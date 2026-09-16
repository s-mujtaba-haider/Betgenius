// D-307 — orchestrator-execute with Claude API tool use.
//
// Wires Anthropic Messages API + safe-subset of tool primitives:
//   - read_supabase_query (read-only SELECT)
//   - read_file (stubbed; edge runtime doesn't have repo fs access)
//   - write_report (persists to cache_orchestrator_results.artifacts_produced)
//
// Per /docs/loop/architecture/orchestrator_claude_integration.md.
//
// AUTH: service-role.
// Mutex: D-291 pattern.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { tryAcquireLock, releaseLock } from "../_shared/function_lock.ts";
import { logSonnetUsage } from "../_shared/sonnet_usage_log.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const BACKFILL_TOKEN = Deno.env.get("BACKFILL_AUTH_TOKEN") ?? "";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const LOCK_KEY = "orchestrator-execute";

const MAX_TURNS = 8;
const MAX_TOKENS_PER_TASK = 200_000;
const MAX_WALL_MS = 130_000;

const corsHeaders = { "Access-Control-Allow-Origin": "*" };
function j(d: unknown, s = 200) { return new Response(JSON.stringify(d, null, 2), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } }); }
const sH = () => ({ apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" });

interface PendingTask {
  task_id: string;
  batch_name: string;
  prompt_text: string;
  priority: number;
  requires_ceo_approval: boolean;
  hard_rule_violations: string[];
  has_approval: boolean;
}

async function rpc(name: string, body: unknown): Promise<unknown> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: sH(),
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`rpc_${name}_${r.status}: ${await r.text()}`);
  const text = await r.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return text; }
}

// ============================================================
// TOOL PRIMITIVES
// ============================================================

const ALLOWED_TABLES_PREFIXES = [
  "pick_history", "recommendations_cache", "cache_mlb_", "cache_nba_", "cache_ballpark", "cache_umpire",
  "cache_orchestrator_", "cache_ceo_", "historical_replay_results", "algorithm_weights",
  "error_log", "run_log", "function_locks", "cron_heartbeat", "notifications_log",
  "dashboard_health_log", "cache_statcast_", "calibration_snapshots", "cron_progress",
];

async function tool_read_supabase_query(input: { sql: string; limit?: number; select_columns?: string }): Promise<unknown> {
  const sql = (input.sql ?? "").trim();
  if (!sql) return { error: "rejected", reason: "empty_sql" };
  const sqlLower = sql.toLowerCase();
  if (!sqlLower.startsWith("select")) return { error: "rejected", reason: "not_select" };
  for (const verb of ["update ", "insert ", "delete ", "alter ", "drop ", "truncate ", "grant ", "revoke ", "create "]) {
    if (sqlLower.includes(verb)) return { error: "rejected", reason: `contains_${verb.trim()}` };
  }

  const fromMatch = sql.match(/\bFROM\s+([a-z0-9_]+)/i);
  if (!fromMatch) return { error: "rejected", reason: "no_FROM_clause" };
  const tableName = fromMatch[1].toLowerCase();
  if (!ALLOWED_TABLES_PREFIXES.some(p => tableName.startsWith(p))) {
    return { error: "rejected", reason: `table_not_allowed:${tableName}` };
  }

  const sqlLimitMatch = sql.match(/\bLIMIT\s+(\d+)/i);
  const sqlLimit = sqlLimitMatch ? parseInt(sqlLimitMatch[1], 10) : null;
  const limit = Math.min(Math.max(sqlLimit ?? input.limit ?? 10, 1), 1000);

  const selectCols = (input.select_columns ?? "*").replace(/[^a-z0-9_,*]/gi, "") || "*";
  const url = `${SUPABASE_URL}/rest/v1/${tableName}?select=${selectCols}&limit=${limit}`;
  const r = await fetch(url, { headers: sH() });
  if (!r.ok) return { error: "query_failed", status: r.status, detail: (await r.text()).slice(0, 200) };
  const rows = await r.json();
  const rowArr = Array.isArray(rows) ? rows.slice(0, limit) : rows;

  const MAX_PAYLOAD_BYTES = 20_000;
  let serialized = JSON.stringify(rowArr);
  let truncated = false;
  if (serialized.length > MAX_PAYLOAD_BYTES && Array.isArray(rowArr)) {
    let lo = 1, hi = rowArr.length;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (JSON.stringify(rowArr.slice(0, mid)).length <= MAX_PAYLOAD_BYTES) lo = mid; else hi = mid - 1;
    }
    serialized = JSON.stringify(rowArr.slice(0, lo));
    truncated = true;
  }
  return {
    success: true,
    table: tableName,
    row_count: Array.isArray(rowArr) ? rowArr.length : 0,
    rows: JSON.parse(serialized),
    truncated,
    honest_note: "This primitive does a PostgREST table scan — only the FROM table + LIMIT are honored. WHERE / JOIN / GROUP BY / ORDER BY / aggregates (COUNT, MIN, MAX) in your SQL are IGNORED. Use select_columns to project specific columns and reduce payload. To filter, pull rows then filter in your reasoning.",
  };
}

