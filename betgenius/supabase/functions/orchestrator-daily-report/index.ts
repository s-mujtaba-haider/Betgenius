// D-306 Phase 5 — Daily orchestrator + production health digest.
//
// Generates a markdown report consolidating last 24h of:
//   - Completed orchestrator tasks
//   - Blocked tasks awaiting CEO approval
//   - Failed tasks
//   - Production health (pick WR per sport per tier, cron health)
//   - Active alerts
//   - D-298 carryover queue
//
// Writes JSON to cache_orchestrator_alerts (severity=info) AND
// returns the markdown body for caller to persist as
// docs/loop/reports/daily_YYYY-MM-DD.md.
//
// Cron: pg_cron `0 13 * * *` (8 AM ET).
// AUTH: service-role or BACKFILL_AUTH_TOKEN.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const BACKFILL_TOKEN = Deno.env.get("BACKFILL_AUTH_TOKEN") ?? "";

const corsHeaders = { "Access-Control-Allow-Origin": "*" };
function j(d: unknown, s = 200, body?: string) {
  if (body) return new Response(body, { status: s, headers: { ...corsHeaders, "Content-Type": "text/markdown" } });
  return new Response(JSON.stringify(d, null, 2), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
const sH = () => ({ apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" });

async function q<T = unknown>(path: string): Promise<T[]> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: sH() });
  if (!r.ok) return [];
  return await r.json() as T[];
}

function wilson(h: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 0];
  const p = h / n;
  const den = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / den;
  const half = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / den;
  return [Math.max(0, c - half) * 100, Math.min(1, c + half) * 100];
}

interface PickRow { sport: string; confidence: number | null; hit: boolean | null; voided: boolean }

