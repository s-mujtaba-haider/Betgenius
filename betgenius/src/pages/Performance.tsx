import { useState, useEffect, useMemo } from "react";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "@/lib/supabase";
import { isoToEtGameDateYmd } from "@/lib/etDate";
import { useAuthSession, currentUserId } from "@/lib/auth";
import { avgImpliedProb } from "@/lib/odds";
import CalibrationSection from "@/components/CalibrationSection";
import SelectionBiasSection from "@/components/SelectionBiasSection";
import { SportSelector } from "@/components/SportSelector";
import { readStoredSport, type Sport } from "@/lib/sport";
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

// Row from public.real_money_bets view (Migration 20260427000001).
// Every bet joined to its most-relevant pick_history row via natural key,
// with deterministic tiebreak (process-games > dashboard > evaluator).
interface RealMoneyBet {
  bet_id: string;
  user_id: string;
  placed_at: string;
  settled_at: string | null;
  player_name: string;
  prop_type: string;
  line: number;
  pick_side: string;
  odds: number;
  stake: number;
  status: "won" | "lost" | "pending" | "voided" | string;
  result_value: number | null;
  payout: number | null;
  book: string | null;
  bet_game_date_et: string;
  matched_pick_id: string | null;
  matched_pick_source: string | null;
  matched_pick_confidence: number | null;
  matched_pick_game_date: string | null;
  matched_pick_created_at: string | null;
  is_matched: boolean;
}

// Resolved pick_history row used for the "Algorithm theoretical" line on
// the Equity by source chart. Each pick treated as a flat $100 stake.
interface AlgoPick {
  game_date: string;          // YYYYMMDD
  hit: boolean | null;
  odds: number | null;
  prop_type: string | null;
  pick_side: string | null;
  clv_pct: number | null;
}

// Lite slice of pick_history rows for the Tonight's Top Picks section
// (still algo-theoretical — no bets exist for upcoming picks yet).
interface PendingPick {
  id: string;
  player_name: string;
  team: string | null;
  opponent: string | null;
  prop_type: string;
  line: number;
  pick_side: string;
  odds: number;
  confidence: number;
  game_date: string;
  game_time: string | null;
  is_home: boolean | null;
  recommendation_shown: boolean | null;
}


type SortKey =
  | "placed_at"
  | "player_name"
  | "prop_type"
  | "line"
  | "pick_side"
  | "odds"
  | "stake"
  | "matched_pick_confidence"
  | "status"
  | "payout";
type SortDir = "asc" | "desc";

type DateRange = "7d" | "30d" | "90d" | "lifetime";

// ============================================================
// CONSTANTS
// ============================================================

// D-548: BREAK_EVEN constant removed — was hardcoded 0.524 (-110 nominal).
// Use src/lib/odds.ts impliedProb / avgImpliedProb for per-pick real BE.
const PAGE_SIZE = 25;

const TEAM_COLORS: Record<string, string> = {
  ATL: "#E03A3E", BOS: "#007A33", BKN: "#000000", CHA: "#1D1160", CHI: "#CE1141",
  CLE: "#860038", DAL: "#00538C", DEN: "#0E2240", DET: "#C8102E", GSW: "#1D428A",
  HOU: "#CE1141", IND: "#FDBB30", LAC: "#C8102E", LAL: "#552583", MEM: "#5D76A9",
  MIA: "#98002E", MIL: "#00471B", MIN: "#0C2340", NOP: "#0C2340", NYK: "#006BB6",
  OKC: "#007AC1", ORL: "#0077C0", PHI: "#006BB6", PHX: "#1D1160", POR: "#E03A3E",
  SAC: "#5A2D81", SAS: "#C4CED4", TOR: "#CE1141", UTA: "#002B5C", WAS: "#002B5C",
};

const TEAM_TO_ABBR: Record<string, string> = {
  "Atlanta Hawks":"ATL","Boston Celtics":"BOS","Brooklyn Nets":"BKN","Charlotte Hornets":"CHA",
  "Chicago Bulls":"CHI","Cleveland Cavaliers":"CLE","Dallas Mavericks":"DAL","Denver Nuggets":"DEN",
  "Detroit Pistons":"DET","Golden State Warriors":"GSW","Houston Rockets":"HOU","Indiana Pacers":"IND",
  "Los Angeles Clippers":"LAC","Los Angeles Lakers":"LAL","LA Clippers":"LAC","Memphis Grizzlies":"MEM",
  "Miami Heat":"MIA","Milwaukee Bucks":"MIL","Minnesota Timberwolves":"MIN","New Orleans Pelicans":"NOP",
  "New York Knicks":"NYK","Oklahoma City Thunder":"OKC","Orlando Magic":"ORL","Philadelphia 76ers":"PHI",
  "Phoenix Suns":"PHX","Portland Trail Blazers":"POR","Sacramento Kings":"SAC","San Antonio Spurs":"SAS",
  "Toronto Raptors":"TOR","Utah Jazz":"UTA","Washington Wizards":"WAS",
};

const TIER_COLORS = {
  elite:  "#f59e0b", // amber — 90+
  strong: "#10b981", // emerald — 80-89
  good:   "#8b5cf6", // violet — 70-79
} as const;

// Tier definitions used by tier table + equity overlay.
type TierKey = "elite" | "strong" | "good" | "lean" | "skip" | "off_algo";
const TIER_DEFS: { key: TierKey; label: string; range: [number, number]; color: string }[] = [
  { key: "elite",  label: "Elite (90+)",   range: [90, 999], color: "#fde68a" },
  { key: "strong", label: "Strong (80-89)",range: [80, 89],  color: "#86efac" },
  { key: "good",   label: "Good (70-79)",  range: [70, 79],  color: "#bae6fd" },
  { key: "lean",   label: "Lean (60-69)",  range: [60, 69],  color: "#fcd34d" },
  { key: "skip",   label: "Skip (<60)",    range: [0,  59],  color: "#8a8376" },
];

function tierFor(b: RealMoneyBet): TierKey {
  if (!b.is_matched || b.matched_pick_confidence == null) return "off_algo";
  const c = b.matched_pick_confidence;
  if (c >= 90) return "elite";
  if (c >= 80) return "strong";
  if (c >= 70) return "good";
  if (c >= 60) return "lean";
  return "skip";
}

// ============================================================
// HELPERS
// ============================================================

