// _shared/statcast.ts — D-274 Phase 2.
//
// Statcast cache accessor. Reads the most-recent snapshot (by
// snapshot_date DESC, LIMIT 1) for a given MLB player_id from the
// 4 cache_statcast_* tables. Gracefully degrades to null when the
// player isn't in the cache (newcomer, no qualifying PA, etc).
//
// Used by scoring_mlb.ts to enrich pitcher / batter context with
// Statcast-derived metrics:
//   - xERA / est_woba / est_slg     (regression-to-mean signals)
//   - barrel% / hard_hit_pct        (HR + power signals)
//   - max_hit_speed / avg_hit_speed (power signals)
//
// All accessors are TTL-cached per-invocation via the caller's
// shared cache map pattern (matches caches.batterTeam etc).

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

export interface BatterStatcast {
  est_ba: number | null;
  est_slg: number | null;
  est_woba: number | null;
  est_ba_minus_ba_diff: number | null;     // negative = under-performing actual
  est_slg_minus_slg_diff: number | null;
  est_woba_minus_woba_diff: number | null;
  barrels: number | null;
  brl_percent: number | null;               // barrels / batted-ball %
  brl_pa: number | null;                    // barrels / PA %
  ev95percent: number | null;               // hard-hit %
  avg_hit_speed: number | null;
  max_hit_speed: number | null;
  // D-797 — extra-base factors. The cache table has these but the loader was
  // not selecting them, so the scorer never saw the launch-angle / sweet-spot
  // signal that distinguishes 2B/3B from grounders. xwOBA is the research-
  // validated single best TB predictor (D-796 finding).
  avg_hit_angle: number | null;             // avg launch angle, degrees (sweet-spot ~12°)
  anglesweetspotpercent: number | null;     // % of batted balls in 8-32° sweet-spot range
  pa: number | null;
  attempts: number | null;
}

export interface PitcherStatcast {
  est_ba: number | null;                    // BAA allowed (xBA proxy)
  est_slg: number | null;
  est_woba: number | null;
  est_ba_minus_ba_diff: number | null;      // negative = under-performing
  est_woba_minus_woba_diff: number | null;
  era: number | null;
  xera: number | null;
  era_minus_xera_diff: number | null;       // positive = ERA luckier than xERA
  barrels: number | null;                   // barrels allowed
  brl_percent: number | null;
  brl_pa: number | null;
  ev95percent: number | null;               // hard-hit % allowed
  avg_hit_speed: number | null;             // exit velo allowed avg
  pa: number | null;
  attempts: number | null;
}

const supaHeaders = (): Record<string, string> => ({
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
});

async function fetchOne<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { headers: supaHeaders() });
    if (!res.ok) return null;
    const rows = await res.json() as T[];
    return rows.length > 0 ? rows[0] : null;
  } catch (_e) { return null; }
}

// D-284 SHIP 1 — memoization + bulk pre-loaders.
// Pre-D-284: each scoreBatterMarket / scorePitcherStrikeouts call
// fired 2 DB queries; 200 batters × 10 prop iterations × 2 queries
// = 4000 queries, ~200s minimum. Now: bulk-load once + map lookups.
const _batterCache = new Map<number, BatterStatcast | null>();
const _pitcherCache = new Map<number, PitcherStatcast | null>();

