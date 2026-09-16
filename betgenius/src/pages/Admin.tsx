import { useState, useEffect, useMemo } from "react";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "@/lib/supabase";
import { etGameDateYmd } from "@/lib/etDate";
import { useAuthSession } from "@/lib/auth";
import { avgImpliedProb } from "@/lib/odds";
import {
  AreaChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";

// ============================================================
// TYPES
// ============================================================

interface PickHistoryRow {
  id: string;
  player_name: string;
  team: string | null;
  opponent: string | null;
  is_home: boolean | null;
  prop_type: string;
  line: number;
  pick_side: string;
  odds: number;
  confidence: number;
  hit: boolean | null;
  actual_value: number | null;
  voided: boolean | null;
  recommendation_shown: boolean | null;
  game_date: string;
  mlb_market_type?: string | null;
  created_at: string;
  // scoring factors
  score_l5: number | null;
  score_l10: number | null;
  score_season: number | null;
  score_floor_ceiling: number | null;
  score_recent_form: number | null;
  score_home_away: number | null;
  score_rest: number | null;
  score_b2b: number | null;
  score_minutes_trend: number | null;
  score_pace: number | null;
  score_opp_defense: number | null;
  score_odds_value: number | null;
  score_trend: number | null;
  score_z_score: number | null;
  score_role_change: number | null;
  score_vig_filter: number | null;
  score_usg_rate: number | null;
  score_regression: number | null;
  score_market_conf: number | null;
  score_home_away_split: number | null;
  score_minutes_floor: number | null;
  score_consistency: number | null;
  score_prop_type_penalty: number | null;
  score_stale_data: number | null;
  score_player_injury: number | null;
  closing_odds: number | null;
  clv_pct: number | null;
  closing_capture_reason: string | null;
}

type SortKey = "game_date" | "player_name" | "prop_type" | "line" | "pick_side" | "odds" | "confidence" | "hit";
type SortDir = "asc" | "desc";

// ============================================================
// CONSTANTS
// ============================================================

const STAKE = 100; // Display dollars based on $100 unit
// D-548: BREAK_EVEN constant removed — was hardcoded 0.524 (-110 nominal).
// Use src/lib/odds.ts avgImpliedProb for per-set real BE.

// Module-level supabaseHeaders removed Apr 29 — RLS migration requires
// each fetch to carry the user's session JWT in Authorization, not the anon
// key. Each section now computes its own headers via useMemo on session.

// NBA team colors — single primary color per team, used for the team dot indicator
const TEAM_COLORS: Record<string, string> = {
  ATL: "#E03A3E", BOS: "#007A33", BKN: "#4a4a4a", CHA: "#00788C", CHI: "#CE1141",
  CLE: "#860038", DAL: "#00538C", DEN: "#FEC524", DET: "#C8102E", GSW: "#1D428A",
  HOU: "#CE1141", IND: "#FDBB30", LAC: "#C8102E", LAL: "#552583", MEM: "#5D76A9",
  MIA: "#98002E", MIL: "#00471B", MIN: "#236192", NOP: "#C8102E", NYK: "#F58426",
  OKC: "#007AC1", ORL: "#0077C0", PHI: "#006BB6", PHX: "#E56020", POR: "#E03A3E",
  SAC: "#5A2D81", SAS: "#8a99a8", TOR: "#CE1141", UTA: "#002B5C", WAS: "#E31837",
};

// Full team name → abbreviation (pick_history.team is stored as full name from The Odds API)
const TEAM_TO_ABBR: Record<string, string> = {
  "Atlanta Hawks": "ATL", "Boston Celtics": "BOS", "Brooklyn Nets": "BKN",
  "Charlotte Hornets": "CHA", "Chicago Bulls": "CHI", "Cleveland Cavaliers": "CLE",
  "Dallas Mavericks": "DAL", "Denver Nuggets": "DEN", "Detroit Pistons": "DET",
  "Golden State Warriors": "GSW", "Houston Rockets": "HOU", "Indiana Pacers": "IND",
  "LA Clippers": "LAC", "Los Angeles Clippers": "LAC", "Los Angeles Lakers": "LAL",
  "Memphis Grizzlies": "MEM", "Miami Heat": "MIA", "Milwaukee Bucks": "MIL",
  "Minnesota Timberwolves": "MIN", "New Orleans Pelicans": "NOP", "New York Knicks": "NYK",
  "Oklahoma City Thunder": "OKC", "Orlando Magic": "ORL", "Philadelphia 76ers": "PHI",
  "Phoenix Suns": "PHX", "Portland Trail Blazers": "POR", "Sacramento Kings": "SAC",
  "San Antonio Spurs": "SAS", "Toronto Raptors": "TOR", "Utah Jazz": "UTA",
  "Washington Wizards": "WAS",
};

const FACTOR_COLUMNS: { col: keyof PickHistoryRow; label: string }[] = [
  { col: "score_l5", label: "Last 5 games" },
  { col: "score_l10", label: "Last 10 games" },
  { col: "score_season", label: "Season hit rate" },
  { col: "score_floor_ceiling", label: "Floor & ceiling" },
  { col: "score_recent_form", label: "Recent form" },
  { col: "score_home_away", label: "Home / away" },
  { col: "score_rest", label: "Days of rest" },
  { col: "score_b2b", label: "Back-to-back" },
  { col: "score_minutes_trend", label: "Minutes trend" },
  { col: "score_pace", label: "Pace" },
  { col: "score_opp_defense", label: "Opp defense" },
  { col: "score_trend", label: "Trend" },
  { col: "score_z_score", label: "Projection edge" },
  { col: "score_role_change", label: "Role change" },
  // §15.10 #8 audit (May 12, 2026): renamed from "Vig filter" — factor
  // measures projection-vs-line proximity, not juice. See Dashboard.tsx
  // for the same rename + comment block.
  { col: "score_vig_filter", label: "No edge" },
  { col: "score_usg_rate", label: "Usage rate" },
  { col: "score_regression", label: "Regression" },
  { col: "score_market_conf", label: "Market confirmation" },
  { col: "score_home_away_split", label: "Home / away split" },
  { col: "score_minutes_floor", label: "Minutes floor" },
  { col: "score_consistency", label: "Consistency (low stdev)" },
  { col: "score_prop_type_penalty", label: "Prop type" },
  { col: "score_stale_data", label: "Stale data" },
  { col: "score_player_injury", label: "Player injury" },
];

// ============================================================
// HELPERS
// ============================================================

function parseGameDate(dateStr: string): Date {
  if (!dateStr || dateStr.length !== 8) return new Date(NaN);
  const year = parseInt(dateStr.substring(0, 4));
  const month = parseInt(dateStr.substring(4, 6)) - 1;
  const day = parseInt(dateStr.substring(6, 8));
  return new Date(year, month, day);
}

function formatGameDate(dateStr: string): string {
  const d = parseGameDate(dateStr);
  if (isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function gameDateISO(dateStr: string): string {
  const d = parseGameDate(dateStr);
  if (isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

function payoutUnits(odds: number, hit: boolean | null): number {
  if (hit == null) return 0;
  if (!hit) return -1;
  if (odds < 0) return 100 / Math.abs(odds);
  return odds / 100;
}

function impliedProb(odds: number): number {
  if (odds > 0) return 100 / (odds + 100);
  return Math.abs(odds) / (Math.abs(odds) + 100);
}

function fmtDollars(units: number, unitVal = STAKE): string {
  const dollars = Math.round(units * unitVal);
  if (dollars >= 0) return `+$${dollars}`;
  return `−$${Math.abs(dollars)}`;
}

function fmtOdds(o: number): string {
  return `${o >= 0 ? "+" : "−"}${Math.abs(o)}`;
}

function teamAbbr(team: string | null): string {
  if (!team) return "";
  if (team.length <= 3) return team.toUpperCase();
  return TEAM_TO_ABBR[team] ?? team.slice(0, 3).toUpperCase();
}

function getInitials(name: string): string {
  if (!name) return "?";
  if (name.includes(" vs ")) return name.split(" vs ")[0];
  const parts = name.split(" ").filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + (parts[parts.length - 1][0] || "")).toUpperCase();
}

function getConfTier(c: number): { key: string; label: string; color: string; textClass: string } {
  if (c >= 90) return { key: "90-100", label: "ELITE", color: "#fde68a", textClass: "text-amber-200" };
  if (c >= 80) return { key: "80-89", label: "STRONG", color: "#86efac", textClass: "text-emerald-300" };
  if (c >= 70) return { key: "70-79", label: "GOOD", color: "#bae6fd", textClass: "text-sky-200" };
  if (c >= 60) return { key: "60-69", label: "LEAN", color: "#fcd34d", textClass: "text-amber-300" };
  return { key: "<60", label: "SKIP", color: "#8a8376", textClass: "text-zinc-500" };
}

function getOddsBucket(o: number): string {
  if (o <= -200) return "Heavy favorite";
  if (o <= -111) return "Standard";
  if (o <= 110) return "Even";
  if (o <= 199) return "Underdog";
  return "Longshot";
}

// ============================================================
// TEAM DOT + PLAYER AVATAR
// ============================================================

function TeamDot({ team, size = 10 }: { team: string | null; size?: number }) {
  const abbr = teamAbbr(team);
  const color = TEAM_COLORS[abbr] || "#52525b";
  return (
    <span
      style={{
        display: "inline-block",
        width: size,
        height: size,
        borderRadius: "50%",
        background: color,
        flexShrink: 0,
        boxShadow: `0 0 0 1.5px ${color}30`,
      }}
    />
  );
}

function PlayerAvatar({
  team,
  name,
  size = 34,
}: {
  team: string | null;
  name: string;
  size?: number;
}) {
  const abbr = teamAbbr(team);
  const color = TEAM_COLORS[abbr] || "#3f3f46";
  const initials = getInitials(name);
  const fontSize = size <= 28 ? 10 : size <= 36 ? 12 : 14;
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        background: `linear-gradient(135deg, ${color}, ${color}dd)`,
        color: "#fff",
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize,
        fontWeight: 700,
        letterSpacing: "-0.02em",
        flexShrink: 0,
        boxShadow: "0 0 0 1.5px rgba(255,255,255,0.06), 0 2px 6px rgba(0,0,0,0.3)",
      }}
    >
      {initials}
    </div>
  );
}

// ============================================================
// MAIN COMPONENT
// ============================================================

function AlgorithmPerformanceSection() {
  const { session } = useAuthSession();
  // D-504 — DO NOT fall back to the anon key on missing session. pick_history's
  // RLS policy admits only role=authenticated; with the anon key the response
  // is [] (silent empty), which the panel previously conflated with "No data".
  // If session.access_token is missing, render the auth-needed state instead.
  const supabaseHeaders = useMemo(() => ({
    "Content-Type": "application/json",
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${session?.access_token ?? ""}`,
  }), [session?.access_token]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState<string | null>(null);  // D-504
  const [allPicks, setAllPicks] = useState<PickHistoryRow[]>([]);
  const [recommendedOnly, setRecommendedOnly] = useState(true);
  const [historyPage, setHistoryPage] = useState(1);
  const [historySearch, setHistorySearch] = useState("");
  const [historyResultFilter, setHistoryResultFilter] = useState<"all" | "wins" | "losses" | "pending">("all");
  const [historyConfidenceFilter, setHistoryConfidenceFilter] = useState<"all" | "70plus" | "shown">("all");
  const [historySortKey, setHistorySortKey] = useState<SortKey>("game_date");
  const [historySortDir, setHistorySortDir] = useState<SortDir>("desc");
  const [showAllFactors, setShowAllFactors] = useState(false);

  useEffect(() => {
    if (session?.access_token) fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.access_token]);

  async function fetchData() {
    setLoading(true);
    setFetchError(null);  // D-504 — clear any prior error before retry
    try {
      // D-602 — KEYSET PAGINATION (replaces OFFSET-based paging).
      //
      // Why: D-601 probe (migration 20260619220000_d601_perf_regression_diag.sql)
      // proved the panel query at page 0 takes 62 ms via Index Scan on
      // idx_ph_perf_panel — fast. But page-49 (OFFSET 49000 LIMIT 1000)
      // took 9,819 ms — the planner must walk every index entry up to
      // the OFFSET position because OFFSET is O(skip+limit), not O(limit).
      // 9.8s > 8s authenticated role statement_timeout → 57014.
      //
      // The fix is keyset pagination with the RIGHT shape — the v1 OR-tuple
      // form `(game_date, created_at) < (CD, CC)` defeated the Index Cond
      // (PG can't push the OR into a single-column seek; it became a heap
      // filter at 6.6s mid / 2.2s deep — D-602 v1 verify
      // 20260619230000_d602_keyset_verify.sql).
      //
      // The correct shape is decomposed as `game_date <= CD AND NOT
      // (game_date = CD AND created_at >= CC)` — which PG decomposes
      // further into `(game_date <> CD OR created_at < CC)` filter
      // applied AFTER an Index Cond seek on `game_date <= CD`. The seek
      // anchors at game_date=CD rows; the OR-filter only removes the
      // 32-565 boundary rows. D-602 v2 verify
      // 20260619230100_d602_keyset_v2.sql confirms: mid 679 ms, deep 144 ms
      // (vs OFFSET 9,819 ms baseline).
      //
      // PostgREST encoding: top-level `game_date=lte.CD` adds the seek
      // anchor as Index Cond. The NOT-AND is decomposed into an OR group
      // and combined with the existing d214 OR-clause inside a single
      // `and=(or(...),or(...))` wrapper so both OR groups apply (PostgREST
      // allows only one top-level `or=` per query).
      //
      // Population grew 44K→49,785 panel rows since D-521 baseline. D-521
      // fix (idx_ph_perf_panel) still load-bearing — page 0 fast = index
      // working. The regression was sibling H3 (deep OFFSET).
      const PAGE = 1000;
      const collected: PickHistoryRow[] = [];
      let cursorGameDate: string | null = null;
      let cursorCreatedAt: string | null = null;

      const orderBy = `order=game_date.desc,created_at.desc`;

      for (let i = 0; i < 50; i++) {
        let url: string;
        if (cursorGameDate === null) {
          // First page: no cursor. Use the exact D-521 baseline shape so
          // the partial idx_ph_perf_panel matches predicate-for-predicate.
          const baseFiltersPage0 = `voided=not.eq.true&is_synthetic=eq.false&or=(is_d214_quarantined.is.null,is_d214_quarantined.eq.false)&game_date=not.is.null`;
          url = `${SUPABASE_URL}/rest/v1/pick_history?${baseFiltersPage0}&${orderBy}&limit=${PAGE}`;
        } else {
          // Subsequent pages: keyset seek via Index Cond `game_date <= CD`
          // plus a single top-level `and=(...)` wrapper that carries BOTH
          // OR groups (d214 + cursor decomposition).
          const cd = encodeURIComponent(cursorGameDate);
          const cc = encodeURIComponent(cursorCreatedAt!);
          // and=( or(d214_null,d214_false), or(game_date<>CD,created_at<CC) )
          // The second OR is the De Morgan expansion of NOT(game_date=CD AND created_at>=CC).
          const andGroup = `and=(or(is_d214_quarantined.is.null,is_d214_quarantined.eq.false),or(game_date.neq.${cd},created_at.lt.${cc}))`;
          const baseFiltersPageN = `voided=not.eq.true&is_synthetic=eq.false&game_date=not.is.null&game_date=lte.${cd}`;
          url = `${SUPABASE_URL}/rest/v1/pick_history?${baseFiltersPageN}&${andGroup}&${orderBy}&limit=${PAGE}`;
        }

        const res = await fetch(url, { headers: supabaseHeaders });

        // D-504 — replace silent `break` with explicit error tracking. Prior
        // behavior conflated auth/network failures with "no data" — the panel
        // rendered "No Performance Data Yet" on a 401 because `collected`
        // stayed empty. Now: surface the HTTP status so the CEO can tell
        // expired-session apart from genuine empty DB.
        if (!res.ok) {
          const bodyExcerpt = (await res.text()).slice(0, 200);
          const reason = res.status === 401 || res.status === 403
            ? `Auth error (HTTP ${res.status}). Your session may have expired — sign out and sign back in.`
            : `Fetch failed (HTTP ${res.status}). ${bodyExcerpt}`;
          setFetchError(reason);
          console.error(`[Performance] fetch failed at page ${i}: HTTP ${res.status} body=${bodyExcerpt}`);
          break;
        }
        const rows = (await res.json()) as PickHistoryRow[];
        if (!Array.isArray(rows) || rows.length === 0) break;
        collected.push(...rows);
        if (rows.length < PAGE) break;
        // Advance the cursor to the last row's (game_date, created_at).
        const last = rows[rows.length - 1];
        cursorGameDate = last.game_date;
        cursorCreatedAt = (last as unknown as { created_at: string }).created_at;
      }
      setAllPicks(collected);
    } catch (err) {
      console.error("Error fetching performance data:", err);
      // D-504 — also surface network/JSON errors as a fetchError instead of
      // letting `collected = []` fall through to the empty-state guard.
      setFetchError(`Network or parse error: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setLoading(false);
    }
  }

  // === TWO SCOPES ===
  // - picks70Plus drives the SCORECARD (hero, last 10, bad beats, tonight's top picks, equity).
  //   This is the real betting performance - picks at the confidence threshold we'd actually bet.
  // - picksAll drives R&D (factor analysis, breakdowns). More statistical power.
  //   Breakdowns let the user toggle between "70+ only" and "all picks" section-by-section.
  const picks70Plus = useMemo(() => allPicks.filter((p) => p.confidence >= 70), [allPicks]);
  const picksAll = allPicks;
  // `picks` is the slice the BREAKDOWN/FACTOR sections use — driven by the toggle
  const picks = recommendedOnly ? picks70Plus : picksAll;

  // Scorecard always uses 70+
  const resolved = useMemo(() => picks70Plus.filter((p) => p.hit !== null), [picks70Plus]);
  // Pending tonight = today's date + 70+ + recommendation_shown (matches Dashboard Strong picks)
  // D-162: DST-safe ET game-date via shared helper.
  const todayYmd = useMemo(() => etGameDateYmd(0), []);
  const pending = useMemo(
    () => picks70Plus.filter((p) => p.hit === null && p.game_date === todayYmd && p.recommendation_shown === true),
    [picks70Plus, todayYmd]
  );
  // Unresolved stragglers (old pending picks that should have resolved but didn't)
  const stragglers = useMemo(
    () => picks70Plus.filter((p) => p.hit === null && p.game_date !== todayYmd),
    [picks70Plus, todayYmd]
  );

  // === HERO METRICS (locked to 70+) ===
  const totalResolved = resolved.length;
  const wins = resolved.filter((p) => p.hit).length;
  const winRate = totalResolved > 0 ? wins / totalResolved : 0;
  const expected = totalResolved > 0 ? resolved.reduce((s, p) => s + impliedProb(p.odds), 0) / totalResolved : 0;
  const edge = winRate - expected;
  const totalUnits = resolved.reduce((s, p) => s + payoutUnits(p.odds, p.hit), 0);
  const roi = totalResolved > 0 ? totalUnits / totalResolved : 0;

  const batterHitsMonitor = useMemo(() => {
    const shown = allPicks.filter(
      (p) => p.mlb_market_type === "batter_hits" && p.recommendation_shown === true,
    );
    const resolvedShown = shown.filter((p) => p.hit !== null);
    const pendingToday = shown.filter((p) => p.hit === null && p.game_date === todayYmd);
    const rolling7dFloor = etGameDateYmd(-7);
    const resolved7d = resolvedShown.filter(
      (p) => p.game_date != null && p.game_date >= rolling7dFloor,
    );
    const sideRoi = (rows: PickHistoryRow[]) =>
      rows.length > 0
        ? rows.reduce((s, p) => s + payoutUnits(p.odds, p.hit), 0) / rows.length
        : null;
    const overs7d = resolved7d.filter((p) => p.pick_side === "over");
    const unders7d = resolved7d.filter((p) => p.pick_side === "under");
    const clvValues = resolvedShown
      .filter((p) => p.clv_pct != null)
      .map((p) => p.clv_pct as number);
    return {
      pendingToday: pendingToday.length,
      resolvedN: resolvedShown.length,
      resolved7dN: resolved7d.length,
      overRoi7d: sideRoi(overs7d),
      underRoi7d: sideRoi(unders7d),
      avgClv: clvValues.length > 0
        ? clvValues.reduce((a, b) => a + b, 0) / clvValues.length
        : null,
    };
  }, [allPicks, todayYmd]);

  // Streak, best day (always 70+)
  // D-062: null-safe sort. PickHistoryRow.game_date is typed as string but
  // the DB column is nullable; at least one row in pick_history has
  // game_date=null which crashed Admin with a TypeError on the .localeCompare
  // call → uncaught error → React unmounted the component subtree → CEO
  // saw "black screen". `?? ""` clamps the null rows to the front of an
  // ascending sort; investigate-and-clean-up the corrupted row separately.
  const sortedByDate = useMemo(
    () => [...resolved].sort((a, b) => (a.game_date ?? "").localeCompare(b.game_date ?? "")),
    [resolved]
  );
  const dailyPL = useMemo(() => {
    const map: Record<string, number> = {};
    for (const p of sortedByDate) {
      map[p.game_date] = (map[p.game_date] ?? 0) + payoutUnits(p.odds, p.hit);
    }
    return map;
  }, [sortedByDate]);
  const bestDay = useMemo(() => {
    let best = 0;
    for (const v of Object.values(dailyPL)) if (v > best) best = v;
    return best;
  }, [dailyPL]);
  const streak = useMemo(() => {
    let count = 0;
    let kind: "W" | "L" | null = null;
    for (let i = sortedByDate.length - 1; i >= 0; i--) {
      const thisKind: "W" | "L" = sortedByDate[i].hit ? "W" : "L";
      if (kind === null) {
        kind = thisKind;
        count = 1;
      } else if (thisKind === kind) count++;
      else break;
    }
    return { count, kind };
  }, [sortedByDate]);

  // === EQUITY CURVE ===
  // Cumulative P/L for ALL 70+ picks (the area), plus three tier lines:
  //   elite  — 90+
  //   strong — 80-89
  //   good   — 70-79
  // Each tier cumulates independently so the lines reveal which tier is actually earning.
  const equityData = useMemo(() => {
    type Bucket = { units: number; expected: number; elite: number; strong: number; good: number };
    const map: Record<string, Bucket> = {};
    for (const p of sortedByDate) {
      const u = payoutUnits(p.odds, p.hit);
      const impP = impliedProb(p.odds);
      const eU = impP * payoutUnits(p.odds, true) + (1 - impP) * -1;
      if (!map[p.game_date]) map[p.game_date] = { units: 0, expected: 0, elite: 0, strong: 0, good: 0 };
      const b = map[p.game_date];
      b.units += u;
      b.expected += eU;
      if (p.confidence >= 90) b.elite += u;
      else if (p.confidence >= 80) b.strong += u;
      else b.good += u;
    }
    let cum = 0, cumExp = 0, cumElite = 0, cumStrong = 0, cumGood = 0;
    return Object.keys(map)
      .sort()
      .map((d) => {
        const b = map[d];
        cum += b.units;
        cumExp += b.expected;
        cumElite += b.elite;
        cumStrong += b.strong;
        cumGood += b.good;
        return {
          date: gameDateISO(d),
          displayDate: formatGameDate(d),
          units: +cum.toFixed(2),
          expected: +cumExp.toFixed(2),
          elite: +cumElite.toFixed(2),
          strong: +cumStrong.toFixed(2),
          good: +cumGood.toFixed(2),
        };
      });
  }, [sortedByDate]);

  // Per-tier totals for the legend.
  const tierFinals = useMemo(() => {
    const last = equityData[equityData.length - 1];
    return {
      elite: last?.elite ?? 0,
      strong: last?.strong ?? 0,
      good: last?.good ?? 0,
    };
  }, [equityData]);
  const tierCounts = useMemo(() => {
    let elite = 0, strong = 0, good = 0;
    for (const p of sortedByDate) {
      if (p.confidence >= 90) elite++;
      else if (p.confidence >= 80) strong++;
      else good++;
    }
    return { elite, strong, good };
  }, [sortedByDate]);
  const finalUnits = equityData.length ? equityData[equityData.length - 1].units : 0;
  const peakUnits = equityData.length ? Math.max(...equityData.map((d) => d.units)) : 0;
  const troughUnits = equityData.length ? Math.min(...equityData.map((d) => d.units)) : 0;

  // === LAST 10 ===
  const last10 = sortedByDate.slice(-10);
  const last10Wins = last10.filter((p) => p.hit).length;
  const last20 = sortedByDate.slice(-20);
  const last20Wins = last20.filter((p) => p.hit).length;
  // D-548 — real per-pick BE for the L10 / L20 windows
  const last10Expected = last10.length ? avgImpliedProb(last10) : 0;
  const last20Expected = last20.length ? avgImpliedProb(last20) : 0;

  // === BREAKDOWN / FACTOR SCOPE ===
  // These sections follow the toggle — default to ALL picks (big sample for stat power),
  // or narrow to 70+ if user toggles "Recommended only"
  const breakdownResolved = useMemo(() => picks.filter((p) => p.hit !== null), [picks]);

  // === TIER BREAKDOWN ===
  const tierRows = useMemo(() => {
    const tiers = [
      { k: "90-100", l: "Elite", c: "#fde68a" },
      { k: "80-89", l: "Strong", c: "#86efac" },
      { k: "70-79", l: "Good", c: "#bae6fd" },
      { k: "60-69", l: "Lean", c: "#fcd34d" },
      { k: "<60", l: "Skip", c: "#8a8376" },
    ];
    const getKey = (c: number) =>
      c >= 90 ? "90-100" : c >= 80 ? "80-89" : c >= 70 ? "70-79" : c >= 60 ? "60-69" : "<60";
    return tiers.map((t) => {
      const tp = breakdownResolved.filter((p) => getKey(p.confidence) === t.k);
      const w = tp.filter((p) => p.hit).length;
      return {
        key: t.k,
        label: t.l,
        color: t.c,
        total: tp.length,
        wr: tp.length ? w / tp.length : 0,
        // D-548 — real per-pick BE averaged over picks in this tier
        expected: tp.length ? avgImpliedProb(tp) : 0,
      };
    });
  }, [breakdownResolved]);
  const bestTier = tierRows.reduce(
    (a, b) => (b.wr > a.wr && b.total >= 5 ? b : a),
    tierRows[0] || { label: "—", color: "#8a8376", wr: 0, expected: 0, total: 0, key: "" }
  );
  const worstTier = tierRows.reduce(
    (a, b) => (b.wr < a.wr && b.total >= 5 ? b : a),
    tierRows[0] || { label: "—", color: "#8a8376", wr: 0, expected: 0, total: 0, key: "" }
  );
  const maxTierTotal = Math.max(...tierRows.map((r) => r.total), 1);

  // === PROP TYPE ===
  const propRows = useMemo(() => {
    const byType: Record<string, { wins: number; total: number; picks: { odds: number }[] }> = {};
    for (const p of breakdownResolved) {
      const t = p.prop_type.toLowerCase();
      if (!byType[t]) byType[t] = { wins: 0, total: 0, picks: [] };
      byType[t].total++;
      byType[t].picks.push({ odds: p.odds });
      if (p.hit) byType[t].wins++;
    }
    return Object.entries(byType)
      .map(([name, d]) => ({
        name,
        total: d.total,
        wr: d.total ? d.wins / d.total : 0,
        // D-548 — real per-pick BE averaged over this prop_type's picks
        expected: d.total ? avgImpliedProb(d.picks) : 0,
      }))
      .sort((a, b) => b.total - a.total);
  }, [breakdownResolved]);
  const maxPropTotal = Math.max(...propRows.map((r) => r.total), 1);

  // === ODDS BUCKET ===
  const oddsRows = useMemo(() => {
    const buckets = ["Heavy favorite", "Standard", "Even", "Underdog", "Longshot"];
    const agg: Record<string, { wins: number; total: number; picks: { odds: number }[] }> = {};
    buckets.forEach((b) => (agg[b] = { wins: 0, total: 0, picks: [] }));
    for (const p of breakdownResolved) {
      const b = getOddsBucket(p.odds);
      agg[b].total++;
      agg[b].picks.push({ odds: p.odds });
      if (p.hit) agg[b].wins++;
    }
    return buckets
      .map((b) => ({
        name: b,
        total: agg[b].total,
        wr: agg[b].total ? agg[b].wins / agg[b].total : 0,
        // D-548 — real per-pick BE within this odds bucket
        expected: agg[b].total ? avgImpliedProb(agg[b].picks) : 0,
      }))
      .filter((r) => r.total > 0);
  }, [breakdownResolved]);

  // === SIDE BIAS ===
  const sideRows = useMemo(() => {
    const sides: { k: string; l: string }[] = [
      { k: "over", l: "Over" },
      { k: "under", l: "Under" },
      { k: "home", l: "Home" },
      { k: "away", l: "Away" },
    ];
    return sides
      .map((s) => {
        const sp = breakdownResolved.filter((p) => p.pick_side === s.k);
        const w = sp.filter((p) => p.hit).length;
        return {
          key: s.k,
          label: s.l,
          total: sp.length,
          wr: sp.length ? w / sp.length : 0,
          // D-548 — real per-pick BE for this side
          expected: sp.length ? avgImpliedProb(sp) : 0,
        };
      })
      .filter((r) => r.total > 0);
  }, [breakdownResolved]);

  // === ATS RECORD (spread picks) ===
  // Reads every spread pick in pick_history (not filtered by 70+ because ATS is its
  // own story at every confidence level). Push behaviour matches §8.3 of framework:
  // pushes count as losses, so we only have hit=true / hit=false buckets.
  // === FACTOR ANALYSIS ===
  const factorRows = useMemo(() => {
    const winPicks = breakdownResolved.filter((p) => p.hit);
    const lossPicks = breakdownResolved.filter((p) => !p.hit);
    return FACTOR_COLUMNS.map((f) => {
      const winVals = winPicks.map((p) => p[f.col] as number | null).filter((v): v is number => v != null);
      const lossVals = lossPicks.map((p) => p[f.col] as number | null).filter((v): v is number => v != null);
      const winAvg = winVals.length ? winVals.reduce((s, v) => s + v, 0) / winVals.length : 0;
      const lossAvg = lossVals.length ? lossVals.reduce((s, v) => s + v, 0) / lossVals.length : 0;
      const delta = winAvg - lossAvg;
      const sample = winVals.length + lossVals.length;
      let direction: "up_hard" | "up" | "down" | "down_hard" | "hold" = "hold";
      if (sample >= 30) {
        if (delta > 2) direction = "up_hard";
        else if (delta > 1.2) direction = "up";
        else if (delta < -1.2) direction = "down_hard";
        else if (delta < -0.5) direction = "down";
      }
      return { ...f, winAvg, lossAvg, delta, sample, direction };
    }).filter((r) => r.sample > 0);
  }, [breakdownResolved]);
  const topFactors = [...factorRows].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 6);
  const allFactorsSorted = [...factorRows].sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  // === TONIGHT'S TOP PICKS (always 70+) ===
  const tonightPicks = useMemo(
    () => [...pending].sort((a, b) => b.confidence - a.confidence).slice(0, 6),
    [pending]
  );

  // === BAD BEATS (always 70+) ===
  const badBeats = useMemo(
    () => resolved.filter((p) => !p.hit).sort((a, b) => b.confidence - a.confidence).slice(0, 10),
    [resolved]
  );
  const badBeatsCost = badBeats.reduce((s) => s - 1, 0);
  const badBeatsAvgConf = badBeats.length
    ? badBeats.reduce((s, p) => s + p.confidence, 0) / badBeats.length
    : 0;

  // === PICK HISTORY (paginated) ===
  // Sourced from picksAll (ALL picks), not the toggle-controlled `picks`.
  // Has its own independent filters in the toolbar so user can search across everything
  // regardless of what the breakdown toggle is set to.
  const filteredHistory = useMemo(() => {
    let rows = picksAll;
    if (historyResultFilter === "wins") rows = rows.filter((p) => p.hit === true);
    else if (historyResultFilter === "losses") rows = rows.filter((p) => p.hit === false);
    else if (historyResultFilter === "pending") rows = rows.filter((p) => p.hit === null);
    if (historyConfidenceFilter === "70plus") rows = rows.filter((p) => p.confidence >= 70);
    else if (historyConfidenceFilter === "shown") rows = rows.filter((p) => p.recommendation_shown === true);
    if (historySearch) {
      const q = historySearch.toLowerCase();
      rows = rows.filter(
        (p) =>
          p.player_name.toLowerCase().includes(q) ||
          (p.team ?? "").toLowerCase().includes(q) ||
          (p.opponent ?? "").toLowerCase().includes(q)
      );
    }
    const sorted = [...rows].sort((a, b) => {
      let aVal: string | number | boolean | null = a[historySortKey] as string | number | boolean | null;
      let bVal: string | number | boolean | null = b[historySortKey] as string | number | boolean | null;
      if (aVal == null) aVal = "";
      if (bVal == null) bVal = "";
      if (typeof aVal === "boolean") {
        aVal = aVal ? 1 : 0;
        bVal = (bVal as boolean) ? 1 : 0;
      }
      if (typeof aVal === "string" && typeof bVal === "string") {
        return historySortDir === "asc" ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
      }
      if (typeof aVal === "number" && typeof bVal === "number") {
        return historySortDir === "asc" ? aVal - bVal : bVal - aVal;
      }
      return 0;
    });
    return sorted;
  }, [picksAll, historySearch, historyResultFilter, historyConfidenceFilter, historySortKey, historySortDir]);

  const PAGE_SIZE = 40;
  const totalPages = Math.max(1, Math.ceil(filteredHistory.length / PAGE_SIZE));
  const pageClamped = Math.min(historyPage, totalPages);
  const pageData = filteredHistory.slice((pageClamped - 1) * PAGE_SIZE, pageClamped * PAGE_SIZE);

  function handleSort(key: SortKey) {
    if (historySortKey === key) setHistorySortDir(historySortDir === "asc" ? "desc" : "asc");
    else {
      setHistorySortKey(key);
      setHistorySortDir("desc");
    }
  }

  function exportCsv() {
    const header = ["date", "player", "team", "opp", "prop", "side", "line", "odds", "conf", "result", "units"];
    const rows = filteredHistory.map((p) => [
      gameDateISO(p.game_date),
      p.player_name,
      p.team ?? "",
      p.opponent ?? "",
      p.prop_type,
      p.pick_side,
      p.line,
      p.odds,
      p.confidence,
      p.hit === null ? "pending" : p.hit ? "W" : "L",
      p.hit === null ? "" : payoutUnits(p.odds, p.hit).toFixed(2),
    ]);
    const csv = [header, ...rows].map((r) => r.join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "sharpai-picks.csv";
    a.click();
  }

  // ============================================================
  // RENDER STATES
  // ============================================================

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-12 text-center">
          <div className="inline-block h-8 w-8 animate-spin rounded-full border-2 border-zinc-600 border-t-emerald-500 mb-4" />
          <p className="text-zinc-400 text-sm">Loading performance data...</p>
        </div>
      </div>
    );
  }

  // D-504 — auth-needed state: distinct from empty data. Fires when the
  // session has no access_token at all (e.g. user not signed in).
  if (!session?.access_token) {
    return (
      <div className="rounded-xl border border-amber-900/40 bg-amber-950/20 p-12 text-center">
        <div className="text-4xl mb-4">🔒</div>
        <h2 className="text-lg font-medium text-amber-200 mb-2">Sign-In Required</h2>
        <p className="text-amber-300/70 text-sm max-w-md mx-auto">
          The Performance panel reads from <span className="font-mono text-amber-200">pick_history</span> which requires an authenticated session.
        </p>
      </div>
    );
  }

  // D-504 — fetch-error state: distinct from empty data. Fires when the
  // fetch failed (401 / 5xx / network) regardless of whether DB rows exist.
  if (fetchError) {
    return (
      <div className="rounded-xl border border-rose-900/40 bg-rose-950/20 p-12 text-center">
        <div className="text-4xl mb-4">⚠️</div>
        <h2 className="text-lg font-medium text-rose-200 mb-2">Failed to Load Performance Data</h2>
        <p className="text-rose-300/70 text-sm max-w-md mx-auto break-words">{fetchError}</p>
        <button
          type="button"
          onClick={() => fetchData()}
          className="mt-4 px-3 py-1.5 text-xs rounded-md border border-rose-800/40 text-rose-200 hover:bg-rose-900/30"
        >
          Retry
        </button>
      </div>
    );
  }

  if (totalResolved === 0 && tonightPicks.length === 0) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-12 text-center">
        <div className="text-4xl mb-4">📊</div>
        <h2 className="text-lg font-medium text-zinc-200 mb-2">No Performance Data Yet</h2>
        <p className="text-zinc-500 text-sm max-w-md mx-auto">
          Algorithm picks will appear here after games complete and picks are resolved.
        </p>
      </div>
    );
  }

  // ============================================================
  // RENDER
  // ============================================================

  return (
    <div className="space-y-4">
      {/* D-600 SHIP 3b — July 3 verdict trigger nudge.
          Shows only when wall-clock date >= 2026-07-03; reminds operator
          to run pending OOS verdicts before promoting any related scoring
          change. Remove this block once the verdicts ship. */}
      {new Date() >= new Date("2026-07-03T00:00:00Z") && (
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
          <span className="font-semibold">PENDING VERDICTS — D-597 / D-598 / D-600 SHIP 3-4.</span>{" "}
          Pitch-type matchup 14-day watch elapsed (2026-06-19 → 2026-07-03).
          Run pitcher_k 5-gate OOS, 6-batter-market harness, batter_TB retune
          before promoting scoring changes. See BetGenius_Framework.md §15.
        </div>
      )}
      {/* HEADER */}
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-zinc-100">Performance</h1>
          <p className="text-sm text-zinc-500 mt-1">
            Scorecard: <span className="text-zinc-300 font-semibold">{totalResolved}</span> resolved picks at 70+ confidence
            {pending.length > 0 && <> · <span className="text-amber-300 font-semibold">{pending.length}</span> pending tonight</>}
            {stragglers.length > 0 && (
              <> · <span className="text-zinc-400" title="Old picks that the resolver hasn't settled yet — not counted in the scorecard">{stragglers.length} unresolved from prior days</span></>
            )}
          </p>
        </div>
        <label className="flex items-center gap-2 text-sm text-zinc-400 cursor-pointer" title="Controls the Breakdown and Factor sections only — the Scorecard always shows 70+">
          <input
            type="checkbox"
            checked={recommendedOnly}
            onChange={(e) => setRecommendedOnly(e.target.checked)}
            className="rounded border-zinc-700 bg-zinc-800 text-emerald-500 focus:ring-emerald-500/30"
          />
          Breakdowns: 70+ only ({picksAll.length.toLocaleString()} total picks available)
        </label>
      </div>
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 px-4 py-3 text-sm text-zinc-300">
        <div className="font-semibold text-zinc-100 mb-1">Batter hits EV surface (M4 monitor)</div>
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-zinc-400">
          <span>Pending tonight: <span className="text-zinc-200">{batterHitsMonitor.pendingToday}</span></span>
          <span>Resolved shown (all): <span className="text-zinc-200">{batterHitsMonitor.resolvedN}</span></span>
          <span>7d resolved: <span className="text-zinc-200">{batterHitsMonitor.resolved7dN}</span></span>
          <span>7d over ROI: <span className="text-zinc-200">{batterHitsMonitor.overRoi7d == null ? "—" : `${(batterHitsMonitor.overRoi7d * 100).toFixed(1)}%`}</span></span>
          <span>7d under ROI: <span className="text-zinc-200">{batterHitsMonitor.underRoi7d == null ? "—" : `${(batterHitsMonitor.underRoi7d * 100).toFixed(1)}%`}</span></span>
          <span>Avg CLV (resolved): <span className="text-zinc-200">{batterHitsMonitor.avgClv == null ? "—" : `${batterHitsMonitor.avgClv >= 0 ? "+" : ""}${batterHitsMonitor.avgClv.toFixed(2)}%`}</span></span>
        </div>
        {batterHitsMonitor.pendingToday === 0 && (
          <p className="mt-2 text-xs text-amber-400/90">
            No batter_hits recommendation_shown picks pending tonight — verify process-games-mlb ran for today&apos;s slate.
          </p>
        )}
      </div>
      {/* HERO: Equity Curve + Hit Rate + Profit */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <EquityCard
            equityData={equityData}
            finalUnits={finalUnits}
            peakUnits={peakUnits}
            troughUnits={troughUnits}
            bestDay={bestDay}
            streak={streak}
            tierFinals={tierFinals}
            tierCounts={tierCounts}
          />
        </div>
        <div className="flex flex-col gap-4">
          <HitRateCard winRate={winRate} expected={expected} edge={edge} />
          <ProfitCard
            units={totalUnits}
            roi={roi}
            resolved={totalResolved}
            pendingCount={pending.length}
          />
        </div>
      </div>

      {/* TONIGHT'S TOP PICKS — horizontal match card strip */}
      {tonightPicks.length > 0 && (
        <section>
          <div className="flex items-end justify-between mb-3">
            <div>
              <h2 className="text-lg font-bold tracking-tight text-zinc-100">Tonight's top picks</h2>
              <p className="text-xs text-zinc-500 mt-0.5">
                Your highest confidence plays not yet settled
              </p>
            </div>
            <span className="text-xs text-zinc-500">{tonightPicks.length} pending</span>
          </div>
          <div className="overflow-x-auto -mx-1 px-1">
            <div className="flex gap-3 pb-1">
              {tonightPicks.map((p) => (
                <MatchCard key={p.id} p={p} />
              ))}
            </div>
          </div>
        </section>
      )}

      {/* BREAKDOWN ROW */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <div className="lg:col-span-3"><TierBreakdownCard rows={tierRows} maxTotal={maxTierTotal} bestTier={bestTier} worstTier={worstTier} /></div>
        <div className="lg:col-span-4"><PropBreakdownCard rows={propRows} maxTotal={maxPropTotal} /></div>
        <div className="lg:col-span-3"><OddsBreakdownCard rows={oddsRows} /></div>
        <div className="lg:col-span-2"><SideBreakdownCard rows={sideRows} /></div>
      </div>

      {/* LAST 10 SCOREBOARD */}
      {last10.length > 0 && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
          <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_auto_auto] gap-4 sm:gap-6 items-center">
            <div>
              <div className="text-xs text-zinc-500 mb-2">Last 10 picks</div>
              <div className="flex flex-wrap gap-1.5">
                {last10.map((p, i) => (
                  <div
                    key={i}
                    title={`${p.player_name} · ${p.prop_type} ${p.pick_side} ${p.line}`}
                    className={`flex items-center justify-center w-7 h-7 rounded-md font-bold text-xs ${
                      p.hit
                        ? "bg-emerald-500/15 text-emerald-300 border border-emerald-500/30"
                        : "bg-red-500/15 text-red-300 border border-red-500/30"
                    }`}
                  >
                    {p.hit ? "W" : "L"}
                  </div>
                ))}
              </div>
            </div>
            <div className="hidden sm:block w-px h-12 bg-zinc-800" />
            <MiniStat
              label="L10"
              value={`${last10Wins}–${last10.length - last10Wins}`}
              // D-548 — color by L10 WR vs L10 stake-weighted real BE
              positive={last10Wins / Math.max(1, last10.length) >= last10Expected}
            />
            <MiniStat
              label="L20"
              value={`${last20Wins}–${last20.length - last20Wins}`}
              positive={last20Wins / Math.max(1, last20.length) >= last20Expected}
            />
            <MiniStat
              label="Streak"
              value={`${streak.count}${streak.kind ?? ""}`}
              positive={streak.kind === "W"}
            />
          </div>
        </div>
      )}

      {/* FACTOR ANALYSIS */}
      {factorRows.length > 0 && (
        <section>
          <div className="flex items-end justify-between mb-3 flex-wrap gap-2">
            <div>
              <h2 className="text-lg font-bold tracking-tight text-zinc-100">What's driving results</h2>
              <p className="text-xs text-zinc-500 mt-0.5 max-w-[620px]">
                Each signal shows the gap between its score on winning picks vs. losing picks. A bigger positive gap means the signal is telling us something real.
              </p>
            </div>
            <div className="flex items-center gap-4 text-[11px] text-zinc-500">
              <span className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-emerald-300" />
                Helping
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-red-300" />
                Hurting
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-zinc-500" />
                Neutral
              </span>
            </div>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2.5 mb-3">
            {topFactors.map((r) => (
              <SignalCard key={r.col as string} r={r} />
            ))}
          </div>

          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 overflow-hidden">
            <button
              onClick={() => setShowAllFactors(!showAllFactors)}
              className="w-full flex items-center justify-between px-5 py-3 hover:bg-zinc-800/30 transition"
            >
              <div>
                <div className="text-sm font-semibold text-zinc-200">All {allFactorsSorted.length} signals</div>
                <div className="text-xs text-zinc-500 mt-0.5">Showing top 6 above · expand to see the full list</div>
              </div>
              <span className="text-xs text-zinc-400 font-medium">
                {showAllFactors ? "Hide ↑" : "Show all ↓"}
              </span>
            </button>
            {showAllFactors && (
              <div className="border-t border-zinc-800 overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[11px] text-zinc-500 uppercase tracking-wide border-b border-zinc-800 bg-zinc-900/60">
                      <th className="text-left px-5 py-2.5 font-medium">Signal</th>
                      <th className="text-right px-4 py-2.5 font-medium">Gap</th>
                      <th className="text-right px-4 py-2.5 font-medium">On wins</th>
                      <th className="text-right px-4 py-2.5 font-medium">On losses</th>
                      <th className="text-right px-4 py-2.5 font-medium">Sample</th>
                      <th className="text-right px-5 py-2.5 font-medium">Suggest</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allFactorsSorted.map((r) => {
                      const pos = r.delta >= 0;
                      const suggest =
                        r.direction === "up_hard"
                          ? { text: "Raise more", c: "text-emerald-400" }
                          : r.direction === "up"
                          ? { text: "Raise", c: "text-emerald-400" }
                          : r.direction === "down_hard"
                          ? { text: "Lower more", c: "text-red-400" }
                          : r.direction === "down"
                          ? { text: "Lower", c: "text-red-400" }
                          : { text: "Hold", c: "text-zinc-500" };
                      return (
                        <tr key={r.col as string} className="border-b border-zinc-800 hover:bg-zinc-800/30">
                          <td className="px-5 py-2.5 text-zinc-200 font-medium">{r.label}</td>
                          <td className={`px-4 py-2.5 text-right font-semibold ${pos ? "text-emerald-400" : "text-red-400"}`}>
                            {pos ? "+" : ""}{r.delta.toFixed(2)}
                          </td>
                          <td className="px-4 py-2.5 text-right text-emerald-400">{r.winAvg.toFixed(2)}</td>
                          <td className="px-4 py-2.5 text-right text-red-400">{r.lossAvg.toFixed(2)}</td>
                          <td className={`px-4 py-2.5 text-right ${r.sample < 15 ? "text-amber-400" : "text-zinc-500"}`}>
                            {r.sample}
                          </td>
                          <td className={`px-5 py-2.5 text-right font-medium ${suggest.c}`}>{suggest.text}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
      )}

      {/* BAD BEATS — full width */}
      {badBeats.length > 0 && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 overflow-hidden">
          <div className="px-5 py-4 border-b border-zinc-800 flex items-center justify-between flex-wrap gap-3">
            <div>
              <div className="flex items-center gap-3">
                <h2 className="text-lg font-bold tracking-tight text-zinc-100">Bad beats</h2>
                <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-semibold bg-red-500/15 text-red-300">
                  {badBeats.length} losses
                </span>
              </div>
              <p className="text-xs text-zinc-500 mt-0.5">High confidence plays that still lost — worth reviewing for patterns</p>
            </div>
            <div className="flex items-center gap-6">
              <div className="text-right">
                <div className="text-[11px] text-zinc-500">Avg confidence</div>
                <div className="text-base font-bold text-zinc-300">{Math.round(badBeatsAvgConf)}</div>
              </div>
              <div className="text-right">
                <div className="text-[11px] text-zinc-500">Cost</div>
                <div className="text-base font-bold text-red-400">{fmtDollars(badBeatsCost)}</div>
              </div>
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-5">
            {badBeats.map((p) => (
              <BadBeatRow key={p.id} p={p} />
            ))}
          </div>
        </div>
      )}

      {/* PICK HISTORY */}
      <section>
        <div className="flex items-end justify-between mb-3 flex-wrap gap-3">
          <div>
            <h2 className="text-lg font-bold tracking-tight text-zinc-100">Pick history</h2>
            <p className="text-xs text-zinc-500 mt-0.5">
              {filteredHistory.length} total picks · sorted by date, newest first
            </p>
          </div>
          <div className="flex gap-2 items-center flex-wrap">
            <input
              placeholder="Search player or team"
              value={historySearch}
              onChange={(e) => {
                setHistorySearch(e.target.value);
                setHistoryPage(1);
              }}
              className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-200 w-56 focus:outline-none focus:border-emerald-500/50"
            />
            <select
              value={historyResultFilter}
              onChange={(e) => {
                setHistoryResultFilter(e.target.value as "all" | "wins" | "losses" | "pending");
                setHistoryPage(1);
              }}
              className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-200 focus:outline-none focus:border-emerald-500/50"
            >
              <option value="all">All results</option>
              <option value="wins">Wins only</option>
              <option value="losses">Losses only</option>
              <option value="pending">Pending</option>
            </select>
            <select
              value={historyConfidenceFilter}
              onChange={(e) => {
                setHistoryConfidenceFilter(e.target.value as "all" | "70plus" | "shown");
                setHistoryPage(1);
              }}
              className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-200 focus:outline-none focus:border-emerald-500/50"
            >
              <option value="all">All confidence</option>
              <option value="70plus">70+ only</option>
              <option value="shown">Shown on Dashboard</option>
            </select>
            <button
              onClick={exportCsv}
              className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-300 hover:border-emerald-500/40 hover:text-emerald-400 transition"
            >
              Export
            </button>
          </div>
        </div>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[11px] text-zinc-500 uppercase tracking-wide border-b border-zinc-800 bg-zinc-900/60">
                  <HistoryHeader label="Date" col="game_date" onSort={handleSort} active={historySortKey} dir={historySortDir} />
                  <HistoryHeader label="Player / matchup" col="player_name" onSort={handleSort} active={historySortKey} dir={historySortDir} />
                  <th className="text-left px-3 py-2.5 font-medium">Pick</th>
                  <HistoryHeader label="Odds" col="odds" onSort={handleSort} active={historySortKey} dir={historySortDir} align="right" />
                  <th className="text-left px-3 py-2.5 font-medium">Tier</th>
                  <HistoryHeader label="Conf" col="confidence" onSort={handleSort} active={historySortKey} dir={historySortDir} align="right" />
                  <th className="text-right px-3 py-2.5 font-medium">CLV</th>
                  <th className="text-right px-5 py-2.5 font-medium">Result</th>
                </tr>
              </thead>
              <tbody>
                {pageData.map((p) => {
                  const tier = getConfTier(p.confidence);
                  const units = p.hit === null ? null : payoutUnits(p.odds, p.hit);
                  const confColor =
                    p.confidence >= 90 ? "text-amber-300" : p.confidence >= 80 ? "text-emerald-400" : p.confidence >= 70 ? "text-zinc-200" : "text-zinc-400";
                  return (
                    <tr key={p.id} className="border-b border-zinc-800 hover:bg-zinc-800/30">
                      <td className="px-5 py-2.5 text-[12px] text-zinc-400 whitespace-nowrap">{formatGameDate(p.game_date)}</td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-2.5">
                          <TeamDot team={p.team} size={10} />
                          <span className="font-semibold text-zinc-200 whitespace-nowrap">{p.player_name}</span>
                          {p.opponent && (
                            <span className="text-[11px] text-zinc-500">{teamAbbr(p.team)} vs {teamAbbr(p.opponent)}</span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="capitalize text-zinc-300 font-medium">{p.prop_type}</span>
                        <span className="mx-1 text-zinc-600">·</span>
                        <span className="capitalize text-zinc-400">{p.pick_side}</span>
                        <span className="ml-1 text-zinc-200 font-semibold">{p.line}</span>
                      </td>
                      <td className="px-3 py-2.5 text-right text-zinc-400">{fmtOdds(p.odds)}</td>
                      <td className={`px-3 py-2.5 text-[11px] font-semibold uppercase tracking-wider ${tier.textClass}`}>
                        {tier.label}
                      </td>
                      <td className={`px-3 py-2.5 text-right font-bold text-[15px] ${confColor}`}>{p.confidence}</td>
                      <td className="px-3 py-2.5 text-right text-[12px] whitespace-nowrap">
                        {p.clv_pct == null ? (
                          <span className="text-zinc-600">—</span>
                        ) : (
                          <span className={p.clv_pct > 0 ? "text-emerald-400" : p.clv_pct < 0 ? "text-red-400" : "text-zinc-400"}>
                            {p.clv_pct > 0 ? "+" : ""}{p.clv_pct.toFixed(2)}%
                          </span>
                        )}
                      </td>
                      <td className="px-5 py-2.5 text-right text-[12px] font-semibold whitespace-nowrap">
                        {units === null ? (
                          <span className="text-zinc-500 font-normal">Pending</span>
                        ) : p.hit ? (
                          <span className="text-emerald-400">{fmtDollars(units)}</span>
                        ) : (
                          <span className="text-red-400">−${STAKE}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between px-4 py-2.5 border-t border-zinc-800 bg-zinc-900/40">
            <span className="text-xs text-zinc-500">
              Showing <span className="text-zinc-300 font-medium">
                {Math.min(filteredHistory.length, (pageClamped - 1) * PAGE_SIZE + 1)}–{Math.min(pageClamped * PAGE_SIZE, filteredHistory.length)}
              </span>{" "}
              of {filteredHistory.length}
            </span>
            <div className="flex items-center gap-2">
              <button
                disabled={pageClamped === 1}
                onClick={() => setHistoryPage(pageClamped - 1)}
                className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1 text-xs text-zinc-300 disabled:opacity-40 hover:bg-zinc-700"
              >
                ← Previous
              </button>
              <span className="text-xs text-zinc-500 px-2">Page {pageClamped} of {totalPages}</span>
              <button
                disabled={pageClamped === totalPages}
                onClick={() => setHistoryPage(pageClamped + 1)}
                className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1 text-xs text-zinc-300 disabled:opacity-40 hover:bg-zinc-700"
              >
                Next →
              </button>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

// ============================================================
// SUB-COMPONENTS
// ============================================================


const TIER_COLORS = {
  elite: "#f59e0b",   // amber — 90+
  strong: "#10b981",  // emerald — 80-89
  good: "#8b5cf6",    // violet — 70-79
} as const;

function EquityCard({
  equityData,
  finalUnits,
  peakUnits,
  troughUnits,
  bestDay,
  streak,
  tierFinals,
  tierCounts,
}: {
  equityData: { date: string; displayDate: string; units: number; expected: number; elite: number; strong: number; good: number }[];
  finalUnits: number;
  peakUnits: number;
  troughUnits: number;
  bestDay: number;
  streak: { count: number; kind: "W" | "L" | null };
  tierFinals: { elite: number; strong: number; good: number };
  tierCounts: { elite: number; strong: number; good: number };
}) {
  const up = finalUnits >= 0;
  const color = up ? "#10b981" : "#ef4444";
  const colorLight = up ? "#34d399" : "#f87171";
  return (
    <div className="rounded-xl border border-zinc-800 bg-gradient-to-b from-zinc-900 to-zinc-900/60 p-6 h-full flex flex-col" style={{ minHeight: 400 }}>
      <div className="flex items-start justify-between mb-1 flex-wrap gap-2">
        <div>
          <div className="text-xs text-zinc-500 mb-2">Profit</div>
          <div className="flex items-baseline gap-3">
            <span className="text-4xl font-extrabold tracking-tight leading-none" style={{ color }}>
              {fmtDollars(finalUnits)}
            </span>
            <span className="text-sm text-zinc-400">
              {finalUnits >= 0 ? "+" : ""}
              {finalUnits.toFixed(2)}u
            </span>
          </div>
          <div className="text-xs text-zinc-500 mt-1.5">
            Based on <span className="text-zinc-300 font-medium">${STAKE}</span> unit · low of {fmtDollars(troughUnits)}
          </div>
          <div className="text-[11px] text-zinc-500 mt-0.5">if you bet every 70+ pick at $100 (you didn't)</div>
        </div>
        <div className="flex items-center gap-5 text-right">
          <div>
            <div className="text-[10px] text-zinc-500 mb-0.5">Best day</div>
            <div className="text-sm font-semibold text-emerald-400">{fmtDollars(bestDay)}</div>
            <div className="text-[10px] text-zinc-500 mt-0.5">theoretical</div>
          </div>
          <div>
            <div className="text-[10px] text-zinc-500 mb-0.5">Streak</div>
            <div
              className={`text-sm font-semibold ${
                streak.kind === "W" ? "text-emerald-400" : streak.kind === "L" ? "text-red-400" : "text-zinc-400"
              }`}
            >
              {streak.count}
              {streak.kind ?? ""}
            </div>
            <div className="text-[10px] text-zinc-500 mt-0.5">of recent algorithm picks</div>
          </div>
          <div>
            <div className="text-[10px] text-zinc-500 mb-0.5">Peak</div>
            <div className="text-sm font-semibold text-emerald-400">{fmtDollars(peakUnits)}</div>
            <div className="text-[10px] text-zinc-500 mt-0.5">theoretical</div>
          </div>
        </div>
      </div>
      <div className="flex-1 mt-5 -mx-2">
        {equityData.length > 1 ? (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={equityData} margin={{ top: 8, right: 8, bottom: 0, left: -4 }}>
              <defs>
                <linearGradient id="profitArea" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={color} stopOpacity={0.4} />
                  <stop offset="60%" stopColor={color} stopOpacity={0.08} />
                  <stop offset="100%" stopColor={color} stopOpacity={0} />
                </linearGradient>
                <linearGradient id="profitStroke" x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0%" stopColor={colorLight} />
                  <stop offset="100%" stopColor={color} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="#27272a" strokeDasharray="0" vertical={false} />
              <XAxis
                dataKey="displayDate"
                stroke="#3f3f46"
                tick={{ fontSize: 11, fill: "#71717a" }}
                axisLine={false}
                tickLine={false}
                dy={8}
                interval="preserveStartEnd"
              />
              <YAxis
                stroke="#3f3f46"
                tick={{ fontSize: 11, fill: "#71717a" }}
                axisLine={false}
                tickLine={false}
                tickFormatter={(v) => `$${Math.round(v * STAKE)}`}
                width={54}
              />
              <Tooltip
                contentStyle={{
                  background: "#0a0a0a",
                  border: "1px solid #27272a",
                  borderRadius: "8px",
                  fontSize: "12px",
                  padding: "8px 12px",
                  boxShadow: "0 12px 32px rgba(0,0,0,0.5)",
                }}
                labelStyle={{ color: "#a1a1aa", fontSize: "11px", marginBottom: "4px", fontWeight: 500 }}
                formatter={(value, key) => {
                  const v = typeof value === "number" ? value : 0;
                  const labelMap: Record<string, string> = {
                    units: "All 70+",
                    expected: "Break-even",
                    elite: "Elite (90+)",
                    strong: "Strong (80-89)",
                    good: "Good (70-79)",
                  };
                  return [fmtDollars(v), labelMap[key as string] ?? (key as string)];
                }}
              />
              <ReferenceLine y={0} stroke="#3f3f46" strokeDasharray="2 4" strokeWidth={1} />
              <Area type="monotone" dataKey="expected" stroke="#52525b" strokeWidth={1.5} strokeDasharray="4 4" fill="none" dot={false} />
              <Area
                type="monotone"
                dataKey="units"
                stroke="url(#profitStroke)"
                strokeWidth={1.5}
                strokeOpacity={0.55}
                fill="url(#profitArea)"
                fillOpacity={0.35}
                dot={false}
                activeDot={{ r: 4, stroke: color, strokeWidth: 2, fill: "#0a0a0a" }}
              />
              <Line
                type="monotone"
                dataKey="elite"
                stroke={TIER_COLORS.elite}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4, stroke: TIER_COLORS.elite, strokeWidth: 2, fill: "#0a0a0a" }}
              />
              <Line
                type="monotone"
                dataKey="strong"
                stroke={TIER_COLORS.strong}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4, stroke: TIER_COLORS.strong, strokeWidth: 2, fill: "#0a0a0a" }}
              />
              <Line
                type="monotone"
                dataKey="good"
                stroke={TIER_COLORS.good}
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4, stroke: TIER_COLORS.good, strokeWidth: 2, fill: "#0a0a0a" }}
              />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <div className="h-full flex items-center justify-center text-xs text-zinc-500">
            Need at least 2 days of data
          </div>
        )}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3 text-[11px]">
        <TierLegend label="Elite 90+" units={tierFinals.elite} count={tierCounts.elite} color={TIER_COLORS.elite} />
        <TierLegend label="Strong 80-89" units={tierFinals.strong} count={tierCounts.strong} color={TIER_COLORS.strong} />
        <TierLegend label="Good 70-79" units={tierFinals.good} count={tierCounts.good} color={TIER_COLORS.good} />
        <div className="flex items-center gap-1.5 text-zinc-500">
          <span className="inline-block w-3 h-[2px] bg-zinc-500/70" />
          All 70+ (shaded)
        </div>
      </div>
    </div>
  );
}

function TierLegend({ label, units, count, color }: { label: string; units: number; count: number; color: string }) {
  const positive = units >= 0;
  return (
    <div className="flex items-center gap-1.5">
      <span className="inline-block w-3 h-[2px]" style={{ background: color }} />
      <span className="text-zinc-300">{label}</span>
      <span className={positive ? "text-emerald-400 font-semibold" : "text-red-400 font-semibold"}>
        {units >= 0 ? "+" : ""}{units.toFixed(2)}u
      </span>
      <span className="text-zinc-500">({count})</span>
    </div>
  );
}

function HitRateCard({ winRate, expected, edge }: { winRate: number; expected: number; edge: number }) {
  // D-548 — compare WR to the stake-weighted real per-pick BE (passed in
  // as `expected`) instead of the nominal -110 (0.524).
  const up = winRate >= expected;
  const color = up ? "text-emerald-400" : "text-red-400";
  const barColor = up ? "from-emerald-500 to-emerald-400" : "from-red-500 to-red-400";
  return (
    <div className="rounded-xl border border-zinc-800 bg-gradient-to-b from-zinc-900 to-zinc-900/60 p-5 flex-1 relative overflow-hidden">
      <div className="relative">
        <div className="flex items-center justify-between mb-1">
          <div className="text-xs text-zinc-500">Hit rate</div>
          <span className="text-[11px] text-zinc-500">
            Goal <span className="text-zinc-300 font-semibold">70%</span>
          </span>
        </div>
        <div className="flex items-baseline gap-1.5 mt-2">
          <span className={`text-5xl font-extrabold tracking-tight leading-none ${color}`}>
            {(winRate * 100).toFixed(1)}
          </span>
          <span className="text-xl text-zinc-500 font-medium">%</span>
        </div>
        <div className="text-xs text-zinc-500 mt-2">
          Market expected <span className="text-zinc-300 font-medium">{(expected * 100).toFixed(1)}%</span> · edge{" "}
          <span className={`font-medium ${color}`}>
            {edge >= 0 ? "+" : ""}
            {(edge * 100).toFixed(2)}%
          </span>
        </div>
        <div className="text-[11px] text-zinc-500 mt-1">of all 70+ algorithm picks (not your bets)</div>
        <div className="mt-4">
          <div className="relative h-[7px] bg-zinc-800 rounded-full overflow-hidden">
            <div
              className={`absolute inset-y-0 left-0 rounded-full bg-gradient-to-r ${barColor}`}
              style={{ width: `${Math.min(100, (winRate / 0.7) * 100)}%` }}
            />
          </div>
          <div className="flex justify-between text-[11px] text-zinc-500 mt-1.5">
            <span>{(winRate * 100).toFixed(1)}% now</span>
            <span>70%</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function ProfitCard({ units, roi, resolved, pendingCount }: { units: number; roi: number; resolved: number; pendingCount: number }) {
  const up = units >= 0;
  const color = up ? "text-emerald-400" : "text-red-400";
  return (
    <div className="rounded-xl border border-zinc-800 bg-gradient-to-b from-zinc-900 to-zinc-900/60 p-5 flex-1">
      <div className="text-xs text-zinc-500 mb-2">Units won</div>
      <div className="flex items-baseline gap-2">
        <span className={`text-4xl font-extrabold tracking-tight leading-none ${color}`}>
          {units >= 0 ? "+" : ""}
          {units.toFixed(1)}
        </span>
        <span className="text-lg text-zinc-500">units</span>
      </div>
      <div className="text-xs text-zinc-500 mt-2">
        <span className={`font-medium ${color}`}>
          {roi >= 0 ? "+" : ""}
          {(roi * 100).toFixed(1)}% ROI
        </span>{" "}
        across <span className="text-zinc-300 font-medium">{resolved}</span> resolved picks
      </div>
      <div className="text-[11px] text-zinc-500 mt-1">if you bet every 70+ pick at $100 (you didn't)</div>
      <div className="flex items-center gap-4 mt-4 pt-4 border-t border-zinc-800">
        <div>
          <div className="text-[11px] text-zinc-500">Pending tonight</div>
          <div className="text-base font-bold text-amber-300">{pendingCount}</div>
        </div>
        <div className="w-px h-8 bg-zinc-800" />
        <div>
          <div className="text-[11px] text-zinc-500">Dollars (${STAKE} unit)</div>
          <div className={`text-base font-bold ${color}`}>{fmtDollars(units)}</div>
        </div>
      </div>
    </div>
  );
}

function MatchCard({ p }: { p: PickHistoryRow }) {
  const isGamePick = p.prop_type === "spread" || p.prop_type === "game_total";
  const tier = getConfTier(p.confidence);
  const propLabel = p.prop_type === "game_total" ? "Total" : p.prop_type === "spread" ? "Spread" : p.prop_type;
  const teamA = teamAbbr(p.team);
  const teamB = teamAbbr(p.opponent);
  const colorA = TEAM_COLORS[teamA] || "#3f3f46";
  const colorB = TEAM_COLORS[teamB] || "#3f3f46";
  const impPct = Math.round(impliedProb(p.odds) * 100);

  return (
    <div className="flex-shrink-0 w-[260px] rounded-xl border border-zinc-800 bg-gradient-to-b from-zinc-900 to-zinc-900/60 p-4 hover:border-zinc-700 transition cursor-pointer relative overflow-hidden">
      <div
        className="absolute top-0 left-0 right-0 h-[3px]"
        style={{ background: `linear-gradient(90deg, ${colorA}, ${colorB})`, opacity: 0.8 }}
      />
      <div className="flex items-center justify-between mb-3 mt-1">
        <div className="flex items-center gap-1.5">
          {isGamePick ? (
            <span className="text-[10px] font-bold uppercase tracking-wider text-amber-300">Game pick</span>
          ) : (
            <div className="flex items-center">
              <span className="text-[11px] font-bold" style={{ color: colorA }}>{teamA}</span>
              <span className="text-[11px] text-zinc-600 mx-1">vs</span>
              <span className="text-[11px] font-bold" style={{ color: colorB }}>{teamB}</span>
            </div>
          )}
        </div>
        <span className="text-[10px] text-zinc-500">{formatGameDate(p.game_date)}</span>
      </div>

      {isGamePick ? (
        <div className="mb-3">
          <div className="flex items-center justify-center gap-3 py-1">
            <TeamCircle team={teamA} color={colorA} label="AWAY" />
            <span className="text-[11px] text-zinc-500 font-bold">@</span>
            <TeamCircle team={teamB} color={colorB} label="HOME" />
          </div>
          <div className="text-center mt-2">
            <div className="text-xs text-zinc-500">
              <span className="text-zinc-300 font-semibold">{propLabel}</span> ·{" "}
              <span className="capitalize text-zinc-300 font-medium">{p.pick_side}</span>{" "}
              <span className="text-zinc-200 font-semibold">{p.line}</span>
            </div>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-3 mb-3">
          <PlayerAvatar team={p.team} name={p.player_name} size={40} />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-bold text-zinc-100 truncate">{p.player_name}</div>
            <div className="text-[12px] text-zinc-500 truncate">
              <span className="capitalize">{p.prop_type}</span> ·{" "}
              <span className="capitalize text-zinc-300 font-medium">{p.pick_side}</span>{" "}
              <span className="text-zinc-200 font-semibold">{p.line}</span>
            </div>
          </div>
        </div>
      )}

      <div className="flex items-end justify-between pt-3 border-t border-zinc-800">
        <div>
          <div className="text-[10px] text-zinc-500 mb-0.5">Confidence</div>
          <div className="flex items-baseline gap-1.5">
            <span className="text-2xl font-extrabold leading-none text-amber-300">{p.confidence}</span>
            <span className={`text-[11px] font-bold uppercase tracking-wider ${tier.textClass}`}>
              {tier.label}
            </span>
          </div>
        </div>
        <div className="text-right">
          <div className="text-[10px] text-zinc-500 mb-0.5">Odds · Implied</div>
          <div className="text-xs font-semibold text-zinc-300">
            {fmtOdds(p.odds)} · {impPct}%
          </div>
        </div>
      </div>
    </div>
  );
}

function TeamCircle({ team, color, label }: { team: string; color: string; label: string }) {
  return (
    <div className="flex flex-col items-center">
      <div
        style={{
          width: 42,
          height: 42,
          borderRadius: "50%",
          background: `linear-gradient(135deg, ${color}, ${color}dd)`,
          color: "#fff",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: 13,
          fontWeight: 800,
          letterSpacing: "-0.02em",
          boxShadow: "0 0 0 1.5px rgba(255,255,255,0.06), 0 2px 6px rgba(0,0,0,0.3)",
        }}
      >
        {team}
      </div>
      <span className="text-[10px] text-zinc-500 mt-1 font-semibold">{label}</span>
    </div>
  );
}

function TierBreakdownCard({
  rows,
  maxTotal,
  bestTier,
  worstTier,
}: {
  rows: { key: string; label: string; color: string; total: number; wr: number; expected: number }[];
  maxTotal: number;
  bestTier: { label: string; color: string; wr: number; expected: number };
  worstTier: { label: string; color: string; wr: number; expected: number };
}) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 h-full flex flex-col">
      <div className="text-xs text-zinc-500 mb-4">Confidence tier performance</div>
      <div className="flex items-end justify-between gap-1.5 flex-1" style={{ minHeight: 120 }}>
        {rows.map((r) => {
          const heightPct = Math.max(6, (r.total / maxTotal) * 100);
          // D-548 — color per-tier WR vs real per-pick BE for that tier
          return (
            <div key={r.key} className="flex-1 flex flex-col items-center justify-end gap-1.5">
              <div className="text-[11px] font-bold" style={{ color: r.wr >= r.expected ? "#10b981" : "#ef4444" }}>
                {r.total > 0 ? `${Math.round(r.wr * 100)}%` : "—"}
              </div>
              <div
                className="w-full rounded-t-md relative"
                style={{
                  height: `${heightPct}%`,
                  background: `linear-gradient(180deg, ${r.color}cc, ${r.color}66)`,
                  minHeight: 6,
                }}
              >
                <div className="absolute inset-x-0 top-0 h-[2px] rounded-t-md" style={{ background: r.color }} />
              </div>
              <div className="text-center">
                <div className="text-[11px] font-semibold" style={{ color: r.color }}>
                  {r.label}
                </div>
                <div className="text-[10px] text-zinc-500">{r.total}</div>
              </div>
            </div>
          );
        })}
      </div>
      <div className="grid grid-cols-2 gap-2 mt-4 pt-4 border-t border-zinc-800">
        <div>
          <div className="text-[10px] text-zinc-500 mb-0.5">Best tier</div>
          <div className="flex items-baseline gap-1.5">
            <span className="text-xs font-bold" style={{ color: bestTier.color }}>{bestTier.label}</span>
            <span className="text-[11px] font-semibold text-emerald-400">{(bestTier.wr * 100).toFixed(1)}%</span>
          </div>
        </div>
        <div>
          <div className="text-[10px] text-zinc-500 mb-0.5">Weakest</div>
          <div className="flex items-baseline gap-1.5">
            <span className="text-xs font-bold" style={{ color: worstTier.color }}>{worstTier.label}</span>
            {/* D-548 — color worst tier WR vs its real per-pick BE */}
            <span className={`text-[11px] font-semibold ${worstTier.wr >= worstTier.expected ? "text-emerald-400" : "text-red-400"}`}>
              {(worstTier.wr * 100).toFixed(1)}%
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function PropBreakdownCard({ rows, maxTotal }: { rows: { name: string; total: number; wr: number; expected: number }[]; maxTotal: number }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 h-full">
      <div className="text-xs text-zinc-500 mb-4">Which prop types we pick most, and how we do</div>
      <div className="space-y-2">
        {/* D-548 — color WR vs real per-pick BE for each prop_type */}
        {rows.map((r) => (
          <div
            key={r.name}
            className="grid grid-cols-[88px_1fr_auto] items-center gap-3 hover:bg-zinc-800/30 -mx-2 px-2 py-1.5 rounded-md"
          >
            <span className="text-[13px] text-zinc-300 font-medium capitalize">{r.name}</span>
            <div className="relative h-[7px] bg-zinc-800 rounded-full overflow-hidden">
              <div
                className={`absolute inset-y-0 left-0 rounded-full ${
                  r.wr >= r.expected
                    ? "bg-gradient-to-r from-emerald-500 to-emerald-400"
                    : "bg-gradient-to-r from-red-500 to-red-400"
                }`}
                style={{ width: `${(r.total / maxTotal) * 100}%`, opacity: 0.85 }}
              />
            </div>
            <div className="text-right min-w-[80px]">
              <span className={`text-[13px] font-semibold ${r.wr >= r.expected ? "text-emerald-400" : "text-red-400"}`}>
                {(r.wr * 100).toFixed(1)}%
              </span>
              <span className="text-[12px] text-zinc-500 ml-2">{r.total}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function OddsBreakdownCard({ rows }: { rows: { name: string; total: number; wr: number; expected: number }[] }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 h-full">
      <div className="text-xs text-zinc-500 mb-4">How we do at different odds levels</div>
      <div className="space-y-2">
        {/* D-548 — color WR vs real per-pick BE within this odds bucket */}
        {rows.map((r) => (
          <div key={r.name} className="flex items-center justify-between hover:bg-zinc-800/30 -mx-2 px-2 py-1.5 rounded-md">
            <span className="text-[13px] text-zinc-300 font-medium">{r.name}</span>
            <div className="flex items-center gap-2">
              <span className={`text-[13px] font-semibold ${r.wr >= r.expected ? "text-emerald-400" : "text-red-400"}`}>
                {(r.wr * 100).toFixed(1)}%
              </span>
              <span className="text-[11px] text-zinc-500">{r.total}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function SideBreakdownCard({ rows }: { rows: { key: string; label: string; total: number; wr: number; expected: number }[] }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 h-full">
      <div className="text-xs text-zinc-500 mb-4">Side bias</div>
      <div className="grid grid-cols-2 gap-2">
        {/* D-548 — color WR vs real per-pick BE for each side */}
        {rows.map((r) => (
          <div
            key={r.key}
            className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 hover:border-zinc-700 transition cursor-pointer"
          >
            <div className="text-[11px] text-zinc-500 font-medium mb-1">{r.label}</div>
            <div className={`text-base font-bold ${r.wr >= r.expected ? "text-emerald-400" : "text-red-400"}`}>
              {(r.wr * 100).toFixed(1)}%
            </div>
            <div className="text-[11px] text-zinc-500 mt-0.5">{r.total}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function MiniStat({ label, value, positive }: { label: string; value: string; positive: boolean }) {
  return (
    <div>
      <div className="text-[11px] text-zinc-500 mb-1">{label}</div>
      <div className={`text-lg font-bold ${positive ? "text-emerald-400" : "text-red-400"}`}>{value}</div>
    </div>
  );
}

type SignalRow = {
  col: keyof PickHistoryRow;
  label: string;
  winAvg: number;
  lossAvg: number;
  delta: number;
  sample: number;
  direction: "up_hard" | "up" | "down" | "down_hard" | "hold";
};

function SignalCard({ r }: { r: SignalRow }) {
  const pos = r.delta >= 0;
  const colorHex = pos ? "#10b981" : "#ef4444";
  const arrow =
    r.direction === "up_hard"
      ? "↑↑"
      : r.direction === "up"
      ? "↑"
      : r.direction === "down_hard"
      ? "↓↓"
      : r.direction === "down"
      ? "↓"
      : "";
  const arrowColor = r.direction.startsWith("up")
    ? "text-emerald-400"
    : r.direction.startsWith("down")
    ? "text-red-400"
    : "text-zinc-500";
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 relative overflow-hidden hover:border-zinc-700 transition cursor-pointer">
      <div className="absolute top-0 left-0 right-0 h-[2px]" style={{ background: colorHex, opacity: 0.7 }} />
      <div className="flex items-start justify-between mb-3">
        <div className="text-sm font-semibold text-zinc-200 leading-tight">{r.label}</div>
        {arrow && <span className={`text-sm font-bold leading-none ${arrowColor}`}>{arrow}</span>}
      </div>
      <div>
        <div className="text-2xl font-extrabold leading-none tracking-tight" style={{ color: colorHex }}>
          {pos ? "+" : ""}
          {r.delta.toFixed(2)}
        </div>
        <div className="text-[11px] text-zinc-500 mt-1.5">
          <span className="text-emerald-400">{r.winAvg.toFixed(1)}</span>
          <span className="mx-1 text-zinc-600">vs</span>
          <span className="text-red-400">{r.lossAvg.toFixed(1)}</span>
        </div>
      </div>
    </div>
  );
}

function BadBeatRow({ p }: { p: PickHistoryRow }) {
  const tier = getConfTier(p.confidence);
  return (
    <div className="grid grid-cols-[auto_1fr_auto] items-center gap-3 px-5 py-3 border-b border-zinc-800 hover:bg-zinc-800/30">
      <PlayerAvatar team={p.team} name={p.player_name} size={34} />
      <div className="min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-sm font-semibold text-zinc-200 truncate">{p.player_name}</span>
          {p.opponent && (
            <span className="text-[12px] text-zinc-500">{teamAbbr(p.team)} vs {teamAbbr(p.opponent)}</span>
          )}
        </div>
        <div className="text-[12px] text-zinc-500 truncate">
          <span className="capitalize">{p.prop_type}</span> {p.pick_side}{" "}
          <span className="text-zinc-300 font-medium">{p.line}</span>
          <span className="mx-1.5 text-zinc-600">·</span>
          <span>{fmtOdds(p.odds)}</span>
          <span className="mx-1.5 text-zinc-600">·</span>
          <span>{formatGameDate(p.game_date)}</span>
        </div>
      </div>
      <div className="text-right">
        <div className="text-2xl font-extrabold leading-none text-red-400">{p.confidence}</div>
        <div className={`text-[11px] font-semibold uppercase tracking-wider mt-1 ${tier.textClass}`}>
          {tier.label}
        </div>
      </div>
    </div>
  );
}

function HistoryHeader({
  label,
  col,
  onSort,
  active,
  dir,
  align = "left",
}: {
  label: string;
  col: SortKey;
  onSort: (k: SortKey) => void;
  active: SortKey;
  dir: SortDir;
  align?: "left" | "right";
}) {
  const isActive = active === col;
  return (
    <th
      onClick={() => onSort(col)}
      className={`px-3 py-2.5 font-medium cursor-pointer hover:text-zinc-300 ${align === "right" ? "text-right" : "text-left"}`}
    >
      {label}
      {isActive && <span className="ml-1 text-emerald-400">{dir === "asc" ? "↑" : "↓"}</span>}
    </th>
  );
}

// ============================================================
// ADMIN PAGE — top-level component, SystemHealthSection
// Auth gate is enforced upstream by App.tsx (isAdmin check on nav +
// page render). The legacy PinGate / VITE_ADMIN_PASSCODE flow was
// removed Apr 29 in favor of Supabase Auth + ADMIN_EMAILS allowlist.
// ============================================================

function ConfirmModal({ title, body, confirmLabel, onConfirm, onCancel }: {
  title: string; body: string; confirmLabel: string;
  onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="max-w-md w-full rounded-xl border border-zinc-700 bg-zinc-900 p-5 shadow-2xl">
        <h3 className="text-base font-bold text-zinc-100 mb-1">{title}</h3>
        <p className="text-sm text-zinc-400 leading-relaxed mb-4">{body}</p>
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700">Cancel</button>
          <button onClick={onConfirm} className="rounded-lg border border-amber-500/40 bg-amber-500/20 px-3 py-1.5 text-xs text-amber-300 hover:bg-amber-500/30 font-medium">{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

interface AdminWeights {
  updated_at: string | null;
  backtest_win_pct: number | null;
  weights: Record<string, number | null>;
}

interface CronStatus {
  fetchOddsAt: string | null;
  processGamesAt: string | null;
  resolvePicksAt: string | null;
  weightsUpdatedAt: string | null;
}

interface AdminCounts {
  pickHistory: number | null;
  bets: number | null;
  recommendationsCache: number | null;
  propsCache: number | null;
  errorLog7d: number | null;
  runLog7d: number | null;
}

interface ErrorGroup { function_name: string; error_type: string; count: number; latest: string; sample: string }
interface TriggerOutcome { ok: boolean; message: string; durationMs: number }

function relativeTimeShort(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return "just now";
  const sec = Math.round(ms / 1000);
  if (sec < 60) return sec + "s ago";
  const min = Math.round(sec / 60);
  if (min < 60) return min + "m ago";
  const hr = Math.round(min / 60);
  if (hr < 48) return hr + "h ago";
  const day = Math.round(hr / 24);
  return day + "d ago";
}

function isStale(iso: string | null, hours: number): boolean {
  if (!iso) return true;
  return Date.now() - new Date(iso).getTime() > hours * 3600_000;
}

function SystemHealthSection() {
  const { session } = useAuthSession();
  // D-602 SHIP 2 — supabaseHeaders falls back to anon key (loadAll has
  // tables like api_usage / algorithm_weights that some sessions can read
  // anonymously). The auth-strictness fix lives in loadErrors below: it
  // (a) refuses to fetch error_log without a session, and (b) surfaces
  // 401/403/RLS as an explicit error state in the panel UI rather than
  // silently rendering "✓ All clear" — D-504 pattern from the
  // AlgorithmPerformanceSection fetchError.
  const supabaseHeaders = useMemo(() => ({
    "Content-Type": "application/json",
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${session?.access_token ?? SUPABASE_ANON_KEY}`,
  }), [session?.access_token]);
  const [counts, setCounts] = useState<AdminCounts>({ pickHistory: null, bets: null, recommendationsCache: null, propsCache: null, errorLog7d: null, runLog7d: null });
  const [cron, setCron] = useState<CronStatus>({ fetchOddsAt: null, processGamesAt: null, resolvePicksAt: null, weightsUpdatedAt: null });
  const [weights, setWeights] = useState<AdminWeights>({ updated_at: null, backtest_win_pct: null, weights: {} });
  const [errors, setErrors] = useState<ErrorGroup[]>([]);
  const [errorsError, setErrorsError] = useState<string | null>(null);  // D-602 SHIP 2
  const [errorWindow, setErrorWindow] = useState<"24h" | "7d">("24h");
  const [errorsLoading, setErrorsLoading] = useState(false);
  const [reloading, setReloading] = useState(false);

  // Manual triggers
  const [confirmFor, setConfirmFor] = useState<null | "fetch-odds" | "process-games">(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});
  const [outcome, setOutcome] = useState<Record<string, TriggerOutcome | null>>({});

  async function loadAll() {
    setReloading(true);
    try {
      const since7d = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString();

      // D-605 SHIP 1 — `Prefer: count=exact` forces PG to do an exact
      // COUNT(*) which for tables in the 100K+ row range exceeds the 8s
      // authenticated `statement_timeout` (D-604 measured props_cache at
      // 8,903 ms → 57014, recommendations_cache at 7,040 ms borderline).
      //
      // For unfiltered total counts on heavy tables, use count=planned
      // instead — PostgREST reads PG's planner estimate from
      // pg_class.reltuples (updated by autovacuum ANALYZE). It returns
      // in ≤ 1ms. Approximation is on the order of a few hundred rows
      // (autovacuum ANALYZE runs frequently); the badge is a rough
      // indicator anyway. For tables with row counts < 10K the estimate
      // is essentially exact.
      //
      // For FILTERED counts on small windows (error_log / run_log 7d),
      // count=exact is fast because the predicate cuts the row set to
      // a tiny slice — D-525 already added idx_error_log_created_at.
      // Keep count=exact for those.
      const headCount = (path: string, prefer: "planned" | "exact" = "planned") =>
        fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
          method: "HEAD",
          headers: { ...supabaseHeaders, Prefer: `count=${prefer}`, Range: "0-0" },
        }).then((r) => {
          const cr = r.headers.get("content-range");
          if (!cr) return null;
          const total = cr.split("/")[1];
          return total === "*" ? null : parseInt(total, 10);
        }).catch(() => null);

      const [pickHistory, bets, recCache, propsCache, errLog7d, runLog7d] = await Promise.all([
        headCount("pick_history?select=id"),       // planned (D-604: 3.2s exact → ~1ms planned)
        headCount("bets?select=id"),               // planned (small but consistent w/ siblings)
        headCount("recommendations_cache?select=id"), // planned (D-604: 7.0s exact → ~1ms planned)
        headCount("props_cache?select=id"),        // planned (D-604: 8.9s exact = TIMEOUT → ~1ms planned)
        headCount(`error_log?select=id&created_at=gte.${since7d}`, "exact"),  // filtered: exact OK (D-525 index)
        headCount(`run_log?select=id&created_at=gte.${since7d}`, "exact"),    // filtered: exact OK
      ]);
      setCounts({ pickHistory, bets, recommendationsCache: recCache, propsCache, errorLog7d: errLog7d, runLog7d });

      // Cron status sources
      const todayYmd = (() => {
        const e = new Date(Date.now() - 4 * 3600_000);
        return e.toISOString().slice(0, 10).replace(/-/g, "");
      })();

      const [foRes, pgRes, rpRes, awRes] = await Promise.all([
        fetch(`${SUPABASE_URL}/rest/v1/api_usage?function_name=eq.fetch-odds&select=called_at&order=called_at.desc&limit=1`, { headers: supabaseHeaders }),
        fetch(`${SUPABASE_URL}/rest/v1/cron_progress?game_date=eq.${todayYmd}&select=completed_at&order=completed_at.desc&limit=1`, { headers: supabaseHeaders }),
        fetch(`${SUPABASE_URL}/rest/v1/pick_history?select=resolved_at&resolved_at=not.is.null&order=resolved_at.desc&limit=1`, { headers: supabaseHeaders }),
        fetch(`${SUPABASE_URL}/rest/v1/algorithm_weights?select=*&order=updated_at.desc&limit=1`, { headers: supabaseHeaders }),
      ]);
      const foJson = foRes.ok ? await foRes.json() : [];
      const pgJson = pgRes.ok ? await pgRes.json() : [];
      const rpJson = rpRes.ok ? await rpRes.json() : [];
      const awJson = awRes.ok ? await awRes.json() : [];

      setCron({
        fetchOddsAt: foJson[0]?.called_at ?? null,
        processGamesAt: pgJson[0]?.completed_at ?? null,
        resolvePicksAt: rpJson[0]?.resolved_at ?? null,
        weightsUpdatedAt: awJson[0]?.updated_at ?? null,
      });

      // Algorithm weights — flatten the row's w_* keys
      const aw = awJson[0] ?? null;
      const wmap: Record<string, number | null> = {};
      if (aw) {
        for (const [k, v] of Object.entries(aw)) {
          if (k.startsWith("w_") && (typeof v === "number" || v === null)) wmap[k] = v as number | null;
        }
      }
      setWeights({
        updated_at: aw?.updated_at ?? null,
        backtest_win_pct: typeof aw?.backtest_win_pct === "number" ? aw.backtest_win_pct : null,
        weights: wmap,
      });

      await loadErrors(errorWindow);
    } finally {
      setReloading(false);
    }
  }

  async function loadErrors(win: "24h" | "7d") {
    setErrorsLoading(true);
    setErrorsError(null);  // D-602 SHIP 2 — clear any prior error before retry
    try {
      // D-602 SHIP 2 — refuse to fetch error_log without a session. Without
      // this gate, the anon-key fallback (`Bearer ${anon-key}`) hits an
      // error_log RLS deny → 401 → previously was silently set errors=[]
      // → panel rendered "✓ All clear — no errors in last 7d", indistinguishable
      // from a genuinely empty 7d window. The user perceived this as "Show 7d
      // is broken".
      if (!session?.access_token) {
        setErrorsError("Sign in required to view error_log. Use the Sign In button above the Performance panel.");
        setErrors([]);
        return;
      }
      const since = new Date(Date.now() - (win === "24h" ? 24 : 7 * 24) * 3600_000).toISOString();
      const url = `${SUPABASE_URL}/rest/v1/error_log?created_at=gte.${since}&select=function_name,error_type,error_message,created_at&order=created_at.desc&limit=500`;
      const res = await fetch(url, { headers: supabaseHeaders });
      // D-602 SHIP 2 — explicit error surfacing (mirrors D-504 pattern in
      // AlgorithmPerformanceSection.fetchData line ~355-363). Pre-D-602
      // this was `setErrors([]); return;` which masked 401/RLS deny as
      // empty data.
      if (!res.ok) {
        const bodyExcerpt = (await res.text()).slice(0, 200);
        const reason = res.status === 401 || res.status === 403
          ? `Auth error (HTTP ${res.status}). Your session may have expired or you lack error_log access — sign out and sign back in.`
          : `Error fetching error_log (HTTP ${res.status}). ${bodyExcerpt}`;
        setErrorsError(reason);
        setErrors([]);
        console.error(`[SystemHealth.loadErrors] win=${win} HTTP ${res.status} body=${bodyExcerpt}`);
        return;
      }
      const rows = await res.json() as { function_name: string; error_type: string; error_message: string; created_at: string }[];
      const groups = new Map<string, ErrorGroup>();
      for (const r of rows) {
        const k = `${r.function_name || "?"}|${r.error_type || "?"}`;
        const g = groups.get(k);
        if (!g) groups.set(k, { function_name: r.function_name || "?", error_type: r.error_type || "?", count: 1, latest: r.created_at, sample: r.error_message || "" });
        else { g.count += 1; if (r.created_at > g.latest) { g.latest = r.created_at; g.sample = r.error_message || g.sample; } }
      }
      setErrors([...groups.values()].sort((a, b) => b.count - a.count));
    } catch (err) {
      // D-602 SHIP 2 — surface network/JSON errors instead of falling
      // through to a stale errors[] state.
      const msg = err instanceof Error ? err.message : String(err);
      setErrorsError(`Network or parse error: ${msg}`);
      setErrors([]);
    } finally {
      setErrorsLoading(false);
    }
  }

  useEffect(() => {
    if (session?.access_token) loadAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.access_token]);
  useEffect(() => {
    if (session?.access_token) loadErrors(errorWindow);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [errorWindow, session?.access_token]);

  // Auto-clear outcome panels after 30s
  useEffect(() => {
    const timers: number[] = [];
    for (const [k, v] of Object.entries(outcome)) {
      if (v) {
        const t = window.setTimeout(() => setOutcome((o) => ({ ...o, [k]: null })), 30_000);
        timers.push(t);
      }
    }
    return () => { timers.forEach(window.clearTimeout); };
  }, [outcome]);

  async function trigger(fn: string, opts: { qs?: string; body?: any } = {}) {
    setBusy((b) => ({ ...b, [fn]: true }));
    setOutcome((o) => ({ ...o, [fn]: null }));
    const startedAt = Date.now();
    try {
      const url = `${SUPABASE_URL}/functions/v1/${fn}${opts.qs ?? ""}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { ...supabaseHeaders },
        body: opts.body ? JSON.stringify(opts.body) : undefined,
      });
      const text = await res.text();
      let parsed: any = null;
      try { parsed = JSON.parse(text); } catch { /* leave null */ }
      const dur = Date.now() - startedAt;
      const message = parsed
        ? Object.entries(parsed)
            .filter(([k]) => !["checks"].includes(k))
            .slice(0, 6)
            .map(([k, v]) => `${k}=${typeof v === "object" ? JSON.stringify(v).slice(0, 60) : String(v)}`)
            .join(" · ")
        : text.slice(0, 200);
      setOutcome((o) => ({ ...o, [fn]: { ok: res.ok, message, durationMs: dur } }));
      // Refresh telemetry after any successful trigger
      if (res.ok) loadAll();
    } catch (err) {
      setOutcome((o) => ({ ...o, [fn]: { ok: false, message: err instanceof Error ? err.message : String(err), durationMs: Date.now() - startedAt } }));
    } finally {
      setBusy((b) => ({ ...b, [fn]: false }));
    }
  }

  const weightsStale = isStale(weights.updated_at, 48);
  const cronWeightsStale = isStale(cron.weightsUpdatedAt, 24);

  const weightEntries = Object.entries(weights.weights).sort(([a], [b]) => a.localeCompare(b));

  return (
    <section className="space-y-4">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-zinc-100">System Health</h2>
          <p className="text-xs text-zinc-500 mt-0.5">Cron status, weights, errors, and manual triggers.</p>
        </div>
        <button
          onClick={loadAll}
          disabled={reloading}
          className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-700 disabled:opacity-50"
        >
          {reloading ? "Refreshing…" : "Refresh"}
        </button>
      </div>

      {/* Row count badges */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        <Badge label="pick_history" value={counts.pickHistory} />
        <Badge label="bets" value={counts.bets} />
        <Badge label="recs_cache" value={counts.recommendationsCache} />
        <Badge label="props_cache" value={counts.propsCache} />
        <Badge label="errors 7d" value={counts.errorLog7d} tone={counts.errorLog7d && counts.errorLog7d > 0 ? "warn" : "ok"} />
        <Badge label="runs 7d" value={counts.runLog7d} />
      </div>

      {/* Cron status */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
        <div className="text-sm font-semibold text-zinc-200 mb-2">Cron status</div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
          <CronTile name="fetch-odds" iso={cron.fetchOddsAt} staleHours={1} />
          <CronTile name="process-games" iso={cron.processGamesAt} staleHours={6} />
          <CronTile name="resolve-picks" iso={cron.resolvePicksAt} staleHours={24} />
          <CronTile name="auto-optimize-weights" iso={cron.weightsUpdatedAt} staleHours={24} unscheduled={cronWeightsStale} />
        </div>
      </div>

      {/* Algorithm weights */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
        <div className="flex items-end justify-between flex-wrap gap-2 mb-2">
          <div>
            <div className="text-sm font-semibold text-zinc-200">Algorithm weights</div>
            <div className="text-[11px] text-zinc-500">
              Updated {relativeTimeShort(weights.updated_at)}
              {typeof weights.backtest_win_pct === "number" && <> · backtest_win_pct <span className="text-zinc-300 font-medium">{weights.backtest_win_pct.toFixed(1)}%</span></>}
            </div>
          </div>
        </div>
        {weightsStale && (
          <div className="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2 mb-3 text-[12px] text-red-300">
            ⚠ UNSCHEDULED — auto-optimize last ran {relativeTimeShort(weights.updated_at)}. Weights frozen.
          </div>
        )}
        <div className="grid grid-cols-2 md:grid-cols-3 gap-x-4 gap-y-1 text-[12px]">
          {weightEntries.length === 0 && <div className="text-zinc-500">No weights row found.</div>}
          {weightEntries.map(([k, v]) => (
            <div key={k} className="flex items-baseline justify-between gap-2 border-b border-zinc-800/50 py-0.5">
              <span className="text-zinc-400 truncate" title={k}>{k.replace(/^w_/, "")}</span>
              <span className="tabular-nums text-zinc-200 font-medium">{typeof v === "number" ? v.toFixed(2) : "—"}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Errors feed */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
        <div className="flex items-center justify-between flex-wrap gap-2 mb-2">
          <div className="text-sm font-semibold text-zinc-200">Errors ({errorWindow})</div>
          <button
            onClick={() => setErrorWindow((w) => (w === "24h" ? "7d" : "24h"))}
            className="rounded-lg border border-zinc-700 bg-zinc-800 px-2.5 py-1 text-[11px] text-zinc-300 hover:bg-zinc-700"
          >
            Show {errorWindow === "24h" ? "7d" : "24h"}
          </button>
        </div>
        {errorsLoading ? (
          <div className="text-xs text-zinc-500">Loading…</div>
        ) : errorsError ? (
          // D-602 SHIP 2 — explicit auth/RLS/network error surfaced
          // instead of the pre-D-602 silent "✓ All clear" disguise.
          <div className="rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
            <div className="font-semibold mb-0.5">Couldn't load error_log ({errorWindow})</div>
            <div className="text-xs text-rose-300/90">{errorsError}</div>
          </div>
        ) : errors.length === 0 ? (
          <div className="text-sm text-emerald-400">✓ All clear — no errors in last {errorWindow}.</div>
        ) : (
          <div className="overflow-x-auto -mx-2">
            <table className="w-full text-[12px] min-w-[560px]">
              <thead>
                <tr className="text-[10px] uppercase tracking-wide text-zinc-500 border-b border-zinc-800">
                  <th className="text-left py-1.5 px-2 font-medium">Function</th>
                  <th className="text-left py-1.5 px-2 font-medium">Type</th>
                  <th className="text-right py-1.5 px-2 font-medium">Count</th>
                  <th className="text-right py-1.5 px-2 font-medium">Latest</th>
                  <th className="text-left py-1.5 px-2 font-medium">Sample</th>
                </tr>
              </thead>
              <tbody>
                {errors.slice(0, 20).map((g, i) => (
                  <tr key={i} className="border-b border-zinc-800/40">
                    <td className="py-1.5 px-2 text-zinc-300 font-medium">{g.function_name}</td>
                    <td className="py-1.5 px-2 text-amber-300">{g.error_type}</td>
                    <td className="py-1.5 px-2 text-right text-zinc-200 tabular-nums">{g.count}</td>
                    <td className="py-1.5 px-2 text-right text-zinc-500">{relativeTimeShort(g.latest)}</td>
                    <td className="py-1.5 px-2 text-zinc-400 truncate max-w-[28ch]" title={g.sample}>{g.sample}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Manual triggers */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/60 p-4">
        <div className="text-sm font-semibold text-zinc-200 mb-1">Manual triggers</div>
        <div className="text-[11px] text-zinc-500 mb-3">
          fetch-odds + process-games burn The Odds API credits — confirmation required.
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <TriggerButton
            label="Trigger fetch-odds"
            costly
            busy={!!busy["fetch-odds"]}
            outcome={outcome["fetch-odds"] ?? null}
            onClick={() => setConfirmFor("fetch-odds")}
          />
          <TriggerButton
            label="Trigger process-games (force=1)"
            costly
            busy={!!busy["process-games"]}
            outcome={outcome["process-games"] ?? null}
            onClick={() => setConfirmFor("process-games")}
          />
          <TriggerButton
            label="Trigger resolve-picks"
            busy={!!busy["resolve-picks"]}
            outcome={outcome["resolve-picks"] ?? null}
            onClick={() => trigger("resolve-picks")}
          />
          <TriggerButton
            label="Run health-check"
            busy={!!busy["health-check"]}
            outcome={outcome["health-check"] ?? null}
            onClick={() => trigger("health-check")}
          />
        </div>
      </div>

      {confirmFor === "fetch-odds" && (
        <ConfirmModal
          title="Trigger fetch-odds"
          body="Calls The Odds API once to refresh today's props_cache. ~1 + N events credits per call."
          confirmLabel="Yes, trigger"
          onConfirm={() => { setConfirmFor(null); trigger("fetch-odds"); }}
          onCancel={() => setConfirmFor(null)}
        />
      )}
      {confirmFor === "process-games" && (
        <ConfirmModal
          title="Trigger process-games (force=1)"
          body="Bypasses time gate; processes one pending game (if any). May call Odds API for game lines. Cron normally handles this — only trigger if you need to retry a stuck game."
          confirmLabel="Yes, trigger"
          onConfirm={() => { setConfirmFor(null); trigger("process-games", { qs: "?force=1" }); }}
          onCancel={() => setConfirmFor(null)}
        />
      )}
    </section>
  );
}

function Badge({ label, value, tone = "ok" }: { label: string; value: number | null; tone?: "ok" | "warn" }) {
  const valueColor = tone === "warn" ? "text-amber-300" : "text-zinc-100";
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</div>
      <div className={`text-base font-bold ${valueColor}`}>{value == null ? "—" : value.toLocaleString()}</div>
    </div>
  );
}

function CronTile({ name, iso, staleHours, unscheduled }: { name: string; iso: string | null; staleHours: number; unscheduled?: boolean }) {
  const stale = isStale(iso, staleHours);
  const tone = unscheduled ? "text-red-400" : stale ? "text-amber-300" : "text-emerald-400";
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 px-3 py-2">
      <div className="text-[10px] uppercase tracking-wide text-zinc-500 truncate" title={name}>{name}</div>
      <div className={`text-sm font-bold ${tone}`}>
        {unscheduled ? "UNSCHEDULED" : iso ? relativeTimeShort(iso) : "never"}
      </div>
    </div>
  );
}

function TriggerButton({ label, busy, outcome, onClick, costly }: { label: string; busy: boolean; outcome: TriggerOutcome | null; onClick: () => void; costly?: boolean }) {
  const border = costly ? "border-amber-500/30" : "border-zinc-700";
  return (
    <div>
      <button
        onClick={onClick}
        disabled={busy}
        className={`w-full rounded-lg border ${border} bg-zinc-800 px-3 py-2 text-xs font-medium text-zinc-200 hover:bg-zinc-700 disabled:opacity-50`}
      >
        {busy ? "Running…" : label}
      </button>
      {outcome && (
        <div className={`mt-1 rounded-md border px-2.5 py-1.5 text-[11px] leading-tight ${outcome.ok ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-300" : "border-red-500/40 bg-red-500/10 text-red-300"}`}>
          <div className="flex items-center justify-between">
            <span className="font-semibold">{outcome.ok ? "OK" : "FAIL"}</span>
            <span className="text-zinc-500">{(outcome.durationMs / 1000).toFixed(1)}s</span>
          </div>
          <div className="text-zinc-300 break-words">{outcome.message}</div>
        </div>
      )}
    </div>
  );
}

