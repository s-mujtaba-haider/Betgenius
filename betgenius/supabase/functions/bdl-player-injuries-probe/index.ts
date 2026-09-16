// One-off probe (May 10, 2026) — samples real BDL /v1/player_injuries response
// shape + status value distribution. Service-role gated. Never echoes the API
// key. To be DELETED immediately after invocation.

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

  const bdlKey = Deno.env.get("BALLDONTLIE_API_KEY") || "";
  if (!bdlKey) {
    return jsonResponse({ success: false, error: "BALLDONTLIE_API_KEY not set" }, 500);
  }

  try {
    // Paginate through ALL pages to get full picture of status distribution.
    // BDL ALL-STAR is 60 req/min; even ~10 pages stays well under.
    const items: any[] = [];
    let cursor: number | null = null;
    let pages_fetched = 0;
    let last_status = 0;
    let last_meta: any = null;
    let last_raw_excerpt: string | null = null;

    while (pages_fetched < 20) {
      const url = cursor
        ? `https://api.balldontlie.io/v1/player_injuries?per_page=100&cursor=${cursor}`
        : `https://api.balldontlie.io/v1/player_injuries?per_page=100`;
      const res = await fetch(url, { headers: { Authorization: bdlKey } });
      last_status = res.status;
      const text = await res.text();
      let parsed: any = null;
      try { parsed = JSON.parse(text); } catch (_e) { /* report raw */ }
      if (!parsed || !Array.isArray(parsed.data)) {
        last_raw_excerpt = text.slice(0, 1500);
        break;
      }
      items.push(...parsed.data);
      last_meta = parsed.meta ?? null;
      pages_fetched++;
      const next = parsed.meta?.next_cursor ?? null;
      if (!next) break;
      cursor = next;
    }

    if (items.length === 0) {
      return jsonResponse({
        success: false,
        http_status: last_status,
        raw_excerpt: last_raw_excerpt,
      });
    }

    const status = last_status;
    const total_returned = items.length;

    // Distinct status values + counts
    const statusCounts: Record<string, number> = {};
    for (const it of items) {
      const s = String(it?.status ?? "(null)");
      statusCounts[s] = (statusCounts[s] || 0) + 1;
    }

    // Sample first item full shape
    const first_item_full = items[0] ?? null;

    // Status field samples: pick one item per distinct status
    const status_samples: Record<string, any> = {};
    for (const it of items) {
      const s = String(it?.status ?? "(null)");
      if (!(s in status_samples)) status_samples[s] = it;
    }

    // return_date format check + non-null counts
    let return_date_non_null = 0;
    const return_date_examples: string[] = [];
    for (const it of items) {
      if (it?.return_date != null && it.return_date !== "") {
        return_date_non_null++;
        if (return_date_examples.length < 5) {
          return_date_examples.push(String(it.return_date));
        }
      }
    }

    // description field stats
    let description_non_empty = 0;
    const description_examples: string[] = [];
    for (const it of items) {
      const d = String(it?.description ?? "");
      if (d.length > 0) {
        description_non_empty++;
        if (description_examples.length < 5) {
          description_examples.push(d.slice(0, 200));
        }
      }
    }

    return jsonResponse({
      success: true,
      http_status: status,
      pages_fetched,
      total_returned,
      last_meta,
      status_counts_full_corpus: statusCounts,
      status_samples_one_per_status: status_samples,
      first_item_full,
      return_date_non_null: return_date_non_null,
      return_date_examples,
      description_non_empty: description_non_empty,
      description_examples,
    });
  } catch (e) {
    return jsonResponse({
      success: false,
      error: `fetch threw: ${e instanceof Error ? e.message : String(e)}`,
    }, 500);
  }
});
