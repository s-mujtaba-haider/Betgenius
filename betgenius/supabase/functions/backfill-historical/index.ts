// backfill-historical — Option C orchestrator (Phase 4, May 6, 2026).
//
// Purpose: re-score pre-megadeploy pick_history rows through the post-megadeploy
// algorithm (commit 03d1700, 2026-05-04) to generate synthetic picks for Kelly
// calibration + backtest_weights_v3 ground truth + auto-optimizer Path-C
// re-enable evidence (D-083). Solves C34 — NBA data accumulation window
// closing in ~5 weeks before season ends.
//
// Architecture:
// 1. Caller posts {startDate, endDate, sport, dryRun, requireServiceRoleKey}
// 2. Orchestrator validates auth (service-role key required)
// 3. Inserts a row into backfill_runs with status='running'
// 4. For each date in range:
//    a. Read pre-megadeploy pick_history rows for that date
//    b. POST to process-games with mode='backfill', supplying the rows
//    c. process-games' scoreSlateForDate scores them and (if not dryRun)
//       writes synthetic rows to pick_history with is_synthetic=true,
//       backfill_run_id, algorithm_version='2026-05-04-megadeploy'
// 5. After all dates processed, run hit/miss settlement SQL — UPDATE
//    synthetic rows from original pick_history.actual_value (saves ~6500
//    ESPN box-score re-fetches per the scoping doc).
// 6. Update backfill_runs row with final stats.
//
// Constraints:
// - Read-only on production data: original (is_synthetic=false) rows are
//   never modified. New synthetic rows have is_synthetic=true.
// - Idempotent failure mode: if a backfill_run_id already has rows,
//   refuses to start. CEO must explicitly delete via SQL editor.
// - Service-role key gates the endpoint. No anon access.

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { notify } from "../_shared/notify.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface BackfillRequest {
  startDate: string; // YYYY-MM-DD
  endDate: string;   // YYYY-MM-DD
  sport?: "nba" | "mlb";
  dryRun?: boolean;
  algorithmVersion?: string;
  skipInjuryFetch?: boolean;
  // Wall-clock seconds budget per invocation. Supabase edge functions are
  // killed at ~150s; we default to 110s of work so settle + cleanup have
  // headroom. CEO can lower this for cautious runs, raise it (max 140) for
  // longer single-shot runs.
  budgetSeconds?: number;
}

// Default time budget. Tuned for ~150s edge function ceiling minus settle
// + updateBackfillRun + response-build overhead. The full 92-day Feb→May
// range needs ~7 invocations at this budget.
const DEFAULT_BUDGET_SECONDS = 110;
const MAX_BUDGET_SECONDS = 140;

interface PickHistoryRow {
  player_name: string;
  prop_type: string;
  line: number;
  pick_side: string;
  opponent?: string;
  team?: string;
  game_time?: string;
  game_date?: string;
  // Tier 0 #12 Phase 2 Fix #3 (May 11, 2026 night): pass real historical
  // odds through to scoreSlateForDate so score_trivial_line_penalty + odds-
  // dependent scoring reflects what the bookmaker actually offered, not a
  // hardcoded -110. Optional — NULL falls back to -110 inside scoreSlateForDate.
  odds?: number;
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function isValidDate(s: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s));
}

function* eachDate(startDate: string, endDate: string): Generator<string> {
  const start = new Date(startDate + "T00:00:00Z");
  const end = new Date(endDate + "T00:00:00Z");
  for (let d = start; d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    yield d.toISOString().slice(0, 10);
  }
}

async function readPickHistoryForDate(
  supaUrl: string, supaKey: string, gameDateYYYYMMDD: string,
): Promise<PickHistoryRow[]> {
  // Read pre-megadeploy original picks for this date. Filter is_synthetic=false
  // so prior backfill runs don't pollute the input set.
  // Limit 1000 per date to fit within edge function memory budget; production
  // typical is ~150-300 picks/day so this is well above what we'll see.
  const url = supaUrl + "/rest/v1/pick_history" +
    "?game_date=eq." + gameDateYYYYMMDD +
    "&is_synthetic=eq.false" +
    "&select=player_name,prop_type,line,pick_side,opponent,team,game_time,game_date,odds" +
    "&limit=1000";
  const res = await fetch(url, {
    headers: {
      "apikey": supaKey,
      "Authorization": "Bearer " + supaKey,
    },
  });
  if (!res.ok) {
    throw new Error("readPickHistoryForDate(" + gameDateYYYYMMDD + ") status=" + res.status);
  }
  const rows = await res.json();
  return rows as PickHistoryRow[];
}

