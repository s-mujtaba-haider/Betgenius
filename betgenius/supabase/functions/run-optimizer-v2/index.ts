// run-optimizer-v2 — walk-forward validating optimizer wrapper (May 7, 2026 evening).
//
// Phase 5 of the May-7 ML upgrade. Wraps optimize_weights_walk_forward
// (migration 20260507000006) which itself wraps optimize_weights_multi_weight
// (migration 20260507000005) — multi-weight adaptive search + larger step
// sizes (±0.25/±0.5/±0.75/±1.0) trained on Feb 1 - Mar 31 synthetic, validated
// on Apr 1 - May 3 synthetic.
//
// Differs from run-optimizer (old single-weight ±0.25 wrapper) in two ways:
//   1. Walk-forward decision drives apply: only APPROVE routes through
//      apply_optimized_weights_with_gate_synthetic. NO_SIGNAL,
//      REJECT_OVERFIT, INSUFFICIENT_VALIDATE_DATA, NO_PROPOSAL all return
//      audit-only without touching algorithm_weights.
//   2. Notification severity reflects decision quality, not just gate outcome:
//        APPROVE                    → info (held-out signal confirmed)
//        NO_SIGNAL                  → info (system working — no spurious change)
//        REJECT_OVERFIT             → warning (gate caught noise — investigate)
//        INSUFFICIENT_VALIDATE_DATA → warning (sample size issue)
//        NO_PROPOSAL                → info (search converged with no candidate)
//        ERROR                      → critical
//
// AUTH: service-role-tier via BACKFILL_AUTH_TOKEN (matches run-optimizer).
//
// SCHEDULE: Phase 7 of this session points jobid 12 cron at this URL.
// Old run-optimizer stays deployed for rollback safety.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { notify } from "../_shared/notify.ts";
import { captureError } from "../_shared/sentry.ts";

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

type Decision =
  | "APPROVE"
  | "NO_SIGNAL"
  | "REJECT_OVERFIT"
  | "INSUFFICIENT_VALIDATE_DATA"
  | "NO_PROPOSAL";

interface WalkForwardResult {
  status?: "completed" | "no_proposal" | "error";
  decision?: Decision;
  decision_reason?: string;
  reason?: string;
  threshold?: number;
  train_window?: { start: string; end: string };
  validate_window?: { start: string; end: string };
  train_baseline_wr?: number;
  train_proposed_wr?: number;
  train_baseline_picks?: number;
  train_delta_pp?: number;
  validate_baseline_wr?: number;
  validate_proposed_wr?: number;
  validate_baseline_picks?: number;
  validate_proposed_picks?: number;
  validate_delta_pp?: number;
  best_descriptor?: string;
  best_pass?: string;
  iterations?: number | string;
  proposal?: Record<string, number> | null;
}

interface GateResult {
  status?: "applied" | "rejected";
  baseline_wr?: number;
  proposed_wr?: number;
  delta_pp?: number;
  baseline_picks?: number;
  proposed_picks?: number;
  reason?: string;
  audit_id?: string;
}

// Default windows — match optimize_weights_walk_forward defaults.
const DEFAULT_TRAIN_START = "2026-02-01";
const DEFAULT_TRAIN_END = "2026-03-31";
const DEFAULT_VALIDATE_START = "2026-04-01";
const DEFAULT_VALIDATE_END = "2026-05-03";
const DEFAULT_THRESHOLD = 70;

