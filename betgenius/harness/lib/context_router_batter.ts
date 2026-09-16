// Phase 1 backtest harness — BatterScoringContext historical router (Postgres).
//
// Port of supabase/functions/_shared/historical_context_router_batter.ts for
// direct read-only Postgres access. Reconstructs BatterScoringContext for a
// given (event_id, player_id) using ONLY data that existed BEFORE the game's
// commence_time. Mirrors the live scoring path's field structure.
//
// HONEST SCOPE per d359_context_field_map.md:
//   - Season aggregate fields (BA, HR/PA, ISO, hand-splits) are DERIVED via
//     boxscore aggregation (cache_mlb_boxscore_player_stats) AS-OF date.
//   - gameLog reads same table filtered by game_date < target.
//   - opposingPitcher: hand from cache_mlb_historical_opposing_pitcher;
//     era/whip/k_per_9 derived via pitcher's boxscore aggregation.
//   - statcast: DARK in router (harness overrides via statcast_asof.ts).
//   - splits / opposingPitcherSplits: DARK_PER_D357 (current snapshot proxy).
//
// No-leakage discipline:
//   - boxscore query: game_date < target_game_date
//   - season aggregate: same filter, then SUM/COUNT in code
//   - opposing pitcher: event_id is the target event (known pre-game)
//
// Phase 1 runs_scored extension:
//   - season.runs / gameLog[].runs populated from runs_scored column (D-729).

import type {
  BatterScoringContext,
  BatterSeasonStats,
  BatterGameLogEntry,
  OpposingPitcherContext,
  BallparkFactor,
  GameWeather,
} from "../../supabase/functions/_shared/scoring_mlb_v2.ts";
import { type Db } from "./env.ts";

export interface BatterHistoricalContextBundle {
  ctx: Omit<BatterScoringContext, "prop">;
  completeness: number;
  missing: string[];
}

interface BoxscoreRow {
  player_id: number;
  game_pk: number;
  game_date: string;
  team_id: number | null;
  player_name: string | null;
  position_type: string | null;
  is_starter: boolean;
  batting_order_slot: number | null;
  at_bats: number | null;
  hits: number | null;
  home_runs: number | null;
  total_bases: number | null;
  rbi: number | null;
  plate_appearances: number | null;
  innings_pitched: number | null;
  pitches_thrown: number | null;
  strikeouts: number | null;
  walks: number | null;
  batters_faced: number | null;
  pitcher_runs: number | null;
  pitcher_earned_runs: number | null;
  runs_scored: number | null;
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
  home_starter_name: string | null;
  home_starter_hand: string | null;
  away_starter_id: number | null;
  away_starter_name: string | null;
  away_starter_hand: string | null;
}

interface WeatherRow {
  event_id: string;
  temperature_f: number | null;
  wind_speed_mph: number | null;
  wind_direction_degrees: number | null;
  precipitation_mm: number | null;
  humidity_pct: number | null;
  is_dome: boolean | null;
}

interface LineupRow {
  event_id: string;
  team_side: string;
  player_id: number;
  lineup_position: number | null;
}

interface PlayerMetaRow {
  player_id: number;
  full_name: string | null;
  bats: string | null;
  throws: string | null;
}

interface BallparkRow {
  park_name: string;
  hits_factor: number | null;
  hr_factor: number | null;
  k_factor: number | null;
  runs_factor: number | null;
}

const LEAGUE_AVG_BA = 0.245;
const LEAGUE_AVG_HR_PA = 0.030;
const LEAGUE_AVG_ISO = 0.155;
const LEAGUE_AVG_OBP = 0.315;
const LEAGUE_AVG_ERA = 4.20;
const LEAGUE_AVG_WHIP = 1.30;
const LEAGUE_AVG_K9 = 8.5;
const LEAGUE_AVG_HR9 = 1.20;

function normalizePark(name: string | null): string {
  if (!name) return "";
  return name.trim();
}

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

