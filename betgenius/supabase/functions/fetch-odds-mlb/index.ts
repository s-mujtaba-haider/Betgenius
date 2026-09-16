// fetch-odds-mlb — MLB player props ingest.
// Mirrors fetch-odds (NBA). Scope: writes sport='mlb' to props_cache.
// NOT scheduled on a cron — manual trigger only via Admin's button.
// Cost: ~270 credits per click (9 markets × 2 regions × ~15 events).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { writeHeartbeat } from "../_shared/cron_heartbeat.ts";

const ODDS_API_KEY = Deno.env.get("THE_ODDS_API_KEY") || "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const BOOKMAKER_PRIORITY = ["hardrockbet", "draftkings", "fanduel", "betmgm", "bovada", "pointsbet"];

// D-262 dry-run gate: module-scope flag set at top of Deno.serve per-request.
// Deno edge functions are per-invocation so module-scope effectively scopes to
// the current request. Every writer helper below early-returns when true.
// In dry-run we also SKIP all outbound Odds API calls — the function should
// not burn quota on smoke tests.
let _dryRun = false;

// D-230 Fix 1 — 9 player markets + 3 game-level markets = 12 total.
// Joined with comma for the Odds API URL; cost per event = regions × markets
// = 2 × 12 = 24 credits (up from 18). Acceptable per CEO §14 Q1 budget.
// Game-level markets enable Games tab MLB content (closes D-229 gap).
const MLB_MARKETS = [
  // Player props (D-203):
  "batter_hits",
  "batter_total_bases",
  "batter_strikeouts",
  "batter_home_runs",
  "batter_runs_scored",
  "batter_rbis",
  "pitcher_strikeouts",
  "pitcher_outs",
  "pitcher_record_a_win",
  // Game-level (D-230 Fix 1):
  "h2h",        // moneyline → mlb_market_type='game_side'
  "spreads",    // run line → mlb_market_type='game_side'
  "totals",     // O/U total runs → mlb_market_type='game_total'
].join(",");

