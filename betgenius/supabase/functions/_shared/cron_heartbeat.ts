// _shared/cron_heartbeat.ts — D-272-INF-2.
//
// Each cron writes one heartbeat row on completion (success OR error
// path). Schema in supabase/migrations/20260520000002_d272_inf2_cron_heartbeat.sql.
//
// writeHeartbeat upserts on (job_name). On error path it bumps
// consecutive_failures; on success it resets to 0.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

export type CronStatus = "success" | "error" | "partial";

interface WriteHeartbeatArgs {
  jobName: string;
  status: CronStatus;
  durationMs?: number;
  error?: string | null;
}

const heartbeatHeaders = (): Record<string, string> => ({
  apikey: SERVICE_ROLE,
  Authorization: `Bearer ${SERVICE_ROLE}`,
  "Content-Type": "application/json",
});

// Best-effort: never throw, never crash the caller's success path.
export async function writeHeartbeat(args: WriteHeartbeatArgs): Promise<void> {
  if (!SUPABASE_URL || !SERVICE_ROLE) return;
  const { jobName, status, durationMs, error } = args;
  try {
    // Step 1: read current consecutive_failures so error-path increment
    // works without a race.
    let consecutiveFailures = 0;
    try {
      const readRes = await fetch(
        `${SUPABASE_URL}/rest/v1/cron_heartbeat?job_name=eq.${encodeURIComponent(jobName)}&select=consecutive_failures&limit=1`,
        { headers: heartbeatHeaders() },
      );
      if (readRes.ok) {
        const rows = await readRes.json() as Array<{ consecutive_failures: number }>;
        if (rows.length > 0) consecutiveFailures = rows[0].consecutive_failures ?? 0;
      }
    } catch { /* tolerate */ }

    const nextFailures = status === "success" ? 0 : consecutiveFailures + 1;

    // Step 2: upsert by job_name. Postgrest UPSERT requires Prefer: resolution=merge-duplicates.
    await fetch(`${SUPABASE_URL}/rest/v1/cron_heartbeat?on_conflict=job_name`, {
      method: "POST",
      headers: {
        ...heartbeatHeaders(),
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify({
        job_name: jobName,
        last_fired_at: new Date().toISOString(),
        last_status: status,
        last_duration_ms: durationMs ?? null,
        last_error: error ?? null,
        consecutive_failures: nextFailures,
        updated_at: new Date().toISOString(),
      }),
    });
  } catch (e) {
    // Swallow — heartbeat failure must not break the cron itself.
    console.log(`[cron_heartbeat] write failed for ${jobName}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

// Convenience wrapper that times the body and writes a heartbeat on
// both success + error paths.
export async function withHeartbeat<T>(
  jobName: string,
  fn: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  try {
    const result = await fn();
    await writeHeartbeat({
      jobName,
      status: "success",
      durationMs: Date.now() - start,
    });
    return result;
  } catch (err) {
    await writeHeartbeat({
      jobName,
      status: "error",
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
    });
    throw err;
  }
}

// detect_silent_crons() — DB view that surfaces silent crons. Call
// this from an admin dashboard or alerting cron.
export async function detectSilentCrons(): Promise<Array<{
  job_name: string;
  last_fired_at: string;
  last_status: string;
  seconds_since_last_fire: number;
  is_silent: boolean;
}>> {
  if (!SUPABASE_URL || !SERVICE_ROLE) return [];
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/detect_silent_crons?is_silent=eq.true&select=*`,
      { headers: heartbeatHeaders() },
    );
    if (!res.ok) return [];
    return await res.json();
  } catch {
    return [];
  }
}
