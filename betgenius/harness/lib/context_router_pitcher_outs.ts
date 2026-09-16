// Phase 1 backtest harness — pitcher_outs historical context router (Postgres).
//
// Port of supabase/functions/_shared/historical_context_router_pitcher_outs.ts.

import type {
  BallparkFactor,
  GameWeather,
  PitcherGameLogEntry,
  PitcherKScoringContext,
  PitcherSeasonStats,
  TeamHittingStats,
  UmpireStats,
} from "../../supabase/functions/_shared/scoring_mlb_v2.ts";
import { type Db } from "./env.ts";

export interface PitcherOutsContextBundle {
  ctx: Omit<PitcherKScoringContext, "prop">;
  completeness: number;
  missing: string[];
}

interface BoxscoreRow {
  player_id: number;
  game_pk: number;
  game_date: string;
  team_id: number;
  position_type: string | null;
  is_starter: boolean | null;
  plate_appearances: number | null;
  innings_pitched: number | null;
  pitches_thrown: number | null;
  strikeouts: number | null;
  walks: number | null;
  batters_faced: number | null;
  pitcher_earned_runs: number | null;
  runs_scored: number | null;
  hits: number | null;
  outs: number | null;
  batter_strikeouts: number | null;
  batter_walks: number | null;
  batter_hbp: number | null;
}

interface EventRow {
  event_id: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  game_pk: number | null;
}

const LEAGUE_AVG_PITCHES_PER_START = 88;

