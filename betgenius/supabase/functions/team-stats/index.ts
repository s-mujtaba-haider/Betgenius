import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const BALLDONTLIE_API_KEY = Deno.env.get("BALLDONTLIE_API_KEY") || "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const TEAM_ABBREV: Record<string, string> = {
  "atlanta hawks": "ATL", "boston celtics": "BOS", "brooklyn nets": "BKN", "charlotte hornets": "CHA", "chicago bulls": "CHI",
  "cleveland cavaliers": "CLE", "dallas mavericks": "DAL", "denver nuggets": "DEN", "detroit pistons": "DET",
  "golden state warriors": "GSW", "houston rockets": "HOU", "indiana pacers": "IND", "los angeles clippers": "LAC",
  "los angeles lakers": "LAL", "memphis grizzlies": "MEM", "miami heat": "MIA", "milwaukee bucks": "MIL",
  "minnesota timberwolves": "MIN", "new orleans pelicans": "NOP", "new york knicks": "NYK", "oklahoma city thunder": "OKC",
  "orlando magic": "ORL", "philadelphia 76ers": "PHI", "phoenix suns": "PHX", "portland trail blazers": "POR",
  "sacramento kings": "SAC", "san antonio spurs": "SAS", "toronto raptors": "TOR", "utah jazz": "UTA", "washington wizards": "WAS",
};

const TEAM_ESPN_IDS: Record<string, string> = {
  "ATL": "1", "BOS": "2", "BKN": "17", "CHA": "30", "CHI": "4",
  "CLE": "5", "DAL": "6", "DEN": "7", "DET": "8", "GS": "9", "GSW": "9",
  "HOU": "10", "IND": "11", "LAC": "12", "LAL": "13", "MEM": "29",
  "MIA": "14", "MIL": "15", "MIN": "16", "NO": "3", "NOP": "3", "NY": "18", "NYK": "18",
  "OKC": "25", "ORL": "19", "PHI": "20", "PHX": "21", "POR": "22",
  "SA": "24", "SAS": "24", "SAC": "23", "TOR": "28", "UTA": "26", "WAS": "27",
};

const ALL_TEAMS = Object.keys(TEAM_ABBREV).map(name => ({
  name: name.split(" ").map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(" "),
  abbrev: TEAM_ABBREV[name],
}));

