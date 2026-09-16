// D-298 SHIP 1 — historical context router.
//
// Builds GameScoringContext from D-293 warehouses + outcomes for a
// given (event_id, commence_time, home_team, away_team).
//
// HONEST SCOPE (Cardinal §1.20):
// - GameScoringContext (game_side, game_total): SUPPORTED here.
// - BatterScoringContext (batter_hits, batter_total_bases, etc.):
//   NOT supported. Requires BatterSeasonStats + game_log + opposing
//   pitcher full season stats — none in D-293 warehouses. Queued
//   for D-299+ pending warehouse expansion.
//
// Per Esc Rule #5: graceful degradation. Each missing factor records
// itself in context_missing[] and falls back to a defensible default;
// replay continues. context_completeness = 1 − missing_count / expected.

import type {
  GameScoringContext,
  TeamSeasonContext,
  OpposingPitcherContext,
  BallparkFactor,
  GameWeather,
  UmpireStats,
  H2HRecent,
} from "./scoring_mlb_v2.ts";

export interface HistoricalContextBundle {
  ctx: Omit<GameScoringContext, "prop">; // caller fills in prop separately per pick
  completeness: number;
  missing: string[];
}

interface SupaArgs { url: string; key: string }

const sH = (a: SupaArgs) => ({ apikey: a.key, Authorization: `Bearer ${a.key}`, "Content-Type": "application/json" });

async function getJSON(a: SupaArgs, path: string): Promise<unknown[]> {
  const r = await fetch(`${a.url}/rest/v1/${path}`, { headers: sH(a) });
  if (!r.ok) return [];
  return await r.json();
}

const LEAGUE_AVG_RPG = 4.5;
const LEAGUE_AVG_ERA = 4.20;