interface AllowedEmail {
  email: string;
  added_by: string | null;
  added_at: string;
  notes: string | null;
}

function AllowedEmailsSection() {
  const { session } = useAuthSession();
  const [rows, setRows] = useState<AllowedEmail[]>([]);
  const [loading, setLoading] = useState(true);
  const [newEmail, setNewEmail] = useState("");
  const [newNotes, setNewNotes] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const supabaseHeaders = useMemo(() => ({
    "apikey": SUPABASE_ANON_KEY,
    "Authorization": `Bearer ${session?.access_token ?? SUPABASE_ANON_KEY}`,
    "Content-Type": "application/json",
  }), [session?.access_token]);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/allowed_emails?select=email,added_by,added_at,notes&order=added_at.desc`,
        { headers: supabaseHeaders }
      );
      if (!r.ok) {
        setErr(`Load failed (${r.status})`);
        setRows([]);
      } else {
        setRows(await r.json());
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (session?.access_token) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.access_token]);

  async function add() {
    const email = newEmail.trim().toLowerCase();
    if (!email || !email.includes("@")) {
      setErr("Enter a valid email.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(`${SUPABASE_URL}/rest/v1/allowed_emails`, {
        method: "POST",
        headers: { ...supabaseHeaders, "Prefer": "return=representation" },
        body: JSON.stringify({
          email,
          added_by: session?.user?.email ?? "admin",
          notes: newNotes.trim() || null,
        }),
      });
      if (!r.ok) {
        const txt = await r.text();
        setErr(`Add failed (${r.status}): ${txt.slice(0, 120)}`);
      } else {
        setNewEmail("");
        setNewNotes("");
        await load();
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(email: string) {
    if (!confirm(`Remove ${email} from the allowlist?`)) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch(
        `${SUPABASE_URL}/rest/v1/allowed_emails?email=eq.${encodeURIComponent(email)}`,
        { method: "DELETE", headers: supabaseHeaders }
      );
      if (!r.ok) {
        setErr(`Remove failed (${r.status})`);
      } else {
        await load();
      }
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="rounded-xl border border-zinc-800 bg-gradient-to-b from-zinc-900 to-zinc-900/60 p-5">
      <div>
        <h2 className="text-base font-semibold text-zinc-100">Manage allowed emails</h2>
        <p className="text-xs text-zinc-400 mt-0.5 max-w-2xl">
          Only emails on this list can sign in. Add friends here before sharing the URL.
          Magic link goes to the email; no passwords.
        </p>
      </div>

      <div className="mt-4 grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto] gap-2">
        <input
          type="email"
          value={newEmail}
          onChange={(e) => setNewEmail(e.target.value)}
          placeholder="friend@example.com"
          className="rounded-lg border border-zinc-700 bg-zinc-950/60 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-500/60 focus:outline-none focus:ring-1 focus:ring-emerald-500/30"
        />
        <input
          type="text"
          value={newNotes}
          onChange={(e) => setNewNotes(e.target.value)}
          placeholder="notes (e.g. friend stress test)"
          className="rounded-lg border border-zinc-700 bg-zinc-950/60 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-500/60 focus:outline-none focus:ring-1 focus:ring-emerald-500/30"
        />
        <button
          onClick={add}
          disabled={busy}
          className="rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-60"
        >
          {busy ? "Saving…" : "Add"}
        </button>
      </div>

      {err && (
        <div className="mt-3 rounded-lg border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-200">
          {err}
        </div>
      )}

      <div className="mt-4 overflow-x-auto rounded-lg border border-zinc-800">
        <table className="w-full text-sm min-w-[420px]">
          <thead className="bg-zinc-900/60 text-xs uppercase text-zinc-500">
            <tr>
              <th className="px-3 py-2 text-left">Email</th>
              <th className="px-3 py-2 text-left hidden sm:table-cell">Notes</th>
              <th className="px-3 py-2 text-left hidden md:table-cell">Added by</th>
              <th className="px-3 py-2 text-left">Added</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/60 text-zinc-300">
            {loading ? (
              <tr><td colSpan={5} className="px-3 py-3 text-xs text-zinc-500">Loading…</td></tr>
            ) : rows.length === 0 ? (
              <tr><td colSpan={5} className="px-3 py-3 text-xs text-zinc-500">No allowed emails. Add one above.</td></tr>
            ) : rows.map((r) => (
              <tr key={r.email}>
                <td className="px-3 py-2 font-medium text-zinc-100">{r.email}</td>
                <td className="px-3 py-2 text-xs text-zinc-400 hidden sm:table-cell">{r.notes ?? "—"}</td>
                <td className="px-3 py-2 text-xs text-zinc-500 hidden md:table-cell">{r.added_by ?? "—"}</td>
                <td className="px-3 py-2 text-xs text-zinc-500">{new Date(r.added_at).toLocaleDateString()}</td>
                <td className="px-3 py-2 text-right">
                  <button
                    onClick={() => remove(r.email)}
                    disabled={busy}
                    className="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-400 hover:text-red-300 hover:border-red-500/40 disabled:opacity-60"
                  >
                    Remove
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-3 text-xs text-zinc-500">
        Note: RLS on this table is not yet enabled — anon read is intentional so the AuthGate
        sign-in flow can check membership pre-magic-link. RLS lockdown ships in tomorrow's session.
      </p>
    </section>
  );
}

// D-609 HealthBanner — reads health_status_current and renders a top-of-page
// RED/AMBER/GREEN banner. RED if any check has status='fail'; AMBER if any
// 'warn' or 'info' (unknown); GREEN only when ALL checks are 'ok'. Failing
// checks expand to show detail. Refreshes every 5 minutes; the hourly cron
// (D-609 SHIP 3) is the source of truth.
interface HealthRow {
  check_name: string;
  status: "ok" | "warn" | "fail" | "info";
  detail: string;
  run_at: string;
}

function HealthBanner() {
  const { session } = useAuthSession();
  const [rows, setRows] = useState<HealthRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [refreshAt, setRefreshAt] = useState<number>(Date.now());

  const supabaseHeaders = useMemo(() => ({
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${session?.access_token ?? SUPABASE_ANON_KEY}`,
  }), [session?.access_token]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const res = await fetch(`${SUPABASE_URL}/rest/v1/health_status_current?select=*&order=check_name.asc`, { headers: supabaseHeaders });
        if (!res.ok) {
          if (!cancelled) {
            setLoadError(`HTTP ${res.status}`);
            setRows([]);
          }
          return;
        }
        const data = await res.json() as HealthRow[];
        if (!cancelled) {
          setLoadError(null);
          setRows(data);
        }
      } catch (e) {
        if (!cancelled) {
          setLoadError(e instanceof Error ? e.message : String(e));
          setRows([]);
        }
      }
    }
    load();
    const t = window.setInterval(() => setRefreshAt(Date.now()), 5 * 60 * 1000);
    return () => { cancelled = true; window.clearInterval(t); };
  }, [supabaseHeaders, refreshAt]);

  if (rows === null) {
    return <div className="rounded-md border border-zinc-700 bg-zinc-900/60 px-3 py-2 text-xs text-zinc-500">System health: loading…</div>;
  }
  if (loadError) {
    return (
      <div className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
        <span className="font-semibold">System health unavailable:</span> {loadError}
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div className="rounded-md border border-zinc-700 bg-zinc-900/60 px-3 py-2 text-xs text-zinc-500">
        System health: no checks recorded yet. Trigger <span className="font-mono text-zinc-300">system-health</span> to populate.
      </div>
    );
  }

  const failing = rows.filter((r) => r.status === "fail");
  const warning = rows.filter((r) => r.status === "warn" || r.status === "info");
  const okCount = rows.filter((r) => r.status === "ok").length;

  let bg = "border-emerald-500/40 bg-emerald-500/10 text-emerald-200";
  let title = `System health: GREEN (${okCount}/${rows.length} checks pass)`;
  if (failing.length > 0) {
    bg = "border-rose-500/50 bg-rose-500/10 text-rose-100";
    title = `System health: RED — ${failing.length} failing check${failing.length === 1 ? "" : "s"}`;
  } else if (warning.length > 0) {
    bg = "border-amber-500/40 bg-amber-500/10 text-amber-100";
    title = `System health: AMBER — ${warning.length} unknown / warning`;
  }

  return (
    <div className={`rounded-lg border px-4 py-3 ${bg}`}>
      <div className="text-sm font-semibold">{title}</div>
      {failing.length > 0 && (
        <ul className="mt-2 space-y-1 text-xs">
          {failing.map((r) => (
            <li key={r.check_name}>
              <span className="font-mono font-semibold">{r.check_name}</span>: {r.detail}
            </li>
          ))}
        </ul>
      )}
      {failing.length === 0 && warning.length > 0 && (
        <ul className="mt-2 space-y-1 text-xs opacity-90">
          {warning.map((r) => (
            <li key={r.check_name}>
              <span className="font-mono font-semibold">{r.check_name}</span> ({r.status}): {r.detail}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-1.5 text-[10px] opacity-60">
        Latest run: {rows[0]?.run_at ? relativeTimeShort(rows[0].run_at) : "unknown"} · refresh every 5 min · D-609 hourly cron.
      </div>
    </div>
  );
}

export default function Admin() {
  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-zinc-100">Admin</h1>
        <p className="text-sm text-zinc-500 mt-1">CEO console · System Health + Algorithm Performance.</p>
      </div>
      <HealthBanner />
      <SystemHealthSection />
      <AllowedEmailsSection />
      <div className="border-t border-zinc-800 pt-4">
        <h2 className="text-xl font-bold tracking-tight text-zinc-100 mb-1">Algorithm Performance</h2>
        <p className="text-xs text-zinc-500 mb-3">Theoretical numbers from <span className="text-zinc-400 font-medium">pick_history</span> at flat $100 stakes. This is the algorithm's view, not real-money P/L.</p>
        <AlgorithmPerformanceSection />
      </div>
    </div>
  );
}
