import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import * as Sentry from '@sentry/react'
import './index.css'
import App from './App.tsx'

// OBS-02 (May 9, 2026): Sentry instrumentation for runtime JS errors,
// unhandled promise rejections, network failures, and React component
// errors. Free-tier-friendly sample rates: 10% traces, no proactive
// session replay, but capture replay on every error. Disabled in dev
// mode so noisy local errors don't burn Sentry quota.
//
// DSN comes from VITE_SENTRY_DSN_FRONTEND. CEO must add this env var
// in Vercel project settings before the Vercel build picks it up;
// without it, Sentry.init silently no-ops (DSN undefined) so nothing
// breaks in environments where it's missing.
//
// Honest limitation: Sentry doesn't catch silent catch blocks (e.g.
// the C40 / C41 pattern at process-games:2927). Empty-state renders
// that look broken but don't error also slip through. Not a substitute
// for the C41 silent-catch refactor.
Sentry.init({
  dsn: import.meta.env.VITE_SENTRY_DSN_FRONTEND,
  environment: import.meta.env.MODE,
  integrations: [
    Sentry.browserTracingIntegration(),
    Sentry.replayIntegration({
      maskAllText: false,
      blockAllMedia: false,
    }),
  ],
  tracesSampleRate: 0.1,
  replaysSessionSampleRate: 0.0,
  replaysOnErrorSampleRate: 1.0,
  enabled: import.meta.env.MODE === 'production',
  sendDefaultPii: false,
})

document.documentElement.classList.add('dark')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Sentry.ErrorBoundary
      fallback={
        <div className="flex min-h-screen items-center justify-center bg-zinc-950 p-6 text-zinc-100">
          <div className="max-w-md text-center">
            <h1 className="mb-4 text-2xl font-semibold">Something went wrong</h1>
            <p className="mb-6 text-sm text-zinc-400">
              An unexpected error occurred. Please refresh the page. If the
              problem persists, the SharpAI team has been notified.
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-md bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500"
            >
              Refresh
            </button>
          </div>
        </div>
      }
    >
      <App />
    </Sentry.ErrorBoundary>
  </StrictMode>,
)
