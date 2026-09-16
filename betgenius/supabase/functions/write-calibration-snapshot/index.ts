// write-calibration-snapshot — daily calibration metrics snapshot writer.
// May 11, 2026.
//
// Triggered by cron jobid 13 at 11:15 UTC daily (after resolve-picks 10:30
// daily settles overnight bets, before 14:00 UTC process-games slate).
// Calls SQL function write_calibration_snapshot(CURRENT_DATE) which writes
// ~40+ rows across rolling_7d / rolling_30d / all_time x overall / tier /
// prop_type / factor_presence metric types.
//
// Pattern matches snapshot-opp-stats (C26-B):
//   - service-role gated via BACKFILL_AUTH_TOKEN / SUPABASE_SERVICE_ROLE_KEY
//   - structured error logging to error_log + notifications_log
//   - Sentry capture on unhandled exceptions
//   - notify() severity routing (info on success, critical on failure)

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { notify } from "../_shared/notify.ts";
import { captureError } from "../_shared/sentry.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const supaUrl = Deno.env.get("SUPABASE_URL") || "";
  // D-365 FIX: separate concerns.
  //   restApiKey  → must be a real Supabase service-role key (JWT or sb_secret_)
  //                 for PostgREST to accept on outgoing REST calls.
  //   gateAccept[]→ tokens we accept on INCOMING auth (BACKFILL_AUTH_TOKEN
  //                 supports the vault-cron path; SERVICE_ROLE supports
  //                 direct invocations).
  const restApiKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const gateAccept = [
    Deno.env.get("BACKFILL_AUTH_TOKEN") || "",
    restApiKey,
  ].filter((s) => s.length > 0);

  if (!supaUrl || !restApiKey) {
    return jsonResponse({ success: false, error: "env missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" }, 500);
  }

  // Service-role gate — incoming bearer must equal one of the accepted tokens.
  const auth = req.headers.get("authorization") || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!bearer || !gateAccept.some((t) => bearer === t)) {
    return jsonResponse({ success: false, error: "service_role required" }, 401);
  }

  // D-262 dry-run gate: parse body.dry_run. When true: short-circuit the RPC
  // entirely (write_calibration_snapshot is itself a write — there is no
  // separate read path). Predict row count from the well-known SQL contract
  // (3 windows × ~14 metric types ≈ 42 rows, observed via prior run).
  let dryRun = false;
  if (req.method === "POST") {
    try {
      const text = await req.text();
      if (text) {
        const body = JSON.parse(text);
        if (body?.dry_run === true) dryRun = true;
      }
    } catch { /* empty body OK */ }
  }

  const startMs = Date.now();

  if (dryRun) {
    // No external mutating API call here; the function's only write is the
    // RPC itself, so we just skip it and return the dry-run shape.
    return jsonResponse({
      dry_run: true,
      would_write: {
        // RPC inserts into calibration_snapshots; suppressed entirely.
        calibration_snapshots: null,  // unknown without running RPC; gate-driven N/A
        notifications_log: 0,  // notify() also suppressed
      },
      elapsed_ms: Date.now() - startMs,
    });
  }

  let rowsInserted = 0;
  let errorMessage: string | null = null;
  let httpStatus = 0;

  try {
    // Call the RPC. Body is empty — function defaults to CURRENT_DATE.
    const res = await fetch(`${supaUrl}/rest/v1/rpc/write_calibration_snapshot`, {
      method: "POST",
      headers: {
        // D-365 FIX: outgoing PostgREST calls require the JWT/sb_secret_-format
        // SUPABASE_SERVICE_ROLE_KEY, NOT BACKFILL_AUTH_TOKEN (which can be a
        // UUID handshake value).
        apikey: restApiKey,
        Authorization: `Bearer ${restApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    });
    httpStatus = res.status;
    const text = await res.text();
    if (!res.ok) {
      errorMessage = `write_calibration_snapshot RPC returned status=${httpStatus}: ${text.slice(0, 400)}`;
    } else {
      // RPC returns a single integer
      const parsed = Number(text);
      if (!Number.isFinite(parsed)) {
        errorMessage = `RPC returned non-numeric: ${text.slice(0, 200)}`;
      } else {
        rowsInserted = parsed;
      }
    }
  } catch (e) {
    errorMessage = `fetch threw: ${e instanceof Error ? e.message : String(e)}`;
  }

  const durationMs = Date.now() - startMs;

  if (errorMessage) {
    await captureError(new Error(errorMessage), {
      function: "write-calibration-snapshot",
      phase: "rpc-call",
      http_status: httpStatus,
    });
    await notify({
      severity: "critical",
      title: "write-calibration-snapshot failed",
      message: errorMessage,
      metadata: { http_status: httpStatus, duration_ms: durationMs },
    });
    return jsonResponse({
      success: false,
      error: errorMessage,
      http_status: httpStatus,
      duration_ms: durationMs,
    }, 500);
  }

  await notify({
    severity: "info",
    title: "write-calibration-snapshot daily run",
    message: `Inserted ${rowsInserted} rows across 3 windows x 4 metric types. Duration ${durationMs}ms.`,
    metadata: { rows_inserted: rowsInserted, duration_ms: durationMs },
  });

  return jsonResponse({
    success: true,
    rows_inserted: rowsInserted,
    duration_ms: durationMs,
  });
});
