import { useEffect, useMemo, useState } from "react";
import { supabase, SUPABASE_URL, SUPABASE_ANON_KEY } from "@/lib/supabase";
import { etGameDateYmd } from "@/lib/etDate";
import { useAuthSession, currentUserId } from "@/lib/auth";
import { readStoredSport, type Sport } from "@/lib/sport";
import { SportSelector } from "@/components/SportSelector";
import { recommendedStake, readBankroll, MAX_BET_PCT } from "@/lib/kelly";
import { extractAIVerdict } from "@/lib/ai_verdict";
import { FactorPanel } from "@/components/FactorPanel";

// Lite shape — only the fields we need to render game cards. Mirrors the
// recommendations_cache row but typed loosely so we can lift this file
// out later without coupling to other pages.
interface GameRow {
  id: number;
  game_id: string | null;
  game_date: string;
  game_time: string | null;
  player_name: string;          // for spreads: team name; for totals: "<home> vs <away>"
  team: string | null;
  opponent: string | null;
  // D-270-C3 (2026-05-20): includes MLB plural variants. Normalized to
  // singular at read time below: "spreads" → "spread", "totals" →
  // "game_total". h2h (MLB moneyline) is fetched but not yet rendered —
  // separate UI work needed for moneyline display.
  prop_type: "spread" | "game_total" | "spreads" | "totals" | "h2h";
  pick_side: string;            // "home" | "away" for spreads; "over" | "under" for totals
  line: number;
  odds: number;
  confidence: number;
  verdict: string | null;
  ai_analysis: string | null;
  bookmaker: string | null;
  is_home: boolean | null;      // D-369: true ⇒ row.team is the home team; null on legacy rows
  // D-380 — populated for MLB game-level picks from D-379 onward; NULL on
  // pre-D-379 picks and on NBA. Mirrors Dashboard.tsx's breakdown reading.
  breakdown?: Record<string, number | string | boolean | null> | null;
  // D-381 (post-pivot) — same-line multi-book odds for line shopping. Uses
  // the existing `available_books` column added in
  // 20260428000000_path_c_step1_line_shopping_schema.sql. NBA's process-games
  // already populates this for game picks; MLB process-games-mlb now does too
  // (D-381 SHIP 2). Each entry: { bookmaker, line, odds, pick_side }.
  available_books?: Array<{ bookmaker: string; line: number; odds: number; pick_side: string }> | null;
}

// D-381 SHIP 4 — bookmaker key → display name mapping. Raw keys come from
// The Odds API; display in human-readable form on cards.
const BOOKMAKER_DISPLAY: Record<string, string> = {
  hardrockbet: "Hard Rock",
  hardrockbet_oh: "Hard Rock OH",
  draftkings: "DraftKings",
  fanduel: "FanDuel",
  betmgm: "BetMGM",
  bovada: "Bovada",
  pointsbet: "PointsBet",
  espnbet: "ESPN BET",
  fliff: "Fliff",
  fanatics: "Fanatics",
  betrivers: "BetRivers",
  betparx: "BetPARX",
  williamhill_us: "Caesars",
  ballybet: "BallyBet",
  rebet: "ReBet",
  betonlineag: "BetOnline",
  betanysports: "BetAnySports",
  mybookieag: "MyBookie",
  betus: "BetUS",
};
function displayBook(key: string): string {
  return BOOKMAKER_DISPLAY[key] ?? key;
}
function formatOddsCompact(odds: number): string {
  return odds > 0 ? `+${odds}` : `${odds}`;
}

// D-380 SHIP 2 — factor labels for game-side and game-total markets.
// D-654 (2026-06-21) — refreshed for v3-promoted game-side scoring (D-653).
// Keys come from scoring_mlb_v2.ts gameMarket result.breakdown.
//
// Order: pitching → defense → offense → context. Renderer filters out
// zero/null values so old pre-v3 picks (no _v3 keys) gracefully degrade
// to whatever v1 keys their breakdown does contain (e.g. score_pitching_matchup).
//
// DROPPED post-v3 (5 entries — replaced by v3 equivalents or proven
// anti-predictive in D-653 partial fit on 882 picks):
//   - score_offense_differential   (D-339 zeroed; always 0 on side market)
//   - score_recent_run_diff        (entangled offense+defense; -9.2pp lift)
//   - score_team_form              (entangled offense+defense; -5.0pp lift)
//   - score_bullpen_strength       (replaced by score_bullpen_quality_v3 composite)
//   - score_ballpark_factor        (replaced by score_park_runs_v3 — un-gated on side)
const FACTOR_LABELS_GAME: { col: string; label: string }[] = [
  // Pitching dimension (3 factors)
  { col: "score_pitching_matchup",            label: "Starter matchup (ERA)" },
  { col: "score_sp_statcast_quality_v3",      label: "Starter stuff (whiff + put-away)" },
  { col: "score_bullpen_quality_v3",          label: "Bullpen quality (ERA + K/9 + BAA)" },
  // Defense dimension (1 factor — REAL OAA via Baseball Savant per D-653)
  { col: "score_team_defense_oaa_v3",         label: "Team defense (Savant OAA)" },
  // Offense dimension (decoupled per D-653)
  { col: "score_team_offense_form_v3",        label: "Offense form (L10 runs)" },
  { col: "score_team_run_prevention_form_v3", label: "Run prevention form (L10 RA)" },
  { col: "score_lineup_vs_hand_split",        label: "Lineup OPS vs SP hand" },
  // Context
  { col: "score_park_runs_v3",                label: "Ballpark" },
  { col: "score_lineup_confirmation_v3",      label: "Lineup confirmed" },
  { col: "score_h2h_recent",                  label: "Recent head-to-head" },
  { col: "score_weather_wind",                label: "Weather (wind)" },
  { col: "score_weather_temp",                label: "Weather (temp)" },
  { col: "score_umpire_k_zone",               label: "Umpire K zone" },
];

interface Game {
  game_id: string;
  away: string;
  home: string;
  game_time: string;
  spread?: GameRow;
  total?: GameRow;
}

// Resolved past spread row (subset). `hit` is from the PICKED team's
// perspective: hit=true means `team` covered. We invert when computing
// stats for the `opponent`.
interface ResolvedSpreadRow {
  team: string | null;
  opponent: string | null;
  pick_side: string;
  hit: boolean | null;
  game_date: string;
}

