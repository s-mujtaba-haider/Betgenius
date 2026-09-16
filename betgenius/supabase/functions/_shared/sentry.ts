// Shared Sentry helper for edge functions (OBS-02, May 9, 2026).
//
// Catches: thrown exceptions from top-level handlers in process-games,
// run-optimizer-v2, resolve-picks. Other edge functions can opt-in by
// importing { captureError } and wrapping their handlers.
//
// Honest limitations: doesn't catch silent catch blocks (e.g. the
// process-games:2927 / 2995 silent-catch pattern that hid C40 for 3
// days). Doesn't catch logic errors that don't throw. Not a substitute
// for the C41 silent-catch refactor — that's still queued.
//
// DSN comes from SENTRY_DSN_EDGE secret. If unset, captureError is a
// no-op so functions still run in dev/test environments.
//
// Sentry Deno SDK (deno.land/x/sentry) — initialized once per cold start
// per edge function instance. Sentry.flush() is critical — edge functions
// terminate quickly after returning, so we have to await flush before
// the runtime kills the process or the event is lost.

import * as Sentry from "https://deno.land/x/sentry/index.mjs";

const dsn = Deno.env.get("SENTRY_DSN_EDGE");

if (dsn) {
  Sentry.init({
    dsn,
    environment: Deno.env.get("ENVIRONMENT") || "production",
    tracesSampleRate: 0.1,
  });
}

export async function captureError(
  error: unknown,
  context?: Record<string, unknown>,
): Promise<void> {
  if (!dsn) return;
  try {
    Sentry.withScope((scope: any) => {
      if (context) scope.setContext("function_context", context);
      Sentry.captureException(error);
    });
    // Edge functions terminate fast — must flush or events vanish
    await Sentry.flush(2000).catch(() => {});
  } catch (_e) {
    // never crash the calling function from observability code
  }
}

export { Sentry };