function parseGameDate(dateStr: string): Date {
  if (!dateStr || dateStr.length !== 8) return new Date(NaN);
  const y = parseInt(dateStr.substring(0, 4));
  const m = parseInt(dateStr.substring(4, 6)) - 1;
  const d = parseInt(dateStr.substring(6, 8));
  return new Date(y, m, d);
}
function formatGameDate(dateStr: string): string {
  const d = parseGameDate(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
function gameDateISO(dateStr: string): string {
  if (!dateStr || dateStr.length !== 8) return "";
  return `${dateStr.slice(0,4)}-${dateStr.slice(4,6)}-${dateStr.slice(6,8)}`;
}
function fmtDollars(n: number | null | undefined): string {
  const v = n ?? 0;
  const sign = v >= 0 ? "+" : "−";
  return `${sign}$${Math.abs(v).toFixed(2)}`;
}
function fmtPct(n: number | null | undefined, digits = 1): string {
  if (n == null || isNaN(n)) return "—";
  return `${(n).toFixed(digits)}%`;
}
function fmtOdds(o: number | null | undefined): string {
  if (o == null) return "—";
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
function getOddsBucket(o: number): string {
  if (o <= -200) return "Heavy favorite";
  if (o <= -111) return "Standard";
  if (o <= 110)  return "Even";
  if (o <= 199)  return "Underdog";
  return "Longshot";
}

// D-548 — impliedProb moved to src/lib/odds.ts (canonical). Re-import for
// in-file usage to avoid touching the existing call sites at lines 529 / 576.
import { impliedProb } from "@/lib/odds";

// Convert an ISO timestamp to its game-date YYYYMMDD in ET (DST-aware via Intl).
function isoToEtGameDate(iso: string): string {
  try {
    const d = new Date(iso);
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: "America/New_York",
      year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return `${get("year")}${get("month")}${get("day")}`;
  } catch {
    return "";
  }
}

// Date-range cutoff as ISO string for PostgREST filters.
function dateRangeCutoff(range: DateRange): string | null {
  if (range === "lifetime") return null;
  const days = range === "7d" ? 7 : range === "30d" ? 30 : 90;
  return new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
}

// Convert an ISO timestamp to a YYYYMMDD ET game-date string. Used to
// align the algoPicks (game_date YYYYMMDD) with the dateRange cutoff.
// D-162 (May 14, 2026): DST-safe via shared helper. Pre-D-162 used raw -4h.
function toGameDate(iso: string): string {
  return isoToEtGameDateYmd(iso);
}

// Build a multi-series cumulative equity dataset keyed by some dimension
// of a RealMoneyBet (prop_type, pick_side, etc). Returns an array shaped
// for recharts: [{date, displayDate, [seriesKey]: cumulative$}, …]
// `minSettledPerSeries` drops series that haven't accumulated that many
// settled bets, to keep noisy 1- or 2-sample lines off the chart.
function buildMultiSeriesEquity(
  bets: RealMoneyBet[],
  keyOf: (b: RealMoneyBet) => string,
  minSettledPerSeries: number,
): { rows: { date: string; displayDate: string; [seriesKey: string]: string | number }[]; series: string[] } {
  // Per-series count for the threshold filter.
  const counts = new Map<string, number>();
  for (const b of bets) counts.set(keyOf(b), (counts.get(keyOf(b)) ?? 0) + 1);
  const keepKeys = new Set([...counts.entries()].filter(([, n]) => n >= minSettledPerSeries).map(([k]) => k));

  // Daily payout per (day, key)
  const daily: Record<string, Record<string, number>> = {}; // day -> key -> daily $
  for (const b of bets) {
    const k = keyOf(b);
    if (!keepKeys.has(k)) continue;
    const day = b.bet_game_date_et;
    (daily[day] ||= {})[k] = (daily[day]?.[k] ?? 0) + (b.payout || 0);
  }

  const sortedDays = Object.keys(daily).sort();
  const cum = new Map<string, number>();
  const series = [...keepKeys].sort();
  const rows = sortedDays.map((d) => {
    const row: { date: string; displayDate: string; [k: string]: string | number } = {
      date: gameDateISO(d),
      displayDate: formatGameDate(d),
    };
    for (const k of series) {
      const dayPL = daily[d]?.[k] ?? 0;
      cum.set(k, (cum.get(k) ?? 0) + dayPL);
      row[k] = +(cum.get(k) ?? 0).toFixed(2);
    }
    return row;
  });
  return { rows, series };
}

// Color palette for prop-type series. Picked for distinguishability on
// dark background.
const PROP_TYPE_COLORS: Record<string, string> = {
  points:     "#10b981", // emerald
  rebounds:   "#f59e0b", // amber
  assists:    "#3b82f6", // blue
  threes:     "#06b6d4", // cyan
  steals:     "#a855f7", // violet
  blocks:     "#ec4899", // pink
  turnovers:  "#f97316", // orange
  spread:     "#eab308", // yellow
  game_total: "#14b8a6", // teal
};

const SIDE_COLORS: Record<string, string> = {
  // Honoring spec's "Over (red), Under (green)" — counter to the usual
  // "over=green/under=red" convention but matches the chart's narrative
  // (overs leak, unders earn after C19 fix).
  over:  "#ef4444",
  under: "#10b981",
};

const SOURCE_COLORS = {
  real: "#10b981",  // emerald — bets actually placed
  algo: "#a855f7",  // violet — theoretical at flat $100
} as const;

function propTypeColor(key: string): string {
  return PROP_TYPE_COLORS[key.toLowerCase()] ?? "#71717a";
}

function propTypeLabel(key: string): string {
  // Title-case + special-case for game_total
  if (key === "game_total") return "Total";
  return key.charAt(0).toUpperCase() + key.slice(1);
}

// ============================================================
// SHARED UI PRIMITIVES
// ============================================================

function PlayerAvatar({ team, name, size = 34 }: { team: string | null; name: string; size?: number }) {
  const abbr = teamAbbr(team);
  const color = TEAM_COLORS[abbr] || "#3f3f46";
  const initials = getInitials(name);
  const fontSize = size <= 28 ? 10 : size <= 36 ? 12 : 14;
  return (
    <div
      style={{
        width: size, height: size, borderRadius: "50%",
        background: `linear-gradient(135deg, ${color}, ${color}dd)`,
        color: "#fff", display: "inline-flex",
        alignItems: "center", justifyContent: "center",
        fontSize, fontWeight: 700, letterSpacing: "-0.02em", flexShrink: 0,
        boxShadow: "0 0 0 1.5px rgba(255,255,255,0.06), 0 2px 6px rgba(0,0,0,0.3)",
      }}
    >{initials}</div>
  );
}

// ============================================================
// MAIN PAGE
// ============================================================

export default function Performance() {
  const { session } = useAuthSession();
  const userId = currentUserId(session);
  // Headers carry the user's session JWT so PostgREST evaluates RLS as
  // role=authenticated (admin-only tables read; bets row-filtered to own).
  // Falls back to anon when there's no session (shouldn't happen behind
  // AuthGate, but defensive).
  const supabaseHeaders = useMemo(() => ({
    "Content-Type": "application/json",
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${session?.access_token ?? SUPABASE_ANON_KEY}`,
  }), [session?.access_token]);
  const [loading, setLoading] = useState(true);
  const [bets, setBets] = useState<RealMoneyBet[]>([]);
  // D-260: pendingPicks state removed — "Tonight's algo picks" section moved
  // to Dashboard primary surface. Setter retained as no-op pattern in case
  // we re-introduce a drill-down. State + PendingPick interface preserved
  // in case of future use.
  const [, setPendingPicks] = useState<PendingPick[]>([]);
  const [algoPicks, setAlgoPicks] = useState<AlgoPick[]>([]);
  const [dateRange, setDateRange] = useState<DateRange>("30d");
  const [historyPage, setHistoryPage] = useState(1);
  const [historySearch, setHistorySearch] = useState("");
  const [historyResultFilter, setHistoryResultFilter] = useState<"all" | "wins" | "losses" | "pending">("all");
  const [historyTierFilter, setHistoryTierFilter] = useState<"all" | "70plus" | "off_algo">("all");
  const [historySortKey, setHistorySortKey] = useState<SortKey>("placed_at");
  const [historySortDir, setHistorySortDir] = useState<SortDir>("desc");
  // D-204 T3.5 — sport switcher. Performance page reads pick_history filtered
  // by sport. real_money_bets isn't sport-filtered (bets table doesn't carry
  // sport directly; matched_pick_id derefs into pick_history.sport but
  // filtering at the view level would lose unmatched bets). Sport state
  // therefore filters the pick_history pulls (tonight + algo theoretical)
  // and downstream sections that aggregate pick_history.
  const [sport, setSport] = useState<Sport>(() => readStoredSport());
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key !== "betgenius_user_sport" || e.newValue == null) return;
      setSport(e.newValue === "mlb" ? "mlb" : "nba");
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // D-061: usage + health state removed (operational sections moved to
  // Admin per CEO direction). fetchUsage + fetchHealth function bodies
  // and the OddsApiUsageCard / SystemHealthCard component defs deleted
  // below.

  useEffect(() => {
    fetchBets();
    fetchTonight();
    fetchAlgoPicks();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId, sport]);

  async function fetchBets() {
    setLoading(true);
    try {
      // D-605 SHIP 2b — KEYSET pagination (hygiene port).
      // user-scoped table → never hit the 8s timeout, but the OFFSET
      // pattern is the same sibling D-602/D-604 named. Port for
      // consistency so any future user-volume growth doesn't surface
      // a new whack-a-mole.
      // ORDER BY placed_at DESC + bet_id DESC tie-break for determinism.
      //
      // D-608 FIX: the view `public.real_money_bets` exposes `bet_id`,
      // NOT `id` (per migration 20260514000013, line 162). The original
      // D-605 keyset port referenced `id` (the column name on the
      // underlying `bets` table, but renamed in the view), causing
      // PostgREST to return 400 Bad Request on every Performance page
      // load — D-608 reading from live console: "Failed to load
      // resource: 400 (Bad Request) (real_money_bets)". All three
      // references (ORDER BY, cursor filter, and last-row property
      // access) corrected to `bet_id`.
      const PAGE = 1000;
      const collected: RealMoneyBet[] = [];
      let cursorPlacedAt: string | null = null;
      let cursorBetId: string | null = null;
      for (let i = 0; i < 50; i++) {
        let url: string;
        if (cursorPlacedAt === null) {
          url = `${SUPABASE_URL}/rest/v1/real_money_bets?user_id=eq.${userId}&order=placed_at.desc,bet_id.desc&limit=${PAGE}`;
        } else {
          const cp = encodeURIComponent(cursorPlacedAt);
          const cbid = encodeURIComponent(cursorBetId!);
          // Decomposed-seek for DESC keyset:
          //   placed_at <= cursor AND (placed_at < cursor OR bet_id < cursor_bet_id)
          url = `${SUPABASE_URL}/rest/v1/real_money_bets?user_id=eq.${userId}&placed_at=lte.${cp}&or=(placed_at.lt.${cp},bet_id.lt.${cbid})&order=placed_at.desc,bet_id.desc&limit=${PAGE}`;
        }
        const res = await fetch(url, { headers: supabaseHeaders });
        if (!res.ok) break;
        const rows = (await res.json()) as RealMoneyBet[];
        if (!Array.isArray(rows) || rows.length === 0) break;
        collected.push(...rows);
        if (rows.length < PAGE) break;
        const last = rows[rows.length - 1];
        cursorPlacedAt = last.placed_at;
        cursorBetId = last.bet_id;
      }
      setBets(collected);
    } catch (err) {
      console.error("Error fetching real_money_bets:", err);
    } finally {
      setLoading(false);
    }
  }

  async function fetchTonight() {
    // Tonight's pending picks come from pick_history directly (not bet yet).
    try {
      const now = new Date();
      // D-162 (May 14, 2026): DST-safe ET via toLocaleString 'en-CA'.
      // Pre-D-162 raw -4h offset broke in EST (Nov 2+) at 04:00-04:59 UTC.
      const easternStr = now.toLocaleString('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
      const todayYmd = easternStr.replace(/-/g, "");
      const url = `${SUPABASE_URL}/rest/v1/pick_history?sport=eq.${sport}&game_date=eq.${todayYmd}&voided=not.eq.true&hit=is.null&recommendation_shown=eq.true&order=confidence.desc&limit=12`;
      const res = await fetch(url, { headers: supabaseHeaders });
      if (!res.ok) return;
      const rows = (await res.json()) as PendingPick[];
      setPendingPicks(rows);
    } catch (err) {
      console.error("Error fetching tonight's picks:", err);
    }
  }

  // Resolved algo picks for the "Algorithm theoretical" line on the Equity
  // by source chart. Bound by recommendation_shown=true to mirror Admin's
  // algorithm view (only picks the user would have actually seen).
  //
  // D-605 SHIP 2 — KEYSET PAGINATION (replaces OFFSET-based paging).
  //
  // D-604 measured the pre-D-605 OFFSET loop at 707 ms (page 0) and 5,018
  // ms (OFFSET 20K). The 50-page loop totaled 7-15s wall-clock on cold
  // cache — the browser perceived it as hung. SAME D-602-class problem,
  // just on a different file the original D-602 batch didn't enumerate.
  //
  // Fix mirrors D-602's decomposed-seek pattern, ASC-inverted:
  //   WHERE game_date >= cursor_date
  //     AND (game_date > cursor_date OR id > cursor_id)
  // The first AND pushes into Index Cond on idx_ph_algo_shown_resolved
  // (sport, game_date) for a TRUE SEEK (no walk-and-discard). The
  // second AND is the tie-breaker for same-game_date rows.
  //
  // PostgREST encoding: `game_date=gte.${cd}` as the seek anchor +
  // `or=(game_date.gt.${cd},id.gt.${cid})` as the tie-break. No
  // `and=(...)` wrapper needed because fetchAlgoPicks has no other
  // top-level `or=` to combine with (unlike D-602 Admin).
  async function fetchAlgoPicks() {
    try {
      const PAGE = 1000;
      const collected: AlgoPick[] = [];
      let cursorGameDate: string | null = null;
      let cursorId: string | null = null;
      // Include id in the select for cursor tie-break. id is stripped
      // from collected[] downstream (AlgoPick doesn't carry it).
      const baseFilters = `sport=eq.${sport}&recommendation_shown=eq.true&voided=eq.false&hit=not.is.null&select=id,game_date,hit,odds,prop_type,pick_side,clv_pct,closing_odds,closing_capture_reason`;
      // ORDER BY (game_date, id) ASC — id sub-order makes the keyset
      // deterministic so we never skip or duplicate within a same-date group.
      const orderBy = `order=game_date.asc,id.asc`;

      for (let i = 0; i < 50; i++) {
        let url: string;
        if (cursorGameDate === null) {
          url = `${SUPABASE_URL}/rest/v1/pick_history?${baseFilters}&${orderBy}&limit=${PAGE}`;
        } else {
          const cd = encodeURIComponent(cursorGameDate);
          const cid = encodeURIComponent(cursorId!);
          // De Morgan expansion of NOT(game_date = cd AND id <= cid).
          url = `${SUPABASE_URL}/rest/v1/pick_history?${baseFilters}&game_date=gte.${cd}&or=(game_date.gt.${cd},id.gt.${cid})&${orderBy}&limit=${PAGE}`;
        }
        const res = await fetch(url, { headers: supabaseHeaders });
        if (!res.ok) break;
        const rows = (await res.json()) as Array<AlgoPick & { id: string }>;
        if (!Array.isArray(rows) || rows.length === 0) break;
        for (const row of rows) {
          const { id: _id, ...rest } = row;
          void _id;
          collected.push(rest as AlgoPick);
        }
        if (rows.length < PAGE) break;
        const last = rows[rows.length - 1];
        cursorGameDate = last.game_date;
        cursorId = last.id;
      }
      setAlgoPicks(collected);
    } catch (err) {
      console.error("Error fetching algo picks:", err);
    }
  }


  // ====== DERIVED DATA ======

  // D-061: User join date floor — Performance is user-scoped so the
  // theoretical equity line should NOT extend back before the user
  // joined. session.user.created_at is the auth-account creation
  // timestamp. CEO joined Apr 29 (post auth-foundation D-029); friends
  // join Friday onward. "Lifetime" toggle = since user joined, not
  // algorithm lifetime.
  const userJoinIso: string | null = session?.user?.created_at ?? null;
  const userJoinGameDate: string | null = userJoinIso ? toGameDate(userJoinIso) : null;
  const userJoinDisplay: string | null = userJoinIso
    ? new Date(userJoinIso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })
    : null;

  // Apply date-range filter to bets (not to pendingPicks or operational sections).
  const cutoffIso = useMemo(() => dateRangeCutoff(dateRange), [dateRange]);
  const inRange = useMemo(
    () => (cutoffIso == null ? bets : bets.filter((b) => b.placed_at >= cutoffIso)),
    [bets, cutoffIso]
  );

  // Duplicates: same natural key on same ET game day with >1 row → flag every row in the group.
  const duplicateBetIds = useMemo(() => {
    const groups: Record<string, string[]> = {};
    for (const b of inRange) {
      const k = [
        (b.player_name || "").toLowerCase(),
        (b.prop_type || "").toLowerCase(),
        (b.pick_side || "").toLowerCase(),
        b.line, b.bet_game_date_et,
      ].join("|");
      (groups[k] ||= []).push(b.bet_id);
    }
    const dups = new Set<string>();
    for (const ids of Object.values(groups)) if (ids.length > 1) ids.forEach((id) => dups.add(id));
    return dups;
  }, [inRange]);

  // Status partitions
  const unmatched = useMemo(() => inRange.filter((b) => !b.is_matched), [inRange]);
  const settled = useMemo(() => inRange.filter((b) => b.status === "won" || b.status === "lost"), [inRange]);
  const pending = useMemo(() => inRange.filter((b) => b.status === "pending"), [inRange]);

  // ====== HERO METRICS (whole population in range) ======
  const wins = settled.filter((b) => b.status === "won").length;
  const winRate = settled.length > 0 ? wins / settled.length : 0;
  const totalStake = settled.reduce((s, b) => s + (b.stake || 0), 0);
  const totalPayout = settled.reduce((s, b) => s + (b.payout || 0), 0);
  const roi = totalStake > 0 ? totalPayout / totalStake : 0;

  // Implied break-even rate weighted by stake
  const expectedWinRate = useMemo(() => {
    if (settled.length === 0) return 0;
    let stakeSum = 0, weighted = 0;
    for (const b of settled) {
      const s = b.stake || 0;
      stakeSum += s;
      weighted += s * impliedProb(b.odds);
    }
    return stakeSum > 0 ? weighted / stakeSum : 0;
  }, [settled]);
  const edge = winRate - expectedWinRate;

  // Sort settled by ET game date for the equity curve
  const sortedByDay = useMemo(
    () => [...settled].sort((a, b) => a.bet_game_date_et.localeCompare(b.bet_game_date_et)),
    [settled]
  );

  // Daily P/L map for best-day stat + hit streak
  const dailyPL = useMemo(() => {
    const m: Record<string, number> = {};
    for (const b of sortedByDay) m[b.bet_game_date_et] = (m[b.bet_game_date_et] ?? 0) + (b.payout || 0);
    return m;
  }, [sortedByDay]);
  const bestDay = useMemo(() => {
    let best = 0;
    for (const v of Object.values(dailyPL)) if (v > best) best = v;
    return best;
  }, [dailyPL]);
  const streak = useMemo(() => {
    let count = 0;
    let kind: "W" | "L" | null = null;
    for (let i = sortedByDay.length - 1; i >= 0; i--) {
      const k: "W" | "L" = sortedByDay[i].status === "won" ? "W" : "L";
      if (kind === null) { kind = k; count = 1; }
      else if (k === kind) count++;
      else break;
    }
    return { count, kind };
  }, [sortedByDay]);

  // Equity curve (real $) — tier-overlaid: total + elite + strong + good
  const equityData = useMemo(() => {
    type Bucket = { total: number; elite: number; strong: number; good: number; expected: number };
    const map: Record<string, Bucket> = {};
    for (const b of sortedByDay) {
      const day = b.bet_game_date_et;
      if (!map[day]) map[day] = { total: 0, elite: 0, strong: 0, good: 0, expected: 0 };
      const bk = map[day];
      const pay = b.payout || 0;
      const stake = b.stake || 0;
      bk.total += pay;
      // expected $ = (stake * implied_prob * payout_if_win) − (stake * (1−p)) — closed form:
      const p = impliedProb(b.odds);
      // Approximation: expected payout = stake * (p * fairWin − (1−p)). For -110, fairWin = stake * 100/110.
      // Simpler: at flat $stake, expected return = 0 when book vig is fairly priced; we use −vig-of-the-bet as expected.
      // Concrete: ev_dollars_per_bet = stake * (p * americanWinReturn(odds) − (1 − p))
      const winReturnPerStake = b.odds > 0 ? b.odds / 100 : 100 / Math.abs(b.odds);
      const evPerDollar = p * winReturnPerStake - (1 - p);
      bk.expected += stake * evPerDollar;
      const tier = tierFor(b);
      if (tier === "elite") bk.elite += pay;
      else if (tier === "strong") bk.strong += pay;
      else if (tier === "good") bk.good += pay;
    }
    let cumT = 0, cumE = 0, cumS = 0, cumG = 0, cumX = 0;
    return Object.keys(map).sort().map((d) => {
      const bk = map[d];
      cumT += bk.total; cumE += bk.elite; cumS += bk.strong; cumG += bk.good; cumX += bk.expected;
      return {
        date: gameDateISO(d),
        displayDate: formatGameDate(d),
        total: +cumT.toFixed(2),
        elite: +cumE.toFixed(2),
        strong: +cumS.toFixed(2),
        good: +cumG.toFixed(2),
        expected: +cumX.toFixed(2),
      };
    });
  }, [sortedByDay]);

  const finalDollars = equityData.length ? equityData[equityData.length - 1].total : 0;
  const peakDollars = equityData.length ? Math.max(...equityData.map((d) => d.total)) : 0;
  const troughDollars = equityData.length ? Math.min(...equityData.map((d) => d.total)) : 0;

  const tierFinals = useMemo(() => {
    const last = equityData[equityData.length - 1];
    return { elite: last?.elite ?? 0, strong: last?.strong ?? 0, good: last?.good ?? 0 };
  }, [equityData]);
  const tierCounts = useMemo(() => {
    let elite = 0, strong = 0, good = 0;
    for (const b of settled) {
      const t = tierFor(b);
      if (t === "elite") elite++;
      else if (t === "strong") strong++;
      else if (t === "good") good++;
    }
    return { elite, strong, good };
  }, [settled]);

  // ====== EQUITY BY PROP TYPE (Chart 1) ======
  // Cumulative payout per (prop_type, day). Drops prop types with <5
  // settled bets to avoid noise. Builds a unified date axis and
  // forward-fills missing days so lines are step-like (cumulative never
  // resets).
  const equityByProp = useMemo(() => buildMultiSeriesEquity(
    sortedByDay,
    (b) => (b.prop_type || "unknown").toLowerCase(),
    2,  // §15.5 May 7 walk fix: was 5; aggressive threshold hid every prop_type except Points. 2 surfaces multi-prop_type series while keeping 1-bet noise off the chart.
  ), [sortedByDay]);

  // ====== EQUITY BY SIDE (Chart 2) ======
  // Buckets bets by pick_side ∈ {over, under}. Spreads/totals (home/away)
  // fall outside this slice — they get their own future chart if needed.
  const equityBySide = useMemo(() => buildMultiSeriesEquity(
    sortedByDay.filter((b) => {
      const s = (b.pick_side || "").toLowerCase();
      return s === "over" || s === "under";
    }),
    (b) => (b.pick_side || "").toLowerCase(),
    1,  // §15.5 May 7 walk fix: was 5; threshold hid Under when its count was below 5. Binary keyspace (over/under) has no risk of over-surfacing — show both as long as either has any bets.
  ), [sortedByDay]);

  // ====== EQUITY BY SOURCE (Chart 3) ======
  // Real-money cumulative + algo-theoretical-flat-$100 cumulative on a
  // unified date axis. The gap between the two is the CEO selection alpha.
  const equityBySource = useMemo(() => {
    // Real money daily payout
    const realDaily = new Map<string, number>();
    for (const b of sortedByDay) {
      realDaily.set(b.bet_game_date_et, (realDaily.get(b.bet_game_date_et) ?? 0) + (b.payout || 0));
    }
    // Algo theoretical daily P/L at flat $100 stake.
    const algoDaily = new Map<string, number>();
    const cutoff = cutoffIso ? toGameDate(cutoffIso) : null;
    // D-061: also floor at the user's join date so the theoretical line
    // doesn't extend back before they joined. Whichever is later (cutoff
    // from the range toggle vs the user's join) wins.
    const effectiveFloor: string | null = (() => {
      if (cutoff && userJoinGameDate) return cutoff > userJoinGameDate ? cutoff : userJoinGameDate;
      return cutoff ?? userJoinGameDate;
    })();
    for (const p of algoPicks) {
      if (!p.game_date || p.hit == null) continue;
      if (effectiveFloor && p.game_date < effectiveFloor) continue;
      const odds = p.odds ?? -110;
      const winReturn = odds > 0 ? odds : (10000 / Math.abs(odds));  // payout for $100 stake
      const pnl = p.hit ? winReturn : -100;
      algoDaily.set(p.game_date, (algoDaily.get(p.game_date) ?? 0) + pnl);
    }
    // Unified sorted date axis.
    const allDays = new Set<string>([...realDaily.keys(), ...algoDaily.keys()]);
    const sortedDays = [...allDays].sort();
    let cumReal = 0, cumAlgo = 0;
    return sortedDays.map((d) => {
      cumReal += realDaily.get(d) ?? 0;
      cumAlgo += algoDaily.get(d) ?? 0;
      return {
        date: gameDateISO(d),
        displayDate: formatGameDate(d),
        real: +cumReal.toFixed(2),
        algo: +cumAlgo.toFixed(2),
      };
    });
  }, [sortedByDay, algoPicks, cutoffIso, userJoinGameDate]);

  // D-061 — A4: Daily W/L breakdown maps for the equity chart tooltip.
  // Theoretical: 70+ algo picks for that day with would-be record + P/L
  // at flat $100. Actual: bets the user placed that day with real
  // record + payout. Both keyed by game_date_et string ("YYYYMMDD").
  type DayBreakdown = { wins: number; losses: number; pnl: number; n: number };
  const algoDayBreakdown = useMemo(() => {
    const m = new Map<string, DayBreakdown>();
    const cutoff = cutoffIso ? toGameDate(cutoffIso) : null;
    const effectiveFloor: string | null = (() => {
      if (cutoff && userJoinGameDate) return cutoff > userJoinGameDate ? cutoff : userJoinGameDate;
      return cutoff ?? userJoinGameDate;
    })();
    for (const p of algoPicks) {
      if (!p.game_date || p.hit == null) continue;
      if (effectiveFloor && p.game_date < effectiveFloor) continue;
      const odds = p.odds ?? -110;
      const winReturn = odds > 0 ? odds : (10000 / Math.abs(odds));
      const pnl = p.hit ? winReturn : -100;
      const cur = m.get(p.game_date) ?? { wins: 0, losses: 0, pnl: 0, n: 0 };
      cur.n += 1;
      if (p.hit) cur.wins += 1; else cur.losses += 1;
      cur.pnl += pnl;
      m.set(p.game_date, cur);
    }
    return m;
  }, [algoPicks, cutoffIso, userJoinGameDate]);

  const algoAvgClv = useMemo(() => {
    const cutoff = cutoffIso ? toGameDate(cutoffIso) : null;
    const effectiveFloor: string | null = (() => {
      if (cutoff && userJoinGameDate) return cutoff > userJoinGameDate ? cutoff : userJoinGameDate;
      return cutoff ?? userJoinGameDate;
    })();
    const values = algoPicks
      .filter((p) => p.game_date && p.clv_pct != null && (!effectiveFloor || p.game_date >= effectiveFloor))
      .map((p) => p.clv_pct as number);
    if (values.length === 0) return null;
    return values.reduce((a, b) => a + b, 0) / values.length;
  }, [algoPicks, cutoffIso, userJoinGameDate]);

  const realDayBreakdown = useMemo(() => {
    const m = new Map<string, DayBreakdown>();
    for (const b of sortedByDay) {
      if (b.status !== "won" && b.status !== "lost") continue;
      const cur = m.get(b.bet_game_date_et) ?? { wins: 0, losses: 0, pnl: 0, n: 0 };
      cur.n += 1;
      if (b.status === "won") cur.wins += 1; else cur.losses += 1;
      cur.pnl += (b.payout || 0);
      m.set(b.bet_game_date_et, cur);
    }
    return m;
  }, [sortedByDay]);

  // Merge breakdowns onto each equity-chart point. Display strings
  // computed once here so the tooltip render is dumb.
  const equityBySourceWithBreakdown = useMemo(() => {
    return equityBySource.map((row) => {
      const ymd = row.date.replace(/-/g, "");
      const algo = algoDayBreakdown.get(ymd);
      const real = realDayBreakdown.get(ymd);
      const fmt = (b: DayBreakdown | undefined) => {
        if (!b || b.n === 0) return "—";
        const sign = b.pnl >= 0 ? "+" : "−";
        const dollars = Math.abs(Math.round(b.pnl));
        return `${b.wins}W-${b.losses}L (${sign}$${dollars})`;
      };
      return { ...row, algoDayLabel: fmt(algo), realDayLabel: fmt(real) };
    });
  }, [equityBySource, algoDayBreakdown, realDayBreakdown]);

  // ====== TIER BREAKDOWN (full real-money table) ======
  const tierRows = useMemo(() => {
    const out: { key: TierKey; label: string; color: string; bets: RealMoneyBet[] }[] = TIER_DEFS.map((t) => ({
      key: t.key, label: t.label, color: t.color,
      bets: inRange.filter((b) => tierFor(b) === t.key),
    }));
    out.push({
      key: "off_algo",
      label: "Off-algorithm",
      color: "#52525b",
      bets: inRange.filter((b) => tierFor(b) === "off_algo"),
    });
    return out.map((t) => {
      const decided = t.bets.filter((b) => b.status === "won" || b.status === "lost");
      const w = decided.filter((b) => b.status === "won").length;
      const stake = t.bets.reduce((s, b) => s + (b.stake || 0), 0);
      const payout = decided.reduce((s, b) => s + (b.payout || 0), 0);
      return {
        ...t,
        total: t.bets.length,
        decided: decided.length,
        wins: w,
        losses: decided.length - w,
        // D-548 — stake-weighted per-pick BE for this tier
        expected: decided.length ? avgImpliedProb(decided) : 0,
        pending: t.bets.filter((b) => b.status === "pending").length,
        winRate: decided.length ? w / decided.length : null,
        stake, payout,
        roi: stake > 0 ? payout / stake : null,
      };
    });
  }, [inRange]);

  // ====== PROP / ODDS / SIDE BREAKDOWNS ======
  const propRows = useMemo(() => {
    const map: Record<string, { decided: number; wins: number; stake: number; payout: number }> = {};
    for (const b of inRange) {
      const k = (b.prop_type || "").toLowerCase();
      if (!map[k]) map[k] = { decided: 0, wins: 0, stake: 0, payout: 0 };
      const m = map[k];
      m.stake += b.stake || 0;
      if (b.status === "won" || b.status === "lost") {
        m.decided++;
        if (b.status === "won") m.wins++;
        m.payout += b.payout || 0;
      }
    }
    // D-548 — collect odds/stake per group for per-pick BE
    const odds: Record<string, { odds: number; stake: number }[]> = {};
    for (const b of inRange) {
      const k = (b.prop_type || "").toLowerCase();
      if (b.status === "won" || b.status === "lost") {
        (odds[k] ||= []).push({ odds: b.odds, stake: b.stake || 0 });
      }
    }
    return Object.entries(map)
      .map(([name, d]) => ({
        name, decided: d.decided, wins: d.wins,
        wr: d.decided ? d.wins / d.decided : null,
        expected: d.decided ? avgImpliedProb(odds[name] || []) : null,
        stake: d.stake, payout: d.payout,
        roi: d.stake > 0 ? d.payout / d.stake : null,
      }))
      .sort((a, b) => b.decided - a.decided);
  }, [inRange]);

  const oddsRows = useMemo(() => {
    const buckets = ["Heavy favorite","Standard","Even","Underdog","Longshot"];
    const map: Record<string, { decided: number; wins: number; stake: number; payout: number }> = {};
    buckets.forEach((b) => (map[b] = { decided: 0, wins: 0, stake: 0, payout: 0 }));
    for (const b of inRange) {
      const key = getOddsBucket(b.odds);
      const m = map[key];
      m.stake += b.stake || 0;
      if (b.status === "won" || b.status === "lost") {
        m.decided++;
        if (b.status === "won") m.wins++;
        m.payout += b.payout || 0;
      }
    }
    // D-548 — per-bucket odds list for real BE
    const bucketOdds: Record<string, { odds: number; stake: number }[]> = {};
    for (const b of inRange) {
      if (b.status === "won" || b.status === "lost") {
        const key = getOddsBucket(b.odds);
        (bucketOdds[key] ||= []).push({ odds: b.odds, stake: b.stake || 0 });
      }
    }
    return buckets
      .map((name) => ({
        name, decided: map[name].decided, wins: map[name].wins,
        wr: map[name].decided ? map[name].wins / map[name].decided : null,
        expected: map[name].decided ? avgImpliedProb(bucketOdds[name] || []) : null,
        stake: map[name].stake, payout: map[name].payout,
        roi: map[name].stake > 0 ? map[name].payout / map[name].stake : null,
      }))
      .filter((r) => r.decided + (r.stake > 0 ? 1 : 0) > 0);
  }, [inRange]);

  const sideRows = useMemo(() => {
    const sides = [{ k: "over", l: "Over" }, { k: "under", l: "Under" }, { k: "home", l: "Home" }, { k: "away", l: "Away" }];
    return sides
      .map((s) => {
        const sb = inRange.filter((b) => (b.pick_side || "").toLowerCase() === s.k);
        const decided = sb.filter((b) => b.status === "won" || b.status === "lost");
        const w = decided.filter((b) => b.status === "won").length;
        const stake = sb.reduce((s, b) => s + (b.stake || 0), 0);
        const payout = decided.reduce((s, b) => s + (b.payout || 0), 0);
        return {
          key: s.k, label: s.l, total: sb.length, decided: decided.length,
          wr: decided.length ? w / decided.length : null,
          // D-548 — stake-weighted real BE over this side's decided bets
          expected: decided.length ? avgImpliedProb(decided) : null,
          stake, payout, roi: stake > 0 ? payout / stake : null,
        };
      })
      .filter((r) => r.total > 0);
  }, [inRange]);

  // ====== BAD BEATS ======
  const badBeats = useMemo(
    () =>
      inRange
        .filter((b) => b.status === "lost" && b.is_matched && (b.matched_pick_confidence ?? 0) >= 80)
        .sort((a, b) => (b.matched_pick_confidence ?? 0) - (a.matched_pick_confidence ?? 0))
        .slice(0, 8),
    [inRange]
  );

  // ====== HISTORY TABLE ======
  const filteredHistory = useMemo(() => {
    let rows = inRange;
    if (historySearch.trim()) {
      const q = historySearch.toLowerCase();
      rows = rows.filter((b) => (b.player_name || "").toLowerCase().includes(q));
    }
    if (historyResultFilter === "wins") rows = rows.filter((b) => b.status === "won");
    else if (historyResultFilter === "losses") rows = rows.filter((b) => b.status === "lost");
    else if (historyResultFilter === "pending") rows = rows.filter((b) => b.status === "pending");
    if (historyTierFilter === "70plus") rows = rows.filter((b) => (b.matched_pick_confidence ?? 0) >= 70);
    else if (historyTierFilter === "off_algo") rows = rows.filter((b) => !b.is_matched);
    return [...rows].sort((a, b) => {
      const av = (a as any)[historySortKey] ?? "";
      const bv = (b as any)[historySortKey] ?? "";
      const cmp = typeof av === "number" && typeof bv === "number" ? av - bv : String(av).localeCompare(String(bv));
      return historySortDir === "asc" ? cmp : -cmp;
    });
  }, [inRange, historySearch, historyResultFilter, historyTierFilter, historySortKey, historySortDir]);

  const totalPages = Math.max(1, Math.ceil(filteredHistory.length / PAGE_SIZE));
  const pageClamped = Math.min(historyPage, totalPages);
  const pageData = filteredHistory.slice((pageClamped - 1) * PAGE_SIZE, pageClamped * PAGE_SIZE);

  function handleSort(k: SortKey) {
    if (historySortKey === k) setHistorySortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setHistorySortKey(k); setHistorySortDir("desc"); }
    setHistoryPage(1);
  }

  function exportCsv() {
    const headers = ["placed_at","player","prop","side","line","odds","stake","status","payout","matched_pick_source","matched_pick_confidence","matched_pick_game_date","is_matched"];
    const rows = filteredHistory.map((b) => [
      b.placed_at, b.player_name, b.prop_type, b.pick_side, b.line, b.odds, b.stake, b.status,
      b.payout ?? "", b.matched_pick_source ?? "", b.matched_pick_confidence ?? "", b.matched_pick_game_date ?? "", b.is_matched,
    ]);
    const csv = [headers.join(","), ...rows.map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `bet_history_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-12 text-center">
          <p className="text-zinc-400">Loading bets…</p>
        </div>
      </div>
    );
  }

  if (bets.length === 0) {
    return (
      <div className="space-y-4">
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-12 text-center">
          <h2 className="text-xl font-semibold text-zinc-200 mb-2">No bets yet</h2>
          <p className="text-zinc-500 text-sm">Real-money picks will appear here once you log them via the Tracker page.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* HEADER + DATE RANGE */}
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-zinc-100">Performance</h1>
          <p className="text-sm text-zinc-500 mt-1 max-w-2xl">
            <span className="text-zinc-300 font-semibold">Real money</span> — only shows bets you placed at Hard Rock. For algorithm recommendations regardless of bet, see <span className="text-zinc-200 font-semibold">Admin</span>.
          </p>
          <p className="text-xs text-zinc-500 mt-1">
            <span className="text-zinc-300 font-semibold">{settled.length}</span> settled
            {pending.length > 0 && <> · <span className="text-amber-300 font-semibold">{pending.length}</span> pending</>}
            {unmatched.length > 0 && <> · <span className="text-zinc-400">{unmatched.length} off-algorithm</span></>}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {/* D-204 T3.5 — sport switcher; filters pick_history-derived sections */}
          <SportSelector value={sport} onChange={setSport} />
          <div className="flex gap-1 rounded-lg border border-zinc-800 bg-zinc-900/60 p-1">
            {(["7d","30d","90d","lifetime"] as DateRange[]).map((r) => (
              <button
                key={r}
                onClick={() => { setDateRange(r); setHistoryPage(1); }}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition ${
                  dateRange === r ? "bg-zinc-700 text-zinc-100" : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                {r === "7d" ? "Last 7 days" : r === "30d" ? "Last 30 days" : r === "90d" ? "Last 90 days" : "Lifetime"}
              </button>
            ))}
          </div>
        </div>
      </div>
      {sport === "mlb" && (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-200">
          MLB Early Beta · 7 markets · algorithm calibrating. Bets shown here are not yet sport-filtered — only pick_history-derived sections (Tonight's Top Picks, Equity by source, Sanity Checks) reflect the MLB cohort.
        </div>
      )}

      {/* D-061: Odds API usage + System Health cards moved to Admin only.
          Performance is now user-scoped (subscriber-facing); ops belong on
          Admin. SystemHealthCard + OddsApiUsageCard component definitions
          retained below for Admin to import if/when wired there. */}

      {/* HERO: equity + hit + profit */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2">
          <EquityCard
            equityData={equityData}
            finalDollars={finalDollars}
            peakDollars={peakDollars}
            troughDollars={troughDollars}
            bestDay={bestDay}
            streak={streak}
            tierFinals={tierFinals}
            tierCounts={tierCounts}
          />
        </div>
        <div className="flex flex-col gap-4">
          <HitRateCard winRate={winRate} expected={expectedWinRate} edge={edge} count={settled.length} />
          <ProfitCard
            payout={totalPayout}
            stake={totalStake}
            roi={roi}
            decided={settled.length}
            pendingCount={pending.length}
          />
          <RecordCard wins={wins} losses={settled.length - wins} />
        </div>
      </div>

      {/* EQUITY BY PROP TYPE / SIDE / SOURCE — equity-slice charts */}
      <MultiSeriesEquityCard
        title="Equity by prop type"
        caption="How each bet category has performed over time. Series with <5 bets hidden."
        data={equityByProp.rows}
        series={equityByProp.series.map((k) => ({ key: k, label: propTypeLabel(k), color: propTypeColor(k) }))}
      />
      <MultiSeriesEquityCard
        title="Equity by side"
        caption="Overs vs unders — where's the alpha?"
        data={equityBySide.rows}
        series={equityBySide.series.map((k) => ({
          key: k, label: k.charAt(0).toUpperCase() + k.slice(1), color: SIDE_COLORS[k] ?? "#71717a"
        }))}
        footnote="C19 over/under-hardcode fix shipped Apr 28 ~01:46Z. The Aug-onward divergence is the inflection."
      />
      <MultiSeriesEquityCard
        title="Equity by source"
        caption={userJoinDisplay
          ? `Performance since ${userJoinDisplay} · algorithm theoretical (flat $100) vs your placed bets (real money)${algoAvgClv != null ? ` · avg CLV ${algoAvgClv >= 0 ? "+" : ""}${algoAvgClv.toFixed(2)}%` : ""}`
          : `Algorithm theoretical (flat $100) vs your placed bets (real money)${algoAvgClv != null ? ` · avg CLV ${algoAvgClv >= 0 ? "+" : ""}${algoAvgClv.toFixed(2)}%` : ""}`}
        data={equityBySourceWithBreakdown}
        series={[
          { key: "real", label: "Real money (placed)", color: SOURCE_COLORS.real },
          { key: "algo", label: "Algo theoretical ($100 flat)", color: SOURCE_COLORS.algo },
        ]}
        footnote="Hover any day for that day's W/L breakdown. Theoretical line floors at your account creation date."
      />

      {/* TIER BREAKDOWN — promoted to full-width row */}
      <TierBreakdownCard rows={tierRows} />

      {/* OFF-ALGORITHM — separate card */}
      {unmatched.length > 0 && <OffAlgoCard bets={unmatched} />}

      {/* D-260 (2026-05-19): "Tonight's algo picks" REMOVED from Performance.
          Dashboard primary surface already shows the same data with better
          context (Kelly action, available books, full breakdown). Performance
          page focus is now real-money retrospective + algorithm transparency,
          not pre-bet recommendation feed. pendingPicks state preserved for
          future drill-down use if needed. */}

      {/* SECONDARY BREAKDOWNS — prop / odds / side */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4">
        <div className="lg:col-span-5"><PropBreakdownCard rows={propRows} /></div>
        <div className="lg:col-span-4"><OddsBreakdownCard rows={oddsRows} /></div>
        <div className="lg:col-span-3"><SideBreakdownCard rows={sideRows} /></div>
      </div>

      {/* BAD BEATS */}
      {badBeats.length > 0 && (
        <section>
          <div className="flex items-end justify-between mb-3">
            <div>
              <h2 className="text-lg font-bold tracking-tight text-zinc-100">Bad beats</h2>
              <p className="text-xs text-zinc-500 mt-0.5">High-confidence (80+) algo picks that lost in real money.</p>
            </div>
          </div>
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 overflow-hidden">
            {badBeats.map((b) => <BadBeatRow key={b.bet_id} b={b} />)}
          </div>
        </section>
      )}

      {/* BET HISTORY */}
      <section>
        <div className="flex items-end justify-between mb-2 flex-wrap gap-2">
          <div>
            <h2 className="text-lg font-bold tracking-tight text-zinc-100">Bets placed</h2>
            <p className="text-xs text-zinc-500 mt-0.5">
              {filteredHistory.length} in range, sorted by {historySortKey.replace(/_/g, " ")}
            </p>
          </div>
          <div className="flex gap-2 items-center flex-wrap">
            <input
              placeholder="Search player"
              value={historySearch}
              onChange={(e) => { setHistorySearch(e.target.value); setHistoryPage(1); }}
              className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-200 w-56 focus:outline-none focus:border-emerald-500/50"
            />
            <select
              value={historyResultFilter}
              onChange={(e) => { setHistoryResultFilter(e.target.value as any); setHistoryPage(1); }}
              className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-200 focus:outline-none focus:border-emerald-500/50"
            >
              <option value="all">All results</option>
              <option value="wins">Wins only</option>
              <option value="losses">Losses only</option>
              <option value="pending">Pending</option>
            </select>
            <select
              value={historyTierFilter}
              onChange={(e) => { setHistoryTierFilter(e.target.value as any); setHistoryPage(1); }}
              className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-200 focus:outline-none focus:border-emerald-500/50"
            >
              <option value="all">All tiers</option>
              <option value="70plus">70+ only</option>
              <option value="off_algo">Off-algorithm</option>
            </select>
            <button
              onClick={exportCsv}
              className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm text-zinc-300 hover:border-emerald-500/40 hover:text-emerald-400 transition"
            >Export</button>
          </div>
        </div>
        <p className="text-xs text-zinc-500 mb-3 max-w-3xl">
          Only shows bets you logged at Hard Rock. Days with no bets appear as gaps — that's expected. For full algorithm activity, see <span className="text-zinc-300 font-semibold">Admin → Pick History</span>.
        </p>
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[11px] text-zinc-500 uppercase tracking-wide border-b border-zinc-800 bg-zinc-900/60">
                  <HistoryHeader label="Placed" col="placed_at" onSort={handleSort} active={historySortKey} dir={historySortDir} />
                  <HistoryHeader label="Player / prop" col="player_name" onSort={handleSort} active={historySortKey} dir={historySortDir} />
                  <th className="text-left px-3 py-2.5 font-medium">Pick</th>
                  <HistoryHeader label="Odds" col="odds" onSort={handleSort} active={historySortKey} dir={historySortDir} align="right" />
                  <HistoryHeader label="Stake" col="stake" onSort={handleSort} active={historySortKey} dir={historySortDir} align="right" />
                  <HistoryHeader label="Conf" col="matched_pick_confidence" onSort={handleSort} active={historySortKey} dir={historySortDir} align="right" />
                  <th className="text-left px-3 py-2.5 font-medium">Pick src</th>
                  <th className="text-right px-5 py-2.5 font-medium">Result</th>
                </tr>
              </thead>
              <tbody>
                {pageData.map((b) => {
                  const isDup = duplicateBetIds.has(b.bet_id);
                  const conf = b.matched_pick_confidence;
                  const confColor =
                    conf == null ? "text-zinc-500" :
                    conf >= 90 ? "text-amber-300" :
                    conf >= 80 ? "text-emerald-400" :
                    conf >= 70 ? "text-zinc-200" : "text-zinc-400";
                  return (
                    <tr key={b.bet_id} className="border-b border-zinc-800 hover:bg-zinc-800/30">
                      <td className="px-5 py-2.5 text-[12px] text-zinc-400 whitespace-nowrap">
                        {new Date(b.placed_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-zinc-200">{b.player_name}</span>
                          {isDup && (
                            <span title="Duplicate bet on same natural key + day"
                              className="text-[10px] uppercase tracking-wider text-amber-300/80 border border-amber-500/30 rounded px-1.5 py-0.5">
                              dupe?
                            </span>
                          )}
                          {!b.is_matched && (
                            <span title="No matching pick_history row — manual / off-algorithm"
                              className="text-[10px] uppercase tracking-wider text-zinc-500 border border-zinc-700 rounded px-1.5 py-0.5">
                              off-algo
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="capitalize text-zinc-300 font-medium">{b.prop_type}</span>
                        <span className="mx-1 text-zinc-600">·</span>
                        <span className="capitalize text-zinc-400">{b.pick_side}</span>
                        <span className="ml-1 text-zinc-200 font-semibold">{b.line}</span>
                      </td>
                      <td className="px-3 py-2.5 text-right text-zinc-400">{fmtOdds(b.odds)}</td>
                      <td className="px-3 py-2.5 text-right text-zinc-400">${(b.stake || 0).toFixed(2)}</td>
                      <td className={`px-3 py-2.5 text-right font-bold text-[15px] ${confColor}`}>
                        {conf == null ? "—" : conf}
                      </td>
                      <td className="px-3 py-2.5 text-[11px] text-zinc-500">
                        {b.matched_pick_source ?? "—"}
                      </td>
                      <td className="px-5 py-2.5 text-right text-[12px] font-semibold whitespace-nowrap">
                        {b.status === "pending" ? (
                          <span className="text-zinc-500 font-normal">Pending</span>
                        ) : b.status === "won" ? (
                          <span className="text-emerald-400">{fmtDollars(b.payout)}</span>
                        ) : b.status === "lost" ? (
                          <span className="text-red-400">{fmtDollars(b.payout)}</span>
                        ) : (
                          <span className="text-zinc-500 font-normal">{b.status}</span>
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
              </span> of {filteredHistory.length}
            </span>
            <div className="flex items-center gap-2">
              <button
                disabled={pageClamped === 1}
                onClick={() => setHistoryPage(pageClamped - 1)}
                className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1 text-xs text-zinc-300 disabled:opacity-40 hover:bg-zinc-700"
              >← Previous</button>
              <span className="text-xs text-zinc-500 px-2">Page {pageClamped} of {totalPages}</span>
              <button
                disabled={pageClamped === totalPages}
                onClick={() => setHistoryPage(pageClamped + 1)}
                className="rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-1 text-xs text-zinc-300 disabled:opacity-40 hover:bg-zinc-700"
              >Next →</button>
            </div>
          </div>
        </div>
      </section>

      {/* Calibration section — added May 11, 2026. Reads from
          public.calibration_snapshots (daily cron jobid 13). */}
      <CalibrationSection />

      {/* D-260 (2026-05-19): algorithm-transparency sections demoted to
          collapsible <details>. Primary page narrative is real-money
          outcomes (above); these sections provide retrospective algo
          diagnostics that subscribers reach when they want to inspect.
          Default state: collapsed. Opens on click. */}
      <details className="rounded-xl border border-zinc-800 bg-zinc-900/30 overflow-hidden group">
        <summary className="px-4 py-3 cursor-pointer text-sm font-semibold text-zinc-300 hover:bg-zinc-800/50 transition-colors flex items-center justify-between">
          <span>📊 Algorithm diagnostics — selection bias + sanity checks</span>
          <span className="text-xs text-zinc-500 group-open:hidden">click to expand</span>
        </summary>
        <div className="border-t border-zinc-800 p-4 space-y-6">
          <SelectionBiasSection />
          <SanityChecksSection supabaseHeaders={supabaseHeaders} sport={sport} />
        </div>
      </details>
    </div>
  );
}

// ============================================================
// SanityChecksSection — D-166 coin-flip + D-167 negative-stacking rollup
// ============================================================
function SanityChecksSection({ supabaseHeaders, sport }: { supabaseHeaders: Record<string, string>; sport: Sport }) {
  const [loading, setLoading] = useState(true);
  const [elite30d, setElite30d] = useState<number>(0);
  const [coinFlip30d, setCoinFlip30d] = useState<number>(0);
  const [negStack30d, setNegStack30d] = useState<number>(0);
  const [negStackWr, setNegStackWr] = useState<{ stack: number | null; nonstack: number | null }>({ stack: null, nonstack: null });
  // D-225 Task 7.2 — extended flag breakdown.
  const [unbettable30d, setUnbettable30d] = useState<number>(0);
  const [secondary30d, setSecondary30d] = useState<number>(0);
  const [quarantined30d, setQuarantined30d] = useState<number>(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    async function fetch30d() {
      try {
        const cutoff = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
        const sourceParam = sport === "mlb" ? "source=eq.process-games-mlb" : "source=eq.process-games";
        const baseFilter = `sport=eq.${sport}&confidence=gte.80&is_synthetic=eq.false&${sourceParam}&created_at=gte.${cutoff}&voided=eq.false`;
        // D-521 sweep — same dead `Prefer: count=exact` pattern as the
        // Admin Performance panel. setElite30d / setCoinFlip30d /
        // setNegStack30d below all read rows.length / rows.filter().length
        // — the Content-Range count header is never consumed. Removing
        // count=exact eliminates the redundant aggregate (~12 ms warm,
        // larger cold-cache penalty on the same BitmapAnd 3-index plan).
        const res = await fetch(
          `${SUPABASE_URL}/rest/v1/pick_history?${baseFilter}&select=hit,coin_flip_flag,negative_stacking_flag,unbettable_juice_flag,is_secondary_market,is_d214_quarantined`,
          { headers: { ...supabaseHeaders, Range: "0-9999", "Range-Unit": "items" } },
        );
        if (!res.ok || cancelled) return;
        const rows = (await res.json()) as Array<{ hit: boolean | null; coin_flip_flag: boolean | null; negative_stacking_flag: boolean | null; unbettable_juice_flag: boolean | null; is_secondary_market: boolean | null; is_d214_quarantined: boolean | null }>;
        if (cancelled) return;
        setElite30d(rows.length);
        setCoinFlip30d(rows.filter((r) => r.coin_flip_flag).length);
        const ns = rows.filter((r) => r.negative_stacking_flag);
        setNegStack30d(ns.length);
        setUnbettable30d(rows.filter((r) => r.unbettable_juice_flag).length);
        setSecondary30d(rows.filter((r) => r.is_secondary_market).length);
        setQuarantined30d(rows.filter((r) => r.is_d214_quarantined).length);
        const nsResolved = ns.filter((r) => r.hit !== null);
        const otherResolved = rows.filter((r) => !r.negative_stacking_flag && r.hit !== null);
        const nsWr = nsResolved.length ? nsResolved.filter((r) => r.hit === true).length / nsResolved.length : null;
        const otherWr = otherResolved.length ? otherResolved.filter((r) => r.hit === true).length / otherResolved.length : null;
        setNegStackWr({ stack: nsWr, nonstack: otherWr });
      } catch (err) {
        console.error("SanityChecksSection fetch failed:", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    fetch30d();
    return () => { cancelled = true; };
  }, [supabaseHeaders, sport]);

  if (loading) return null;
  const coinFlipPct = elite30d > 0 ? (100 * coinFlip30d) / elite30d : 0;
  const negStackPct = elite30d > 0 ? (100 * negStack30d) / elite30d : 0;
  const coinFlipAlert = coinFlipPct > 10;
  const wrGap =
    negStackWr.stack !== null && negStackWr.nonstack !== null
      ? (negStackWr.nonstack - negStackWr.stack) * 100
      : null;
  const negStackAlert = wrGap !== null && wrGap > 10;

  return (
    <section className="mb-8">
      <h2 className="text-sm font-semibold text-zinc-200 mb-1">Sanity checks (rolling 30 days)</h2>
      <p className="text-xs text-zinc-500 mb-3 max-w-3xl">
        Elite-tier (confidence ≥ 80) picks broken out by sanity flags. Thresholds: coin-flip share &gt; 10% or
        negative-stacking WR deficit &gt; 10pp signals a factor-pumping issue worth investigating.
        <span className="block mt-1 text-emerald-400/70">
          ✓ Low fire rates here are expected and healthy — these flags catch rare over-confidence patterns.
        </span>
      </p>
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-xs">
          <div>
            <div className="text-zinc-500 mb-0.5">Elite picks (30d)</div>
            <div className="text-2xl font-bold text-zinc-200 tabular-nums">{elite30d}</div>
          </div>
          <div>
            <div className="text-zinc-500 mb-0.5">Coin-flip flagged</div>
            <div className={`text-2xl font-bold tabular-nums ${coinFlipAlert ? "text-orange-300" : "text-zinc-300"}`}>
              {coinFlip30d}
              <span className={`text-sm ml-1 ${coinFlipAlert ? "text-orange-300" : "text-zinc-500"}`}>
                ({coinFlipPct.toFixed(1)}%)
              </span>
            </div>
            <div className={`text-[10px] mt-0.5 ${coinFlipAlert ? "text-orange-300/80" : "text-zinc-500"}`}>
              D-166 — {coinFlipAlert ? "above 10% — investigate" : "within tolerance"}
            </div>
          </div>
          <div>
            <div className="text-zinc-500 mb-0.5">Negative-stacking flagged</div>
            <div className={`text-2xl font-bold tabular-nums ${negStackAlert ? "text-red-400" : "text-zinc-300"}`}>
              {negStack30d}
              <span className={`text-sm ml-1 ${negStackAlert ? "text-red-400" : "text-zinc-500"}`}>
                ({negStackPct.toFixed(1)}%)
              </span>
            </div>
            <div className={`text-[10px] mt-0.5 ${negStackAlert ? "text-red-400/80" : "text-zinc-500"}`}>
              D-167 — {negStackAlert ? "WR deficit > 10pp — Failure Mode D" : "within tolerance"}
            </div>
          </div>
          <div>
            <div className="text-zinc-500 mb-0.5">WR: stack vs. non-stack</div>
            <div className="text-sm font-medium text-zinc-200 tabular-nums">
              {negStackWr.stack !== null ? `${(negStackWr.stack * 100).toFixed(1)}%` : "—"}
              {" "}vs{" "}
              {negStackWr.nonstack !== null ? `${(negStackWr.nonstack * 100).toFixed(1)}%` : "—"}
            </div>
            <div className="text-[10px] text-zinc-500 mt-0.5">
              {wrGap !== null ? `Δ ${wrGap >= 0 ? "+" : ""}${wrGap.toFixed(1)}pp` : "Insufficient resolved picks"}
            </div>
          </div>
          {/* D-225 Task 7.2 — extended flag cells */}
          <div>
            <div className="text-zinc-500 mb-0.5">Unbettable juice</div>
            <div className={`text-2xl font-bold tabular-nums ${unbettable30d > 0 ? "text-red-300" : "text-zinc-300"}`}>
              {unbettable30d}
              <span className={`text-sm ml-1 ${unbettable30d > 0 ? "text-red-300/80" : "text-zinc-500"}`}>
                ({elite30d > 0 ? ((unbettable30d / elite30d) * 100).toFixed(1) : "0"}%)
              </span>
            </div>
            <div className="text-[10px] text-zinc-500 mt-0.5">
              D-164 — heavy juice on under-side picks
            </div>
          </div>
          <div>
            <div className="text-zinc-500 mb-0.5">Secondary markets</div>
            <div className="text-2xl font-bold tabular-nums text-zinc-300">
              {secondary30d}
              <span className="text-sm ml-1 text-zinc-500">
                ({elite30d > 0 ? ((secondary30d / elite30d) * 100).toFixed(1) : "0"}%)
              </span>
            </div>
            <div className="text-[10px] text-zinc-500 mt-0.5">
              D-165 — same player has higher-conf pick elsewhere
            </div>
          </div>
          <div>
            <div className="text-zinc-500 mb-0.5">Beta calibration excluded</div>
            <div className={`text-2xl font-bold tabular-nums ${quarantined30d > 0 ? "text-orange-300" : "text-zinc-300"}`}>
              {quarantined30d}
              <span className="text-sm ml-1 text-zinc-500">
                ({elite30d > 0 ? ((quarantined30d / elite30d) * 100).toFixed(1) : "0"}%)
              </span>
            </div>
            <div className="text-[10px] text-zinc-500 mt-0.5">
              D-214 — MLB Beta cold-start cohort excluded from rolling-30d
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

// ============================================================
// SUB-COMPONENTS
// ============================================================

function EquityCard({
  equityData, finalDollars, peakDollars, troughDollars, bestDay, streak, tierFinals, tierCounts,
}: {
  equityData: { date: string; displayDate: string; total: number; elite: number; strong: number; good: number; expected: number }[];
  finalDollars: number; peakDollars: number; troughDollars: number;
  bestDay: number; streak: { count: number; kind: "W" | "L" | null };
  tierFinals: { elite: number; strong: number; good: number };
  tierCounts: { elite: number; strong: number; good: number };
}) {
  const up = finalDollars >= 0;
  const color = up ? "#10b981" : "#ef4444";
  const colorLight = up ? "#34d399" : "#f87171";
  return (
    <div className="rounded-xl border border-zinc-800 bg-gradient-to-b from-zinc-900 to-zinc-900/60 p-6 h-full flex flex-col" style={{ minHeight: 400 }}>
      <div className="flex items-start justify-between mb-1 flex-wrap gap-2">
        <div>
          <div className="text-xs text-zinc-500 mb-2">Real-money P/L</div>
          <div className="flex items-baseline gap-3">
            <span className="text-4xl font-extrabold tracking-tight leading-none" style={{ color }}>
              {fmtDollars(finalDollars)}
            </span>
          </div>
          <div className="text-xs text-zinc-500 mt-1.5">
            Low {fmtDollars(troughDollars)} · Peak {fmtDollars(peakDollars)}
          </div>
          <div className="text-[11px] text-zinc-500 mt-0.5">of bets placed at Hard Rock</div>
        </div>
        <div className="flex items-center gap-5 text-right">
          <div>
            <div className="text-[10px] text-zinc-500 mb-0.5">Best day</div>
            <div className="text-sm font-semibold text-emerald-400">{fmtDollars(bestDay)}</div>
            <div className="text-[10px] text-zinc-500 mt-0.5">of bets placed</div>
          </div>
          <div>
            <div className="text-[10px] text-zinc-500 mb-0.5">Streak</div>
            <div className={`text-sm font-semibold ${
              streak.kind === "W" ? "text-emerald-400" : streak.kind === "L" ? "text-red-400" : "text-zinc-400"
            }`}>{streak.count}{streak.kind ?? ""}</div>
            <div className="text-[10px] text-zinc-500 mt-0.5">of bets placed</div>
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
                dataKey="displayDate" stroke="#3f3f46"
                tick={{ fontSize: 11, fill: "#71717a" }} axisLine={false} tickLine={false}
                dy={8} interval="preserveStartEnd" minTickGap={40}
              />
              <YAxis
                stroke="#3f3f46" tick={{ fontSize: 11, fill: "#71717a" }}
                axisLine={false} tickLine={false}
                tickFormatter={(v) => `$${Math.round(v)}`} width={54}
              />
              <Tooltip
                contentStyle={{ background: "#0a0a0a", border: "1px solid #27272a", borderRadius: "8px", fontSize: "12px", padding: "8px 12px", boxShadow: "0 12px 32px rgba(0,0,0,0.5)" }}
                labelStyle={{ color: "#a1a1aa", fontSize: "11px", marginBottom: "4px", fontWeight: 500 }}
                formatter={(value, key) => {
                  const v = typeof value === "number" ? value : 0;
                  const labelMap: Record<string, string> = {
                    total: "All bets", expected: "Expected (book vig)",
                    elite: "Elite (90+)", strong: "Strong (80-89)", good: "Good (70-79)",
                  };
                  return [fmtDollars(v), labelMap[key as string] ?? (key as string)];
                }}
              />
              <ReferenceLine y={0} stroke="#3f3f46" strokeDasharray="2 4" strokeWidth={1} />
              <Area type="monotone" dataKey="expected" stroke="#52525b" strokeWidth={1.5} strokeDasharray="4 4" fill="none" dot={false} />
              <Area
                type="monotone" dataKey="total" stroke="url(#profitStroke)" strokeWidth={1.5}
                strokeOpacity={0.55} fill="url(#profitArea)" fillOpacity={0.35}
                dot={false}
                activeDot={{ r: 4, stroke: color, strokeWidth: 2, fill: "#0a0a0a" }}
              />
              <Line type="monotone" dataKey="elite"  stroke={TIER_COLORS.elite}  strokeWidth={2} dot={false}
                activeDot={{ r: 4, stroke: TIER_COLORS.elite,  strokeWidth: 2, fill: "#0a0a0a" }} />
              <Line type="monotone" dataKey="strong" stroke={TIER_COLORS.strong} strokeWidth={2} dot={false}
                activeDot={{ r: 4, stroke: TIER_COLORS.strong, strokeWidth: 2, fill: "#0a0a0a" }} />
              <Line type="monotone" dataKey="good"   stroke={TIER_COLORS.good}   strokeWidth={2} dot={false}
                activeDot={{ r: 4, stroke: TIER_COLORS.good,   strokeWidth: 2, fill: "#0a0a0a" }} />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <div className="h-full flex items-center justify-center text-xs text-zinc-500">
            Need at least 2 settled days to plot
          </div>
        )}
      </div>
      <div className="mt-6 pt-3 border-t border-zinc-800/60 flex flex-wrap items-center gap-x-4 gap-y-2 text-[11px]">
        <TierLegend label="Elite 90+" dollars={tierFinals.elite} count={tierCounts.elite} color={TIER_COLORS.elite} />
        <TierLegend label="Strong 80-89" dollars={tierFinals.strong} count={tierCounts.strong} color={TIER_COLORS.strong} />
        <TierLegend label="Good 70-79" dollars={tierFinals.good} count={tierCounts.good} color={TIER_COLORS.good} />
        <div className="flex items-center gap-1.5 text-zinc-500">
          <span className="inline-block w-3 h-[2px] bg-zinc-500/70" />
          All bets (shaded)
        </div>
      </div>
    </div>
  );
}

function TierLegend({ label, dollars, count, color }: { label: string; dollars: number; count: number; color: string }) {
  const positive = dollars >= 0;
  return (
    <div className="flex items-center gap-1.5">
      <span className="inline-block w-3 h-[2px]" style={{ background: color }} />
      <span className="text-zinc-300">{label}</span>
      <span className={positive ? "text-emerald-400 font-semibold" : "text-red-400 font-semibold"}>
        {fmtDollars(dollars)}
      </span>
      <span className="text-zinc-500">({count})</span>
    </div>
  );
}

// Generic multi-line equity chart. Used for prop-type, side, and source
// breakdowns. Renders a "Not enough data" empty state when no series have
// settled-bet volume to plot. Visual conventions match EquityCard
// (CartesianGrid, ReferenceLine at 0, dark-tinted Tooltip).
type SeriesSpec = { key: string; label: string; color: string };
function MultiSeriesEquityCard({
  title, caption, data, series, footnote,
}: {
  title: string;
  caption: string;
  data: { date: string; displayDate: string; [k: string]: string | number }[];
  series: SeriesSpec[];
  footnote?: string;
}) {
  const empty = data.length < 2 || series.length === 0;
  return (
    <div className="rounded-xl border border-zinc-800 bg-gradient-to-b from-zinc-900 to-zinc-900/60 p-5">
      <div className="flex items-end justify-between flex-wrap gap-2 mb-3">
        <div>
          <h3 className="text-sm font-bold tracking-tight text-zinc-100">{title}</h3>
          <p className="text-xs text-zinc-500 mt-0.5">{caption}</p>
        </div>
        {/* Color-coded legend */}
        {!empty && (
          <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
            {series.map((s) => (
              <span key={s.key} className="flex items-center gap-1.5 text-zinc-400">
                <span className="inline-block h-2 w-3 rounded-sm" style={{ background: s.color }} />
                {s.label}
              </span>
            ))}
          </div>
        )}
      </div>
      <div style={{ height: 240 }}>
        {empty ? (
          <div className="h-full flex items-center justify-center text-xs text-zinc-500">
            Not enough data — need 2+ settled days and 5+ bets per series.
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: -4 }}>
              <CartesianGrid stroke="#27272a" strokeDasharray="0" vertical={false} />
              <XAxis
                dataKey="displayDate" stroke="#3f3f46"
                tick={{ fontSize: 11, fill: "#71717a" }} axisLine={false} tickLine={false}
                dy={8} interval="preserveStartEnd" minTickGap={40}
              />
              <YAxis
                stroke="#3f3f46" tick={{ fontSize: 11, fill: "#71717a" }}
                axisLine={false} tickLine={false}
                tickFormatter={(v) => `$${Math.round(v)}`} width={54}
              />
              {/* D-061 — A4: custom tooltip content shows daily W/L
                  breakdown per series. Reads algoDayLabel / realDayLabel
                  fields populated by equityBySourceWithBreakdown when
                  the series key matches "algo" or "real". Falls back to
                  cumulative-dollar formatter for other series. */}
              <Tooltip
                content={({ active, payload, label }) => {
                  if (!active || !payload || payload.length === 0) return null;
                  const row = payload[0]?.payload as Record<string, unknown> | undefined;
                  return (
                    <div style={{ background: "#0a0a0a", border: "1px solid #27272a", borderRadius: 8, padding: "8px 12px", boxShadow: "0 12px 32px rgba(0,0,0,0.5)", fontSize: 12 }}>
                      <div style={{ color: "#a1a1aa", fontSize: 11, marginBottom: 6, fontWeight: 500 }}>{label}</div>
                      {payload.map((p) => {
                        const k = p.dataKey as string;
                        const s = series.find((x) => x.key === k);
                        const v = typeof p.value === "number" ? p.value : 0;
                        const dayLabel = k === "algo"
                          ? (row?.algoDayLabel as string | undefined)
                          : k === "real"
                            ? (row?.realDayLabel as string | undefined)
                            : undefined;
                        return (
                          <div key={k} style={{ display: "flex", flexDirection: "column", gap: 2, marginBottom: 4 }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                              <span style={{ display: "inline-block", width: 10, height: 3, background: s?.color ?? "#fff" }} />
                              <span style={{ color: "#e4e4e7" }}>{s?.label ?? k}: <span style={{ color: "#fff", fontWeight: 600 }}>{fmtDollars(v)}</span> <span style={{ color: "#71717a", fontSize: 10 }}>cumulative</span></span>
                            </div>
                            {dayLabel && dayLabel !== "—" && (
                              <span style={{ color: "#a1a1aa", fontSize: 11, marginLeft: 16 }}>
                                this day: {dayLabel}
                              </span>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  );
                }}
              />
              <ReferenceLine y={0} stroke="#3f3f46" strokeDasharray="2 4" strokeWidth={1} />
              {series.map((s) => (
                <Line
                  key={s.key}
                  type="monotone"
                  dataKey={s.key}
                  stroke={s.color}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 4, stroke: s.color, strokeWidth: 2, fill: "#0a0a0a" }}
                />
              ))}
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
      {footnote && <p className="mt-3 text-[11px] text-zinc-600">{footnote}</p>}
    </div>
  );
}

function HitRateCard({ winRate, expected, edge, count }: { winRate: number; expected: number; edge: number; count: number }) {
  // D-548: compare WR against the stake-weighted per-pick break-even
  // (passed in as `expected`) instead of the nominal -110 (0.524).
  const up = winRate >= expected;
  const color = up ? "text-emerald-400" : "text-red-400";
  const barColor = up ? "from-emerald-500 to-emerald-400" : "from-red-500 to-red-400";
  return (
    <div className="rounded-xl border border-zinc-800 bg-gradient-to-b from-zinc-900 to-zinc-900/60 p-5 flex-1 relative overflow-hidden">
      <div className="relative">
        <div className="flex items-center justify-between mb-1">
          <div className="text-xs text-zinc-500">Hit rate</div>
          <span className="text-[11px] text-zinc-500">
            Break-even <span className="text-zinc-300 font-semibold">{(expected * 100).toFixed(1)}%</span>
          </span>
        </div>
        <div className="flex items-baseline gap-1.5 mt-2">
          <span className={`text-5xl font-extrabold tracking-tight leading-none ${color}`}>
            {(winRate * 100).toFixed(1)}
          </span>
          <span className="text-xl text-zinc-500 font-medium">%</span>
        </div>
        <div className="text-xs text-zinc-500 mt-2">
          Book-implied <span className="text-zinc-300 font-medium">{(expected * 100).toFixed(1)}%</span> · edge{" "}
          <span className={`font-medium ${color}`}>
            {edge >= 0 ? "+" : ""}{(edge * 100).toFixed(2)}%
          </span> · {count} settled
        </div>
        <div className="text-[11px] text-zinc-500 mt-1">of bets placed (not algorithm picks)</div>
        <div className="mt-4">
          <div className="h-1.5 rounded-full bg-zinc-800 overflow-hidden">
            <div className={`h-full bg-gradient-to-r ${barColor}`} style={{ width: `${Math.min(100, winRate * 100)}%` }} />
          </div>
        </div>
      </div>
    </div>
  );
}

function ProfitCard({ payout, stake, roi, decided, pendingCount }: { payout: number; stake: number; roi: number; decided: number; pendingCount: number }) {
  const up = payout >= 0;
  const color = up ? "text-emerald-400" : "text-red-400";
  return (
    <div className="rounded-xl border border-zinc-800 bg-gradient-to-b from-zinc-900 to-zinc-900/60 p-5 flex-1 relative overflow-hidden">
      <div className="text-xs text-zinc-500 mb-1">Profit / ROI</div>
      <div className="flex items-baseline gap-3">
        <span className={`text-3xl font-extrabold tracking-tight leading-none ${color}`}>{fmtDollars(payout)}</span>
        <span className={`text-sm font-semibold ${color}`}>
          {roi >= 0 ? "+" : ""}{(roi * 100).toFixed(2)}% ROI
        </span>
      </div>
      <div className="text-xs text-zinc-500 mt-2">
        ${stake.toFixed(2)} staked · {decided} decided
        {pendingCount > 0 && <> · <span className="text-amber-300">{pendingCount} pending</span></>}
      </div>
      <div className="text-[11px] text-zinc-500 mt-1">of bets placed at Hard Rock</div>
    </div>
  );
}

function RecordCard({ wins, losses }: { wins: number; losses: number }) {
  const total = wins + losses;
  return (
    <div className="rounded-xl border border-zinc-800 bg-gradient-to-b from-zinc-900 to-zinc-900/60 p-5 flex-1 relative overflow-hidden">
      <div className="text-xs text-zinc-500 mb-1">Record</div>
      <div className="flex items-baseline gap-2">
        <span className="text-3xl font-extrabold tracking-tight leading-none text-emerald-400">{wins}W</span>
        <span className="text-2xl font-bold tracking-tight leading-none text-zinc-500">-</span>
        <span className="text-3xl font-extrabold tracking-tight leading-none text-red-400">{losses}L</span>
      </div>
      <div className="text-xs text-zinc-500 mt-2">
        {total > 0 ? "wins/losses on bets placed" : "No settled bets in range"}
      </div>
    </div>
  );
}

type TierRow = {
  key: TierKey; label: string; color: string;
  total: number; decided: number; wins: number; losses: number; pending: number;
  winRate: number | null; stake: number; payout: number; roi: number | null;
  // D-548 — real per-pick break-even averaged over this tier's decided bets
  expected: number;
};

function TierBreakdownCard({ rows }: { rows: TierRow[] }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
      <div className="flex items-end justify-between flex-wrap gap-2 mb-4">
        <div>
          <h2 className="text-sm font-semibold text-zinc-200">Real money by confidence tier</h2>
          <p className="text-[11px] text-zinc-500 mt-0.5">
            Performance grouped by the matched algorithm pick's confidence. Off-algorithm = bets with no matching pick.
          </p>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm min-w-[720px]">
          <thead>
            <tr className="text-[11px] text-zinc-500 uppercase tracking-wide border-b border-zinc-800">
              <th className="text-left px-3 py-2 font-medium">Tier</th>
              <th className="text-right px-3 py-2 font-medium">Bets</th>
              <th className="text-right px-3 py-2 font-medium">W-L</th>
              <th className="text-right px-3 py-2 font-medium">Hit rate</th>
              <th className="text-right px-3 py-2 font-medium">Stake</th>
              <th className="text-right px-3 py-2 font-medium">Payout</th>
              <th className="text-right px-3 py-2 font-medium">ROI</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              // D-548 — color WR by real per-pick BE for this tier, not nominal -110
              const wrColor = r.winRate == null ? "text-zinc-500" : r.winRate >= r.expected ? "text-emerald-400" : "text-red-400";
              const roiColor = r.roi == null ? "text-zinc-500" : r.roi >= 0 ? "text-emerald-400" : "text-red-400";
              const dim = r.total === 0;
              return (
                <tr key={r.key} className={`border-b border-zinc-800 ${dim ? "opacity-50" : ""}`}>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: r.color }} />
                      <span className="text-zinc-200 font-medium">{r.label}</span>
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-right text-zinc-300">{r.total}</td>
                  <td className="px-3 py-2.5 text-right text-zinc-300">{r.wins}-{r.losses}{r.pending > 0 && <span className="text-amber-300/70 ml-1">+{r.pending}p</span>}</td>
                  <td className={`px-3 py-2.5 text-right font-semibold ${wrColor}`}>
                    {r.winRate == null ? "—" : fmtPct(r.winRate * 100)}
                  </td>
                  <td className="px-3 py-2.5 text-right text-zinc-400">${r.stake.toFixed(2)}</td>
                  <td className={`px-3 py-2.5 text-right font-semibold ${r.payout >= 0 ? "text-emerald-400" : "text-red-400"}`}>
                    {fmtDollars(r.payout)}
                  </td>
                  <td className={`px-3 py-2.5 text-right font-semibold ${roiColor}`}>
                    {r.roi == null ? "—" : `${r.roi >= 0 ? "+" : ""}${(r.roi * 100).toFixed(2)}%`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function OffAlgoCard({ bets }: { bets: RealMoneyBet[] }) {
  const decided = bets.filter((b) => b.status === "won" || b.status === "lost");
  const wins = decided.filter((b) => b.status === "won").length;
  const stake = bets.reduce((s, b) => s + (b.stake || 0), 0);
  const payout = decided.reduce((s, b) => s + (b.payout || 0), 0);
  const wr = decided.length ? wins / decided.length : null;
  const roi = stake > 0 ? payout / stake : null;
  // D-548 — real per-pick BE over the decided off-algo bets
  const expected = decided.length ? avgImpliedProb(decided) : null;
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
      <div className="flex items-end justify-between flex-wrap gap-2">
        <div>
          <h2 className="text-sm font-semibold text-zinc-200">Off-algorithm bucket</h2>
          <p className="text-[11px] text-zinc-500 mt-0.5">
            Bets without a matching pick_history row. Could be manual decisions, prop types not yet scored, or bets placed before the algo had data.
          </p>
        </div>
      </div>
      <div className="mt-3 grid grid-cols-2 md:grid-cols-5 gap-3 text-sm">
        <div><div className="text-[10px] uppercase tracking-wide text-zinc-500">Bets</div><div className="text-lg font-bold text-zinc-100">{bets.length}</div></div>
        <div><div className="text-[10px] uppercase tracking-wide text-zinc-500">W-L</div><div className="text-lg font-bold text-zinc-100">{wins}-{decided.length - wins}</div></div>
        <div><div className="text-[10px] uppercase tracking-wide text-zinc-500">Hit rate</div><div className={`text-lg font-bold ${wr == null || expected == null ? "text-zinc-500" : wr >= expected ? "text-emerald-400" : "text-red-400"}`}>{wr == null ? "—" : fmtPct(wr * 100)}</div></div>
        <div><div className="text-[10px] uppercase tracking-wide text-zinc-500">Payout</div><div className={`text-lg font-bold ${payout >= 0 ? "text-emerald-400" : "text-red-400"}`}>{fmtDollars(payout)}</div></div>
        <div><div className="text-[10px] uppercase tracking-wide text-zinc-500">ROI</div><div className={`text-lg font-bold ${roi == null ? "text-zinc-500" : roi >= 0 ? "text-emerald-400" : "text-red-400"}`}>{roi == null ? "—" : `${roi >= 0 ? "+" : ""}${(roi * 100).toFixed(2)}%`}</div></div>
      </div>
    </div>
  );
}

function PropBreakdownCard({ rows }: { rows: { name: string; decided: number; wins: number; wr: number | null; expected: number | null; stake: number; payout: number; roi: number | null }[] }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
      <h3 className="text-sm font-semibold text-zinc-200 mb-3">By prop type</h3>
      {rows.length === 0 ? (
        <p className="text-xs text-zinc-500">No data in range</p>
      ) : (
        <table className="w-full text-sm">
          <tbody>
            {rows.map((r) => (
              <tr key={r.name} className="border-b border-zinc-800/50 last:border-0">
                <td className="py-2 capitalize text-zinc-300">{r.name}</td>
                <td className="py-2 text-right text-zinc-400 text-xs">{r.wins}-{r.decided - r.wins}</td>
                {/* D-548 — color WR against real per-pick BE for this prop_type */}
                <td className={`py-2 text-right font-semibold ${r.wr == null || r.expected == null ? "text-zinc-500" : r.wr >= r.expected ? "text-emerald-400" : "text-red-400"}`}>
                  {r.wr == null ? "—" : `${(r.wr*100).toFixed(1)}%`}
                </td>
                <td className={`py-2 text-right font-semibold ${r.payout >= 0 ? "text-emerald-400" : "text-red-400"}`}>{fmtDollars(r.payout)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function OddsBreakdownCard({ rows }: { rows: { name: string; decided: number; wins: number; wr: number | null; expected: number | null; stake: number; payout: number; roi: number | null }[] }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
      <h3 className="text-sm font-semibold text-zinc-200 mb-3">By odds bucket</h3>
      {rows.length === 0 ? (
        <p className="text-xs text-zinc-500">No data in range</p>
      ) : (
        <table className="w-full text-sm">
          <tbody>
            {rows.map((r) => (
              <tr key={r.name} className="border-b border-zinc-800/50 last:border-0">
                <td className="py-2 text-zinc-300">{r.name}</td>
                <td className="py-2 text-right text-zinc-400 text-xs">{r.wins}-{r.decided - r.wins}</td>
                {/* D-548 — color WR against real per-pick BE for this odds bucket */}
                <td className={`py-2 text-right font-semibold ${r.wr == null || r.expected == null ? "text-zinc-500" : r.wr >= r.expected ? "text-emerald-400" : "text-red-400"}`}>
                  {r.wr == null ? "—" : `${(r.wr*100).toFixed(1)}%`}
                </td>
                <td className={`py-2 text-right font-semibold ${r.payout >= 0 ? "text-emerald-400" : "text-red-400"}`}>{fmtDollars(r.payout)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function SideBreakdownCard({ rows }: { rows: { key: string; label: string; total: number; decided: number; wr: number | null; expected: number | null; stake: number; payout: number; roi: number | null }[] }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
      <h3 className="text-sm font-semibold text-zinc-200 mb-3">By side</h3>
      {rows.length === 0 ? (
        <p className="text-xs text-zinc-500">No data in range</p>
      ) : (
        <table className="w-full text-sm">
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-b border-zinc-800/50 last:border-0">
                <td className="py-2 text-zinc-300">{r.label}</td>
                {/* D-548 — color WR against real per-pick BE for this side */}
                <td className={`py-2 text-right font-semibold ${r.wr == null || r.expected == null ? "text-zinc-500" : r.wr >= r.expected ? "text-emerald-400" : "text-red-400"}`}>
                  {r.wr == null ? "—" : `${(r.wr*100).toFixed(1)}%`}
                </td>
                <td className={`py-2 text-right font-semibold ${r.payout >= 0 ? "text-emerald-400" : "text-red-400"}`}>{fmtDollars(r.payout)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// D-260 (2026-05-19): PickCardLite component deleted along with "Tonight's
// algo picks" section. Dashboard primary surface already renders this data
// with full Kelly action + line shopping context. Removed to keep this file
// focused on retrospective real-money story. Git history preserves it at
// commit 53e35dd~1 if needed.

function BadBeatRow({ b }: { b: RealMoneyBet }) {
  return (
    <div className="grid grid-cols-[auto_1fr_auto] items-center gap-3 px-5 py-3 border-b border-zinc-800 last:border-0 hover:bg-zinc-800/30">
      <PlayerAvatar team={null} name={b.player_name} size={34} />
      <div className="min-w-0">
        <div className="flex items-center gap-2 mb-0.5">
          <span className="text-sm font-semibold text-zinc-200 truncate">{b.player_name}</span>
        </div>
        <div className="text-[12px] text-zinc-500 truncate">
          <span className="capitalize">{b.prop_type}</span> {b.pick_side}{" "}
          <span className="text-zinc-300 font-medium">{b.line}</span>
          <span className="mx-1.5 text-zinc-600">·</span>
          <span>{fmtOdds(b.odds)}</span>
          <span className="mx-1.5 text-zinc-600">·</span>
          <span>${(b.stake || 0).toFixed(2)} stake</span>
          <span className="mx-1.5 text-zinc-600">·</span>
          <span>{b.matched_pick_source ?? "—"}</span>
        </div>
      </div>
      <div className="text-right">
        <div className="text-2xl font-extrabold leading-none text-red-400">{b.matched_pick_confidence ?? "—"}</div>
        <div className="text-[11px] font-semibold uppercase tracking-wider text-red-400 mt-1">
          {fmtDollars(b.payout)}
        </div>
      </div>
    </div>
  );
}

function HistoryHeader({ label, col, onSort, active, dir, align = "left" }: { label: string; col: SortKey; onSort: (k: SortKey) => void; active: SortKey; dir: SortDir; align?: "left" | "right" }) {
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


// Touch unused helpers so tsc strict doesn't complain
void isoToEtGameDate;