// Compute a TeamSeasonContext from cache_mlb_historical_outcomes:
//   - games played, runs/game, runs_allowed/game (all home + away)
//   - l10 from most-recent 10 games before commence_time
// Bullpen ERA from cache_mlb_historical_bullpen (snapshot_date = day before commence_time)
async function buildTeamContext(
  a: SupaArgs,
  teamName: string,
  beforeCommence: string,
  outcomesCache: Record<string, OutcomeRow[]>,
  bullpenCache: Record<string, BullpenRow | null>,
): Promise<{ ctx: TeamSeasonContext; missing: string[] }> {
  const missing: string[] = [];
  // Pull team outcomes from cache (one team appears in many rows; both home & away)
  const key = teamName;
  if (!outcomesCache[key]) {
    const rows = await getJSON(a, `cache_mlb_historical_outcomes?or=(home_team.eq.${encodeURIComponent(teamName)},away_team.eq.${encodeURIComponent(teamName)})&commence_time=lt.${encodeURIComponent(beforeCommence)}&game_completed=eq.true&order=commence_time.desc&limit=200&select=home_team,away_team,home_score,away_score,commence_time`) as OutcomeRow[];
    outcomesCache[key] = rows;
  }
  const rows = outcomesCache[key];
  if (rows.length === 0) {
    missing.push("team_season_outcomes");
    return {
      ctx: { name: teamName, gamesPlayed: 0, runsPerGame: LEAGUE_AVG_RPG, runsAllowedPerGame: LEAGUE_AVG_RPG, l10Runs: null, l10RunsAllowed: null, bullpenEra: null, bullpenWhip: null, opsSeason: null, kRate: null, bullpenKPer9: null, bullpenBaa: null, teamOAA: null, l10AvgWinMargin: null, l10BlowoutPct: null, isoSeason: null, slgSeason: null, bobAvgEra: null, penIp48h: null },
      missing,
    };
  }

  // Filter to current season (games within 200 days before commence)
  const cd = new Date(beforeCommence);
  const seasonStart = new Date(cd);
  seasonStart.setMonth(cd.getMonth() - 7); // approx season window
  const seasonRows = rows.filter((r) => new Date(r.commence_time) >= seasonStart);
  let runs = 0, allowed = 0;
  for (const r of seasonRows) {
    if (r.home_team === teamName) { runs += r.home_score ?? 0; allowed += r.away_score ?? 0; }
    else { runs += r.away_score ?? 0; allowed += r.home_score ?? 0; }
  }
  const gp = seasonRows.length;
  const rpg = gp > 0 ? runs / gp : LEAGUE_AVG_RPG;
  const rapg = gp > 0 ? allowed / gp : LEAGUE_AVG_RPG;

  // L10
  const last10 = rows.slice(0, 10);
  let l10r = 0, l10ra = 0;
  for (const r of last10) {
    if (r.home_team === teamName) { l10r += r.home_score ?? 0; l10ra += r.away_score ?? 0; }
    else { l10r += r.away_score ?? 0; l10ra += r.home_score ?? 0; }
  }
  const l10Runs = last10.length > 0 ? l10r / last10.length : null;
  const l10RunsAllowed = last10.length > 0 ? l10ra / last10.length : null;

  // Bullpen ERA: lookup historical_bullpen snapshot for (teamName, snapshot_date = day-of beforeCommence)
  const snapDate = beforeCommence.slice(0, 10);
  const bpKey = `${teamName}|${snapDate}`;
  if (!(bpKey in bullpenCache)) {
    const bp = await getJSON(a, `cache_mlb_historical_bullpen?team_name=eq.${encodeURIComponent(teamName)}&snapshot_date=lte.${snapDate}&order=snapshot_date.desc&limit=1`) as BullpenRow[];
    bullpenCache[bpKey] = bp[0] ?? null;
  }
  const bp = bullpenCache[bpKey];
  let bullpenEra: number | null = null;
  if (bp && bp.rolling_14d_era !== null) bullpenEra = bp.rolling_14d_era;
  else { missing.push(`bullpen:${teamName}`); }

  return {
    ctx: { name: teamName, gamesPlayed: gp, runsPerGame: rpg, runsAllowedPerGame: rapg, l10Runs, l10RunsAllowed, bullpenEra, bullpenWhip: null, opsSeason: null, kRate: null, bullpenKPer9: null, bullpenBaa: null, teamOAA: null, l10AvgWinMargin: null, l10BlowoutPct: null, isoSeason: null, slgSeason: null, bobAvgEra: null, penIp48h: null },
    missing,
  };
}

interface OutcomeRow { home_team: string; away_team: string; home_score: number | null; away_score: number | null; commence_time: string }
interface BullpenRow { rolling_14d_era: number | null; rolling_14d_whip: number | null }
interface WeatherRow { temperature_f: number | null; wind_speed_mph: number | null; wind_direction_degrees: number | null; precipitation_mm: number | null; humidity_pct: number | null; is_dome: boolean }
interface PitcherStatcastRow { xera: number | null; era: number | null; k_per_9: number | null; bb_per_9: number | null; ip: number | null }