// Per-team ATS aggregate over the lookback window.
interface TeamATS {
  covered: number;
  total: number;
  // Most-recent-first list of "W" (covered) / "L" (didn't cover) strings.
  recentForm: ("W" | "L")[];
}

// H2H summary over the lookback window — perspective of teamA.
interface H2HRecord {
  teamA: string;
  teamB: string;
  // teamA's covers in past meetings, out of total meetings. e.g. {covers:2,total:3}
  covers: number;
  total: number;
}

type DateChoice = "today" | "tomorrow";

// Days back to scan pick_history for ATS / form / H2H. 60 caps query cost
// (~300 rows for NBA, less for MLB) while giving enough coverage to fill
// each team's "last 5" without dipping into pre-season noise.
const ATS_LOOKBACK_DAYS = 60;

function gameDateForOffset(offset: 0 | 1): string {
  // D-162: DST-safe ET game-date via shared helper.
  return etGameDateYmd(offset);
}

// YYYYMMDD string for `daysBack` days before today (ET).
function gameDateNDaysAgo(daysBack: number): string {
  // D-162: DST-safe ET game-date via shared helper.
  return etGameDateYmd(-daysBack);
}

function formatOdds(o: number): string {
  return o >= 0 ? `+${o}` : String(o);
}

function formatGameTime(iso: string | null): string {
  if (!iso) return "";
  try {
    const d = new Date(iso);
    // D-270-M1 (2026-05-20): guard against unparseable input (NBA "8:10 PM ET"
    // strings from older writers don't parse as Date; toLocaleTimeString on
    // NaN Date returns "Invalid Date" — UX visible bug). Return raw on NaN.
    if (Number.isNaN(d.getTime())) return iso;
    return d.toLocaleTimeString("en-US", {
      timeZone: "America/New_York",
      hour: "numeric",
      minute: "2-digit",
    }) + " ET";
  } catch {
    return iso;
  }
}

// Build per-team ATS records from a flat list of resolved spread rows.
// For each row, team's perspective: hit=true means team covered. Same row
// also feeds the opponent's record with hit inverted.
function buildTeamATSMap(rows: ResolvedSpreadRow[]): Map<string, TeamATS> {
  const map = new Map<string, TeamATS>();
  // Sort by game_date DESC so recentForm slicing is correct.
  const sorted = [...rows].sort((a, b) => (b.game_date || "").localeCompare(a.game_date || ""));
  for (const r of sorted) {
    if (!r.team || !r.opponent || r.hit === null) continue;
    const teamCovered = r.hit;          // pick was on `team`; hit=true ⇒ team covered
    const oppCovered = !r.hit;
    pushATS(map, r.team, teamCovered);
    pushATS(map, r.opponent, oppCovered);
  }
  return map;
}

function pushATS(map: Map<string, TeamATS>, team: string, covered: boolean) {
  const cur = map.get(team) ?? { covered: 0, total: 0, recentForm: [] };
  cur.total += 1;
  if (covered) cur.covered += 1;
  if (cur.recentForm.length < 5) cur.recentForm.push(covered ? "W" : "L");
  map.set(team, cur);
}

// H2H: count past meetings between two teams in the lookback window and
// summarize teamA's cover rate. Order-agnostic on input — we look at rows
// where (team=A, opponent=B) OR (team=B, opponent=A).
function buildH2H(rows: ResolvedSpreadRow[], teamA: string, teamB: string, lastN = 3): H2HRecord {
  const filtered = rows.filter((r) =>
    r.hit !== null &&
    ((r.team === teamA && r.opponent === teamB) || (r.team === teamB && r.opponent === teamA))
  );
  const sorted = filtered.sort((a, b) => (b.game_date || "").localeCompare(a.game_date || "")).slice(0, lastN);
  let covers = 0;
  for (const r of sorted) {
    if (r.team === teamA) {
      if (r.hit) covers += 1;
    } else {
      // r.team === teamB, so teamA covers iff that pick missed
      if (!r.hit) covers += 1;
    }
  }
  return { teamA, teamB, covers, total: sorted.length };
}

// Stable key for the in-session loggedPicks Set. Same shape used in
// duplicate-check logic so the natural-key match in pick_history is
// consistent (lower(player_name), prop_type, line, pick_side).
function logKey(playerName: string, propType: string, line: number, pickSide: string): string {
  return `${playerName.toLowerCase()}|${propType}|${line}|${pickSide}`;
}