async function tool_read_file(input: { path: string }): Promise<unknown> {
  const path = input.path ?? "";
  if (!path) return { error: "rejected", reason: "empty_path" };
  if (path.startsWith("/") || path.includes("..")) return { error: "rejected", reason: "path_traversal" };
  if (path.includes(".env") || path.includes("secrets/") || path.endsWith(".pem")) {
    return { error: "rejected", reason: "secret_path" };
  }
  // D-307 honest scope: edge runtime doesn't have repo fs access.
  // Return stub indicating intent + path validation passed.
  return {
    success: false,
    stub: true,
    error: "file_read_not_yet_implemented_in_edge_runtime",
    requested_path: path,
    note: "Path validation passed. File-bridge mechanism deferred to D-308. Use read_supabase_query instead OR describe the file from memory.",
  };
}

async function tool_write_report(input: { filename: string; content: string }, taskId: string): Promise<unknown> {
  const filename = input.filename ?? "";
  if (!filename) return { error: "rejected", reason: "empty_filename" };
  if (!/^[a-z0-9_-]+\.md$/.test(filename)) {
    return { error: "rejected", reason: "invalid_filename_pattern", expected: "^[a-z0-9_-]+\\.md$" };
  }
  const content = input.content ?? "";
  if (!content) return { error: "rejected", reason: "empty_content" };

  // Persist to cache_orchestrator_results.artifacts_produced as the
  // canonical destination (edge runtime can't write to disk).
  // CEO/orchestrator-doc-sync (D-308) can persist to actual /docs/ later.
  await fetch(`${SUPABASE_URL}/rest/v1/cache_orchestrator_results`, {
    method: "POST",
    headers: { ...sH(), Prefer: "return=minimal" },
    body: JSON.stringify({
      task_id: taskId,
      ship_name: "write_report",
      grade: null,
      artifacts_produced: [{
        tool: "write_report",
        filename,
        intended_path: `docs/loop/reports/${filename}`,
        content_length: content.length,
        content,
      }],
      honest_summary: `Report '${filename}' written to artifacts (${content.length} chars). CEO can persist to disk via /docs/loop/reports/${filename}.`,
    }),
  });

  return {
    success: true,
    filename,
    intended_path: `docs/loop/reports/${filename}`,
    content_length: content.length,
    persistence: "stored_in_cache_orchestrator_results.artifacts_produced",
    note: "Disk persistence deferred to D-308 doc-sync mechanism. CEO can pull report content from DB.",
  };
}

interface ArtifactsTracked {
  write_report_count: number;
  write_report_filenames: string[];
  read_query_count: number;
  rejected_tool_calls: number;
}

