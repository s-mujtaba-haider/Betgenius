import { createClient } from '@supabase/supabase-js'

// D-673 SHIP 3 — defensive env-var validation. If VITE_SUPABASE_URL or
// VITE_SUPABASE_ANON_KEY is undefined at build time, every PostgREST call
// would silently fail with `{"message":"No API key found in request",
// "hint":"No 'apikey' request header or url param was found."}`. We hit
// this exact error on Performance page per D-672 / user report. Fail
// loudly here at module load so the bug surfaces immediately in dev /
// preview rather than landing silently in prod.
const _SUPABASE_URL_RAW = import.meta.env.VITE_SUPABASE_URL as string | undefined
const _SUPABASE_ANON_KEY_RAW = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined
if (!_SUPABASE_URL_RAW || !_SUPABASE_ANON_KEY_RAW) {
  // eslint-disable-next-line no-console
  console.error(
    "[D-673] Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY at build time — every PostgREST call will fail with 'No API key found in request'. Check Vercel env vars.",
  )
}

export const SUPABASE_URL = _SUPABASE_URL_RAW as string
export const SUPABASE_ANON_KEY = _SUPABASE_ANON_KEY_RAW as string

// D-504 — explicit auth options (these are the v2 defaults; spelled out
// so a future config change can't accidentally disable token refresh,
// which would let access_tokens expire on long-open sessions and silently
// 401 RLS-gated reads (e.g. the Admin Performance panel — D-503 bug 2).
export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    autoRefreshToken: true,
    persistSession: true,
    detectSessionInUrl: true,
  },
})