function aggregateBatterSeason(rows: BoxscoreRow[]): {
  gamesPlayed: number;
  atBats: number;
  hits: number;
  plateAppearances: number;
  battingAvg: number;
  babip: number;
  obp: number;
  homeRuns: number;
  totalBases: number;
  rbi: number;
  hrPerPA: number;
  iso: number;
  runs: number;
} {
  let gamesPlayed = 0, ab = 0, h = 0, pa = 0, hr = 0, tb = 0, rbi = 0, runs = 0;
  for (const r of rows) {
    const rowPA = r.plate_appearances ?? 0;
    const rowAB = r.at_bats ?? 0;
    if (rowPA === 0 && rowAB === 0) continue;
    gamesPlayed++;
    ab += rowAB;
    h += r.hits ?? 0;
    pa += rowPA;
    hr += r.home_runs ?? 0;
    tb += r.total_bases ?? 0;
    rbi += r.rbi ?? 0;
    runs += r.runs_scored ?? 0;
  }
  const battingAvg = ab > 0 ? h / ab : 0;
  const slg = ab > 0 ? tb / ab : 0;
  const iso = slg - battingAvg;
  const hrPerPA = pa > 0 ? hr / pa : 0;
  const babipDenom = ab - hr;
  const babip = babipDenom > 0 ? (h - hr) / babipDenom : 0;
  const obp = battingAvg + (iso * 0.4);
  return {
    gamesPlayed, atBats: ab, hits: h, plateAppearances: pa, battingAvg, babip, obp,
    homeRuns: hr, totalBases: tb, rbi, hrPerPA, iso, runs,
  };
}

function aggregatePitcherSeason(rows: BoxscoreRow[]): {
  inningsPitched: number;
  era: number;
  whip: number;
  kPerNine: number;
  hrPerNine: number;
} {
  let ip = 0, er = 0, k = 0, bb = 0;
  for (const r of rows) {
    if ((r.innings_pitched ?? 0) <= 0) continue;
    ip += Number(r.innings_pitched ?? 0);
    er += r.pitcher_earned_runs ?? 0;
    k += r.strikeouts ?? 0;
    bb += r.walks ?? 0;
  }
  const era = ip > 0 ? (er * 9) / ip : LEAGUE_AVG_ERA;
  const whip = ip > 0 ? (bb + Math.round(ip * 1.2)) / ip : LEAGUE_AVG_WHIP;
  const kPerNine = ip > 0 ? (k * 9) / ip : LEAGUE_AVG_K9;
  return { inningsPitched: ip, era, whip, kPerNine, hrPerNine: LEAGUE_AVG_HR9 };
}