async function fetchTeamStats(teamName: string) {
  const searchName = teamName.toLowerCase().replace(/[^a-z ]/g, "");
  const abbrev = TEAM_ABBREV[searchName];
  if (!abbrev) return null;

  const espnId = TEAM_ESPN_IDS[abbrev];
  let wins = 0, losses = 0, ppgScored = 0, ppgAllowed = 0;

  // ESPN team record
  if (espnId) {
    try {
      const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${espnId}`);
      if (res.ok) {
        const data = await res.json();
        const record = data.team?.record?.items?.[0]?.summary ?? "";
        if (record) { const p = record.split("-"); wins = parseInt(p[0]) || 0; losses = parseInt(p[1]) || 0; }
      }
    } catch (e) { /* skip */ }

    // ESPN stats
    try {
      const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${espnId}/statistics`);
      if (res.ok) {
        const data = await res.json();
        const statCategories = data.results?.stats?.categories ?? data.stats?.categories ?? [];
        for (const category of Array.isArray(statCategories) ? statCategories : []) {
          for (const stat of category.stats ?? []) {
            const sName = stat.name ?? "";
            const sVal = parseFloat(stat.value ?? stat.displayValue ?? "0") || 0;
            if (sName === "avgPoints") ppgScored = sVal;
          }
        }
      }
    } catch (e) { /* skip */ }
  }

  // BDL games data
  let l10Wins = 0, l10Losses = 0, homeWins = 0, homeLosses = 0, awayWins = 0, awayLosses = 0;
  let recentPPG = 0, pointDiff = 0, restDays = 1;
  const recentGames: { date: string; opponent: string; score: string; result: string }[] = [];
  let bdlTeamId: number | null = null;

  if (BALLDONTLIE_API_KEY) {
    try {
      // Get BDL team ID
      const teamsRes = await fetch("https://api.balldontlie.io/v1/teams", { headers: { "Authorization": BALLDONTLIE_API_KEY } });
      if (teamsRes.ok) {
        const teamsData = await teamsRes.json();
        for (const t of teamsData.data) {
          if (t.full_name.toLowerCase() === searchName) { bdlTeamId = t.id; break; }
        }
      }

      if (bdlTeamId) {
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        const gamesRes = await fetch(`https://api.balldontlie.io/v1/games?team_ids[]=${bdlTeamId}&seasons[]=2025&start_date=${thirtyDaysAgo}&per_page=25`, {
          headers: { "Authorization": BALLDONTLIE_API_KEY }
        });
        if (gamesRes.ok) {
          const gamesData = await gamesRes.json();
          const games = (gamesData.data || []).filter((g: any) => g.status === "Final");
          games.sort((a: any, b: any) => new Date(b.date).getTime() - new Date(a.date).getTime());

          if (games.length > 0) {
            restDays = Math.max(1, Math.round((Date.now() - new Date(games[0].date).getTime()) / (1000 * 60 * 60 * 24)));
          }

          for (const g of games.slice(0, 10)) {
            const isHome = g.home_team?.id === bdlTeamId;
            const ts = isHome ? g.home_team_score : g.visitor_team_score;
            const os = isHome ? g.visitor_team_score : g.home_team_score;
            if (ts > os) l10Wins++; else l10Losses++;
          }

          let l5Total = 0;
          for (const g of games.slice(0, 5)) {
            const isHome = g.home_team?.id === bdlTeamId;
            l5Total += isHome ? g.home_team_score : g.visitor_team_score;
          }
          recentPPG = games.length >= 5 ? l5Total / 5 : 0;

          let totalPD = 0;
          let totalOppScore = 0;
          for (const g of games) {
            const isHome = g.home_team?.id === bdlTeamId;
            const ts = isHome ? g.home_team_score : g.visitor_team_score;
            const os = isHome ? g.visitor_team_score : g.home_team_score;
            totalPD += (ts - os);
            totalOppScore += os;
            if (isHome) { if (ts > os) homeWins++; else homeLosses++; }
            else { if (ts > os) awayWins++; else awayLosses++; }

            const oppName = isHome ? g.visitor_team?.full_name : g.home_team?.full_name;
            recentGames.push({
              date: g.date,
              opponent: (isHome ? "vs " : "@ ") + (oppName || "Unknown"),
              score: ts + "-" + os,
              result: ts > os ? "W" : "L",
            });
          }
          pointDiff = games.length > 0 ? totalPD / games.length : 0;
          if (games.length > 0) ppgAllowed = totalOppScore / games.length;
        }
      }
    } catch (e) { /* skip */ }
  }

  return {
    team: teamName, abbrev, wins, losses, ppgScored, ppgAllowed,
    netRating: ppgScored - ppgAllowed,
    l10: { wins: l10Wins, losses: l10Losses },
    home: { wins: homeWins, losses: homeLosses },
    away: { wins: awayWins, losses: awayLosses },
    recentPPG, pointDiff, restDays,
    recentGames: recentGames.slice(0, 10),
    bdlTeamId,
  };
}

async function fetchH2H(teamId1: number, teamId2: number) {
  if (!BALLDONTLIE_API_KEY) return [];
  try {
    // D-273-FOLLOWUP-H2H (2026-05-20): BDL's team_ids[] uses OR semantics —
    // returns games where EITHER team played, not games where BOTH did.
    // Use per_page=100 to ensure we capture the season range, then filter
    // client-side for true H2H meetings.
    const res = await fetch(`https://api.balldontlie.io/v1/games?team_ids[]=${teamId1}&team_ids[]=${teamId2}&seasons[]=2025&per_page=100`, {
      headers: { "Authorization": BALLDONTLIE_API_KEY }
    });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.data || [])
      .filter((g: any) => g.status === "Final")
      .filter((g: any) => {
        // True H2H — both teams in this game.
        const homeId = g.home_team?.id;
        const awayId = g.visitor_team?.id;
        return (homeId === teamId1 && awayId === teamId2) || (homeId === teamId2 && awayId === teamId1);
      })
      .sort((a: any, b: any) => (b.date || "").localeCompare(a.date || ""))
      .map((g: any) => ({
        date: g.date,
        home: g.home_team?.full_name,
        away: g.visitor_team?.full_name,
        homeScore: g.home_team_score,
        awayScore: g.visitor_team_score,
      }));
  } catch (e) { return []; }
}