async function logApiUsage(endpoint: string, httpStatus: number, headers: Headers | null, context: Record<string, unknown> = {}, eventCount: number | null = null): Promise<void> {
  try {
    const used = parseInt(headers?.get("x-requests-used") || "0", 10);
    const remaining = parseInt(headers?.get("x-requests-remaining") || "0", 10);
    const last = parseInt(headers?.get("x-requests-last") || "0", 10);
    if (!SUPABASE_URL || !SUPABASE_KEY) return;
    // D-262: suppress api_usage write in dry-run.
    if (_dryRun) return;
    await fetch(SUPABASE_URL + "/rest/v1/api_usage", {
      method: "POST",
      headers: { "Content-Type": "application/json", "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY, "Prefer": "return=minimal" },
      body: JSON.stringify({
        function_name: "fetch-odds-mlb",
        endpoint, http_status: httpStatus,
        requests_used: isNaN(used) ? null : used,
        requests_remaining: isNaN(remaining) ? null : remaining,
        requests_last: isNaN(last) ? null : last,
        event_count: eventCount, context,
      }),
    });
  } catch (_err) { /* non-fatal */ }
}

async function logError(phase: string, errorType: string, errorMessage: string, context: Record<string, unknown> = {}): Promise<void> {
  try {
    if (!SUPABASE_URL || !SUPABASE_KEY) return;
    // D-262: suppress error_log write in dry-run (except dry_run_internal).
    if (_dryRun && errorType !== "dry_run_internal") return;
    await fetch(SUPABASE_URL + "/rest/v1/error_log", {
      method: "POST",
      headers: { "Content-Type": "application/json", "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY, "Prefer": "return=minimal" },
      body: JSON.stringify({
        function_name: "fetch-odds-mlb",
        phase, error_type: errorType, error_message: errorMessage, context,
      }),
    });
  } catch (_err) { /* non-fatal */ }
}

// D-342 (2026-05-27): threshold raised from 500 to 50000.
// Pre-D-342 production used the SMALL 100K-tier key (THE_ODDS_API_KEY pointed at
// fb831ff3...); 500 was ~0.5% of monthly quota — sensible safety floor. D-342
// swapped THE_ODDS_API_KEY to the LARGE 5M-tier key (d10f7748...) shared with
// ODDS_API_KEY_5M. 500 is now <0.01% of monthly quota — never trips meaningfully.
// 50000 = 1% of 5M monthly quota. ~4 days of warning at typical burn rate.
const CIRCUIT_BREAKER_THRESHOLD = 50000;
async function checkCircuitBreaker(context: Record<string, unknown> = {}): Promise<boolean> {
  try {
    if (!SUPABASE_URL || !SUPABASE_KEY) return true;
    const res = await fetch(
      SUPABASE_URL + "/rest/v1/api_usage?select=requests_remaining,called_at&http_status=eq.200&order=called_at.desc&limit=1",
      { headers: { "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY } }
    );
    if (!res.ok) return true;
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) return true;
    const remaining = rows[0]?.requests_remaining;
    if (typeof remaining !== "number") return true;
    if (remaining < CIRCUIT_BREAKER_THRESHOLD) {
      await fetch(SUPABASE_URL + "/rest/v1/error_log", {
        method: "POST",
        headers: { "Content-Type": "application/json", "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY, "Prefer": "return=minimal" },
        body: JSON.stringify({
          function_name: "fetch-odds-mlb",
          phase: "circuit_breaker",
          error_type: "circuit_breaker",
          error_message: "Odds API requests_remaining=" + remaining + " below threshold=" + CIRCUIT_BREAKER_THRESHOLD + " — skipping Odds API calls",
          context: { ...context, remaining, threshold: CIRCUIT_BREAKER_THRESHOLD, last_called_at: rows[0]?.called_at ?? null },
        }),
      });
      return false;
    }
    return true;
  } catch (_err) { return true; }
}

Deno.serve(async (req: Request) => {
  const startTime = Date.now();
  // D-262: reset module-scope dry-run flag each request.
  _dryRun = false;

  try {
    // Determine date — same ET-anchored window as fetch-odds.
    let dateOffset = 0;
    let dryRun = false;
    try {
      const body = await req.json();
      dateOffset = body.dateOffset ?? 0;
      // D-262: caller-controlled dry-run gate. In dry-run we SHORT-CIRCUIT
      // before any Odds API call — burning the quota for a smoke test is
      // not acceptable (each invocation is ~270 credits per CEO §14 Q1).
      if (body.dry_run === true) dryRun = true;
    } catch { /* no body = today */ }
    _dryRun = dryRun;

    const EDT_OFFSET_MS = 4 * 60 * 60 * 1000;
    const now = new Date(Date.now() - EDT_OFFSET_MS);
    const targetDate = new Date(now);
    targetDate.setDate(targetDate.getDate() + dateOffset);
    const gameDate = targetDate.toISOString().slice(0, 10).replace(/-/g, "");
    console.log("[fetch-odds-mlb] Fetching for date=" + gameDate + " (offset=" + dateOffset + ")");

    // D-262: dry-run early return. The function's only mutating writes are
    //   - Odds API quota burn (~270 credits/call)
    //   - props_cache UPSERT
    //   - api_usage POST
    //   - error_log POST
    // ALL of which we want to skip. Return the would_write shape with nulls
    // for unknowable counts (we can't predict prop count without burning the
    // Odds API quota — that's the whole point).
    if (dryRun) {
      return new Response(JSON.stringify({
        dry_run: true,
        sport: "mlb",
        gameDate,
        dateOffset,
        would_write: {
          props_cache: null,  // unknown without burning Odds API quota
          api_usage: 0,
          error_log: 0,
        },
        note: "fetch-odds-mlb skipped Odds API + writes entirely (quota burn protection)",
        elapsed_ms: Date.now() - startTime,
      }), { headers: { "Content-Type": "application/json" } });
    }

    if (!(await checkCircuitBreaker({ game_date: gameDate, date_offset: dateOffset }))) {
      console.log("[fetch-odds-mlb] Circuit breaker tripped — skipping Odds API calls");
      return new Response(JSON.stringify({
        success: true, skipped: true, reason: "circuit_breaker", sport: "mlb",
        gameDate, events: 0, propsExtracted: 0, propsUpserted: 0,
      }), { headers: { "Content-Type": "application/json" } });
    }

    // Step 1: Fetch events from Odds API.
    const eventsUrl = `https://api.the-odds-api.com/v4/sports/baseball_mlb/events?apiKey=${ODDS_API_KEY}&dateFormat=iso&commenceTimeFrom=${targetDate.toISOString().slice(0,10)}T04:00:00Z&commenceTimeTo=${new Date(targetDate.getTime() + 24*60*60*1000).toISOString().slice(0,10)}T06:59:00Z`;
    const eventsRes = await fetch(eventsUrl);
    await logApiUsage("events", eventsRes.status, eventsRes.headers, { game_date: gameDate, date_offset: dateOffset });
    if (!eventsRes.ok) {
      return new Response(JSON.stringify({ error: "Odds API events failed: " + eventsRes.status }), { status: 500 });
    }
    const events = await eventsRes.json();
    console.log("[fetch-odds-mlb] Found " + events.length + " events");

    // Step 2: Fetch props for each event from ALL bookmakers.
    let totalUpserted = 0;
    let totalEvents = 0;
    const rows: any[] = [];

    for (const event of events) {
      try {
        const propsUrl = `https://api.the-odds-api.com/v4/sports/baseball_mlb/events/${event.id}/odds?apiKey=${ODDS_API_KEY}&regions=us,us2&markets=${MLB_MARKETS}&oddsFormat=american`;
        const propsRes = await fetch(propsUrl);
        await logApiUsage("event_odds_player_props", propsRes.status, propsRes.headers, { event_id: event.id, home: event.home_team, away: event.away_team });
        if (!propsRes.ok) continue;
        const propsData = await propsRes.json();

        // Sort bookmakers by priority.
        const bookmakers = (propsData.bookmakers || []).sort((a: any, b: any) => {
          const ai = BOOKMAKER_PRIORITY.indexOf(a.key);
          const bi = BOOKMAKER_PRIORITY.indexOf(b.key);
          return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
        });

        const seenInEvent = new Set<string>();

        for (const bk of bookmakers) {
          for (const mkt of bk.markets || []) {
            const mktKey = mkt.key || "";
            // D-214 Fix 1 — strip ONLY "batter_" prefix; KEEP "pitcher_" prefix.
            const propType = mktKey.replace(/^batter_/, "");

            // D-230 Fix 1 — game-level markets (h2h / spreads / totals)
            // have different outcome shapes than player props. Branch handling
            // here, otherwise fall through to player-prop extraction below.
            const isGameLevel = mktKey === "h2h" || mktKey === "spreads" || mktKey === "totals";
            if (isGameLevel) {
              for (const outcome of mkt.outcomes || []) {
                let pickSide: string | null = null;
                let line = 0;
                const nameRaw = (outcome.name || "").toLowerCase();
                if (mktKey === "h2h") {
                  // Moneyline — outcome.name = team name. Map home/away by
                  // comparing to event.home_team / event.away_team.
                  if (outcome.name === event.home_team) pickSide = "home";
                  else if (outcome.name === event.away_team) pickSide = "away";
                  line = 0;  // no line for moneyline
                } else if (mktKey === "spreads") {
                  // Run line — outcome.name = team, outcome.point = spread.
                  if (outcome.name === event.home_team) pickSide = "home";
                  else if (outcome.name === event.away_team) pickSide = "away";
                  line = outcome.point ?? 0;
                } else if (mktKey === "totals") {
                  // O/U total runs — outcome.name = "Over"/"Under".
                  if (nameRaw === "over") pickSide = "over";
                  else if (nameRaw === "under") pickSide = "under";
                  line = outcome.point ?? 0;
                }
                if (pickSide === null) continue;
                // Game-level rows use a synthetic player_name that aligns
                // with process-games-mlb gameHistPayload conventions:
                //   spreads/h2h → "<home> vs <away>"
                //   totals      → "<home> vs <away> (total)"
                // process-games-mlb gameByKey looks up by (home_team, away_team)
                // tuple, so player_name is informational only.
                const playerName = `${event.home_team} vs ${event.away_team}`;
                const dedupKey = `game|${propType}|${bk.key}|${pickSide}|${line}`;
                if (seenInEvent.has(dedupKey)) continue;
                seenInEvent.add(dedupKey);
                rows.push({
                  game_date: gameDate,
                  event_id: event.id,
                  player_name: playerName,
                  prop_type: propType,
                  line,
                  odds: outcome.price,
                  bookmaker: bk.key,
                  pick_side: pickSide,
                  home_team: event.home_team,
                  away_team: event.away_team,
                  game_time: event.commence_time,
                  sport: "mlb",
                });
              }
              continue;  // skip player-prop branch
            }

            // Player props (original path)
            for (const outcome of mkt.outcomes || []) {
              if (outcome.point == null) continue;
              const nameRaw = (outcome.name || "").toLowerCase();
              const pickSide = nameRaw === "over" ? "over" : nameRaw === "under" ? "under" : null;
              if (pickSide == null) continue;
              const playerName = outcome.description || "";
              const dedupKey = `${playerName}|${propType}|${bk.key}|${pickSide}`;
              if (seenInEvent.has(dedupKey)) continue;
              seenInEvent.add(dedupKey);

              rows.push({
                game_date: gameDate,
                event_id: event.id,
                player_name: playerName,
                prop_type: propType,
                line: outcome.point,
                odds: outcome.price,
                bookmaker: bk.key,
                pick_side: pickSide,
                home_team: event.home_team,
                away_team: event.away_team,
                game_time: event.commence_time,
                sport: "mlb",
              });
            }
          }
        }
        totalEvents++;
      } catch (e) { console.log("[fetch-odds-mlb] Error for event " + event.id + ": " + e); }
    }

    console.log("[fetch-odds-mlb] Extracted " + rows.length + " props from " + totalEvents + " events");

    // Step 3: Batch upsert to props_cache. Same on_conflict as fetch-odds —
    // cross-sport name collisions are vanishingly rare (NBA + MLB players
    // rarely share names) and merge-duplicates handles ties safely.
    for (let i = 0; i < rows.length; i += 50) {
      const chunk = rows.slice(i, i + 50);
      const upsertRes = await fetch(SUPABASE_URL + "/rest/v1/props_cache?on_conflict=game_date,player_name,prop_type,bookmaker,pick_side", {
        method: "POST",
        headers: {
          "apikey": SUPABASE_KEY,
          "Authorization": "Bearer " + SUPABASE_KEY,
          "Content-Type": "application/json",
          "Prefer": "resolution=merge-duplicates",
        },
        body: JSON.stringify(chunk.map(r => ({
          ...r,
          last_seen: new Date().toISOString(),
        }))),
      });
      if (upsertRes.ok) {
        totalUpserted += chunk.length;
      } else {
        const errText = await upsertRes.text();
        console.log("[fetch-odds-mlb] Upsert error: " + upsertRes.status + " " + errText);
        await logError("props_cache_upsert", "http_error", "Status " + upsertRes.status + ": " + errText.slice(0, 500), {
          game_date: gameDate,
          chunk_index: i,
          chunk_size: chunk.length,
          sample_event_id: chunk[0]?.event_id ?? null,
        });
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log("[fetch-odds-mlb] Done: " + totalUpserted + " props upserted in " + duration + "s");

    // D-272-INF-2: heartbeat success.
    await writeHeartbeat({ jobName: "fetch-odds-mlb", status: "success", durationMs: Date.now() - startTime });
    return new Response(JSON.stringify({
      success: true,
      sport: "mlb",
      gameDate,
      events: totalEvents,
      propsExtracted: rows.length,
      propsUpserted: totalUpserted,
      durationSeconds: parseFloat(duration),
    }), { headers: { "Content-Type": "application/json" } });

  } catch (err) {
    console.log("[fetch-odds-mlb] Fatal: " + err);
    // D-272-INF-2: heartbeat error.
    await writeHeartbeat({ jobName: "fetch-odds-mlb", status: "error", durationMs: Date.now() - startTime, error: String(err) });
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});