function tierOf(c: number): string {
  if (c >= 90) return "Elite";
  if (c >= 80) return "Strong";
  if (c >= 70) return "Good";
  if (c >= 60) return "Lean";
  return "Pass";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const auth = req.headers.get("Authorization") ?? "";
  if (!(auth.includes(SUPABASE_KEY) || (BACKFILL_TOKEN && auth.includes(BACKFILL_TOKEN)))) return j({ error: "unauthorized" }, 401);

  const url = new URL(req.url);
  const format = url.searchParams.get("format") ?? "json";

  const now = new Date();
  const today = new Date(now.getTime() - 4 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const since24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();

  // Pull data in parallel
  const [completed, blocked, failed, alerts, picks24h, productionAlerts] = await Promise.all([
    q<{ task_id: string; batch_name: string; result_summary: unknown; completed_at: string }>(
      `cache_orchestrator_task_queue?status=eq.completed&completed_at=gte.${since24h}&select=task_id,batch_name,result_summary,completed_at&order=completed_at.desc&limit=50`
    ),
    q<{ task_id: string; batch_name: string; hard_rule_violations: unknown; created_at: string; prompt_text: string }>(
      `cache_orchestrator_task_queue?status=eq.blocked&select=task_id,batch_name,hard_rule_violations,created_at,prompt_text&order=created_at.desc&limit=20`
    ),
    q<{ task_id: string; batch_name: string; error_log: string; completed_at: string }>(
      `cache_orchestrator_task_queue?status=eq.failed&completed_at=gte.${since24h}&select=task_id,batch_name,error_log,completed_at&order=completed_at.desc&limit=20`
    ),
    q<{ alert_id: string; severity: string; alert_type: string; title: string; created_at: string }>(
      `cache_orchestrator_alerts?resolved=eq.false&severity=in.(warning,critical,hard_alert)&select=alert_id,severity,alert_type,title,created_at&order=created_at.desc&limit=20`
    ),
    q<PickRow>(
      `pick_history?select=sport,confidence,hit,voided&hit=not.is.null&voided=eq.false&game_date=gte.${today}&limit=10000`
    ),
    q<{ function_name: string; error_message: string; created_at: string }>(
      `error_log?created_at=gte.${since24h}&select=function_name,error_message,created_at&order=created_at.desc&limit=10`
    ),
  ]);

  // Per-sport per-tier WR
  const tierMap: Record<string, Record<string, { h: number; n: number }>> = { mlb: {}, nba: {} };
  for (const p of picks24h) {
    const sport = p.sport;
    if (!tierMap[sport]) tierMap[sport] = {};
    const t = tierOf(p.confidence ?? 0);
    if (!tierMap[sport][t]) tierMap[sport][t] = { h: 0, n: 0 };
    tierMap[sport][t].n++;
    if (p.hit) tierMap[sport][t].h++;
  }

  // Build markdown body
  const lines: string[] = [];
  lines.push(`# Daily Orchestrator Report — ${today}`);
  lines.push("");
  lines.push("## At a glance");
  lines.push(`- ${completed.length} tasks completed last 24h`);
  lines.push(`- ${blocked.length} tasks **blocked awaiting CEO approval**`);
  lines.push(`- ${failed.length} tasks failed`);
  lines.push(`- ${alerts.length} active alerts (warning+)`);
  lines.push(`- Production errors last 24h: ${productionAlerts.length}`);
  lines.push("");

  // Production health
  lines.push("## Production health (last 24h)");
  for (const sport of ["mlb", "nba"]) {
    const m = tierMap[sport] ?? {};
    const total = Object.values(m).reduce((a, b) => a + b.n, 0);
    lines.push(`### ${sport.toUpperCase()} (n=${total})`);
    for (const t of ["Elite", "Strong", "Good", "Lean", "Pass"]) {
      const v = m[t];
      if (!v || v.n === 0) continue;
      const wr = v.h / v.n * 100;
      const [lo, hi] = wilson(v.h, v.n);
      lines.push(`- ${t}: n=${v.n} hits=${v.h} WR=${wr.toFixed(1)}% [${lo.toFixed(1)}, ${hi.toFixed(1)}]`);
    }
    lines.push("");
  }

  // Tasks completed
  if (completed.length > 0) {
    lines.push("## Tasks completed (last 24h)");
    for (const t of completed.slice(0, 20)) {
      lines.push(`- **${t.batch_name}** @ ${t.completed_at.slice(0, 16)} — ${JSON.stringify(t.result_summary ?? {}).slice(0, 200)}`);
    }
    lines.push("");
  }

  // Blocked tasks
  if (blocked.length > 0) {
    lines.push("## Tasks blocked — require CEO approval");
    for (const t of blocked) {
      const violations = Array.isArray(t.hard_rule_violations) ? (t.hard_rule_violations as string[]).join(", ") : "?";
      const preview = t.prompt_text?.slice(0, 150) ?? "";
      lines.push(`- **${t.batch_name}** [${t.task_id}]`);
      lines.push(`  - Violations: ${violations}`);
      lines.push(`  - Prompt preview: ${preview}...`);
      lines.push(`  - Approve via: \`SELECT approve_task('${t.task_id}', 'reason');\``);
    }
    lines.push("");
  }

  // Failed tasks
  if (failed.length > 0) {
    lines.push("## Tasks failed (last 24h)");
    for (const t of failed) {
      lines.push(`- **${t.batch_name}** [${t.task_id}]: ${t.error_log?.slice(0, 200) ?? "(no error log)"}`);
    }
    lines.push("");
  }

  // Active alerts
  if (alerts.length > 0) {
    lines.push("## Active alerts");
    for (const a of alerts) {
      lines.push(`- **[${a.severity.toUpperCase()}]** ${a.alert_type}: ${a.title} @ ${a.created_at.slice(0, 16)}`);
    }
    lines.push("");
  }

  // Production cron errors
  if (productionAlerts.length > 0) {
    lines.push("## Production cron errors (last 24h, top 5)");
    for (const e of productionAlerts.slice(0, 5)) {
      lines.push(`- ${e.created_at.slice(0, 16)} **${e.function_name}**: ${e.error_message.slice(0, 150)}`);
    }
    lines.push("");
  }

  // Recommended actions
  // D-307 Phase 0 — open carryover queue section.
  // Currently §16.5 in framework is CLEARED (D-303 closed D-298 items).
  // Section lists "all clear" when no carryover items pending. When CEO
  // adds carryover items, this will pull from a dedicated carryover_queue
  // table OR framework §16.5 parsing. For D-307, surface the most
  // recent v2.8X framework version's roadmap as a quick reference.
  lines.push("## Open carryover queue");
  lines.push("- D-298 §16.5 items: ALL CLEARED (D-303 chained final)");
  lines.push("- Next-batch open items per latest framework:");
  lines.push("  - umpire_k_zone backfill (D-307 first autonomous run)");
  lines.push("  - MLB Games page Sonnet enrichment (D-305-SIDE finding)");
  lines.push("  - totals-Elite tier collapse investigation (D-305 SHIP 6)");
  lines.push("  - Strong tier overfit investigation (D-305 SHIP 4)");
  lines.push("  - DB-tunable weights (D-301 critical finding, prereq for optimizer)");
  lines.push("  - score_offense_differential inversion fix (4× confirmed)");
  lines.push("  - Retire 4 candidate factors (ballpark, weather_temp/wind, h2h)");
  lines.push("  - MLB batter market warehouses (D-30Y scope)");
  lines.push("");

  lines.push("## Recommended CEO actions");
  if (blocked.length > 0) {
    lines.push(`- Review ${blocked.length} blocked task(s) — approve or reject`);
  }
  if (alerts.filter(a => a.severity === "hard_alert" || a.severity === "critical").length > 0) {
    lines.push("- Investigate critical/hard alerts");
  }
  if (completed.length === 0 && blocked.length === 0 && failed.length === 0) {
    lines.push("- No orchestrator activity in last 24h (cron not yet enabled OR no enqueued tasks)");
  }
  lines.push("");

  lines.push("---");
  lines.push(`Generated ${now.toISOString()} by orchestrator-daily-report`);

  const md = lines.join("\n");

  // Optional: log a summary alert
  if (blocked.length > 0 || alerts.length > 0) {
    await fetch(`${SUPABASE_URL}/rest/v1/cache_orchestrator_alerts`, {
      method: "POST",
      headers: { ...sH(), Prefer: "return=minimal" },
      body: JSON.stringify({
        severity: "info",
        alert_type: "daily_report_summary",
        title: `Daily report ${today}: ${completed.length} completed, ${blocked.length} blocked, ${failed.length} failed, ${alerts.length} alerts`,
        details: { date: today, blocked_count: blocked.length, alerts_count: alerts.length },
      }),
    });
  }

  if (format === "markdown") return j(null, 200, md);
  return j({
    success: true,
    date: today,
    completed: completed.length,
    blocked: blocked.length,
    failed: failed.length,
    alerts: alerts.length,
    production_errors: productionAlerts.length,
    markdown: md,
  });
});
