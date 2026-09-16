// One-off probe (May 11, 2026) — empirical check whether The Odds API exposes
// any injury/player-status data. Docs at https://the-odds-api.com/liveapi/guides/v4/
// list 10 endpoints, none about injuries. /participants returns teams only with
// just {full_name, id}. This probe tests 4 candidate paths to rule out
// undocumented variants. Probe will be DELETED after invocation.
//
// Service-role gated. THE_ODDS_API_KEY read from Supabase secrets; never
// echoed to logs or response body.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const serviceKey = Deno.env.get("BACKFILL_AUTH_TOKEN") ||
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const auth = req.headers.get("authorization") || "";
  if (!serviceKey || !auth.includes(serviceKey)) {
    return jsonResponse({ success: false, error: "service_role required" }, 401);
  }

  const oddsKey = Deno.env.get("THE_ODDS_API_KEY") || "";
  if (!oddsKey) {
    return jsonResponse({ success: false, error: "THE_ODDS_API_KEY not set" }, 500);
  }

  // 4 candidate endpoint paths to probe. Each call costs ~1 credit on the
  // Odds API quota; total ~4 credits / 100K monthly = ~0.004% of budget. Negligible.
  const candidates = [
    "/v4/sports/basketball_nba/participants",      // documented — sample shape
    "/v4/sports/basketball_nba/injuries",           // undocumented — expect 404
    "/v4/sports/basketball_nba/player_status",      // undocumented — expect 404
    "/v4/sports/basketball_nba/players",            // undocumented — expect 404
  ];

  const results: Record<string, unknown> = {};

  for (const path of candidates) {
    const url = `https://api.the-odds-api.com${path}?apiKey=${oddsKey}`;
    try {
      const res = await fetch(url);
      const status = res.status;
      const text = await res.text();
      const usedHeader = res.headers.get("x-requests-used");
      const remainingHeader = res.headers.get("x-requests-remaining");
      let parsed: unknown = null;
      try { parsed = JSON.parse(text); } catch (_e) { /* report raw */ }

      // Sanitize: never include the apiKey in the URL we report back
      const sanitizedUrl = `https://api.the-odds-api.com${path}?apiKey=<redacted>`;

      let arrayShape = false;
      let sampleItem: unknown = null;
      let totalItems = 0;
      if (Array.isArray(parsed)) {
        arrayShape = true;
        totalItems = parsed.length;
        sampleItem = parsed[0] ?? null;
      }

      results[path] = {
        url: sanitizedUrl,
        http_status: status,
        x_requests_used: usedHeader,
        x_requests_remaining: remainingHeader,
        is_array_response: arrayShape,
        total_items: totalItems,
        sample_item: sampleItem,
        body_excerpt: text.slice(0, 400),
      };
    } catch (e) {
      results[path] = {
        error: `fetch threw: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  return jsonResponse({
    success: true,
    candidates_probed: candidates.length,
    results,
  });
});
