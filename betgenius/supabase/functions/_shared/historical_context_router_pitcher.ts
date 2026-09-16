// D-359 SHIP 3 — PitcherKScoringContext historical router.
//
// Reconstructs PitcherKScoringContext for a given (event_id, player_id, prop)
// using only data that existed before the game's commence_time. Mirrors the
// live scoring path (scoring_mlb_v2.ts:73-103).
//
// HONEST SCOPE per d359_context_field_map.md:
//   - season aggregate (kPerNine, ERA, etc): DERIVED from boxscore where
//     is_starter=true AND innings_pitched > 0.
//   - gameLog: boxscore filtered by player_id + game_date < target, last 5.
//   - opposingHitting (kRate, kRateVsLHP/RHP): DARK_NO_SOURCE. boxscore
//     doesn't store per-batter K, so team K-rate can't be reconstructed.
//     Returns null → score_opposing_lineup_k goes to 0.
//   - umpire: DARK (no historical per-game umpire data).
//   - statcast / catcherFraming / arsenal / velocity: current-snapshot
//     proxy from cache_statcast_* tables (caveat: not true AS-OF, but
//     stable season aggregates).
//   - lineupKComposition: DARK (requires per-batter season K rates we
//     don't have for historical).

import type {
  PitcherKScoringContext,
  PitcherSeasonStats,
  PitcherGameLogEntry,
  TeamHittingStats,
  BallparkFactor,
  GameWeather,
  UmpireStats,
} from "./scoring_mlb_v2.ts";

interface SupaArgs { url: string; key: string }

const sH = (a: SupaArgs) => ({
  apikey: a.key,
  Authorization: `Bearer ${a.key}`,
  "Content-Type": "application/json",
});

async function getJSON<T>(a: SupaArgs, path: string): Promise<T | null> {
  try {
    const r = await fetch(`${a.url}/rest/v1/${path}`, { headers: sH(a) });
    if (!r.ok) return null;
    return await r.json() as T;
  } catch { return null; }
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
  event_id: string; commence_time: string; home_team: string; away_team: string; game_pk: number | null;
}

interface OppPitcherRow {
  event_id: string;
  home_starter_id: number | null; home_starter_name: string | null; home_starter_hand: string | null;
  away_starter_id: number | null; away_starter_name: string | null; away_starter_hand: string | null;
}

interface WeatherRow {
  event_id: string; temperature_f: number | null; wind_speed_mph: number | null;
  wind_direction_degrees: number | null; precipitation_mm: number | null;
  humidity_pct: number | null; is_dome: boolean | null;
}

interface PlayerMetaRow { player_id: number; full_name: string | null; bats: string | null; throws: string | null; }
interface BallparkRow { park_name: string; hits_factor: number | null; hr_factor: number | null; k_factor: number | null; runs_factor: number | null; }
interface FramingRow { entity_id: number; rv_tot: number | null; pitches: number | null; snapshot_date: string; }
interface ArsenalRow { player_id: number; breaking_ball_pct: number | null; offspeed_pct: number | null; total_pitches: number | null; ff_avg_speed: number | null; si_avg_speed: number | null; csw_pct: number | null; total_pitches_csw: number | null; snapshot_date: string; }
interface PitcherStatcastRow { player_id: number; xera: number | null; era_minus_xera_diff: number | null; est_ba: number | null; }

const LEAGUE_AVG_K9 = 8.5;
const LEAGUE_AVG_ERA = 4.20;

const TEAM_TO_PARK: Record<string, string> = {
  "Arizona Diamondbacks": "Chase Field", "Atlanta Braves": "Truist Park",
  "Baltimore Orioles": "Camden Yards", "Boston Red Sox": "Fenway Park",
  "Chicago Cubs": "Wrigley Field", "Chicago White Sox": "Guaranteed Rate Field",
  "Cincinnati Reds": "Great American Ball Park", "Cleveland Guardians": "Progressive Field",
  "Colorado Rockies": "Coors Field", "Detroit Tigers": "Comerica Park",
  "Houston Astros": "Minute Maid Park", "Kansas City Royals": "Kauffman Stadium",
  "Los Angeles Angels": "Angel Stadium", "Los Angeles Dodgers": "Dodger Stadium",
  "Miami Marlins": "loanDepot park", "Milwaukee Brewers": "American Family Field",
  "Minnesota Twins": "Target Field", "New York Mets": "Citi Field",
  "New York Yankees": "Yankee Stadium", "Athletics": "Oakland Coliseum",
  "Oakland Athletics": "Oakland Coliseum", "Philadelphia Phillies": "Citizens Bank Park",
  "Pittsburgh Pirates": "PNC Park", "San Diego Padres": "Petco Park",
  "San Francisco Giants": "Oracle Park", "Seattle Mariners": "T-Mobile Park",
  "St. Louis Cardinals": "Busch Stadium", "Tampa Bay Rays": "Tropicana Field",
  "Texas Rangers": "Globe Life Field", "Toronto Blue Jays": "Rogers Centre",
  "Washington Nationals": "Nationals Park",
};

