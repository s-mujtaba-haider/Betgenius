// D-634 SHIP 3 — Source-agnostic odds-snapshot writer.
// ─────────────────────────────────────────────────────────────────────
// Reads via OddsSourceAdapter (the abstraction layer); writes to
// cache_odds_snapshots. Delta-only persistence. Variance check on
// every run (D-585 — confirm real distribution, not a flatline).
//
// Cron schedule (set by 20260620901000_d634_cron.sql):
//   `*/30 17-23,0-4 * * *` — every 30 min during MLB active window
//   (mirrors fetch-odds-mlb-30min so we snapshot fresh data).
//
// Provider swap: set Deno.env ODDS_SOURCE to a registered adapter name
// (e.g. "oddsjam"). See docs/loop/reports/d634_source_abstraction.md
// "Swap procedure".

import { getOddsSourceAdapter, type OddsSnapshot } from "../_shared/odds_source.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(d: unknown, s = 200) {
  return new Response(JSON.stringify(d, null, 2), {
    status: s,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const SUPA_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPA_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const BACKFILL = Deno.env.get("BACKFILL_AUTH_TOKEN") || "";

function todayYmdEt(): string {
  // ET-anchored YYYY-MM-DD; the adapter's game_date contract requires ET.
  return new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

interface PriorRow {
  line: number;
  odds: number;
}

async function fetchPriorMap(sport: string, gameDate: string):
  Promise<Map<string, PriorRow>> {
  // Fetch the most recent prior snapshot per
  // (sport, event_id, market, player_name, prop_type, pick_side, bookmaker).
  // Used to delta-check before insert. SELECT DISTINCT ON via PostgREST
  // by ordering snapshot_time DESC and a Range cap; we then dedup
  // client-side because PostgREST doesn't expose DISTINCT ON.
  const out = new Map<string, PriorRow>();
  const url = `${SUPA_URL}/rest/v1/cache_odds_snapshots?sport=eq.${sport}` +
    `&game_date=eq.${encodeURIComponent(gameDate)}` +
    `&select=event_id,market,player_name,prop_type,pick_side,bookmaker,line,odds,snapshot_time` +
    `&order=snapshot_time.desc`;
  let pStart = 0;
  const PAGE = 10000;
  for (let i = 0; i < 5; i++) {
    const r = await fetch(url, {
      headers: {
        apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`,
        Range: `${pStart}-${pStart + PAGE - 1}`, "Range-Unit": "items",
      },
    });
    if (!r.ok) break;
    const rows = await r.json() as Array<{
      event_id: string; market: string; player_name: string; prop_type: string;
      pick_side: string; bookmaker: string; line: number; odds: number;
      snapshot_time: string;
    }>;
    for (const row of rows) {
      const k = `${row.event_id}|${row.market}|${row.player_name}|${row.prop_type}|${row.pick_side}|${row.bookmaker}`;
      // First occurrence wins since ordered by snapshot_time DESC.
      if (!out.has(k)) {
        out.set(k, { line: Number(row.line), odds: Number(row.odds) });
      }
    }
    if (rows.length < PAGE) break;
    pStart += PAGE;
  }
  return out;
}

// D-585 — variance check. Confirm the writer produces a REAL distribution,
// not a flatline (which would indicate the adapter is returning a single
// repeated row or the upstream is stuck). The check is non-blocking;
// only emits a warning log.
function varianceCheck(snaps: OddsSnapshot[]): { distinct_lines: number; distinct_odds: number; distinct_players: number; warn: string | null } {
  const lines = new Set<number>();
  const odds = new Set<number>();
  const players = new Set<string>();
  for (const s of snaps) {
    lines.add(s.line);
    odds.add(s.odds);
    players.add(s.player_name);
  }
  let warn: string | null = null;
  // Flatline detection: <5 distinct lines OR <10 distinct odds across
  // >1000 rows is suspicious (the MLB slate normally has 100s of
  // distinct lines + 50+ distinct odds values per snapshot).
  if (snaps.length > 1000 && (lines.size < 5 || odds.size < 10)) {
    warn = `flatline-suspect: ${snaps.length} rows but only ${lines.size} distinct lines, ${odds.size} distinct odds`;
  }
  return { distinct_lines: lines.size, distinct_odds: odds.size, distinct_players: players.size, warn };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  // Auth — service_role OR BACKFILL_AUTH_TOKEN.
  const auth = req.headers.get("Authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!bearer || (bearer !== BACKFILL && bearer !== SUPA_KEY)) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  const t0 = Date.now();

  // Optional override via body.sport / body.game_date for backfills.
  let bodyJson: { sport?: string; game_date?: string } = {};
  try {
    const text = await req.text();
    if (text) bodyJson = JSON.parse(text);
  } catch { /* ignore */ }
  const sport = bodyJson.sport || "mlb";
  const gameDate = bodyJson.game_date || todayYmdEt();

  // Resolve the active adapter via the swap-config factory.
  const adapter = getOddsSourceAdapter();

  // Pull current snapshot via the source interface.
  let current: OddsSnapshot[] = [];
  try {
    current = await adapter.fetchCurrentSnapshots({ sport, gameDate });
  } catch (e) {
    return jsonResponse({
      success: false,
      adapter: adapter.name,
      error: `adapter.fetchCurrentSnapshots threw: ${e instanceof Error ? e.message : String(e)}`,
      sport, game_date: gameDate, elapsed_ms: Date.now() - t0,
    }, 500);
  }

  if (current.length === 0) {
    return jsonResponse({
      success: true, adapter: adapter.name, sport, game_date: gameDate,
      message: "no current rows from adapter; nothing to snapshot",
      elapsed_ms: Date.now() - t0,
    });
  }

  // Variance check on the adapter's output (D-585 anti-flatline).
  const variance = varianceCheck(current);

  // Pull prior snapshots so we can delta-check.
  const prior = await fetchPriorMap(sport, gameDate);

  // Delta-only: include only rows where (line, odds) differ from the
  // most recent prior snapshot for the same (event, market, player,
  // prop_type, side, book). New combos (no prior) are always included.
  const toInsert: OddsSnapshot[] = [];
  for (const s of current) {
    const k = `${s.event_id}|${s.market}|${s.player_name}|${s.prop_type}|${s.pick_side}|${s.bookmaker}`;
    const p = prior.get(k);
    if (!p) { toInsert.push(s); continue; }
    if (p.line !== s.line || p.odds !== s.odds) toInsert.push(s);
  }

  if (toInsert.length === 0) {
    return jsonResponse({
      success: true, adapter: adapter.name, sport, game_date: gameDate,
      current_rows: current.length, prior_rows: prior.size,
      inserted: 0, message: "no deltas vs prior snapshot",
      variance, elapsed_ms: Date.now() - t0,
    });
  }

  // Bulk upsert. The PK includes snapshot_time so each call writes
  // distinct rows; on_conflict isn't strictly needed but is set for
  // safety against accidental same-second double-fires.
  const snapshotTime = new Date().toISOString();
  const rows = toInsert.map((s) => ({
    sport: s.sport,
    event_id: s.event_id,
    game_date: s.game_date,
    game_time: s.game_time,
    home_team: s.home_team,
    away_team: s.away_team,
    market: s.market,
    prop_type: s.prop_type,
    player_name: s.player_name,
    pick_side: s.pick_side,
    line: s.line,
    odds: s.odds,
    bookmaker: s.bookmaker,
    snapshot_time: snapshotTime,
    source_name: adapter.name,
  }));

  // Chunk inserts at 5000 rows.
  let inserted = 0;
  const errors: string[] = [];
  for (let i = 0; i < rows.length; i += 5000) {
    const slice = rows.slice(i, i + 5000);
    const res = await fetch(
      `${SUPA_URL}/rest/v1/cache_odds_snapshots?on_conflict=sport,event_id,market,player_name,prop_type,pick_side,bookmaker,snapshot_time`,
      {
        method: "POST",
        headers: {
          apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`,
          "Content-Type": "application/json",
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify(slice),
      },
    );
    if (res.ok) {
      inserted += slice.length;
    } else {
      const errBody = (await res.text()).slice(0, 200);
      if (errors.length < 3) errors.push(`HTTP ${res.status}: ${errBody}`);
    }
  }

  return jsonResponse({
    success: errors.length === 0,
    adapter: adapter.name,
    sport, game_date: gameDate,
    snapshot_time: snapshotTime,
    current_rows: current.length,
    prior_rows: prior.size,
    inserted,
    deltas: toInsert.length,
    new_combos: toInsert.length - (toInsert.length - (current.length - prior.size)),
    errors,
    variance,
    elapsed_ms: Date.now() - t0,
  });
});