export async function buildBatterHistoricalContext(
  db: Db,
  eventId: string,
  playerId: number,
  caches: {
    events?: Map<string, EventRow>;
    lineups?: Map<string, LineupRow[]>;
    oppPitcher?: Map<string, OppPitcherRow>;
    weather?: Map<string, WeatherRow>;
    ballpark?: Map<string, BallparkRow>;
    playerMeta?: Map<number, PlayerMetaRow>;
    pitcherSeason?: Map<string, ReturnType<typeof aggregatePitcherSeason>>;
    boxscoreGameLog?: {
      has(k: string): boolean;
      get(k: string): BoxscoreRow[] | undefined;
      set(k: string, v: BoxscoreRow[]): void;
    };
  } = {},
): Promise<BatterHistoricalContextBundle> {
  const missing: string[] = [];
  let expectedFactors = 0;
  let presentFactors = 0;

  // 1) EVENT META
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
  if (!event) {
    throw new Error(`historical_router_batter: event_id=${eventId} not found in cache_mlb_historical_events`);
  }
  presentFactors += 1;

  const gameDate = event.commence_time.slice(0, 10);

  // 2) LINEUPS
  let lineups: LineupRow[] | undefined = caches.lineups?.get(eventId);
  if (!lineups) {
    lineups = await db.query<LineupRow>(
      `SELECT event_id, team_side, player_id, lineup_position
       FROM cache_mlb_historical_lineups WHERE event_id = $1`,
      [eventId],
    );
    caches.lineups?.set(eventId, lineups);
  }
  const myLineupRow = lineups.find((l) => l.player_id === playerId);
  const isHome = myLineupRow?.team_side === "home";
  const batterTeam = isHome ? event.home_team : event.away_team;
  const opponentTeam = isHome ? event.away_team : event.home_team;
  const lineupSpot = myLineupRow?.lineup_position ?? null;

  // 3) PLAYER METADATA
  let meta: PlayerMetaRow | undefined = caches.playerMeta?.get(playerId);
  if (!meta) {
    const rows = await db.query<PlayerMetaRow>(
      `SELECT player_id, full_name, bats, throws FROM cache_mlb_player_metadata
       WHERE player_id = $1 LIMIT 1`,
      [playerId],
    );
    if (rows.length > 0) {
      meta = rows[0];
      caches.playerMeta?.set(playerId, meta);
    }
  }
  const fullName = meta?.full_name ?? "Unknown";
  const bats: "L" | "R" | "S" | null =
    meta?.bats === "L" || meta?.bats === "R" || meta?.bats === "S" ? meta.bats : null;

  // 4) GAMELOG + SEASON — boxscore aggregate AS-OF game_date
  expectedFactors += 2;
  const boxscoreKey = `${playerId}|${gameDate}`;
  let gameLogRows: BoxscoreRow[];
  if (caches.boxscoreGameLog?.has(boxscoreKey)) {
    gameLogRows = caches.boxscoreGameLog.get(boxscoreKey)!;
  } else {
    gameLogRows = await db.query<BoxscoreRow>(
      `SELECT player_id, game_pk, game_date, position_type, is_starter, batting_order_slot,
              at_bats, hits, home_runs, total_bases, rbi, plate_appearances, innings_pitched, runs_scored
       FROM cache_mlb_boxscore_player_stats
       WHERE player_id = $1 AND game_date < $2::date
       ORDER BY game_date DESC LIMIT 200`,
      [playerId, gameDate],
    );
    caches.boxscoreGameLog?.set(boxscoreKey, gameLogRows);
  }
  const gameLog: BatterGameLogEntry[] = gameLogRows
    .filter((r) => (r.plate_appearances ?? 0) > 0 || (r.at_bats ?? 0) > 0)
    .slice(0, 10)
    .map((r) => ({
      date: r.game_date,
      atBats: r.at_bats ?? 0,
      hits: r.hits ?? 0,
      homeRuns: r.home_runs ?? 0,
      totalBases: r.total_bases ?? 0,
      rbi: r.rbi ?? 0,
      plateAppearances: r.plate_appearances ?? 0,
      battingOrderSlot: r.batting_order_slot ?? null,
      strikeOuts: 0,
      runs: r.runs_scored ?? 0,
    }));
  if (gameLog.length > 0) presentFactors += 1; else missing.push("gameLog");

  const seasonAggregateRaw = aggregateBatterSeason(gameLogRows);

  // Hand-splits AS-OF
  let avgVsLHP: number | null = null;
  let avgVsRHP: number | null = null;
  let paVsLHP = 0;
  let paVsRHP = 0;
  if (gameLogRows.length >= 15) {
    const gamePks = gameLogRows.map((r) => r.game_pk).filter(Boolean);
    if (gamePks.length > 0) {
      const evMapRows = await db.query<{ event_id: string; game_pk: number; home_team: string; away_team: string }>(
        `SELECT event_id, game_pk, home_team, away_team FROM cache_mlb_historical_events
         WHERE game_pk = ANY($1::int[])`,
        [gamePks],
      );
      const gpToEv = new Map<number, { event_id: string; home_team: string; away_team: string }>();
      for (const r of evMapRows) gpToEv.set(r.game_pk, { event_id: r.event_id, home_team: r.home_team, away_team: r.away_team });
      const evIds = Array.from(new Set(Array.from(gpToEv.values()).map((v) => v.event_id)));
      const oppRows = evIds.length > 0
        ? await db.query<OppPitcherRow>(
          `SELECT * FROM cache_mlb_historical_opposing_pitcher WHERE event_id = ANY($1::text[])`,
          [evIds],
        )
        : [];
      const evToOpp = new Map<string, OppPitcherRow>();
      for (const r of oppRows) evToOpp.set(r.event_id, r);

      const lookupEvIds = gameLogRows
        .map((g) => gpToEv.get(g.game_pk)?.event_id)
        .filter((x): x is string => !!x);
      const sideMap = new Map<string, string>();
      if (lookupEvIds.length > 0) {
        for (let ci = 0; ci < lookupEvIds.length; ci += 200) {
          const idChunk = lookupEvIds.slice(ci, ci + 200);
          const sideRows = await db.query<{ event_id: string; team_side: string }>(
            `SELECT event_id, team_side FROM cache_mlb_historical_lineups
             WHERE event_id = ANY($1::text[]) AND player_id = $2`,
            [idChunk, playerId],
          );
          for (const row of sideRows) sideMap.set(row.event_id, row.team_side);
        }
      }
      let lAB = 0, lH = 0, rAB = 0, rH = 0, lPA = 0, rPA = 0;
      for (const game of gameLogRows) {
        const ev = gpToEv.get(game.game_pk);
        if (!ev) continue;
        const opp = evToOpp.get(ev.event_id);
        if (!opp) continue;
        const homeHand = opp.home_starter_hand;
        const awayHand = opp.away_starter_hand;
        let oppHand: string | null = null;
        if (homeHand && awayHand && homeHand === awayHand) {
          oppHand = homeHand;
        } else {
          const side = sideMap.get(ev.event_id);
          if (side === "home") oppHand = awayHand;
          else if (side === "away") oppHand = homeHand;
        }
        const pa = game.plate_appearances ?? 0;
        const ab = game.at_bats ?? 0;
        const h = game.hits ?? 0;
        if (oppHand === "L") { lAB += ab; lH += h; lPA += pa; }
        else if (oppHand === "R") { rAB += ab; rH += h; rPA += pa; }
      }
      if (lAB > 0) avgVsLHP = lH / lAB;
      if (rAB > 0) avgVsRHP = rH / rAB;
      paVsLHP = lPA;
      paVsRHP = rPA;
    }
  }

  const seasonStats: BatterSeasonStats = {
    gamesPlayed: seasonAggregateRaw.gamesPlayed,
    atBats: seasonAggregateRaw.atBats,
    hits: seasonAggregateRaw.hits,
    plateAppearances: seasonAggregateRaw.plateAppearances,
    battingAvg: seasonAggregateRaw.battingAvg || LEAGUE_AVG_BA,
    babip: seasonAggregateRaw.babip || LEAGUE_AVG_BA + 0.05,
    obp: seasonAggregateRaw.obp || LEAGUE_AVG_OBP,
    bats,
    homeRuns: seasonAggregateRaw.homeRuns,
    totalBases: seasonAggregateRaw.totalBases,
    rbi: seasonAggregateRaw.rbi,
    hrPerPA: seasonAggregateRaw.hrPerPA || LEAGUE_AVG_HR_PA,
    iso: seasonAggregateRaw.iso || LEAGUE_AVG_ISO,
    avgVsLHP,
    avgVsRHP,
    strikeOuts: 0,
    runs: seasonAggregateRaw.runs,
  };
  if (seasonAggregateRaw.atBats > 0) presentFactors += 1; else missing.push("season");

  // 5) OPPOSING PITCHER
  expectedFactors += 1;
  let oppPitcher: OppPitcherRow | undefined = caches.oppPitcher?.get(eventId);
  if (!oppPitcher) {
    const rows = await db.query<OppPitcherRow>(
      `SELECT * FROM cache_mlb_historical_opposing_pitcher WHERE event_id = $1 LIMIT 1`,
      [eventId],
    );
    if (rows.length > 0) {
      oppPitcher = rows[0];
      caches.oppPitcher?.set(eventId, oppPitcher);
    }
  }
  let opposingPitcher: OpposingPitcherContext | null = null;
  if (oppPitcher) {
    const oppStarterId = isHome ? oppPitcher.away_starter_id : oppPitcher.home_starter_id;
    const oppStarterName = isHome ? oppPitcher.away_starter_name : oppPitcher.home_starter_name;
    const oppStarterHand = isHome ? oppPitcher.away_starter_hand : oppPitcher.home_starter_hand;
    if (oppStarterId !== null && oppStarterId !== undefined) {
      const cacheKey = `${oppStarterId}|${gameDate}`;
      let pAgg = caches.pitcherSeason?.get(cacheKey);
      if (!pAgg) {
        const pRows = await db.query<BoxscoreRow>(
          `SELECT player_id, game_pk, game_date, innings_pitched, strikeouts, walks,
                  pitcher_earned_runs, batters_faced, pitches_thrown, position_type, is_starter,
                  team_id, player_name, batting_order_slot, at_bats, hits, home_runs, total_bases,
                  rbi, plate_appearances, pitcher_runs
           FROM cache_mlb_boxscore_player_stats
           WHERE player_id = $1 AND game_date < $2::date LIMIT 200`,
          [oppStarterId, gameDate],
        );
        pAgg = aggregatePitcherSeason(pRows);
        caches.pitcherSeason?.set(cacheKey, pAgg);
      }
      let resolvedHand: "L" | "R" | null =
        oppStarterHand === "L" || oppStarterHand === "R" ? oppStarterHand : null;
      if (!resolvedHand) {
        let oppMeta: PlayerMetaRow | undefined = caches.playerMeta?.get(oppStarterId);
        if (!oppMeta) {
          const rows = await db.query<PlayerMetaRow>(
            `SELECT player_id, full_name, bats, throws FROM cache_mlb_player_metadata
             WHERE player_id = $1 LIMIT 1`,
            [oppStarterId],
          );
          if (rows.length > 0) {
            oppMeta = rows[0];
            caches.playerMeta?.set(oppStarterId, oppMeta);
          }
        }
        if (oppMeta?.throws === "L" || oppMeta?.throws === "R") resolvedHand = oppMeta.throws;
      }
      opposingPitcher = {
        fullName: oppStarterName ?? "Unknown",
        throws: resolvedHand,
        era: pAgg.era,
        whip: pAgg.whip,
        kPerNine: pAgg.kPerNine,
        hrPerNine: pAgg.hrPerNine,
        inningsPitched: pAgg.inningsPitched,
        last3Era: null,
        expectedWhiffPct: null,
        expectedKPct: null,
        expectedPutAway: null,
        groundOutsToAirouts: null,
        gamesStarted: null,
        last3StartEra: null,
      };
      presentFactors += 1;
    } else {
      missing.push("opposingPitcher:no_starter");
    }
  } else {
    missing.push("opposingPitcher:no_event_row");
  }

  // 6) BALLPARK
  expectedFactors += 1;
  let ballparkRow: BallparkRow | undefined;
  if (!caches.ballpark || caches.ballpark.size === 0) {
    const rows = await db.query<BallparkRow>(
      `SELECT park_name, hits_factor, hr_factor, k_factor, runs_factor FROM cache_ballpark_factors`,
    );
    caches.ballpark = caches.ballpark ?? new Map();
    for (const r of rows) caches.ballpark.set(normalizePark(r.park_name), r);
  }
  const targetPark = TEAM_TO_PARK[event.home_team];
  if (targetPark) {
    ballparkRow = caches.ballpark!.get(targetPark);
    if (!ballparkRow) {
      for (const [name, row] of caches.ballpark!) {
        if (name.toLowerCase() === targetPark.toLowerCase()) { ballparkRow = row; break; }
      }
    }
  }
  const ballpark: BallparkFactor | null = ballparkRow
    ? {
      runsFactor: Number(ballparkRow.runs_factor ?? 1.0),
      hrFactor: Number(ballparkRow.hr_factor ?? 1.0),
      kFactor: Number(ballparkRow.k_factor ?? 1.0),
      hitsFactor: Number(ballparkRow.hits_factor ?? 1.0),
    }
    : null;
  if (ballpark) presentFactors += 1; else missing.push("ballpark");

  // 7) WEATHER
  expectedFactors += 1;
  let weatherRow: WeatherRow | undefined = caches.weather?.get(eventId);
  if (!weatherRow) {
    const rows = await db.query<WeatherRow>(
      `SELECT * FROM cache_mlb_historical_weather WHERE event_id = $1 LIMIT 1`,
      [eventId],
    );
    if (rows.length > 0) {
      weatherRow = rows[0];
      caches.weather?.set(eventId, weatherRow);
    }
  }
  function degToCompass(deg: number | null | undefined): string | null {
    if (deg === null || deg === undefined) return null;
    const dirs = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];
    return dirs[Math.round(((deg % 360) / 22.5)) % 16];
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

  const ctxOut: Omit<BatterScoringContext, "prop"> = {
    batter: {
      fullName,
      team: batterTeam,
      opponentTeam,
      isHome,
      gameTime: event.commence_time,
      venue: ballparkRow?.park_name ?? null,
    },
    season: seasonStats,
    gameLog,
    opposingPitcher,
    ballpark,
    weather,
    statcast: null,
    splits: null,
    opposingBullpen: null,
    ballparkOrientation: null,
    lineupSpot,
    dayAfterNight: false,
    travelContext: null,
    opposingPitcherSplits: null,
    consecutiveStarts: null,
  };

  // 8) CONSECUTIVE STARTS
  expectedFactors += 1;
  const startsWindow = gameLogRows.filter((r) => {
    if (!r.is_starter) return false;
    const dt = new Date(r.game_date + "T00:00:00Z");
    const target = new Date(gameDate + "T00:00:00Z");
    const diffDays = (target.getTime() - dt.getTime()) / 86_400_000;
    return diffDays >= 1 && diffDays <= 14;
  });
  let cs = 0;
  const sortedDescByDate = [...startsWindow].sort((a, b) => b.game_date.localeCompare(a.game_date));
  let prevDate: string | null = null;
  for (const s of sortedDescByDate) {
    if (!prevDate) {
      cs = 1;
      prevDate = s.game_date;
      continue;
    }
    const gap = (new Date(prevDate + "T00:00:00Z").getTime() - new Date(s.game_date + "T00:00:00Z").getTime()) / 86_400_000;
    if (gap <= 3) {
      cs++;
      prevDate = s.game_date;
    } else {
      break;
    }
  }
  ctxOut.consecutiveStarts = cs;
  if (cs > 0) presentFactors += 1; else missing.push("consecutiveStarts:no_starts_in_window");

  // 9) HAND-SPLIT samples
  if (avgVsLHP !== null || avgVsRHP !== null) {
    ctxOut.splits = {
      vs_lhp_avg: avgVsLHP,
      vs_lhp_slg: null,
      vs_lhp_ops: null,
      vs_lhp_pa: paVsLHP || null,
      vs_rhp_avg: avgVsRHP,
      vs_rhp_slg: null,
      vs_rhp_ops: null,
      vs_rhp_pa: paVsRHP || null,
    };
  }

  // 10) BALLPARK ORIENTATION
  if (ballparkRow && weatherRow !== undefined) {
    ctxOut.ballparkOrientation = {
      cf_compass_degrees: 0,
      is_dome: weatherRow.is_dome ?? false,
    };
  }

  const completeness = expectedFactors > 0 ? presentFactors / expectedFactors : 0;
  return { ctx: ctxOut, completeness, missing };
}

export type RouterCaches = Parameters<typeof buildBatterHistoricalContext>[3];