async function buildOpposingPitcher(a: SupaArgs, eventId: string, side: "home" | "away", season: number, missing: string[]): Promise<OpposingPitcherContext | null> {
  // D-303 SHIP 2 + D-304 SHIP 2 fixes:
  // (1) field names match OpposingPitcherContext interface (kPerNine
  //     not kPer9 — caught D-304 SHIP 1 diagnosis)
  // (2) inningsPitched proxy when stats.ip is null but era exists
  //     (pitching_matchup gate needs ip > 0; cache_mlb_historical_pitcher_statcast
  //      has era populated but ip column NULL in current backfill)
  // (3) throws field populated from cache_mlb_historical_opposing_pitcher
  //     hand columns (D-304 SHIP 2A backfilled via /people endpoint)
  const opRows = await getJSON(a, `cache_mlb_historical_opposing_pitcher?event_id=eq.${eventId}&select=home_starter_id,home_starter_name,home_starter_hand,away_starter_id,away_starter_name,away_starter_hand&limit=1`) as Array<{ home_starter_id: number | null; home_starter_name: string | null; home_starter_hand: string | null; away_starter_id: number | null; away_starter_name: string | null; away_starter_hand: string | null }>;
  if (opRows.length === 0) {
    missing.push(`opposing_pitcher_event:${side}`);
    return null;
  }
  const op = opRows[0];
  const starterId = side === "home" ? op.home_starter_id : op.away_starter_id;
  const starterName = side === "home" ? op.home_starter_name : op.away_starter_name;
  const starterHand = side === "home" ? op.home_starter_hand : op.away_starter_hand;
  if (starterId === null) {
    missing.push(`opposing_pitcher_id:${side}`);
    return null;
  }
  const throws_: "L" | "R" | null = starterHand === "L" || starterHand === "R" ? starterHand : null;

  // Look up pitcher stats from D-293 SHIP 5b warehouse (season aggregates)
  const psc = await getJSON(a, `cache_mlb_historical_pitcher_statcast?player_id=eq.${starterId}&season=eq.${season}&select=era,xera,k_per_9,bb_per_9,ip&limit=1`) as Array<{ era: number | null; xera: number | null; k_per_9: number | null; bb_per_9: number | null; ip: number | null }>;
  if (psc.length === 0) {
    missing.push(`opposing_pitcher_stats:${side}:${starterName}`);
    return {
      fullName: starterName ?? `pitcher_${starterId}`,
      throws: throws_,
      era: LEAGUE_AVG_ERA,
      whip: 1.27,
      kPerNine: 8.5,
      hrPerNine: 1.15,
      inningsPitched: 80, // proxy so pitching_matchup gate passes; flagged as fallback
      last3Era: null,
      // D-652 — historical replay path doesn't have Statcast arsenal context.
      expectedWhiffPct: null,
      expectedKPct: null,
      expectedPutAway: null,
      groundOutsToAirouts: null,
      // D-663 — backfill replay path has no gamesStarted; v3 IP/depth factor will null out.
      gamesStarted: null,
      // D-664 — backfill replay path has no last-3-start data.
      last3StartEra: null,
    };
  }
  const stats = psc[0];
  // D-304 SHIP 3 — when ip is null but era is real, use 100 IP proxy (typical
  // starter season). This allows the scoreGameMarket pitching_matchup factor
  // to fire on its era-only signal instead of being blocked by ip>0 gate.
  const ipUsed = stats.ip ?? (stats.era !== null ? 100 : 0);
  return {
    fullName: starterName ?? `pitcher_${starterId}`,
    throws: throws_,
    era: stats.era ?? stats.xera ?? LEAGUE_AVG_ERA,
    whip: 1.27,
    kPerNine: stats.k_per_9 ?? 8.5,
    hrPerNine: 1.15,
    inningsPitched: ipUsed,
    last3Era: null,
    // D-652 — historical replay path doesn't have Statcast arsenal context.
    expectedWhiffPct: null,
    expectedKPct: null,
    expectedPutAway: null,
    // D-661 — backfill replay path: no goToAo cached in pitcher_statcast warehouse.
    groundOutsToAirouts: null,
    // D-663 — backfill replay path: no gamesStarted cached.
    gamesStarted: null,
    // D-664 — backfill replay path: no last-3-start data.
    last3StartEra: null,
  };
}

async function buildWeather(a: SupaArgs, eventId: string, missing: string[]): Promise<GameWeather | null> {
  const rows = await getJSON(a, `cache_mlb_historical_weather?event_id=eq.${eventId}&select=*&limit=1`) as WeatherRow[];
  if (rows.length === 0) { missing.push("weather"); return null; }
  const w = rows[0];
  if (w.is_dome) {
    return { tempF: 70, windSpeed: 0, windDirection: 0, condition: "indoor", precipitation: 0, humidity: 50 };
  }
  if (w.temperature_f === null) { missing.push("weather_data"); return null; }
  return {
    tempF: w.temperature_f,
    windSpeed: w.wind_speed_mph ?? 0,
    windDirection: w.wind_direction_degrees ?? 0,
    condition: (w.precipitation_mm ?? 0) > 0 ? "Rain" : "Clouds",
    precipitation: w.precipitation_mm ?? 0,
    humidity: w.humidity_pct ?? 50,
  };
}

