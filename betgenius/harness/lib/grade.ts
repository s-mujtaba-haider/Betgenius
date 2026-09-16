// Phase 1 backtest harness — grading against real outcomes.
//
// Ground truth comes from cache_mlb_boxscore_player_stats (per-market column).
// Push/win/loss rule mirrors resolve-picks/index.ts.

import { chunk, type Db } from "./env.ts";
import type { GradeColumn } from "./market_config.ts";

export type PickSide = "over" | "under";

const BATTER_GRADE_COLUMNS = new Set<GradeColumn>([
  "hits",
  "total_bases",
  "home_runs",
  "rbi",
  "runs_scored",
]);

/** Bulk-loads boxscore stat for (player_id, game_pk) pairs. */
export async function fetchPlayerOutcomes(
  db: Db,
  pairs: Array<{ playerId: number; gamePk: number }>,
  gradeColumn: GradeColumn,
): Promise<Map<string, number | null>> {
  const out = new Map<string, number | null>();
  if (pairs.length === 0) return out;

  if (gradeColumn === "game_outcome") {
    throw new Error("[harness] game_outcome is graded via grade_game.ts, not boxscore player stats");
  }
  const playerIds = Array.from(new Set(pairs.map((p) => p.playerId)));
  const gamePks = Array.from(new Set(pairs.map((p) => p.gamePk)));
  const pairSet = new Set(pairs.map((p) => `${p.playerId}|${p.gamePk}`));

  for (const playerBatch of chunk(playerIds, 200)) {
    for (const gameBatch of chunk(gamePks, 200)) {
      let rows: Array<{ player_id: number; game_pk: number; stat: number | null }>;
      if (gradeColumn === "pitcher_strikeouts") {
        rows = await db.query(
          `SELECT player_id, game_pk, strikeouts AS stat
           FROM cache_mlb_boxscore_player_stats
           WHERE player_id = ANY($1::int[]) AND game_pk = ANY($2::int[])
             AND position_type = 'Pitcher'`,
          [playerBatch, gameBatch],
        );
      } else if (gradeColumn === "pitcher_outs") {
        rows = await db.query(
          `SELECT player_id, game_pk,
                  COALESCE(outs, ROUND(innings_pitched * 3)::int) AS stat
           FROM cache_mlb_boxscore_player_stats
           WHERE player_id = ANY($1::int[]) AND game_pk = ANY($2::int[])
             AND position_type = 'Pitcher'`,
          [playerBatch, gameBatch],
        );
      } else {
        const col = gradeColumn;
        rows = await db.query(
          `SELECT player_id, game_pk, ${col} AS stat FROM cache_mlb_boxscore_player_stats
           WHERE player_id = ANY($1::int[]) AND game_pk = ANY($2::int[])`,
          [playerBatch, gameBatch],
        );
      }
      for (const r of rows) {
        const key = `${r.player_id}|${r.game_pk}`;
        if (pairSet.has(key)) out.set(key, r.stat);
      }
    }
  }
  return out;
}

/** @deprecated Use fetchPlayerOutcomes. */
export async function fetchBatterOutcomes(
  db: Db,
  pairs: Array<{ playerId: number; gamePk: number }>,
  gradeColumn: GradeColumn,
): Promise<Map<string, number | null>> {
  if (!BATTER_GRADE_COLUMNS.has(gradeColumn)) {
    return fetchPlayerOutcomes(db, pairs, gradeColumn);
  }
  return fetchPlayerOutcomes(db, pairs, gradeColumn);
}

/** @deprecated Use fetchBatterOutcomes with gradeColumn='runs_scored'. */
export async function fetchRunsOutcomes(
  db: Db,
  pairs: Array<{ playerId: number; gamePk: number }>,
): Promise<Map<string, number | null>> {
  return fetchBatterOutcomes(db, pairs, "runs_scored");
}

export interface GradeResult {
  hit: boolean | null;
  voided: boolean;
  voidReason?: string;
}

export function gradePick(
  actualStat: number | null,
  line: number,
  pickSide: PickSide,
): GradeResult {
  if (actualStat === null) {
    return { hit: null, voided: true, voidReason: "dnp_or_no_boxscore_row" };
  }
  if (Math.abs(actualStat - line) < 0.0001) {
    return { hit: null, voided: false };
  }
  const hit = pickSide === "over" ? actualStat > line : actualStat < line;
  return { hit, voided: false };
}
