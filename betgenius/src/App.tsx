import { useEffect, useState } from "react";
import Dashboard from "./pages/Dashboard";
import Evaluator from "./pages/Evaluator";
import BetTracker from "./pages/BetTracker";
import Performance from "./pages/Performance";
import Stats from "./pages/Stats";
import Admin from "./pages/Admin";
import Settings from "./pages/Settings";
import Games from "./pages/Games";
import AuthGate from "./components/AuthGate";
import { useAuthSession } from "./lib/auth";
import { hydrateUserPreferences } from "./lib/user_preferences";
import { persistSignupAttribution } from "./lib/signup_attribution";
import { useSubscriptionGate } from "./hooks/useSubscriptionGate";
import Subscribe from "./pages/Subscribe";
import SubscriptionBanner from "./components/SubscriptionBanner";
import ErrorBoundary from "./components/ErrorBoundary";

type Page = "dashboard" | "games" | "evaluator" | "tracker" | "performance" | "stats" | "admin" | "settings";

export interface BetPrefill {
  playerName: string;
  propType: string;
  line: number;
  pickSide: "over" | "under";
  odds: number;
}

const VALID_PAGES: ReadonlyArray<Page> = ["dashboard", "games", "evaluator", "tracker", "performance", "stats", "admin", "settings"];

function App() {
  return (
    <AuthGate>
      <SignedInApp />
    </AuthGate>
  );
}

