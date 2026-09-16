// Phase 1 backtest harness — PitcherKScoringContext historical router (Postgres).
//
// Port of supabase/functions/_shared/historical_context_router_pitcher.ts for
// direct read-only Postgres access.

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

async function tryQuery<T>(db: Db, sql: string, params: unknown[] = []): Promise<T[]> {
  try {
    return await db.query<T>(sql, params);
  } catch {
    return [];
  }
}

export interface PitcherHistoricalContextBundle {
  ctx: Omit<PitcherKScoringContext, "prop">;
  completeness: number;
  missing: string[];
}

interface BoxscoreRow {
  player_id: number;
  game_pk: number;
  game_date: string;
  position_type: string | null;
  is_starter: boolean;
  innings_pitched: number | null;
  pitches_thrown: number | null;
  strikeouts: number | null;
  walks: number | null;
  pitcher_earned_runs: number | null;
  batters_faced: number | null;
  pitcher_runs: number | null;
}

interface EventRow {
  event_id: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  game_pk: number | null;
}

interface OppPitcherRow {
  event_id: string;
  home_starter_id: number | null;
  away_starter_id: number | null;
}

interface WeatherRow {
  event_id: string;
  temperature_f: number | null;
  wind_speed_mph: number | null;
  wind_direction_degrees: number | null;
  is_dome: boolean | null;
}

interface PlayerMetaRow {
  player_id: number;
  full_name: string | null;
  throws: string | null;
}

interface BallparkRow {
  park_name: string;
  hits_factor: number | null;
  hr_factor: number | null;
  k_factor: number | null;
  runs_factor: number | null;
}

interface ArsenalRow {
  player_id: number;
  breaking_ball_pct: number | null;
  offspeed_pct: number | null;
  total_pitches: number | null;
  ff_avg_speed: number | null;
  si_avg_speed: number | null;
  csw_pct: number | null;
  total_pitches_csw: number | null;
}

interface PitcherStatcastRow {
  player_id: number;
  xera: number | null;
  era_minus_xera_diff: number | null;
  est_ba: number | null;
}

export interface PitcherRouterCaches {
  events?: Map<string, EventRow>;
  oppPitcher?: Map<string, OppPitcherRow>;
  weather?: Map<string, WeatherRow>;
  ballpark?: Map<string, BallparkRow>;
  playerMeta?: Map<number, PlayerMetaRow>;
  arsenal?: Map<number, ArsenalRow>;
  statcast?: Map<number, PitcherStatcastRow>;
}

const LEAGUE_AVG_K9 = 8.5;
const LEAGUE_AVG_ERA = 4.20;

const TEAM_TO_PARK: Record<string, string> = {
  "Arizona Diamondbacks": "Chase Field",
  "Atlanta Braves": "Truist Park",
  "Baltimore Orioles": "Camden Yards",
  "Boston Red Sox": "Fenway Park",
  "Chicago Cubs": "Wrigley Field",
  "Chicago White Sox": "Guaranteed Rate Field",
  "Cincinnati Reds": "Great American Ball Park",
  "Cleveland Guardians": "Progressive Field",
  "Colorado Rockies": "Coors Field",
  "Detroit Tigers": "Comerica Park",
  "Houston Astros": "Minute Maid Park",
  "Kansas City Royals": "Kauffman Stadium",
  "Los Angeles Angels": "Angel Stadium",
  "Los Angeles Dodgers": "Dodger Stadium",
  "Miami Marlins": "loanDepot park",
  "Milwaukee Brewers": "American Family Field",
  "Minnesota Twins": "Target Field",
  "New York Mets": "Citi Field",
  "New York Yankees": "Yankee Stadium",
  "Athletics": "Oakland Coliseum",
  "Oakland Athletics": "Oakland Coliseum",
  "Philadelphia Phillies": "Citizens Bank Park",
  "Pittsburgh Pirates": "PNC Park",
  "San Diego Padres": "Petco Park",
  "San Francisco Giants": "Oracle Park",
  "Seattle Mariners": "T-Mobile Park",
  "St. Louis Cardinals": "Busch Stadium",
  "Tampa Bay Rays": "Tropicana Field",
  "Texas Rangers": "Globe Life Field",
  "Toronto Blue Jays": "Rogers Centre",
  "Washington Nationals": "Nationals Park",
};

