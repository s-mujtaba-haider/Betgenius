import { useState, useEffect, useRef } from "react";
import { supabase } from "@/lib/supabase";
import { useAuthSession, currentUserId } from "@/lib/auth";
import { readStoredSport, type Sport } from "@/lib/sport";
import { SportSelector } from "@/components/SportSelector";
import { readDiscretionaryStake } from "@/lib/user_preferences";
import type { BetPrefill } from "@/App";

interface PlayerSuggestion {
  id: string;
  displayName: string;
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

interface Bet {
  id: string;
  player_name: string;
  prop_type: string;
  line: number;
  pick_side: "over" | "under";
  odds: number;
  stake: number;
  status: "pending" | "won" | "lost";
  placed_at: string;
  payout?: number;
}

// D-270-H4 — sport-aware prop_type lists.
// NBA: matches Evaluator + scoring.ts canonical set.
// MLB: matches the 5 player-prop markets actually written to props_cache /
// recommendations_cache (batter_hits → "hits", batter_home_runs → "home_runs",
// batter_total_bases → "total_bases", batter_rbis → "rbis", pitcher_strikeouts
// kept as-is). See fetch-odds-mlb/index.ts MLB_MARKETS for the upstream
// fetch-side map; process-games-mlb dispatches to scoring_mlb.ts based on
// these prop_type values.
const PROP_TYPES_BY_SPORT: Record<Sport, string[]> = {
  nba: ["points", "rebounds", "assists", "threes", "steals", "blocks"],
  mlb: ["hits", "home_runs", "total_bases", "rbis", "pitcher_strikeouts"],
};

const PROP_LABELS: Record<string, string> = {
  points: "Points",
  rebounds: "Rebounds",
  assists: "Assists",
  threes: "Threes",
  steals: "Steals",
  blocks: "Blocks",
  hits: "Hits",
  home_runs: "Home Runs",
  total_bases: "Total Bases",
  rbis: "RBIs",
  pitcher_strikeouts: "Pitcher Strikeouts",
};

interface BetTrackerProps {
  prefill?: BetPrefill | null;
  onClearPrefill?: () => void;
}

export default function BetTracker({ prefill, onClearPrefill }: BetTrackerProps) {
  const { session, isAdmin } = useAuthSession();
  const userId = currentUserId(session);
  // D-350 — read-only mode for non-admin (friend preview).
  const readOnly = !isAdmin;
  const readOnlyTip = "Preview mode — full access requires subscription";
  const [bets, setBets] = useState<Bet[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // D-270-H4 — sport switcher. Defaults from localStorage (shared key with
  // Dashboard / Performance / Games). Cross-tab sync via storage event so
  // changing sport on Dashboard updates Tracker in another tab.
  const [sport, setSport] = useState<Sport>(() => readStoredSport());
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key !== "betgenius_user_sport" || e.newValue == null) return;
      setSport(e.newValue === "mlb" ? "mlb" : "nba");
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Form state
  const [playerName, setPlayerName] = useState("");
  const [propType, setPropType] = useState<string>(() => PROP_TYPES_BY_SPORT[readStoredSport()][0]);
  const [line, setLine] = useState("");
  const [side, setSide] = useState<"over" | "under">("over");
  const [odds, setOdds] = useState("");
  const [stake, setStake] = useState("");

  // Player autocomplete state
  const [suggestions, setSuggestions] = useState<PlayerSuggestion[]>([]);
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [selectedValue, setSelectedValue] = useState<string | null>(null);
  const debounceRef = useRef<number | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // D-270-H4 — when sport changes, reset propType to the first option for the
  // newly-selected sport so we never leave a stale NBA value in an MLB dropdown
  // (or vice versa). Guarded so it only fires when the current propType is
  // truly out of the new sport's allowed set (preserves prefill across mounts).
  useEffect(() => {
    const allowed = PROP_TYPES_BY_SPORT[sport];
    if (!allowed.includes(propType)) {
      setPropType(allowed[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sport]);

  // Load bets from Supabase on mount.
  // D-054: gated on session.access_token so the fetch doesn't fire with anon
  // role and get filtered to empty by the bets RLS policy
  // (`user_id = auth.uid()`). Same pattern as D-045 (Admin) and D-047
  // (Dashboard/Games). Empty `[]` deps would have fired on first render with
  // `session=null`, then never re-fired when session loaded.
  useEffect(() => {
    if (!session?.access_token) return;
    async function loadBets() {
      setLoading(true);
      try {
        // First fetch bets
        const { data, error } = await supabase
          .from("bets")
          .select("*")
          .order("placed_at", { ascending: false });

        if (error) {
          console.error("Error fetching bets:", error);
          return;
        }

        const fetchedBets = (data ?? []) as Bet[];

        // Auto-resolve pending bets older than 6 hours
        const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
        const pendingOldBets = fetchedBets.filter(
          (b) => b.status === "pending" && b.placed_at < sixHoursAgo
        );

        if (pendingOldBets.length > 0) {
          console.log(`[AutoResolve] Checking ${pendingOldBets.length} old pending bets...`);

          for (const bet of pendingOldBets) {
            // Try to find matching pick_history entry with hit result
            // Derive game_date from bet's placed_at (Eastern time)
            const betDate = new Date(bet.placed_at);
            const betEastern = new Date(betDate.toLocaleString('en-US', { timeZone: 'America/New_York' }));
            const betGameDate = betEastern.toISOString().slice(0, 10).replace(/-/g, '');

            const { data: matchData } = await supabase
              .from("pick_history")
              .select("hit, game_date")
              .ilike("player_name", bet.player_name)
              .eq("prop_type", bet.prop_type)
              .eq("line", bet.line)
              .eq("pick_side", bet.pick_side)
              .eq("game_date", betGameDate)
              .not("hit", "is", null)
              .limit(1);

            if (matchData && matchData.length > 0) {
              const hit = matchData[0].hit as boolean;
              const newStatus = hit ? "won" : "lost";

              // Calculate payout
              let payout = 0;
              if (hit) {
                if (bet.odds > 0) {
                  payout = bet.stake * (bet.odds / 100);
                } else {
                  payout = bet.stake * (100 / Math.abs(bet.odds));
                }
              } else {
                payout = -bet.stake;
              }

              // Update the bet
              const { error: updateError } = await supabase
                .from("bets")
                .update({
                  status: newStatus,
                  payout: Math.round(payout * 100) / 100,
                  settled_at: new Date().toISOString(),
                })
                .eq("id", bet.id);

              if (!updateError) {
                console.log(`[AutoResolve] ${bet.player_name} ${bet.prop_type} -> ${newStatus}`);
                // Update local state
                bet.status = newStatus as "won" | "lost";
                bet.payout = Math.round(payout * 100) / 100;
              }
            }
          }
        }

        setBets(fetchedBets);
      } finally {
        setLoading(false);
      }
    }

    loadBets();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.access_token]);

  // Handle prefill from Evaluator
  useEffect(() => {
    if (prefill) {
      setPlayerName(prefill.playerName);
      setSelectedValue(prefill.playerName); // Prevent autocomplete from triggering
      // D-270-H4 — if the prefill prop_type belongs to MLB's set and we're
      // currently on NBA (or vice versa), flip the sport switcher so the
      // dropdown shows the correct option. Otherwise the sport-reset effect
      // would clobber the prefilled propType back to "points" / "hits".
      const pt = prefill.propType.toLowerCase();
      if (PROP_TYPES_BY_SPORT.mlb.includes(pt) && sport !== "mlb") {
        setSport("mlb");
      } else if (PROP_TYPES_BY_SPORT.nba.includes(pt) && sport !== "nba") {
        setSport("nba");
      }
      setPropType(pt);
      setLine(String(prefill.line));
      setSide(prefill.pickSide);
      setOdds(String(prefill.odds));
      // Clear the prefill after applying
      onClearPrefill?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill, onClearPrefill]);

  // Debounced player search
  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
    }

    // Don't search if this is the selected value
    if (selectedValue && playerName === selectedValue) {
      return;
    }

    // Clear selected value if user starts typing something different
    if (selectedValue && playerName !== selectedValue) {
      setSelectedValue(null);
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
    setSelectedValue(suggestion.displayName);
    setPlayerName(suggestion.displayName);
    setSuggestions([]);
    setShowSuggestions(false);
    inputRef.current?.blur();
  }

  function formatDate(isoDate: string): string {
    const date = new Date(isoDate);
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  async function checkDuplicateBet(
    playerNameVal: string,
    propTypeVal: string,
    lineVal: number,
    pickSideVal: string
  ): Promise<boolean> {
    try {
      const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

      const { data, error } = await supabase
        .from("bets")
        .select("id")
        .ilike("player_name", playerNameVal)
        .eq("prop_type", propTypeVal)
        .eq("line", lineVal)
        .eq("pick_side", pickSideVal)
        .gte("placed_at", twentyFourHoursAgo)
        .limit(1);

      if (error) {
        console.error("Error checking for duplicate:", error);
        return false; // Allow insert on error
      }

      return (data?.length ?? 0) > 0;
    } catch {
      return false; // Allow insert on error
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!playerName.trim() || !line || !odds || !stake) return;
    if (readOnly) return;  // D-350

    setSaving(true);
    try {
      const trimmedName = playerName.trim();
      const parsedLine = parseFloat(line);

      // Check for duplicate bet
      const isDuplicate = await checkDuplicateBet(trimmedName, propType, parsedLine, side);
      if (isDuplicate) {
        alert("This bet is already logged");
        setSaving(false);
        return;
      }

      // D-270-H4 — include `sport` so MLB bets are filterable downstream.
      // bets table accepts sport text column (added pre-D-204); on legacy
      // schemas the insert simply ignores unknown column → defensive.
      const newBet = {
        user_id: userId,
        player_name: trimmedName,
        prop_type: propType,
        line: parsedLine,
        pick_side: side,
        odds: parseInt(odds),
        stake: parseFloat(stake),
        status: "pending",
        sport,
      };

      const { data, error } = await supabase
        .from("bets")
        .insert(newBet)
        .select()
        .single();

      if (error) {
        console.error("Error saving bet:", error);
        alert("Failed to save bet: " + error.message);
      } else if (data) {
        setBets((prev) => [data as Bet, ...prev]);
        // Clear form
        setPlayerName("");
        setLine("");
        setOdds("");
        setStake("");
      }
    } finally {
      setSaving(false);
    }
  }

  async function handleDeleteBet(betId: string) {
    if (readOnly) return;  // D-350
    const confirmed = window.confirm("Delete this bet? This cannot be undone.");
    if (!confirmed) return;

    try {
      const { error } = await supabase
        .from("bets")
        .delete()
        .eq("id", betId);

      if (error) {
        console.error("Error deleting bet:", error);
        alert("Failed to delete bet: " + error.message);
      } else {
        // Remove from local state to update UI and summary stats
        setBets((prev) => prev.filter((b) => b.id !== betId));
      }
    } catch (err) {
      console.error("Error deleting bet:", err);
      alert("Failed to delete bet");
    }
  }

  async function handleUpdateStatus(betId: string, status: "won" | "lost") {
    if (readOnly) return;  // D-350
    const bet = bets.find((b) => b.id === betId);
    if (!bet) return;

    // Calculate payout
    let payout = 0;
    if (status === "won") {
      if (bet.odds > 0) {
        // Positive odds: +150 means win $150 per $100 stake
        payout = bet.stake * (bet.odds / 100);
      } else {
        // Negative odds: -110 means win $90.91 per $100 stake
        payout = bet.stake * (100 / Math.abs(bet.odds));
      }
    } else {
      payout = -bet.stake;
    }

    try {
      const { error } = await supabase
        .from("bets")
        .update({
          status,
          payout: Math.round(payout * 100) / 100,
          settled_at: new Date().toISOString(),
        })
        .eq("id", betId);

      if (error) {
        console.error("Error updating bet:", error);
        alert("Failed to update bet: " + error.message);
      } else {
        setBets((prev) =>
          prev.map((b) =>
            b.id === betId ? { ...b, status, payout: Math.round(payout * 100) / 100 } : b
          )
        );
      }
    } catch (err) {
      console.error("Error updating bet:", err);
    }
  }

  // Summary calculations
  const totalBets = bets.length;
  const wonBets = bets.filter((b) => b.status === "won").length;
  const lostBets = bets.filter((b) => b.status === "lost").length;
  const pendingBets = bets.filter((b) => b.status === "pending").length;
  const winRate = wonBets + lostBets > 0 ? ((wonBets / (wonBets + lostBets)) * 100).toFixed(1) : "0.0";

  const totalPl = bets.reduce((sum, b) => {
    if (b.status === "won") {
      const profit = b.payout ?? (b.odds > 0 ? b.stake * (b.odds / 100) : b.stake * (100 / Math.abs(b.odds)));
      return sum + profit;
    }
    if (b.status === "lost") {
      return sum - b.stake;
    }
    return sum;
  }, 0);

  const totalStaked = bets.reduce((sum, b) => sum + b.stake, 0);
  const roi = totalStaked > 0 ? ((totalPl / totalStaked) * 100).toFixed(1) : "0.0";

  return (
    <div className="space-y-8">
      {/* Summary */}
      <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-4">
        <SummaryCard label="Total Bets" value={String(totalBets)} />
        <SummaryCard label="Won" value={String(wonBets)} color="text-emerald-400" />
        <SummaryCard label="Lost" value={String(lostBets)} color="text-red-400" />
        <SummaryCard label="Pending" value={String(pendingBets)} color="text-yellow-400" />
        <SummaryCard label="Win Rate" value={`${winRate}%`} />
        <SummaryCard
          label="Profit/Loss"
          value={`${totalPl >= 0 ? "+" : ""}$${totalPl.toFixed(2)}`}
          color={totalPl > 0 ? "text-emerald-400" : totalPl < 0 ? "text-red-400" : "text-zinc-300"}
        />
        <SummaryCard
          label="ROI"
          value={`${parseFloat(roi) >= 0 ? "+" : ""}${roi}%`}
          color={parseFloat(roi) > 0 ? "text-emerald-400" : parseFloat(roi) < 0 ? "text-red-400" : "text-zinc-300"}
        />
      </div>

      {/* Log Bet Form */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-6">
        <div className="flex items-center justify-between flex-wrap gap-3 mb-5">
          <h2 className="text-lg font-medium text-zinc-200">Log a Bet</h2>
          {/* D-270-H4 — sport switcher; matches Dashboard pattern. */}
          <SportSelector value={sport} onChange={setSport} />
        </div>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <div className="space-y-1.5 relative">
              <label className="text-xs text-zinc-500">Player</label>
              <div className="relative">
                <input
                  ref={inputRef}
                  type="text"
                  placeholder="Player name"
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
              {/* Player Suggestions Dropdown */}
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
            <Field label="Prop Type">
              <select
                value={propType}
                onChange={(e) => setPropType(e.target.value)}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
              >
                {PROP_TYPES_BY_SPORT[sport].map((p) => (
                  <option key={p} value={p}>
                    {PROP_LABELS[p] ?? p}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Line">
              <input
                type="number"
                step="0.5"
                placeholder="24.5"
                value={line}
                onChange={(e) => setLine(e.target.value)}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white placeholder-zinc-500 outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
              />
            </Field>
            <Field label="Side">
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setSide("over")}
                  className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                    side === "over"
                      ? "border-emerald-500 bg-emerald-500/20 text-emerald-400"
                      : "border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-zinc-600"
                  }`}
                >
                  Over
                </button>
                <button
                  type="button"
                  onClick={() => setSide("under")}
                  className={`flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                    side === "under"
                      ? "border-red-500 bg-red-500/20 text-red-400"
                      : "border-zinc-700 bg-zinc-800 text-zinc-400 hover:border-zinc-600"
                  }`}
                >
                  Under
                </button>
              </div>
            </Field>
            <Field label="Odds">
              <input
                type="number"
                placeholder="-110"
                value={odds}
                onChange={(e) => setOdds(e.target.value)}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white placeholder-zinc-500 outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
              />
            </Field>
            <Field label="Stake ($)">
              <input
                type="number"
                step="0.01"
                placeholder={readDiscretionaryStake().toFixed(2)}
                value={stake}
                onChange={(e) => setStake(e.target.value)}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-white placeholder-zinc-500 outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500"
              />
            </Field>
          </div>
          <button
            type="submit"
            disabled={!playerName.trim() || !line || !odds || !stake || saving || readOnly}
            title={readOnly ? readOnlyTip : undefined}
            className="w-full rounded-lg bg-emerald-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {saving ? "Saving..." : "Log Bet"}
          </button>
        </form>
      </section>

      {/* Bets Table */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 overflow-hidden">
        <div className="px-6 py-4 border-b border-zinc-800">
          <h2 className="text-lg font-medium text-zinc-200">Bet History</h2>
        </div>
        {loading ? (
          <div className="p-8 text-center">
            <div className="inline-block h-6 w-6 animate-spin rounded-full border-2 border-zinc-600 border-t-emerald-500 mb-3" />
            <p className="text-zinc-500 text-sm">Loading bets...</p>
          </div>
        ) : bets.length === 0 ? (
          <div className="p-8 text-center">
            <p className="text-zinc-500 text-sm">No bets logged yet</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-zinc-500 text-left">
                  <th className="px-6 py-3 font-medium">Date</th>
                  <th className="px-6 py-3 font-medium">Player</th>
                  <th className="px-6 py-3 font-medium">Prop</th>
                  <th className="px-6 py-3 font-medium">Line</th>
                  <th className="px-6 py-3 font-medium">Side</th>
                  <th className="px-6 py-3 font-medium">Odds</th>
                  <th className="px-6 py-3 font-medium">Stake</th>
                  <th className="px-6 py-3 font-medium">Status</th>
                  <th className="px-6 py-3 font-medium">Actions</th>
                </tr>
              </thead>
              <tbody>
                {bets.map((bet) => (
                  <tr key={bet.id} className="border-b border-zinc-800/50 hover:bg-zinc-800/30">
                    <td className="px-6 py-3 text-zinc-500 text-xs">{formatDate(bet.placed_at)}</td>
                    <td className="px-6 py-3 text-white">{bet.player_name}</td>
                    <td className="px-6 py-3 text-zinc-300 capitalize">{bet.prop_type}</td>
                    <td className="px-6 py-3 text-zinc-300">{bet.line}</td>
                    <td className="px-6 py-3">
                      <span className={bet.pick_side === "over" ? "text-emerald-400" : "text-red-400"}>
                        {bet.pick_side.charAt(0).toUpperCase() + bet.pick_side.slice(1)}
                      </span>
                    </td>
                    <td className="px-6 py-3 text-zinc-300">
                      {bet.odds > 0 ? `+${bet.odds}` : bet.odds}
                    </td>
                    <td className="px-6 py-3 text-zinc-300">${bet.stake.toFixed(2)}</td>
                    <td className="px-6 py-3">
                      <StatusBadge status={bet.status} payout={bet.payout} />
                    </td>
                    <td className="px-6 py-3">
                      <div className="flex items-center gap-2">
                        {bet.status === "pending" ? (
                          <>
                            <button
                              onClick={() => handleUpdateStatus(bet.id, "won")}
                              disabled={readOnly}
                              title={readOnly ? readOnlyTip : undefined}
                              className="rounded-md bg-emerald-500/20 border border-emerald-500/30 px-2.5 py-1 text-xs font-medium text-emerald-400 hover:bg-emerald-500/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              Won ✓
                            </button>
                            <button
                              onClick={() => handleUpdateStatus(bet.id, "lost")}
                              disabled={readOnly}
                              title={readOnly ? readOnlyTip : undefined}
                              className="rounded-md bg-red-500/20 border border-red-500/30 px-2.5 py-1 text-xs font-medium text-red-400 hover:bg-red-500/30 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                            >
                              Lost ✗
                            </button>
                          </>
                        ) : null}
                        <button
                          onClick={() => handleDeleteBet(bet.id)}
                          disabled={readOnly}
                          className="p-1.5 rounded-md text-zinc-400 hover:text-red-400 hover:bg-red-500/20 bg-zinc-800 border border-zinc-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                          title={readOnly ? readOnlyTip : "Delete bet"}
                        >
                          <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="text-xs text-zinc-500">{label}</label>
      {children}
    </div>
  );
}

function SummaryCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 px-5 py-4">
      <p className="text-xs text-zinc-500 mb-1">{label}</p>
      <p className={`text-2xl font-semibold ${color ?? "text-white"}`}>{value}</p>
    </div>
  );
}

function StatusBadge({ status, payout }: { status: string; payout?: number }) {
  const styles = {
    pending: "bg-yellow-500/10 text-yellow-400",
    won: "bg-emerald-500/10 text-emerald-400",
    lost: "bg-red-500/10 text-red-400",
  };

  const style = styles[status as keyof typeof styles] ?? styles.pending;

  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${style}`}>
      {status.charAt(0).toUpperCase() + status.slice(1)}
      {payout !== undefined && status !== "pending" && (
        <span className="ml-1">
          ({payout >= 0 ? "+" : ""}${payout.toFixed(2)})
        </span>
      )}
    </span>
  );
}
