// Phase 1 backtest harness — candidate universe from the historical odds
// warehouse (cache_mlb_historical_odds).
//
// This is the FULL candidate universe (every player/line the market priced
// for this market that night), not just picks SharpAI would have "shown" —
// tier filtering happens later, in metrics.ts, on top of every scored
// candidate.

import { chunk, closePool, type Db } from "./env.ts";
import {
  selectBestSameLineBook,
  type AvailableBook,
} from "../../supabase/functions/_shared/best_price.ts";

export interface OddsRow {
  event_id: string;
  snapshot_timestamp: string;
  commence_time: string;
  home_team: string;
  away_team: string;
  bookmaker_key: string;
  player_name: string;
  line: number;
  over_odds: number | null;
  under_odds: number | null;
}

export interface CoverageWindow {
  minCommenceTime: string | null;
  maxCommenceTime: string | null;
  rowCount: number;
}

/** Auto-detects the backfilled coverage window for a market_key instead of
 *  requiring a hardcoded date range. */
export async function detectCoverageWindow(
  db: Db,
  marketKey: string,
): Promise<CoverageWindow> {
  const rows = await db.query<{
    min_commence_time: string | null;
    max_commence_time: string | null;
    count: string;
  }>(
    `SELECT MIN(commence_time)::text AS min_commence_time,
            MAX(commence_time)::text AS max_commence_time,
            COUNT(*)::text AS count
     FROM cache_mlb_historical_odds
     WHERE market_key = $1`,
    [marketKey],
  );
  const row = rows[0];
  return {
    minCommenceTime: row?.min_commence_time ?? null,
    maxCommenceTime: row?.max_commence_time ?? null,
    rowCount: parseInt(row?.count ?? "0", 10),
  };
}

export interface CandidateGroup {
  eventId: string;
  playerName: string;
  line: number;
  commenceTime: string;
  homeTeam: string;
  awayTeam: string;
  entrySnapshotTime: string | null;
  entryOverOdds: number | null;
  entryOverBook: string | null;
  entryUnderOdds: number | null;
  entryUnderBook: string | null;
  closingSnapshotTime: string | null;
  closingOverOdds: number | null;
  closingOverBook: string | null;
  closingUnderOdds: number | null;
  closingUnderBook: string | null;
}

const ENTRY_TARGET_MS_BEFORE_COMMENCE = 60 * 60 * 1000; // T-1h — what you could actually still bet
const ENTRY_TOLERANCE_MS = 10 * 60 * 1000; // snapshots are taken at ~T-6h/T-1h/T-15min, not exact minute marks
const CLOSING_TARGET_MS_BEFORE_COMMENCE = 15 * 60 * 1000; // T-15min — pre-game close proxy
const CLOSING_TOLERANCE_MS = 10 * 60 * 1000;

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

/** Pick closing snapshot distinct from entry when possible. Prefers T-15min
 *  bucket; falls back to latest pre-game snapshot strictly after entry. */
export function pickClosingSnapshot(
  snapshotTimes: string[],
  commenceMs: number,
  entrySnapshotTime: string | null = null,
): string | null {
  const beforeGame = snapshotTimes.filter((s) => Date.parse(s) < commenceMs);
  if (beforeGame.length === 0) return null;

  const entryMs = entrySnapshotTime ? Date.parse(entrySnapshotTime) : -Infinity;
  const closingTargetMs = commenceMs - CLOSING_TARGET_MS_BEFORE_COMMENCE;

  const t15Eligible = beforeGame.filter((s) => {
    const ms = Date.parse(s);
    return ms >= closingTargetMs - CLOSING_TOLERANCE_MS &&
      ms <= closingTargetMs + CLOSING_TOLERANCE_MS &&
      ms !== entryMs;
  });
  if (t15Eligible.length > 0) {
    return t15Eligible.reduce(
      (best, s) =>
        Math.abs(Date.parse(s) - closingTargetMs) <
          Math.abs(Date.parse(best) - closingTargetMs)
          ? s
          : best,
      t15Eligible[0],
    );
  }

  const afterEntry = beforeGame.filter((s) => Date.parse(s) > entryMs);
  if (afterEntry.length > 0) {
    return afterEntry.reduce(
      (best, s) => (Date.parse(s) > Date.parse(best) ? s : best),
      afterEntry[0],
    );
  }

  const distinctFromEntry = beforeGame.filter((s) => Date.parse(s) !== entryMs);
  if (distinctFromEntry.length > 0) {
    return distinctFromEntry.reduce(
      (best, s) => (Date.parse(s) > Date.parse(best) ? s : best),
      distinctFromEntry[0],
    );
  }

  return beforeGame.reduce(
    (best, s) => (Date.parse(s) > Date.parse(best) ? s : best),
    beforeGame[0],
  );
}

