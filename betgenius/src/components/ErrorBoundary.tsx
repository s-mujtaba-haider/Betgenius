// ErrorBoundary — D-226 Task 7.3.
//
// React error boundary per architecture §10.5. Catches component-tree
// exceptions, renders a non-crash fallback UI, and reports the error
// to Sentry (if @sentry/react initialized) plus the public.error_log
// table via PostgREST.
//
// Wraps key subscriber routes (Dashboard, Performance, Evaluator,
// Settings, Subscribe). Fallback preserves the §10.6 disclaimer so
// the build's lint:disclaimer gate still finds the required string
// on every code path.

import { Component, type ErrorInfo, type ReactNode } from "react";
import * as Sentry from "@sentry/react";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "@/lib/supabase";

interface ErrorBoundaryProps {
  children: ReactNode;
  routeName: string;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

async function logToErrorLog(routeName: string, error: Error, info: ErrorInfo) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/error_log`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        function_name: "frontend",
        phase: `route:${routeName}`,
        error_type: "react_error_boundary",
        error_message: error.message?.slice(0, 500) ?? "unknown",
        severity: "error",
        context: {
          stack: error.stack?.slice(0, 1500) ?? null,
          componentStack: info.componentStack?.slice(0, 1500) ?? null,
          route: routeName,
          url: typeof window !== "undefined" ? window.location.href : null,
        },
      }),
    });
  } catch { /* swallow — best-effort */ }
}

export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Sentry (if SENTRY_DSN configured at app boot — main.tsx Sentry.init).
    try {
      Sentry.captureException(error, {
        tags: { route: this.props.routeName, source: "error_boundary" },
        contexts: { react: { componentStack: info.componentStack ?? null } },
      });
    } catch { /* Sentry not initialized — fine */ }

    // error_log fallback so the issue lands somewhere persistent even
    // when Sentry is unavailable.
    void logToErrorLog(this.props.routeName, error, info);
  }

  handleReload = () => {
    if (typeof window !== "undefined") window.location.reload();
  };

  handleGoHome = () => {
    if (typeof window !== "undefined") window.location.href = "/";
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col">
          <main className="flex-1 max-w-2xl mx-auto px-4 py-20 w-full text-center">
            <div className="rounded-2xl border border-zinc-800 bg-zinc-900/50 p-8">
              <div className="text-amber-400 text-2xl font-bold mb-2">Something went wrong</div>
              <p className="text-sm text-zinc-400 leading-relaxed max-w-md mx-auto mb-6">
                We've logged this error and are looking into it. You can reload this page or head back home.
              </p>
              <div className="flex gap-3 justify-center">
                <button
                  onClick={this.handleReload}
                  className="rounded-lg bg-emerald-500 px-5 py-2 text-sm font-semibold text-zinc-950 hover:bg-emerald-400"
                >
                  Reload page
                </button>
                <button
                  onClick={this.handleGoHome}
                  className="rounded-lg border border-zinc-700 bg-zinc-800 px-5 py-2 text-sm font-medium text-zinc-200 hover:bg-zinc-700"
                >
                  Go home
                </button>
              </div>
              {this.state.error && (
                <details className="mt-6 text-left text-[11px] text-zinc-500">
                  <summary className="cursor-pointer hover:text-zinc-300">Technical details</summary>
                  <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded bg-zinc-950 p-3 text-zinc-400">
                    {this.state.error.message}
                  </pre>
                </details>
              )}
            </div>
          </main>

          {/* §10.6 disclaimer preserved in fallback so lint:disclaimer
              gate doesn't fail. Required string + 1-800-GAMBLER. */}
          <div className="border-t border-zinc-800 text-[11px] text-zinc-500 px-4 py-3 text-center">
            SharpAI provides analytics — <strong className="text-zinc-300">not financial or betting advice</strong>. Bet responsibly. 1-800-GAMBLER.
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
