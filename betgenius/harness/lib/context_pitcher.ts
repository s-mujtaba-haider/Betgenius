// Phase 1 backtest harness — leak-safe point-in-time context for pitcher markets.

import {
  buildPitcherHistoricalContext,
  degToCompass,
  TEAM_TO_PARK,
  type PitcherRouterCaches,
} from "./context_router_pitcher.ts";
import {
  buildPitcherOutsHistoricalContext,
  resolvePitcherTeamIds,
} from "./context_router_pitcher_outs.ts";
import type { Db } from "./env.ts";
import type { PitcherKScoringContext } from "../../supabase/functions/_shared/scoring_mlb_v2.ts";

export function newPitcherRouterCaches(): PitcherRouterCaches {
  return {
    events: new Map(),
    oppPitcher: new Map(),
    weather: new Map(),
    ballpark: new Map(),
    playerMeta: new Map(),
    arsenal: new Map(),
    statcast: new Map(),
  };
}

export interface PitcherContextResult {
  ctx: Omit<PitcherKScoringContext, "prop">;
  completeness: number;
  missing: string[];
  statcastReconstructed: boolean;
}

export async function buildLeakSafePitcherKContext(
  db: Db,
  eventId: string,
  playerId: number,
  caches: PitcherRouterCaches,
): Promise<PitcherContextResult> {
  const bundle = await buildPitcherHistoricalContext(db, eventId, playerId, caches);
  return {
    ctx: bundle.ctx,
    completeness: bundle.completeness,
    missing: bundle.missing,
    statcastReconstructed: bundle.ctx.statcast != null,
  };
}

interface EventRow {
  event_id: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  game_pk: number | null;
}

interface WeatherRow {
  temperature_f: number | null;
  wind_speed_mph: number | null;
  wind_direction_degrees: number | null;
  is_dome: boolean | null;
}

interface BallparkRow {
  park_name: string;
  hits_factor: number | null;
  hr_factor: number | null;
  k_factor: number | null;
  runs_factor: number | null;
}

export async function buildLeakSafePitcherOutsContext(
  db: Db,
  eventId: string,
  playerId: number,
  playerName: string,
  gameDate: string,
  isHome: boolean | null,
  gamePk: number | null,
  caches: PitcherRouterCaches,
): Promise<PitcherContextResult | null> {
  let event: EventRow | undefined = caches.events?.get(eventId);
  if (!event) {
    const rows = await db.query<EventRow>(
      `SELECT event_id, commence_time, home_team, away_team, game_pk
       FROM cache_mlb_historical_events WHERE event_id = $1 LIMIT 1`,
      [eventId],
    );
    if (rows.length === 0) return null;
    event = rows[0];
    caches.events?.set(eventId, event);
  }

  const resolvedGamePk = gamePk ?? event.game_pk;
  if (resolvedGamePk == null) return null;

  const teamIds = await resolvePitcherTeamIds(db, playerId, resolvedGamePk);
  if (!teamIds) return null;

  let homeFlag = isHome;
  if (homeFlag == null) {
    const oppRows = await db.query<{ home_starter_id: number | null; away_starter_id: number | null }>(
      `SELECT home_starter_id, away_starter_id
       FROM cache_mlb_historical_opposing_pitcher WHERE event_id = $1 LIMIT 1`,
      [eventId],
    );
    const opp = oppRows[0];
    if (opp?.home_starter_id === playerId) homeFlag = true;
    else if (opp?.away_starter_id === playerId) homeFlag = false;
    else homeFlag = false;
  }

  const bundle = await buildPitcherOutsHistoricalContext(
    db,
    event,
    playerId,
    teamIds.pitcherTeamId,
    teamIds.oppTeamId,
    playerName,
    homeFlag,
    gameDate,
  );
  if (!bundle) return null;

  if (!caches.ballpark || caches.ballpark.size === 0) {
    const rows = await db.query<BallparkRow>(
      `SELECT park_name, hits_factor, hr_factor, k_factor, runs_factor FROM cache_ballpark_factors`,
    );
    caches.ballpark = caches.ballpark ?? new Map();
    for (const r of rows) caches.ballpark.set(r.park_name, r);
  }
  const parkName = TEAM_TO_PARK[event.home_team];
  const parkRow = parkName ? caches.ballpark!.get(parkName) : undefined;
  if (parkRow) {
    bundle.ctx.ballpark = {
      runsFactor: Number(parkRow.runs_factor ?? 1.0),
      hrFactor: Number(parkRow.hr_factor ?? 1.0),
      kFactor: Number(parkRow.k_factor ?? 1.0),
      hitsFactor: Number(parkRow.hits_factor ?? 1.0),
    };
  }

  let weatherRow = caches.weather?.get(eventId);
  if (!weatherRow) {
    const rows = await db.query<WeatherRow & { event_id: string }>(
      `SELECT event_id, temperature_f, wind_speed_mph, wind_direction_degrees, is_dome
       FROM cache_mlb_historical_weather WHERE event_id = $1 LIMIT 1`,
      [eventId],
    );
    if (rows.length > 0) {
      weatherRow = rows[0];
      caches.weather?.set(eventId, weatherRow);
    }
  }
  if (weatherRow) {
    bundle.ctx.weather = {
      tempF: weatherRow.temperature_f,
      windSpeed: weatherRow.wind_speed_mph,
      windDir: degToCompass(weatherRow.wind_direction_degrees),
      windDirDeg: weatherRow.wind_direction_degrees,
      condition: weatherRow.is_dome ? "Dome" : null,
    };
  }

  return {
    ctx: bundle.ctx,
    completeness: bundle.completeness,
    missing: bundle.missing,
    statcastReconstructed: false,
  };
}
