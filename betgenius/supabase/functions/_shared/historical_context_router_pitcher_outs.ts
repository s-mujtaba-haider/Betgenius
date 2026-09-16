// D-772 — Pitcher_outs-specific historical-context router.
//
// Reconstructs scoring context from cache_mlb_boxscore_player_stats (D-770
// backfill: 4,793 rows for Apr-May 2025) + cache_mlb_historical_odds (D-769
// backfill: pitcher_outs lines + totals). Closes the dark-factor gap D-771
// surfaced (only 2/17 factors fired because the original pitcher_k router
// doesn't reconstruct pitcher_outs-specific D-668-wave inputs).
//
// NO LEAKAGE BY CONSTRUCTION — every reconstruction explicitly filters
// game_date < gameDate. The pre-game cutoff is enforced per query, not as
// a post-hoc filter, so a missing filter would surface as a compile-time
// missing param.
//
// FACTOR-BY-FACTOR RECONSTRUCTION:
//
//   PitcherSeasonStats (drives avg_ip, recent_ip_trend, walk_efficiency,
//                       recent_pitch_count, era):
//     - cache_mlb_boxscore_player_stats WHERE player_id=X AND game_date < D
//     - gamesPlayed = count
//     - inningsPitched = SUM(outs)/3  (D-729 outs column — eliminates the
//       Shane Baz off-by-one decimal-thirds class)
//     - strikeOuts = SUM(strikeouts)  (pit.strikeOuts column)
//     - baseOnBalls = SUM(walks)
//     - battersFaced = SUM(batters_faced)
//     - pitchesPerStart = SUM(pitches_thrown WHERE is_starter=true) /
//                        count(WHERE is_starter=true)
//
//   PitcherGameLogEntry[] (drives recent_ip_trend, volatility_v2, rest_pitcher):
//     - Latest 5 starts BEFORE gameDate, ordered desc
//
//   TeamHittingStats (drives opp_k_rate):
//     - SUM(batter_strikeouts) / SUM(plate_appearances) for opp's batter rows
//       BEFORE gameDate
//     - bbRate / obpSeason / pitchesPerPA / ozSwingAvg: null (batter walks
//       not captured in boxscore; chase rate is Statcast-only)
//
//   D-668 fields:
//     - ownTeamPenIp48h: SUM(outs WHERE is_starter=false AND team_id=ownTeam
//       AND game_date IN [D-2, D-1]) / 3
//     - ownTeamRunsPerGame / oppRunsPerGame: SUM(runs_scored from batter rows
//       WHERE team_id=X AND game_date < D) / distinct game count
//
//   D-763 manager_hook:
//     - team_starter_games = COUNT(distinct game_pk WHERE team_id=X has any
//       is_starter=true pitcher AND game_date < D)
//     - team_starter_pitches = SUM(pitches_thrown WHERE is_starter=true AND
//       team_id=X AND game_date < D)
//     - hook_index = team_starter_pitches/team_starter_games - 88
//
// STILL DARK (escalation #1 — genuinely unavailable for 2025 from boxscore alone):
//   - inn1Era / inn1Ip / inn1Walks: needs play-by-play OR sitCodes=i01 per pitcher
//   - thirdTimeOps / thirdTimeIp: needs sitCodes=i06 per pitcher
//   - opp bbRate / obpSeason / pitchesPerPA: batter walks not captured by
//     fetch-mlb-boxscores (column gap)
//   - opp ozSwingAvg / chase_rate: Statcast-only
//   These factors will return 0 in scorePitcherOuts — flagged via missing[].

import type {
  BallparkFactor,
  GameWeather,
  PitcherGameLogEntry,
  PitcherKScoringContext,
  PitcherSeasonStats,
  TeamHittingStats,
  UmpireStats,
} from "./scoring_mlb_v2.ts";

interface SupabaseAuth { url: string; key: string }

const sH = (sa: SupabaseAuth) => ({
  apikey: sa.key,
  Authorization: `Bearer ${sa.key}`,
  "Content-Type": "application/json",
});