async function dispatchTool(name: string, input: unknown, taskId: string, tracked: ArtifactsTracked): Promise<unknown> {
  let result: unknown;
  switch (name) {
    case "read_supabase_query":
      result = await tool_read_supabase_query(input as { sql: string; limit?: number; select_columns?: string });
      tracked.read_query_count++;
      break;
    case "read_file":
      result = await tool_read_file(input as { path: string });
      break;
    case "write_report":
      result = await tool_write_report(input as { filename: string; content: string }, taskId);
      if (typeof result === "object" && result !== null && "success" in result && (result as { success: boolean }).success) {
        tracked.write_report_count++;
        const fn = (input as { filename?: string }).filename;
        if (fn) tracked.write_report_filenames.push(fn);
      } else {
        tracked.rejected_tool_calls++;
      }
      break;
    default:
      tracked.rejected_tool_calls++;
      result = { error: "unknown_tool", tool: name };
  }
  if (typeof result === "object" && result !== null && "error" in result && !("success" in result)) {
    tracked.rejected_tool_calls++;
  }
  return result;
}

// Tiered grading. Replaces the binary `abortReason ? "F" : "A"` of D-307.
// Inputs are honest signals: did the task produce a final report, did the
// model exit cleanly, was the abort recoverable, were there cardinal
// violations or production damage?
function computeGrade(opts: {
  stopReason: string | null;
  abortReason: string | null;
  artifacts: ArtifactsTracked;
  cardinalViolations: string[];
  productionDamage: boolean;
}): { grade: "A" | "B" | "C" | "D" | "F"; rationale: string } {
  const { stopReason, abortReason, artifacts, cardinalViolations, productionDamage } = opts;

  if (productionDamage) return { grade: "F", rationale: "production_damage" };
  if (cardinalViolations.length > 0) return { grade: "F", rationale: `cardinal_violations:${cardinalViolations.join(",")}` };

  const hasReport = artifacts.write_report_count > 0;
  const cleanExit = stopReason === "end_turn" && !abortReason;

  if (!hasReport) {
    if (cleanExit) return { grade: "D", rationale: "clean_exit_but_no_report_written" };
    if (abortReason === "wall_clock") return { grade: "D", rationale: "wall_clock_with_no_report" };
    return { grade: "F", rationale: `no_report_and_${abortReason ?? "unknown_abort"}` };
  }

  if (cleanExit) return { grade: "A", rationale: "end_turn_with_report_and_no_violations" };
  if (abortReason === "wall_clock") return { grade: "C", rationale: "wall_clock_after_report_landed" };
  if (abortReason === "token_budget") return { grade: "C", rationale: "token_budget_after_report_landed" };
  if (stopReason === "max_tokens") return { grade: "B", rationale: "max_tokens_after_report_landed" };
  return { grade: "B", rationale: `unexpected_state:stop=${stopReason ?? "?"},abort=${abortReason ?? "?"}` };
}

// ============================================================
// CLAUDE API
// ============================================================

const TOOLS_SCHEMA = [
  {
    name: "read_supabase_query",
    description: "Read rows from an allowed table. IMPORTANT: this is a TABLE SCAN, not a SQL executor. Only the FROM table-name and LIMIT clause from your SQL are honored. WHERE / JOIN / GROUP BY / ORDER BY / aggregates (COUNT, MIN, MAX) are IGNORED — they will silently return raw rows. To minimize tokens, ALWAYS pass select_columns to project only the columns you need. Default LIMIT is 10. Payload is auto-truncated to ~20KB per call. Allowed table prefixes: pick_history, recommendations_cache, cache_mlb_, cache_nba_, cache_ballpark, cache_umpire, cache_orchestrator_, historical_replay_results, algorithm_weights, error_log, run_log.",
    input_schema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "SELECT statement (only FROM + LIMIT honored)" },
        limit: { type: "integer", description: "Max rows (1-1000), default 10. Overridden by LIMIT in sql.", default: 10 },
        select_columns: { type: "string", description: "Comma-separated columns to project, e.g. 'umpire_name,k_zone_size_index'. Defaults to '*' but use specific columns to keep payload small." },
      },
      required: ["sql"],
    },
  },
  {
    name: "read_file",
    description: "Read a repo file. CURRENTLY STUBBED — returns path-validation result only. Use read_supabase_query or describe the file from memory.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "Repo-relative path" } },
      required: ["path"],
    },
  },
  {
    name: "write_report",
    description: "Write a final report. Persists to cache_orchestrator_results.artifacts_produced. Call this at the end of every task.",
    input_schema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "Pattern: ^[a-z0-9_-]+\\.md$" },
        content: { type: "string", description: "Markdown report content" },
      },
      required: ["filename", "content"],
    },
  },
];

