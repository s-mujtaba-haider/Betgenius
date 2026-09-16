// SharpAI — backtest edge function — DEPRECATED & STUBBED
//
// History:
//   - Predates D-155 (_shared/scoring.ts extraction, 2026-05-14)
//   - Carried a private 86-line `calculateConfidenceScore` (lines 269-355
//     in pre-stub history) + sibling `calcHitRates` / `calculateMinutesTrend`
//     / `fetchGameLog` / box-score fetchers — all stale pre-D-155 versions
//     of code that has been canonical in `_shared/scoring.ts` for two weeks.
//   - D-177 multi-writer audit (commit context in /tmp/d177_multi_writer_audit.md,
//     LOW-1 finding at lines 269-355) confirmed zero callers via grep across
//     `src/`, `supabase/functions/`, and `supabase/migrations/`. No
//     `pg_cron.schedule`, no frontend `supabase.functions.invoke`, no
//     edge-function-to-edge-function reference. The live backtester is
//     the SQL function `backtest_weights_v3` / `_synthetic_windowed`
//     reached via `run-optimizer-v2` (D-105).
//   - D-192-B.6 (autonomous loop self-test, 2026-05-16) executed the
//     dead-code elimination: ~720 lines of stale scoring + ESPN fetchers
//     removed. Zero behavior change because nothing called any of it.
//
// Why a stub instead of file deletion:
//   - CLAUDE.md cardinal rule: file deletion gated on CEO approval.
//   - Keeping the file (1) preserves the Supabase function name in case
//     of any cached pg_net references the audit didn't catch, (2) emits
//     an explicit 410 so any rediscovery is obvious, (3) leaves a single
//     atomic delete migration as the obvious final cleanup once CEO is
//     ready (no orphan references to chase first).
//
// To resurrect, see git history for the pre-D-192-B.6 implementation
// (commit immediately before this stub). DO NOT copy that scoring math
// back into production — import from `_shared/scoring.ts` instead.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

Deno.serve((req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  return new Response(
    JSON.stringify({
      status: "deprecated",
      message:
        "The backtest edge function is dead code as of D-177 audit (2026-05-15) and was stubbed in D-192-B.6 (2026-05-16). Use SQL function backtest_weights_v3 via run-optimizer-v2 instead.",
      replaced_by: "backtest_weights_v3 (SQL) / run-optimizer-v2 (edge function wrapper)",
      removed_in: "D-192-B.6",
    }),
    {
      status: 410, // Gone
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    },
  );
});