function degToCompass(deg: number | null | undefined): string | null {
  if (deg === null || deg === undefined) return null;
  const dirs = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
  return dirs[Math.round(((deg % 360) / 22.5)) % 16];
}

function aggregatePitcherSeason(rows: BoxscoreRow[]): {
  gamesPlayed: number; inningsPitched: number; strikeOuts: number; battersFaced: number;
  kPerNine: number; era: number; pitchesPerStart: number | null; baseOnBalls: number;
} {
  let gp = 0, ip = 0, k = 0, bf = 0, er = 0, pTotal = 0, pCount = 0, bb = 0;
  for (const r of rows) {
    if (!r.is_starter) continue;
    if ((r.innings_pitched ?? 0) <= 0) continue;
    gp++;
    ip += Number(r.innings_pitched ?? 0);
    k += r.strikeouts ?? 0;
    bf += r.batters_faced ?? 0;
    er += r.pitcher_earned_runs ?? 0;
    bb += r.walks ?? 0;  // D-671 — sum real walks from historical boxscore
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
  a: SupaArgs,
  eventId: string,
  playerId: number,
  caches: {
    events?: Map<string, EventRow>;
    oppPitcher?: Map<string, OppPitcherRow>;
    weather?: Map<string, WeatherRow>;
    ballpark?: Map<string, BallparkRow>;
    playerMeta?: Map<number, PlayerMetaRow>;
    framing?: Map<number, FramingRow>;
    arsenal?: Map<number, ArsenalRow>;
    statcast?: Map<number, PitcherStatcastRow>;
  } = {},
): Promise<PitcherHistoricalContextBundle> {
  const missing: string[] = [];
  let expectedFactors = 0;
  let presentFactors = 0;

  // 1) EVENT META
  expectedFactors += 1;
  let event: EventRow | undefined = caches.events?.get(eventId);
  if (!event) {
    const rows = await getJSON<EventRow[]>(
      a,
      `cache_mlb_historical_events?event_id=eq.${eventId}&select=event_id,commence_time,home_team,away_team,game_pk`,
    );
    if (rows && rows.length > 0) {
      event = rows[0];
      caches.events?.set(eventId, event);
    }
  }
  if (!event) throw new Error(`historical_router_pitcher: event_id=${eventId} not found`);
  presentFactors += 1;
  const gameDate = event.commence_time.slice(0, 10);

  // 2) OPPOSING PITCHER table — identifies which team this pitcher is on
  let oppPitcher: OppPitcherRow | undefined = caches.oppPitcher?.get(eventId);
  if (!oppPitcher) {
    const rows = await getJSON<OppPitcherRow[]>(
      a,
      `cache_mlb_historical_opposing_pitcher?event_id=eq.${eventId}&select=*`,
    );
    if (rows && rows.length > 0) {
      oppPitcher = rows[0];
      caches.oppPitcher?.set(eventId, oppPitcher);
    }
  }
  let isHome = false;
  if (oppPitcher) {
    isHome = oppPitcher.home_starter_id === playerId;
  }
  const pitcherTeam = isHome ? event.home_team : event.away_team;
  const opponentTeam = isHome ? event.away_team : event.home_team;

  // 3) PLAYER METADATA
  let meta: PlayerMetaRow | undefined = caches.playerMeta?.get(playerId);
  if (!meta) {
    const rows = await getJSON<PlayerMetaRow[]>(
      a,
      `cache_mlb_player_metadata?player_id=eq.${playerId}&select=player_id,full_name,bats,throws`,
    );
    if (rows && rows.length > 0) { meta = rows[0]; caches.playerMeta?.set(playerId, meta); }
  }
  const fullName = meta?.full_name ?? "Unknown";
  const throws: "L" | "R" | null = meta?.throws === "L" || meta?.throws === "R" ? meta.throws : null;

  // 4) GAMELOG + SEASON AGGREGATE
  expectedFactors += 2;
  const gameLogRows = await getJSON<BoxscoreRow[]>(
    a,
    `cache_mlb_boxscore_player_stats?player_id=eq.${playerId}&game_date=lt.${gameDate}&order=game_date.desc&limit=100&select=player_id,game_pk,game_date,position_type,is_starter,innings_pitched,pitches_thrown,strikeouts,walks,pitcher_earned_runs,batters_faced,pitcher_runs`,
  );
  // For gameLog: last 5 STARTS (filter is_starter=true + IP>0 BEFORE slicing per the D-346 SHIP 2 fix)
  //
  // D-737f-A-3 BUG FIX: query is `order=game_date.desc` (newest first), then slice(0,5).
  // WITHOUT .reverse(), gameLog[0] = newest start and gameLog[gameLog.length-1] = OLDEST
  // of the 5 recent starts (~25-30 days old).
  //
  // The live scoring path (process-games-mlb.fetchPitcherGameLog) returns MLB Stats API
  // gameLog splits in ASCENDING order — scoring formula in scoring_mlb_v2.ts reads
  // `gameLog[gameLog.length - 1].date` expecting the MOST RECENT game.
  //
  // Without this .reverse(), score_rest_pitcher always computes days_rest from a
  // 25-day-old date → ALWAYS hits `if (days >= 7) f_rest = -2` (rust risk) regardless
  // of the pitcher's actual recent rest. Likewise score_pitcher_form (recent vs season)
  // reads the wrong window. D-737f-A-2 diagnosis confirms: rest_pitcher parity 21%,
  // form parity 32% — both expected to recover to ≥95% after this fix.
  //
  // (Same `.reverse()` would have helped any prior D-359/D-368 historical-replay
  // iteration that consumed this gameLog. See D-737f-A-3 doc for wider-audit note.)
  // D-740 STEP 1C — REMOVE the is_starter filter on gameLog construction so the
  // last-5 window matches what live's MLB Stats API gameLog returns (ALL pitching
  // appearances, not just starts). D-737f-A-2 diagnosed this as the structural
  // divergence behind pitcher_form parity 32%.
  const recentPitches = (gameLogRows ?? []).filter((r) => (r.innings_pitched ?? 0) > 0);
  const gameLog: PitcherGameLogEntry[] = recentPitches
    .slice(0, 5)
    .reverse()  // D-737f-A-3 — make ASC order to match scoring formula expectations
    .map((r) => ({
      date: r.game_date,
      strikeOuts: r.strikeouts ?? 0,
      inningsPitched: Number(r.innings_pitched ?? 0),
      opponent: "", // not in boxscore; left empty
      pitchCount: r.pitches_thrown ?? null,
      walks: r.walks ?? null,
    }));
  if (gameLog.length > 0) presentFactors += 1; else missing.push("gameLog");

  // D-740 STEP 1C — TRY cache_mlb_pitcher_season_stats first (populated from MLB
  // Stats API; matches what process-games-mlb.fetchPitcherSeason reads at live
  // scoring time). Falls back to boxscore aggregation on cache miss.
  let seasonStats: PitcherSeasonStats;
  const seasonYear = Number(gameDate.slice(0, 4));
  const cacheRows = await getJSON<Array<{
    games_played: number | null; innings_pitched: number | string | null;
    strike_outs: number | null; batters_faced: number | null;
    k_per_nine: number | null; era: number | null;
    pitches_per_start: number | null; base_on_balls: number | null;
    throws: string | null;
  }>>(
    a,
    `cache_mlb_pitcher_season_stats?player_id=eq.${playerId}&season=eq.${seasonYear}` +
    `&select=games_played,innings_pitched,strike_outs,batters_faced,k_per_nine,era,pitches_per_start,base_on_balls,throws`,
  );
  const cacheRow = cacheRows && cacheRows.length > 0 ? cacheRows[0] : null;
  if (cacheRow && (cacheRow.games_played ?? 0) > 0) {
    // Cache hit — MLB API source of truth (matches live)
    const cacheThrows: "L" | "R" | null = cacheRow.throws === "L" || cacheRow.throws === "R"
      ? cacheRow.throws : null;
    seasonStats = {
      gamesPlayed: cacheRow.games_played ?? 0,
      inningsPitched: Number(cacheRow.innings_pitched ?? 0),
      strikeOuts: cacheRow.strike_outs ?? 0,
      battersFaced: cacheRow.batters_faced ?? 0,
      kPerNine: Number(cacheRow.k_per_nine ?? 0),
      era: Number(cacheRow.era ?? 0),
      pitchesPerStart: cacheRow.pitches_per_start !== null ? Number(cacheRow.pitches_per_start) : null,
      throws: cacheThrows ?? throws,  // prefer cache hand; fall back to player_metadata
      baseOnBalls: cacheRow.base_on_balls ?? 0,
    };
    presentFactors += 1;
  } else {
    // Fallback: boxscore aggregation (legacy path, kept for graceful degradation)
    const seasonAgg = aggregatePitcherSeason(gameLogRows ?? []);
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

  // 5) BALLPARK
  expectedFactors += 1;
  let ballparkRow: BallparkRow | undefined;
  if (!caches.ballpark || caches.ballpark.size === 0) {
    const rows = await getJSON<BallparkRow[]>(
      a,
      `cache_ballpark_factors?select=park_name,hits_factor,hr_factor,k_factor,runs_factor`,
    );
    caches.ballpark = caches.ballpark ?? new Map();
    for (const r of rows ?? []) caches.ballpark.set(r.park_name, r);
  }
  const targetPark = TEAM_TO_PARK[event.home_team];
  if (targetPark) ballparkRow = caches.ballpark!.get(targetPark);
  const ballpark: BallparkFactor | null = ballparkRow
    ? {
        runsFactor: Number(ballparkRow.runs_factor ?? 1.0),
        hrFactor: Number(ballparkRow.hr_factor ?? 1.0),
        kFactor: Number(ballparkRow.k_factor ?? 1.0),
        hitsFactor: Number(ballparkRow.hits_factor ?? 1.0),
      }
    : null;
  if (ballpark) presentFactors += 1; else missing.push("ballpark");

  // 6) WEATHER
  expectedFactors += 1;
  let weatherRow: WeatherRow | undefined = caches.weather?.get(eventId);
  if (!weatherRow) {
    const rows = await getJSON<WeatherRow[]>(
      a,
      `cache_mlb_historical_weather?event_id=eq.${eventId}&select=*`,
    );
    if (rows && rows.length > 0) { weatherRow = rows[0]; caches.weather?.set(eventId, weatherRow); }
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

  // 7) ARSENAL — pitch mix + velocity (current snapshot proxy)
  expectedFactors += 1;
  let arsRow: ArsenalRow | undefined = caches.arsenal?.get(playerId);
  if (!arsRow) {
    const rows = await getJSON<ArsenalRow[]>(
      a,
      `cache_statcast_pitcher_arsenal?player_id=eq.${playerId}&order=snapshot_date.desc&limit=1&select=*`,
    );
    if (rows && rows.length > 0) { arsRow = rows[0]; caches.arsenal?.set(playerId, arsRow); }
  }
  let arsenalCtx: PitcherKScoringContext["arsenal"] = null;
  let velocityCtx: PitcherKScoringContext["velocity"] = null;
  if (arsRow) {
    arsenalCtx = {
      breaking_ball_pct: arsRow.breaking_ball_pct,
      offspeed_pct: arsRow.offspeed_pct,
      total_pitches: arsRow.total_pitches,
      csw_pct: arsRow.csw_pct,  // D-749 — CSW% (called_strike + whiff) / total_pitches
      total_pitches_csw: (arsRow as { total_pitches_csw?: number | null }).total_pitches_csw ?? null,
    };
    const ff = arsRow.ff_avg_speed;
    const si = arsRow.si_avg_speed;
    const primary = ff !== null && si !== null ? Math.max(ff, si) : ff ?? si ?? null;
    velocityCtx = { primary_fb_velo: primary };
    presentFactors += 1;
  } else {
    missing.push("arsenal");
  }

  // 8) CATCHER FRAMING — current snapshot for opposing team's catcher
  // (the opposing team's catcher is the one catching THIS pitcher, since the
  // game has both teams playing — wait, no. The pitcher's OWN catcher is on
  // the same team as the pitcher. Their framing affects the pitcher's K rate.
  // We need to identify this pitcher's team's catcher.
  // For simplicity, use any most-recent framing row for any catcher on this team.
  // True implementation would identify the starting catcher from lineups.
  expectedFactors += 1;
  let framingCtx: PitcherKScoringContext["catcherFraming"] = null;
  // Skip for now: catcher_framing identification requires lineup catcher lookup.
  // Default to null → factor goes dark for this pitcher (acceptable per D-357 + D-358 honest).
  missing.push("catcherFraming:lineup_catcher_lookup_skipped");

  // 9) STATCAST — current-snapshot proxy (xera, est_ba)
  let statcastCtx: PitcherKScoringContext["statcast"] = null;
  let stRow: PitcherStatcastRow | undefined = caches.statcast?.get(playerId);
  if (!stRow) {
    const rows = await getJSON<PitcherStatcastRow[]>(
      a,
      `cache_statcast_pitcher?player_id=eq.${playerId}&select=player_id,xera,era_minus_xera_diff,est_ba&order=snapshot_date.desc&limit=1`,
    );
    if (rows && rows.length > 0) { stRow = rows[0]; caches.statcast?.set(playerId, stRow); }
  }
  if (stRow) {
    statcastCtx = {
      xera: stRow.xera,
      era_minus_xera_diff: stRow.era_minus_xera_diff,
      est_ba: stRow.est_ba,
    };
  }

  // 10) UMPIRE — DARK (no historical per-game source)
  const umpire: UmpireStats | null = null;

  // 11) OPPOSING HITTING — DARK (boxscore doesn't store per-batter K)
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
    catcherFraming: framingCtx,
    arsenal: arsenalCtx,
    velocity: velocityCtx,
    lineupKComposition: null,
  };

  const completeness = expectedFactors > 0 ? presentFactors / expectedFactors : 0;
  return { ctx: ctxOut, completeness, missing };
}