function degToCompass(deg: number | null | undefined): string | null {
  if (deg === null || deg === undefined) return null;
  const dirs = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
  return dirs[Math.round(((deg % 360) / 22.5)) % 16];
}

function aggregatePitcherSeason(rows: BoxscoreRow[]) {
  let gp = 0, ip = 0, k = 0, bf = 0, er = 0, pTotal = 0, pCount = 0, bb = 0;
  for (const r of rows) {
    if (!r.is_starter) continue;
    if ((r.innings_pitched ?? 0) <= 0) continue;
    gp++;
    ip += Number(r.innings_pitched ?? 0);
    k += r.strikeouts ?? 0;
    bf += r.batters_faced ?? 0;
    er += r.pitcher_earned_runs ?? 0;
    bb += r.walks ?? 0;
    if (r.pitches_thrown !== null && r.pitches_thrown !== undefined) {
      pTotal += r.pitches_thrown;
      pCount++;
    }
  }
  const kPerNine = ip > 0 ? (k * 9) / ip : LEAGUE_AVG_K9;
  const era = ip > 0 ? (er * 9) / ip : LEAGUE_AVG_ERA;
  const pitchesPerStart = pCount > 0 ? pTotal / pCount : null;
  return { gamesPlayed: gp, inningsPitched: ip, strikeOuts: k, battersFaced: bf, kPerNine, era, pitchesPerStart, baseOnBalls: bb };
}