export async function bulkLoadBatterStatcast(playerIds: number[]): Promise<number> {
  if (!SUPABASE_URL || !SUPABASE_KEY || playerIds.length === 0) return 0;
  const idList = playerIds.join(",");
  try {
    const [xRes, evRes] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/cache_statcast_batters_xstats?player_id=in.(${idList})&order=snapshot_date.desc&select=player_id,est_ba,est_slg,est_woba,est_ba_minus_ba_diff,est_slg_minus_slg_diff,est_woba_minus_woba_diff,pa`, { headers: supaHeaders() }),
      fetch(`${SUPABASE_URL}/rest/v1/cache_statcast_batters_exit_velo?player_id=in.(${idList})&order=snapshot_date.desc&select=player_id,barrels,brl_percent,brl_pa,ev95percent,avg_hit_speed,max_hit_speed,avg_hit_angle,anglesweetspotpercent,attempts`, { headers: supaHeaders() }),
    ]);
    const xs = xRes.ok ? await xRes.json() as Array<{ player_id: number; est_ba: number | null; est_slg: number | null; est_woba: number | null; est_ba_minus_ba_diff: number | null; est_slg_minus_slg_diff: number | null; est_woba_minus_woba_diff: number | null; pa: number | null }> : [];
    const evs = evRes.ok ? await evRes.json() as Array<{ player_id: number; barrels: number | null; brl_percent: number | null; brl_pa: number | null; ev95percent: number | null; avg_hit_speed: number | null; max_hit_speed: number | null; avg_hit_angle: number | null; anglesweetspotpercent: number | null; attempts: number | null }> : [];
    const xByPid = new Map<number, typeof xs[number]>();
    for (const r of xs) if (!xByPid.has(r.player_id)) xByPid.set(r.player_id, r);
    const evByPid = new Map<number, typeof evs[number]>();
    for (const r of evs) if (!evByPid.has(r.player_id)) evByPid.set(r.player_id, r);
    for (const pid of playerIds) {
      const x = xByPid.get(pid) ?? null;
      const e = evByPid.get(pid) ?? null;
      if (!x && !e) { _batterCache.set(pid, null); continue; }
      _batterCache.set(pid, {
        est_ba: x?.est_ba ?? null, est_slg: x?.est_slg ?? null, est_woba: x?.est_woba ?? null,
        est_ba_minus_ba_diff: x?.est_ba_minus_ba_diff ?? null,
        est_slg_minus_slg_diff: x?.est_slg_minus_slg_diff ?? null,
        est_woba_minus_woba_diff: x?.est_woba_minus_woba_diff ?? null,
        barrels: e?.barrels ?? null, brl_percent: e?.brl_percent ?? null, brl_pa: e?.brl_pa ?? null,
        ev95percent: e?.ev95percent ?? null, avg_hit_speed: e?.avg_hit_speed ?? null,
        max_hit_speed: e?.max_hit_speed ?? null,
        // D-797 — added launch-angle / sweet-spot fields (cache table already
        // has them; query SELECT now includes them).
        avg_hit_angle: e?.avg_hit_angle ?? null,
        anglesweetspotpercent: e?.anglesweetspotpercent ?? null,
        pa: x?.pa ?? null, attempts: e?.attempts ?? null,
      });
    }
    return _batterCache.size;
  } catch { return 0; }
}

export async function bulkLoadPitcherStatcast(playerIds: number[]): Promise<number> {
  if (!SUPABASE_URL || !SUPABASE_KEY || playerIds.length === 0) return 0;
  const idList = playerIds.join(",");
  try {
    const [xRes, evRes] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/cache_statcast_pitchers_xstats?player_id=in.(${idList})&order=snapshot_date.desc&select=player_id,est_ba,est_slg,est_woba,est_ba_minus_ba_diff,est_woba_minus_woba_diff,era,xera,era_minus_xera_diff,pa`, { headers: supaHeaders() }),
      fetch(`${SUPABASE_URL}/rest/v1/cache_statcast_pitchers_exit_velo?player_id=in.(${idList})&order=snapshot_date.desc&select=player_id,barrels,brl_percent,brl_pa,ev95percent,avg_hit_speed,attempts`, { headers: supaHeaders() }),
    ]);
    const xs = xRes.ok ? await xRes.json() as Array<{ player_id: number; est_ba: number | null; est_slg: number | null; est_woba: number | null; est_ba_minus_ba_diff: number | null; est_woba_minus_woba_diff: number | null; era: number | null; xera: number | null; era_minus_xera_diff: number | null; pa: number | null }> : [];
    const evs = evRes.ok ? await evRes.json() as Array<{ player_id: number; barrels: number | null; brl_percent: number | null; brl_pa: number | null; ev95percent: number | null; avg_hit_speed: number | null; attempts: number | null }> : [];
    const xByPid = new Map<number, typeof xs[number]>();
    for (const r of xs) if (!xByPid.has(r.player_id)) xByPid.set(r.player_id, r);
    const evByPid = new Map<number, typeof evs[number]>();
    for (const r of evs) if (!evByPid.has(r.player_id)) evByPid.set(r.player_id, r);
    for (const pid of playerIds) {
      const x = xByPid.get(pid) ?? null;
      const e = evByPid.get(pid) ?? null;
      if (!x && !e) { _pitcherCache.set(pid, null); continue; }
      _pitcherCache.set(pid, {
        est_ba: x?.est_ba ?? null, est_slg: x?.est_slg ?? null, est_woba: x?.est_woba ?? null,
        est_ba_minus_ba_diff: x?.est_ba_minus_ba_diff ?? null,
        est_woba_minus_woba_diff: x?.est_woba_minus_woba_diff ?? null,
        era: x?.era ?? null, xera: x?.xera ?? null,
        era_minus_xera_diff: x?.era_minus_xera_diff ?? null,
        barrels: e?.barrels ?? null, brl_percent: e?.brl_percent ?? null, brl_pa: e?.brl_pa ?? null,
        ev95percent: e?.ev95percent ?? null, avg_hit_speed: e?.avg_hit_speed ?? null,
        pa: x?.pa ?? null, attempts: e?.attempts ?? null,
      });
    }
    return _pitcherCache.size;
  } catch { return 0; }
}

