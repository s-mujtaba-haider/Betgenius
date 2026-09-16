import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { writeHeartbeat } from "../_shared/cron_heartbeat.ts";

const ODDS_API_KEY = Deno.env.get("THE_ODDS_API_KEY") || "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const BOOKMAKER_PRIORITY = ["hardrockbet", "draftkings", "fanduel", "betmgm", "bovada", "pointsbet"];

// D-253f dry-run gate: module-scope flag set at top of Deno.serve per-request.
// Deno edge functions are per-invocation so module-scope effectively scopes to
// the current request. Every writer helper below early-returns when true.
let _dryRun = false;

async function logApiUsage(endpoint: string, httpStatus: number, headers: Headers, context: Record<string, unknown> = {}, eventCount: number | null = null): Promise<void> {
  try {
    const used = parseInt(headers.get("x-requests-used") || "0", 10);
    const remaining = parseInt(headers.get("x-requests-remaining") || "0", 10);
    const last = parseInt(headers.get("x-requests-last") || "0", 10);
    if (!SUPABASE_URL || !SUPABASE_KEY) return;
    // D-253f: skip api_usage write in dry-run. Reads still happen above this point.
    if (_dryRun) return;
    await fetch(SUPABASE_URL + "/rest/v1/api_usage", {
      method: "POST",
      headers: { "Content-Type": "application/json", "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY, "Prefer": "return=minimal" },
      body: JSON.stringify({
        function_name: "fetch-odds",
        endpoint, http_status: httpStatus,
        requests_used: isNaN(used) ? null : used,
        requests_remaining: isNaN(remaining) ? null : remaining,
        requests_last: isNaN(last) ? null : last,
        event_count: eventCount, context,
      }),
    });
  } catch (_err) { /* non-fatal */ }
}

// Inline error_log writer for non-fatal failures we want surfaced in the Admin
// errors feed. Matches the shape used by the circuit-breaker block below and
// the logError helper in process-games. Fail-silent so a DB hiccup never breaks
// the cron run.
// D-253f: in dry-run, still log dry_run_internal errors (helpful telemetry).
async function logError(phase: string, errorType: string, errorMessage: string, context: Record<string, unknown> = {}): Promise<void> {
  try {
    if (!SUPABASE_URL || !SUPABASE_KEY) return;
    // D-253f: in dry-run, suppress writes to error_log EXCEPT for our own
    // dry-run-internal telemetry. This way a dry-run remains side-effect-free
    // on the production-error feed but still surfaces helper bugs.
    if (_dryRun && errorType !== "dry_run_internal") return;
    await fetch(SUPABASE_URL + "/rest/v1/error_log", {
      method: "POST",
      headers: { "Content-Type": "application/json", "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY, "Prefer": "return=minimal" },
      body: JSON.stringify({
        function_name: "fetch-odds",
        phase, error_type: errorType, error_message: errorMessage, context,
      }),
    });
  } catch (_err) { /* non-fatal */ }
}

// Circuit breaker: query most recent api_usage row; if requests_remaining is below
// CIRCUIT_BREAKER_THRESHOLD, log to error_log and return false to tell the caller
// to skip the Odds API call. Fails open (returns true) on query errors so that a
// DB hiccup doesn't block production runs.
// D-342 (2026-05-27): threshold raised from 500 to 50000 — production swapped
// from SMALL 100K-tier key to LARGE 5M-tier key. 50000 = 1% of monthly quota.
// See fetch-odds-mlb header comment for full rationale.
const CIRCUIT_BREAKER_THRESHOLD = 50000;
async function checkCircuitBreaker(context: Record<string, unknown> = {}): Promise<boolean> {
  try {
    if (!SUPABASE_URL || !SUPABASE_KEY) return true;
    // Only consider rows from successful (200) responses. 5xx responses from The Odds
    // API have no x-requests-* headers, so logApiUsage stores them with remaining=0 —
    // if we didn't filter, a single 503 would self-brick the breaker on every run.
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
          function_name: "fetch-odds",
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
  // D-253f: reset module-scope dry-run flag each request.
  _dryRun = false;

  try {
    // Determine date
    let dateOffset = 0;
    let dryRun = false;
    try {
      const body = await req.json();
      dateOffset = body.dateOffset ?? 0;
      // D-253f: caller-controlled dry-run gate. When true: run all reads +
      // computations as normal but skip ALL writes to props_cache,
      // cache_game_lines, api_usage, error_log (except dry_run_internal).
      if (body.dry_run === true) dryRun = true;
    } catch { /* no body = today */ }
    _dryRun = dryRun;

    const EDT_OFFSET_MS = 4 * 60 * 60 * 1000;
    const now = new Date(Date.now() - EDT_OFFSET_MS);
    const targetDate = new Date(now);
    targetDate.setDate(targetDate.getDate() + dateOffset);
    const gameDate = targetDate.toISOString().slice(0, 10).replace(/-/g, "");
    console.log("[fetch-odds] Fetching for date=" + gameDate + " (offset=" + dateOffset + ")");

    // Circuit breaker: skip all Odds API calls if remaining credits are too low.
    if (!(await checkCircuitBreaker({ game_date: gameDate, date_offset: dateOffset }))) {
      console.log("[fetch-odds] Circuit breaker tripped — skipping Odds API calls");
      return new Response(JSON.stringify({
        success: true, skipped: true, reason: "circuit_breaker",
        gameDate, events: 0, propsExtracted: 0, propsUpserted: 0,
      }), { headers: { "Content-Type": "application/json" } });
    }

    // Step 1: Fetch events from Odds API
    const eventsUrl = `https://api.the-odds-api.com/v4/sports/basketball_nba/events?apiKey=${ODDS_API_KEY}&dateFormat=iso&commenceTimeFrom=${targetDate.toISOString().slice(0,10)}T04:00:00Z&commenceTimeTo=${new Date(targetDate.getTime() + 24*60*60*1000).toISOString().slice(0,10)}T06:59:00Z`;
    const eventsRes = await fetch(eventsUrl);
    await logApiUsage("events", eventsRes.status, eventsRes.headers, { game_date: gameDate, date_offset: dateOffset });
    if (!eventsRes.ok) {
      return new Response(JSON.stringify({ error: "Odds API events failed: " + eventsRes.status }), { status: 500 });
    }
    const events = await eventsRes.json();
    console.log("[fetch-odds] Found " + events.length + " events");

    // Step 2: Fetch props for each event from ALL bookmakers
    let totalUpserted = 0;
    let totalEvents = 0;
    const rows: any[] = [];

    for (const event of events) {
      try {
        const propsUrl = `https://api.the-odds-api.com/v4/sports/basketball_nba/events/${event.id}/odds?apiKey=${ODDS_API_KEY}&regions=us,us2&markets=player_points,player_rebounds,player_assists,player_threes,player_steals,player_blocks,player_turnovers,player_points_rebounds_assists&oddsFormat=american`;
        const propsRes = await fetch(propsUrl);
        await logApiUsage("event_odds_player_props", propsRes.status, propsRes.headers, { event_id: event.id, home: event.home_team, away: event.away_team });
        if (!propsRes.ok) continue;
        const propsData = await propsRes.json();
        
        // Sort bookmakers by priority
        const bookmakers = (propsData.bookmakers || []).sort((a: any, b: any) => {
          const ai = BOOKMAKER_PRIORITY.indexOf(a.key);
          const bi = BOOKMAKER_PRIORITY.indexOf(b.key);
          return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
        });

        const seenInEvent = new Set<string>();

        for (const bk of bookmakers) {
          for (const mkt of bk.markets || []) {
            const propType = (mkt.key || "").replace("player_", "");
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
              });
            }
          }
        }
        totalEvents++;
      } catch (e) { console.log("[fetch-odds] Error for event " + event.id + ": " + e); }
    }

    console.log("[fetch-odds] Extracted " + rows.length + " props from " + totalEvents + " events");

    // Step 3: Batch upsert to props_cache (chunks of 50)
    // D-253f: in dry-run, count what WOULD be upserted but skip the POST.
    for (let i = 0; i < rows.length; i += 50) {
      const chunk = rows.slice(i, i + 50);
      if (dryRun) {
        totalUpserted += chunk.length;
        continue;
      }
const upsertRes = await fetch(SUPABASE_URL + "/rest/v1/props_cache?on_conflict=game_date,player_name,prop_type,bookmaker,pick_side", {        method: "POST",
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
        console.log("[fetch-odds] Upsert error: " + upsertRes.status + " " + errText);
        await logError("props_cache_upsert", "http_error", "Status " + upsertRes.status + ": " + errText.slice(0, 500), {
          game_date: gameDate,
          chunk_index: i,
          chunk_size: chunk.length,
          sample_event_id: chunk[0]?.event_id ?? null,
        });
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(1);
    // D-137 Tier 2 #6 V0-B (May 13, 2026, CEO §19.3): second dedicated Odds API
    // call for spreads + totals. Writes one row per upcoming event to
    // cache_game_lines for the new score_blowout_risk factor (and future
    // Tier 2 #5 line-movement work). Defensive try/catch: a failure here
    // does NOT block the player-prop write that already succeeded above.
    // Quota impact: ~250 extra calls/month against the 100K quota = ~0.25%.
    let gameLinesEvents = 0;
    let gameLinesWritten = 0;
    try {
      const glUrl = "https://api.the-odds-api.com/v4/sports/basketball_nba/odds"
        + "?apiKey=" + ODDS_API_KEY
        + "&regions=us&markets=spreads,totals&oddsFormat=american";
      const glRes = await fetch(glUrl);
      await logApiUsage("sport_odds_game_lines", glRes.status, glRes.headers, { markets: "spreads,totals" }, null);
      if (glRes.ok) {
        const events = await glRes.json();
        gameLinesEvents = Array.isArray(events) ? events.length : 0;
        const rows: Record<string, unknown>[] = [];
        for (const ev of (Array.isArray(events) ? events : [])) {
          // Match fetch-odds bookmaker-priority pattern: prefer hardrockbet,
          // fall back through BOOKMAKER_PRIORITY in order, then any book.
          const bookmakers = (ev.bookmakers || []).slice().sort((a: any, b: any) => {
            const ai = BOOKMAKER_PRIORITY.indexOf(a.key); const bi = BOOKMAKER_PRIORITY.indexOf(b.key);
            return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
          });
          const chosen = bookmakers[0];
          if (!chosen) continue;
          const spreadsMkt = (chosen.markets || []).find((m: any) => m.key === "spreads");
          const totalsMkt = (chosen.markets || []).find((m: any) => m.key === "totals");
          const homeOutcome = (spreadsMkt?.outcomes || []).find((o: any) => o.name === ev.home_team);
          const homeSpr = typeof homeOutcome?.point === "number" ? homeOutcome.point : null;
          const overOutcome = (totalsMkt?.outcomes || []).find((o: any) => o.name === "Over");
          const totLine = typeof overOutcome?.point === "number" ? overOutcome.point : null;
          const favTeam = homeSpr !== null ? (homeSpr < 0 ? ev.home_team : ev.away_team) : null;
          if (homeSpr === null && totLine === null) continue; // skip useless rows
          rows.push({
            event_id: ev.id,
            game_date: (ev.commence_time || "").slice(0, 10),
            home_team: ev.home_team,
            away_team: ev.away_team,
            spread_line: homeSpr,
            spread_line_t0: homeSpr,  // D-139 Tier 2 #5: trigger preserves OLD.spread_line_t0 on UPDATE — t0 is set once on INSERT, immutable thereafter
            total_line: totLine,
            favored_team: favTeam,
            bookmaker: chosen.key,
          });
        }
        if (rows.length > 0) {
          // D-253f: in dry-run, count what WOULD be written but skip the POST.
          if (dryRun) {
            gameLinesWritten = rows.length;
          } else {
            const writeRes = await fetch(SUPABASE_URL + "/rest/v1/cache_game_lines?on_conflict=event_id", {
              method: "POST",
              headers: {
                "apikey": SUPABASE_KEY,
                "Authorization": "Bearer " + SUPABASE_KEY,
                "Content-Type": "application/json",
                "Prefer": "resolution=merge-duplicates",
              },
              body: JSON.stringify(rows.map(r => ({ ...r, fetched_at: new Date().toISOString() }))),
            });
            if (writeRes.ok) {
              gameLinesWritten = rows.length;
            } else {
              const errText = await writeRes.text().catch(() => "");
              console.log("[fetch-odds] cache_game_lines upsert failed: " + writeRes.status + " " + errText.slice(0, 300));
            }
          }
        }
      } else {
        console.log("[fetch-odds] game-lines API call failed: status=" + glRes.status);
      }
    } catch (err) {
      console.log("[fetch-odds] D-137 game-lines fetch error: " + (err instanceof Error ? err.message : String(err)));
    }
    console.log("[fetch-odds] game-lines: " + gameLinesWritten + " written from " + gameLinesEvents + " events");

    console.log("[fetch-odds] Done: " + totalUpserted + (dryRun ? " props WOULD upsert (dry-run) in " : " props upserted in ") + duration + "s");

    // D-253f: dry-run response shape adds `dry_run: true` + `would_write` counts.
    // sample_pick = first row of props_cache batch so callers can sanity-check shape.
    if (dryRun) {
      return new Response(JSON.stringify({
        dry_run: true,
        gameDate,
        events: totalEvents,
        propsExtracted: rows.length,
        would_write: {
          props_cache: totalUpserted,
          cache_game_lines: gameLinesWritten,
          api_usage: 0,  // suppressed in dry-run
          error_log: 0,  // suppressed (except dry_run_internal) in dry-run
        },
        sample_pick: rows.length > 0 ? rows[0] : null,
        elapsed_ms: Date.now() - startTime,
      }), { headers: { "Content-Type": "application/json" } });
    }

    // D-272-INF-2: heartbeat success.
    await writeHeartbeat({ jobName: "fetch-odds", status: "success", durationMs: Date.now() - startTime });
    return new Response(JSON.stringify({
      success: true,
      gameDate,
      events: totalEvents,
      propsExtracted: rows.length,
      propsUpserted: totalUpserted,
      durationSeconds: parseFloat(duration),
    }), { headers: { "Content-Type": "application/json" } });

  } catch (err) {
    console.log("[fetch-odds] Fatal: " + err);
    // D-272-INF-2: heartbeat error.
    await writeHeartbeat({ jobName: "fetch-odds", status: "error", durationMs: Date.now() - startTime, error: String(err) });
    return new Response(JSON.stringify({ error: String(err) }), { status: 500 });
  }
});
