// Phase 1 backtest harness — point-in-time Statcast reconstruction.
//
// The router (historical_context_router_batter.ts) hardcodes `statcast:
// null` — a deliberate D-359 SHIP-2 scope decision, not a technical
// limitation: the two D-274 snapshot tables it would need already had 8
// days of daily history by the time the router shipped. D-801
// (d801-backfill-tb-extra-base/index.ts) and D-825 (d825-backfill-hits)
// later proved the AS-OF pattern works — as standalone backfill scripts,
// not router edits. This module ports that exact pattern into the harness:
// bulk-preload every snapshot row for the candidate player cohort, then
// for each pick pull the latest snapshot STRICTLY BEFORE game_date.
//
// LEAKAGE PROOF (identical to D-801 lines 10-19): a snapshot taken on
// snapshot_date X reflects all batted balls THROUGH end-of-day X. For a
// pick whose outcome is decided by game_date Y:
//   - snapshot_date = Y-1 -> stats through Y-1 (player hasn't played Y yet) -> SAFE
//   - snapshot_date = Y   -> stats already include Y's game               -> LEAKAGE
// The strict `<` filter below is what keeps this safe — never relax it to `<=`.

import { chunk, type Db } from "./env.ts";
import type { BatterStatcastContext } from "../../supabase/functions/_shared/scoring_mlb_v2.ts";

interface XstatsRow {
  player_id: number;
  snapshot_date: string;
  est_ba: number | null;
  est_slg: number | null;
  est_slg_minus_slg_diff: number | null;
  est_woba: number | null;
  est_woba_minus_woba_diff: number | null;
}

interface ExitVeloRow {
  player_id: number;
  snapshot_date: string;
  ev95percent: number | null;
  avg_hit_speed: number | null;
  avg_hit_angle: number | null;
  anglesweetspotpercent: number | null;
  brl_pa: number | null;
  brl_percent: number | null;
}

export interface StatcastAsOfIndex {
  xByPlayer: Map<number, XstatsRow[]>;
  eByPlayer: Map<number, ExitVeloRow[]>;
}

/** Bulk-preloads every snapshot row (all dates) for the given player cohort
 *  from both D-274 tables, sorted per-player by snapshot_date descending —
 *  same shape D-801 builds in-memory before looping over picks. One-time
 *  cost per harness run, not per candidate. */
export async function buildStatcastAsOfIndex(db: Db, playerIds: number[]): Promise<StatcastAsOfIndex> {
  const xByPlayer = new Map<number, XstatsRow[]>();
  const eByPlayer = new Map<number, ExitVeloRow[]>();
  const distinctIds = Array.from(new Set(playerIds));
  if (distinctIds.length === 0) return { xByPlayer, eByPlayer };

  for (const idBatch of chunk(distinctIds, 200)) {
    // Single-connection client cannot pipeline two queries (Busy: TCP stream).
    const ids = idBatch.map((id) => Number(id));
    const xRows = await db.query<XstatsRow>(
      `SELECT player_id, snapshot_date, est_ba, est_slg, est_slg_minus_slg_diff,
              est_woba, est_woba_minus_woba_diff
       FROM cache_statcast_batters_xstats
       WHERE player_id = ANY($1::int[])`,
      [ids],
    );
    const eRows = await db.query<ExitVeloRow>(
      `SELECT player_id, snapshot_date, ev95percent, avg_hit_speed, avg_hit_angle,
              anglesweetspotpercent, brl_pa, brl_percent
       FROM cache_statcast_batters_exit_velo
       WHERE player_id = ANY($1::int[])`,
      [ids],
    );
    for (const r of xRows) {
      const pid = Number(r.player_id);
      r.player_id = pid;
      if (!xByPlayer.has(pid)) xByPlayer.set(pid, []);
      xByPlayer.get(pid)!.push(r);
    }
    for (const r of eRows) {
      const pid = Number(r.player_id);
      r.player_id = pid;
      if (!eByPlayer.has(pid)) eByPlayer.set(pid, []);
      eByPlayer.get(pid)!.push(r);
    }
  }
  for (const arr of xByPlayer.values()) arr.sort((a, b) => b.snapshot_date.localeCompare(a.snapshot_date));
  for (const arr of eByPlayer.values()) arr.sort((a, b) => b.snapshot_date.localeCompare(a.snapshot_date));

  return { xByPlayer, eByPlayer };
}

/** Latest-snapshot-strictly-before-game_date lookup, merged into the full
 *  11-field BatterStatcastContext shape — mirrors D-801 lines 247-269
 *  exactly. Returns null only when NEITHER table has a qualifying snapshot
 *  (e.g. early-season picks before 2026-05-20, or a callup with no prior
 *  snapshot) — same graceful degradation as the router's own null case:
 *  every gated factor in scoreBatterRunsScored scores 0 rather than firing
 *  on a leaked or fabricated value. */
export function lookupStatcastAsOf(
  index: StatcastAsOfIndex,
  playerId: number,
  gameDateIso: string,
): BatterStatcastContext | null {
  const pid = Number(playerId);
  const xList = index.xByPlayer.get(pid) ?? [];
  const eList = index.eByPlayer.get(pid) ?? [];
  const xRow = xList.find((r) => r.snapshot_date < gameDateIso) ?? null;
  const eRow = eList.find((r) => r.snapshot_date < gameDateIso) ?? null;
  if (!xRow && !eRow) return null;

  return {
    est_ba: xRow?.est_ba ?? null,
    est_slg: xRow?.est_slg ?? null,
    est_slg_minus_slg_diff: xRow?.est_slg_minus_slg_diff ?? null,
    brl_pa: eRow?.brl_pa ?? null,
    brl_percent: eRow?.brl_percent ?? null,
    avg_hit_speed: eRow?.avg_hit_speed ?? null,
    est_woba: xRow?.est_woba ?? null,
    est_woba_minus_woba_diff: xRow?.est_woba_minus_woba_diff ?? null,
    ev95percent: eRow?.ev95percent ?? null,
    avg_hit_angle: eRow?.avg_hit_angle ?? null,
    anglesweetspotpercent: eRow?.anglesweetspotpercent ?? null,
  };
}