function bestPriceAtSnapshot(
  rows: OddsRow[],
  snapshotTime: string | null,
  line: number,
  side: "over" | "under",
): { odds: number; bookmaker: string } | null {
  if (!snapshotTime) return null;
  const atSnapshot = rows.filter((r) => r.snapshot_timestamp === snapshotTime);
  const books: AvailableBook[] = atSnapshot
    .filter((r) => (side === "over" ? r.over_odds : r.under_odds) !== null)
    .map((r) => ({
      bookmaker: r.bookmaker_key,
      line: r.line,
      odds: (side === "over" ? r.over_odds : r.under_odds) as number,
      pick_side: side,
    }));
  const chosen = selectBestSameLineBook(books, line, side, "", 0);
  if (!chosen) return null;
  return { odds: chosen.odds, bookmaker: chosen.bookmaker };
}

export interface CandidateUniverseResult {
  groups: CandidateGroup[];
  totalOddsRowsFetched: number;
}

export interface LoadCandidateOptions {
  /** Stop once this many (event, player, line) groups are collected. */
  maxGroups?: number;
  /** When true with maxGroups, scan from endIso backwards (for --limit smoke runs). */
  pageFromEnd?: boolean;
  /** Log progress every N odds rows fetched. */
  logEveryRows?: number;
}

const PAGE_MS = 7 * 24 * 60 * 60 * 1000;

async function fetchOddsChunk(
  db: Db,
  marketKey: string,
  chunkStartIso: string,
  chunkEndIso: string,
): Promise<OddsRow[]> {
  return db.query<OddsRow>(
    `SELECT event_id, snapshot_timestamp::text AS snapshot_timestamp,
            commence_time::text AS commence_time, home_team, away_team,
            bookmaker_key, player_name, line, over_odds, under_odds
     FROM cache_mlb_historical_odds
     WHERE market_key = $1
       AND commence_time >= $2::timestamptz
       AND commence_time < $3::timestamptz
     ORDER BY event_id ASC, player_name ASC, line ASC, snapshot_timestamp ASC`,
    [marketKey, chunkStartIso, chunkEndIso],
  );
}