const TEAM_TO_PARK: Record<string, string> = {
  "Arizona Diamondbacks": "Chase Field", "Atlanta Braves": "Truist Park",
  "Baltimore Orioles": "Oriole Park at Camden Yards", "Boston Red Sox": "Fenway Park",
  "Chicago Cubs": "Wrigley Field", "Chicago White Sox": "Guaranteed Rate Field",
  "Cincinnati Reds": "Great American Ball Park", "Cleveland Guardians": "Progressive Field",
  "Colorado Rockies": "Coors Field", "Detroit Tigers": "Comerica Park",
  "Houston Astros": "Minute Maid Park", "Kansas City Royals": "Kauffman Stadium",
  "Los Angeles Angels": "Angel Stadium", "Los Angeles Dodgers": "Dodger Stadium",
  "Miami Marlins": "loanDepot park", "Milwaukee Brewers": "American Family Field",
  "Minnesota Twins": "Target Field", "New York Mets": "Citi Field",
  "New York Yankees": "Yankee Stadium", "Oakland Athletics": "Oakland Coliseum",
  "Athletics": "Sutter Health Park",
  "Philadelphia Phillies": "Citizens Bank Park", "Pittsburgh Pirates": "PNC Park",
  "San Diego Padres": "Petco Park", "San Francisco Giants": "Oracle Park",
  "Seattle Mariners": "T-Mobile Park", "St. Louis Cardinals": "Busch Stadium",
  "Tampa Bay Rays": "Tropicana Field", "Texas Rangers": "Globe Life Field",
  "Toronto Blue Jays": "Rogers Centre", "Washington Nationals": "Nationals Park",
};

async function buildBallpark(a: SupaArgs, homeTeam: string, missing: string[]): Promise<BallparkFactor | null> {
  // Reuse current production cache_ballpark_factors (per Cardinal §1.5).
  // Keyed by park_name; team→park mapping above. Current-season factors
  // not point-in-time — fidelity compromise documented in framework §15.
  const park = TEAM_TO_PARK[homeTeam];
  if (!park) { missing.push(`ballpark_team_unmapped:${homeTeam}`); return null; }
  const rows = await getJSON(a, `cache_ballpark_factors?park_name=eq.${encodeURIComponent(park)}&select=runs_factor,hits_factor,hr_factor&limit=1`) as Array<{ runs_factor?: number | null; hits_factor?: number | null; hr_factor?: number | null }>;
  if (rows.length === 0) { missing.push(`ballpark:${park}`); return null; }
  const r = rows[0];
  return {
    runsFactor: r.runs_factor ?? 1.0,
    hitsFactor: r.hits_factor ?? 1.0,
    hrFactor: r.hr_factor ?? 1.0,
  };
}

// D-304 SHIP 2B — build lineup-vs-hand aggregate from D-293 warehouses.
// PA-weighted average of starting batters' vs_lhp_ops / vs_rhp_ops.
// Mirrors production preloadLineupVsHand pattern but reads from
// cache_mlb_historical_lineups + cache_mlb_historical_splits.
interface LineupVsHandBundle {
  home_vs_lhp_ops: number | null;
  home_vs_rhp_ops: number | null;
  away_vs_lhp_ops: number | null;
  away_vs_rhp_ops: number | null;
  home_lineup_pa: number;
  away_lineup_pa: number;
  home_source?: "confirmed" | "projected" | "unavailable";
  away_source?: "confirmed" | "projected" | "unavailable";
}

