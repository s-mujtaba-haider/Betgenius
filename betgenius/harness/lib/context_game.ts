// Phase 1 — leak-safe GameScoringContext from warehouse tables via Postgres.
// Port of historical_context_router.ts (PostgREST) to the harness db.query
// client. Sequential queries only (rolconnlimit 10 / Busy TCP).
//
// AS-OF: team outcomes and H2H use commence_time < this game. Bullpen
// snapshot_date <= game date.

import type { Db } from "./env.ts";
import { BoundedMap } from "./context_batter.ts";
import type {
  BallparkFactor,
  GameScoringContext,
  GameWeather,
  H2HRecent,
  OpposingPitcherContext,
  TeamSeasonContext,
} from "../../supabase/functions/_shared/scoring_mlb_v2.ts";

const LEAGUE_AVG_RPG = 4.5;
const LEAGUE_AVG_ERA = 4.20;

/** Once true, skip cache_mlb_historical_pitcher_statcast for the rest of the process. */
let pitcherStatcastSelectDenied = false;
let loggedPitcherStatcastDenied = false;

function isPermissionDenied(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.toLowerCase().includes("permission denied");
}

const TEAM_TO_PARK: Record<string, string> = {
  "Arizona Diamondbacks": "Chase Field",
  "Atlanta Braves": "Truist Park",
  "Baltimore Orioles": "Oriole Park at Camden Yards",
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
  "Oakland Athletics": "Oakland Coliseum",
  Athletics: "Sutter Health Park",
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

interface OutcomeRow {
  home_team: string;
  away_team: string;
  home_score: number | null;
  away_score: number | null;
  commence_time: string;
}

type PitcherSeasonSlice = {
  era: number | null;
  xera: number | null;
  k_per_9: number | null;
  ip: number | null;
};

export interface GameContextCaches {
  teamOutcomes: BoundedMap<string, OutcomeRow[]>;
  bullpen: BoundedMap<string, number | null>;
  weather: BoundedMap<string, GameWeather | null>;
  ballpark: BoundedMap<string, BallparkFactor | null>;
  pitcher: BoundedMap<string, OpposingPitcherContext | null>;
  pitcherBoxscoreAsOf: BoundedMap<string, PitcherSeasonSlice | null>;
  h2h: BoundedMap<string, H2HRecent | null>;
}

export function newGameContextCaches(): GameContextCaches {
  return {
    teamOutcomes: new BoundedMap(400),
    bullpen: new BoundedMap(800),
    weather: new BoundedMap(4000),
    ballpark: new BoundedMap(40),
    pitcher: new BoundedMap(8000),
    pitcherBoxscoreAsOf: new BoundedMap(8000),
    h2h: new BoundedMap(4000),
  };
}

export interface GameContextResult {
  ctx: Omit<GameScoringContext, "prop">;
  completeness: number;
  missing: string[];
}

function emptyTeam(name: string): TeamSeasonContext {
  return {
    name,
    gamesPlayed: 0,
    runsPerGame: LEAGUE_AVG_RPG,
    runsAllowedPerGame: LEAGUE_AVG_RPG,
    l10Runs: null,
    l10RunsAllowed: null,
    bullpenEra: null,
    bullpenWhip: null,
    opsSeason: null,
    kRate: null,
    bullpenKPer9: null,
    bullpenBaa: null,
    teamOAA: null,
    l10AvgWinMargin: null,
    l10BlowoutPct: null,
    isoSeason: null,
    slgSeason: null,
    bobAvgEra: null,
    penIp48h: null,
  };
}

async function teamOutcomesAsOf(
  db: Db,
  caches: GameContextCaches,
  teamName: string,
  beforeCommence: string,
): Promise<OutcomeRow[]> {
  const key = `${teamName}|${beforeCommence.slice(0, 10)}`;
  if (caches.teamOutcomes.has(key)) return caches.teamOutcomes.get(key)!;
  const rows = await db.query<OutcomeRow>(
    `SELECT home_team, away_team, home_score, away_score,
            commence_time::text AS commence_time
     FROM cache_mlb_historical_outcomes
     WHERE game_completed = true
       AND commence_time < $2::timestamptz
       AND (home_team = $1 OR away_team = $1)
     ORDER BY commence_time DESC
     LIMIT 200`,
    [teamName, beforeCommence],
  );
  caches.teamOutcomes.set(key, rows);
  return rows;
}

function teamSeasonFromRows(
  teamName: string,
  beforeCommence: string,
  rows: OutcomeRow[],
  bullpenEra: number | null,
): TeamSeasonContext {
  if (rows.length === 0) return { ...emptyTeam(teamName), bullpenEra };
  const cd = new Date(beforeCommence);
  const seasonStart = new Date(cd);
  seasonStart.setMonth(cd.getMonth() - 7);
  const seasonRows = rows.filter((r) => new Date(r.commence_time) >= seasonStart);
  let runs = 0;
  let allowed = 0;
  for (const r of seasonRows) {
    if (r.home_team === teamName) {
      runs += r.home_score ?? 0;
      allowed += r.away_score ?? 0;
    } else {
      runs += r.away_score ?? 0;
      allowed += r.home_score ?? 0;
    }
  }
  const gp = seasonRows.length;
  const last10 = rows.slice(0, 10);
  let l10r = 0;
  let l10ra = 0;
  for (const r of last10) {
    if (r.home_team === teamName) {
      l10r += r.home_score ?? 0;
      l10ra += r.away_score ?? 0;
    } else {
      l10r += r.away_score ?? 0;
      l10ra += r.home_score ?? 0;
    }
  }
  return {
    ...emptyTeam(teamName),
    gamesPlayed: gp,
    runsPerGame: gp > 0 ? runs / gp : LEAGUE_AVG_RPG,
    runsAllowedPerGame: gp > 0 ? allowed / gp : LEAGUE_AVG_RPG,
    l10Runs: last10.length > 0 ? l10r / last10.length : null,
    l10RunsAllowed: last10.length > 0 ? l10ra / last10.length : null,
    bullpenEra,
  };
}

async function bullpenEraAsOf(
  db: Db,
  caches: GameContextCaches,
  teamName: string,
  gameDate: string,
): Promise<number | null> {
  const key = `${teamName}|${gameDate}`;
  if (caches.bullpen.has(key)) return caches.bullpen.get(key)!;
  const rows = await db.query<{ rolling_14d_era: number | null }>(
    `SELECT rolling_14d_era FROM cache_mlb_historical_bullpen
     WHERE team_name = $1 AND snapshot_date <= $2::date
     ORDER BY snapshot_date DESC LIMIT 1`,
    [teamName, gameDate],
  );
  const era = rows[0]?.rolling_14d_era ?? null;
  caches.bullpen.set(key, era);
  return era;
}

async function pitcherBoxscoreAsOf(
  db: Db,
  caches: GameContextCaches,
  playerId: number,
  gameDate: string,
  season: number,
): Promise<PitcherSeasonSlice | null> {
  const key = `${playerId}|${gameDate}`;
  if (caches.pitcherBoxscoreAsOf.has(key)) return caches.pitcherBoxscoreAsOf.get(key)!;
  const seasonStart = `${season}-03-01`;
  const rows = await db.query<{
    er: number | string | null;
    ip: number | string | null;
    k: number | string | null;
  }>(
    `SELECT COALESCE(SUM(pitcher_earned_runs), 0) AS er,
            COALESCE(SUM(innings_pitched), 0) AS ip,
            COALESCE(SUM(strikeouts), 0) AS k
     FROM cache_mlb_boxscore_player_stats
     WHERE player_id = $1
       AND game_date < $2::date
       AND game_date >= $3::date
       AND COALESCE(innings_pitched, 0) > 0`,
    [playerId, gameDate, seasonStart],
  );
  const ip = Number(rows[0]?.ip ?? 0);
  if (!(ip > 0)) {
    caches.pitcherBoxscoreAsOf.set(key, null);
    return null;
  }
  const er = Number(rows[0]?.er ?? 0);
  const k = Number(rows[0]?.k ?? 0);
  const slice: PitcherSeasonSlice = {
    era: (er * 9) / ip,
    xera: null,
    k_per_9: (k * 9) / ip,
    ip,
  };
  caches.pitcherBoxscoreAsOf.set(key, slice);
  return slice;
}

async function buildPitcher(
  db: Db,
  caches: GameContextCaches,
  eventId: string,
  side: "home" | "away",
  season: number,
  gameDate: string,
  missing: string[],
): Promise<OpposingPitcherContext | null> {
  const key = `${eventId}|${side}`;
  if (caches.pitcher.has(key)) return caches.pitcher.get(key)!;
  const opRows = await db.query<{
    home_starter_id: number | null;
    home_starter_name: string | null;
    home_starter_hand: string | null;
    away_starter_id: number | null;
    away_starter_name: string | null;
    away_starter_hand: string | null;
  }>(
    `SELECT home_starter_id, home_starter_name, home_starter_hand,
            away_starter_id, away_starter_name, away_starter_hand
     FROM cache_mlb_historical_opposing_pitcher
     WHERE event_id = $1 LIMIT 1`,
    [eventId],
  );
  if (opRows.length === 0) {
    missing.push(`opposing_pitcher_event:${side}`);
    caches.pitcher.set(key, null);
    return null;
  }
  const op = opRows[0];
  const starterId = side === "home" ? op.home_starter_id : op.away_starter_id;
  const starterName = side === "home" ? op.home_starter_name : op.away_starter_name;
  const starterHand = side === "home" ? op.home_starter_hand : op.away_starter_hand;
  if (starterId === null) {
    missing.push(`opposing_pitcher_id:${side}`);
    caches.pitcher.set(key, null);
    return null;
  }
  const throws_: "L" | "R" | null =
    starterHand === "L" || starterHand === "R" ? starterHand : null;
  let stats: PitcherSeasonSlice | undefined;

  if (!pitcherStatcastSelectDenied) {
    try {
      const psc = await db.query<{
        era: number | null;
        xera: number | null;
        k_per_9: number | null;
        ip: number | null;
      }>(
        `SELECT era, xera, k_per_9, ip FROM cache_mlb_historical_pitcher_statcast
         WHERE player_id = $1 AND season = $2 LIMIT 1`,
        [starterId, season],
      );
      stats = psc[0];
    } catch (e) {
      if (!isPermissionDenied(e)) throw e;
      pitcherStatcastSelectDenied = true;
      missing.push("pitcher_statcast_select_denied");
      if (!loggedPitcherStatcastDenied) {
        loggedPitcherStatcastDenied = true;
        console.warn(
          "[harness] SELECT denied on cache_mlb_historical_pitcher_statcast — " +
            "opposing pitcher uses leak-safe boxscore as-of (granted) / season_stats / league-avg",
        );
      }
    }
  } else {
    missing.push("pitcher_statcast_select_denied");
  }

  if (!stats) {
    const asOf = await pitcherBoxscoreAsOf(db, caches, starterId, gameDate, season);
    if (asOf) stats = asOf;
    else missing.push(`pitcher_boxscore_asof:${side}`);
  }

  if (!stats) {
    try {
      const seasonRows = await db.query<{
        era: number | null;
        k_per_nine: number | null;
        innings_pitched: number | string | null;
      }>(
        `SELECT era, k_per_nine, innings_pitched
         FROM cache_mlb_pitcher_season_stats
         WHERE player_id = $1 AND season = $2 LIMIT 1`,
        [starterId, season],
      );
      const s = seasonRows[0];
      if (s) {
        stats = {
          era: s.era,
          xera: null,
          k_per_9: s.k_per_nine,
          ip: s.innings_pitched != null ? Number(s.innings_pitched) : null,
        };
      }
    } catch (e) {
      if (!isPermissionDenied(e)) throw e;
      missing.push("pitcher_season_stats_select_denied");
    }
  }
  const ipUsed = stats?.ip ?? (stats?.era != null ? 100 : 0);
  const ctx: OpposingPitcherContext = {
    fullName: starterName ?? `pitcher_${starterId}`,
    throws: throws_,
    era: stats?.era ?? stats?.xera ?? LEAGUE_AVG_ERA,
    whip: 1.27,
    kPerNine: stats?.k_per_9 ?? 8.5,
    hrPerNine: 1.15,
    inningsPitched: ipUsed,
    last3Era: null,
    expectedWhiffPct: null,
    expectedKPct: null,
    expectedPutAway: null,
    groundOutsToAirouts: null,
    gamesStarted: null,
    last3StartEra: null,
  };
  caches.pitcher.set(key, ctx);
  return ctx;
}

async function buildWeather(
  db: Db,
  caches: GameContextCaches,
  eventId: string,
  missing: string[],
): Promise<GameWeather | null> {
  if (caches.weather.has(eventId)) return caches.weather.get(eventId)!;
  const rows = await db.query<{
    temperature_f: number | null;
    wind_speed_mph: number | null;
    wind_direction_degrees: number | null;
    precipitation_mm: number | null;
    humidity_pct: number | null;
    is_dome: boolean | null;
  }>(
    `SELECT temperature_f, wind_speed_mph, wind_direction_degrees,
            precipitation_mm, humidity_pct, is_dome
     FROM cache_mlb_historical_weather WHERE event_id = $1 LIMIT 1`,
    [eventId],
  );
  if (rows.length === 0) {
    missing.push("weather");
    caches.weather.set(eventId, null);
    return null;
  }
  const w = rows[0];
  const wx: GameWeather = w.is_dome
    ? { tempF: 70, windSpeed: 0, windDirection: 0, condition: "indoor", precipitation: 0, humidity: 50 }
    : w.temperature_f === null
    ? (() => {
      missing.push("weather_data");
      return null;
    })()
    : {
      tempF: w.temperature_f,
      windSpeed: w.wind_speed_mph ?? 0,
      windDirection: w.wind_direction_degrees ?? 0,
      condition: (w.precipitation_mm ?? 0) > 0 ? "Rain" : "Clouds",
      precipitation: w.precipitation_mm ?? 0,
      humidity: w.humidity_pct ?? 50,
    };
  caches.weather.set(eventId, wx);
  return wx;
}

async function buildBallpark(
  db: Db,
  caches: GameContextCaches,
  homeTeam: string,
  missing: string[],
): Promise<BallparkFactor | null> {
  if (caches.ballpark.has(homeTeam)) return caches.ballpark.get(homeTeam)!;
  const park = TEAM_TO_PARK[homeTeam];
  if (!park) {
    missing.push(`ballpark_team_unmapped:${homeTeam}`);
    caches.ballpark.set(homeTeam, null);
    return null;
  }
  const rows = await db.query<{
    runs_factor: number | null;
    hits_factor: number | null;
    hr_factor: number | null;
  }>(
    `SELECT runs_factor, hits_factor, hr_factor
     FROM cache_ballpark_factors WHERE park_name = $1 LIMIT 1`,
    [park],
  );
  if (rows.length === 0) {
    missing.push(`ballpark:${park}`);
    caches.ballpark.set(homeTeam, null);
    return null;
  }
  const r = rows[0];
  const bp: BallparkFactor = {
    runsFactor: r.runs_factor ?? 1.0,
    hitsFactor: r.hits_factor ?? 1.0,
    hrFactor: r.hr_factor ?? 1.0,
  };
  caches.ballpark.set(homeTeam, bp);
  return bp;
}

async function buildH2H(
  db: Db,
  caches: GameContextCaches,
  home: string,
  away: string,
  beforeCommence: string,
  missing: string[],
): Promise<H2HRecent | null> {
  const key = `${home}|${away}|${beforeCommence.slice(0, 10)}`;
  if (caches.h2h.has(key)) return caches.h2h.get(key)!;
  const rows = await db.query<OutcomeRow>(
    `SELECT home_team, away_team, home_score, away_score,
            commence_time::text AS commence_time
     FROM cache_mlb_historical_outcomes
     WHERE game_completed = true
       AND commence_time < $3::timestamptz
       AND ((home_team = $1 AND away_team = $2) OR (home_team = $2 AND away_team = $1))
     ORDER BY commence_time DESC
     LIMIT 10`,
    [home, away, beforeCommence],
  );
  if (rows.length === 0) {
    missing.push("h2h");
    caches.h2h.set(key, null);
    return null;
  }
  let totalRuns = 0;
  let homeWins = 0;
  for (const r of rows) {
    totalRuns += (r.home_score ?? 0) + (r.away_score ?? 0);
    const designatedIsHome = r.home_team === home;
    const designatedScore = designatedIsHome ? (r.home_score ?? 0) : (r.away_score ?? 0);
    const otherScore = designatedIsHome ? (r.away_score ?? 0) : (r.home_score ?? 0);
    if (designatedScore > otherScore) homeWins++;
  }
  const h2h: H2HRecent = {
    l10Games: rows.length,
    runsPerGame: totalRuns / rows.length,
    homeTeamWinPct: homeWins / rows.length,
  };
  caches.h2h.set(key, h2h);
  return h2h;
}

export async function buildLeakSafeGameContext(
  db: Db,
  eventId: string,
  commenceTime: string,
  homeTeam: string,
  awayTeam: string,
  caches: GameContextCaches,
): Promise<GameContextResult> {
  const missing: string[] = [];
  const season = new Date(commenceTime).getUTCFullYear();
  const gameDate = commenceTime.slice(0, 10);

  const homeBp = await bullpenEraAsOf(db, caches, homeTeam, gameDate);
  const awayBp = await bullpenEraAsOf(db, caches, awayTeam, gameDate);
  const homeRows = await teamOutcomesAsOf(db, caches, homeTeam, commenceTime);
  const awayRows = await teamOutcomesAsOf(db, caches, awayTeam, commenceTime);
  const homeCtx = teamSeasonFromRows(homeTeam, commenceTime, homeRows, homeBp);
  const awayCtx = teamSeasonFromRows(awayTeam, commenceTime, awayRows, awayBp);
  if (homeRows.length === 0) missing.push("team_season_outcomes:home");
  if (awayRows.length === 0) missing.push("team_season_outcomes:away");
  if (homeBp === null) missing.push(`bullpen:${homeTeam}`);
  if (awayBp === null) missing.push(`bullpen:${awayTeam}`);

  const weather = await buildWeather(db, caches, eventId, missing);
  const ballpark = await buildBallpark(db, caches, homeTeam, missing);
  const h2h = await buildH2H(db, caches, homeTeam, awayTeam, commenceTime, missing);
  const homePitcher = await buildPitcher(db, caches, eventId, "home", season, gameDate, missing);
  const awayPitcher = await buildPitcher(db, caches, eventId, "away", season, gameDate, missing);

  const present = [
    homeCtx.gamesPlayed > 0 ? 1 : 0,
    awayCtx.gamesPlayed > 0 ? 1 : 0,
    homePitcher !== null ? 1 : 0,
    awayPitcher !== null ? 1 : 0,
    ballpark !== null ? 1 : 0,
    weather !== null ? 1 : 0,
    h2h !== null ? 1 : 0,
    0,
  ].reduce((a, b) => a + b, 0);

  return {
    ctx: {
      game: { homeTeam, awayTeam, gameTime: commenceTime, venue: null },
      homeTeam: homeCtx,
      awayTeam: awayCtx,
      homePitcher,
      awayPitcher,
      ballpark,
      weather,
      umpire: null,
      h2h,
      lineupVsHand: null,
    },
    completeness: present / 8,
    missing,
  };
}