function mergeOddsRows(groups: Map<string, OddsRow[]>, rows: OddsRow[]): void {
  for (const r of rows) {
    const key = `${r.event_id}|${r.player_name}|${r.line}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(r);
  }
}

function groupsToCandidates(groups: Map<string, OddsRow[]>): CandidateGroup[] {
  const out: CandidateGroup[] = [];
  for (const [, groupRows] of groups) {
    const first = groupRows[0];
    const commenceMs = Date.parse(first.commence_time);
    const snapshotTimes = Array.from(
      new Set(groupRows.map((r) => r.snapshot_timestamp)),
    );
    const entrySnap = pickEntrySnapshot(snapshotTimes, commenceMs);
    const closingSnap = pickClosingSnapshot(snapshotTimes, commenceMs, entrySnap);

    const entryOver = bestPriceAtSnapshot(groupRows, entrySnap, first.line, "over");
    const entryUnder = bestPriceAtSnapshot(groupRows, entrySnap, first.line, "under");
    const closingOver = bestPriceAtSnapshot(groupRows, closingSnap, first.line, "over");
    const closingUnder = bestPriceAtSnapshot(groupRows, closingSnap, first.line, "under");

    out.push({
      eventId: first.event_id,
      playerName: first.player_name,
      line: first.line,
      commenceTime: first.commence_time,
      homeTeam: first.home_team,
      awayTeam: first.away_team,
      entrySnapshotTime: entrySnap,
      entryOverOdds: entryOver?.odds ?? null,
      entryOverBook: entryOver?.bookmaker ?? null,
      entryUnderOdds: entryUnder?.odds ?? null,
      entryUnderBook: entryUnder?.bookmaker ?? null,
      closingSnapshotTime: closingSnap,
      closingOverOdds: closingOver?.odds ?? null,
      closingOverBook: closingOver?.bookmaker ?? null,
      closingUnderOdds: closingUnder?.odds ?? null,
      closingUnderBook: closingUnder?.bookmaker ?? null,
    });
  }
  return out;
}

/** Loads the candidate universe for [startIso, endIso) in weekly pages to avoid
 *  pulling millions of odds rows into memory at once. */
export async function loadCandidateUniverse(
  db: Db,
  marketKey: string,
  startIso: string,
  endIso: string,
  options: LoadCandidateOptions = {},
): Promise<CandidateUniverseResult> {
  const maxGroups = options.maxGroups ?? 0;
  const pageFromEnd = options.pageFromEnd ?? false;
  const logEveryRows = options.logEveryRows ?? 500_000;

  const startMs = Date.parse(startIso);
  const endMs = Date.parse(endIso);
  const groups = new Map<string, OddsRow[]>();
  let totalOddsRowsFetched = 0;
  let lastLoggedAt = 0;

  const ingestChunk = async (chunkStartMs: number, chunkEndMs: number) => {
    const rows = await fetchOddsChunk(
      db,
      marketKey,
      new Date(chunkStartMs).toISOString(),
      new Date(chunkEndMs).toISOString(),
    );
    totalOddsRowsFetched += rows.length;
    mergeOddsRows(groups, rows);
    if (totalOddsRowsFetched - lastLoggedAt >= logEveryRows) {
      console.log(
        `[harness]   ...${totalOddsRowsFetched} odds rows loaded, ${groups.size} candidate groups`,
      );
      lastLoggedAt = totalOddsRowsFetched;
    }
    // Recycle the TLS session after each weekly page. Supabase's pooler
    // drops long-lived Deno/rustls connections without close_notify.
    await closePool();
  };

  if (pageFromEnd && maxGroups > 0) {
    let cursorEnd = endMs;
    while (cursorEnd > startMs && groups.size < maxGroups) {
      const cursorStart = Math.max(startMs, cursorEnd - PAGE_MS);
      await ingestChunk(cursorStart, cursorEnd);
      cursorEnd = cursorStart;
    }
  } else {
    let cursorStart = startMs;
    while (cursorStart < endMs) {
      const cursorEnd = Math.min(cursorStart + PAGE_MS, endMs);
      await ingestChunk(cursorStart, cursorEnd);
      if (maxGroups > 0 && groups.size >= maxGroups) break;
      cursorStart = cursorEnd;
    }
  }

  const candidateGroups = groupsToCandidates(groups);
  candidateGroups.sort((a, b) => {
    const t = Date.parse(a.commenceTime) - Date.parse(b.commenceTime);
    if (t !== 0) return t;
    const p = a.playerName.localeCompare(b.playerName);
    if (p !== 0) return p;
    return a.line - b.line;
  });

  return { groups: candidateGroups, totalOddsRowsFetched };
}

// ---------------------------------------------------------------------------
// Player-name -> player_id resolution. cache_mlb_historical_odds only has
// player_name (the Odds API's format); the scorer/router need player_id.
// ---------------------------------------------------------------------------
export interface PlayerNameIndex {
  primary: Map<string, number>; // from cache_mlb_player_metadata (authoritative)
  fallback: Map<string, number>; // from cache_mlb_boxscore_player_stats (most-frequent id per name)
}

export async function buildPlayerNameIndex(
  db: Db,
  startDate: string,
  endDate: string,
): Promise<PlayerNameIndex> {
  const metaRows = await db.query<{
    player_id: number;
    full_name: string | null;
  }>(`SELECT player_id, full_name FROM cache_mlb_player_metadata`);
  const primary = new Map<string, number>();
  for (const m of metaRows)
    if (m.full_name) primary.set(m.full_name.trim(), m.player_id);

  const boxRows = await db.query<{
    player_id: number;
    player_name: string | null;
  }>(
    `SELECT player_id, player_name FROM cache_mlb_boxscore_player_stats
     WHERE game_date >= $1::date AND game_date <= $2::date`,
    [startDate, endDate],
  );
  const freq = new Map<string, Map<number, number>>();
  for (const r of boxRows) {
    if (!r.player_name) continue;
    const name = r.player_name.trim();
    if (!freq.has(name)) freq.set(name, new Map());
    const inner = freq.get(name)!;
    inner.set(r.player_id, (inner.get(r.player_id) ?? 0) + 1);
  }
  const fallback = new Map<string, number>();
  for (const [name, inner] of freq) {
    let bestId = -1;
    let bestCount = -1;
    for (const [id, c] of inner) {
      if (c > bestCount) {
        bestCount = c;
        bestId = id;
      }
    }
    if (bestId >= 0) fallback.set(name, bestId);
  }
  return { primary, fallback };
}

export function resolvePlayerId(
  name: string,
  index: PlayerNameIndex,
): number | null {
  const trimmed = name.trim();
  return index.primary.get(trimmed) ?? index.fallback.get(trimmed) ?? null;
}

// ---------------------------------------------------------------------------
// event_id -> game_pk (needed to join cache_mlb_boxscore_player_stats for
// grading — that table is keyed by (player_id, game_pk), not event_id).
// ---------------------------------------------------------------------------
export async function buildEventGamePkIndex(
  db: Db,
  eventIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const batch of chunk(Array.from(new Set(eventIds)), 200)) {
    const rows = await db.query<{ event_id: string; game_pk: number | null }>(
      `SELECT event_id, game_pk FROM cache_mlb_historical_events
       WHERE event_id = ANY($1::text[])`,
      [batch],
    );
    for (const r of rows)
      if (r.game_pk !== null) out.set(r.event_id, r.game_pk);
  }
  return out;
}