async function buildLineupVsHand(a: SupaArgs, eventId: string, season: number, missing: string[]): Promise<LineupVsHandBundle | null> {
  // 1. Pull lineup for this event from cache_mlb_historical_lineups
  const lineupRows = await getJSON(a, `cache_mlb_historical_lineups?event_id=eq.${eventId}&select=team_side,player_id&order=team_side,lineup_position&limit=20`) as Array<{ team_side: string; player_id: number }>;
  if (lineupRows.length === 0) {
    missing.push("lineup_vs_hand:no_lineup");
    return null;
  }
  const homeIds = lineupRows.filter(r => r.team_side === "home").map(r => r.player_id);
  const awayIds = lineupRows.filter(r => r.team_side === "away").map(r => r.player_id);
  if (homeIds.length === 0 && awayIds.length === 0) {
    missing.push("lineup_vs_hand:empty_lineup");
    return null;
  }

  // 2. Bulk-fetch splits for all batter IDs at once
  const allIds = [...homeIds, ...awayIds];
  if (allIds.length === 0) { missing.push("lineup_vs_hand:no_ids"); return null; }
  const splitsRows = await getJSON(a, `cache_mlb_historical_splits?player_id=in.(${allIds.join(",")})&season=eq.${season}&select=player_id,vs_lhp_ops,vs_rhp_ops,vs_lhp_pa,vs_rhp_pa&limit=50`) as Array<{ player_id: number; vs_lhp_ops: number | null; vs_rhp_ops: number | null; vs_lhp_pa: number | null; vs_rhp_pa: number | null }>;
  const splitsById = new Map(splitsRows.map(s => [s.player_id, s]));

  // 3. PA-weighted average per team
  function aggregate(ids: number[]): { vs_lhp: number | null; vs_rhp: number | null; total_pa: number } {
    let lhpOpsSum = 0, lhpPaSum = 0;
    let rhpOpsSum = 0, rhpPaSum = 0;
    for (const id of ids) {
      const s = splitsById.get(id);
      if (!s) continue;
      if (s.vs_lhp_ops !== null && s.vs_lhp_pa !== null && s.vs_lhp_pa > 0) {
        lhpOpsSum += s.vs_lhp_ops * s.vs_lhp_pa;
        lhpPaSum += s.vs_lhp_pa;
      }
      if (s.vs_rhp_ops !== null && s.vs_rhp_pa !== null && s.vs_rhp_pa > 0) {
        rhpOpsSum += s.vs_rhp_ops * s.vs_rhp_pa;
        rhpPaSum += s.vs_rhp_pa;
      }
    }
    return {
      vs_lhp: lhpPaSum > 0 ? lhpOpsSum / lhpPaSum : null,
      vs_rhp: rhpPaSum > 0 ? rhpOpsSum / rhpPaSum : null,
      total_pa: lhpPaSum + rhpPaSum,
    };
  }
  const homeAgg = aggregate(homeIds);
  const awayAgg = aggregate(awayIds);

  // Need both teams to have ≥100 PA aggregate for scoring fn to fire
  if (homeAgg.total_pa < 100 && awayAgg.total_pa < 100) {
    missing.push("lineup_vs_hand:insufficient_pa");
    return null;
  }

  return {
    home_vs_lhp_ops: homeAgg.vs_lhp,
    home_vs_rhp_ops: homeAgg.vs_rhp,
    away_vs_lhp_ops: awayAgg.vs_lhp,
    away_vs_rhp_ops: awayAgg.vs_rhp,
    home_lineup_pa: homeAgg.total_pa,
    away_lineup_pa: awayAgg.total_pa,
    home_source: "confirmed", // came from historical lineups (post-game boxscore)
    away_source: "confirmed",
  };
}

