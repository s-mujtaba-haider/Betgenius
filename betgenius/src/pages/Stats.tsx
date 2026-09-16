import { useState } from "react";

const SUPABASE_URL = "https://gzuzuqxvfjszlfclhcfz.supabase.co";

interface TeamStats {
  team: string; abbrev: string; wins: number; losses: number;
  ppgScored: number; ppgAllowed: number; netRating: number;
  l10: { wins: number; losses: number };
  home: { wins: number; losses: number };
  away: { wins: number; losses: number };
  recentPPG: number; pointDiff: number; restDays: number;
  recentGames: { date: string; opponent: string; score: string; result: string }[];
  rpg?: number; apg?: number; fgPct?: number; blkPg?: number; stlPg?: number;
}

interface PlayerStats {
  name: string; team: string; position: string;
  seasonAvg: Record<string, number>;
  l5Avg: Record<string, number>;
  l10Avg: Record<string, number>;
  recentGames: { date: string; opponent: string; result: string; score: string; pts: number; reb: number; ast: number; stl: number; blk: number; min: number }[];
  totalGames: number;
}

interface H2HGame { date: string; home: string; away: string; homeScore: number; awayScore: number; }

const ALL_TEAMS = [
  "Atlanta Hawks", "Boston Celtics", "Brooklyn Nets", "Charlotte Hornets", "Chicago Bulls",
  "Cleveland Cavaliers", "Dallas Mavericks", "Denver Nuggets", "Detroit Pistons",
  "Golden State Warriors", "Houston Rockets", "Indiana Pacers", "Los Angeles Clippers",
  "Los Angeles Lakers", "Memphis Grizzlies", "Miami Heat", "Milwaukee Bucks",
  "Minnesota Timberwolves", "New Orleans Pelicans", "New York Knicks", "Oklahoma City Thunder",
  "Orlando Magic", "Philadelphia 76ers", "Phoenix Suns", "Portland Trail Blazers",
  "Sacramento Kings", "San Antonio Spurs", "Toronto Raptors", "Utah Jazz", "Washington Wizards",
];