// Get most-recent Statcast snapshot for a batter. Joins xstats +
// exit_velo into a single object. Returns null when player isn't
// in either cache (typical for low-PA players).
// D-284: memoized — first call hits DB; subsequent calls O(1).
export async function getBatterStatcast(playerId: number): Promise<BatterStatcast | null> {
  if (!SUPABASE_URL || !SUPABASE_KEY || !Number.isFinite(playerId)) return null;
  if (_batterCache.has(playerId)) return _batterCache.get(playerId)!;
  const [xstats, ev] = await Promise.all([
    fetchOne<{ est_ba: number | null; est_slg: number | null; est_woba: number | null; est_ba_minus_ba_diff: number | null; est_slg_minus_slg_diff: number | null; est_woba_minus_woba_diff: number | null; pa: number | null }>(
      `${SUPABASE_URL}/rest/v1/cache_statcast_batters_xstats?player_id=eq.${playerId}&order=snapshot_date.desc&limit=1&select=est_ba,est_slg,est_woba,est_ba_minus_ba_diff,est_slg_minus_slg_diff,est_woba_minus_woba_diff,pa`,
    ),
    fetchOne<{ barrels: number | null; brl_percent: number | null; brl_pa: number | null; ev95percent: number | null; avg_hit_speed: number | null; max_hit_speed: number | null; avg_hit_angle: number | null; anglesweetspotpercent: number | null; attempts: number | null }>(
      `${SUPABASE_URL}/rest/v1/cache_statcast_batters_exit_velo?player_id=eq.${playerId}&order=snapshot_date.desc&limit=1&select=barrels,brl_percent,brl_pa,ev95percent,avg_hit_speed,max_hit_speed,avg_hit_angle,anglesweetspotpercent,attempts`,
    ),
  ]);
  if (!xstats && !ev) { _batterCache.set(playerId, null); return null; }
  const v: BatterStatcast = {
    est_ba: xstats?.est_ba ?? null,
    est_slg: xstats?.est_slg ?? null,
    est_woba: xstats?.est_woba ?? null,
    est_ba_minus_ba_diff: xstats?.est_ba_minus_ba_diff ?? null,
    est_slg_minus_slg_diff: xstats?.est_slg_minus_slg_diff ?? null,
    est_woba_minus_woba_diff: xstats?.est_woba_minus_woba_diff ?? null,
    barrels: ev?.barrels ?? null,
    brl_percent: ev?.brl_percent ?? null,
    brl_pa: ev?.brl_pa ?? null,
    ev95percent: ev?.ev95percent ?? null,
    avg_hit_speed: ev?.avg_hit_speed ?? null,
    max_hit_speed: ev?.max_hit_speed ?? null,
    // D-797 — launch-angle / sweet-spot signal for extra-base prediction.
    avg_hit_angle: ev?.avg_hit_angle ?? null,
    anglesweetspotpercent: ev?.anglesweetspotpercent ?? null,
    pa: xstats?.pa ?? null,
    attempts: ev?.attempts ?? null,
  };
  _batterCache.set(playerId, v);
  return v;
}