const SYSTEM_PROMPT = `You are an autonomous orchestrator for the SharpAI sports betting analytics platform.
You execute tasks queued by the CEO. Your work is logged in cache_orchestrator_results.

Available tools (D-307 safe subset):
- read_supabase_query(sql, limit) — read-only SELECT
- read_file(path) — STUBBED in D-307, returns validation only
- write_report(filename, content) — write markdown report

You CANNOT (in D-307):
- Modify production tables (UPDATE/INSERT/DELETE/ALTER)
- Deploy code
- Run git operations
- Spend Odds API credits

When a task is ambiguous or destructive: refuse + write an honest report explaining why.

Cardinal rules:
- §1.19 assertion-symptom match — investigate what's actually wrong, don't pattern-match
- §1.20 verified ground-truth before grading
- NO fabricated A+ — honest grades

Token budget per task is tight (~200K input tokens, 8 turns max). Be efficient:
- ALWAYS pass select_columns to project only the columns you need.
- Aim for at most 3 query turns of data gathering, then write the report.
- Aggregates (COUNT, MIN, MAX) and WHERE are NOT executed — they return raw rows. Compute aggregates by inspecting the returned rows yourself.
- Don't re-query the same table multiple times. Pull what you need once and reason from there.

End your turn by calling write_report with a complete final task summary (1500-4000 words is typical).`;

interface ContentBlock { type: string; text?: string; id?: string; name?: string; input?: unknown; tool_use_id?: string; content?: string | unknown[] }
interface Message { role: "user" | "assistant"; content: string | ContentBlock[] }

async function callClaude(messages: Message[]): Promise<{ content: ContentBlock[]; stop_reason: string; usage?: { input_tokens: number; output_tokens: number } } | { error: string }> {
  if (!ANTHROPIC_API_KEY) return { error: "ANTHROPIC_API_KEY not configured in Supabase secrets" };

  const body = {
    model: "claude-sonnet-4-6",
    max_tokens: 16384,
    system: SYSTEM_PROMPT,
    tools: TOOLS_SCHEMA,
    messages,
  };
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    const errText = await r.text();
    return { error: `anthropic_${r.status}: ${errText.slice(0, 400)}` };
  }
  return await r.json();
}