async function callScoreSlateForDate(
  supaUrl: string, supaKey: string,
  targetDate: string, sport: string, pickHistoryRows: PickHistoryRow[],
  backfillRunId: string, writeToPickHistory: boolean,
  algorithmVersion: string, skipInjuryFetch: boolean,
): Promise<{ success: boolean; picks_scored: number; picks_written: number; picks_skipped: number; errors: string[]; }> {
  const res = await fetch(supaUrl + "/functions/v1/process-games", {
    method: "POST",
    headers: {
      "Authorization": "Bearer " + supaKey,
      "apikey": supaKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      mode: "backfill",
      targetDate,
      sport,
      pickHistoryRows,
      backfillRunId,
      writeToPickHistory,
      algorithmVersion,
      skipInjuryFetch,
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    return {
      success: false, picks_scored: 0, picks_written: 0, picks_skipped: pickHistoryRows.length,
      errors: ["process-games backfill mode HTTP " + res.status + " " + errText.slice(0, 200)],
    };
  }
  const data = await res.json();
  return {
    success: !!data.success,
    picks_scored: Number(data.picks_scored ?? 0),
    picks_written: Number(data.picks_written ?? 0),
    picks_skipped: Number(data.picks_skipped ?? 0),
    errors: Array.isArray(data.errors) ? data.errors : [],
  };
}

async function settleHits(
  supaUrl: string, supaKey: string, backfillRunId: string,
): Promise<{ updated: number; error?: string }> {
  // SQL JOIN settlement — UPDATE synthetic picks SET actual_value/hit/resolved_at
  // FROM original pick_history rows. Saves ~6500 ESPN re-fetches (see scoping
  // doc /tmp/backfill_scope_may6.md Task 2).
  //
  // Approach: use a Postgres RPC since PostgREST doesn't expose UPDATE FROM JOIN
  // directly. Define inline as a one-shot SQL via the supabase client's
  // generic RPC mechanism — but supabase JS client can't run arbitrary SQL.
  //
  // Workaround: use REST API with a stored function. We'd need to register a
  // Postgres function settle_synthetic_hits(run_id UUID) once. Since we're in
  // an edge function we can use the supabase-js RPC... but no — that requires
  // the client lib, not just fetch.
  //
  // Practical path: register settle_synthetic_hits SQL function via a migration
  // alongside this orchestrator, then call it via PostgREST RPC endpoint.
  // Migration: 20260506000002_settle_synthetic_hits.sql.
  const res = await fetch(supaUrl + "/rest/v1/rpc/settle_synthetic_hits", {
    method: "POST",
    headers: {
      "apikey": supaKey,
      "Authorization": "Bearer " + supaKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ run_id: backfillRunId }),
  });
  if (!res.ok) {
    const errText = await res.text();
    return { updated: 0, error: "settle RPC failed status=" + res.status + " " + errText.slice(0, 200) };
  }
  const updated = await res.json();
  return { updated: Number(updated ?? 0) };
}

async function createBackfillRun(
  supaUrl: string, supaKey: string,
  startDate: string, endDate: string, algorithmVersion: string,
): Promise<{ id: string }> {
  const res = await fetch(supaUrl + "/rest/v1/backfill_runs", {
    method: "POST",
    headers: {
      "apikey": supaKey,
      "Authorization": "Bearer " + supaKey,
      "Content-Type": "application/json",
      "Prefer": "return=representation",
    },
    body: JSON.stringify({
      start_date: startDate, end_date: endDate,
      algorithm_version: algorithmVersion,
      status: "running",
    }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error("createBackfillRun status=" + res.status + " " + errText.slice(0, 200));
  }
  const rows = await res.json();
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error("createBackfillRun returned no rows");
  }
  return { id: rows[0].id };
}

async function updateBackfillRun(
  supaUrl: string, supaKey: string, runId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await fetch(supaUrl + "/rest/v1/backfill_runs?id=eq." + runId, {
    method: "PATCH",
    headers: {
      "apikey": supaKey,
      "Authorization": "Bearer " + supaKey,
      "Content-Type": "application/json",
      "Prefer": "return=minimal",
    },
    body: JSON.stringify(patch),
  });
}

// Top-level error logger — durable persistence of crashes that happen BEFORE
// the orchestrator's instrumented try/catch kicks in. Writes to error_log
// table directly via PostgREST. If the write itself fails (e.g., env missing),
// falls through to console.error which appears in Supabase function logs
// (queryable via the Studio UI even if our captured body lacks the trace).
async function logTopLevelError(
  errorType: string, errorMessage: string, context: Record<string, unknown> = {},
): Promise<void> {
  const url = Deno.env.get("SUPABASE_URL") || "";
  // Try every known service-role-tier env var; one of them might be valid for
  // the error_log write even if the others are stale.
  const candidateKeys = [
    Deno.env.get("BACKFILL_AUTH_TOKEN") || "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
    ...((Deno.env.get("SUPABASE_SECRET_KEYS") || "").split(",").map((s) => s.trim())),
  ].filter((k) => k.length > 0);
  console.error(`[backfill-historical] FATAL type=${errorType} msg=${errorMessage}`);
  if (!url || candidateKeys.length === 0) return;
  for (const key of candidateKeys) {
    try {
      const res = await fetch(`${url}/rest/v1/error_log`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: key,
          Authorization: `Bearer ${key}`,
          Prefer: "return=minimal",
        },
        body: JSON.stringify({
          function_name: "backfill-historical",
          phase: "top-level",
          error_type: errorType,
          error_message: errorMessage.slice(0, 4000),
          context,
        }),
      });
      if (res.ok) return; // first successful write wins
    } catch (_e) { /* try next key */ }
  }
}