export async function getPitcherStatcast(playerId: number): Promise<PitcherStatcast | null> {
  if (!SUPABASE_URL || !SUPABASE_KEY || !Number.isFinite(playerId)) return null;
  if (_pitcherCache.has(playerId)) return _pitcherCache.get(playerId)!;
  const [xstats, ev] = await Promise.all([
    fetchOne<{ est_ba: number | null; est_slg: number | null; est_woba: number | null; est_ba_minus_ba_diff: number | null; est_woba_minus_woba_diff: number | null; era: number | null; xera: number | null; era_minus_xera_diff: number | null; pa: number | null }>(
      `${SUPABASE_URL}/rest/v1/cache_statcast_pitchers_xstats?player_id=eq.${playerId}&order=snapshot_date.desc&limit=1&select=est_ba,est_slg,est_woba,est_ba_minus_ba_diff,est_woba_minus_woba_diff,era,xera,era_minus_xera_diff,pa`,
    ),
    fetchOne<{ barrels: number | null; brl_percent: number | null; brl_pa: number | null; ev95percent: number | null; avg_hit_speed: number | null; attempts: number | null }>(
      `${SUPABASE_URL}/rest/v1/cache_statcast_pitchers_exit_velo?player_id=eq.${playerId}&order=snapshot_date.desc&limit=1&select=barrels,brl_percent,brl_pa,ev95percent,avg_hit_speed,attempts`,
    ),
  ]);
  if (!xstats && !ev) { _pitcherCache.set(playerId, null); return null; }
  const v: PitcherStatcast = {
    est_ba: xstats?.est_ba ?? null,
    est_slg: xstats?.est_slg ?? null,
    est_woba: xstats?.est_woba ?? null,
    est_ba_minus_ba_diff: xstats?.est_ba_minus_ba_diff ?? null,
    est_woba_minus_woba_diff: xstats?.est_woba_minus_woba_diff ?? null,
    era: xstats?.era ?? null,
    xera: xstats?.xera ?? null,
    era_minus_xera_diff: xstats?.era_minus_xera_diff ?? null,
    barrels: ev?.barrels ?? null,
    brl_percent: ev?.brl_percent ?? null,
    brl_pa: ev?.brl_pa ?? null,
    ev95percent: ev?.ev95percent ?? null,
    avg_hit_speed: ev?.avg_hit_speed ?? null,
    pa: xstats?.pa ?? null,
    attempts: ev?.attempts ?? null,
  };
  _pitcherCache.set(playerId, v);
  return v;
}

// Bucket-style scoring helpers — return ±X based on percentile band.
// Each helper returns 0 when data is null (graceful degrade).
// Magnitude bands match existing scoring_mlb.ts patterns (±10 max).

// Pitcher xERA edge: lower xERA = better pitcher = K factor boost.
// League avg ~4.20. Buckets: <3.0=elite, 3.0-3.5=strong, 3.5-4.0=above,
// 4.0-4.5=avg, 4.5-5.0=below, >5.0=poor.
export function scorePitcherXeraEdge(xera: number | null): number {
  if (xera === null) return 0;
  if (xera < 3.0)      return 10;
  if (xera < 3.5)      return 6;
  if (xera < 4.0)      return 3;
  if (xera < 4.5)      return 0;
  if (xera < 5.0)      return -3;
  return -8;
}

// Batter barrel-rate: barrels per PA (brl_pa column).
// League avg ~6%. Elite >12%, plus 9-12, avg 6-9, below 3-6, poor <3.
export function scoreBatterBarrelPa(brlPa: number | null): number {
  if (brlPa === null) return 0;
  if (brlPa >= 12) return 8;
  if (brlPa >= 9)  return 5;
  if (brlPa >= 6)  return 2;
  if (brlPa >= 3)  return -2;
  return -5;
}

// Batter xSLG edge over actual SLG: positive diff = under-performing
// actual = regression-to-mean lift expected (slight positive signal).
// Strong positive >0.030, mild 0.015-0.030, none ±0.015, mild negative,
// strong negative >0.030.
export function scoreBatterXslgRegression(diff: number | null): number {
  if (diff === null) return 0;
  if (diff >= 0.030) return -4;   // actual under-performing — UPSIDE
  if (diff >= 0.015) return -2;
  if (diff <= -0.030) return 4;   // actual over-performing — DOWNSIDE
  if (diff <= -0.015) return 2;
  return 0;
}