export default function Games() {
  const { session, isAdmin } = useAuthSession();
  const userId = currentUserId(session);
  // D-350 — read-only mode for non-admin (friend preview) users. Defense-in-depth
  // gating in handleLogBet; per-button visual disable handled inside LogBetButton.
  const readOnly = !isAdmin;
  const supabaseHeaders = useMemo(() => ({
    "Content-Type": "application/json",
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${session?.access_token ?? SUPABASE_ANON_KEY}`,
  }), [session?.access_token]);
  // D-056 — Log Bet on game cards. In-session Set prevents re-clicking;
  // DB-side dedup via 24h checkDuplicateBet covers cross-session safety.
  const [loggedPicks, setLoggedPicks] = useState<Set<string>>(new Set());
  const [logError, setLogError] = useState<string | null>(null);
  const [dateChoice, setDateChoice] = useState<DateChoice>("today");
  const [sport, setSport] = useState<Sport>(() => readStoredSport());
  useEffect(() => {
    function handler(e: StorageEvent) {
      if (e.key !== "betgenius_user_sport" || e.newValue == null) return;
      setSport(e.newValue === "mlb" ? "mlb" : "nba");
    }
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);
  const [rows, setRows] = useState<GameRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Past resolved spread picks for ATS / recent form / H2H. Fetched once on
  // sport change. Single broad query → client-side partition.
  const [pastSpreads, setPastSpreads] = useState<ResolvedSpreadRow[]>([]);

  useEffect(() => {
    if (!session?.access_token) return;
    // Reset rows on sport / date / session change so a sport with no spread or
    // total picks doesn't render the previous sport's stale rows (D-049).
    setRows([]);
    setError(null);
    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const offset: 0 | 1 = dateChoice === "today" ? 0 : 1;
        const ymd = gameDateForOffset(offset);
        // D-270-C3 (2026-05-20): query now includes MLB plural variants
        // (spreads/totals) + h2h. Normalize plural → singular at read time
        // so the rest of this file's NBA-shaped consumer logic works
        // unchanged. h2h (moneyline) is dropped for now — separate UI
        // work needed before it can render.
        // D-540 — was read from recommendations_cache_sellable (filtered
        // by product_market_config.is_sellable).
        // D-631 — switched to base recommendations_cache so all markets
        // surface; game_total now flows through (rendered with the
        // UNVALIDATED badge in the Total column). The hide-via-sellable
        // pattern was based on -EV measured on corrupted inputs (D-630
        // fixed weather 48% / Statcast 28% missing); per-market un-tagging
        // is gated on D-630b re-measurement.
        const url =
          `${SUPABASE_URL}/rest/v1/recommendations_cache?` +
          `game_date=eq.${ymd}&` +
          `sport=eq.${sport}&` +
          `prop_type=in.(spread,game_total,spreads,totals,h2h)&` +
          `select=id,game_id,game_date,game_time,player_name,team,opponent,is_home,prop_type,pick_side,line,odds,confidence,verdict,ai_analysis,bookmaker,breakdown,available_books&` +
          `order=game_time.asc`;
        const res = await fetch(url, { headers: supabaseHeaders });
        if (!res.ok) {
          if (!cancelled) setError(`Cache query failed: ${res.status}`);
          return;
        }
        const raw = (await res.json()) as GameRow[];
        // Normalize MLB plural prop_types to NBA-singular form; drop h2h.
        const json = raw.flatMap((r): GameRow[] => {
          if (r.prop_type === "spreads") return [{ ...r, prop_type: "spread" }];
          if (r.prop_type === "totals") return [{ ...r, prop_type: "game_total" }];
          if (r.prop_type === "h2h") return [];
          return [r];
        });
        if (!cancelled) setRows(json);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [dateChoice, sport, supabaseHeaders]);

  // Past resolved spread picks for ATS / form / H2H. Independent of date
  // toggle — once per sport.
  useEffect(() => {
    if (!session?.access_token) return;
    let cancelled = false;
    (async () => {
      try {
        const since = gameDateNDaysAgo(ATS_LOOKBACK_DAYS);
        const url =
          `${SUPABASE_URL}/rest/v1/pick_history?` +
          `prop_type=eq.spread&` +
          `sport=eq.${sport}&` +
          `voided=eq.false&` +
          `hit=not.is.null&` +
          `game_date=gte.${since}&` +
          `select=team,opponent,pick_side,hit,game_date&` +
          `order=game_date.desc&` +
          `limit=1000`;
        const res = await fetch(url, { headers: supabaseHeaders });
        if (!res.ok) {
          if (!cancelled) setPastSpreads([]); // soft-fail; Context strip just hides
          return;
        }
        const json = (await res.json()) as ResolvedSpreadRow[];
        if (!cancelled) setPastSpreads(json);
      } catch {
        if (!cancelled) setPastSpreads([]);
      }
    })();
    return () => { cancelled = true; };
  }, [sport, supabaseHeaders]);

  const teamATS = useMemo(() => buildTeamATSMap(pastSpreads), [pastSpreads]);

  // D-056 — Log Bet handler. Mirrors Dashboard.tsx handleLogSingleBet
  // (line 557): 24h DB-side duplicate check + supabase-js insert with the
  // bets schema shape Dashboard uses. pick_id resolves automatically via
  // the BEFORE INSERT trigger from D-021 (resolve_bet_pick_id) — natural-
  // key match against pick_history works for spread/game_total because
  // process-games and Games both store player_name as team-name (spread)
  // or "<home> vs <away>" (game_total). No trigger update needed.
  async function handleLogBet(payload: {
    playerName: string;
    propType: "spread" | "game_total";
    pickSide: string;
    line: number;
    odds: number;
    stake?: number;
  }): Promise<boolean> {
    // D-350 — read-only mode blocks bet logging for non-admin (friend preview) users.
    if (readOnly) return false;
    const key = logKey(payload.playerName, payload.propType, payload.line, payload.pickSide);
    if (loggedPicks.has(key)) return true;
    try {
      const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const { data: dupeRows } = await supabase
        .from("bets")
        .select("id")
        .ilike("player_name", payload.playerName)
        .eq("prop_type", payload.propType)
        .eq("line", payload.line)
        .eq("pick_side", payload.pickSide)
        .gte("placed_at", since24h)
        .limit(1);
      if ((dupeRows?.length ?? 0) > 0) {
        setLoggedPicks((prev) => new Set(prev).add(key));
        setLogError("This bet is already logged");
        setTimeout(() => setLogError(null), 4000);
        return false;
      }
      // D-060 — stake from inline Kelly confirm form. Falls back to $10
      // legacy default if not supplied (defensive; the LogBetButton
      // requires confirm before reaching this fn so a 0 stake means
      // user-explicitly-overrode-to-zero, which we still allow).
      const stake = typeof payload.stake === "number" && payload.stake >= 0 ? payload.stake : 10.00;
      const { error: insertError } = await supabase.from("bets").insert({
        user_id: userId,
        player_name: payload.playerName,
        prop_type: payload.propType,
        line: payload.line,
        pick_side: payload.pickSide,
        odds: payload.odds ?? -110,
        stake,
        status: "pending",
      });
      if (insertError) {
        setLogError(`Failed to log bet: ${insertError.message}`);
        setTimeout(() => setLogError(null), 4000);
        return false;
      }
      setLoggedPicks((prev) => new Set(prev).add(key));
      return true;
    } catch (err) {
      setLogError(err instanceof Error ? err.message : "Failed to log bet");
      setTimeout(() => setLogError(null), 4000);
      return false;
    }
  }


  // Group rows into games. Prefer game_id; fall back to a synthesized key
  // built from team + opponent + game_time so older rows without game_id
  // still render.
  //
  // D-369 (2026-05-29): home/away derivation now prefers `r.is_home`. The
  // legacy logic used `r.team` for game_total, which was wrong: backend
  // packs the OVER-row with team=homeTeam and the UNDER-row with
  // team=awayTeam (totals have no semantic "team", so this is arbitrary).
  // If PostgREST returned the UNDER row first, game.home/away inverted and
  // the spread card label flipped. Two-part fix:
  //   (1) Use is_home as the home/away anchor for ALL prop_types.
  //   (2) Process spread/h2h rows before game_total so even if is_home is
  //       missing on some row, the unambiguous spread/h2h row sets game
  //       orientation first.
  const games = useMemo<Game[]>(() => {
    const byGame = new Map<string, Game>();
    const propOrder = (pt: string) => (pt === "spread" || pt === "spreads" || pt === "h2h" ? 0 : 1);
    const sortedRows = [...rows].sort((a, b) => propOrder(a.prop_type) - propOrder(b.prop_type));
    for (const r of sortedRows) {
      let home = "";
      let away = "";
      if (r.is_home === true) {
        home = r.team || r.player_name || "";
        away = r.opponent || "";
      } else if (r.is_home === false) {
        away = r.team || r.player_name || "";
        home = r.opponent || "";
      } else {
        // Legacy null is_home: fall back to the pre-D-369 logic.
        if (r.prop_type === "game_total") {
          home = r.team || "";
          away = r.opponent || "";
        } else if (r.pick_side === "home") {
          home = r.team || r.player_name || "";
          away = r.opponent || "";
        } else {
          away = r.team || r.player_name || "";
          home = r.opponent || "";
        }
      }
      const key = r.game_id || [home, away, r.game_time || ""].sort().join("|");
      if (!byGame.has(key)) {
        byGame.set(key, { game_id: key, away, home, game_time: r.game_time || "" });
      }
      const g = byGame.get(key)!;
      if (!g.away && away) g.away = away;
      if (!g.home && home) g.home = home;
      if (!g.game_time && r.game_time) g.game_time = r.game_time;
      if (r.prop_type === "spread") g.spread = r;
      else if (r.prop_type === "game_total") g.total = r;
    }
    return [...byGame.values()].sort((a, b) => {
      const aConf = Math.max(a.spread?.confidence ?? 0, a.total?.confidence ?? 0);
      const bConf = Math.max(b.spread?.confidence ?? 0, b.total?.confidence ?? 0);
      return bConf - aConf;
    });
  }, [rows]);

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-zinc-100">Games</h1>
          <p className="text-sm text-zinc-500 mt-1 max-w-2xl">
            Spread and total picks for today's slate. For player props, see <span className="text-zinc-300 font-semibold">Dashboard</span>.
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <SportSelector value={sport} onChange={setSport} />
          <div className="flex gap-1 rounded-lg border border-zinc-800 bg-zinc-900/60 p-1">
            {(["today", "tomorrow"] as DateChoice[]).map((d) => (
              <button
                key={d}
                onClick={() => setDateChoice(d)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition ${
                  dateChoice === d ? "bg-zinc-700 text-zinc-100" : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                {d === "today" ? "Today" : "Tomorrow"}
              </button>
            ))}
          </div>
        </div>
      </div>

      {loading && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-12 text-center">
          <div className="inline-block h-6 w-6 animate-spin rounded-full border-2 border-zinc-600 border-t-emerald-500 mb-3" />
          <p className="text-zinc-400 text-sm">Loading games…</p>
        </div>
      )}

      {!loading && error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/10 p-5">
          <p className="text-sm text-red-300 font-medium">Failed to load games</p>
          <p className="text-xs text-red-300/80 mt-1">{error}</p>
        </div>
      )}

      {!loading && !error && games.length === 0 && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-12 text-center">
          <p className="text-zinc-300 text-sm font-medium">No games {dateChoice === "today" ? "today" : "tomorrow"}</p>
          <p className="text-zinc-500 text-xs mt-1">
            {dateChoice === "tomorrow" ? "Cron seeds tomorrow's slate at ~14:00 UTC. Check back later." : "No spreads or totals in cache for today."}
          </p>
        </div>
      )}

      {/* D-056: Log Bet error toast — auto-clears after 4s via setTimeout
          inside handleLogBet. Renders above the games grid so it's visible
          regardless of which card triggered the error. */}
      {logError && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {logError}
        </div>
      )}

      {!loading && !error && games.length > 0 && (
        <div className="grid gap-4">
          {games.map((g) => (
            <GameCard
              key={g.game_id}
              game={g}
              teamATS={teamATS}
              pastSpreads={pastSpreads}
              onLogBet={handleLogBet}
              loggedPicks={loggedPicks}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// D-386 §15.0 #74 — Verdict-label treatment on positive-tier FADE picks.
// When Sonnet's verdict on the AI analysis is FADE on a positive-tier pick
// (Good/Strong/Elite), suppress the tier-label text but keep the numeric
// confidence visible. The number is honest (it's what the optimizer is
// trained against); the label implies recommendation strength the second
// opinion is pushing back on. Sonnet's FADE conclusion stays in the AI
// Analysis prose. The D-384 chip beside the badge has been removed —
// label suppression is the new headline treatment for the disagreement
// case D-385 empirically settled (Sonnet-right at GOOD tier).
function confBadge(conf: number, aiAnalysis?: string | null) {
  const tone =
    conf >= 90 ? { num: "text-amber-300",   bg: "bg-amber-500/15",   border: "border-amber-500/40",   label: "text-amber-400" } :
    conf >= 80 ? { num: "text-emerald-300", bg: "bg-emerald-500/15", border: "border-emerald-500/40", label: "text-emerald-400" } :
    conf >= 70 ? { num: "text-blue-300",    bg: "bg-blue-500/15",    border: "border-blue-500/40",    label: "text-blue-400" } :
    conf >= 60 ? { num: "text-yellow-300",  bg: "bg-yellow-500/15",  border: "border-yellow-500/40",  label: "text-yellow-400" } :
                 { num: "text-zinc-400",    bg: "bg-zinc-700/20",    border: "border-zinc-600/40",    label: "text-zinc-500" };
  const label = conf >= 90 ? "Elite" : conf >= 80 ? "Strong" : conf >= 70 ? "Good" : conf >= 60 ? "Lean" : "Pass";
  const suppressLabel = conf >= 70 && extractAIVerdict(aiAnalysis) === "FADE";
  return (
    <div className="text-center">
      <div
        className={`inline-flex items-baseline justify-center px-3 py-1 rounded-lg border ${tone.bg} ${tone.border}`}
        title={suppressLabel ? "Tier label suppressed — Sonnet (AI Analysis) returns FADE on this pick. Confidence number is the algorithm's score; see AI Analysis for reasoning." : undefined}
      >
        <span className={`${tone.num} font-bold text-2xl tabular-nums leading-none`}>{conf}</span>
      </div>
      {!suppressLabel && (
        <p className={`text-[10px] mt-1 font-semibold uppercase tracking-wide ${tone.label}`}>{label}</p>
      )}
    </div>
  );
}

type LogBetPayload = {
  playerName: string;
  propType: "spread" | "game_total";
  pickSide: string;
  line: number;
  odds: number;
  stake?: number; // D-060 — set by LogBetButton's inline Kelly confirm form.
};

function GameCard({
  game,
  teamATS,
  pastSpreads,
  onLogBet,
  loggedPicks,
}: {
  game: Game;
  teamATS: Map<string, TeamATS>;
  pastSpreads: ResolvedSpreadRow[];
  onLogBet: (payload: LogBetPayload) => Promise<boolean>;
  loggedPicks: Set<string>;
}) {
  const [showAI, setShowAI] = useState(false);
  // D-655 SHIP 1 — factor expand/collapse moved into shared FactorPanel.
  // D-452 #75 — collapse book lists by default, expand on click.
  // Mirrors the existing AI Analysis collapse pattern (`showAI`/`setShowAI`).
  const [showShopSpread, setShowShopSpread] = useState(false);
  const [showShopTotal, setShowShopTotal] = useState(false);
  const bestConf = Math.max(game.spread?.confidence ?? 0, game.total?.confidence ?? 0);
  const borderColor = bestConf >= 80 ? "border-emerald-500/40" : bestConf >= 70 ? "border-blue-500/30" : "border-zinc-700";
  const hasAi = !!(game.spread?.ai_analysis || game.total?.ai_analysis);
  const time = formatGameTime(game.game_time);

  // D-655 SHIP 1 — factor display moved to shared FactorPanel (rendered below
  // in the card body). Bucketing now lives in src/components/FactorPanel.tsx
  // and is reused by Dashboard PickCard + Games + any future market surface.

  const homeATS = teamATS.get(game.home);
  const awayATS = teamATS.get(game.away);
  // D-273-FOLLOWUP-H2H (2026-05-20): replaced buildH2H over pick_history
  // window with team-stats edge function h2hOnly mode → real BDL schedule.
  // We KEEP the buildH2H result as a fallback when the BDL fetch fails.
  const h2hFromPicks = useMemo(
    () => game.home && game.away ? buildH2H(pastSpreads, game.away, game.home, 3) : null,
    [pastSpreads, game.away, game.home]
  );
  const [realH2H, setRealH2H] = useState<null | { meetings: Array<{ date: string; home: string; away: string; homeScore: number; awayScore: number }>; awayWins: number; homeWins: number; source: "bdl" | "pending" | "failed" }>(null);
  useEffect(() => {
    if (!game.home || !game.away) return;
    let cancelled = false;
    setRealH2H({ meetings: [], awayWins: 0, homeWins: 0, source: "pending" });
    (async () => {
      try {
        const res = await fetch(SUPABASE_URL + "/functions/v1/team-stats", {
          method: "POST",
          headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON_KEY, Authorization: "Bearer " + SUPABASE_ANON_KEY },
          body: JSON.stringify({ team1: game.away, team2: game.home, h2hOnly: true }),
        });
        if (!res.ok) {
          if (!cancelled) setRealH2H({ meetings: [], awayWins: 0, homeWins: 0, source: "failed" });
          return;
        }
        const d = await res.json();
        const meetings = (d.h2h ?? []) as Array<{ date: string; home: string; away: string; homeScore: number; awayScore: number }>;
        let awayWins = 0, homeWins = 0;
        for (const m of meetings) {
          const awayIsAwayTeam = m.away === game.away;
          const teamScoredMore = awayIsAwayTeam ? m.awayScore > m.homeScore : m.homeScore > m.awayScore;
          if (teamScoredMore) awayWins++;
          else homeWins++;
        }
        if (!cancelled) setRealH2H({ meetings, awayWins, homeWins, source: "bdl" });
      } catch (_e) {
        if (!cancelled) setRealH2H({ meetings: [], awayWins: 0, homeWins: 0, source: "failed" });
      }
    })();
    return () => { cancelled = true; };
  }, [game.home, game.away]);

  const haveAnyContext = !!(homeATS || awayATS || (realH2H && realH2H.meetings.length > 0) || (h2hFromPicks && h2hFromPicks.total > 0));

  return (
    <div className={`rounded-xl border ${borderColor} bg-zinc-900/50 overflow-hidden`}>
      {/* Header */}
      <div className="bg-zinc-800/60 px-3 sm:px-4 py-3 flex items-center justify-between flex-wrap gap-1">
        <div className="flex items-center gap-3">
          <span className="text-white font-semibold text-sm">{game.away || "—"}</span>
          <span className="text-zinc-500 text-xs">@</span>
          <span className="text-white font-semibold text-sm">{game.home || "—"}</span>
        </div>
        {time && <span className="text-xs text-amber-400/80 font-medium">{time}</span>}
      </div>

      {/* Context strip — Last 5 ATS / Recent H2H / Last 60 Days ATS.
          Tier 1 Fix #3 (May 11, 2026): renamed "Season ATS (60d)" →
          "Last 60 Days ATS" and "H2H ATS" → "Recent H2H" to stop
          misrepresenting the 60-day window as "season" and to make
          explicit that the H2H number is derived from our own tracked
          spread picks, not real NBA game-history ATS. All numbers come
          from pick_history rows within the ATS_LOOKBACK_DAYS=60 window
          (see useEffect at line ~227). Hide entirely when neither team
          has any data and there are no H2H meetings. */}
      {haveAnyContext && (
        <div className="px-3 sm:px-4 py-2.5 border-b border-zinc-800/50 bg-zinc-950/30">
          <div className="grid grid-cols-3 gap-3 text-[11px]">
            {/* Last 5 ATS — literal last 5 tracked spread picks per team
                within the 60-day window. Label honest. */}
            <div>
              <div className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1">Last 5 ATS</div>
              <FormStrip team={game.away} ats={awayATS} />
              <FormStrip team={game.home} ats={homeATS} />
            </div>
            {/* D-273-FOLLOWUP-H2H (2026-05-20): real BDL schedule lookup
                via team-stats edge function h2hOnly mode. The previous
                D-273 ship relabeled but kept the wrong data source; this
                ship pulls actual meetings + scores from BDL. Falls back
                to "from our tracker" data if BDL resolve fails. */}
            <div>
              <div className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1">Season H2H</div>
              {realH2H?.source === "bdl" && realH2H.meetings.length > 0 ? (
                <div className="text-zinc-300">
                  <span className="font-semibold text-zinc-100">{game.away}</span>{" "}
                  <span className="tabular-nums">{realH2H.awayWins}-{realH2H.homeWins}</span>{" "}
                  <span className="text-zinc-500">vs {game.home}</span>
                  <div className="text-[10px] text-zinc-500 mt-0.5">
                    {realH2H.meetings.length} meeting{realH2H.meetings.length === 1 ? "" : "s"} this season (BDL)
                  </div>
                </div>
              ) : realH2H?.source === "bdl" ? (
                <div className="text-zinc-500">First meeting this season</div>
              ) : realH2H?.source === "pending" ? (
                <div className="text-zinc-600 text-[11px]">loading…</div>
              ) : h2hFromPicks && h2hFromPicks.total > 0 ? (
                <div className="text-zinc-300">
                  <span className="font-semibold text-zinc-100">{game.away}</span>{" "}
                  <span className="tabular-nums">{h2hFromPicks.covers}-{h2hFromPicks.total - h2hFromPicks.covers}</span>{" "}
                  <span className="text-zinc-500">vs {game.home}</span>
                  <div className="text-[10px] text-zinc-500 mt-0.5">
                    from our tracker (last 60d) — schedule lookup unavailable
                  </div>
                </div>
              ) : (
                <div className="text-zinc-500">No prior meetings this season</div>
              )}
            </div>
            {/* Last 60 Days ATS — formerly mislabeled "Season ATS (60d)".
                It is strictly the last 60 days, not season-to-date. */}
            <div>
              <div className="text-[10px] uppercase tracking-wide text-zinc-500 mb-1">Last 60 Days ATS</div>
              <ATSRow team={game.away} ats={awayATS} />
              <ATSRow team={game.home} ats={homeATS} />
            </div>
          </div>
        </div>
      )}

      {/* Spread + Total side-by-side */}
      <div className="grid grid-cols-1 sm:grid-cols-2 sm:divide-x divide-zinc-800/50">
        {/* Spread */}
        <div className="p-4">
          <div className="flex items-center justify-between mb-2.5">
            <span className="text-[10px] px-2 py-0.5 rounded bg-blue-500/20 text-blue-300 font-bold tracking-wider">SPREAD</span>
            {game.spread && confBadge(game.spread.confidence, game.spread.ai_analysis)}
          </div>
          {game.spread ? (
            <div>
              <div className="text-sm">
                <span className={`font-semibold ${game.spread.pick_side === "home" ? "text-emerald-400" : "text-amber-400"}`}>
                  {game.spread.pick_side === "home" ? game.home : game.away}
                </span>
                <span className="text-white font-medium ml-1.5">{game.spread.line > 0 ? "+" : ""}{game.spread.line}</span>
                <span className="text-zinc-500 text-xs ml-1.5">{formatOdds(game.spread.odds)}</span>
              </div>
              {game.spread.verdict && (
                <p className="text-[11px] text-zinc-500 mt-1">{game.spread.verdict}</p>
              )}
              {/* D-381 — same-line multi-book price comparison. HRB first via
                  frontend sort; remaining books by best odds. Hidden when
                  available_books is null/empty (pre-D-381 rows). */}
              {(() => {
                const books = game.spread.available_books;
                if (!books || books.length < 2) return null;
                const sameLine = books.filter(
                  (b) => b.line === game.spread!.line && b.pick_side === game.spread!.pick_side,
                );
                if (sameLine.length < 2) return null;
                const sorted = [...sameLine].sort((a, b) => {
                  const ah = a.bookmaker.startsWith("hardrockbet") ? 0 : 1;
                  const bh = b.bookmaker.startsWith("hardrockbet") ? 0 : 1;
                  if (ah !== bh) return ah - bh;
                  return b.odds - a.odds;
                });
                return (
                  <div className="mt-2 pt-2 border-t border-zinc-800/40">
                    {/* D-452 #75 — collapsed by default; expand on click. Mirrors AI Analysis collapse. */}
                    <button
                      onClick={() => setShowShopSpread((v) => !v)}
                      className="w-full flex items-center justify-between text-[10px] uppercase tracking-wide text-zinc-500 hover:text-zinc-300 transition-colors"
                    >
                      <span>Shop the line ({sorted.length})</span>
                      <span>{showShopSpread ? "▲" : "▼"}</span>
                    </button>
                    {showShopSpread && (
                      <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px]">
                        {sorted.map((e, i) => (
                          <div key={`${e.bookmaker}-${i}`} className="flex items-baseline justify-between gap-2">
                            <span className={`truncate ${i === 0 ? "text-zinc-200 font-medium" : "text-zinc-400"}`}>{displayBook(e.bookmaker)}</span>
                            <span className={`tabular-nums ${i === 0 ? "text-emerald-400 font-semibold" : "text-zinc-300"}`}>
                              {e.line > 0 ? "+" : ""}{e.line} / {formatOddsCompact(e.odds)}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })()}
              <LogBetButton
                payload={{
                  playerName: game.spread.player_name,
                  propType: "spread",
                  pickSide: game.spread.pick_side,
                  line: game.spread.line,
                  odds: game.spread.odds,
                }}
                confidence={game.spread.confidence}
                onLogBet={onLogBet}
                isLogged={loggedPicks.has(logKey(game.spread.player_name, "spread", game.spread.line, game.spread.pick_side))}
              />
            </div>
          ) : <p className="text-xs text-zinc-600">No spread available</p>}
        </div>

        {/* Total */}
        <div className="p-4">
          <div className="flex items-center justify-between mb-2.5">
            {/* D-626 → D-631 — totals were hidden by is_sellable=false (D-533
                marginal -EV verdict measured on broken inputs); D-631
                surfaces them and tags with UNVALIDATED. Badge is full
                purple again when a total is present; muted only when no
                total at all. */}
            <div className="flex items-center gap-1.5">
              <span className={`text-[10px] px-2 py-0.5 rounded font-bold tracking-wider ${
                game.total ? "bg-purple-500/20 text-purple-300" : "bg-zinc-800/40 text-zinc-600"
              }`}>TOTAL</span>
              {/* D-631 — UNVALIDATED tag for game_total (was hidden pre-D-631). */}
              {game.total && (
                <span
                  className="rounded border border-amber-500/40 bg-amber-500/10 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-amber-300"
                  title="Unvalidated — totals were hidden by an -EV verdict measured on broken inputs (D-630 fixed weather/Statcast holes). Awaiting re-measurement on clean data."
                >
                  Unvalidated
                </span>
              )}
            </div>
            {game.total && confBadge(game.total.confidence, game.total.ai_analysis)}
          </div>
          {game.total ? (
            <div>
              <div className="text-sm">
                <span className={`font-semibold ${game.total.pick_side === "over" ? "text-emerald-400" : "text-red-400"}`}>
                  {game.total.pick_side === "over" ? "Over" : "Under"}
                </span>
                <span className="text-white font-medium ml-1.5">{game.total.line}</span>
                <span className="text-zinc-500 text-xs ml-1.5">{formatOdds(game.total.odds)}</span>
              </div>
              {game.total.verdict && (
                <p className="text-[11px] text-zinc-500 mt-1">{game.total.verdict}</p>
              )}
              {/* D-381 — same-line multi-book price comparison. */}
              {(() => {
                const books = game.total.available_books;
                if (!books || books.length < 2) return null;
                const sameLine = books.filter(
                  (b) => b.line === game.total!.line && b.pick_side === game.total!.pick_side,
                );
                if (sameLine.length < 2) return null;
                const sorted = [...sameLine].sort((a, b) => {
                  const ah = a.bookmaker.startsWith("hardrockbet") ? 0 : 1;
                  const bh = b.bookmaker.startsWith("hardrockbet") ? 0 : 1;
                  if (ah !== bh) return ah - bh;
                  return b.odds - a.odds;
                });
                return (
                  <div className="mt-2 pt-2 border-t border-zinc-800/40">
                    {/* D-452 #75 — collapsed by default; expand on click. */}
                    <button
                      onClick={() => setShowShopTotal((v) => !v)}
                      className="w-full flex items-center justify-between text-[10px] uppercase tracking-wide text-zinc-500 hover:text-zinc-300 transition-colors"
                    >
                      <span>Shop the line ({sorted.length})</span>
                      <span>{showShopTotal ? "▲" : "▼"}</span>
                    </button>
                    {showShopTotal && (
                      <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[11px]">
                        {sorted.map((e, i) => (
                          <div key={`${e.bookmaker}-${i}`} className="flex items-baseline justify-between gap-2">
                            <span className={`truncate ${i === 0 ? "text-zinc-200 font-medium" : "text-zinc-400"}`}>{displayBook(e.bookmaker)}</span>
                            <span className={`tabular-nums ${i === 0 ? "text-emerald-400 font-semibold" : "text-zinc-300"}`}>
                              {e.line} / {formatOddsCompact(e.odds)}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })()}
              <LogBetButton
                payload={{
                  playerName: game.total.player_name,
                  propType: "game_total",
                  pickSide: game.total.pick_side,
                  line: game.total.line,
                  odds: game.total.odds,
                }}
                confidence={game.total.confidence}
                onLogBet={onLogBet}
                isLogged={loggedPicks.has(logKey(game.total.player_name, "game_total", game.total.line, game.total.pick_side))}
              />
            </div>
          ) : (
            // D-626 — totals are config-driven scope-out (product_market_config
            // is_sellable=false; D-533: marginal -EV at -2.7pp). The pre-D-626
            // "No total available" text read as a fetch failure; the data IS
            // fetched (props_cache.totals: 532 rows × 14 games × 19 books on
            // 2026-06-19) and IS scored, but the sellable view filters it out.
            // Honest text + muted style so users don't read it as broken.
            <p className="text-xs text-zinc-600 italic">Totals not currently offered</p>
          )}
        </div>
      </div>

      {/* AI Analysis collapsible */}
      {hasAi && (
        <div className="border-t border-zinc-800/50">
          <button
            onClick={() => setShowAI((v) => !v)}
            className="w-full px-4 py-2 flex items-center justify-between text-xs text-purple-400 hover:text-purple-300 transition-colors"
          >
            <span className="flex items-center gap-1.5"><span>✨</span><span className="font-medium">AI Analysis</span></span>
            <span>{showAI ? "▲" : "▼"}</span>
          </button>
          {showAI && (
            <div className="px-4 pb-3 space-y-2">
              {game.spread?.ai_analysis && (
                <div>
                  <span className="text-xs font-medium text-blue-400">Spread:</span>
                  <p className="text-xs text-zinc-400 leading-relaxed mt-0.5">{game.spread.ai_analysis}</p>
                </div>
              )}
              {game.total?.ai_analysis && (
                <div>
                  <span className="text-xs font-medium text-purple-400">Total:</span>
                  <p className="text-xs text-zinc-400 leading-relaxed mt-0.5">{game.total.ai_analysis}</p>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* D-380 / D-655 — Factor breakdown collapsible (game markets).
          Uses shared FactorPanel (3-bucket: firing / no-tilt / missing). */}
      <div className="border-t border-zinc-800/50 px-4 py-2">
        <FactorPanel
          labels={FACTOR_LABELS_GAME}
          lookup={(col) => {
            const bd = (game.spread?.breakdown ?? game.total?.breakdown ?? null) as
              Record<string, unknown> | null;
            return bd ? bd[col] : undefined;
          }}
        />
      </div>
    </div>
  );
}

function FormStrip({ team, ats }: { team: string; ats: TeamATS | undefined }) {
  if (!ats || ats.recentForm.length === 0) {
    return (
      <div className="flex items-center gap-2 mb-0.5">
        <span className="text-zinc-500 truncate max-w-[7rem]" title={team}>{shortTeam(team)}</span>
        <span className="text-zinc-600">—</span>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2 mb-0.5">
      <span className="text-zinc-300 truncate max-w-[7rem]" title={team}>{shortTeam(team)}</span>
      <span className="flex gap-0.5">
        {ats.recentForm.map((r, i) => (
          <span
            key={i}
            className={`inline-block w-3 text-center text-[10px] font-bold rounded ${
              r === "W" ? "bg-emerald-500/25 text-emerald-300" : "bg-red-500/25 text-red-300"
            }`}
          >
            {r}
          </span>
        ))}
      </span>
    </div>
  );
}

function ATSRow({ team, ats }: { team: string; ats: TeamATS | undefined }) {
  if (!ats || ats.total === 0) {
    return (
      <div className="flex items-center justify-between gap-2 mb-0.5">
        <span className="text-zinc-300 truncate max-w-[7rem]" title={team}>{shortTeam(team)}</span>
        <span className="text-zinc-600 tabular-nums">—</span>
      </div>
    );
  }
  const pct = ats.total > 0 ? (ats.covered / ats.total) * 100 : 0;
  const tone = pct >= 55 ? "text-emerald-300" : pct >= 45 ? "text-zinc-300" : "text-red-300";
  return (
    <div className="flex items-center justify-between gap-2 mb-0.5">
      <span className="text-zinc-300 truncate max-w-[7rem]" title={team}>{shortTeam(team)}</span>
      <span className={`tabular-nums ${tone}`}>{ats.covered}-{ats.total - ats.covered}</span>
    </div>
  );
}

// Compact team label for the narrow Context columns. Drops the city when
// the franchise name alone is unambiguous (e.g. "Los Angeles Lakers" →
// "Lakers"). Falls back to the raw string if no obvious last-word split.
function shortTeam(name: string): string {
  if (!name) return "—";
  const parts = name.trim().split(/\s+/);
  // "LA Lakers" / "LA Clippers" / "New York Knicks" → last word.
  if (parts.length >= 2) return parts[parts.length - 1];
  return name;
}

// D-056 — Per-pick Log Bet button.
// D-060 — Now expands to inline Kelly confirm form on click. Owns its own
// busy + form state so the spread + total buttons inside the same GameCard
// track independently. isLogged is sourced from the parent's loggedPicks
// Set so cross-card dedup works (e.g. flipping date toggle and back doesn't
// reset the "Logged ✓" state for picks already logged this session).
function LogBetButton({
  payload,
  confidence,
  onLogBet,
  isLogged,
}: {
  payload: LogBetPayload;
  confidence: number;
  onLogBet: (payload: LogBetPayload) => Promise<boolean>;
  isLogged: boolean;
}) {
  // D-350 — local read-only flag (cheaper than threading a prop through nested cards).
  const { isAdmin } = useAuthSession();
  const readOnly = !isAdmin;
  const readOnlyTip = "Preview mode — full access requires subscription";
  const [logging, setLogging] = useState(false);
  const [showStakeForm, setShowStakeForm] = useState(false);
  const [bankroll] = useState<number>(() => readBankroll());
  const suggestedStake = recommendedStake({ confidence, odds: payload.odds, bankroll });
  const capStake = Math.round(MAX_BET_PCT * bankroll);
  const [stakeInput, setStakeInput] = useState<string>(String(suggestedStake));

  function handleClick() {
    if (isLogged || logging) return;
    if (readOnly) return;  // D-350
    setStakeInput(String(suggestedStake));
    setShowStakeForm(true);
  }
  async function handleConfirm() {
    if (logging) return;
    const n = parseFloat(stakeInput);
    const stake = Number.isFinite(n) && n >= 0 ? n : 0;
    setLogging(true);
    const ok = await onLogBet({ ...payload, stake });
    setLogging(false);
    if (ok) setShowStakeForm(false);
  }
  function handleCancel() {
    if (logging) return;
    setShowStakeForm(false);
  }

  if (isLogged || !showStakeForm) {
    return (
      <button
        onClick={handleClick}
        disabled={isLogged || logging || readOnly}
        title={readOnly ? readOnlyTip : undefined}
        className={`mt-3 w-full rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
          isLogged
            ? "border-emerald-500/30 bg-emerald-500/20 text-emerald-400 cursor-default"
            : "border-zinc-700 bg-zinc-800 text-zinc-300 hover:bg-zinc-700 hover:text-white"
        }`}
      >
        {isLogged ? "Logged ✓" : "Log Bet"}
      </button>
    );
  }

  return (
    <div className="mt-3 space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-zinc-500 text-xs">Stake $</span>
        <input
          type="number"
          inputMode="decimal"
          min="0"
          step="any"
          value={stakeInput}
          onChange={(e) => setStakeInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleConfirm(); if (e.key === "Escape") handleCancel(); }}
          disabled={logging}
          autoFocus
          className="flex-1 rounded-lg border border-zinc-700 bg-zinc-950/60 px-2 py-1.5 text-xs text-zinc-100 focus:border-emerald-500/60 focus:outline-none focus:ring-1 focus:ring-emerald-500/30 disabled:opacity-60"
        />
        <button
          onClick={handleConfirm}
          disabled={logging}
          className="rounded-lg border border-emerald-500/40 bg-emerald-500/20 px-3 py-1.5 text-xs font-medium text-emerald-300 hover:bg-emerald-500/30 disabled:opacity-60 disabled:cursor-wait"
        >
          {logging ? "..." : "Confirm"}
        </button>
        <button
          onClick={handleCancel}
          disabled={logging}
          className="rounded-lg border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 disabled:opacity-60"
        >
          ✕
        </button>
      </div>
      <p className="text-[10px] text-zinc-500 leading-snug">
        {suggestedStake > 0 ? (
          <>Quarter Kelly suggests <span className="text-zinc-300 font-medium">${suggestedStake}</span> · 5% cap: <span className="text-zinc-400">${capStake}</span> · bankroll <span className="text-zinc-400">${bankroll.toFixed(0)}</span></>
        ) : (
          <span className="text-amber-400/80">Sub-breakeven confidence tier — Kelly recommends no bet. Override above if you want to log anyway.</span>
        )}
      </p>
    </div>
  );
}
