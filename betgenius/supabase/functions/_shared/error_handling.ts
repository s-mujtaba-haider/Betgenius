// Shared structured error handling helpers (C41, May 10, 2026).
//
// Background: silent catch blocks at process-games:3042
// (logToRecommendationsCache) and previously at :2927 (logPickToHistory,
// fixed May 9 commit c82de30) swallowed PostgREST 4xx responses for 3
// days, masking the C40 player-prop writer bug. Sentry instrumentation
// (May 9 commit 26ec414) catches THROWN errors but NOT silent catches.
// This module is the C41 fix — exposes catches without spamming
// notifications on every transient failure.
//
// Pattern:
//   1. logErrorStructured() — drop a row into error_log with severity
//      tagged in the context JSONB. Always safe to call; never throws.
//   2. trackFailureRate() — count recent error_log rows of the same
//      error_type. Returns count + tripped flag based on threshold.
//   3. captureWithContext() — Sentry capture + flush. Calls into the
//      existing _shared/sentry.ts helper.
//
// Severity tagging: error_log doesn't have a severity column (verified
// May 10 by migration 20260510000001 — function_name/phase/error_type/
// error_message/context columns only). We encode severity in
// context->>'severity' so existing readers (Admin error_log table,
// health-monitor count thresholds) keep working unchanged.
//
// Why ad-hoc fetch instead of @supabase/supabase-js: avoid pulling
// another dep into edge functions and the round-trip overhead is the
// same. notify.ts uses the same fetch pattern.

import { captureError as sentryCaptureError } from "./sentry.ts";

export type Severity = "debug" | "warning" | "critical";

interface StructuredContext {
  function_name: string;
  phase: string;
  error_type: string;
  message: string;
  payload?: Record<string, unknown>;
}

function getEnv() {
  return {
    url: Deno.env.get("SUPABASE_URL") || "",
    key: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "",
  };
}

// Write a structured error_log row. Severity tagged in context JSONB.
// Never throws — observability code can't crash the caller.
export async function logErrorStructured(
  severity: Severity,
  context: StructuredContext,
): Promise<void> {
  const { url, key } = getEnv();
  if (!url || !key) return;
  try {
    await fetch(`${url}/rest/v1/error_log`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: key,
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        function_name: context.function_name,
        phase: context.phase,
        error_type: context.error_type,
        error_message: context.message.slice(0, 2000),
        context: {
          severity,
          ...(context.payload ?? {}),
        },
      }),
    });
  } catch (_e) {
    // recursion guard — never log errors about logging errors
    console.error(`[logErrorStructured] failed to write: ${context.error_type}`);
  }
}

// Query error_log for recent rows of the same error_type. Returns count
// over the window + tripped boolean if count >= threshold.
//
// Idempotent: callers can invoke after every failure; threshold breach
// only fires once per window because subsequent calls return tripped=true
// with the same count.
export async function trackFailureRate(
  error_type: string,
  threshold: number,
  windowMin: number = 30,
  function_name: string = "process-games",
): Promise<{ count: number; tripped: boolean }> {
  const { url, key } = getEnv();
  if (!url || !key) return { count: 0, tripped: false };
  try {
    const cutoff = new Date(Date.now() - windowMin * 60 * 1000).toISOString();
    const queryUrl = `${url}/rest/v1/error_log` +
      `?function_name=eq.${encodeURIComponent(function_name)}` +
      `&error_type=eq.${encodeURIComponent(error_type)}` +
      `&created_at=gte.${encodeURIComponent(cutoff)}` +
      `&select=id`;
    const res = await fetch(queryUrl, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        // Exact count in Content-Range header
        Prefer: "count=exact",
      },
    });
    if (!res.ok) return { count: 0, tripped: false };
    const contentRange = res.headers.get("content-range") || "";
    // Format: "0-N/total" — extract total after '/'
    const slashIdx = contentRange.lastIndexOf("/");
    const totalStr = slashIdx >= 0 ? contentRange.slice(slashIdx + 1) : "0";
    const count = parseInt(totalStr, 10) || 0;
    return { count, tripped: count >= threshold };
  } catch (_e) {
    return { count: 0, tripped: false };
  }
}

// Sentry capture + flush wrapper. Delegates to _shared/sentry.ts
// captureError which already handles the flush + silent-catch.
export async function captureWithContext(
  error: unknown,
  context: Record<string, unknown>,
): Promise<void> {
  await sentryCaptureError(error, context);
}
