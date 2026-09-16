import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const ODDS_API_KEY = Deno.env.get("THE_ODDS_API_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

async function logApiUsage(endpoint: string, httpStatus: number, headers: Headers | null, context: Record<string, unknown> = {}, eventCount: number | null = null): Promise<void> {
  try {
    const used = parseInt(headers?.get("x-requests-used") || "0", 10);
    const remaining = parseInt(headers?.get("x-requests-remaining") || "0", 10);
    const last = parseInt(headers?.get("x-requests-last") || "0", 10);
    if (!SUPABASE_URL || !SUPABASE_KEY) return;
    await fetch(SUPABASE_URL + "/rest/v1/api_usage", {
      method: "POST",
      headers: { "Content-Type": "application/json", "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY, "Prefer": "return=minimal" },
      body: JSON.stringify({
        function_name: "get-live-games",
        endpoint, http_status: httpStatus,
        requests_used: isNaN(used) ? null : used,
        requests_remaining: isNaN(remaining) ? null : remaining,
        requests_last: isNaN(last) ? null : last,
        event_count: eventCount, context,
      }),
    });
  } catch (_err) { /* non-fatal */ }
}

interface LiveGame {
  id: string;
  homeTeam: string;
  awayTeam: string;
  commenceTime: string;
  homeScore: number | null;
  awayScore: number | null;
  status: "In Progress" | "Final" | "Scheduled";
}

// D-336 BUG 3 — gate the Odds API call.
// Pre-fix: every Dashboard page-view called scores/?daysFrom=1 → 1 credit/call.
// With NBA in offseason/Finals lull, this burned the monthly quota below the
// fetch-odds circuit-breaker threshold (500) and DOA'd pick generation.
//
// Two gates added:
// (1) UTC window — NBA games run 19:00 UTC (3pm ET tip) to ~06:00 UTC (1am ET end + buffer).
//     Outside 18:00-06:00 UTC, return cached empty without API call.
// (2) Emergency circuit breaker — if requests_remaining < 200, return empty
//     to preserve the last ~5 days of quota for fetch-odds picks-generation.
const NBA_WINDOW_START_UTC = 18;  // 2pm ET earliest preseason tipoffs
const NBA_WINDOW_END_UTC = 6;     // 1am ET + buffer for 4-OT marathons
const EMERGENCY_QUOTA_FLOOR = 200;

async function checkOddsQuotaCritical(): Promise<boolean> {
  // Returns true when remaining is so low we should not spend on live-games.
  if (!SUPABASE_URL || !SUPABASE_KEY) return false;
  try {
    const r = await fetch(
      SUPABASE_URL + "/rest/v1/api_usage?order=called_at.desc&limit=1&select=requests_remaining",
      { headers: { "apikey": SUPABASE_KEY, "Authorization": "Bearer " + SUPABASE_KEY } },
    );
    if (!r.ok) return false;
    const rows = await r.json() as Array<{ requests_remaining: number | null }>;
    const rem = rows[0]?.requests_remaining;
    return typeof rem === "number" && rem < EMERGENCY_QUOTA_FLOOR;
  } catch { return false; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    console.log("\n=== GET LIVE GAMES ===");

    // GATE 1 — NBA UTC window. Outside 18:00-06:00 UTC, return cached empty.
    const hour = new Date().getUTCHours();
    const inWindow = (hour >= NBA_WINDOW_START_UTC || hour < NBA_WINDOW_END_UTC);
    if (!inWindow) {
      return jsonResponse({
        success: true,
        games: [],
        fetchedAt: new Date().toISOString(),
        gated: "outside_nba_window",
        window_utc: `${NBA_WINDOW_START_UTC}:00-${NBA_WINDOW_END_UTC}:00`,
      });
    }

    // GATE 2 — emergency circuit breaker. If Odds API quota is near depletion,
    // preserve credits for picks-generation.
    const quotaCritical = await checkOddsQuotaCritical();
    if (quotaCritical) {
      return jsonResponse({
        success: true,
        games: [],
        fetchedAt: new Date().toISOString(),
        gated: "quota_critical",
        floor: EMERGENCY_QUOTA_FLOOR,
      });
    }

    // Fetch scores from The Odds API
    const scoresUrl = `https://api.the-odds-api.com/v4/sports/basketball_nba/scores/?apiKey=${ODDS_API_KEY}&daysFrom=1`;
    console.log("[scores] Fetching live scores...");

    const res = await fetch(scoresUrl);
    const text = await res.text();
    await logApiUsage("scores", res.status, res.headers, { days_from: 1 });

    if (!res.ok) {
      console.log(`[scores] API error: ${res.status} - ${text.slice(0, 200)}`);
      return jsonResponse({ success: true, games: [], message: "Could not fetch scores" });
    }

    const events = JSON.parse(text) as Array<{
      id: string;
      home_team: string;
      away_team: string;
      commence_time: string;
      completed?: boolean;
      scores?: Array<{ name: string; score: string }> | null;
    }>;

    console.log(`[scores] Found ${events.length} events`);

    const now = new Date();
    const liveGames: LiveGame[] = [];

    for (const event of events) {
      const gameStart = new Date(event.commence_time);

      // Only include games that have started (live or final)
      if (gameStart > now) continue;

      let homeScore: number | null = null;
      let awayScore: number | null = null;

      if (event.scores && Array.isArray(event.scores)) {
        for (const scoreEntry of event.scores) {
          if (scoreEntry.name === event.home_team) {
            homeScore = parseInt(scoreEntry.score) || null;
          } else if (scoreEntry.name === event.away_team) {
            awayScore = parseInt(scoreEntry.score) || null;
          }
        }
      }

      let status: "In Progress" | "Final" | "Scheduled" = "In Progress";
      if (event.completed === true) {
        status = "Final";
      } else if (homeScore === null && awayScore === null) {
        status = "In Progress";
      }

      liveGames.push({
        id: event.id,
        homeTeam: event.home_team,
        awayTeam: event.away_team,
        commenceTime: event.commence_time,
        homeScore,
        awayScore,
        status,
      });
    }

    console.log(`[scores] ${liveGames.length} live/completed games found`);

    return jsonResponse({
      success: true,
      games: liveGames,
      fetchedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error("[error]", err);
    return jsonResponse({
      success: false,
      games: [],
      error: err instanceof Error ? err.message : "Internal server error",
    }, 500);
  }
});