async function searchPlayers(query: string) {
  const url = "https://site.web.api.espn.com/apis/common/v3/search?query=" + encodeURIComponent(query) + "&limit=8&type=player&sport=basketball&league=nba";
  try {
    const res = await fetch(url);
    if (!res.ok) return [];
    const data = await res.json();
    const items = data.items ?? data.results ?? [];
    return items.map((item: any) => {
      const p = item.athlete ?? item;
      const teamRel = (p.teamRelationships ?? [])[0]?.core ?? {};
      return {
        id: p.id || "",
        name: p.displayName || "",
        team: teamRel.abbreviation ?? teamRel.shortDisplayName ?? "",
        position: p.jersey ? "#" + p.jersey : "",
        active: p.isActive ?? false,
      };
    }).filter((p: any) => p.id && p.name);
  } catch (e) { return []; }
}

async function fetchPlayerStats(playerName: string) {
  // Search ESPN for player
  const searchUrl = "https://site.web.api.espn.com/apis/common/v3/search?query=" + encodeURIComponent(playerName) + "&limit=5&type=player&sport=basketball&league=nba";
  const searchRes = await fetch(searchUrl);
  if (!searchRes.ok) return null;
  const searchData = await searchRes.json();
  const items = searchData.items ?? searchData.results ?? [];
  if (!items.length) return null;

  let player: any = null;
  for (const item of items) {
    const p = item.athlete ?? item;
    if (p.displayName?.toLowerCase() === playerName.toLowerCase()) { player = p; break; }
  }
  if (!player) player = items[0].athlete ?? items[0];
  if (!player?.id) return null;

  const playerId = player.id;
  const displayName = player.displayName || playerName;
  const team = player.teamShortName ?? player.team?.abbreviation ?? player.teamName ?? "";
  const position = player.position || "";

  // Fetch game log — same parsing as get-recommendations fetchGameLog
  const logUrl = "https://site.web.api.espn.com/apis/common/v3/sports/basketball/nba/athletes/" + playerId + "/gamelog";
  const logRes = await fetch(logUrl);
  const games: any[] = [];

  if (logRes.ok) {
    const data = await logRes.json();
    const labels: string[] = data.labels ?? data.names ?? [];
    const eventsObj = data.events ?? {};
    const seasonTypes = data.seasonTypes ?? [];

    for (const seasonType of seasonTypes.slice(0, 1)) { // Regular season only, skip preseason
      for (const category of seasonType.categories ?? []) {
        const catLabels: string[] = category.labels ?? labels;
        for (const catEvent of category.events ?? []) {
          const eventId = catEvent.eventId ?? catEvent.id;
          const eventInfo = eventsObj[eventId] ?? {};
          const statsValues: string[] = catEvent.stats ?? [];
          const statsMap: Record<string, number> = {};

          catLabels.forEach((label: string, i: number) => {
            if (i < statsValues.length) {
              const rawVal = String(statsValues[i]);
              const numMatch = rawVal.match(/^[\d.]+/);
              if (numMatch) {
                const val = parseFloat(numMatch[0]);
                if (!isNaN(val)) statsMap[label.toUpperCase()] = val;
              }
            }
          });

          if (Object.keys(statsMap).length > 0) {
            games.push({
              date: eventInfo.gameDate ?? "",
              opponent: (eventInfo.atVs === "@" ? "@ " : "vs ") + (eventInfo.opponent?.displayName ?? eventInfo.opponent?.abbreviation ?? ""),
              result: eventInfo.gameResult ?? "",
              score: eventInfo.score ?? "",
              pts: statsMap["PTS"] ?? 0,
              reb: statsMap["REB"] ?? 0,
              ast: statsMap["AST"] ?? 0,
              stl: statsMap["STL"] ?? 0,
              blk: statsMap["BLK"] ?? 0,
              min: statsMap["MIN"] ?? 0,
              threes: statsMap["3PM"] ?? 0,
              to: statsMap["TO"] ?? 0,
              fgm: statsMap["FGM"] ?? 0,
              fga: statsMap["FGA"] ?? 0,
            });
          }
        }
      }
    }
  }

  // Calculate averages
  const avg = (arr: any[], key: string) => arr.length ? arr.reduce((s: number, g: any) => s + (g[key] ?? 0), 0) / arr.length : 0;
  const l5 = games.slice(0, 5);
  const l10 = games.slice(0, 10);
  const all = games;

  return {
    name: displayName, team, position, playerId,
    totalGames: games.length,
    seasonAvg: { ppg: avg(all, "pts"), rpg: avg(all, "reb"), apg: avg(all, "ast"), spg: avg(all, "stl"), bpg: avg(all, "blk"), mpg: avg(all, "min"), topg: avg(all, "to"), threes: avg(all, "threes") },
    l5Avg: { ppg: avg(l5, "pts"), rpg: avg(l5, "reb"), apg: avg(l5, "ast"), spg: avg(l5, "stl"), bpg: avg(l5, "blk"), mpg: avg(l5, "min") },
    l10Avg: { ppg: avg(l10, "pts"), rpg: avg(l10, "reb"), apg: avg(l10, "ast"), spg: avg(l10, "stl"), bpg: avg(l10, "blk"), mpg: avg(l10, "min") },
    recentGames: games.slice(0, 15),
  };
}

