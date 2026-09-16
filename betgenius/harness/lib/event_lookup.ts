// Phase 1 backtest harness — resolve pick_history rows to historical event_id.

import type { Db } from "./env.ts";

export interface ResolvedEvent {
  eventId: string;
  commenceTime: string;
  homeTeam: string;
  awayTeam: string;
  gamePk: number | null;
}

interface EventRow {
  event_id: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  game_pk: number | null;
}

function normalizeTeamName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Build lookup key for (game_date, team, opponent, is_home). */
export function eventLookupKey(
  gameDate: string,
  team: string,
  opponent: string,
  isHome: boolean | null,
): string {
  return `${gameDate}|${normalizeTeamName(team)}|${normalizeTeamName(opponent)}|${isHome ?? "?"}`;
}

function matchEvent(
  row: EventRow,
  team: string,
  opponent: string,
  isHome: boolean | null,
): boolean {
  const home = normalizeTeamName(row.home_team);
  const away = normalizeTeamName(row.away_team);
  const t = normalizeTeamName(team);
  const o = normalizeTeamName(opponent);

  if (isHome === true) return home === t && away === o;
  if (isHome === false) return away === t && home === o;
  return (home === t && away === o) || (away === t && home === o);
}

export async function buildEventLookupIndex(
  db: Db,
  lookups: Array<{ gameDate: string; team: string; opponent: string; isHome: boolean | null }>,
): Promise<Map<string, ResolvedEvent>> {
  const out = new Map<string, ResolvedEvent>();
  if (lookups.length === 0) return out;

  const dates = Array.from(new Set(lookups.map((l) => l.gameDate)));
  const eventsByDate = new Map<string, EventRow[]>();

  for (const date of dates) {
    const rows = await db.query<EventRow>(
      `SELECT event_id, commence_time::text AS commence_time, home_team, away_team, game_pk
       FROM cache_mlb_historical_events
       WHERE commence_time >= $1::date
         AND commence_time < ($1::date + interval '1 day')`,
      [date],
    );
    eventsByDate.set(date, rows);
  }

  for (const l of lookups) {
    const key = eventLookupKey(l.gameDate, l.team, l.opponent, l.isHome);
    if (out.has(key)) continue;
    const candidates = eventsByDate.get(l.gameDate) ?? [];
    const match = candidates.find((e) => matchEvent(e, l.team, l.opponent, l.isHome));
    if (match) {
      out.set(key, {
        eventId: match.event_id,
        commenceTime: match.commence_time,
        homeTeam: match.home_team,
        awayTeam: match.away_team,
        gamePk: match.game_pk,
      });
    }
  }

  return out;
}