export default function Stats() {
  const [mode, setMode] = useState<"team" | "player" | "matchup">("team");
  const [team1, setTeam1] = useState("");
  const [team2, setTeam2] = useState("");
  const [playerSearch, setPlayerSearch] = useState("");
  const [stats1, setStats1] = useState<TeamStats | null>(null);
  const [stats2, setStats2] = useState<TeamStats | null>(null);
  const [playerData, setPlayerData] = useState<PlayerStats | null>(null);
  const [h2h, setH2h] = useState<H2HGame[]>([]);
  const [loading, setLoading] = useState(false);
  const [matchupTeam, setMatchupTeam] = useState("");
  const [suggestions, setSuggestions] = useState<any[]>([]);
  const [acTimer, setAcTimer] = useState<any>(null);

  function handleAutocomplete(query: string) {
    if (acTimer) clearTimeout(acTimer);
    if (query.length < 2) { setSuggestions([]); return; }
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(SUPABASE_URL + "/functions/v1/team-stats", {
          method: "POST",
          headers: { "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9", "Content-Type": "application/json" },
          body: JSON.stringify({ playerQuery: query }),
        });
        const data = await res.json();
        if (data.suggestions) setSuggestions(data.suggestions);
      } catch (e) { /* ignore */ }
    }, 300);
    setAcTimer(timer);
  }
  const [error, setError] = useState<string | null>(null);

  async function fetchTeamStats() {
    if (!team1) return;
    setLoading(true); setError(null); setStats1(null); setStats2(null); setH2h([]);
    try {
      const res = await fetch(SUPABASE_URL + "/functions/v1/team-stats", {
        method: "POST",
        headers: { "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9", "Content-Type": "application/json" },
        body: JSON.stringify({ team1, team2: team2 || undefined }),
      });
      const data = await res.json();
      if (data.team1) setStats1(data.team1);
      if (data.team2) setStats2(data.team2);
      if (data.h2h) setH2h(data.h2h);
    } catch (e) { setError(String(e)); }
    setLoading(false);
  }

  const [vsData, setVsData] = useState<any>(null);

  async function fetchPlayer() {
    if (!playerSearch.trim()) return;
    setLoading(true); setError(null); setPlayerData(null); setVsData(null);
    try {
      const body: any = { player: playerSearch.trim() };
      if (mode === "matchup" && matchupTeam) body.vsTeam = matchupTeam;
      const res = await fetch(SUPABASE_URL + "/functions/v1/team-stats", {
        method: "POST",
        headers: { "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9", "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (data.player) setPlayerData(data.player);
      if (data.vs) setVsData(data.vs);
      if (!data.player && !data.vs) setError(data.error || "Player not found");
    } catch (e) { setError(String(e)); }
    setLoading(false);
  }

  const tabClass = (active: boolean) => `px-4 py-2 text-sm font-medium rounded-lg transition-colors ${active ? "bg-emerald-600 text-white" : "bg-zinc-800 text-zinc-400 hover:text-zinc-200"}`;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-medium text-zinc-200">Stats Lookup</h2>
        <p className="text-xs text-zinc-500 mt-0.5">Look up team stats, player stats, or compare matchups</p>
      </div>

      {/* Mode Toggle */}
      <div className="flex flex-wrap gap-2">
        <button className={tabClass(mode === "team")} onClick={() => { setMode("team"); setPlayerData(null); setError(null); }}>Teams</button>
        <button className={tabClass(mode === "player")} onClick={() => { setMode("player"); setStats1(null); setStats2(null); setH2h([]); setError(null); }}>Players</button>
        <button className={tabClass(mode === "matchup")} onClick={() => { setMode("matchup"); setStats1(null); setStats2(null); setH2h([]); setPlayerData(null); setError(null); }}>Player vs Team</button>
      </div>

      {/* Team Mode */}
      {mode === "team" && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Team 1</label>
              <select value={team1} onChange={e => { setTeam1(e.target.value); setStats1(null); setStats2(null); }}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-800 text-white text-sm px-3 py-2 focus:outline-none focus:border-emerald-500">
                <option value="">Select team...</option>
                {ALL_TEAMS.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-zinc-400 mb-1">Team 2 (for comparison)</label>
              <select value={team2} onChange={e => { setTeam2(e.target.value); setStats2(null); setH2h([]); }}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-800 text-white text-sm px-3 py-2 focus:outline-none focus:border-emerald-500">
                <option value="">Select team...</option>
                {ALL_TEAMS.filter(t => t !== team1).map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          </div>
          <button onClick={fetchTeamStats} disabled={!team1 || loading}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-emerald-600 text-white hover:bg-emerald-500 transition-colors disabled:opacity-50">
            {loading ? "Loading..." : "Lookup"}
          </button>
        </div>
      )}

      {/* Player Mode */}
      {mode === "player" && (
        <div className="space-y-4">
          <div className="relative">
            <label className="block text-xs text-zinc-400 mb-1">Player Name</label>
            <div className="flex gap-2">
              <div className="flex-1 relative">
                <input value={playerSearch} onChange={e => { setPlayerSearch(e.target.value); handleAutocomplete(e.target.value); }}
                  onKeyDown={e => { if (e.key === "Enter") { setSuggestions([]); fetchPlayer(); } }}
                  placeholder="e.g. LeBron James"
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-800 text-white text-sm px-3 py-2 focus:outline-none focus:border-emerald-500 placeholder-zinc-600" />
                {suggestions.length > 0 && (
                  <div className="absolute top-full left-0 right-0 mt-1 rounded-lg border border-zinc-700 bg-zinc-800 shadow-xl z-20 max-h-60 overflow-y-auto">
                    {suggestions.map((s: any, i: number) => (
                      <button key={i} onClick={() => { setPlayerSearch(s.name); setSuggestions([]); }}
                        className="w-full px-3 py-2 text-left hover:bg-zinc-700 transition-colors flex items-center justify-between">
                        <span className="text-sm text-white">{s.name}</span>
                        <span className="text-xs text-zinc-500 ml-2">{s.team} · {s.position}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <button onClick={() => { setSuggestions([]); fetchPlayer(); }} disabled={!playerSearch.trim() || loading}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-emerald-600 text-white hover:bg-emerald-500 transition-colors disabled:opacity-50">
                {loading ? "..." : "Search"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Player vs Team Mode */}
      {mode === "matchup" && (
        <div className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-4">
            <div className="relative">
              <label className="block text-xs text-zinc-400 mb-1">Player</label>
              <div className="relative">
                <input value={playerSearch} onChange={e => { setPlayerSearch(e.target.value); handleAutocomplete(e.target.value); }}
                  onKeyDown={e => { if (e.key === "Enter") { setSuggestions([]); } }}
                  placeholder="e.g. LeBron James"
                  className="w-full rounded-lg border border-zinc-700 bg-zinc-800 text-white text-sm px-3 py-2 focus:outline-none focus:border-emerald-500 placeholder-zinc-600" />
                {suggestions.length > 0 && (
                  <div className="absolute top-full left-0 right-0 mt-1 rounded-lg border border-zinc-700 bg-zinc-800 shadow-xl z-20 max-h-60 overflow-y-auto">
                    {suggestions.map((s: any, i: number) => (
                      <button key={i} onClick={() => { setPlayerSearch(s.name); setSuggestions([]); }}
                        className="w-full px-3 py-2 text-left hover:bg-zinc-700 transition-colors flex items-center justify-between">
                        <span className="text-sm text-white">{s.name}</span>
                        <span className="text-xs text-zinc-500 ml-2">{s.team} · {s.position}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div>
              <label className="block text-xs text-zinc-400 mb-1">vs Team</label>
              <select value={matchupTeam} onChange={e => setMatchupTeam(e.target.value)}
                className="w-full rounded-lg border border-zinc-700 bg-zinc-800 text-white text-sm px-3 py-2 focus:outline-none focus:border-emerald-500">
                <option value="">Select team...</option>
                {ALL_TEAMS.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
          </div>
          <button onClick={() => { setSuggestions([]); fetchPlayer(); }} disabled={!playerSearch.trim() || loading}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-emerald-600 text-white hover:bg-emerald-500 transition-colors disabled:opacity-50">
            {loading ? "Loading..." : "Lookup"}
          </button>
        </div>
      )}

      {/* Player vs Team Results */}
      {mode === "matchup" && playerData && matchupTeam && (() => {
        const bdlGames = vsData?.vsGames ?? [];
        const vsGames = bdlGames.length > 0 ? bdlGames : playerData.recentGames.filter((g: any) =>
          g.opponent?.toLowerCase().includes(matchupTeam.toLowerCase().split(" ").pop() || "")
        );
        const avg = (arr: any[], key: string) => arr.length ? arr.reduce((s: number, g: any) => s + (g[key] ?? 0), 0) / arr.length : 0;
        const wins = vsGames.filter((g: any) => {
          if (g.homeTeam !== undefined) {
            const isHome = !g.homeTeam?.toLowerCase().includes(matchupTeam.toLowerCase().split(" ").pop() || "");
            return isHome ? g.homeScore > g.awayScore : g.awayScore > g.homeScore;
          }
          return g.result === "W";
        }).length;
        const losses = vsGames.length - wins;
        return (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4 space-y-4">
            <div>
              <h3 className="text-white font-semibold text-lg">{playerData.name} vs {matchupTeam}</h3>
              <p className="text-xs text-zinc-500">{vsGames.length} games this season · Record: {wins}W-{losses}L</p>
            </div>
            {vsGames.length > 0 ? (
              <>
                <div className="rounded-lg border border-zinc-800 overflow-hidden">
                  <div className="overflow-x-auto">
                    <div className="bg-zinc-800/60 px-4 py-2 grid grid-cols-7 text-xs font-semibold text-zinc-400 min-w-[560px]">
                      <span>Stat</span><span className="text-center">vs {matchupTeam.split(" ").pop()}</span><span className="text-center">Season</span>
                      <span className="text-center">Diff</span><span className="text-center">L10</span><span className="text-center">L5</span><span className="text-center">Edge?</span>
                    </div>
                    {[
                      { label: "PPG", key: "pts", sKey: "ppg" },
                      { label: "RPG", key: "reb", sKey: "rpg" },
                      { label: "APG", key: "ast", sKey: "apg" },
                      { label: "SPG", key: "stl", sKey: "spg" },
                      { label: "BPG", key: "blk", sKey: "bpg" },
                      { label: "MPG", key: "min", sKey: "mpg" },
                    ].map(({ label, key, sKey }) => {
                      const vsAvg = avg(vsGames, key);
                      const szn = playerData.seasonAvg[sKey] ?? 0;
                      const diff = vsAvg - szn;
                      const edge = diff > 1 ? "OVER" : diff < -1 ? "UNDER" : "—";
                      const edgeColor = edge === "OVER" ? "text-emerald-400" : edge === "UNDER" ? "text-red-400" : "text-zinc-600";
                      return (
                        <div key={key} className="px-2 sm:px-4 py-1.5 grid grid-cols-7 text-xs sm:text-sm border-b border-zinc-800/30 min-w-[560px]">
                          <span className="text-zinc-400">{label}</span>
                          <span className="text-center text-white font-medium">{vsAvg.toFixed(1)}</span>
                          <span className="text-center text-zinc-400">{szn.toFixed(1)}</span>
                          <span className={`text-center font-medium ${diff > 0 ? "text-emerald-400" : diff < 0 ? "text-red-400" : "text-zinc-600"}`}>{diff > 0 ? "+" : ""}{diff.toFixed(1)}</span>
                          <span className="text-center text-zinc-400">{(playerData.l10Avg[sKey] ?? 0).toFixed(1)}</span>
                          <span className="text-center text-zinc-400">{(playerData.l5Avg[sKey] ?? 0).toFixed(1)}</span>
                          <span className={`text-center font-medium text-xs ${edgeColor}`}>{edge}</span>
                        </div>
                      );
                    })}
                  </div>
                </div>
                <div>
                  <h4 className="text-sm font-medium text-zinc-400 mb-2">Games vs {matchupTeam.split(" ").pop()}</h4>
                  <div className="overflow-x-auto">
                    <div className="grid grid-cols-8 gap-1 text-xs font-semibold text-zinc-500 pb-1 border-b border-zinc-700 min-w-[560px]">
                      <span>Date</span><span>Loc</span><span className="text-center">Result</span>
                      <span className="text-center">MIN</span><span className="text-center">PTS</span>
                      <span className="text-center">REB</span><span className="text-center">AST</span>
                      <span className="text-center">STL/BLK</span>
                    </div>
                    {vsGames.map((g: any, i: number) => {
                      const isBDL = g.homeTeam !== undefined;
                      const isHome = isBDL ? !g.homeTeam?.toLowerCase().includes(matchupTeam.toLowerCase().split(" ").pop() || "") : !g.opponent?.startsWith("@");
                      const score = isBDL ? (isHome ? g.homeScore + "-" + g.awayScore : g.awayScore + "-" + g.homeScore) : g.score;
                      const playerScore = isBDL ? (isHome ? g.homeScore : g.awayScore) : 0;
                      const oppScore = isBDL ? (isHome ? g.awayScore : g.homeScore) : 0;
                      const result = isBDL ? (playerScore > oppScore ? "W" : "L") : g.result;
                      return (
                      <div key={i} className="grid grid-cols-8 gap-1 text-xs py-1 border-b border-zinc-800/20 min-w-[560px]">
                        <span className="text-zinc-500">{g.date?.slice(0, 10)}</span>
                        <span className="text-zinc-300">{isHome ? "Home" : "Away"}</span>
                        <span className={`text-center font-medium ${result === "W" ? "text-emerald-400" : "text-red-400"}`}>{result} {score}</span>
                        <span className="text-center text-zinc-300">{g.min}</span>
                        <span className="text-center text-white font-medium">{g.pts}</span>
                        <span className="text-center text-zinc-300">{g.reb}</span>
                        <span className="text-center text-zinc-300">{g.ast}</span>
                        <span className="text-center text-zinc-500">{g.stl}/{g.blk}</span>
                      </div>
                      );
                    })}
                  </div>
                </div>
              </>
            ) : (
              <p className="text-zinc-500 text-sm">No games found vs {matchupTeam} this season</p>
            )}
          </div>
        );
      })()}

      {error && <p className="text-red-400 text-sm">{error}</p>}

      {/* Player Results */}
      {playerData && (
        <div className="space-y-4">
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-white font-semibold text-lg">{playerData.name}</h3>
                <p className="text-xs text-zinc-500">{playerData.team} · {playerData.position} · {playerData.totalGames} games</p>
              </div>
            </div>

            {/* Averages Comparison */}
            <div className="rounded-lg border border-zinc-800 overflow-hidden">
              <div className="bg-zinc-800/60 px-4 py-2 grid grid-cols-4 text-xs font-semibold text-zinc-400">
                <span>Stat</span><span className="text-center">Season</span><span className="text-center">L10</span><span className="text-center">L5</span>
              </div>
              {[
                { label: "PPG", key: "ppg" }, { label: "RPG", key: "rpg" }, { label: "APG", key: "apg" },
                { label: "SPG", key: "spg" }, { label: "BPG", key: "bpg" }, { label: "MPG", key: "mpg" },
              ].map(({ label, key }) => (
                <div key={key} className="px-4 py-1.5 grid grid-cols-4 text-sm border-b border-zinc-800/30">
                  <span className="text-zinc-400">{label}</span>
                  <span className="text-center text-white font-medium">{(playerData.seasonAvg[key] ?? 0).toFixed(1)}</span>
                  <span className={`text-center font-medium ${(playerData.l10Avg[key] ?? 0) > (playerData.seasonAvg[key] ?? 0) ? "text-emerald-400" : (playerData.l10Avg[key] ?? 0) < (playerData.seasonAvg[key] ?? 0) ? "text-red-400" : "text-white"}`}>
                    {(playerData.l10Avg[key] ?? 0).toFixed(1)}
                  </span>
                  <span className={`text-center font-medium ${(playerData.l5Avg[key] ?? 0) > (playerData.seasonAvg[key] ?? 0) ? "text-emerald-400" : (playerData.l5Avg[key] ?? 0) < (playerData.seasonAvg[key] ?? 0) ? "text-red-400" : "text-white"}`}>
                    {(playerData.l5Avg[key] ?? 0).toFixed(1)}
                  </span>
                </div>
              ))}
              {playerData.seasonAvg.fgPct ? (
                <>
                  {[
                    { label: "FG%", val: playerData.seasonAvg.fgPct },
                    { label: "3PT%", val: playerData.seasonAvg.threePct },
                    { label: "FT%", val: playerData.seasonAvg.ftPct },
                  ].map(({ label, val }) => (
                    <div key={label} className="px-4 py-1.5 grid grid-cols-4 text-sm border-b border-zinc-800/30">
                      <span className="text-zinc-400">{label}</span>
                      <span className="text-center text-white font-medium">{val ? (val > 1 ? val.toFixed(1) : (val * 100).toFixed(1)) + "%" : "—"}</span>
                      <span className="text-center text-zinc-600">—</span>
                      <span className="text-center text-zinc-600">—</span>
                    </div>
                  ))}
                </>
              ) : null}
            </div>
          </div>

          {/* Recent Game Log */}
          {playerData.recentGames.length > 0 && (
            <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
              <h4 className="text-sm font-medium text-zinc-400 mb-2">Recent Game Log</h4>
              <div className="overflow-x-auto">
                <div className="grid grid-cols-8 gap-1 text-xs font-semibold text-zinc-500 pb-1 border-b border-zinc-700 min-w-[500px]">
                  <span>Date</span><span>Opp</span><span className="text-center">Result</span>
                  <span className="text-center">MIN</span><span className="text-center">PTS</span>
                  <span className="text-center">REB</span><span className="text-center">AST</span>
                  <span className="text-center">STL/BLK</span>
                </div>
                {playerData.recentGames.slice(0, 15).map((g, i) => (
                  <div key={i} className="grid grid-cols-8 gap-1 text-xs py-1 border-b border-zinc-800/20 min-w-[600px]">
                    <span className="text-zinc-500">{g.date?.slice(0, 10)}</span>
                    <span className="text-zinc-300 truncate">{g.opponent}</span>
                    <span className={`text-center font-medium ${g.result === "W" ? "text-emerald-400" : "text-red-400"}`}>{g.result} {g.score}</span>
                    <span className="text-center text-zinc-300">{g.min}</span>
                    <span className="text-center text-white font-medium">{g.pts}</span>
                    <span className="text-center text-zinc-300">{g.reb}</span>
                    <span className="text-center text-zinc-300">{g.ast}</span>
                    <span className="text-center text-zinc-500">{g.stl}/{g.blk}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Single Team View */}
      {mode === "team" && stats1 && !stats2 && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <h3 className="text-white font-semibold text-lg mb-3">{stats1.team} ({stats1.abbrev})</h3>
          <div className="space-y-1">
            {[
              { label: "Record", val: stats1.wins + "-" + stats1.losses + " (" + ((stats1.wins / Math.max(1, stats1.wins + stats1.losses)) * 100).toFixed(1) + "%)" },
              { label: "PPG", val: stats1.ppgScored.toFixed(1) },
              { label: "Opp PPG", val: stats1.ppgAllowed.toFixed(1) },
              { label: "RPG", val: (stats1 as any).rpg?.toFixed(1) ?? "—" },
              { label: "APG", val: (stats1 as any).apg?.toFixed(1) ?? "—" },
              { label: "FG%", val: (stats1 as any).fgPct ? (stats1 as any).fgPct.toFixed(1) + "%" : "—" },
              { label: "BLK/G", val: (stats1 as any).blkPg?.toFixed(1) ?? "—" },
              { label: "STL/G", val: (stats1 as any).stlPg?.toFixed(1) ?? "—" },
              { label: "Net Rating", val: (stats1.netRating > 0 ? "+" : "") + stats1.netRating.toFixed(1) },
              { label: "L10", val: stats1.l10.wins + "-" + stats1.l10.losses },
              { label: "Home", val: stats1.home.wins + "-" + stats1.home.losses },
              { label: "Away", val: stats1.away.wins + "-" + stats1.away.losses },
              { label: "L5 PPG", val: stats1.recentPPG > 0 ? stats1.recentPPG.toFixed(1) : "—" },
              { label: "Pt Diff/Game", val: (stats1.pointDiff > 0 ? "+" : "") + stats1.pointDiff.toFixed(1) },
              { label: "Rest Days", val: String(stats1.restDays) },
            ].map(r => (
              <div key={r.label} className="grid grid-cols-2 gap-1 text-sm py-1.5 border-b border-zinc-800/30">
                <span className="text-zinc-400">{r.label}</span>
                <span className="text-center text-white font-medium">{r.val}</span>
              </div>
            ))}
          </div>
          {stats1.recentGames.length > 0 && (
            <div className="mt-4 pt-4 border-t border-zinc-800/50">
              <h4 className="text-sm font-medium text-zinc-400 mb-2">Recent Games</h4>
              {stats1.recentGames.map((g, i) => (
                <div key={i} className="flex justify-between text-xs py-1 border-b border-zinc-800/20">
                  <span className="text-zinc-500">{g.date}</span>
                  <span className="text-zinc-300">{g.opponent}</span>
                  <span className="text-white font-medium">{g.score}</span>
                  <span className={g.result === "W" ? "text-emerald-400 font-medium" : "text-red-400 font-medium"}>{g.result}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Team Comparison View */}
      {mode === "team" && stats1 && stats2 && (() => {
        const better = (a: number, b: number) => a > b ? "text-emerald-400" : a < b ? "text-red-400" : "text-white";
        const rows = [
          { label: "Record", v1: stats1.wins + "-" + stats1.losses, v2: stats2.wins + "-" + stats2.losses, a: stats1.wins / Math.max(1, stats1.wins + stats1.losses), b: stats2.wins / Math.max(1, stats2.wins + stats2.losses) },
          { label: "PPG", v1: stats1.ppgScored.toFixed(1), v2: stats2.ppgScored.toFixed(1), a: stats1.ppgScored, b: stats2.ppgScored },
          { label: "Opp PPG", v1: stats1.ppgAllowed.toFixed(1), v2: stats2.ppgAllowed.toFixed(1), a: -stats1.ppgAllowed, b: -stats2.ppgAllowed },
          { label: "RPG", v1: (stats1 as any).rpg?.toFixed(1) ?? "—", v2: (stats2 as any).rpg?.toFixed(1) ?? "—", a: (stats1 as any).rpg ?? 0, b: (stats2 as any).rpg ?? 0 },
          { label: "APG", v1: (stats1 as any).apg?.toFixed(1) ?? "—", v2: (stats2 as any).apg?.toFixed(1) ?? "—", a: (stats1 as any).apg ?? 0, b: (stats2 as any).apg ?? 0 },
          { label: "FG%", v1: (stats1 as any).fgPct ? (stats1 as any).fgPct.toFixed(1) + "%" : "—", v2: (stats2 as any).fgPct ? (stats2 as any).fgPct.toFixed(1) + "%" : "—", a: (stats1 as any).fgPct ?? 0, b: (stats2 as any).fgPct ?? 0 },
          { label: "Net Rating", v1: (stats1.netRating > 0 ? "+" : "") + stats1.netRating.toFixed(1), v2: (stats2.netRating > 0 ? "+" : "") + stats2.netRating.toFixed(1), a: stats1.netRating, b: stats2.netRating },
          { label: "L10", v1: stats1.l10.wins + "-" + stats1.l10.losses, v2: stats2.l10.wins + "-" + stats2.l10.losses, a: stats1.l10.wins, b: stats2.l10.wins },
          { label: "Home", v1: stats1.home.wins + "-" + stats1.home.losses, v2: stats2.home.wins + "-" + stats2.home.losses, a: stats1.home.wins, b: stats2.home.wins },
          { label: "Away", v1: stats1.away.wins + "-" + stats1.away.losses, v2: stats2.away.wins + "-" + stats2.away.losses, a: stats1.away.wins, b: stats2.away.wins },
          { label: "L5 PPG", v1: stats1.recentPPG > 0 ? stats1.recentPPG.toFixed(1) : "—", v2: stats2.recentPPG > 0 ? stats2.recentPPG.toFixed(1) : "—", a: stats1.recentPPG, b: stats2.recentPPG },
          { label: "Pt Diff", v1: (stats1.pointDiff > 0 ? "+" : "") + stats1.pointDiff.toFixed(1), v2: (stats2.pointDiff > 0 ? "+" : "") + stats2.pointDiff.toFixed(1), a: stats1.pointDiff, b: stats2.pointDiff },
          { label: "Rest Days", v1: String(stats1.restDays), v2: String(stats2.restDays), a: stats1.restDays, b: stats2.restDays },
        ];
        return (
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 overflow-hidden">
            <div className="bg-zinc-800/60 px-4 py-3 grid grid-cols-3 text-sm font-semibold">
              <span className="text-zinc-400">Stat</span>
              <span className="text-center text-white">{stats1.abbrev}</span>
              <span className="text-center text-white">{stats2.abbrev}</span>
            </div>
            <div className="px-4 py-2">
              {rows.map(r => (
                <div key={r.label} className="grid grid-cols-3 gap-1 text-sm py-1.5 border-b border-zinc-800/30">
                  <span className="text-zinc-400">{r.label}</span>
                  <span className={`text-center font-medium ${better(r.a, r.b)}`}>{r.v1}</span>
                  <span className={`text-center font-medium ${better(r.b, r.a)}`}>{r.v2}</span>
                </div>
              ))}
            </div>
          </div>
        );
      })()}

      {/* H2H */}
      {h2h.length > 0 && (
        <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-4">
          <h3 className="text-white font-semibold mb-3">Head-to-Head (2025 Season)</h3>
          {h2h.map((g, i) => (
            <div key={i} className="flex justify-between text-sm py-1.5 border-b border-zinc-800/30">
              <span className="text-zinc-500">{g.date}</span>
              <span className="text-zinc-300">{g.away} @ {g.home}</span>
              <span className="text-white font-medium">{g.awayScore} - {g.homeScore}</span>
              <span className={g.homeScore > g.awayScore ? "text-emerald-400" : "text-red-400"}>
                {g.homeScore > g.awayScore ? g.home?.split(" ").pop() : g.away?.split(" ").pop()} W
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
