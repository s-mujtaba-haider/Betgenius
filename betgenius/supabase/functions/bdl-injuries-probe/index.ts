// One-off probe (May 10, 2026) — checks whether our BDL API key has access
// to the /v1/nba/injuries endpoint. NOT a persistent function — delete after
// the verification result is captured. The existing codebase uses
// /v1/player_injuries (no sport prefix); /v1/nba/injuries may be a different
// path (newer API version, different tier, or sport-prefixed variant).
//
// Service-role gated. Returns:
//   { status, first_data_item, full_response_excerpt, error }
// Never echoes the API key to logs or response body.

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

  // Auth gate — service-role only
  const serviceKey = Deno.env.get("BACKFILL_AUTH_TOKEN") ||
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const auth = req.headers.get("authorization") || "";
  if (!serviceKey || !auth.includes(serviceKey)) {
    return jsonResponse({ success: false, error: "service_role required" }, 401);
  }

  const bdlKey = Deno.env.get("BALLDONTLIE_API_KEY") || "";
  if (!bdlKey) {
    return jsonResponse({ success: false, error: "BALLDONTLIE_API_KEY not set in Supabase secrets" }, 500);
  }

  const url = "https://api.balldontlie.io/v1/nba/injuries";
  let status = 0;
  let firstItem: unknown = null;
  let bodyExcerpt: string | null = null;
  let parseError: string | null = null;

  try {
    const res = await fetch(url, {
      headers: { Authorization: bdlKey },
    });
    status = res.status;
    const text = await res.text();
    bodyExcerpt = text.slice(0, 800);
    try {
      const parsed = JSON.parse(text);
      const arr = (parsed as { data?: unknown[] })?.data;
      if (Array.isArray(arr) && arr.length > 0) {
        firstItem = arr[0];
      } else if (Array.isArray(arr)) {
        firstItem = null; // empty array, valid response
      } else {
        firstItem = parsed; // not array-shaped; return whole parsed payload for inspection
      }
    } catch (e) {
      parseError = e instanceof Error ? e.message : String(e);
    }
  } catch (e) {
    return jsonResponse({
      success: false,
      url,
      error: `fetch threw: ${e instanceof Error ? e.message : String(e)}`,
    }, 500);
  }

  return jsonResponse({
    success: status >= 200 && status < 300,
    url,
    http_status: status,
    has_data_array: firstItem !== null || bodyExcerpt?.includes('"data"'),
    first_data_item: firstItem,
    response_excerpt: bodyExcerpt,
    parse_error: parseError,
  });
});
