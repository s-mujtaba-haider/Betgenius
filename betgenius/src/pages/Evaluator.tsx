import { useState, useEffect, useRef } from "react";
import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from "@/lib/supabase";
import { useAuthSession } from "@/lib/auth";
import { readStoredSport, type Sport } from "@/lib/sport";
import { SportSelector } from "@/components/SportSelector";
import PickCard from "@/components/PickCard";
import type { BetPrefill } from "@/App";

// D-270-H5 — sport-aware prop_type lists.
// NBA: matches the canonical scoring.ts set + Tracker.
// MLB: 5 player markets actually written to props_cache after the
// fetch-odds-mlb prefix-strip (batter_* → *) plus pitcher_strikeouts which
// is kept verbatim. recommendations_cache rows for MLB use these values.
const PROP_TYPES_BY_SPORT: Record<Sport, { value: string; label: string }[]> = {
  nba: [
    { value: "points", label: "Points" },
    { value: "rebounds", label: "Rebounds" },
    { value: "assists", label: "Assists" },
    { value: "threes", label: "Threes" },
    { value: "steals", label: "Steals" },
    { value: "blocks", label: "Blocks" },
  ],
  mlb: [
    { value: "hits", label: "Hits" },
    { value: "home_runs", label: "Home Runs" },
    { value: "total_bases", label: "Total Bases" },
    { value: "rbis", label: "RBIs" },
    { value: "pitcher_strikeouts", label: "Pitcher Strikeouts" },
  ],
};

// HRB-first book priority for autofill. Falls back to DK / FD / first-seen.
const AUTOFILL_PRIORITY = ["hardrockbet", "hardrockbet_fl", "hardrockbet_az", "draftkings", "fanduel"];

interface PlayerSuggestion {
  id: string;
  displayName: string;
  description?: string;
  teamAbbr?: string;
}

// NBA team name to abbreviation mapping
const TEAM_ABBR_MAP: Record<string, string> = {
  "atlanta hawks": "ATL", "boston celtics": "BOS", "brooklyn nets": "BKN",
  "charlotte hornets": "CHA", "chicago bulls": "CHI", "cleveland cavaliers": "CLE",
  "dallas mavericks": "DAL", "denver nuggets": "DEN", "detroit pistons": "DET",
  "golden state warriors": "GSW", "houston rockets": "HOU", "indiana pacers": "IND",
  "la clippers": "LAC", "los angeles clippers": "LAC", "los angeles lakers": "LAL",
  "la lakers": "LAL", "memphis grizzlies": "MEM", "miami heat": "MIA",
  "milwaukee bucks": "MIL", "minnesota timberwolves": "MIN", "new orleans pelicans": "NOP",
  "new york knicks": "NYK", "oklahoma city thunder": "OKC", "orlando magic": "ORL",
  "philadelphia 76ers": "PHI", "phoenix suns": "PHX", "portland trail blazers": "POR",
  "sacramento kings": "SAC", "san antonio spurs": "SAS", "toronto raptors": "TOR",
  "utah jazz": "UTA", "washington wizards": "WAS",
};

// @ts-ignore
function _getTeamAbbr(description: string): string {
  if (!description) return "";
  const normalized = description.toLowerCase().trim();

  // Check for exact match first
  if (TEAM_ABBR_MAP[normalized]) {
    return TEAM_ABBR_MAP[normalized];
  }

  // Search for team name within the description (handles "PG · Boston Celtics" etc.)
  for (const [teamName, abbr] of Object.entries(TEAM_ABBR_MAP)) {
    if (normalized.includes(teamName)) {
      return abbr;
    }
  }

  return "";
}

// Duplicated from Dashboard.tsx (line 5 and elsewhere) so Evaluator's
// LineShoppingSection stays self-contained per CEO instruction.
type AvailableBook = {
  bookmaker: string;
  line: number;
  odds: number;
  pick_side: string;
};

interface MiniRec {
  pickSide: "over" | "under";
  line: number;
  bookmaker: string | null;
  availableBooks: AvailableBook[];
}

// One row in props_cache as we need it. props_cache uses `last_seen` as the
// most-recent-update timestamp (refreshed every fetch-odds tick) and
// `first_seen` for the initial sighting. We sort by last_seen to surface
// freshest quotes.
interface PropsCacheRow {
  player_name: string;
  prop_type: string;
  line: number;
  pick_side: string;
  odds: number;
  bookmaker: string;
  last_seen: string;
}

interface AutofillSource {
  bookmaker: string;
  line: number;
  odds: number;
  pickSide: string;
  lastSeen: string;
  // All sibling rows for this (player, prop) keyed by side+line+book — used to
  // build availableBooks for the LineShoppingSection after Analyze runs.
  siblings: PropsCacheRow[];
}

interface AnalysisResult {
  playerName: string;
  team: string;
  propType: string;
  line: number;
  pickSide: "over" | "under";
  confidenceScore: number;
  label: string;
  hitRates: { l5: string; l10: string; season: string };
  stats: { floor: number; ceiling: number; seasonAvg: number; recentAvg: number };
  factors: Record<string, number>;
  aiAnalysis?: string | null;
  // Game context
  opponent?: string | null;
  gameTime?: string | null;
  isHome?: boolean | null;
  odds?: number;
  // New edge data
  backToBack?: boolean;
  restDays?: number;
  minutesTrend?: {
    l5Avg: number;
    l10Avg: number;
    direction: "up" | "down" | "stable";
  };
  // D-179 (May 15-16, 2026): analyze-pick now reports backend-cache hit
  // status across player_game_logs + opponent_defensive_stats + team_metadata.
  cacheStatus?: "full" | "partial" | "miss";
  cacheSources?: {
    playerGameLog: boolean;
    opponentStats: boolean;
    teamMetadata: boolean;
  };
}

