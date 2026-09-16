import { useEffect, useState } from "react";
import { useAuthSession } from "@/lib/auth";
import { useSubscriptionGate } from "@/hooks/useSubscriptionGate";
import {
  readBankroll, writeBankroll, MAX_BET_PCT, ROUND_TO,
  readKellyFractionMode, writeKellyFractionMode,
  KELLY_FRACTION_OPTIONS, type KellyFractionMode,
} from "@/lib/kelly";
import {
  saveUserPreferences,
  readDiscretionaryStake,
  DISCRETIONARY_STAKE_KEY,
} from "@/lib/user_preferences";

// Books currently visible in props_cache. Order matches BOOK_DISPLAY in
// Dashboard.tsx so checkbox layout reflects priority + brand familiarity.
// Update this list when fetch-odds picks up a new region/book.
const ALL_BOOKS: { key: string; label: string }[] = [
  { key: "hardrockbet", label: "Hard Rock Bet" },
  { key: "hardrockbet_fl", label: "Hard Rock Bet (FL)" },
  { key: "hardrockbet_az", label: "Hard Rock Bet (AZ)" },
  { key: "draftkings", label: "DraftKings" },
  { key: "fanduel", label: "FanDuel" },
  { key: "betmgm", label: "BetMGM" },
  { key: "bovada", label: "Bovada" },
  { key: "fliff", label: "Fliff" },
  { key: "betparx", label: "BetParx" },
  { key: "betonlineag", label: "BetOnline" },
  { key: "espnbet", label: "ESPN BET" },
  { key: "betrivers", label: "BetRivers" },
  { key: "williamhill_us", label: "Caesars" },
  { key: "fanatics", label: "Fanatics" },
  { key: "ballybet", label: "Bally Bet" },
];

const STORAGE_KEY = "betgenius_user_books";
const DEFAULT_BOOKS = ["hardrockbet"];

// D-271 L6 — bind Subscription row to live gate state instead of
// hardcoded "Free (subscriber launch coming)".
function subscriptionLabel(gate: ReturnType<typeof useSubscriptionGate>): string {
  if (gate.loading) return "Loading…";
  if (gate.is_beta_locked) return "Beta — Pro";
  switch (gate.status) {
    case "active":   return "Active";
    case "trialing": return gate.days_remaining != null
      ? `Trial — ${gate.days_remaining} day${gate.days_remaining === 1 ? "" : "s"} left`
      : "Trial";
    case "past_due":           return "Past due — update payment";
    case "canceled":           return "Canceled";
    case "unpaid":             return "Unpaid";
    case "incomplete":         return "Pending checkout";
    case "incomplete_expired": return "Checkout expired";
    default: return gate.access_level === "full" ? "Beta — Free access" : "Free";
  }
}

function readStoredBooks(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_BOOKS;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return DEFAULT_BOOKS;
    return parsed.filter((v) => typeof v === "string");
  } catch {
    return DEFAULT_BOOKS;
  }
}

