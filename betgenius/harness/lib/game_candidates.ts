// Phase 1 — warehouse candidate loader for MLB game markets.
//
// Player-prop odds live in one market_key with over_odds + under_odds.
// Game markets do not:
//   h2h__home / h2h__away     side baked into market_key; price in over_odds
//   spreads__home / spreads__away   same; line is the run line
//   totals                    both over_odds and under_odds (like props)
//
// D-391: spreads candidates are restricted to |line| === 1.5.

import { closePool, type Db } from "./env.ts";
import {
  selectBestSameLineBook,
  type AvailableBook,
} from "../../supabase/functions/_shared/best_price.ts";
import { pickClosingSnapshot } from "./candidates.ts";

export type GameKind = "h2h" | "spreads" | "totals";

export const GAME_WAREHOUSE_KEYS: Record<GameKind, readonly string[]> = {
  h2h: ["h2h__home", "h2h__away"],
  spreads: ["spreads__home", "spreads__away"],
  totals: ["totals"],
};

export interface GameOddsRow {
  event_id: string;
  snapshot_timestamp: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmaker_key: string;
  market_key: string;
  line: number;
  over_odds: number | null;
  under_odds: number | null;
}

export interface GameCandidateGroup {
  eventId: string;
  kind: GameKind;
  line: number;
  commenceTime: string;
  homeTeam: string;
  awayTeam: string;
  entrySnapshotTime: string | null;
  closingSnapshotTime: string | null;
  /** Totals: over. Side markets: home-side price (h2h/spreads __home). */
  entryHomeOrOverOdds: number | null;
  entryHomeOrOverBook: string | null;
  /** Totals: under. Side markets: away-side price (h2h/spreads __away). */
  entryAwayOrUnderOdds: number | null;
  entryAwayOrUnderBook: string | null;
  closingHomeOrOverOdds: number | null;
  closingHomeOrOverBook: string | null;
  closingAwayOrUnderOdds: number | null;
  closingAwayOrUnderBook: string | null;
}

const ENTRY_TARGET_MS_BEFORE_COMMENCE = 60 * 60 * 1000;
const ENTRY_TOLERANCE_MS = 10 * 60 * 1000;
const PAGE_MS = 7 * 24 * 60 * 60 * 1000;
const SPREAD_ABS_LINE = 1.5;

function pickEntrySnapshot(
  snapshotTimes: string[],
  commenceMs: number,
): string | null {
  const targetMs = commenceMs - ENTRY_TARGET_MS_BEFORE_COMMENCE;
  const eligible = snapshotTimes.filter(
    (s) => Date.parse(s) <= targetMs + ENTRY_TOLERANCE_MS,
  );
  if (eligible.length > 0) {
    return eligible.reduce(
      (best, s) => (Date.parse(s) > Date.parse(best) ? s : best),
      eligible[0],
    );
  }
  const beforeGame = snapshotTimes.filter((s) => Date.parse(s) < commenceMs);
  if (beforeGame.length === 0) return null;
  return beforeGame.reduce(
    (best, s) => (Date.parse(s) < Date.parse(best) ? s : best),
    beforeGame[0],
  );
}

function isHomeKey(marketKey: string): boolean {
  return marketKey.endsWith("__home");
}

function isAwayKey(marketKey: string): boolean {
  return marketKey.endsWith("__away");
}

function groupKey(kind: GameKind, r: GameOddsRow): string {
  if (kind === "h2h") return r.event_id;
  if (kind === "totals") return `${r.event_id}|${r.line}`;
  return `${r.event_id}|${Math.abs(r.line)}`;
}

function homeLineForGroup(kind: GameKind, rows: GameOddsRow[]): number {
  if (kind === "h2h") return 0;
  if (kind === "totals") return Number(rows[0].line);
  const homeRow = rows.find((r) => isHomeKey(r.market_key));
  return Number(homeRow ? homeRow.line : rows[0].line);
}