export async function buildPitcherHistoricalContext(
  db: Db,
  eventId: string,
  playerId: number,
  caches: PitcherRouterCaches = {},
): Promise<PitcherHistoricalContextBundle> {
  const missing: string[] = [];
  let expectedFactors = 0;
  let presentFactors = 0;

  expectedFactors += 1;
  let event: EventRow | undefined = caches.events?.get(eventId);
  if (!event) {
    const rows = await db.query<EventRow>(
      `SELECT event_id, commence_time, home_team, away_team, game_pk
       FROM cache_mlb_historical_events WHERE event_id = $1 LIMIT 1`,
      [eventId],
    );
    if (rows.length > 0) {
      event = rows[0];
      caches.events?.set(eventId, event);
    }
  }
  if (!event) throw new Error(`historical_router_pitcher: event_id=${eventId} not found`);
  presentFactors += 1;
  const gameDate = event.commence_time.slice(0, 10);

  let oppPitcher: OppPitcherRow | undefined = caches.oppPitcher?.get(eventId);
  if (!oppPitcher) {
    const rows = await db.query<OppPitcherRow>(
      `SELECT event_id, home_starter_id, away_starter_id
       FROM cache_mlb_historical_opposing_pitcher WHERE event_id = $1 LIMIT 1`,
      [eventId],
    );
    if (rows.length > 0) {
      oppPitcher = rows[0];
      caches.oppPitcher?.set(eventId, oppPitcher);
    }
  }
  const isHome = oppPitcher?.home_starter_id === playerId;
  const pitcherTeam = isHome ? event.home_team : event.away_team;
  const opponentTeam = isHome ? event.away_team : event.home_team;

  let meta: PlayerMetaRow | undefined = caches.playerMeta?.get(playerId);
  if (!meta) {
    const rows = await db.query<PlayerMetaRow>(
      `SELECT player_id, full_name, throws FROM cache_mlb_player_metadata
       WHERE player_id = $1 LIMIT 1`,
      [playerId],
    );
    if (rows.length > 0) {
      meta = rows[0];
      caches.playerMeta?.set(playerId, meta);
    }
  }
  const fullName = meta?.full_name ?? "Unknown";
  const throws: "L" | "R" | null = meta?.throws === "L" || meta?.throws === "R" ? meta.throws : null;

  expectedFactors += 2;
  const gameLogRows = await db.query<BoxscoreRow>(
    `SELECT player_id, game_pk, game_date, position_type, is_starter, innings_pitched,
            pitches_thrown, strikeouts, walks, pitcher_earned_runs, batters_faced, pitcher_runs
     FROM cache_mlb_boxscore_player_stats
     WHERE player_id = $1 AND game_date < $2::date
     ORDER BY game_date DESC LIMIT 100`,
    [playerId, gameDate],
  );
  const recentPitches = gameLogRows.filter((r) => (r.innings_pitched ?? 0) > 0);
  const gameLog: PitcherGameLogEntry[] = recentPitches
    .slice(0, 5)
    .reverse()
    .map((r) => ({
      date: r.game_date,
      strikeOuts: r.strikeouts ?? 0,
      inningsPitched: Number(r.innings_pitched ?? 0),
      opponent: "",
      pitchCount: r.pitches_thrown ?? null,
      walks: r.walks ?? null,
    }));
  if (gameLog.length > 0) presentFactors += 1; else missing.push("gameLog");

  const seasonYear = Number(gameDate.slice(0, 4));
  const cacheRows = await tryQuery<{
    games_played: number | null;
    innings_pitched: number | string | null;
    strike_outs: number | null;
    batters_faced: number | null;
    k_per_nine: number | null;
    era: number | null;
    pitches_per_start: number | null;
    base_on_balls: number | null;
    throws: string | null;
  }>(
    `SELECT games_played, innings_pitched, strike_outs, batters_faced, k_per_nine, era,
            pitches_per_start, base_on_balls, throws
     FROM cache_mlb_pitcher_season_stats
     WHERE player_id = $1 AND season = $2 LIMIT 1`,
    [playerId, seasonYear],
  );
  const cacheRow = cacheRows[0];
  let seasonStats: PitcherSeasonStats;
  if (cacheRow && (cacheRow.games_played ?? 0) > 0) {
    const cacheThrows: "L" | "R" | null = cacheRow.throws === "L" || cacheRow.throws === "R"
      ? cacheRow.throws
      : null;
    seasonStats = {
      gamesPlayed: cacheRow.games_played ?? 0,
      inningsPitched: Number(cacheRow.innings_pitched ?? 0),
      strikeOuts: cacheRow.strike_outs ?? 0,
      battersFaced: cacheRow.batters_faced ?? 0,
      kPerNine: Number(cacheRow.k_per_nine ?? 0),
      era: Number(cacheRow.era ?? 0),
      pitchesPerStart: cacheRow.pitches_per_start !== null ? Number(cacheRow.pitches_per_start) : null,
      throws: cacheThrows ?? throws,
      baseOnBalls: cacheRow.base_on_balls ?? 0,
    };
    presentFactors += 1;
  } else {
    const seasonAgg = aggregatePitcherSeason(gameLogRows);
    seasonStats = {
      gamesPlayed: seasonAgg.gamesPlayed,
      inningsPitched: seasonAgg.inningsPitched,
      strikeOuts: seasonAgg.strikeOuts,
      battersFaced: seasonAgg.battersFaced,
      kPerNine: seasonAgg.kPerNine,
      era: seasonAgg.era,
      pitchesPerStart: seasonAgg.pitchesPerStart,
      throws,
      baseOnBalls: seasonAgg.baseOnBalls,
    };
    if (seasonAgg.gamesPlayed > 0) presentFactors += 1; else missing.push("season");
  }

  expectedFactors += 1;
  if (!caches.ballpark || caches.ballpark.size === 0) {
    const rows = await db.query<BallparkRow>(
      `SELECT park_name, hits_factor, hr_factor, k_factor, runs_factor FROM cache_ballpark_factors`,
    );
    caches.ballpark = caches.ballpark ?? new Map();
    for (const r of rows) caches.ballpark.set(r.park_name, r);
  }
  const targetPark = TEAM_TO_PARK[event.home_team];
  const ballparkRow = targetPark ? caches.ballpark!.get(targetPark) : undefined;
  const ballpark: BallparkFactor | null = ballparkRow
    ? {
      runsFactor: Number(ballparkRow.runs_factor ?? 1.0),
      hrFactor: Number(ballparkRow.hr_factor ?? 1.0),
      kFactor: Number(ballparkRow.k_factor ?? 1.0),
      hitsFactor: Number(ballparkRow.hits_factor ?? 1.0),
    }
    : null;
  if (ballpark) presentFactors += 1; else missing.push("ballpark");

  expectedFactors += 1;
  let weatherRow: WeatherRow | undefined = caches.weather?.get(eventId);
  if (!weatherRow) {
    const rows = await db.query<WeatherRow>(
      `SELECT event_id, temperature_f, wind_speed_mph, wind_direction_degrees, is_dome
       FROM cache_mlb_historical_weather WHERE event_id = $1 LIMIT 1`,
      [eventId],
    );
    if (rows.length > 0) {
      weatherRow = rows[0];
      caches.weather?.set(eventId, weatherRow);
    }
  }
  const weather: GameWeather | null = weatherRow
    ? {
      tempF: weatherRow.temperature_f,
      windSpeed: weatherRow.wind_speed_mph,
      windDir: degToCompass(weatherRow.wind_direction_degrees),
      windDirDeg: weatherRow.wind_direction_degrees,
      condition: weatherRow.is_dome ? "Dome" : null,
    }
    : null;
  if (weather && weather.tempF !== null) presentFactors += 1; else missing.push("weather");

  expectedFactors += 1;
  let arsRow: ArsenalRow | undefined = caches.arsenal?.get(playerId);
  if (!arsRow) {
    const rows = await tryQuery<ArsenalRow>(
      `SELECT player_id, breaking_ball_pct, offspeed_pct, total_pitches, ff_avg_speed,
              si_avg_speed, csw_pct, total_pitches_csw
       FROM cache_statcast_pitcher_arsenal
       WHERE player_id = $1 ORDER BY snapshot_date DESC LIMIT 1`,
      [playerId],
    );
    if (rows.length > 0) {
      arsRow = rows[0];
      caches.arsenal?.set(playerId, arsRow);
    }
  }
  let arsenalCtx: PitcherKScoringContext["arsenal"] = null;
  let velocityCtx: PitcherKScoringContext["velocity"] = null;
  if (arsRow) {
    arsenalCtx = {
      breaking_ball_pct: arsRow.breaking_ball_pct,
      offspeed_pct: arsRow.offspeed_pct,
      total_pitches: arsRow.total_pitches,
      csw_pct: arsRow.csw_pct,
      total_pitches_csw: arsRow.total_pitches_csw ?? null,
    };
    const ff = arsRow.ff_avg_speed;
    const si = arsRow.si_avg_speed;
    const primary = ff !== null && si !== null ? Math.max(ff, si) : ff ?? si ?? null;
    velocityCtx = { primary_fb_velo: primary };
    presentFactors += 1;
  } else {
    missing.push("arsenal");
  }

  missing.push("catcherFraming:lineup_catcher_lookup_skipped");

  let statcastCtx: PitcherKScoringContext["statcast"] = null;
  let stRow: PitcherStatcastRow | undefined = caches.statcast?.get(playerId);
  if (!stRow) {
    const rows = await tryQuery<PitcherStatcastRow>(
      `SELECT player_id, xera, era_minus_xera_diff, est_ba
       FROM cache_statcast_pitcher
       WHERE player_id = $1 ORDER BY snapshot_date DESC LIMIT 1`,
      [playerId],
    );
    if (rows.length > 0) {
      stRow = rows[0];
      caches.statcast?.set(playerId, stRow);
    }
  }
  if (stRow) {
    statcastCtx = {
      xera: stRow.xera,
      era_minus_xera_diff: stRow.era_minus_xera_diff,
      est_ba: stRow.est_ba,
    };
  }

  const umpire: UmpireStats | null = null;
  const opposingHitting: TeamHittingStats | null = null;

  const ctxOut: Omit<PitcherKScoringContext, "prop"> = {
    pitcher: {
      fullName,
      team: pitcherTeam,
      opponentTeam,
      isHome,
      gameTime: event.commence_time,
    },
    season: seasonStats,
    gameLog,
    opposingHitting,
    ballpark,
    weather,
    umpire,
    statcast: statcastCtx,
    catcherFraming: null,
    arsenal: arsenalCtx,
    velocity: velocityCtx,
    lineupKComposition: null,
  };

  const completeness = expectedFactors > 0 ? presentFactors / expectedFactors : 0;
  return { ctx: ctxOut, completeness, missing };
}

export { TEAM_TO_PARK, degToCompass };
