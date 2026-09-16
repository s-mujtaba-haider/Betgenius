// check-email-allowed — D-500 (2026-06-10).
//
// Server-side membership check for allowed_emails. Replaces the prior
// frontend pattern where src/lib/auth.ts:isEmailAllowed fetched
// `/rest/v1/allowed_emails?email=eq.X` with the anon key — which only
// worked because of the `allowed_emails_select_all (using=true)` policy
// that let the entire allow-list leak to any holder of the public anon
// key. D-500 SHIP 2 drops that policy; this function is the replacement
// path for membership checks.
//
// Contract:
//   POST /functions/v1/check-email-allowed
//   Headers: apikey + Authorization (any valid Supabase anon-key bearer
//            is enough — the function does its own service-role read).
//   Body:    { "email": "string" }
//   Returns: { "allowed": boolean }    — boolean ONLY, never the row,
//            never the list, never any other email.
//
// Cardinal: the response shape MUST stay tight. Future changes must NOT
// add `email`, `row`, `count`, or any field that could be used to scrape
// the list. The boolean is the entire surface.
//
// Deploy: npx supabase functions deploy check-email-allowed --no-verify-jwt
//
// Why --no-verify-jwt: matches the project's edge-function convention; the
// fn does its own server-side service-role query that bypasses RLS. The
// anon-key bearer is required by the Supabase platform to authenticate the
// HTTP call, but is not used for the DB read.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type",
};

function j(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return j({ allowed: false }, 405);

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    console.error("[check-email-allowed] missing SUPABASE_URL or SERVICE_ROLE_KEY env");
    return j({ allowed: false }, 500);
  }

  let body: { email?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    return j({ allowed: false }, 400);
  }

  // Strict input validation: must be a non-empty string with an `@`.
  // Anything else short-circuits to allowed=false (no DB query).
  const raw = body.email;
  if (typeof raw !== "string") return j({ allowed: false }, 400);
  const email = raw.trim().toLowerCase();
  if (!email || !email.includes("@") || email.length > 254) {
    return j({ allowed: false });
  }

  try {
    // Service-role bypasses RLS server-side. Query is HEAD-style: we only
    // need to know if a row exists; select=email&limit=1 is the minimal
    // payload. The body is parsed but never returned to the caller.
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/allowed_emails?email=eq.${encodeURIComponent(email)}&select=email&limit=1`,
      {
        headers: {
          "apikey": SUPABASE_KEY,
          "Authorization": `Bearer ${SUPABASE_KEY}`,
        },
      }
    );
    if (!res.ok) {
      console.error(`[check-email-allowed] DB read ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return j({ allowed: false }, 500);
    }
    const rows = await res.json() as Array<unknown>;
    const allowed = Array.isArray(rows) && rows.length > 0;
    // Response intentionally contains only `allowed`. No email field, no
    // count, no rows.
    return j({ allowed });
  } catch (err) {
    console.error(`[check-email-allowed] internal: ${err}`);
    return j({ allowed: false }, 500);
  }
});