// ============================================================
// MAIN
// ============================================================

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const auth = req.headers.get("Authorization") ?? "";
  if (!(auth.includes(SUPABASE_KEY) || (BACKFILL_TOKEN && auth.includes(BACKFILL_TOKEN)))) return j({ error: "unauthorized" }, 401);

  if (!ANTHROPIC_API_KEY) {
    return j({ error: "ANTHROPIC_API_KEY not set in Supabase secrets. CEO action required: `supabase secrets set ANTHROPIC_API_KEY=<key>`." }, 503);
  }

  const acquired = await tryAcquireLock(LOCK_KEY, SUPABASE_URL, SUPABASE_KEY, 15);
  if (!acquired) return j({ error: "another instance running" }, 423);

  const t0 = Date.now();
  const conversationLog: Array<{ turn: number; role: string; content: unknown }> = [];

  try {
    const next = await rpc("get_next_pending_task", {}) as PendingTask[];
    if (!next || next.length === 0) return j({ success: true, message: "no_pending_tasks" });
    const task = next[0];

    // Defense in depth
    const scan = await rpc("scan_task_hard_rules", { p_prompt: task.prompt_text }) as Array<{ blocked: boolean; violations: string[] }>;
    if (scan[0].blocked && !task.has_approval) {
      return j({ success: true, message: "task_blocked_no_approval", task_id: task.task_id, violations: scan[0].violations });
    }

    await rpc("mark_task_running", { p_task_id: task.task_id });

    const messages: Message[] = [{ role: "user", content: task.prompt_text }];
    conversationLog.push({ turn: 0, role: "user", content: task.prompt_text });

    let turn = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let lastResponse: { content: ContentBlock[]; stop_reason: string } | null = null;
    let abortReason: string | null = null;
    const tracked: ArtifactsTracked = { write_report_count: 0, write_report_filenames: [], read_query_count: 0, rejected_tool_calls: 0 };
    const cardinalViolations: string[] = [];

    while (turn < MAX_TURNS) {
      if (Date.now() - t0 > MAX_WALL_MS) { abortReason = "wall_clock"; break; }
      if (totalInputTokens + totalOutputTokens > MAX_TOKENS_PER_TASK) { abortReason = "token_budget"; break; }

      const claudeResp = await callClaude(messages);
      if ("error" in claudeResp) {
        abortReason = `claude_api_error: ${claudeResp.error}`;
        break;
      }
      lastResponse = claudeResp;
      if (claudeResp.usage) {
        totalInputTokens += claudeResp.usage.input_tokens ?? 0;
        totalOutputTokens += claudeResp.usage.output_tokens ?? 0;
      }
      // D-463 — persist per-turn usage to sonnet_usage_log (best-effort).
      await logSonnetUsage("orchestrator", "claude-sonnet-4-6", claudeResp.usage, {
        task_id: task.task_id,
        turn: turn + 1,
        stop_reason: claudeResp.stop_reason,
      });
      messages.push({ role: "assistant", content: claudeResp.content });
      conversationLog.push({ turn: ++turn, role: "assistant", content: claudeResp.content });

      if (claudeResp.stop_reason !== "tool_use") break;

      const toolUses = claudeResp.content.filter(b => b.type === "tool_use");
      const toolResults = await Promise.all(toolUses.map(async (tu) => ({
        type: "tool_result",
        tool_use_id: tu.id!,
        content: JSON.stringify(await dispatchTool(tu.name!, tu.input, task.task_id, tracked)),
      })));
      messages.push({ role: "user", content: toolResults as unknown as ContentBlock[] });
      conversationLog.push({ turn, role: "tool_results", content: toolResults });
    }

    const graded = computeGrade({
      stopReason: lastResponse?.stop_reason ?? null,
      abortReason,
      artifacts: tracked,
      cardinalViolations,
      productionDamage: false,
    });

    const finalSummary = {
      claude_api_integration: "live",
      turns_used: turn,
      total_input_tokens: totalInputTokens,
      total_output_tokens: totalOutputTokens,
      stop_reason: lastResponse?.stop_reason ?? "unknown",
      abort_reason: abortReason,
      duration_ms: Date.now() - t0,
      grade: graded.grade,
      grade_rationale: graded.rationale,
      artifacts: tracked,
    };

    // Task-queue status: completed if any report landed OR clean exit;
    // failed only when the run produced nothing usable.
    const hadDeliverable = tracked.write_report_count > 0 || (!abortReason && lastResponse?.stop_reason === "end_turn");
    if (!hadDeliverable && abortReason) {
      await rpc("mark_task_failed", { p_task_id: task.task_id, p_error: abortReason });
    } else {
      await rpc("mark_task_completed", { p_task_id: task.task_id, p_summary: finalSummary });
    }

    await fetch(`${SUPABASE_URL}/rest/v1/cache_orchestrator_results`, {
      method: "POST",
      headers: { ...sH(), Prefer: "return=minimal" },
      body: JSON.stringify({
        task_id: task.task_id,
        ship_name: "claude-api-execution",
        grade: graded.grade,
        artifacts_produced: [{
          conversation_log: conversationLog.slice(0, 20),
          tracked_artifacts: tracked,
          grade_rationale: graded.rationale,
        }],
        honest_summary: `Claude API task ran ${turn} turns, ${totalInputTokens + totalOutputTokens} tokens. stop_reason=${lastResponse?.stop_reason ?? "?"} abort=${abortReason ?? "none"} write_reports=${tracked.write_report_count} grade=${graded.grade} (${graded.rationale})`,
      }),
    });

    return j({
      success: true,
      task_id: task.task_id,
      batch_name: task.batch_name,
      ...finalSummary,
    });
  } finally {
    await releaseLock(LOCK_KEY, SUPABASE_URL, SUPABASE_KEY);
  }
});