serve(async (req) => {
  // OUTERMOST try/catch — wraps EVERYTHING including auth, body parse,
  // validation, and orchestration. Any crash anywhere lands here and gets
  // persisted to error_log before the 500 response. Per CEO directive after
  // commit 28e2f7f's lastCheckpoint instrumentation didn't surface the bug:
  // the failure happens BEFORE the inner try/catch and we couldn't see WHERE.
  try {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ success: false, error: "POST only" }, 405);
  }

  // Auth: accept any of three env vars. SUPABASE_SERVICE_ROLE_KEY and
  // SUPABASE_SECRET_KEYS are platform-managed but on this project both are
  // STALE — Supabase doesn't auto-refresh them when project keys rotate, and
  // `supabase secrets set` refuses to overwrite SUPABASE_* names. So we
  // also read a custom-name env var BACKFILL_AUTH_TOKEN that CEO can rotate
  // via `supabase secrets set BACKFILL_AUTH_TOKEN=<live-key>`. For PostgREST
  // outbound calls we still need a working DB-tier key — fall back to whichever
  // env var matched (custom token may be set to the live service_role JWT,
  // which then doubles as the PostgREST authorization).
  const supaUrl = Deno.env.get("SUPABASE_URL") || "";
  const legacyKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const newSecretKeysRaw = Deno.env.get("SUPABASE_SECRET_KEYS") || "";
  const newSecretKeys = newSecretKeysRaw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  const customToken = Deno.env.get("BACKFILL_AUTH_TOKEN") || "";
  if (!supaUrl) {
    return jsonResponse({ success: false, error: "edge function env missing SUPABASE_URL" }, 500);
  }
  const auth = req.headers.get("authorization") || "";
  const matchedLegacy = legacyKey && auth.includes(legacyKey);
  const matchedNew = newSecretKeys.some((k) => auth.includes(k));
  const matchedCustom = customToken && auth.includes(customToken);
  if (!matchedLegacy && !matchedNew && !matchedCustom) {
    return jsonResponse({ success: false, error: "service_role key required (set BACKFILL_AUTH_TOKEN env var to live service_role JWT and use it as bearer; SUPABASE_SERVICE_ROLE_KEY env is stale on this project)" }, 401);
  }
  // For PostgREST + internal HTTP calls we need a key Postgres recognizes.
  // Prefer the custom token (CEO sets to live service_role JWT). Fallback
  // to legacy env, then to the matching new secret key.
  const supaKey = matchedCustom ? customToken
    : matchedLegacy ? legacyKey
    : (newSecretKeys.find((k) => auth.includes(k)) || customToken || legacyKey);
  if (!supaKey) {
    return jsonResponse({ success: false, error: "edge function env: no usable service-role key for PostgREST" }, 500);
  }

  let body: BackfillRequest;
  try {
    body = await req.json() as BackfillRequest;
  } catch (_e) {
    return jsonResponse({ success: false, error: "invalid JSON body" }, 400);
  }

  const { startDate, endDate } = body;
  const sport = body.sport || "nba";
  const dryRun = body.dryRun === true;
  const algorithmVersion = body.algorithmVersion || "2026-05-04-megadeploy";
  // Tier 0 #12 Phase 3 Fix #5 (May 11, 2026 night): backfill replay now
  // defaults skipInjuryFetch=true per CEO + CTO decision documented in
  // framework v2.34 §15.7.9. Rationale: live engine on date X saw date-X
  // injuries; today's BDL feed is wrong for X; no historical BDL injury
  // API exists. None of the three options is faithful replay, so the
  // CEO/CTO chose "clean matched pairs" (no injury context in synthetic)
  // over "today-contaminated approximation". Eliminates score_player_injury
  // drift (1.10pp, std 4.83) + reduces score_usg_rate drift (3.45pp,
  // propagates from teammate injury context). Explicit `false` in the
  // request body still overrides if a caller ever wants the legacy path.
  const skipInjuryFetch = body.skipInjuryFetch !== false;

  if (!isValidDate(startDate) || !isValidDate(endDate)) {
    return jsonResponse({ success: false, error: "startDate + endDate must be YYYY-MM-DD" }, 400);
  }
  if (startDate > endDate) {
    return jsonResponse({ success: false, error: "startDate must be <= endDate" }, 400);
  }
  if (sport !== "nba") {
    return jsonResponse({ success: false, error: "Phase 4: only sport=nba supported" }, 400);
  }

  let runId = "";
  try {
    if (!dryRun) {
      const created = await createBackfillRun(supaUrl, supaKey, startDate, endDate, algorithmVersion);
      runId = created.id;
    } else {
      runId = "00000000-0000-0000-0000-000000000000"; // sentinel for dry-run
    }
  } catch (e) {
    return jsonResponse({
      success: false,
      error: "createBackfillRun failed: " + (e instanceof Error ? e.message : String(e)),
    }, 500);
  }

  const dateResults: Array<{
    date: string; rowsRead: number; picks_scored: number;
    picks_written: number; picks_skipped: number; errors: string[];
  }> = [];
  let totalScored = 0, totalWritten = 0, totalSkipped = 0;
  const aggregateErrors: string[] = [];
  let lastCheckpoint = "init";
  // Time budget: graceful early stop with resume info before edge function
  // wall-clock kills us. Empirically 14 days/~120s succeeds, 28 days hits the
  // platform ~150s timeout (502 from gateway). At ~9-12s per data-bearing
  // date, ~110s budget covers ~9-11 active dates per invocation.
  const budgetSec = Math.min(MAX_BUDGET_SECONDS, Math.max(30, body.budgetSeconds ?? DEFAULT_BUDGET_SECONDS));
  const startMs = Date.now();
  const budgetMs = budgetSec * 1000;
  let stoppedEarly = false;
  let nextStartDate: string | null = null;

  try {
    let dateIndex = 0;
    for (const date of eachDate(startDate, endDate)) {
      dateIndex++;
      const elapsedMs = Date.now() - startMs;
      // Reserve ~20s for settle + updateBackfillRun + response build at end
      // of loop, so check budget BEFORE starting each date.
      if (elapsedMs > budgetMs) {
        stoppedEarly = true;
        nextStartDate = date;
        console.log(`[backfill] STOP early at date=${date} elapsed=${elapsedMs}ms budget=${budgetMs}ms — caller must re-invoke from ${date}`);
        break;
      }
      lastCheckpoint = `loop date=${date} (${dateIndex}) elapsed=${elapsedMs}ms`;
      console.log(`[backfill] ${lastCheckpoint}`);
      const gameDateYYYYMMDD = date.replace(/-/g, "");
      let rows: PickHistoryRow[] = [];
      try {
        rows = await readPickHistoryForDate(supaUrl, supaKey, gameDateYYYYMMDD);
      } catch (e) {
        const msg = "readPickHistoryForDate(" + date + ") failed: " +
          (e instanceof Error ? e.message : String(e));
        aggregateErrors.push(msg);
        dateResults.push({
          date, rowsRead: 0, picks_scored: 0, picks_written: 0,
          picks_skipped: 0, errors: [msg.slice(0, 240)],
        });
        continue;
      }
      if (rows.length === 0) {
        dateResults.push({
          date, rowsRead: 0, picks_scored: 0, picks_written: 0,
          picks_skipped: 0, errors: [],
        });
        continue;
      }
      lastCheckpoint = `callScoreSlateForDate date=${date} rows=${rows.length}`;
      let result: Awaited<ReturnType<typeof callScoreSlateForDate>>;
      try {
        result = await callScoreSlateForDate(
          supaUrl, supaKey, date, sport, rows, runId,
          !dryRun, algorithmVersion, skipInjuryFetch,
        );
      } catch (e) {
        const msg = "callScoreSlateForDate threw: " + (e instanceof Error ? (e.stack || e.message) : String(e));
        aggregateErrors.push("[" + date + "] " + msg);
        dateResults.push({
          date, rowsRead: rows.length, picks_scored: 0, picks_written: 0,
          picks_skipped: rows.length, errors: [msg.slice(0, 240)],
        });
        continue;
      }
      // Defensive: if the callee somehow returned undefined or a malformed
      // shape, capture it instead of crashing on field access.
      if (!result || typeof result !== "object") {
        const msg = "callScoreSlateForDate returned non-object: " + String(result);
        aggregateErrors.push("[" + date + "] " + msg);
        dateResults.push({
          date, rowsRead: rows.length, picks_scored: 0, picks_written: 0,
          picks_skipped: rows.length, errors: [msg],
        });
        continue;
      }
      totalScored += Number(result.picks_scored ?? 0);
      totalWritten += Number(result.picks_written ?? 0);
      totalSkipped += Number(result.picks_skipped ?? 0);
      const errs = Array.isArray(result.errors) ? result.errors : [];
      if (errs.length > 0) {
        for (const err of errs) aggregateErrors.push("[" + date + "] " + String(err).slice(0, 240));
      }
      dateResults.push({
        date, rowsRead: rows.length,
        picks_scored: Number(result.picks_scored ?? 0),
        picks_written: Number(result.picks_written ?? 0),
        picks_skipped: Number(result.picks_skipped ?? 0),
        // Cap per-date errors to keep the response size sane on long ranges.
        errors: errs.slice(0, 3).map((e) => String(e).slice(0, 240)),
      });
    }

    lastCheckpoint = `loop done totalWritten=${totalWritten} totalScored=${totalScored}`;
    console.log(`[backfill] ${lastCheckpoint}`);

    let settledCount = 0;
    let settleError: string | undefined;
    if (!dryRun && totalWritten > 0) {
      lastCheckpoint = `settleHits run=${runId}`;
      console.log(`[backfill] ${lastCheckpoint}`);
      try {
        const settle = await settleHits(supaUrl, supaKey, runId);
        if (settle && typeof settle === "object") {
          settledCount = Number(settle.updated ?? 0);
          settleError = settle.error;
        } else {
          settleError = "settleHits returned non-object: " + String(settle);
        }
      } catch (e) {
        settleError = "settleHits threw: " + (e instanceof Error ? e.message : String(e));
      }
      if (settleError) aggregateErrors.push("settle: " + settleError);
    }

    if (!dryRun) {
      lastCheckpoint = `updateBackfillRun run=${runId}`;
      console.log(`[backfill] ${lastCheckpoint}`);
      try {
        await updateBackfillRun(supaUrl, supaKey, runId, {
          completed_at: stoppedEarly ? null : new Date().toISOString(),
          dates_processed: dateResults.length,
          picks_generated: totalWritten,
          picks_resolved: settledCount,
          // partial_complete runs stay 'running' so multiple chunks can
          // contribute to the same logical backfill across invocations.
          status: stoppedEarly ? "running" : "completed",
          notes: aggregateErrors.length > 0 ? aggregateErrors.slice(0, 10).join(" | ").slice(0, 4000) : null,
        });
      } catch (e) {
        const msg = "updateBackfillRun (terminal) threw: " + (e instanceof Error ? e.message : String(e));
        aggregateErrors.push(msg);
      }
    }

    lastCheckpoint = "build response";
    const totalElapsedMs = Date.now() - startMs;

    // SMS alert hook — elevated error count during a backfill is worth a
    // warning (not critical — backfill is offline tooling, not user-facing).
    if (!dryRun && aggregateErrors.length > 10) {
      await notify({
        severity: "warning",
        title: "backfill-historical errors elevated",
        message: `error_count=${aggregateErrors.length}, written=${totalWritten}, settled=${settledCount}`,
        metadata: { error_count: aggregateErrors.length, run_id: runId },
      });
    }

    return jsonResponse({
      success: true,
      dryRun,
      partial_complete: stoppedEarly,
      // When partial_complete is true, caller should re-invoke with
      // startDate=next_start_date and the SAME endDate to resume.
      next_start_date: nextStartDate,
      backfill_run_id: runId,
      start_date: startDate,
      end_date: endDate,
      sport,
      algorithm_version: algorithmVersion,
      dates_processed: dateResults.length,
      total_picks_scored: totalScored,
      total_picks_written: totalWritten,
      total_picks_skipped: totalSkipped,
      total_picks_settled: settledCount,
      elapsed_ms: totalElapsedMs,
      budget_ms: budgetMs,
      error_count: aggregateErrors.length,
      first_errors: aggregateErrors.slice(0, 10),
      // Cap dateResults included in response to last 30 entries to avoid
      // 6MB edge function response cap on long ranges. Full per-date detail
      // remains queryable via backfill_runs.notes + pick_history filtered
      // by backfill_run_id.
      date_results: dateResults.length > 30 ? dateResults.slice(-30) : dateResults,
    });
  } catch (e) {
    const msg = e instanceof Error ? (e.stack || e.message) : String(e);
    const wrappedMsg = `at checkpoint='${lastCheckpoint}': ${msg}`;
    console.error(`[backfill] FATAL ${wrappedMsg}`);
    if (!dryRun && runId !== "00000000-0000-0000-0000-000000000000") {
      try {
        await updateBackfillRun(supaUrl, supaKey, runId, {
          completed_at: new Date().toISOString(),
          status: "failed",
          error_message: wrappedMsg.slice(0, 4000),
        });
      } catch (_e) { /* swallow */ }
    }
    return jsonResponse({
      success: false,
      backfill_run_id: runId,
      checkpoint: lastCheckpoint,
      error: wrappedMsg.slice(0, 2000),
      partial_results: dateResults.slice(-10),
      total_picks_written_so_far: totalWritten,
    }, 500);
  }

  } catch (outermostErr) {
    // OUTERMOST catch — anything thrown before the inner try (auth, body parse,
    // validation, createBackfillRun) lands here. Persist to error_log so we
    // can read the actual stack trace afterward, even if Dashboard Invoke or
    // some platform wrapper masks the response body.
    const errStr = outermostErr instanceof Error
      ? `${outermostErr.name}: ${outermostErr.message}\nstack:\n${outermostErr.stack || "(no stack)"}`
      : String(outermostErr);
    let bodySnippet = "(could not capture)";
    try {
      // req is consumed by the time we reach here in some paths, so this may
      // throw — bury that error, only care about durable logging.
      const cloned = req.clone();
      bodySnippet = (await cloned.text()).slice(0, 1000);
    } catch (_e) { /* swallow */ }
    let urlInfo = "(could not capture)";
    try { urlInfo = req.url; } catch (_e) { /* swallow */ }
    let methodInfo = "(could not capture)";
    try { methodInfo = req.method; } catch (_e) { /* swallow */ }
    await logTopLevelError("outermost_throw", errStr, {
      url: urlInfo,
      method: methodInfo,
      body: bodySnippet,
      ts: new Date().toISOString(),
    });
    return jsonResponse({
      success: false,
      error: "outermost handler crashed",
      error_detail: errStr.slice(0, 2000),
    }, 500);
  }
});