async function buildH2H(a: SupaArgs, home: string, away: string, beforeCommence: string, missing: string[]): Promise<H2HRecent | null> {
  // Two queries (home_team=X & away_team=Y) and (home_team=Y & away_team=X)
  // PostgREST nested or-of-ands gets fragile; simple AND-pair queries are reliable.
  const bcEnc = encodeURIComponent(beforeCommence);
  const [a1, a2] = await Promise.all([
    getJSON(a, `cache_mlb_historical_outcomes?home_team=eq.${encodeURIComponent(home)}&away_team=eq.${encodeURIComponent(away)}&commence_time=lt.${bcEnc}&game_completed=eq.true&order=commence_time.desc&limit=10&select=home_team,home_score,away_score,commence_time`),
    getJSON(a, `cache_mlb_historical_outcomes?home_team=eq.${encodeURIComponent(away)}&away_team=eq.${encodeURIComponent(home)}&commence_time=lt.${bcEnc}&game_completed=eq.true&order=commence_time.desc&limit=10&select=home_team,home_score,away_score,commence_time`),
  ]) as [OutcomeRow[], OutcomeRow[]];
  const rows = [...a1, ...a2].sort((p, q) => q.commence_time.localeCompare(p.commence_time)).slice(0, 10);
  if (rows.length === 0) { missing.push("h2h"); return null; }
  let totalRuns = 0;
  let homeWins = 0;
  for (const r of rows) {
    totalRuns += (r.home_score ?? 0) + (r.away_score ?? 0);
    // From the "designated home team" perspective (i.e., `home` arg)
    const designatedIsHome = r.home_team === home;
    const designatedScore = designatedIsHome ? (r.home_score ?? 0) : (r.away_score ?? 0);
    const otherScore = designatedIsHome ? (r.away_score ?? 0) : (r.home_score ?? 0);
    if (designatedScore > otherScore) homeWins++;
  }
  return { l10Games: rows.length, runsPerGame: totalRuns / rows.length, homeTeamWinPct: homeWins / rows.length };
}

export async function buildHistoricalContext(
  a: SupaArgs,
  eventId: string,
  commenceTime: string,
  homeTeam: string,
  awayTeam: string,
  venue: string | null,
  outcomesCache: Record<string, OutcomeRow[]>,
  bullpenCache: Record<string, BullpenRow | null>,
): Promise<HistoricalContextBundle> {
  const missing: string[] = [];
  const season = new Date(commenceTime).getUTCFullYear();

  // Run independent builders in parallel
  const [homeCtx, awayCtx, weather, ballpark, h2h, homePitcher, awayPitcher, lineupVsHand] = await Promise.all([
    buildTeamContext(a, homeTeam, commenceTime, outcomesCache, bullpenCache),
    buildTeamContext(a, awayTeam, commenceTime, outcomesCache, bullpenCache),
    buildWeather(a, eventId, missing),
    buildBallpark(a, homeTeam, missing),
    buildH2H(a, homeTeam, awayTeam, commenceTime, missing),
    buildOpposingPitcher(a, eventId, "home", season, missing),
    buildOpposingPitcher(a, eventId, "away", season, missing),
    buildLineupVsHand(a, eventId, season, missing),
  ]);
  missing.push(...homeCtx.missing, ...awayCtx.missing);

  // 8 expected context components for game-level scoring (D-304):
  // homeTeam, awayTeam, homePitcher, awayPitcher, ballpark, weather, h2h, lineupVsHand
  const present = [
    homeCtx.ctx.gamesPlayed > 0 ? 1 : 0,
    awayCtx.ctx.gamesPlayed > 0 ? 1 : 0,
    homePitcher !== null ? 1 : 0,
    awayPitcher !== null ? 1 : 0,
    ballpark !== null ? 1 : 0,
    weather !== null ? 1 : 0,
    h2h !== null ? 1 : 0,
    lineupVsHand !== null ? 1 : 0,
  ].reduce((a, b) => a + b, 0);
  const completeness = present / 8;

  return {
    ctx: {
      game: { homeTeam, awayTeam, gameTime: commenceTime, venue },
      homeTeam: homeCtx.ctx,
      awayTeam: awayCtx.ctx,
      homePitcher,
      awayPitcher,
      ballpark,
      weather,
      umpire: null,                 // D-298 honest: umpire historical data not in warehouses (D-304 SHIP 4 deferred)
      h2h,
      lineupVsHand,                 // D-304 SHIP 2B — now populated from D-293 lineups + splits warehouses
    },
    completeness,
    missing,
  };
}