function bestPrice(
  rows: GameOddsRow[],
  snapshotTime: string | null,
  side: "home_or_over" | "away_or_under",
  kind: GameKind,
  groupLine: number,
): { odds: number; bookmaker: string } | null {
  if (!snapshotTime) return null;
  const atSnap = rows.filter((r) => r.snapshot_timestamp === snapshotTime);
  const books: AvailableBook[] = [];
  for (const r of atSnap) {
    if (kind === "totals") {
      const odds = side === "home_or_over" ? r.over_odds : r.under_odds;
      if (odds === null) continue;
      books.push({
        bookmaker: r.bookmaker_key,
        line: r.line,
        odds,
        pick_side: side === "home_or_over" ? "over" : "under",
      });
    } else {
      const wantHome = side === "home_or_over";
      if (wantHome && !isHomeKey(r.market_key)) continue;
      if (!wantHome && !isAwayKey(r.market_key)) continue;
      if (r.over_odds === null) continue;
      books.push({
        bookmaker: r.bookmaker_key,
        line: r.line,
        odds: r.over_odds,
        pick_side: wantHome ? "home" : "away",
      });
    }
  }
  if (books.length === 0) return null;
  const shopLine = kind === "spreads" && side === "away_or_under"
    ? -groupLine
    : groupLine;
  const shopSide = kind === "totals"
    ? (side === "home_or_over" ? "over" : "under")
    : (side === "home_or_over" ? "home" : "away");
  const chosen = selectBestSameLineBook(books, shopLine, shopSide, "", 0);
  if (chosen) return { odds: chosen.odds, bookmaker: chosen.bookmaker };
  const fallback = books.reduce((a, b) => (a.odds >= b.odds ? a : b));
  return { odds: fallback.odds, bookmaker: fallback.bookmaker };
}

