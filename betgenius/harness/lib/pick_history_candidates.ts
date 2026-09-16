// Phase 1 backtest harness — pick_history-sourced candidates (runs_scored).

import type { PickSide } from "./metrics.ts";
import type { Db } from "./env.ts";

export interface PickHistoryCandidate {
  pickId: string;
  playerName: string;
  team: string;
  opponent: string;
  gameDate: string;
  gameTime: string | null;
  isHome: boolean | null;
  line: number;
  pickSide: PickSide;
  entryOdds: number;
  eventId: string | null;
  commenceTime: string | null;
  homeTeam: string | null;
  awayTeam: string | null;
  gamePk: number | null;
}

export interface PickHistoryUniverseResult {
  candidates: PickHistoryCandidate[];
  totalRowsFetched: number;
}

interface PickHistoryRow {
  id: string;
  player_name: string;
  team: string | null;
  opponent: string | null;
  game_date: string;
  game_time: string | null;
  is_home: boolean | null;
  line: number;
  pick_side: string;
  odds: number;
}

function parsePickSide(raw: string): PickSide | null {
  const s = raw.trim().toLowerCase();
  if (s === "over" || s === "under") return s;
  return null;
}

function formatGameDate(raw: string): string {
  if (/^\d{8}$/.test(raw)) {
    return `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
  }
  return raw.slice(0, 10);
}

/** Loads production pick_history rows for a market in [startDate, endDate]. */
export async function loadPickHistoryUniverse(
  db: Db,
  mlbMarketType: string,
  startDate: string,
  endDate: string,
): Promise<PickHistoryUniverseResult> {
  const rows = await db.query<PickHistoryRow>(
    `SELECT id, player_name, team, opponent,
            game_date::text AS game_date,
            game_time, is_home, line, pick_side, odds
     FROM pick_history
     WHERE sport = 'mlb'
       AND is_synthetic = false
       AND mlb_market_type = $1
       AND game_date >= $2::date
       AND game_date <= $3::date
       AND odds IS NOT NULL
       AND (voided IS NOT TRUE)`,
    [mlbMarketType, startDate, endDate],
  );

  const candidates: PickHistoryCandidate[] = [];
  for (const r of rows) {
    if (!r.team || !r.opponent) continue;
    const side = parsePickSide(r.pick_side);
    if (!side) continue;
    candidates.push({
      pickId: r.id,
      playerName: r.player_name,
      team: r.team,
      opponent: r.opponent,
      gameDate: formatGameDate(r.game_date),
      gameTime: r.game_time,
      isHome: r.is_home,
      line: Number(r.line),
      pickSide: side,
      entryOdds: r.odds,
      eventId: null,
      commenceTime: null,
      homeTeam: null,
      awayTeam: null,
      gamePk: null,
    });
  }

  return { candidates, totalRowsFetched: rows.length };
}

export interface PickHistoryCoverageWindow {
  minGameDate: string | null;
  maxGameDate: string | null;
  rowCount: number;
}

export async function detectPickHistoryCoverage(
  db: Db,
  mlbMarketType: string,
): Promise<PickHistoryCoverageWindow> {
  const rows = await db.query<{
    min_game_date: string | null;
    max_game_date: string | null;
    count: string;
  }>(
    `SELECT MIN(game_date)::text AS min_game_date,
            MAX(game_date)::text AS max_game_date,
            COUNT(*)::text AS count
     FROM pick_history
     WHERE sport = 'mlb'
       AND is_synthetic = false
       AND mlb_market_type = $1
       AND odds IS NOT NULL
       AND (voided IS NOT TRUE)`,
    [mlbMarketType],
  );
  const row = rows[0];
  return {
    minGameDate: row?.min_game_date ?? null,
    maxGameDate: row?.max_game_date ?? null,
    rowCount: parseInt(row?.count ?? "0", 10),
  };
}