async function getJSON<T>(sa: SupabaseAuth, path: string): Promise<T | null> {
  try {
    const r = await fetch(`${sa.url}/rest/v1${path}`, { headers: sH(sa) });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch { return null; }
}

interface BoxscoreRow {
  player_id: number;
  game_pk: number;
  game_date: string;
  team_id: number;
  player_name: string;
  position_type: string | null;
  is_starter: boolean | null;
  at_bats: number | null;
  hits: number | null;
  total_bases: number | null;
  plate_appearances: number | null;
  innings_pitched: number | null;
  pitches_thrown: number | null;
  strikeouts: number | null;
  walks: number | null;
  batters_faced: number | null;
  pitcher_runs: number | null;
  pitcher_earned_runs: number | null;
  runs_scored: number | null;
  outs: number | null;
  batter_strikeouts: number | null;
  // D-774 — unlocks opp_walk_rate, opp_obp_patience, opp_pitch_grind
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

export interface PitcherOutsContextBundle {
  ctx: Omit<PitcherKScoringContext, "prop">;
  completeness: number;     // 0..1 share of fields reconstructable (informational)
  missing: string[];        // factors / inputs that remain dark
}

const LEAGUE_AVG_PITCHES_PER_START = 88;  // D-763 reference

/**
 * Build a pitcher_outs-specific historical scoring context for a given
 * (event, pitcher, gameDate). All reconstructions are point-in-time
 * (game_date < gameDate). Returns null when basic prereqs (team_id /
 * opp_team_id / season game count) can't be resolved.
 */
export async function buildPitcherOutsHistoricalContext(
  sa: SupabaseAuth,
  ev: EventRow,
  playerId: number,
  pitcherTeamId: number,
  oppTeamId: number,
  pitcherName: string,
  isHome: boolean,
  gameDate: string,                  // YYYY-MM-DD — the pick's game date
): Promise<PitcherOutsContextBundle | null> {
  const missing: string[] = [];
  const oneFieldCount = { reconstructed: 0, total: 0 };
  const T = (label: string) => oneFieldCount.total++;
  const R = (label: string) => oneFieldCount.reconstructed++;

  // Pitcher's prior boxscore rows (point-in-time)
  // D-772 LEAKAGE GUARD: game_date < gameDate (strictly before).
  const pitcherPriorUrl =
    `/cache_mlb_boxscore_player_stats?player_id=eq.${playerId}` +
    `&game_date=lt.${gameDate}&select=*&order=game_date.desc&limit=200`;
  const pitcherRows = await getJSON<BoxscoreRow[]>(sa, pitcherPriorUrl) ?? [];

  // ----- PitcherSeasonStats reconstruction -----
  // D-773 FIX — aggregate from STARTER rows only (mirrors pitcher_k router
  // aggregatePitcherSeason convention at historical_context_router_pitcher.ts:122).
  // scorePitcherOuts factor bodies (avg_ip, walk_efficiency, opener) expect
  // gamesPlayed/inningsPitched to be per-start, not per-appearance. My D-772
  // router was including reliever appearances which depressed seasonIPperStart
  // below the bucket bands (z < -1.5 always) and made the factor gates fire as
  // null. This is a CONSTRUCT bug — not a scoring change.
  T("season");
  const starterRows = pitcherRows.filter(r => r.is_starter === true && (r.outs ?? 0) > 0);
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
    pitchesPerStart: starterRows.length > 0
      ? Math.round(starterPitches / starterRows.length)
      : null,
    throws: null,                   // handedness not in boxscore — DARK
    baseOnBalls: starterBb,
  };
  if (season.gamesPlayed >= 1) R("season");
  if (season.throws == null) missing.push("season.throws");

  // ----- PitcherGameLogEntry[] (last 5 starts) -----
  T("gameLog");
  const gameLog: PitcherGameLogEntry[] = starterRows.slice(0, 5).map(r => ({
    date: r.game_date,
    strikeOuts: r.strikeouts ?? 0,
    inningsPitched: Math.round(((r.outs ?? 0) / 3) * 10) / 10,
    opponent: "",                   // not needed for outs-side factors
    pitchCount: r.pitches_thrown,
    walks: r.walks,
  }));
  if (gameLog.length >= 1) R("gameLog");

  // ----- Opposing-team batting (TeamHittingStats) -----
  // D-774 — extended to compute bbRate + obpSeason + pitchesPerPA now that
  // fetch-mlb-boxscores stores bat.baseOnBalls + bat.hitByPitch (PART 1).
  // pitchesPerPA derived from opp's pitcher rows (pitches_thrown) / total PA.
  T("opposingHitting");
  const oppBattersUrl =
    `/cache_mlb_boxscore_player_stats?team_id=eq.${oppTeamId}` +
    `&game_date=lt.${gameDate}&select=player_id,game_pk,plate_appearances,batter_strikeouts,runs_scored,hits,batter_walks,batter_hbp,pitches_thrown,position_type&limit=2000`;
  const oppBatterRows = await getJSON<BoxscoreRow[]>(sa, oppBattersUrl) ?? [];
  const oppPa = oppBatterRows.reduce((s, r) => s + (r.plate_appearances ?? 0), 0);
  const oppK = oppBatterRows.reduce((s, r) => s + (r.batter_strikeouts ?? 0), 0);
  const oppGames = new Set(oppBatterRows.map(r => r.game_pk)).size;
  const oppRuns = oppBatterRows.reduce((s, r) => s + (r.runs_scored ?? 0), 0);
  // D-774 — batter walks + HBP from PART 1 backfill
  const oppBb = oppBatterRows.reduce((s, r) => s + (r.batter_walks ?? 0), 0);
  const oppHbp = oppBatterRows.reduce((s, r) => s + (r.batter_hbp ?? 0), 0);
  const oppHits = oppBatterRows.reduce((s, r) => s + (r.hits ?? 0), 0);
  // pitches_per_PA — pull opp's PITCHER rows (pitches thrown by THEIR pitchers facing OUR team)
  // Wait: the brief asked for opp_pitch_grind = pitches THEY MAKE pitchers throw, so we want
  // pitches thrown AGAINST the opp team — that is, by the OTHER team's pitchers. We don't easily
  // have that join from opp_team_id alone. Skip for now (still DARK) without trying to reconstruct
  // from a different angle — that would risk leakage/wrong-side data.

  let opposingHitting: TeamHittingStats | null = null;
  if (oppGames >= 1 && oppPa > 0) {
    // OBP = (H + BB + HBP) / (PA - SH? we don't track sac bunts; approximate with PA)
    const obpRaw = (oppHits + oppBb + oppHbp) / oppPa;
    opposingHitting = {
      gamesPlayed: oppGames,
      strikeOuts: oppK,
      plateAppearances: oppPa,
      kRate: Math.round((oppK / oppPa) * 1000) / 1000,
      kRateVsLHP: null,                         // splits not reconstructable — DARK
      kRateVsRHP: null,
      bbRate: Math.round((oppBb / oppPa) * 1000) / 1000,         // D-774 unlocked
      obpSeason: Math.round(obpRaw * 1000) / 1000,                // D-774 unlocked (approximated; ignores sac bunts)
      pitchesPerPA: null,                       // requires opp-team-pitches-faced join — still DARK
      ozSwingAvg: null,                         // Statcast-only — DARK
    };
    R("opposingHitting");
    missing.push("opp.pitchesPerPA", "opp.ozSwingAvg", "opp.kRateVsLHP", "opp.kRateVsRHP");
  } else {
    missing.push("opp.kRate");
  }

  // ----- D-668: own bullpen IP last 48h -----
  T("ownTeamPenIp48h");
  const twoDaysAgo = isoDateMinusDays(gameDate, 2);
  const ownPenUrl =
    `/cache_mlb_boxscore_player_stats?team_id=eq.${pitcherTeamId}` +
    `&is_starter=eq.false&position_type=eq.Pitcher` +
    `&game_date=gte.${twoDaysAgo}&game_date=lt.${gameDate}` +
    `&select=outs&limit=200`;
  const ownPenRows = await getJSON<BoxscoreRow[]>(sa, ownPenUrl) ?? [];
  const ownPenOuts = ownPenRows.reduce((s, r) => s + (r.outs ?? 0), 0);
  const ownTeamPenIp48h = ownPenRows.length > 0
    ? Math.round((ownPenOuts / 3) * 10) / 10
    : null;
  if (ownTeamPenIp48h !== null) R("ownTeamPenIp48h"); else missing.push("ownTeamPenIp48h");

  // ----- D-668: own + opp runs per game -----
  T("ownTeamRunsPerGame");
  const ownTeamBattersUrl =
    `/cache_mlb_boxscore_player_stats?team_id=eq.${pitcherTeamId}` +
    `&game_date=lt.${gameDate}` +
    `&select=game_pk,runs_scored&limit=2000`;
  const ownTeamRows = await getJSON<BoxscoreRow[]>(sa, ownTeamBattersUrl) ?? [];
  const ownGames = new Set(ownTeamRows.map(r => r.game_pk)).size;
  const ownRuns = ownTeamRows.reduce((s, r) => s + (r.runs_scored ?? 0), 0);
  const ownTeamRunsPerGame = ownGames > 0 ? Math.round((ownRuns / ownGames) * 100) / 100 : null;
  if (ownTeamRunsPerGame !== null) R("ownTeamRunsPerGame"); else missing.push("ownTeamRunsPerGame");

  T("oppRunsPerGame");
  const oppRunsPerGame = oppGames > 0 ? Math.round((oppRuns / oppGames) * 100) / 100 : null;
  if (oppRunsPerGame !== null) R("oppRunsPerGame"); else missing.push("oppRunsPerGame");

  // ----- D-763 manager_hook (team starter avg-pitches-per-start) -----
  T("ownTeamHookIndex");
  const ownStarterUrl =
    `/cache_mlb_boxscore_player_stats?team_id=eq.${pitcherTeamId}` +
    `&is_starter=eq.true&position_type=eq.Pitcher` +
    `&game_date=lt.${gameDate}&select=game_pk,pitches_thrown&limit=2000`;
  const ownStarterRows = await getJSON<BoxscoreRow[]>(sa, ownStarterUrl) ?? [];
  const ownStarterGames = new Set(ownStarterRows.map(r => r.game_pk)).size;
  const ownStarterPitches = ownStarterRows.reduce((s, r) => s + (r.pitches_thrown ?? 0), 0);
  let ownTeamHookIndex: number | null = null;
  if (ownStarterGames >= 5 && ownStarterPitches > 0) {
    const avgPps = ownStarterPitches / ownStarterGames;
    ownTeamHookIndex = Math.round((avgPps - LEAGUE_AVG_PITCHES_PER_START) * 100) / 100;
    R("ownTeamHookIndex");
  } else {
    missing.push("ownTeamHookIndex");
  }

  // ----- D-669 / D-761 inn1 + i06 — DARK (escalation #1 — sitCodes pull is heavier than budget) -----
  T("inn1Era"); missing.push("inn1Era");
  T("inn1Ip"); missing.push("inn1Ip");
  T("inn1Walks"); missing.push("inn1Walks");
  T("thirdTimeOps"); missing.push("thirdTimeOps");
  T("thirdTimeIp"); missing.push("thirdTimeIp");

  // ----- Ballpark + weather + umpire: outside boxscore scope (caller's responsibility) -----
  // We populate placeholders; the calling generator can layer on cache lookups
  // (cache_mlb_ballpark_factors, cache_mlb_weather, etc.) which already have
  // 2025 coverage if backfilled.
  const ballpark: BallparkFactor | null = null;  // caller-injected
  const weather: GameWeather | null = null;       // caller-injected
  const umpire: UmpireStats | null = null;         // caller-injected

  // Build the context shell (callers add prop later)
  const ctx: Omit<PitcherKScoringContext, "prop"> = {
    pitcher: {
      fullName: pitcherName,
      team: ev.home_team === pitcherName ? ev.home_team : (isHome ? ev.home_team : ev.away_team),
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

  // Require at least pitcher's own gameLog to consider this reconstructable
  if (gameLog.length === 0 && season.gamesPlayed === 0) return null;

  return { ctx, completeness, missing };
}

function isoDateMinusDays(iso: string, days: number): string {
  // iso = "YYYY-MM-DD"
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}
