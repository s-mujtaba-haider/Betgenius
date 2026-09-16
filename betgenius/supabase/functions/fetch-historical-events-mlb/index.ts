// D-289 PHASE 2 — historical MLB events backfill.
//
// Iterates UTC dates between body.start_date and body.end_date,
// calls /v4/historical/sports/baseball_mlb/events?date={iso}, upserts
// into cache_mlb_historical_events. Cost: 1 credit per UTC date.
//
// Per Supabase 150s timeout, function is chunkable via body.max_dates
// (default 100). Caller invokes repeatedly with shifted start_date
// until 'all_done': true returned.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { tryAcquireLock, releaseLock } from "../_shared/function_lock.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const BACKFILL_TOKEN = Deno.env.get("BACKFILL_AUTH_TOKEN") ?? "";
const ODDS_KEY = Deno.env.get("ODDS_API_KEY_5M") ?? "";

const corsHeaders = { "Access-Control-Allow-Origin": "*" };
function j(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}
const supaHeaders = () => ({ apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json" });

function isoDateOnly(d: Date): string { return d.toISOString().slice(0, 10); }
function addDays(s: string, n: number): string {
  const d = new Date(s + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n);
  return isoDateOnly(d);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (!SUPABASE_URL || !SUPABASE_KEY) return j({ error: "missing env" }, 500);
  if (!ODDS_KEY) return j({ error: "ODDS_API_KEY_5M not set" }, 500);

  const auth = req.headers.get("authorization") || "";
  const matches = auth.includes(SUPABASE_KEY) || (BACKFILL_TOKEN && auth.includes(BACKFILL_TOKEN));
  if (!matches) return j({ error: "unauthorized" }, 401);

  // D-291 SHIP 1 — mutex
  const LOCK_KEY = "fetch-historical-events-mlb";
  const lock = await tryAcquireLock(LOCK_KEY, 900, `${Date.now()}`);
  if (!lock.acquired) {
    return j({ blocked: true, reason: "concurrent_instance_already_running", lock_state: lock });
  }

  let body: { start_date?: string; end_date?: string; max_dates?: number } = {};
  try { body = await req.json(); } catch { /* defaults */ }
  const startDate = body.start_date ?? "2023-05-03";
  const endDate = body.end_date ?? "2025-10-31";
  const maxDates = Math.min(body.max_dates ?? 100, 300);

  const start = Date.now();
  try {
  let datesProcessed = 0;
  let eventsUpserted = 0;
  let lastCreditsRemaining: string | null = null;
  let lastDate = startDate;
  const errors: string[] = [];

  let cur = startDate;
  while (cur <= endDate && datesProcessed < maxDates) {
    // Stay within 130s function budget (leave 20s for response)
    if (Date.now() - start > 130_000) break;
    try {
      // Query with mid-day UTC timestamp (catches games that day reliably)
      const ts = `${cur}T18:00:00Z`;
      const url = `https://api.the-odds-api.com/v4/historical/sports/baseball_mlb/events?date=${ts}&apiKey=${ODDS_KEY}`;
      const res = await fetch(url);
      lastCreditsRemaining = res.headers.get("x-requests-remaining");
      if (!res.ok) {
        errors.push(`${cur}: HTTP ${res.status}`);
        if (res.status === 429) { await new Promise((r) => setTimeout(r, 2000)); }
      } else {
        const txt = await res.text();
        const parsed = JSON.parse(txt) as { data?: Array<{ id?: string; commence_time?: string; home_team?: string; away_team?: string; sport_key?: string }> };
        const events = parsed.data ?? [];
        const rows = events
          .filter((e) => e.id && e.commence_time && e.home_team && e.away_team)
          .map((e) => ({
            event_id: e.id, sport_key: e.sport_key ?? "baseball_mlb",
            commence_time: e.commence_time, home_team: e.home_team, away_team: e.away_team,
          }));
        if (rows.length > 0) {
          const up = await fetch(`${SUPABASE_URL}/rest/v1/cache_mlb_historical_events?on_conflict=event_id`, {
            method: "POST",
            headers: { ...supaHeaders(), Prefer: "resolution=merge-duplicates,return=minimal" },
            body: JSON.stringify(rows),
          });
          if (up.ok) eventsUpserted += rows.length;
          else errors.push(`${cur}: upsert ${up.status}`);
        }
      }
    } catch (e) {
      errors.push(`${cur}: ${e instanceof Error ? e.message : String(e)}`);
    }
    lastDate = cur;
    datesProcessed++;
    cur = addDays(cur, 1);
    // Light throttle (rate limit is 30 req/sec; we're well under)
    await new Promise((r) => setTimeout(r, 50));
  }

  const allDone = cur > endDate;
  return j({
    success: true,
    start_date: startDate, end_date: endDate,
    dates_processed: datesProcessed,
    events_upserted: eventsUpserted,
    last_date_processed: lastDate,
    next_start_date: allDone ? null : cur,
    all_done: allDone,
    credits_remaining: lastCreditsRemaining,
    errors_sample: errors.slice(0, 10),
    duration_ms: Date.now() - start,
    lock_acquired: true,
  });
  } finally {
    await releaseLock(LOCK_KEY);
  }
});