async function fetchPlayerVsTeamBDL(playerName: string, teamName: string) {
  if (!BALLDONTLIE_API_KEY) return null;
  try {
    // Search BDL for player — try full name, then last name
    let players: any[] = [];
    const searchRes = await fetch("https://api.balldontlie.io/v1/players?search=" + encodeURIComponent(playerName) + "&per_page=5", { headers: { "Authorization": BALLDONTLIE_API_KEY } });
    if (searchRes.ok) {
      const searchData = await searchRes.json();
      players = searchData.data || [];
    }
    // Fallback: search by last name only
    if (players.length === 0 && playerName.includes(" ")) {
      const lastName = playerName.split(" ").pop() || "";
      const res2 = await fetch("https://api.balldontlie.io/v1/players?search=" + encodeURIComponent(lastName) + "&per_page=10", { headers: { "Authorization": BALLDONTLIE_API_KEY } });
      if (res2.ok) {
        const d2 = await res2.json();
        players = d2.data || [];
      }
    }
    const player = players.find((p: any) => (p.first_name + " " + p.last_name).toLowerCase() === playerName.toLowerCase()) || players[0];
    if (!player) return null;

    // Get team ID
    const teamSearchName = teamName.toLowerCase().replace(/[^a-z ]/g, "");
    const teamsRes = await fetch("https://api.balldontlie.io/v1/teams", { headers: { "Authorization": BALLDONTLIE_API_KEY } });
    if (!teamsRes.ok) return null;
    const teamsData = await teamsRes.json();
    let teamId: number | null = null;
    for (const t of teamsData.data || []) {
      if (t.full_name.toLowerCase() === teamSearchName) { teamId = t.id; break; }
    }
    if (!teamId) return null;

    // Get all player game stats this season
    const statsUrl = "https://api.balldontlie.io/v1/stats?player_ids[]=" + player.id + "&seasons[]=2025&per_page=100";
    const statsRes = await fetch(statsUrl, { headers: { "Authorization": BALLDONTLIE_API_KEY } });
    if (!statsRes.ok) return null;
    const statsData = await statsRes.json();
    const allGames = statsData.data || [];

    // Filter to games vs this team
    const vsGames = allGames.filter((g: any) => {
      const game = g.game || {};
      return game.home_team_id === teamId || game.visitor_team_id === teamId;
    });

    return {
      playerName: player.first_name + " " + player.last_name,
      teamName,
      totalSeasonGames: allGames.length,
      vsGames: vsGames.filter((g: any) => (parseInt(g.min || "0") || 0) > 0 || (g.pts || 0) > 0).map((g: any) => ({
        date: g.game?.date ?? "",
        pts: g.pts ?? 0,
        reb: g.reb ?? 0,
        ast: g.ast ?? 0,
        stl: g.stl ?? 0,
        blk: g.blk ?? 0,
        min: parseInt(g.min) || 0,
        fgm: g.fgm ?? 0,
        fga: g.fga ?? 0,
        fg3m: g.fg3m ?? 0,
        to: g.turnover ?? 0,
        homeTeam: g.game?.home_team?.full_name ?? "",
        awayTeam: g.game?.visitor_team?.full_name ?? "",
        homeScore: g.game?.home_team_score ?? 0,
        awayScore: g.game?.visitor_team_score ?? 0,
      })),
    };
  } catch (e) { console.log("[bdl-vs] Error: " + e); return null; }
}

