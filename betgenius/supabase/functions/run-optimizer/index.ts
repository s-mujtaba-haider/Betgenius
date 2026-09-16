// run-optimizer — wraps the optimizer with structured notification (May 7, 2026).
//
// Per CEO decision: move auto-optimizer from manual-only (Path C, D-083)
// to weekly cron with notification on every run. §19.3 spirit (no surprise
// algorithm changes) preserved via full notifications_log audit trail —
// every run produces a notify() call regardless of gate decision.
//
// IMPORTANT — wraps optimize_weights_synthetic_run, NOT auto_optimize_weights:
//
//   auto_optimize_weights() body has been a placeholder no-op since
//   migration 20260505000004 (D-091, May 5). It just proposes current weights
//   as the proposal — gate sees delta=0 and applies trivially. Real
//   coordinate-descent logic lives in optimize_weights_synthetic_run() per
//   migration 20260506000004 (May 6). Yesterday's manual optimizer run that
//   landed w_stale_data 1.5→1.75 was via optimize_weights_synthetic_run, not
//   auto_optimize_weights despite the framework v2.27 D-083 / D-091 / D-097
//   trail being a bit ambiguous on which function name does what.
//
//   CEO's Task 5 constraint says "DO NOT change auto_optimize_weights body."
//   So this wrapper calls optimize_weights_synthetic_run directly. When CEO
//   eventually upgrades auto_optimize_weights body to real coordinate
//   descent (e.g., against organic post-megadeploy data once enough
//   accumulates), update this wrapper's RPC target to match.
//
// AUTH: service-role-tier via BACKFILL_AUTH_TOKEN pattern (commit 4e2144e).
//
// SCHEDULE: pg_cron weekly Sunday 11:00 UTC = 6am ET. SQL command in
// /tmp/auto_optimizer_cron_summary_may7.md for CEO to apply.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { notify } from "../_shared/notify.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

interface OptimizerResult {
  status?: "applied" | "rejected" | "no_improvement" | "error";
  reason?: string;
  baseline_wr?: number;
  proposed_wr?: number;
  best_wr?: number;
  delta_pp?: number;
  baseline_picks?: number;
  proposed_picks?: number;
  iterations?: number;
  best_perturb_key?: string | null;
  best_perturb_dir?: number | null;
  best_perturb_amount?: number | null;
  optimizer_baseline_wr?: number;
  optimizer_best_wr?: number;
  audit_id?: string;
  min_improvement_pp?: number;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST" && req.method !== "GET") {
    return jsonResponse({ success: false, error: "POST or GET only" }, 405);
  }

  const supaUrl = Deno.env.get("SUPABASE_URL") || "";
  // D-378 SHIP 2b — D-365 separation pattern.
  //   supaKey  → outgoing PostgREST apikey; MUST be SERVICE_ROLE_KEY only.
  //   gateAccept[] → tokens accepted on INCOMING gate.
  // Previously supaKey fell back to BACKFILL_AUTH_TOKEN which PostgREST
  // rejects as an apikey when it's a vault UUID.
  const supaKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const backfillToken = Deno.env.get("BACKFILL_AUTH_TOKEN") || "";
  const gateAccept = [backfillToken, supaKey].filter(Boolean);

  if (!supaUrl || !supaKey) {
    return jsonResponse({ success: false, error: "edge function env missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" }, 500);
  }

  const auth = req.headers.get("authorization") || "";
  const matches = gateAccept.some((t) => auth.includes(t));
  if (!matches) {
    return jsonResponse({ success: false, error: "service_role key required" }, 401);
  }

  const startMs = Date.now();
  let result: OptimizerResult | null = null;
  let httpStatus = 0;
  let errorBody = "";

  try {
    const res = await fetch(
      `${supaUrl}/rest/v1/rpc/optimize_weights_synthetic_run`,
      {
        method: "POST",
        headers: {
          apikey: supaKey,
          Authorization: `Bearer ${supaKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
      },
    );
    httpStatus = res.status;
    const text = await res.text();
    if (res.ok) {
      try { result = JSON.parse(text) as OptimizerResult; }
      catch (_e) { errorBody = `non-JSON response: ${text.slice(0, 500)}`; }
    } else {
      errorBody = `HTTP ${res.status}: ${text.slice(0, 500)}`;
    }
  } catch (e) {
    errorBody = `fetch threw: ${e instanceof Error ? e.message : String(e)}`;
  }

  const durationMs = Date.now() - startMs;

  // Determine notification severity + title from result.
  // Always notify — that's the key §19.3-spirit guarantee CEO wanted.
  // Severity routing per CEO spec:
  //   APPLIED        → info  (good news; weight changed; audit row written)
  //   REJECTED       → warning (gate working; no change; investigate why)
  //   NO_IMPROVEMENT → info  (steady state — coordinate descent has converged)
  //   ERROR          → critical (something broke)
  let severity: "info" | "warning" | "critical" = "info";
  let title = "Auto-optimizer weekly run";
  let message = "";

  if (errorBody) {
    severity = "critical";
    title = "Auto-optimizer error";
    message = `RPC failed: ${errorBody}`;
  } else if (!result || !result.status) {
    severity = "critical";
    title = "Auto-optimizer error";
    message = `unexpected response shape: ${JSON.stringify(result).slice(0, 300)}`;
  } else if (result.status === "applied") {
    severity = "info";
    title = "Auto-optimizer applied weight change";
    message = `${result.best_perturb_key} ${result.best_perturb_dir === 1 ? "+" : "-"}${result.best_perturb_amount} ` +
      `→ WR ${result.baseline_wr}% → ${result.proposed_wr}% (+${result.delta_pp}pp at threshold 70). ` +
      `Iter ${result.iterations}. audit_id=${result.audit_id}`;
  } else if (result.status === "rejected") {
    severity = "warning";
    title = "Auto-optimizer proposal rejected by gate";
    message = `${result.reason || "unknown reason"}. Best perturbation was ${result.best_perturb_key} ` +
      `${result.best_perturb_dir === 1 ? "+" : "-"}${result.best_perturb_amount}. ` +
      `audit_id=${result.audit_id}`;
  } else if (result.status === "no_improvement") {
    severity = "info";
    title = "Auto-optimizer found no improvement";
    message = `Baseline WR ${result.baseline_wr}%, best perturbation only ${result.delta_pp}pp ` +
      `(below ${result.min_improvement_pp}pp threshold). ${result.iterations} iterations. ` +
      `Best candidate: ${result.best_perturb_key} ${result.best_perturb_dir === 1 ? "+" : "-"}${result.best_perturb_amount}.`;
  } else {
    severity = "critical";
    title = "Auto-optimizer error";
    message = `unexpected status: ${result.status}. reason: ${result.reason || "(none)"}`;
  }

  await notify({
    severity,
    title,
    message,
    metadata: {
      duration_ms: durationMs,
      http_status: httpStatus,
      result: result ?? null,
      error_body: errorBody || null,
    },
  });

  return jsonResponse({
    success: !errorBody && result?.status !== undefined,
    duration_ms: durationMs,
    notification_severity: severity,
    notification_title: title,
    notification_message: message,
    optimizer_result: result,
    error: errorBody || null,
  }, errorBody || !result ? 500 : 200);
});