/** Pure grouping used by smoke tests and the warehouse loader. */
export function groupsToGameCandidates(
  kind: GameKind,
  rows: GameOddsRow[],
): GameCandidateGroup[] {
  const groups = new Map<string, GameOddsRow[]>();
  for (const r of rows) {
    if (kind === "spreads" && Math.abs(r.line) !== SPREAD_ABS_LINE) continue;
    const k = groupKey(kind, r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(r);
  }

  const out: GameCandidateGroup[] = [];
  for (const groupRows of groups.values()) {
    const first = groupRows[0];
    const line = homeLineForGroup(kind, groupRows);
    const commenceMs = Date.parse(first.commence_time);
    const snapshotTimes = Array.from(
      new Set(groupRows.map((r) => r.snapshot_timestamp)),
    );
    const entrySnap = pickEntrySnapshot(snapshotTimes, commenceMs);
    const closingSnap = pickClosingSnapshot(snapshotTimes, commenceMs, entrySnap);
    const entryHome = bestPrice(groupRows, entrySnap, "home_or_over", kind, line);
    const entryAway = bestPrice(groupRows, entrySnap, "away_or_under", kind, line);
    const closingHome = bestPrice(groupRows, closingSnap, "home_or_over", kind, line);
    const closingAway = bestPrice(groupRows, closingSnap, "away_or_under", kind, line);
    out.push({
      eventId: first.event_id,
      kind,
      line,
      commenceTime: first.commence_time,
      homeTeam: first.home_team,
      awayTeam: first.away_team,
      entrySnapshotTime: entrySnap,
      closingSnapshotTime: closingSnap,
      entryHomeOrOverOdds: entryHome?.odds ?? null,
      entryHomeOrOverBook: entryHome?.bookmaker ?? null,
      entryAwayOrUnderOdds: entryAway?.odds ?? null,
      entryAwayOrUnderBook: entryAway?.bookmaker ?? null,
      closingHomeOrOverOdds: closingHome?.odds ?? null,
      closingHomeOrOverBook: closingHome?.bookmaker ?? null,
      closingAwayOrUnderOdds: closingAway?.odds ?? null,
      closingAwayOrUnderBook: closingAway?.bookmaker ?? null,
    });
  }
  out.sort((a, b) => Date.parse(a.commenceTime) - Date.parse(b.commenceTime));
  return out;
}

export interface GameCoverageWindow {
  minCommenceTime: string | null;
  maxCommenceTime: string | null;
  rowCount: number;
}

export async function detectGameCoverageWindow(
  db: Db,
  kind: GameKind,
): Promise<GameCoverageWindow> {
  const keys = [...GAME_WAREHOUSE_KEYS[kind]];
  const rows = await db.query<{
    min_commence_time: string | null;
    max_commence_time: string | null;
    count: string;
  }>(
    `SELECT MIN(commence_time)::text AS min_commence_time,
            MAX(commence_time)::text AS max_commence_time,
            COUNT(*)::text AS count
     FROM cache_mlb_historical_odds
     WHERE market_key = ANY($1::text[])`,
    [keys],
  );
  const row = rows[0];
  return {
    minCommenceTime: row?.min_commence_time ?? null,
    maxCommenceTime: row?.max_commence_time ?? null,
    rowCount: parseInt(row?.count ?? "0", 10),
  };
}

export interface GameUniverseResult {
  groups: GameCandidateGroup[];
  totalOddsRowsFetched: number;
}

export interface LoadGameOptions {
  maxGroups?: number;
  pageFromEnd?: boolean;
}

async function fetchGameOddsChunk(
  db: Db,
  keys: string[],
  chunkStartIso: string,
  chunkEndIso: string,
): Promise<GameOddsRow[]> {
  return db.query<GameOddsRow>(
    `SELECT event_id, snapshot_timestamp::text AS snapshot_timestamp,
            commence_time::text AS commence_time, home_team, away_team,
            bookmaker_key, market_key, line, over_odds, under_odds
     FROM cache_mlb_historical_odds
     WHERE market_key = ANY($1::text[])
       AND commence_time >= $2::timestamptz
       AND commence_time < $3::timestamptz
     ORDER BY event_id ASC, market_key ASC, line ASC, snapshot_timestamp ASC`,
    [keys, chunkStartIso, chunkEndIso],
  );
}

export async function loadGameCandidateUniverse(
  db: Db,
  kind: GameKind,
  startIso: string,
  endIso: string,
  options: LoadGameOptions = {},
): Promise<GameUniverseResult> {
  const keys = [...GAME_WAREHOUSE_KEYS[kind]];
  const maxGroups = options.maxGroups ?? 0;
  const pageFromEnd = options.pageFromEnd ?? false;
  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  const collected: GameOddsRow[] = [];
  let totalOddsRowsFetched = 0;

  const ingest = async (chunkStartMs: number, chunkEndMs: number) => {
    const rows = await fetchGameOddsChunk(
      db,
      keys,
      new Date(chunkStartMs).toISOString(),
      new Date(chunkEndMs).toISOString(),
    );
    totalOddsRowsFetched += rows.length;
    collected.push(...rows);
    await closePool();
  };

  if (pageFromEnd && maxGroups > 0) {
    let cursorEnd = endMs;
    while (cursorEnd > startMs) {
      const cursorStart = Math.max(startMs, cursorEnd - PAGE_MS);
      await ingest(cursorStart, cursorEnd);
      const soFar = groupsToGameCandidates(kind, collected).length;
      if (soFar >= maxGroups) break;
      cursorEnd = cursorStart;
    }
  } else {
    let cursorStart = startMs;
    while (cursorStart < endMs) {
      const cursorEnd = Math.min(cursorStart + PAGE_MS, endMs);
      await ingest(cursorStart, cursorEnd);
      if (maxGroups > 0 && groupsToGameCandidates(kind, collected).length >= maxGroups) {
        break;
      }
      cursorStart = cursorEnd;
    }
  }

  let groups = groupsToGameCandidates(kind, collected);
  if (maxGroups > 0) groups = groups.slice(0, maxGroups);
  return { groups, totalOddsRowsFetched };
}
