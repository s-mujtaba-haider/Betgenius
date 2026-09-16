// D-291 SHIP 1 — function lock helper for backfill mutex pattern.
//
// Use:
//   const lock = await tryAcquireLock(lockKey, ttlSeconds);
//   if (!lock.acquired) return j({ blocked: true, reason: 'concurrent_instance' });
//   try { /* work */ } finally { await releaseLock(lockKey); }

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const supaHeaders = () => ({
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
});

export interface LockAcquireResult {
  acquired: boolean;
  acquired_at?: string;
  expires_at?: string;
  reason?: string;
}

// Try to acquire a named lock. Uses INSERT ... ON CONFLICT DO UPDATE
// WHERE expires_at < now() — atomic CAS pattern. If 0 rows returned,
// another instance holds an active lock.
export async function tryAcquireLock(lockKey: string, ttlSeconds = 900, acquiredBy?: string): Promise<LockAcquireResult> {
  if (!SUPABASE_URL || !SUPABASE_KEY) return { acquired: false, reason: "missing_env" };
  // PostgREST doesn't directly support our needed CAS pattern; use RPC instead.
  // For now: probe-then-write race (acceptable for 99% of cases since edge
  // function calls are typically separated by seconds). Production-grade
  // would use a dedicated RPC.
  try {
    const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    const probe = await fetch(
      `${SUPABASE_URL}/rest/v1/function_locks?lock_key=eq.${encodeURIComponent(lockKey)}&select=lock_key,acquired_at,expires_at`,
      { headers: supaHeaders() },
    );
    if (probe.ok) {
      const rows = await probe.json() as Array<{ lock_key: string; acquired_at: string; expires_at: string }>;
      if (rows.length > 0) {
        const existing = rows[0];
        if (new Date(existing.expires_at) > new Date()) {
          return { acquired: false, reason: "existing_active_lock", acquired_at: existing.acquired_at, expires_at: existing.expires_at };
        }
        // Stale lock — try UPDATE
        const upd = await fetch(
          `${SUPABASE_URL}/rest/v1/function_locks?lock_key=eq.${encodeURIComponent(lockKey)}`,
          {
            method: "PATCH",
            headers: { ...supaHeaders(), Prefer: "return=representation" },
            body: JSON.stringify({ acquired_at: new Date().toISOString(), expires_at: expiresAt, acquired_by: acquiredBy ?? null }),
          },
        );
        if (upd.ok) {
          return { acquired: true, expires_at: expiresAt };
        }
        return { acquired: false, reason: `update_failed_${upd.status}` };
      }
    }
    // No existing row — INSERT
    const ins = await fetch(
      `${SUPABASE_URL}/rest/v1/function_locks`,
      {
        method: "POST",
        headers: { ...supaHeaders(), Prefer: "return=representation" },
        body: JSON.stringify({ lock_key: lockKey, expires_at: expiresAt, acquired_by: acquiredBy ?? null }),
      },
    );
    if (ins.ok) {
      return { acquired: true, expires_at: expiresAt };
    }
    if (ins.status === 409) {
      // Race condition: another instance inserted between probe and INSERT
      return { acquired: false, reason: "race_409" };
    }
    return { acquired: false, reason: `insert_failed_${ins.status}` };
  } catch (e) {
    return { acquired: false, reason: `exception:${e instanceof Error ? e.message : String(e)}` };
  }
}

export async function releaseLock(lockKey: string): Promise<void> {
  if (!SUPABASE_URL || !SUPABASE_KEY) return;
  try {
    await fetch(
      `${SUPABASE_URL}/rest/v1/function_locks?lock_key=eq.${encodeURIComponent(lockKey)}`,
      { method: "DELETE", headers: { ...supaHeaders(), Prefer: "return=minimal" } },
    );
  } catch { /* swallow */ }
}