interface EvaluatorProps {
  onLogBet?: (data: BetPrefill) => void;
}

export default function Evaluator({ onLogBet }: EvaluatorProps) {
  const { session, isAdmin } = useAuthSession();
  // D-350 — read-only mode for non-admin (friend preview).
  const readOnly = !isAdmin;
  const readOnlyTip = "Preview mode — full access requires subscription";
  // D-270-H5 — sport switcher. Shared localStorage key with Dashboard /
  // Performance / Games / Tracker. Cross-tab sync via storage event.
  const [sport, setSport] = useState<Sport>(() => readStoredSport());
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key !== "betgenius_user_sport" || e.newValue == null) return;
      setSport(e.newValue === "mlb" ? "mlb" : "nba");
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const [playerName, setPlayerName] = useState("");
  const [propType, setPropType] = useState<string>(() => PROP_TYPES_BY_SPORT[readStoredSport()][0].value);
  const [line, setLine] = useState("");
  const [odds, setOdds] = useState("");
  const [pickSide, setPickSide] = useState<"over" | "under" | null>(null);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AnalysisResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Where the displayed result came from. "cache" = same row Dashboard sees;
  // "live" = fell through to analyze-pick edge function (analyze-pick uses a
  // DIFFERENT scoring function than process-games — this is C8 in §15.1).
  // D-161 (May 14, 2026): resultSource now carries `cacheKind` to distinguish
  // exact vs fuzzy cache hits, plus `cachedLine` so the caption can surface
  // line-delta when fuzzy-matched.
  const [resultSource, setResultSource] = useState<
    | { kind: "cache"; cacheKind: "exact" | "fuzzy"; createdAt?: string; cachedLine?: number }
    | { kind: "live" }
    | null
  >(null);
  // Books-by-side snapshot from cache row (when cache hit). Used for line
  // shopping render. Cache row's `available_books` JSONB is the same shape
  // LineShoppingSection wants, so this bypasses the props_cache→autofillSource
  // path entirely on cache hits.
  const [resultAvailableBooks, setResultAvailableBooks] = useState<AvailableBook[] | null>(null);
  const [resultBookmaker, setResultBookmaker] = useState<string | null>(null);

  // Player autocomplete state
  const [suggestions, setSuggestions] = useState<PlayerSuggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [selectedValue, setSelectedValue] = useState<string | null>(null); // Track the selected value to prevent re-search
  const debounceRef = useRef<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Autofill state (Feature A)
  const [autofillSource, setAutofillSource] = useState<AutofillSource | null>(null);
  const [autofillStatus, setAutofillStatus] = useState<"idle" | "loading" | "no_match" | "ok">("idle");
  const [manualOverride, setManualOverride] = useState(false);
  const autofillRequestRef = useRef(0); // Tracks active fetch to discard stale responses on rapid input changes.

  // D-270-H5 — when sport changes, reset propType to the new sport's first
  // allowed value. Skips when current value is already valid (preserves user
  // selection across re-renders).
  useEffect(() => {
    const allowed = PROP_TYPES_BY_SPORT[sport].map((p) => p.value);
    if (!allowed.includes(propType)) {
      setPropType(allowed[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sport]);

  // userBooks for LineShoppingSection (Feature C). Same pattern as Dashboard.
  const [userBooks, setUserBooks] = useState<string[]>(() => {
    try {
      const stored = localStorage.getItem("betgenius_user_books");
      const arr = stored ? JSON.parse(stored) : null;
      return Array.isArray(arr) && arr.length > 0 ? arr : ["hardrockbet"];
    } catch { return ["hardrockbet"]; }
  });
  useEffect(() => {
    function handler(e: StorageEvent) {
      if (e.key !== "betgenius_user_books" || e.newValue == null) return;
      try {
        const arr = JSON.parse(e.newValue);
        if (Array.isArray(arr) && arr.length > 0) setUserBooks(arr);
      } catch { /* ignore */ }
    }
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);

  // Autofill effect (Feature A): when player AND propType are set, query
  // props_cache and pre-fill line + odds. Skips if user manually overrode.
  // pickSide is included in deps so flipping over↔under updates the odds.
  useEffect(() => {
    // Bail conditions.
    if (manualOverride) return;
    if (!selectedValue) {
      // No committed player yet (typed but not picked from dropdown).
      setAutofillSource(null);
      setAutofillStatus("idle");
      return;
    }
    if (!propType) return;

    const reqId = ++autofillRequestRef.current;
    setAutofillStatus("loading");

    // D-270-H5 — sport-aware props_cache lookup. Pre-D-270 this hardcoded
    // sport=eq.nba which would silently skip MLB rows even when the dropdown
    // surfaced an MLB prop_type (e.g. "hits"). Now driven by the current
    // sport state from the SportSelector.
    const url = `${SUPABASE_URL}/rest/v1/props_cache?player_name=ilike.${encodeURIComponent(selectedValue)}&prop_type=eq.${encodeURIComponent(propType)}&sport=eq.${sport}&order=last_seen.desc&limit=50&select=player_name,prop_type,line,pick_side,odds,bookmaker,last_seen`;
    fetch(url, {
      // Session JWT for RLS — props_cache is TO authenticated USING (true)
      // post-RLS migration (Apr 30 commit d9ce8d8). Anon would return [].
      // Falls back to anon key for the no-session edge case (theoretical
      // since AuthGate gates the whole app, but defensive).
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${session?.access_token ?? SUPABASE_ANON_KEY}`,
      },
    })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`props_cache ${r.status}`))))
      .then((rows: PropsCacheRow[]) => {
        if (reqId !== autofillRequestRef.current) return; // stale
        if (!rows || rows.length === 0) {
          setAutofillSource(null);
          setAutofillStatus("no_match");
          return;
        }
        // If user has already chosen a side, prefer rows on that side; else
        // use the most recent row regardless of side and present its line.
        const sidedRows = pickSide ? rows.filter((r) => r.pick_side === pickSide) : rows;
        const candidatePool = sidedRows.length > 0 ? sidedRows : rows;
        // Pick by HRB priority. Within the same book, the array is already
        // sorted by last_seen DESC.
        let best: PropsCacheRow | null = null;
        for (const bk of AUTOFILL_PRIORITY) {
          const found = candidatePool.find((r) => r.bookmaker === bk);
          if (found) { best = found; break; }
        }
        if (!best) best = candidatePool[0]; // fallback: most recent of any book

        setAutofillSource({
          bookmaker: best.bookmaker,
          line: best.line,
          odds: best.odds,
          pickSide: best.pick_side,
          lastSeen: best.last_seen,
          siblings: rows,
        });
        // Pre-fill the inputs.
        setLine(String(best.line));
        setOdds(String(best.odds));
        setAutofillStatus("ok");
      })
      .catch(() => {
        if (reqId !== autofillRequestRef.current) return;
        setAutofillSource(null);
        setAutofillStatus("no_match");
      });
    // D-270-H5 — sport in deps so switching NBA→MLB (or back) re-queries
    // props_cache with the new sport filter.
  }, [selectedValue, propType, pickSide, manualOverride, sport]);

  // Debounced player search
  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    // Don't search if this is the selected value (prevents re-triggering after selection)
    if (selectedValue && playerName === selectedValue) {
      return;
    }

    // Clear selected value if user starts typing something different
    if (selectedValue && playerName !== selectedValue) {
      setSelectedValue(null);
      // Also clear autofill state — they're starting a different player.
      setAutofillSource(null);
      setAutofillStatus("idle");
      setManualOverride(false);
    }

    if (playerName.length < 3) {
      setSuggestions([]);
      setShowSuggestions(false);
      return;
    }

    debounceRef.current = window.setTimeout(async () => {
      setSearchLoading(true);
      try {
        const url = `https://site.web.api.espn.com/apis/common/v3/search?query=${encodeURIComponent(playerName)}&limit=5&mode=prefix&type=player`;
        const res = await fetch(url);
        if (res.ok) {
          const data = await res.json();
          const items = data?.items ?? [];
          const players: PlayerSuggestion[] = items.map((item: Record<string, unknown>) => {
            const teamRel = (item.teamRelationships as any)?.[0];
            const teamAbbr = teamRel?.core?.abbreviation ?? "";

            // teamName removed - using teamAbbr directly
            return {
              id: String(item.id ?? ""),
              displayName: String(item.displayName ?? item.title ?? item.name ?? ""),
              description: teamRel?.displayName ?? "",
              teamAbbr: teamAbbr,
            };
          }).filter((p: PlayerSuggestion) => p.displayName);
          setSuggestions(players);
          setShowSuggestions(players.length > 0);
        }
      } catch {
        // Silently fail on search errors
      } finally {
        setSearchLoading(false);
      }
    }, 300);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
      }
    };
  }, [playerName, selectedValue]);

  function handleSelectSuggestion(suggestion: PlayerSuggestion) {
    // Set selected value to prevent re-search for this exact name
    setSelectedValue(suggestion.displayName);
    setPlayerName(suggestion.displayName);
    setSuggestions([]);
    setShowSuggestions(false);
    // Reset override on player change so autofill kicks in fresh.
    setManualOverride(false);
    // Blur input to close any focus state
    inputRef.current?.blur();
  }

  function handleOverride() {
    setManualOverride(true);
    setAutofillSource(null);
    setAutofillStatus("idle");
    setLine("");
    setOdds("");
  }

  // Cache-first analyze. process-games' nightly cron writes every scored
  // prop to recommendations_cache; that's the SAME row Dashboard renders.
  // Reading it here gives us the same confidence number the rest of the app
  // shows AND zero API cost.
  //
  // D-155 (May 14, 2026): analyze-pick + process-games now share
  // _shared/scoring.ts. The residual cache-vs-live delta is D-137/D-139
  // game-line factors (analyze-pick depends on cache_game_lines being
  // populated via D-156 fetch path).
  //
  // D-161 (May 14, 2026): adds fuzzy-line fallback. Exact line match
  // tried first; on miss, fetch player+prop+side+date rows with line
  // within ±0.5 and pick the closest. Caption surfaces line-delta so
  // user can decide.
  async function fetchCachedAnalysis(): Promise<{
    result: AnalysisResult;
    createdAt: string;
    availableBooks: AvailableBook[] | null;
    bookmaker: string | null;
    cacheKind: "exact" | "fuzzy";
    cachedLine: number;
  } | null> {
    try {
      // ET game_date for "today" — matches process-games' write convention.
      // D-162 (May 14, 2026): DST-safe ET via toLocaleString. Pre-D-162
      // raw -4h offset was wrong in winter (EST = UTC-5) for 04:00-04:59 UTC.
      const now = new Date();
      const easternStr = now.toLocaleString('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
      const todayYmd = easternStr.replace(/-/g, ""); // 'en-CA' returns YYYY-MM-DD
      // D-270-H5 — prefer in-component sport state so a switcher click reflects
      // immediately without waiting for the storage event to round-trip.
      // readStoredSport() retained as fallback semantic match for earlier behavior.
      const sportFilter = sport ?? readStoredSport();
      const userLine = parseFloat(line);

      const baseUrl =
        `${SUPABASE_URL}/rest/v1/recommendations_cache?` +
        `player_name=ilike.${encodeURIComponent(playerName)}&` +
        `prop_type=eq.${encodeURIComponent(propType)}&` +
        `pick_side=eq.${pickSide}&` +
        `game_date=eq.${todayYmd}&` +
        `sport=eq.${sportFilter}&` +
        `select=*`;
      const headers = {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${session?.access_token ?? SUPABASE_ANON_KEY}`,
      };

      // Pass 1: exact match. Keep the fast path.
      const exactUrl = `${baseUrl}&line=eq.${userLine}&order=created_at.desc&limit=1`;
      let row: Record<string, unknown> | null = null;
      let cacheKind: "exact" | "fuzzy" = "exact";
      const exactRes = await fetch(exactUrl, { headers });
      if (exactRes.ok) {
        const rows = (await exactRes.json()) as Array<Record<string, unknown>>;
        if (Array.isArray(rows) && rows.length > 0) row = rows[0];
      }

      // Pass 2: fuzzy fallback within ±0.5.
      if (!row) {
        const lo = userLine - 0.5;
        const hi = userLine + 0.5;
        const fuzzyUrl = `${baseUrl}&line=gte.${lo}&line=lte.${hi}&order=created_at.desc&limit=20`;
        const fuzzyRes = await fetch(fuzzyUrl, { headers });
        if (fuzzyRes.ok) {
          const rows = (await fuzzyRes.json()) as Array<Record<string, unknown>>;
          if (Array.isArray(rows) && rows.length > 0) {
            // Pick the row with the smallest |cachedLine − userLine|.
            // On tie, the newest created_at wins (rows already ordered desc).
            let best = rows[0];
            let bestDelta = Math.abs(Number(best.line ?? 0) - userLine);
            for (const r2 of rows.slice(1)) {
              const d = Math.abs(Number(r2.line ?? 0) - userLine);
              if (d < bestDelta) { best = r2; bestDelta = d; }
            }
            row = best;
            cacheKind = "fuzzy";
          }
        }
      }

      if (!row) return null;

      // Map cache row → AnalysisResult shape. Every field has a 1:1 source
      // in recommendations_cache (verified via Apr 30 audit probe).
      const hitRatesDisplay = (row.hit_rates_display as { l5?: string; l10?: string; season?: string } | null) ?? {};
      const breakdown = (row.breakdown as Record<string, number> | null) ?? {};
      const minutesDirection = (row.minutes_trend as string | null) ?? "stable";
      const cachedLine = Number(row.line ?? 0);
      const result: AnalysisResult = {
        playerName: String(row.player_name ?? ""),
        team: String(row.team ?? ""),
        propType: String(row.prop_type ?? ""),
        line: cachedLine,
        pickSide: (row.pick_side as "over" | "under") ?? "over",
        confidenceScore: Number(row.confidence ?? 0),
        label: String(row.verdict ?? ""),
        hitRates: {
          l5: hitRatesDisplay.l5 ?? "—",
          l10: hitRatesDisplay.l10 ?? "—",
          season: hitRatesDisplay.season ?? "—",
        },
        stats: {
          floor: Number(row.floor_val ?? 0),
          ceiling: Number(row.ceiling_val ?? 0),
          seasonAvg: Number(row.season_avg ?? 0),
          recentAvg: Number(row.recent_avg ?? 0),
        },
        factors: breakdown,
        aiAnalysis: (row.ai_analysis as string | null) ?? null,
        opponent: (row.opponent as string | null) ?? null,
        gameTime: (row.game_time as string | null) ?? null,
        isHome: (row.is_home as boolean | null) ?? null,
        odds: Number(row.odds ?? -110),
        backToBack: Boolean(row.is_b2b ?? false),
        restDays: row.rest_days != null ? Number(row.rest_days) : undefined,
        minutesTrend: {
          l5Avg: Number(row.minutes_l5_avg ?? 0),
          l10Avg: Number(row.minutes_l10_avg ?? 0),
          direction: (minutesDirection === "up" || minutesDirection === "down") ? minutesDirection : "stable",
        },
      };
      const availableBooks = (row.available_books as AvailableBook[] | null) ?? null;
      return {
        result,
        createdAt: String(row.created_at ?? ""),
        availableBooks,
        bookmaker: (row.bookmaker as string | null) ?? null,
        cacheKind,
        cachedLine,
      };
    } catch {
      return null;
    }
  }

  async function handleAnalyze() {
    if (!pickSide) return;
    // D-350 — block expensive analyze-pick call in read-only (friend preview) mode.
    if (readOnly) return;

    setLoading(true);
    setError(null);
    setResult(null);
    setResultSource(null);
    setResultAvailableBooks(null);
    setResultBookmaker(null);
    setShowSuggestions(false);

    try {
      // 1) Try cache first — same score Dashboard shows, zero API cost.
      const cached = await fetchCachedAnalysis();
      if (cached) {
        setResult(cached.result);
        // D-161: surface fuzzy-vs-exact + the cached line for the caption.
        setResultSource({
          kind: "cache",
          cacheKind: cached.cacheKind,
          createdAt: cached.createdAt,
          cachedLine: cached.cachedLine,
        });
        setResultAvailableBooks(cached.availableBooks);
        setResultBookmaker(cached.bookmaker);
        return;
      }

      // 2) Fall through: live analyze-pick. Post-D-155 + D-156, this uses
      // the SAME scoring math as Dashboard via _shared/scoring.ts. The only
      // residual delta is D-137/D-139 game-line factors when
      // cache_game_lines hasn't been pre-warmed for the matchup.
      // D-270-H5 — sport-aware analyze-pick body. The edge function's
      // getSportPath() expects "basketball"|"baseball"|"football"|"hockey";
      // hardcoded "basketball" pre-D-270 meant MLB lookups would still hit
      // ESPN's NBA athlete index.
      const sportForApi = sport === "mlb" ? "baseball" : "basketball";
      const { data, error: fnError } = await supabase.functions.invoke("analyze-pick", {
        body: {
          playerName,
          sport: sportForApi,
          propType,
          line: parseFloat(line),
          pickSide,
          odds: odds ? parseFloat(odds) : -110,
        },
      });

      if (fnError) {
        setError(fnError.message);
        return;
      }

      if (data?.error) {
        setError(data.error);
        return;
      }

      setResult(data as AnalysisResult);
      setResultSource({ kind: "live" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to analyze pick");
    } finally {
      setLoading(false);
    }
  }

  const canAnalyze = playerName.trim() && line && pickSide && !loading;

  // Build a MiniRec for LineShoppingSection. Prefer cache's available_books
  // (always populated when cron scored this prop today, more comprehensive
  // than props_cache's current snapshot). Fall back to autofillSource on
  // live analysis paths.
  const miniRecForShopping: MiniRec | null = (() => {
    if (!result || manualOverride) return null;

    // Cache hit — use the row's snapshotted available_books.
    if (resultAvailableBooks && resultAvailableBooks.length > 0) {
      return {
        pickSide: result.pickSide,
        line: result.line,
        bookmaker: resultBookmaker,
        availableBooks: resultAvailableBooks,
      };
    }

    // Live fall-through — use autofillSource siblings, gated on line match.
    if (!autofillSource) return null;
    if (parseFloat(line) !== autofillSource.line) return null;
    const availableBooks: AvailableBook[] = autofillSource.siblings.map((r) => ({
      bookmaker: r.bookmaker,
      line: r.line,
      odds: r.odds,
      pick_side: r.pick_side,
    }));
    return {
      pickSide: result.pickSide,
      line: result.line,
      bookmaker: autofillSource.bookmaker,
      availableBooks,
    };
  })();

  const autofillCaption = (() => {
    if (manualOverride) return null;
    if (autofillStatus === "loading") return "Looking up current line…";
    if (autofillStatus === "no_match") return "No current line cached for this prop. Enter manually.";
    if (autofillStatus === "ok" && autofillSource) {
      const ago = formatRelativeTime(autofillSource.lastSeen);
      return `Auto-filled from ${bookDisplayName(autofillSource.bookmaker)} · ${ago}`;
    }
    return null;
  })();

  return (
    <div className="space-y-8">
      {/* Input Form */}
      <form autoComplete="off" onSubmit={(e) => e.preventDefault()} className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6 space-y-5">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <h2 className="text-lg font-medium text-zinc-200">Evaluate a Pick</h2>
          {/* D-270-H5 — sport switcher; same component used on Dashboard. */}
          <SportSelector value={sport} onChange={setSport} />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          {/* Player Name with Autocomplete */}
          <div className="space-y-1.5 relative">
            <label className="text-xs text-zinc-500">Player</label>
            <div className="relative">
              <input
                ref={inputRef}
                type="text"
                placeholder="Enter player name..."
                value={playerName}
                onChange={(e) => setPlayerName(e.target.value)}
                onFocus={() => suggestions.length > 0 && playerName !== selectedValue && setShowSuggestions(true)}
                onBlur={() => setTimeout(() => setShowSuggestions(false), 200)}
                autoComplete="off"
                className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white placeholder-zinc-500 outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
              />
              {searchLoading && (
                <div className="absolute right-3 top-1/2 -translate-y-1/2">
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-zinc-600 border-t-emerald-500" />
                </div>
              )}
            </div>
            {/* Suggestions Dropdown */}
            {showSuggestions && suggestions.length > 0 && (
              <div className="absolute z-50 mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-800 shadow-lg overflow-hidden">
                {suggestions.map((suggestion) => (
                  <button
                    key={suggestion.id}
                    type="button"
                    onClick={() => handleSelectSuggestion(suggestion)}
                    className="w-full px-3 py-2 text-left text-sm hover:bg-zinc-700 transition-colors flex items-center gap-2"
                  >
                    <span className="text-white">{suggestion.displayName}</span>
                    {suggestion.teamAbbr && (
                      <span className="text-zinc-400 text-sm">— {suggestion.teamAbbr}</span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Prop Type */}
          <div className="space-y-1.5">
            <label className="text-xs text-zinc-500">Prop Type</label>
            <select
              value={propType}
              onChange={(e) => setPropType(e.target.value)}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
            >
              {PROP_TYPES_BY_SPORT[sport].map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </div>

          {/* Line */}
          <div className="space-y-1.5">
            <label className="text-xs text-zinc-500">Line</label>
            <input
              type="number"
              step="0.5"
              placeholder="24.5"
              value={line}
              onChange={(e) => { setLine(e.target.value); setManualOverride(true); }}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white placeholder-zinc-500 outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
            />
          </div>

          {/* Odds */}
          <div className="space-y-1.5">
            <label className="text-xs text-zinc-500">Odds</label>
            <input
              type="number"
              placeholder="-110"
              value={odds}
              onChange={(e) => { setOdds(e.target.value); setManualOverride(true); }}
              className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white placeholder-zinc-500 outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
            />
          </div>

          {/* Pick Side */}
          <div className="space-y-1.5 sm:col-span-2">
            <label className="text-xs text-zinc-500">Side</label>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setPickSide("over")}
                className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                  pickSide === "over"
                    ? "border-emerald-500 bg-emerald-500/20 text-emerald-400"
                    : "border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-zinc-600"
                }`}
              >
                Over
              </button>
              <button
                type="button"
                onClick={() => setPickSide("under")}
                className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                  pickSide === "under"
                    ? "border-red-500 bg-red-500/20 text-red-400"
                    : "border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-zinc-600"
                }`}
              >
                Under
              </button>
            </div>
          </div>
        </div>

        {/* Autofill caption */}
        {autofillCaption && (
          <div className="flex items-center justify-between flex-wrap gap-2 -mt-2 text-[11px]">
            <span className={
              autofillStatus === "ok" ? "text-emerald-400/80" :
              autofillStatus === "loading" ? "text-zinc-500" :
              "text-zinc-500"
            }>
              {autofillCaption}
            </span>
            {autofillStatus === "ok" && !manualOverride && (
              <button
                type="button"
                onClick={handleOverride}
                disabled={readOnly}
                title={readOnly ? readOnlyTip : undefined}
                className="text-zinc-500 hover:text-zinc-300 underline transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                Override
              </button>
            )}
          </div>
        )}

        <button
          type="button"
          onClick={handleAnalyze}
          disabled={!canAnalyze || readOnly}
          title={readOnly ? readOnlyTip : undefined}
          className="w-full rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed"
        >
          {loading ? "Analyzing..." : "Analyze"}
        </button>
      </form>

      {/* Results */}
      {loading && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-8 text-center">
          <div className="inline-block h-6 w-6 animate-spin rounded-full border-2 border-zinc-600 border-t-emerald-500 mb-3" />
          <p className="text-zinc-400 text-sm">Analyzing {playerName}...</p>
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-6 text-center">
          <p className="text-red-400 text-sm">{error}</p>
        </div>
      )}

      {result && (
        <div className="space-y-4">
          {/* D-161 (May 14, 2026): three-state source caption.
              - cache/exact: same row Dashboard reads.
              - cache/fuzzy: closest line within ±0.5 — shows delta.
              - live: analyze-pick uses the SAME scoring as Dashboard post-D-155;
                only D-137/D-139 game-line factors can diverge (data-availability,
                not scoring math). */}
          {resultSource && (
            <div className={`rounded-lg border px-3 py-2 text-[11px] ${
              resultSource.kind === "cache" && resultSource.cacheKind === "exact"
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200"
                : resultSource.kind === "cache"
                ? "border-sky-500/30 bg-sky-500/10 text-sky-200"
                : "border-amber-500/30 bg-amber-500/10 text-amber-200"
            }`}>
              {resultSource.kind === "cache" && resultSource.cacheKind === "exact" ? (
                <span>
                  ✓ Score from today's algorithm cache
                  {resultSource.createdAt && <span className="text-emerald-400/70"> · {formatRelativeTime(resultSource.createdAt)}</span>}
                  <span className="text-emerald-400/70"> · same row Dashboard reads</span>
                </span>
              ) : resultSource.kind === "cache" ? (
                <span>
                  ≈ Closest cached pick: line {resultSource.cachedLine} (you entered {parseFloat(line)})
                  {resultSource.createdAt && <span className="text-sky-400/70"> · {formatRelativeTime(resultSource.createdAt)}</span>}
                  <span className="text-sky-400/70"> · score from algorithm cache, line within ±0.5</span>
                </span>
              ) : (
                <span>
                  ⚡ Live analysis — same scoring as Dashboard, minor delta possible on game-line factors if today's lines aren't cached yet.
                  {/* D-179: surface backend-cache hit status when analyze-pick ran live. */}
                  {result.cacheStatus === "full" && (
                    <span className="text-amber-300/70"> · ✓ all data from cache</span>
                  )}
                  {result.cacheStatus === "partial" && result.cacheSources && (
                    <span className="text-amber-300/70"> · ≈ partial cache (
                      {[
                        result.cacheSources.playerGameLog && "player",
                        result.cacheSources.opponentStats && "opponent",
                        result.cacheSources.teamMetadata && "team",
                      ].filter(Boolean).join(" + ")} cached)
                    </span>
                  )}
                  {result.cacheStatus === "miss" && (
                    <span className="text-amber-300/60"> · live ESPN/BDL fetches</span>
                  )}
                </span>
              )}
            </div>
          )}
          <PickCard
            playerName={result.playerName}
            team={result.team}
            propType={result.propType}
            line={result.line}
            pickSide={result.pickSide}
            confidenceScore={result.confidenceScore}
            hitRates={result.hitRates}
            aiAnalysis={result.aiAnalysis}
            // D-202 — pass odds so PickCard can compute + lead with Kelly stake.
            odds={result.odds ?? (odds ? parseFloat(odds) : -110)}
            onLogBet={() => {
              if (onLogBet) {
                onLogBet({
                  playerName: result.playerName,
                  propType: result.propType,
                  line: result.line,
                  pickSide: result.pickSide,
                  odds: result.odds ?? (odds ? parseFloat(odds) : -110),
                });
              }
            }}
            opponent={result.opponent}
            gameTime={result.gameTime}
            isHome={result.isHome}
          />

          {/* Line shopping (Feature C) — only when autofill source is in scope and the user did not override the line. */}
          {miniRecForShopping && (
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
              <h3 className="text-sm font-medium text-zinc-300 mb-1">Line shopping</h3>
              <p className="text-[11px] text-zinc-500 mb-2">Compare books for this exact prop.</p>
              <LineShoppingSection rec={miniRecForShopping} userBooks={userBooks} />
            </div>
          )}

          {/* Detailed Stats */}
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 space-y-4">
            <h3 className="text-sm font-medium text-zinc-300">Stat Breakdown</h3>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <StatBox label="Floor" value={result.stats.floor} />
              <StatBox label="Ceiling" value={result.stats.ceiling} />
              <StatBox label="Season Avg" value={result.stats.seasonAvg} />
              <StatBox label="Recent Avg" value={result.stats.recentAvg} />
            </div>

            {/* Edge info line */}
            {(result.minutesTrend || result.backToBack !== undefined) && (
              <div className="rounded-lg bg-zinc-800/30 px-3 py-2 text-xs text-zinc-400 flex flex-wrap gap-x-4 gap-y-1">
                {result.minutesTrend && (
                  <span>
                    Minutes: {result.minutesTrend.l5Avg} → {result.minutesTrend.l10Avg} min
                    <span className={`ml-1 ${
                      result.minutesTrend.direction === "up" ? "text-emerald-400" :
                      result.minutesTrend.direction === "down" ? "text-red-400" : "text-zinc-500"
                    }`}>
                      ({result.minutesTrend.direction})
                    </span>
                  </span>
                )}
                {result.restDays !== undefined && (
                  <span>Rest: {result.restDays}d</span>
                )}
                {result.backToBack !== undefined && (
                  <span className={result.backToBack ? "text-amber-400" : ""}>
                    B2B: {result.backToBack ? "Yes" : "No"}
                  </span>
                )}
              </div>
            )}

            <h3 className="text-sm font-medium text-zinc-300 pt-2">Scoring Factors</h3>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {Object.entries(result.factors).map(([key, value]) => (
                <div key={key} className="flex items-center justify-between rounded-lg bg-zinc-800/50 px-3 py-2">
                  <span className="text-xs text-zinc-500">{formatFactorName(key)}</span>
                  <span className={`text-xs font-semibold ${value > 0 ? "text-emerald-400" : value < 0 ? "text-red-400" : "text-zinc-500"}`}>
                    {value > 0 ? "+" : ""}{value}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {!loading && !error && !result && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-8 text-center">
          <p className="text-zinc-500 text-sm">Enter a pick above to analyze</p>
        </div>
      )}
    </div>
  );
}

function StatBox({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg bg-zinc-800/50 px-3 py-2 text-center">
      <p className="text-[10px] text-zinc-500 uppercase tracking-wide">{label}</p>
      <p className="text-sm font-semibold text-zinc-200">{value}</p>
    </div>
  );
}

function formatFactorName(key: string): string {
  const names: Record<string, string> = {
    l5HitRate: "L5 Hit Rate",
    l10HitRate: "L10 Hit Rate",
    seasonHitRate: "Season Rate",
    floorAnalysis: "Floor/Ceiling",
    floorCeiling: "Floor/Ceiling",
    recentForm: "Recent Form",
    homeAway: "Home/Away",
    rest: "Rest Days",
    restDays: "Rest",
    backToBack: "B2B",
    minutesTrend: "Min Trend",
    pace: "Pace",
    opponentDefense: "Opp Defense",
    vsOpponent: "vs Opponent",
    oddsValue: "Odds Value",
  };
  return names[key] ?? key;
}

function formatRelativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "just now";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return sec + "s ago";
  const min = Math.round(sec / 60);
  if (min < 60) return min + "m ago";
  const hr = Math.round(min / 60);
  if (hr < 24) return hr + "h ago";
  const day = Math.round(hr / 24);
  return day + "d ago";
}

// =============================================================================
// LineShoppingSection — duplicated from Dashboard.tsx (line 1279) per CEO
// instruction. Internal helpers (BOOK_DISPLAY, bookDisplayName, formatOdds,
// findBestPrice, BestPriceResult) are duplicated below to keep Evaluator
// independent of Dashboard's component file.
// =============================================================================

const BOOK_DISPLAY: Record<string, string> = {
  hardrockbet: "HRB",
  hardrockbet_fl: "HRB FL",
  hardrockbet_az: "HRB AZ",
  draftkings: "DK",
  fanduel: "FD",
  betmgm: "MGM",
  bovada: "Bovada",
  pointsbet: "PointsBet",
  fliff: "Fliff",
  ballybet: "Bally",
  betparx: "BetParx",
  betonlineag: "BetOnline",
  espnbet: "ESPN",
  betrivers: "BetRivers",
  williamhill_us: "Caesars",
  fanatics: "Fanatics",
};

function bookDisplayName(key: string): string {
  if (BOOK_DISPLAY[key]) return BOOK_DISPLAY[key];
  return key
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function formatOdds(odds: number): string {
  return odds >= 0 ? `+${odds}` : String(odds);
}

interface BestPriceResult {
  hrb: AvailableBook | null;
  best: AvailableBook | null;
  deltaCents: number;
  isMaterial: boolean;
  sameLineCandidates: AvailableBook[];
  altLineCandidates: AvailableBook[];
}

function findBestPrice(rec: MiniRec): BestPriceResult | null {
  const books = rec.availableBooks;
  if (!books || books.length === 0) return null;

  const sameSide = books.filter((b) => b.pick_side === rec.pickSide);
  if (sameSide.length === 0) return null;

  const sameLineCandidates = sameSide
    .filter((b) => b.line === rec.line)
    .slice()
    .sort((a, b) => b.odds - a.odds);

  const altLineCandidates = sameSide
    .filter((b) => b.line !== rec.line)
    .slice()
    .sort((a, b) => (a.line - b.line) || (b.odds - a.odds));

  const hrb =
    (rec.bookmaker
      ? sameLineCandidates.find((b) => b.bookmaker === rec.bookmaker)
      : null) ??
    sameLineCandidates.find((b) => b.bookmaker.startsWith("hardrockbet")) ??
    null;

  const best = sameLineCandidates.length > 0 ? sameLineCandidates[0] : null;

  let deltaCents = 0;
  if (hrb && best) deltaCents = best.odds - hrb.odds;

  return {
    hrb,
    best,
    deltaCents,
    isMaterial: Math.abs(deltaCents) >= 5,
    sameLineCandidates,
    altLineCandidates,
  };
}

function LineShoppingSection({ rec, userBooks }: { rec: MiniRec; userBooks: string[] }) {
  const [expanded, setExpanded] = useState(false);
  const userBookSet = new Set(userBooks);
  const result = findBestPrice(rec);
  if (!result) return null;
  const { hrb, sameLineCandidates, altLineCandidates } = result;

  if (sameLineCandidates.length <= 1) {
    if (!hrb) return null;
    return (
      <div className="text-[11px] text-zinc-500">
        {bookDisplayName(hrb.bookmaker)} only · no other books offer this line
      </div>
    );
  }

  const userBest = sameLineCandidates.find((b) => userBookSet.has(b.bookmaker)) ?? null;
  const userBestIsHrb = !!(hrb && userBest && hrb.bookmaker === userBest.bookmaker);
  const userDeltaCents = (userBest && hrb) ? userBest.odds - hrb.odds : 0;
  const showInline = !!(userBest && hrb && !userBestIsHrb && Math.abs(userDeltaCents) >= 5);

  return (
    <div>
      <div className="flex items-center justify-between flex-wrap gap-2">
        {showInline ? (
          <span className="text-[11px] text-zinc-300">
            <span className="text-amber-400">↑</span>{" "}
            Better at <span className="font-semibold text-emerald-400">{bookDisplayName(userBest!.bookmaker)}</span>{" "}
            <span className="font-semibold text-emerald-400">{formatOdds(userBest!.odds)}</span>{" "}
            <span className="text-zinc-500">({userDeltaCents >= 0 ? "+" : ""}{userDeltaCents}¢)</span>
          </span>
        ) : (
          <span className="text-[11px] text-zinc-500">
            {userBestIsHrb && hrb ? `${bookDisplayName(hrb.bookmaker)} best at your books` :
             !userBest && hrb ? `${bookDisplayName(hrb.bookmaker)} only book in your set` :
             hrb ? `${bookDisplayName(hrb.bookmaker)} best at your books` :
             "Compare available books"}
          </span>
        )}
        <button
          onClick={() => setExpanded((v) => !v)}
          className="text-[11px] text-zinc-400 hover:text-zinc-200 transition-colors"
        >
          {expanded ? "Hide books ▲" : `Compare books (${sameLineCandidates.length}${altLineCandidates.length ? `+${altLineCandidates.length}` : ""}) ▼`}
        </button>
      </div>

      {expanded && (
        <div className="mt-2.5 space-y-2.5">
          <div>
            <div className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1">Same line ({rec.line})</div>
            <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
              {sameLineCandidates.map((b) => {
                const isHrb = hrb && b.bookmaker === hrb.bookmaker;
                const isUserBest = userBest && b.bookmaker === userBest.bookmaker;
                const isUserBook = userBookSet.has(b.bookmaker);
                const oddsClass =
                  isUserBest && !userBestIsHrb ? "text-emerald-400 font-semibold" :
                  isHrb ? "text-amber-300" :
                  isUserBook ? "text-zinc-300" :
                  "text-zinc-600";
                return (
                  <div
                    key={`${b.bookmaker}-${b.line}-${b.odds}`}
                    className={`flex items-baseline justify-between gap-2 ${isUserBook ? "" : "opacity-50"}`}
                  >
                    <span
                      className={`truncate ${isHrb ? "text-amber-300 font-medium" : isUserBook ? "text-zinc-400" : "text-zinc-600"}`}
                      title={b.bookmaker}
                    >
                      {bookDisplayName(b.bookmaker)}{isHrb ? " ★" : ""}
                      {!isUserBook && <span className="ml-1 text-[10px] text-zinc-600">✗</span>}
                    </span>
                    <span className={`tabular-nums ${oddsClass}`}>{formatOdds(b.odds)}</span>
                  </div>
                );
              })}
            </div>
          </div>

          {altLineCandidates.length > 0 && (
            <div>
              <div className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1">Other lines</div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[11px]">
                {altLineCandidates.map((b, idx) => {
                  const isUserBook = userBookSet.has(b.bookmaker);
                  return (
                    <div
                      key={`alt-${b.bookmaker}-${b.line}-${b.odds}-${idx}`}
                      className={`flex items-baseline justify-between gap-2 ${isUserBook ? "" : "opacity-50"}`}
                    >
                      <span className={`truncate ${isUserBook ? "text-zinc-400" : "text-zinc-600"}`} title={b.bookmaker}>
                        {bookDisplayName(b.bookmaker)}
                        {!isUserBook && <span className="ml-1 text-[10px] text-zinc-600">✗</span>}
                      </span>
                      <span className={`tabular-nums ${isUserBook ? "text-zinc-300" : "text-zinc-600"}`}>
                        <span className="text-zinc-500 mr-1">{b.line}</span>{formatOdds(b.odds)}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="pt-1 flex items-center justify-between gap-2 text-[10px] text-zinc-500">
            <span>★ HRB · ✗ no account</span>
            <button
              onClick={() => window.dispatchEvent(new CustomEvent("bg:navigate", { detail: "settings" }))}
              className="text-zinc-400 hover:text-zinc-200 underline transition-colors"
            >
              Edit in Settings →
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
