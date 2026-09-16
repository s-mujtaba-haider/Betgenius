// Phase 1 — grade game-market picks from cache_mlb_historical_outcomes.
// Mirrors replay-historical-mlb resolveGameOutcome (home/away/over/under + push).

import { chunk, type Db } from "./env.ts";
import type { GameKind } from "./game_candidates.ts";

export interface GameOutcome {
  homeScore: number | null;
  awayScore: number | null;
  gameCompleted: boolean;
}

export interface GameGradeResult {
  hit: boolean | null;
  voided: boolean;
  voidReason?: string;
  actualStat: number | null;
}

/** Copy of replay-historical-mlb resolveGameOutcome. */
export function gradeGameOutcome(
  kind: GameKind,
  pickSide: "home" | "away" | "over" | "under",
  line: number,
  homeScore: number | null,
  awayScore: number | null,
): GameGradeResult {
  if (homeScore === null || awayScore === null) {
    return {
      hit: null,
      voided: true,
      voidReason: "no_final_score",
      actualStat: null,
    };
  }
  // Postgres `numeric` arrives as a string in Deno postgres. Home uses `line`
  // as-is; away uses `-line` which already coerces. Un-coerced home -1.5
  // becomes `6 + "-1.5"` → `"6-1.5"` → hit false (warehouse WR ~1%).
  const lineNum = Number(line);
  if (!Number.isFinite(lineNum)) {
    return {
      hit: null,
      voided: true,
      voidReason: "invalid_line",
      actualStat: null,
    };
  }
  if (kind === "totals") {
    const total = homeScore + awayScore;
    if (Math.abs(total - lineNum) < 1e-9) {
      return { hit: null, voided: false, actualStat: total };
    }
    if (pickSide === "over") {
      return { hit: total > lineNum, voided: false, actualStat: total };
    }
    return { hit: total < lineNum, voided: false, actualStat: total };
  }
  const pickHome = pickSide === "home" || pickSide === "over";
  const margin = pickHome ? homeScore - awayScore : awayScore - homeScore;
  const lineForPick = pickHome ? lineNum : -lineNum;
  const adj = margin + lineForPick;
  if (Math.abs(adj) < 1e-9) {
    return { hit: null, voided: false, actualStat: margin };
  }
  return { hit: adj > 0, voided: false, actualStat: margin };
}

export async function fetchGameOutcomes(
  db: Db,
  eventIds: string[],
): Promise<Map<string, GameOutcome>> {
  const out = new Map<string, GameOutcome>();
  for (const batch of chunk(Array.from(new Set(eventIds)), 200)) {
    const rows = await db.query<{
      event_id: string;
      home_score: number | null;
      away_score: number | null;
      game_completed: boolean | null;
    }>(
      `SELECT event_id, home_score, away_score, game_completed
       FROM cache_mlb_historical_outcomes
       WHERE event_id = ANY($1::text[])`,
      [batch],
    );
    for (const r of rows) {
      out.set(r.event_id, {
        homeScore: r.home_score,
        awayScore: r.away_score,
        gameCompleted: r.game_completed === true,
      });
    }
  }
  return out;
}