function SignedInApp() {
  const { session, isAdmin, signOut } = useAuthSession();
  const [page, setPage] = useState<Page>("dashboard");
  const [betPrefill, setBetPrefill] = useState<BetPrefill | null>(null);
  // D-221 — subscription gate. Admin always full access (per §6.7).
  const gate = useSubscriptionGate();
  const needsSubscribe = !isAdmin && gate.access_level === "subscribe_required" && !gate.loading;

  // In-app navigation channel — components dispatch
  // `new CustomEvent("bg:navigate", { detail: <page> })` to switch pages
  // without prop-drilling setPage. Currently used by LineShoppingSection's
  // "Edit in Settings" link.
  useEffect(() => {
    function handler(e: Event) {
      const detail = (e as CustomEvent<unknown>).detail;
      if (typeof detail === "string" && (VALID_PAGES as ReadonlyArray<string>).includes(detail)) {
        // Block non-admin from navigating to admin page via custom event.
        if (detail === "admin" && !isAdmin) return;
        setPage(detail as Page);
      }
    }
    window.addEventListener("bg:navigate", handler);
    return () => window.removeEventListener("bg:navigate", handler);
  }, [isAdmin]);

  // Defensive: if a non-admin somehow lands on admin (e.g. they were admin,
  // got removed mid-session, page state held over), bounce to dashboard.
  useEffect(() => {
    if (page === "admin" && !isAdmin) setPage("dashboard");
  }, [page, isAdmin]);

  // §15.10 Critical #2 — hydrate user_preferences from Supabase on sign-in.
  // Fetches the server row (or INSERTs current localStorage if no row yet)
  // and writes the synced values back to localStorage. Existing sync readers
  // (readBankroll, readKellyFractionMode, books loader in Settings, etc.)
  // pick up the synced values on next access. Fire-and-forget — UI doesn't
  // block on this. Anonymous mode (no session) is a no-op inside the helper.
  useEffect(() => {
    if (!session?.user?.id) return;
    let cancelled = false;
    (async () => {
      try {
        // D-216 — persist signup attribution (TOS + ref/invite codes)
        // before hydration so user_preferences picks up tos_accepted_at.
        await persistSignupAttribution(session);
        await hydrateUserPreferences(session);
        // Fire a custom event so any component that wants to re-read its
        // cached preferences post-hydration can listen for it. Bookkeeping
        // only — most consumers re-read on next mount which is sufficient.
        if (!cancelled) {
          window.dispatchEvent(new CustomEvent("bg:preferences-hydrated"));
        }
      } catch { /* hydration failure is non-fatal; localStorage cache stays */ }
    })();
    return () => { cancelled = true; };
  }, [session?.user?.id, session]);

  function handleLogBet(data: BetPrefill) {
    setBetPrefill(data);
    setPage("tracker");
  }

  function handleClearPrefill() {
    setBetPrefill(null);
  }

  // D-221 — gate to /subscribe when no active subscription. Settings + Admin
  // remain accessible per §6.7 (read-only for Settings); other pages redirect.
  if (needsSubscribe && page !== "settings" && page !== "admin") {
    return (
      <ErrorBoundary routeName="subscribe">
        <Subscribe />
      </ErrorBoundary>
    );
  }

  // D-221 — degraded read-only mode flag (passed to child pages via context
  // could be cleaner; for v1 the banner alerts and child pages render normally
  // with their existing read paths — write paths through edge functions are
  // already RLS-gated. Future Batch 7 work: disable bet-log + evaluator writes.

  return (
    <div className="min-h-screen bg-zinc-950 text-white">
      <SubscriptionBanner />
      {/* Header */}
      <header className="border-b border-zinc-800 bg-zinc-900/80 backdrop-blur-sm sticky top-0 z-10">
        <div className="mx-auto max-w-6xl flex items-center justify-between px-3 sm:px-6 h-16">
          <div className="flex items-center h-12 shrink-0">
            {/* Header h-16 (64px), logo wrapper h-12 (48px). Logo bumped
                from h-10 → h-12 for 20% larger render at the same bar height. */}
            <img src="/logo.png" alt="SharpAI" className="h-full w-auto object-contain" />
          </div>
          <nav className="flex items-center gap-1 overflow-x-auto">
            <NavButton active={page === "dashboard"} onClick={() => setPage("dashboard")}>
              Dashboard
            </NavButton>
            <NavButton active={page === "games"} onClick={() => setPage("games")}>
              Games
            </NavButton>
            <NavButton active={page === "evaluator"} onClick={() => setPage("evaluator")}>
              Evaluator
            </NavButton>
            <NavButton active={page === "tracker"} onClick={() => setPage("tracker")}>
              Tracker
            </NavButton>
            <NavButton active={page === "performance"} onClick={() => setPage("performance")}>
              Performance
            </NavButton>
            <NavButton active={page === "stats"} onClick={() => setPage("stats")}>
              Stats
            </NavButton>
            {isAdmin && (
              <NavButton active={page === "admin"} onClick={() => setPage("admin")}>
                Admin
              </NavButton>
            )}
            <NavButton active={page === "settings"} onClick={() => setPage("settings")}>
              Settings
            </NavButton>
            <button
              onClick={signOut}
              title={session?.user?.email ?? ""}
              className="ml-1 rounded-lg px-2 sm:px-3 py-1.5 text-xs sm:text-sm font-medium text-zinc-500 hover:text-zinc-300 whitespace-nowrap"
            >
              Sign out
            </button>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-3 sm:px-6 py-4 sm:py-8">
        {page === "dashboard" && (
          <ErrorBoundary routeName="dashboard"><Dashboard /></ErrorBoundary>
        )}
        {page === "games" && (
          <ErrorBoundary routeName="games"><Games /></ErrorBoundary>
        )}
        {page === "evaluator" && (
          <ErrorBoundary routeName="evaluator"><Evaluator onLogBet={handleLogBet} /></ErrorBoundary>
        )}
        {page === "tracker" && (
          <ErrorBoundary routeName="tracker"><BetTracker prefill={betPrefill} onClearPrefill={handleClearPrefill} /></ErrorBoundary>
        )}
        {page === "performance" && (
          <ErrorBoundary routeName="performance"><Performance /></ErrorBoundary>
        )}
        {page === "stats" && (
          <ErrorBoundary routeName="stats"><Stats /></ErrorBoundary>
        )}
        {page === "admin" && isAdmin && (
          <ErrorBoundary routeName="admin"><Admin /></ErrorBoundary>
        )}
        {page === "settings" && (
          <ErrorBoundary routeName="settings"><Settings /></ErrorBoundary>
        )}
      </main>
      {/* D-654 SHIP 3 — bundle-hash footer. Lets us tell INSTANTLY whether
          a user is loading the current bundle or a stale one cached client-side.
          BUILD_HASH is injected at vite build time (see vite.config.ts define block). */}
      <BuildHashFooter />
    </div>
  );
}

// D-654 SHIP 3 — written by scripts/write_build_info.mjs in `npm run build`.
import buildInfo from "./build-info.json";
function BuildHashFooter() {
  return (
    <footer className="mx-auto max-w-7xl px-4 py-3 text-[10px] text-zinc-700 tabular-nums select-text">
      build {buildInfo.hash} · {buildInfo.time} · {buildInfo.env}
    </footer>
  );
}

function NavButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-lg px-2 sm:px-3 py-1.5 text-xs sm:text-sm font-medium transition-colors whitespace-nowrap ${
        active
          ? "bg-zinc-800 text-white"
          : "text-zinc-500 hover:text-zinc-300"
      }`}
    >
      {children}
    </button>
  );
}

export default App;