async function callRpc<T>(
  supaUrl: string, supaKey: string, fn: string, body: Record<string, unknown>,
): Promise<{ ok: boolean; httpStatus: number; result: T | null; errorBody: string }> {
  let httpStatus = 0;
  let errorBody = "";
  let result: T | null = null;
  try {
    const res = await fetch(`${supaUrl}/rest/v1/rpc/${fn}`, {
      method: "POST",
      headers: {
        apikey: supaKey,
        Authorization: `Bearer ${supaKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    httpStatus = res.status;
    const text = await res.text();
    if (res.ok) {
      try { result = JSON.parse(text) as T; }
      catch (_e) { errorBody = `non-JSON response: ${text.slice(0, 500)}`; }
    } else {
      errorBody = `HTTP ${res.status}: ${text.slice(0, 500)}`;
    }
  } catch (e) {
    errorBody = `fetch threw: ${e instanceof Error ? e.message : String(e)}`;
  }
  return { ok: !errorBody && result !== null, httpStatus, result, errorBody };
}

Deno.serve(async (req) => {
  // OBS-02: top-level try/catch wraps the entire handler body so any thrown
  // error reaches Sentry. Existing notify() calls inside the body keep firing
  // for known structured outcomes; this catches anything unexpected.
  try {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST" && req.method !== "GET") {
    return jsonResponse({ success: false, error: "POST or GET only" }, 405);
  }

  const supaUrl = Deno.env.get("SUPABASE_URL") || "";
  // D-378 SHIP 2c — D-365 separation pattern.
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

  // Optional override windows via JSON body (defaults match SQL function defaults).
  let body: Record<string, unknown> = {};
  if (req.method === "POST") {
    try {
      const text = await req.text();
      if (text) body = JSON.parse(text);
    } catch (_e) {
      // Empty/invalid body is fine — fall through to defaults.
    }
  }
  const threshold = (body.threshold as number) || DEFAULT_THRESHOLD;
  const trainStart = (body.train_start as string) || DEFAULT_TRAIN_START;
  const trainEnd = (body.train_end as string) || DEFAULT_TRAIN_END;
  const validateStart = (body.validate_start as string) || DEFAULT_VALIDATE_START;
  const validateEnd = (body.validate_end as string) || DEFAULT_VALIDATE_END;

  // D-262 dry-run gate: when body.dry_run === true, run the walk-forward
  // RPC (read-only — it's a SELECT against pick_history) but SKIP the
  // apply_optimized_weights_with_gate_synthetic RPC (the only writer to
  // algorithm_weights). Also skip notify() to avoid notifications_log
  // pollution from operator smoke tests.
  const dryRun = body.dry_run === true;

  const startMs = Date.now();

  // STEP 1: Run walk-forward search.
  const wfCall = await callRpc<WalkForwardResult>(
    supaUrl, supaKey, "optimize_weights_walk_forward",
    {
      threshold,
      train_start: trainStart, train_end: trainEnd,
      validate_start: validateStart, validate_end: validateEnd,
    },
  );

  let result = wfCall.result;
  let httpStatus = wfCall.httpStatus;
  let errorBody = wfCall.errorBody;

  // STEP 2: Conditional apply on APPROVE only.
  let gateResult: GateResult | null = null;
  let gateErrorBody = "";
  let applied = false;

  if (result && result.status === "completed" && result.decision === "APPROVE" && result.proposal) {
    // D-262: in dry-run, skip the apply RPC (the ONLY algorithm_weights writer).
    if (dryRun) {
      gateResult = null;
      gateErrorBody = "";
      applied = false;
    } else {
      const gateCall = await callRpc<GateResult>(
        supaUrl, supaKey, "apply_optimized_weights_with_gate_synthetic",
        {
          proposed_weights: result.proposal,
          confidence_threshold: threshold,
          invoked_by: "run-optimizer-v2 walk-forward APPROVE",
        },
      );
      gateResult = gateCall.result;
      gateErrorBody = gateCall.errorBody;
      applied = gateResult?.status === "applied";
    }
  }

  const durationMs = Date.now() - startMs;

  // STEP 3: Determine notification severity + message.
  let severity: "info" | "warning" | "critical" = "info";
  let title = "Walk-forward optimizer weekly run";
  let message = "";

  const decision: Decision | "ERROR" =
    errorBody || !result ? "ERROR" :
    result.status === "error" ? "ERROR" :
    (result.decision as Decision) || "ERROR";

  if (decision === "ERROR") {
    severity = "critical";
    title = "Walk-forward optimizer error";
    const reasonStr = result?.reason || result?.decision_reason || "(no reason)";
    message = `RPC failed or unexpected response. ${errorBody || reasonStr}`;
  } else if (decision === "APPROVE") {
    severity = "info";
    title = applied
      ? "Walk-forward optimizer APPLIED weight change"
      : "Walk-forward APPROVE but gate blocked";
    const trainPicks = result?.train_baseline_picks ?? "?";
    const valPicks = result?.validate_baseline_picks ?? "?";
    const trainDelta = result?.train_delta_pp ?? 0;
    const valDelta = result?.validate_delta_pp ?? 0;
    const desc = result?.best_descriptor || "(unknown)";
    const pass = result?.best_pass || "(unknown)";
    if (applied) {
      message = `${desc} (${pass}). train +${Number(trainDelta).toFixed(2)}pp on ${trainPicks} picks, ` +
        `validate +${Number(valDelta).toFixed(2)}pp on ${valPicks} picks. ` +
        `Gate applied: WR ${gateResult?.baseline_wr}% → ${gateResult?.proposed_wr}% (delta ${gateResult?.delta_pp}pp on full corpus). ` +
        `audit_id=${gateResult?.audit_id}`;
    } else {
      severity = "warning";
      message = `Walk-forward APPROVE but synthetic-corpus gate blocked: ${gateResult?.reason || gateErrorBody || "unknown"}. ` +
        `Walk-forward: ${desc} (${pass}), train +${Number(trainDelta).toFixed(2)}pp / validate +${Number(valDelta).toFixed(2)}pp. ` +
        `Gate audit_id=${gateResult?.audit_id || "(none)"}`;
    }
  } else if (decision === "NO_SIGNAL") {
    severity = "info";
    title = "Walk-forward optimizer NO_SIGNAL";
    const trainDelta = result?.train_delta_pp ?? 0;
    const valDelta = result?.validate_delta_pp ?? 0;
    const trainPicks = result?.train_baseline_picks ?? "?";
    const valPicks = result?.validate_baseline_picks ?? "?";
    const desc = result?.best_descriptor || "(unknown)";
    const pass = result?.best_pass || "(unknown)";
    message = `Train ${desc} (${pass}) +${Number(trainDelta).toFixed(2)}pp on ${trainPicks} picks ` +
      `did not transfer — validate delta ${Number(valDelta).toFixed(2)}pp on ${valPicks} picks ` +
      `within noise band. No weight change.`;
  } else if (decision === "REJECT_OVERFIT") {
    severity = "warning";
    title = "Walk-forward optimizer REJECT_OVERFIT";
    const trainDelta = result?.train_delta_pp ?? 0;
    const valDelta = result?.validate_delta_pp ?? 0;
    const trainPicks = result?.train_baseline_picks ?? "?";
    const valPicks = result?.validate_baseline_picks ?? "?";
    const desc = result?.best_descriptor || "(unknown)";
    const pass = result?.best_pass || "(unknown)";
    message = `Gate caught overfit: train ${desc} (${pass}) +${Number(trainDelta).toFixed(2)}pp on ${trainPicks} picks, ` +
      `validate ${Number(valDelta).toFixed(2)}pp on ${valPicks} picks. ` +
      `Proposed weights perform WORSE on held-out — likely noise. No weight change.`;
  } else if (decision === "INSUFFICIENT_VALIDATE_DATA") {
    severity = "warning";
    title = "Walk-forward optimizer INSUFFICIENT_VALIDATE_DATA";
    const valPicks = result?.validate_baseline_picks ?? 0;
    message = `Validate window has insufficient picks at threshold ${threshold} (got ${valPicks}). ` +
      `Walk-forward cannot decide; no weight change. ` +
      `Reason: ${result?.decision_reason || "(unknown)"}`;
  } else if (decision === "NO_PROPOSAL") {
    severity = "info";
    title = "Walk-forward optimizer NO_PROPOSAL";
    const trainPicks = result?.train_baseline_picks ?? "?";
    const trainDelta = result?.train_delta_pp ?? 0;
    message = `Multi-weight search found no improvement on training window (${trainPicks} picks at threshold ${threshold}, ` +
      `best train delta ${Number(trainDelta).toFixed(2)}pp). Coordinate descent has converged. No weight change.`;
  }

  // D-262: suppress notify() in dry-run (notifications_log pollution).
  if (!dryRun) {
    await notify({
      severity,
      title,
      message,
      metadata: {
        duration_ms: durationMs,
        http_status: httpStatus,
        decision,
        threshold,
        train_window: { start: trainStart, end: trainEnd },
        validate_window: { start: validateStart, end: validateEnd },
        walk_forward_result: result ?? null,
        gate_result: gateResult ?? null,
        gate_error: gateErrorBody || null,
        error_body: errorBody || null,
        applied,
      },
    });
  }

  if (dryRun) {
    // would_write.algorithm_weights = 1 IF decision === APPROVE (would call
    // apply RPC which conditionally UPDATEs algorithm_weights). For all other
    // decisions, no write would happen.
    const wouldWriteWeights = (decision === "APPROVE") ? 1 : 0;
    return jsonResponse({
      dry_run: true,
      duration_ms: durationMs,
      decision,
      would_write: {
        algorithm_weights: wouldWriteWeights,
        notifications_log: 0,
      },
      walk_forward_result: result,
      gate_result: null,
      elapsed_ms: durationMs,
    });
  }

  return jsonResponse({
    success: !errorBody && result?.status !== undefined,
    duration_ms: durationMs,
    decision,
    applied,
    notification_severity: severity,
    notification_title: title,
    notification_message: message,
    walk_forward_result: result,
    gate_result: gateResult,
    error: errorBody || null,
  }, errorBody || !result ? 500 : 200);
  } catch (err) {
    // OBS-02: surface to Sentry. Existing notify() inside the try block fires
    // for known structured outcomes (REJECT_OVERFIT, NO_SIGNAL, etc); this
    // catches truly-unexpected throws.
    console.error("[run-optimizer-v2] FATAL:", err);
    await captureError(err, {
      function: "run-optimizer-v2",
      phase: "top-level-handler",
      method: req.method,
    });
    return jsonResponse({
      success: false,
      error: err instanceof Error ? err.message : "Internal server error",
    }, 500);
  }
});