function isoDateMinusDays(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

export async function buildPitcherOutsHistoricalContext(
  db: Db,
  ev: EventRow,
  playerId: number,
  pitcherTeamId: number,
  oppTeamId: number,
  pitcherName: string,
  isHome: boolean,
  gameDate: string,
): Promise<PitcherOutsContextBundle | null> {
  const missing: string[] = [];
  const oneFieldCount = { reconstructed: 0, total: 0 };
  const T = () => oneFieldCount.total++;
  const R = () => oneFieldCount.reconstructed++;

  const pitcherRows = await db.query<BoxscoreRow>(
    `SELECT player_id, game_pk, game_date, team_id, position_type, is_starter,
            plate_appearances, innings_pitched, pitches_thrown, strikeouts, walks,
            batters_faced, pitcher_earned_runs, runs_scored, hits, outs,
            batter_strikeouts, batter_walks, batter_hbp
     FROM cache_mlb_boxscore_player_stats
     WHERE player_id = $1 AND game_date < $2::date
     ORDER BY game_date DESC LIMIT 200`,
    [playerId, gameDate],
  );

  T();
  const starterRows = pitcherRows.filter((r) => r.is_starter === true && (r.outs ?? 0) > 0);
  const starterOuts = starterRows.reduce((s, r) => s + (r.outs ?? 0), 0);
  const starterIp = starterOuts / 3;
  const starterK = starterRows.reduce((s, r) => s + (r.strikeouts ?? 0), 0);
  const starterBb = starterRows.reduce((s, r) => s + (r.walks ?? 0), 0);
  const starterBf = starterRows.reduce((s, r) => s + (r.batters_faced ?? 0), 0);
  const starterEr = starterRows.reduce((s, r) => s + (r.pitcher_earned_runs ?? 0), 0);
  const starterPitches = starterRows.reduce((s, r) => s + (r.pitches_thrown ?? 0), 0);

  const season: PitcherSeasonStats = {
    gamesPlayed: starterRows.length,
    inningsPitched: Math.round(starterIp * 10) / 10,
    strikeOuts: starterK,
    battersFaced: starterBf,
    kPerNine: starterIp > 0 ? Math.round((starterK * 9 / starterIp) * 100) / 100 : 0,
    era: starterIp > 0 ? Math.round((starterEr * 9 / starterIp) * 100) / 100 : 0,
    pitchesPerStart: starterRows.length > 0 ? Math.round(starterPitches / starterRows.length) : null,
    throws: null,
    baseOnBalls: starterBb,
  };
  if (season.gamesPlayed >= 1) R();
  if (season.throws == null) missing.push("season.throws");

  T();
  const gameLog: PitcherGameLogEntry[] = starterRows.slice(0, 5).map((r) => ({
    date: r.game_date,
    strikeOuts: r.strikeouts ?? 0,
    inningsPitched: Math.round(((r.outs ?? 0) / 3) * 10) / 10,
    opponent: "",
    pitchCount: r.pitches_thrown,
    walks: r.walks,
  }));
  if (gameLog.length >= 1) R();

  T();
  const oppBatterRows = await db.query<BoxscoreRow>(
    `SELECT player_id, game_pk, plate_appearances, batter_strikeouts, runs_scored, hits,
            batter_walks, batter_hbp, pitches_thrown, position_type
     FROM cache_mlb_boxscore_player_stats
     WHERE team_id = $1 AND game_date < $2::date LIMIT 2000`,
    [oppTeamId, gameDate],
  );
  const oppPa = oppBatterRows.reduce((s, r) => s + (r.plate_appearances ?? 0), 0);
  const oppK = oppBatterRows.reduce((s, r) => s + (r.batter_strikeouts ?? 0), 0);
  const oppGames = new Set(oppBatterRows.map((r) => r.game_pk)).size;
  const oppRuns = oppBatterRows.reduce((s, r) => s + (r.runs_scored ?? 0), 0);
  const oppBb = oppBatterRows.reduce((s, r) => s + (r.batter_walks ?? 0), 0);
  const oppHbp = oppBatterRows.reduce((s, r) => s + (r.batter_hbp ?? 0), 0);
  const oppHits = oppBatterRows.reduce((s, r) => s + (r.hits ?? 0), 0);

  let opposingHitting: TeamHittingStats | null = null;
  if (oppGames >= 1 && oppPa > 0) {
    const obpRaw = (oppHits + oppBb + oppHbp) / oppPa;
    opposingHitting = {
      gamesPlayed: oppGames,
      strikeOuts: oppK,
      plateAppearances: oppPa,
      kRate: Math.round((oppK / oppPa) * 1000) / 1000,
      kRateVsLHP: null,
      kRateVsRHP: null,
      bbRate: Math.round((oppBb / oppPa) * 1000) / 1000,
      obpSeason: Math.round(obpRaw * 1000) / 1000,
      pitchesPerPA: null,
      ozSwingAvg: null,
    };
    R();
    missing.push("opp.pitchesPerPA", "opp.ozSwingAvg", "opp.kRateVsLHP", "opp.kRateVsRHP");
  } else {
    missing.push("opp.kRate");
  }

  T();
  const twoDaysAgo = isoDateMinusDays(gameDate, 2);
  const ownPenRows = await db.query<{ outs: number | null }>(
    `SELECT outs FROM cache_mlb_boxscore_player_stats
     WHERE team_id = $1 AND is_starter = false AND position_type = 'Pitcher'
       AND game_date >= $2::date AND game_date < $3::date LIMIT 200`,
    [pitcherTeamId, twoDaysAgo, gameDate],
  );
  const ownPenOuts = ownPenRows.reduce((s, r) => s + (r.outs ?? 0), 0);
  const ownTeamPenIp48h = ownPenRows.length > 0 ? Math.round((ownPenOuts / 3) * 10) / 10 : null;
  if (ownTeamPenIp48h !== null) R(); else missing.push("ownTeamPenIp48h");

  T();
  const ownTeamRows = await db.query<{ game_pk: number; runs_scored: number | null }>(
    `SELECT game_pk, runs_scored FROM cache_mlb_boxscore_player_stats
     WHERE team_id = $1 AND game_date < $2::date LIMIT 2000`,
    [pitcherTeamId, gameDate],
  );
  const ownGames = new Set(ownTeamRows.map((r) => r.game_pk)).size;
  const ownRuns = ownTeamRows.reduce((s, r) => s + (r.runs_scored ?? 0), 0);
  const ownTeamRunsPerGame = ownGames > 0 ? Math.round((ownRuns / ownGames) * 100) / 100 : null;
  if (ownTeamRunsPerGame !== null) R(); else missing.push("ownTeamRunsPerGame");

  T();
  const oppRunsPerGame = oppGames > 0 ? Math.round((oppRuns / oppGames) * 100) / 100 : null;
  if (oppRunsPerGame !== null) R(); else missing.push("oppRunsPerGame");

  T();
  const ownStarterRows = await db.query<{ game_pk: number; pitches_thrown: number | null }>(
    `SELECT game_pk, pitches_thrown FROM cache_mlb_boxscore_player_stats
     WHERE team_id = $1 AND is_starter = true AND position_type = 'Pitcher'
       AND game_date < $2::date LIMIT 2000`,
    [pitcherTeamId, gameDate],
  );
  const ownStarterGames = new Set(ownStarterRows.map((r) => r.game_pk)).size;
  const ownStarterPitches = ownStarterRows.reduce((s, r) => s + (r.pitches_thrown ?? 0), 0);
  let ownTeamHookIndex: number | null = null;
  if (ownStarterGames >= 5 && ownStarterPitches > 0) {
    const avgPps = ownStarterPitches / ownStarterGames;
    ownTeamHookIndex = Math.round((avgPps - LEAGUE_AVG_PITCHES_PER_START) * 100) / 100;
    R();
  } else {
    missing.push("ownTeamHookIndex");
  }

  T(); missing.push("inn1Era");
  T(); missing.push("inn1Ip");
  T(); missing.push("inn1Walks");
  T(); missing.push("thirdTimeOps");
  T(); missing.push("thirdTimeIp");

  const ballpark: BallparkFactor | null = null;
  const weather: GameWeather | null = null;
  const umpire: UmpireStats | null = null;

  const ctx: Omit<PitcherKScoringContext, "prop"> = {
    pitcher: {
      fullName: pitcherName,
      team: isHome ? ev.home_team : ev.away_team,
      opponentTeam: isHome ? ev.away_team : ev.home_team,
      isHome,
      gameTime: ev.commence_time,
    },
    season,
    gameLog,
    opposingHitting,
    ballpark,
    weather,
    umpire,
    statcast: null,
    catcherFraming: null,
    arsenal: null,
    velocity: null,
    lineupKComposition: null,
    pitchTypeMatchup: null,
    ownTeamPenIp48h,
    ownTeamRunsPerGame,
    oppRunsPerGame,
    inn1Era: null,
    inn1Ip: null,
    inn1Walks: null,
    thirdTimeOps: null,
    thirdTimeIp: null,
    ownTeamHookIndex,
  };

  const completeness = oneFieldCount.total > 0
    ? Math.round((oneFieldCount.reconstructed / oneFieldCount.total) * 100) / 100
    : 0;

  if (gameLog.length === 0 && season.gamesPlayed === 0) return null;
  return { ctx, completeness, missing };
}

export async function resolvePitcherTeamIds(
  db: Db,
  playerId: number,
  gamePk: number,
): Promise<{ pitcherTeamId: number; oppTeamId: number } | null> {
  const rows = await db.query<{ team_id: number | null }>(
    `SELECT DISTINCT team_id FROM cache_mlb_boxscore_player_stats
     WHERE game_pk = $1 AND team_id IS NOT NULL`,
    [gamePk],
  );
  const pitcherRow = await db.query<{ team_id: number | null }>(
    `SELECT team_id FROM cache_mlb_boxscore_player_stats
     WHERE player_id = $1 AND game_pk = $2 AND position_type = 'Pitcher' LIMIT 1`,
    [playerId, gamePk],
  );
  const pitcherTeamId = pitcherRow[0]?.team_id;
  if (pitcherTeamId == null) return null;
  const oppTeamId = rows.map((r) => r.team_id).find((t) => t !== null && t !== pitcherTeamId);
  if (oppTeamId == null) return null;
  return { pitcherTeamId, oppTeamId };
}
