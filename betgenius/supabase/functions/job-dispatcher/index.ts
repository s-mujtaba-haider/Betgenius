declare const Deno: any;
// D-330 Phase B SHIP 2 — job-dispatcher.
//
// Polls scheduled_jobs for pending rows whose run_at <= now(), claims up to
// MAX_PER_TICK of them atomically via the claim_due_jobs RPC (FOR UPDATE SKIP
// LOCKED so concurrent dispatcher invocations cannot grab the same row),
// invokes each function in parallel (concurrency MAX_CONCURRENCY), then
// writes terminal status via mark_job_completed RPC.
//
// Status transitions:
//   pending --(claim)--> running --(invoke)--> completed | skipped | failed
//
// Skip vs failed distinction:
//   skipped = response { success: true, skipped: true } (entry-guard skip,
//             expected operational state — not a problem)
//   failed  = HTTP non-2xx, or response.success === false
//   completed = HTTP 2xx + response.success === true + skipped !== true
//
// AUTH: service-role only.
// Hard cap per job: 130s (just under the 150s edge function wall).
// Hard cap per tick: ~140s aggregate. Cron fires every 1 min so any
//   in-flight invocations finish before the next firing's claim.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { notify } from "../_shared/notify.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const BACKFILL_TOKEN = Deno.env.get("BACKFILL_AUTH_TOKEN") ?? "";

const MAX_PER_TICK = 10;
const MAX_CONCURRENCY = 5;
const PER_JOB_TIMEOUT_MS = 130_000;

const corsHeaders = { "Access-Control-Allow-Origin": "*" };
function j(d: unknown, s = 200) {
  return new Response(JSON.stringify(d, null, 2), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
const sH = () => ({ apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" });

interface ClaimedJob {
  job_id: number;
  function_name: string;
  payload: Record<string, unknown>;
  run_at: string;
  attempt_count: number;
}

async function claimDueJobs(limit: number): Promise<ClaimedJob[]> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/claim_due_jobs`, {
    method: "POST",
    headers: sH(),
    body: JSON.stringify({ p_limit: limit }),
  });
  if (!r.ok) {
    throw new Error(`claim_due_jobs RPC failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
  }
  return await r.json() as ClaimedJob[];
}

async function markJobCompleted(
  jobId: number,
  status: "completed" | "failed" | "skipped",
  result: unknown,
  errorText: string | null,
): Promise<string> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/mark_job_completed`, {
    method: "POST",
    headers: sH(),
    body: JSON.stringify({
      p_job_id: jobId,
      p_status: status,
      p_result: result === undefined ? null : result,
      p_error: errorText,
    }),
  });
  if (!r.ok) {
    // Don't throw — terminal-state write failure shouldn't crash the dispatcher.
    // Worst case: row stays in 'running' until 10-min ops sweep cleans it.
    console.error(`[dispatcher] mark_job_completed failed for ${jobId}: ${r.status}`);
    return status;
  }
  try {
    return await r.json() as string;
  } catch {
    return status;
  }
}

async function invokeJob(job: ClaimedJob): Promise<{ status: "completed" | "failed" | "skipped"; result: unknown; errorText: string | null }> {
  const url = `${SUPABASE_URL}/functions/v1/${job.function_name}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), PER_JOB_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { ...sH() },
      body: JSON.stringify(job.payload),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    let result: Record<string, unknown> = {};
    try { result = await res.json(); } catch { /* tolerate non-JSON */ }

    if (!res.ok) {
      return {
        status: "failed",
        result: { http_status: res.status, ...result },
        errorText: `HTTP ${res.status}: ${String(result.error ?? "no body").slice(0, 200)}`,
      };
    }

    // Success path — partition into completed vs skipped.
    if (result.success === false) {
      return {
        status: "failed",
        result,
        errorText: String(result.error ?? "function returned success=false").slice(0, 200),
      };
    }
    if (result.skipped === true) {
      return {
        status: "skipped",
        result,
        errorText: null,
      };
    }
    return {
      status: "completed",
      result,
      errorText: null,
    };
  } catch (e) {
    clearTimeout(timeoutId);
    const msg = e instanceof Error ? e.message : String(e);
    return {
      status: "failed",
      result: { exception: msg },
      errorText: `dispatcher_exception: ${msg.slice(0, 200)}`,
    };
  }
}

async function concurrentMap<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) break;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const t0 = Date.now();

  const auth = req.headers.get("Authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!bearer || (bearer !== SUPABASE_KEY && bearer !== BACKFILL_TOKEN)) {
    return j({ error: "unauthorized" }, 401);
  }

  let claimed: ClaimedJob[] = [];
  try {
    claimed = await claimDueJobs(MAX_PER_TICK);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return j({ success: false, error: `claim_failed: ${msg}`, dispatched: 0, errors: 0, duration_ms: Date.now() - t0 }, 500);
  }

  if (claimed.length === 0) {
    return j({
      success: true,
      dispatched: 0,
      skipped: 0,
      failed: 0,
      claimed: 0,
      duration_ms: Date.now() - t0,
    });
  }

  const results = await concurrentMap(claimed, MAX_CONCURRENCY, async (job) => {
    const outcome = await invokeJob(job);
    const finalStatus = await markJobCompleted(job.job_id, outcome.status, outcome.result, outcome.errorText);
    
    if (finalStatus === "failed") {
      await notify({ severity: "critical", title: "Job Failed", message: `Job ${job.job_id} (${job.function_name}) reached terminal failure status. Attempt count: ${job.attempt_count + 1}.\nLast error: ${outcome.errorText}` });
    }
    
    return { job_id: job.job_id, function_name: job.function_name, status: finalStatus };
  });

  const dispatched = results.filter(r => r.status === "completed").length;
  const skipped = results.filter(r => r.status === "skipped").length;
  const failed = results.filter(r => r.status === "failed").length;

  return j({
    success: true,
    dispatched,
    skipped,
    failed,
    claimed: claimed.length,
    duration_ms: Date.now() - t0,
    per_job: results,
  });
});