export default function Settings() {
  const { session, signOut } = useAuthSession();
  const gate = useSubscriptionGate();
  const [selectedBooks, setSelectedBooks] = useState<Set<string>>(() => new Set(readStoredBooks()));
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  // D-060: bankroll input. String state so users can type freely; we
  // parse on save and snap back if invalid.
  const [bankrollInput, setBankrollInput] = useState<string>(() => String(readBankroll()));
  const [bankrollSavedAt, setBankrollSavedAt] = useState<number | null>(null);
  const [bankrollError, setBankrollError] = useState<string | null>(null);
  // May 5: Kelly Aggressiveness mode (Quarter/Half/Full). Persists via
  // localStorage; recommendedStake reads it on every Log Bet form open.
  const [kellyMode, setKellyMode] = useState<KellyFractionMode>(() => readKellyFractionMode());
  const [kellyModeSavedAt, setKellyModeSavedAt] = useState<number | null>(null);
  // §15.10 Critical #1 Phase 2: discretionary stake auto-fills Log All Picks
  // for SKIP_PRICE picks (Kelly says no but the user wants the bet tracked).
  const [discInput, setDiscInput] = useState<string>(() => String(readDiscretionaryStake()));
  const [discSavedAt, setDiscSavedAt] = useState<number | null>(null);
  const [discError, setDiscError] = useState<string | null>(null);

  function handleKellyModeChange(mode: KellyFractionMode) {
    setKellyMode(mode);
    // localStorage write stays (anonymous fallback + instant in-tab effect);
    // server sync via saveUserPreferences (no-op for anonymous sessions).
    writeKellyFractionMode(mode);
    void saveUserPreferences(session, { kelly_aggressiveness: mode });
    setKellyModeSavedAt(Date.now());
    setTimeout(() => setKellyModeSavedAt(null), 2500);
  }
  const kellyFractionPct = Math.round(KELLY_FRACTION_OPTIONS[kellyMode] * 100);

  function saveDiscretionaryStake() {
    const n = parseFloat(discInput);
    if (!Number.isFinite(n) || n < 0) {
      setDiscError("Enter a non-negative number.");
      setTimeout(() => setDiscError(null), 3000);
      setDiscInput(String(readDiscretionaryStake()));
      return;
    }
    try { localStorage.setItem(DISCRETIONARY_STAKE_KEY, String(n)); } catch { /* ignore */ }
    void saveUserPreferences(session, { discretionary_stake: n });
    setDiscInput(String(n));
    setDiscError(null);
    setDiscSavedAt(Date.now());
    setTimeout(() => setDiscSavedAt(null), 2500);
  }

  function copyAccountId() {
    const id = session?.user?.id;
    if (!id) return;
    navigator.clipboard?.writeText(id).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }).catch(() => { /* clipboard unavailable */ });
  }

  // Persist on every change. Single source of truth: the Set state.
  // localStorage write stays for anonymous fallback + instant in-tab effect;
  // saveUserPreferences syncs to the user_preferences table when signed in.
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...selectedBooks]));
      setSavedAt(Date.now());
    } catch {
      // localStorage may be disabled (private mode); silently ignore.
    }
    void saveUserPreferences(session, { my_books: [...selectedBooks] });
  }, [selectedBooks, session]);

  function toggleBook(key: string) {
    setSelectedBooks((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  }

  function selectAll() {
    setSelectedBooks(new Set(ALL_BOOKS.map((b) => b.key)));
  }

  function resetDefault() {
    setSelectedBooks(new Set(DEFAULT_BOOKS));
  }

  // D-060: save bankroll. Validate positive finite number; snap back
  // input to last-saved value on failure.
  function saveBankroll() {
    const n = parseFloat(bankrollInput);
    if (!Number.isFinite(n) || n <= 0) {
      setBankrollError("Enter a positive number.");
      setTimeout(() => setBankrollError(null), 3000);
      return;
    }
    // localStorage write stays (anonymous fallback + instant in-tab effect);
    // server sync via saveUserPreferences (no-op for anonymous sessions).
    writeBankroll(n);
    void saveUserPreferences(session, { bankroll: n });
    setBankrollInput(String(n));
    setBankrollError(null);
    setBankrollSavedAt(Date.now());
    setTimeout(() => setBankrollSavedAt(null), 2500);
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-zinc-100">Settings</h1>
        <p className="text-sm text-zinc-500 mt-1 max-w-2xl">
          Coming soon — most settings are placeholder UI for now. Full functionality ships with subscriber launch.
        </p>
      </div>

      {/* My Books */}
      <section className="rounded-xl border border-zinc-800 bg-gradient-to-b from-zinc-900 to-zinc-900/60 p-5">
        <div className="flex items-end justify-between flex-wrap gap-2 mb-1">
          <div>
            <h2 className="text-base font-semibold text-zinc-100">My Books</h2>
            <p className="text-xs text-zinc-400 mt-0.5 max-w-2xl">
              Select sportsbooks you have accounts at. Picks will filter to props your books offer.{" "}
              <span className="text-zinc-200 font-medium">Hard Rock Bet</span> is the default priority sportsbook.
            </p>
          </div>
          <div className="flex gap-2">
            <button
              onClick={selectAll}
              className="rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-[11px] text-zinc-300 hover:bg-zinc-700"
            >
              Select all
            </button>
            <button
              onClick={resetDefault}
              className="rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-[11px] text-zinc-300 hover:bg-zinc-700"
            >
              Reset to default
            </button>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2">
          {ALL_BOOKS.map((b) => {
            const checked = selectedBooks.has(b.key);
            return (
              <label
                key={b.key}
                className={`flex items-center gap-2 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${
                  checked
                    ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-200"
                    : "border-zinc-800 bg-zinc-950/40 text-zinc-300 hover:border-zinc-700"
                }`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggleBook(b.key)}
                  className="h-4 w-4 rounded border-zinc-700 bg-zinc-800 text-emerald-500 focus:ring-emerald-500/30"
                />
                <span className="text-sm font-medium truncate" title={b.label}>{b.label}</span>
              </label>
            );
          })}
        </div>

        <div className="mt-3 flex items-center justify-between flex-wrap gap-2 text-xs text-zinc-500">
          <span>
            {selectedBooks.size} of {ALL_BOOKS.length} books selected.
          </span>
          {savedAt != null && <span className="text-emerald-400/80">Saved locally ✓</span>}
        </div>
        <p className="mt-2 text-xs text-zinc-500">
          Saved locally for now. Will sync to your account once auth ships.
        </p>
      </section>

      {/* Betting Bankroll (D-060) + Kelly Aggressiveness (May 5) */}
      <section className="rounded-xl border border-zinc-800 bg-gradient-to-b from-zinc-900 to-zinc-900/60 p-5">
        <div>
          <h2 className="text-base font-semibold text-zinc-100">Betting Bankroll</h2>
          <p className="text-xs text-zinc-400 mt-0.5 max-w-2xl">
            Used by the Kelly stake-sizing recommender on every Log Bet. Set this to your actual bankroll on Hard Rock Bet (or your primary book). Update manually as your bankroll grows or shrinks.
          </p>
        </div>

        <div className="mt-4 flex items-center gap-2 flex-wrap">
          <span className="text-zinc-400 text-sm">$</span>
          <input
            type="number"
            inputMode="decimal"
            min="0"
            step="any"
            value={bankrollInput}
            onChange={(e) => setBankrollInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") saveBankroll(); }}
            placeholder="1000"
            className="rounded-lg border border-zinc-700 bg-zinc-950/60 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-500/60 focus:outline-none focus:ring-1 focus:ring-emerald-500/30 w-36"
          />
          <button
            onClick={saveBankroll}
            className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-xs font-medium text-zinc-300 hover:bg-zinc-700"
          >
            Save
          </button>
          {bankrollSavedAt != null && <span className="text-xs text-emerald-400/80">Saved ✓</span>}
          {bankrollError && <span className="text-xs text-red-400">{bankrollError}</span>}
        </div>

        {/* Kelly Aggressiveness — May 5 */}
        <div className="mt-5 pt-4 border-t border-zinc-800/60">
          <div className="flex items-baseline justify-between gap-3 flex-wrap">
            <div>
              <h3 className="text-sm font-semibold text-zinc-200">Kelly Aggressiveness</h3>
              <p className="text-xs text-zinc-400 mt-0.5">Choose how much of full Kelly to stake. Lower = safer; higher = optimal-but-noisier.</p>
            </div>
            {kellyModeSavedAt != null && <span className="text-xs text-emerald-400/80">Saved ✓</span>}
          </div>
          <div className="mt-3 space-y-2">
            {([
              { mode: "quarter" as const, label: "Quarter Kelly — 25% of optimal", note: "Safest option. Smaller bets, less swing. Recommended while the algorithm is still proving itself." },
              { mode: "half"    as const, label: "Half Kelly — 50% of optimal",    note: "Balanced. What most professional bettors use. Bigger bets when the edge is real, but still leaves a safety margin." },
              { mode: "full"    as const, label: "Full Kelly — 100% of optimal",   note: "Maximum growth, maximum swings. Use only if you trust the win-rate numbers exactly. Big losing streaks possible." },
            ]).map((opt) => {
              const selected = kellyMode === opt.mode;
              return (
                <label
                  key={opt.mode}
                  className={`flex items-start gap-3 rounded-lg border px-3 py-2 cursor-pointer transition-colors ${
                    selected ? "border-emerald-500/40 bg-emerald-500/5" : "border-zinc-800 bg-zinc-950/40 hover:bg-zinc-900/50"
                  }`}
                >
                  <input
                    type="radio"
                    name="kelly-fraction"
                    checked={selected}
                    onChange={() => handleKellyModeChange(opt.mode)}
                    className="mt-0.5 accent-emerald-500"
                  />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-zinc-100">{opt.label}</div>
                    <p className="text-xs text-zinc-400 mt-0.5">{opt.note}</p>
                  </div>
                </label>
              );
            })}
          </div>
        </div>

        {/* Discretionary stake — §15.10 Critical #1 Phase 2 (May 12, 2026).
            Default stake applied by "Log All Picks" when a recommendation is
            SKIP_PRICE (Kelly says the price doesn't support an edge but the
            user still wants the row in the tracker). */}
        <div className="mt-5 pt-4 border-t border-zinc-800/60">
          <div className="flex items-baseline justify-between gap-3 flex-wrap">
            <div>
              <h3 className="text-sm font-semibold text-zinc-200">Discretionary stake</h3>
              <p className="text-xs text-zinc-400 mt-0.5 max-w-2xl">
                Default stake when logging non-BET picks via "Log All Picks". Kelly-recommended bets use the Kelly stake; SKIP picks (no edge at price) use this amount. PASS picks log at $0.
              </p>
            </div>
          </div>
          <div className="mt-3 flex items-center gap-2 flex-wrap">
            <span className="text-zinc-400 text-sm">$</span>
            <input
              type="number"
              inputMode="decimal"
              min="0"
              step="any"
              value={discInput}
              onChange={(e) => setDiscInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") saveDiscretionaryStake(); }}
              placeholder="5"
              className="rounded-lg border border-zinc-700 bg-zinc-950/60 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-500/60 focus:outline-none focus:ring-1 focus:ring-emerald-500/30 w-36"
            />
            <button
              onClick={saveDiscretionaryStake}
              className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-xs font-medium text-zinc-300 hover:bg-zinc-700"
            >
              Save
            </button>
            {discSavedAt != null && <span className="text-xs text-emerald-400/80">Saved ✓</span>}
            {discError && <span className="text-xs text-red-400">{discError}</span>}
          </div>
        </div>

        <div className="mt-4 rounded-lg border border-zinc-800 bg-zinc-950/40 p-3 text-[11px] text-zinc-400 leading-relaxed">
          <p className="text-zinc-300 font-medium mb-1">How stakes are sized</p>
          <p>
            Your bets max out at <span className="text-zinc-200">{Math.round(MAX_BET_PCT * 100)}% of your bankroll</span>, rounded to the nearest <span className="text-zinc-200">${ROUND_TO}</span>. Your current setting is <span className="text-zinc-200 capitalize">{kellyMode} Kelly</span>, so recommendations are <span className="text-zinc-200">{kellyFractionPct}%</span> of the most aggressive option.
          </p>
          <p className="mt-2">
            Some picks show $0 — that means the price isn't good enough to justify a bet, even though the confidence looks high. You can always override and bet anyway.
          </p>
          <p className="mt-2">
            Win rates are based on how often each confidence level has actually hit in the past, not just the confidence number itself.
          </p>
        </div>
      </section>

      {/* Account */}
      <section className="rounded-xl border border-zinc-800 bg-gradient-to-b from-zinc-900 to-zinc-900/60 p-5">
        <h2 className="text-base font-semibold text-zinc-100">Account</h2>
        <p className="text-xs text-zinc-400 mt-0.5">Signed in via magic link. Manage your subscription below.</p>
        <div className="mt-4 divide-y divide-zinc-800/60">
          <div className="flex items-baseline justify-between gap-3 py-2">
            <span className="text-sm text-zinc-300">Email</span>
            <span className="text-sm text-zinc-100 font-medium">{session?.user?.email ?? "—"}</span>
          </div>
          <div className="flex items-baseline justify-between gap-3 py-2">
            <span className="text-sm text-zinc-300">Account ID</span>
            <button
              onClick={copyAccountId}
              title="Click to copy"
              className="text-xs text-zinc-400 font-mono hover:text-zinc-200 cursor-pointer truncate max-w-[60%]"
            >
              {session?.user?.id ?? "—"} <span className="text-zinc-600">{copied ? "✓ copied" : "(click to copy)"}</span>
            </button>
          </div>
          <div className="flex items-baseline justify-between gap-3 py-2">
            <span className="text-sm text-zinc-300">Subscription</span>
            <span className="text-sm text-zinc-100">{subscriptionLabel(gate)}</span>
          </div>
        </div>
        <button
          onClick={signOut}
          className="mt-4 rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700"
        >
          Sign out
        </button>
      </section>

      {/* Notifications */}
      <section className="rounded-xl border border-zinc-800 bg-gradient-to-b from-zinc-900 to-zinc-900/60 p-5 opacity-70">
        <h2 className="text-base font-semibold text-zinc-100">Notifications</h2>
        <p className="text-xs text-zinc-400 mt-0.5">Notification preferences ship with subscriber launch.</p>
        <div className="mt-4 space-y-2">
          <ToggleRow label="Push notifications for 75+ confidence picks" />
          <ToggleRow label="Daily algorithm summary email" />
          <ToggleRow label="Weekly performance report" />
        </div>
      </section>
    </div>
  );
}

function ToggleRow({ label }: { label: string }) {
  return (
    <label className="flex items-center justify-between gap-3 py-1.5 cursor-not-allowed">
      <span className="text-sm text-zinc-300">{label}</span>
      <div className="flex items-center gap-2">
        <span className="text-xs text-zinc-500">(soon)</span>
        <input
          type="checkbox"
          disabled
          className="h-4 w-4 rounded border-zinc-700 bg-zinc-800 text-emerald-500 opacity-50 cursor-not-allowed"
        />
      </div>
    </label>
  );
}