// D-273-FOLLOWUP-H2H (2026-05-20): lightweight resolver — names → BDL IDs
// without full fetchTeamStats (saves 4-6 API calls per pair).
async function resolveBdlTeamId(teamName: string): Promise<number | null> {
  if (!BALLDONTLIE_API_KEY) return null;
  const searchName = teamName.toLowerCase().replace(/[^a-z ]/g, "");
  try {
    const teamsRes = await fetch("https://api.balldontlie.io/v1/teams", { headers: { "Authorization": BALLDONTLIE_API_KEY } });
    if (!teamsRes.ok) return null;
    const teamsData = await teamsRes.json();
    for (const t of teamsData.data) {
      if (t.full_name.toLowerCase() === searchName) return t.id;
    }
  } catch (_e) { /* fall through */ }
  return null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json();
    const team1 = body.team1 || "";
    const team2 = body.team2 || "";

    const playerName = body.player || "";
    const playerQuery = body.playerQuery || "";

    // D-273-FOLLOWUP-H2H: lightweight H2H-only mode for Games.tsx widget.
    // Skips the full fetchTeamStats path (records/ppg/recent games) and
    // just resolves BDL IDs + returns the real-schedule H2H. Used per
    // game card so heavy stats payload isn't needed.
    if (body.h2hOnly === true && team1 && team2) {
      const [id1, id2] = await Promise.all([resolveBdlTeamId(team1), resolveBdlTeamId(team2)]);
      if (!id1 || !id2) {
        return new Response(JSON.stringify({ success: true, h2h: [], note: "team_id_resolve_failed" }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const h2h = await fetchH2H(id1, id2);
      return new Response(JSON.stringify({ success: true, h2h, team1Id: id1, team2Id: id2 }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Autocomplete search mode
    if (playerQuery) {
      const suggestions = await searchPlayers(playerQuery);
      return new Response(JSON.stringify({ success: true, suggestions }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Player vs Team mode (BDL data — complete game log)
    const vsTeam = body.vsTeam || "";
    if (playerName && vsTeam) {
      const vsData = await fetchPlayerVsTeamBDL(playerName, vsTeam);
      const playerStats = await fetchPlayerStats(playerName);
      return new Response(JSON.stringify({ success: true, vs: vsData, player: playerStats }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Player lookup mode
    if (playerName) {
      const playerStats = await fetchPlayerStats(playerName);
      if (!playerStats) {
        return new Response(JSON.stringify({ error: "Player not found: " + playerName }), {
          status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ success: true, player: playerStats }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!team1 && !team2) {
      return new Response(JSON.stringify({ teams: ALL_TEAMS }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const result: any = {};

    if (team1) {
      result.team1 = await fetchTeamStats(team1);
    }
    if (team2) {
      result.team2 = await fetchTeamStats(team2);
    }
    if (result.team1?.bdlTeamId && result.team2?.bdlTeamId) {
      result.h2h = await fetchH2H(result.team1.bdlTeamId, result.team2.bdlTeamId);
    }

    return new Response(JSON.stringify({ success: true, ...result }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
