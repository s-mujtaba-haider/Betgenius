import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  // D-155 (May 14, 2026, CEO §19.3): scoring math moved to _shared/scoring.ts.
  // Single source of truth shared with process-games. Closes D-148 v2 Finding #1
  // (Evaluator/Dashboard divergence). Closes D-152 sister-bug atomically — the
  // 4 confidence.score read sites (L1680/L1718/L1791/L1831 pre-refactor) now
  // implicitly read post-everything finalScore via scoreOneSide return.
  type ScoringWeights, type ScoreOneSideHelpers,
  type ExtractedProp, type GameLogEntry, type PlayerResult, type MinutesTrend,
  type AbsenceInfo, type OpponentStats, type PropAnalysisResult, type CachedPlayerData,
  type BdlInjury,
  loadWeightsFromDB,
  calcHitRates, calculateMinutesTrend, detectRecentAbsence,
  calculatePaceDefenseScores, getScoreLabel, getPlayerInjuryStatus,
  calculateConfidenceScore, scoreOneSide,
} from "../_shared/scoring.ts";
// D-489 STAGE 4 — final caller migration to the unified pick_history writer.
// Both cron writers (process-games + process-games-mlb) have been on this
// helper since D-487 / D-488; analyze-pick (UI on-demand single-pick) is
// the last writer. After this batch, ALL 3 writers route through the
// hour-0 client-side validation path. See d486_write_path_design.md.
import {
  writePickHistory as canonicalWritePickHistory,
  type PickHistoryPayload,
} from "../_shared/pick_history_writer.ts";

console.log("[analyze-pick] Module loading...");

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

// Team abbreviation map for ESPN injury endpoint
const TEAM_ABBREV: Record<string, string> = {
  "atlanta hawks": "ATL", "boston celtics": "BOS", "brooklyn nets": "BKN",
  "charlotte hornets": "CHA", "chicago bulls": "CHI", "cleveland cavaliers": "CLE",
  "dallas mavericks": "DAL", "denver nuggets": "DEN", "detroit pistons": "DET",
  "golden state warriors": "GSW", "houston rockets": "HOU", "indiana pacers": "IND",
  "los angeles clippers": "LAC", "los angeles lakers": "LAL", "memphis grizzlies": "MEM",
  "miami heat": "MIA", "milwaukee bucks": "MIL", "minnesota timberwolves": "MIN",
  "new orleans pelicans": "NOP", "new york knicks": "NYK", "oklahoma city thunder": "OKC",
  "orlando magic": "ORL", "philadelphia 76ers": "PHI", "phoenix suns": "PHX",
  "portland trail blazers": "POR", "sacramento kings": "SAC", "san antonio spurs": "SAS",
  "toronto raptors": "TOR", "utah jazz": "UTA", "washington wizards": "WAS"
};

// --- ESPN player search & game log ---



function getSportPath(sport: string): string {
  if (sport === "basketball") return "basketball/nba";
  if (sport === "football") return "football/nfl";
  if (sport === "baseball") return "baseball/mlb";
  if (sport === "hockey") return "hockey/nhl";
  return `${sport}/${sport}`;
}

// Fetch with full debug logging
async function debugFetch(label: string, url: string): Promise<{ ok: boolean; status: number; text: string }> {
  console.log(`\n[${label}] >>> Fetching: ${url}`);
  try {
    const res = await fetch(url);
    const text = await res.text();
    console.log(`[${label}] <<< Status: ${res.status}`);
    console.log(`[${label}] <<< Body (${text.length} chars, first 2000):\n${text.slice(0, 2000)}`);
    return { ok: res.ok, status: res.status, text };
  } catch (err) {
    console.log(`[${label}] !!! Fetch error: ${err}`);
    return { ok: false, status: 0, text: "" };
  }
}

// Name matching: case-insensitive, returns true if names match
function namesMatch(query: string, candidate: string): boolean {
  const q = query.toLowerCase().trim();
  const c = candidate.toLowerCase().trim();
  if (c === q) return true;
  if (c.includes(q) || q.includes(c)) return true;
  // Check all query words appear in candidate
  const qWords = q.split(/\s+/);
  return qWords.length > 1 && qWords.every(w => c.includes(w));
}

// Fetch full athlete profile to get team info
async function fetchAthleteProfile(playerId: string, sport: string): Promise<{ team: string; position: string }> {
  const sportPath = getSportPath(sport);
  const url = `https://site.web.api.espn.com/apis/common/v3/sports/${sportPath}/athletes/${playerId}`;
  const { ok, text } = await debugFetch("athlete-profile", url);
  if (!ok || !text) return { team: "", position: "" };

  try {
    const data = JSON.parse(text);
    const athlete = data?.athlete ?? data;
    const team = athlete?.team?.displayName ?? athlete?.team?.name ?? "";
    const position = athlete?.position?.displayName ?? athlete?.position?.abbreviation ?? "";
    console.log(`[athlete-profile] Team: "${team}", Position: "${position}"`);
    return { team, position };
  } catch (e) {
    console.log(`[athlete-profile] Parse error: ${e}`);
    return { team: "", position: "" };
  }
}

async function searchPlayer(name: string, sport: string): Promise<PlayerResult | null> {
  const sportPath = getSportPath(sport);

  // === Attempt 1: site.web search with type=player ===
  {
    const url = `https://site.web.api.espn.com/apis/common/v3/search?query=${encodeURIComponent(name)}&limit=5&mode=prefix&type=player`;
    const { ok, text } = await debugFetch("search-attempt-1", url);
    if (ok && text) {
      try {
        const data = JSON.parse(text);

        // Flat format: { items: [{ id, displayName, ... }] }
        if (Array.isArray(data?.items)) {
          for (const item of data.items) {
            const entryName = item?.displayName ?? item?.title ?? item?.name ?? "";
            const athleteId = item?.id;
            console.log(`[search-attempt-1] Checking item: "${entryName}" (id=${athleteId})`);
            if (athleteId && namesMatch(name, entryName)) {
              let team = item?.team?.displayName ?? item?.description ?? "";
              let position = item?.position ?? "";
              // Fetch full profile if team is empty
              if (!team) {
                const profile = await fetchAthleteProfile(String(athleteId), sport);
                team = profile.team;
                position = profile.position || position;
              }
              const result = {
                id: String(athleteId),
                displayName: entryName,
                team,
                position,
              };
              console.log(`[search-attempt-1] MATCH: ${result.displayName} (id=${result.id}, team=${result.team})`);
              return result;
            }
          }
        }

        // Nested format: { results: [{ contents: [...] }] }
        const sections = data?.results ?? [];
        for (const section of Array.isArray(sections) ? sections : []) {
          const entries = section?.contents ?? section?.items ?? [];
          for (const entry of Array.isArray(entries) ? entries : []) {
            const entryName = entry?.displayName ?? entry?.title ?? entry?.name ?? "";
            const athleteId = entry?.id ??
              entry?.uid?.match?.(/athletes:(\d+)/)?.[1] ??
              entry?.link?.match?.(/id\/(\d+)/)?.[1];
            if (athleteId && namesMatch(name, entryName)) {
              let team = entry?.team?.displayName ?? entry?.description ?? "";
              let position = entry?.position ?? "";
              if (!team) {
                const profile = await fetchAthleteProfile(String(athleteId), sport);
                team = profile.team;
                position = profile.position || position;
              }
              const result = {
                id: String(athleteId),
                displayName: entryName,
                team,
                position,
              };
              console.log(`[search-attempt-1] MATCH (nested): ${result.displayName} (id=${result.id}, team=${result.team})`);
              return result;
            }
          }
        }

        console.log("[search-attempt-1] No matching athlete in response");
      } catch (e) {
        console.log(`[search-attempt-1] JSON parse error: ${e}`);
      }
    }
  }

  // === Attempt 2: site API v2 athletes endpoint ===
  {
    const url = `https://site.api.espn.com/apis/site/v2/sports/${sportPath}/athletes?search=${encodeURIComponent(name)}`;
    const { ok, text } = await debugFetch("search-attempt-2", url);
    if (ok && text) {
      try {
        const data = JSON.parse(text);
        // This endpoint returns { athletes: [{ id, displayName, ... }] } or similar
        const athletes = data?.athletes ?? data?.items ?? [];
        for (const athlete of Array.isArray(athletes) ? athletes : []) {
          const aName = athlete?.displayName ?? athlete?.fullName ?? athlete?.name ?? "";
          const aId = athlete?.id ?? athlete?.uid?.match?.(/(\d+)/)?.[1];
          if (aId && namesMatch(name, aName)) {
            let team = athlete?.team?.displayName ?? athlete?.team?.name ?? "";
            let position = athlete?.position?.displayName ?? athlete?.position?.abbreviation ?? "";
            if (!team) {
              const profile = await fetchAthleteProfile(String(aId), sport);
              team = profile.team;
              position = profile.position || position;
            }
            const result = {
              id: String(aId),
              displayName: aName,
              team,
              position,
            };
            console.log(`[search-attempt-2] MATCH: ${result.displayName} (id=${result.id}, team=${result.team})`);
            return result;
          }
        }
        // Also try if response is an array directly
        if (Array.isArray(data)) {
          for (const athlete of data) {
            const aName = athlete?.displayName ?? athlete?.fullName ?? "";
            const aId = athlete?.id;
            if (aId && namesMatch(name, aName)) {
              const profile = await fetchAthleteProfile(String(aId), sport);
              console.log(`[search-attempt-2] MATCH from array: ${aName} (id=${aId}, team=${profile.team})`);
              return { id: String(aId), displayName: aName, team: profile.team, position: profile.position };
            }
          }
        }
        console.log("[search-attempt-2] No matching athlete in response");
      } catch (e) {
        console.log(`[search-attempt-2] JSON parse error: ${e}`);
      }
    }
  }

  // === Attempt 3: core API with $ref resolution ===
  {
    const parts = sportPath.split("/");
    const url = `https://sports.core.api.espn.com/v2/sports/${parts[0]}/leagues/${parts[1]}/athletes?limit=10&search=${encodeURIComponent(name)}`;
    const { ok, text } = await debugFetch("search-attempt-3", url);
    if (ok && text) {
      try {
        const data = JSON.parse(text);
        const items = data?.items ?? [];
        // Collect $ref URLs
        const refs: string[] = [];
        for (const item of Array.isArray(items) ? items : []) {
          const ref = item?.$ref;
          if (typeof ref === "string" && ref.includes("athletes/")) {
            refs.push(ref);
          }
        }
        console.log(`[search-attempt-3] Found ${refs.length} athlete refs, resolving top 5...`);

        // Resolve each ref and match by name
        for (const ref of refs.slice(0, 5)) {
          const { ok: refOk, text: refText } = await debugFetch("resolve-ref", ref);
          if (!refOk || !refText) continue;
          try {
            const athlete = JSON.parse(refText);
            const aName = athlete?.displayName ?? athlete?.fullName ?? athlete?.shortName ?? "";
            const aId = athlete?.id ?? ref.match(/athletes\/(\d+)/)?.[1];
            console.log(`[resolve-ref] Candidate: "${aName}" (id=${aId})`);
            if (aId && namesMatch(name, aName)) {
              let team = athlete?.team?.displayName ?? athlete?.team?.name ?? "";
              let position = athlete?.position?.displayName ?? athlete?.position?.abbreviation ?? "";
              if (!team) {
                const profile = await fetchAthleteProfile(String(aId), sport);
                team = profile.team;
                position = profile.position || position;
              }
              const result = {
                id: String(aId),
                displayName: aName,
                team,
                position,
              };
              console.log(`[search-attempt-3] MATCH: ${result.displayName} (id=${result.id}, team=${result.team})`);
              return result;
            }
          } catch {
            continue;
          }
        }
        console.log("[search-attempt-3] No matching athlete after resolving refs");
      } catch (e) {
        console.log(`[search-attempt-3] JSON parse error: ${e}`);
      }
    }
  }

  console.log(`\n[searchPlayer] ALL ATTEMPTS FAILED for "${name}"`);
  return null;
}

// D-179 (May 15-16, 2026): cache-first read helpers. analyze-pick is invoked
// per-Evaluator-query (single pick at a time), so ESPN/BDL latency dominates
// response time. cache_player_game_logs + cache_opponent_defensive_stats are
// populated by process-games' nightly cron — if today's data exists, we skip
// the live fetch entirely.

interface CachePlayerGameLogRow {
  player_id: string; player_name: string; game_date: string;
  opponent: string | null; is_home: boolean | null;
  minutes: number | null; points: number | null; rebounds: number | null;
  assists: number | null; threes: number | null; steals: number | null;
  blocks: number | null; turnovers: number | null;
  result: string | null; fetched_at: string; sport: string | null;
}

// Returns GameLogEntry[] in the SAME shape that fetchGameLog returns —
// scoring.ts uses `g.stats["MIN"|"PTS"|"REB"|"AST"|"3PM"|"STL"|"BLK"|"TO"]`.
async function readPlayerGameLogFromCache(
  playerName: string, sport: string,
): Promise<GameLogEntry[] | null> {
  try {
    const SUPA_URL = Deno.env.get("SUPABASE_URL") ?? "";
    const SUPA_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    if (!SUPA_URL || !SUPA_KEY) return null;
    const sportFilter = sport === "basketball" ? "nba" : sport;
    const url = `${SUPA_URL}/rest/v1/cache_player_game_logs?` +
      `player_name=ilike.${encodeURIComponent(playerName)}` +
      `&sport=eq.${encodeURIComponent(sportFilter)}` +
      `&order=game_date.desc&limit=30` +
      `&select=player_id,player_name,game_date,opponent,is_home,minutes,points,rebounds,assists,threes,steals,blocks,turnovers,fetched_at`;
    const res = await fetch(url, {
      headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` },
    });
    if (!res.ok) return null;
    const rows = await res.json() as CachePlayerGameLogRow[];
    if (!Array.isArray(rows) || rows.length < 10) {
      console.log(`[d179-cache] player game log cache: ${rows?.length ?? 0} rows for ${playerName} (need >=10 for hit)`);
      return null;
    }
    // Transform cache row → GameLogEntry shape (matches what fetchGameLog returns).
    const entries: GameLogEntry[] = rows.map((r) => ({
      date: r.game_date ?? "",
      opponent: r.opponent ?? "",
      homeAway: r.is_home === true ? "home" : r.is_home === false ? "away" : "",
      stats: {
        MIN: r.minutes ?? 0,
        PTS: r.points ?? 0,
        REB: r.rebounds ?? 0,
        AST: r.assists ?? 0,
        "3PM": r.threes ?? 0,
        STL: r.steals ?? 0,
        BLK: r.blocks ?? 0,
        TO: r.turnovers ?? 0,
      },
    }));
    console.log(`[d179-cache] HIT player game log: ${entries.length} rows for ${playerName}`);
    return entries;
  } catch (e) {
    console.log(`[d179-cache] readPlayerGameLogFromCache error: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

async function readOpponentStatsFromCache(
  teamName: string, sport: string,
): Promise<OpponentStats | null> {
  try {
    const SUPA_URL = Deno.env.get("SUPABASE_URL") ?? "";
    const SUPA_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    if (!SUPA_URL || !SUPA_KEY || !teamName) return null;
    const sportFilter = sport === "basketball" ? "nba" : sport;
    const url = `${SUPA_URL}/rest/v1/cache_opponent_defensive_stats?` +
      `team_name=eq.${encodeURIComponent(teamName)}` +
      `&sport=eq.${encodeURIComponent(sportFilter)}` +
      `&order=snapshot_date.desc&limit=1` +
      `&select=ppg_allowed,rpg_allowed,apg_allowed,spg_allowed,bpg_allowed,threes_allowed,fg_pct_allowed,three_pct_allowed,pace,net_rating,def_rating,rpg_allowed_bdl,apg_allowed_bdl,snapshot_date`;
    const res = await fetch(url, {
      headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` },
    });
    if (!res.ok) return null;
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) {
      console.log(`[d179-cache] opp stats MISS for ${teamName}`);
      return null;
    }
    const r = rows[0];
    const stats: OpponentStats = {
      pointsAllowedPerGame: Number(r.ppg_allowed ?? 0),
      reboundsAllowedPerGame: Number(r.rpg_allowed_bdl ?? r.rpg_allowed ?? 0),
      assistsAllowedPerGame: Number(r.apg_allowed_bdl ?? r.apg_allowed ?? 0),
      oppFieldGoalPct: Number(r.fg_pct_allowed ?? 0),
      oppThreePointPct: Number(r.three_pct_allowed ?? 0),
      pace: Number(r.pace ?? 0),
      defensiveRating: Number(r.def_rating ?? r.net_rating ?? 0),
      defenseRank: "—",
      // oppOwn* fields are not in cache — leave as 0 (graceful degradation).
      oppOwnTurnovers: 0, oppOwnSteals: 0, oppOwnBlocks: 0,
      oppOwnTwoPtFGPct: 0, oppOwnThreePtFGPct: 0, oppOwnFGPct: 0,
      oppPaceFactor: 0,
    };
    // D-186: enrich with per-opp-position GOAT advanced lookups. Two reads:
    // (1) cache_team_metadata to map team_name → abbreviation, (2) cache_team_
    // advanced_stats_by_position filtered to that abbreviation. Both reads
    // gracefully no-op if rows missing (pre-D-186 behavior).
    try {
      const tmUrl = `${SUPA_URL}/rest/v1/cache_team_metadata?team_name=eq.${encodeURIComponent(teamName)}&sport=eq.${encodeURIComponent(sportFilter)}&select=abbreviation&limit=1`;
      const tmRes = await fetch(tmUrl, { headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` } });
      const tmRows = tmRes.ok ? await tmRes.json() : [];
      const abbr = Array.isArray(tmRows) && tmRows[0]?.abbreviation;
      if (abbr) {
        const posUrl = `${SUPA_URL}/rest/v1/cache_team_advanced_stats_by_position?` +
          `team_abbr=eq.${encodeURIComponent(abbr)}&sport=eq.${encodeURIComponent(sportFilter)}` +
          `&snapshot_date=eq.${encodeURIComponent(r.snapshot_date)}` +
          `&select=position,defensive_rating,defensive_rebound_percentage,assist_percentage`;
        const posRes = await fetch(posUrl, { headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` } });
        if (posRes.ok) {
          const posRows = await posRes.json();
          if (Array.isArray(posRows) && posRows.length > 0) {
            const dr: Record<string, number> = {};
            const drb: Record<string, number> = {};
            const ast: Record<string, number> = {};
            for (const p of posRows) {
              if (p.defensive_rating != null) dr[p.position] = Number(p.defensive_rating);
              if (p.defensive_rebound_percentage != null) drb[p.position] = Number(p.defensive_rebound_percentage);
              if (p.assist_percentage != null) ast[p.position] = Number(p.assist_percentage);
            }
            if (Object.keys(dr).length) stats.defensiveRatingVsPosition = dr;
            if (Object.keys(drb).length) stats.defensiveReboundPctVsPosition = drb;
            if (Object.keys(ast).length) stats.assistPctVsPosition = ast;
            console.log(`[d186-cache] HIT by-position for ${abbr}: ${posRows.length} pos rows`);
          }
        }
      }
    } catch (_e) { /* graceful degradation */ }
    console.log(`[d179-cache] HIT opp stats for ${teamName} (snapshot ${r.snapshot_date})`);
    return stats;
  } catch (e) {
    console.log(`[d179-cache] readOpponentStatsFromCache error: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

async function readTeamMetadataFromCache(
  teamName: string, sport: string,
): Promise<{ teamId: string | null } | null> {
  try {
    const SUPA_URL = Deno.env.get("SUPABASE_URL") ?? "";
    const SUPA_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    if (!SUPA_URL || !SUPA_KEY || !teamName) return null;
    const sportFilter = sport === "basketball" ? "nba" : sport;
    const url = `${SUPA_URL}/rest/v1/cache_team_metadata?` +
      `team_name=eq.${encodeURIComponent(teamName)}` +
      `&sport=eq.${encodeURIComponent(sportFilter)}` +
      `&limit=1&select=team_name,espn_id,bdl_id`;
    const res = await fetch(url, {
      headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` },
    });
    if (!res.ok) return null;
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const r = rows[0];
    console.log(`[d179-cache] HIT team metadata for ${teamName}`);
    return { teamId: r.espn_id ?? null };
  } catch (e) {
    console.log(`[d179-cache] readTeamMetadataFromCache error: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

async function fetchGameLog(playerId: string, sport: string): Promise<GameLogEntry[]> {
  const sportPath = getSportPath(sport);
  const url = `https://site.web.api.espn.com/apis/common/v3/sports/${sportPath}/athletes/${playerId}/gamelog`;
  const { ok, text } = await debugFetch("gamelog", url);
  if (!ok || !text) return [];

  try {
    const data = JSON.parse(text);
    const entries: GameLogEntry[] = [];

    console.log(`[gamelog] Top-level keys: ${Object.keys(data).join(", ")}`);

    // ESPN gamelog structure:
    // - data.labels = stat display names (["MIN","FG","FG%",...,"PTS"])
    // - data.names = stat key names
    // - data.events = { eventId: { gameDate, opponent, homeAway, ... } } - metadata ONLY
    // - data.seasonTypes[].categories[].events[] = where stats arrays live
    //   Each event has { eventId, stats: ["35","10-22",...] } mapping to labels by index

    const labels: string[] = data?.labels ?? [];
    const names: string[] = data?.names ?? [];
    const eventsObj = data?.events ?? {};
    const seasonTypes = data?.seasonTypes ?? [];

    console.log(`[gamelog] labels (${labels.length}): ${labels.join(", ")}`);
    console.log(`[gamelog] names (${names.length}): ${names.join(", ")}`);
    console.log(`[gamelog] events metadata count: ${Object.keys(eventsObj).length}`);
    console.log(`[gamelog] seasonTypes count: ${seasonTypes.length}`);

    const statKeys = labels.length ? labels : names;

    if (!statKeys.length) {
      console.log("[gamelog] No labels or names found");
      return [];
    }

    // Extract stats from seasonTypes[].categories[].events[]
    let statsEventCount = 0;
    for (const seasonType of seasonTypes) {
      const categories = seasonType?.categories ?? [];
      for (const category of categories) {
        const catEvents = category?.events ?? [];
        const catLabels: string[] = category?.labels ?? statKeys;

        for (const catEvent of catEvents) {
          const eventId = catEvent?.eventId ?? catEvent?.id;
          const eventInfo = eventsObj[eventId] ?? {};
          const statsValues: string[] = catEvent?.stats ?? [];

          const statsMap: Record<string, number> = {};
          catLabels.forEach((label: string, i: number) => {
            if (i < statsValues.length) {
              // Stats can be strings like "35" or "10-22" - parse the first number
              const rawVal = String(statsValues[i]);
              const numMatch = rawVal.match(/^[\d.]+/);
              if (numMatch) {
                const val = parseFloat(numMatch[0]);
                if (!isNaN(val)) statsMap[label] = val;
              }
            }
          });

          if (Object.keys(statsMap).length > 0) {
            entries.push({
              date: eventInfo.gameDate ?? "",
              opponent: eventInfo.opponent?.displayName ?? eventInfo.opponent?.abbreviation ?? "",
              // §19.3 May 12 fix — see process-games:859 for full rationale.
              // ESPN uses `atVs`, not `homeAway`.
              homeAway: eventInfo.atVs === "vs" ? "home" : eventInfo.atVs === "@" ? "away" : "",
              stats: statsMap,
            });
            statsEventCount++;
          }
        }
      }
    }

    console.log(`[gamelog] Found ${statsEventCount} events with stats across seasonTypes`);

    // Fallback: if no seasonTypes, try legacy categories at top level
    if (entries.length === 0) {
      const categories = data?.categories ?? [];
      if (categories.length > 0) {
        console.log("[gamelog] Fallback: trying top-level categories");
        for (const category of categories) {
          const catEvents = category?.events ?? [];
          const catLabels: string[] = category?.labels ?? statKeys;

          for (const catEvent of catEvents) {
            const eventId = catEvent?.eventId ?? catEvent?.id;
            const eventInfo = eventsObj[eventId] ?? {};
            const statsValues: string[] = catEvent?.stats ?? [];

            const statsMap: Record<string, number> = {};
            catLabels.forEach((label: string, i: number) => {
              if (i < statsValues.length) {
                const rawVal = String(statsValues[i]);
                const numMatch = rawVal.match(/^[\d.]+/);
                if (numMatch) {
                  const val = parseFloat(numMatch[0]);
                  if (!isNaN(val)) statsMap[label] = val;
                }
              }
            });

            if (Object.keys(statsMap).length > 0) {
              entries.push({
                date: eventInfo.gameDate ?? "",
                opponent: eventInfo.opponent?.displayName ?? eventInfo.opponent?.abbreviation ?? "",
                // §19.3 May 12 fix — see process-games:859 for full rationale.
                homeAway: eventInfo.atVs === "vs" ? "home" : eventInfo.atVs === "@" ? "away" : "",
                stats: statsMap,
              });
            }
          }
        }
      }
    }

    console.log(`[gamelog] Parsed ${entries.length} game entries total`);
    if (entries.length > 0) {
      console.log(`[gamelog] First entry stats: ${JSON.stringify(entries[0].stats)}`);
      console.log(`[gamelog] Available stat keys: ${Object.keys(entries[0].stats).join(", ")}`);
    }

    return entries;
  } catch (e) {
    console.log(`[gamelog] Parse error: ${e}`);
    return [];
  }
}

// --- Prop type to ESPN stat label mapping ---



// --- Hit rate calculation ---

// Check if a game is a DNP (Did Not Play) - 0 minutes or missing minutes data


// --- Fetch today's NBA schedule to get game context ---

interface GameContext {
  opponent: string;
  opponentTeamId: string;
  gameTime: string;
  isHome: boolean;
  gameId?: string;
}

// --- Back-to-Back Detection ---

interface BackToBackResult {
  isBackToBack: boolean;
  restDays: number;
}

async function checkBackToBack(teamName: string, sport: string): Promise<BackToBackResult> {
  if (sport !== "basketball") {
    return { isBackToBack: false, restDays: 1 };
  }

  try {
    // Get yesterday's date
    const now = new Date();
    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const yesterdayStr = yesterday.toISOString().slice(0, 10).replace(/-/g, '');

    const url = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${yesterdayStr}`;
    console.log(`[b2b] Fetching yesterday's schedule (${yesterdayStr}) to check back-to-back...`);
    const { ok, text } = await debugFetch("b2b-check", url);

    if (!ok || !text) {
      console.log(`[b2b] Failed to fetch yesterday's schedule, defaulting to no B2B`);
      return { isBackToBack: false, restDays: 1 };
    }

    const data = JSON.parse(text);
    const events = data?.events ?? [];
    const normalizedTeam = teamName.toLowerCase().trim();

    for (const event of events) {
      const competitions = event?.competitions ?? [];
      for (const comp of competitions) {
        const competitors = comp?.competitors ?? [];
        for (const competitor of competitors) {
          const teamDisplayName = (competitor?.team?.displayName ?? "").toLowerCase();
          const teamAbbrev = (competitor?.team?.abbreviation ?? "").toLowerCase();

          if (teamDisplayName.includes(normalizedTeam) || normalizedTeam.includes(teamDisplayName) ||
              teamAbbrev === normalizedTeam || normalizedTeam.includes(teamAbbrev)) {
            console.log(`[b2b] Back-to-back detected for ${teamName} - played yesterday`);
            return { isBackToBack: true, restDays: 0 };
          }
        }
      }
    }

    // If not B2B, check 2 days ago for rest calculation
    const twoDaysAgo = new Date(now);
    twoDaysAgo.setDate(twoDaysAgo.getDate() - 2);
    const twoDaysAgoStr = twoDaysAgo.toISOString().slice(0, 10).replace(/-/g, '');

    const url2 = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${twoDaysAgoStr}`;
    const { ok: ok2, text: text2 } = await debugFetch("rest-check", url2);

    if (ok2 && text2) {
      const data2 = JSON.parse(text2);
      const events2 = data2?.events ?? [];

      for (const event of events2) {
        const competitions = event?.competitions ?? [];
        for (const comp of competitions) {
          const competitors = comp?.competitors ?? [];
          for (const competitor of competitors) {
            const teamDisplayName = (competitor?.team?.displayName ?? "").toLowerCase();
            const teamAbbrev = (competitor?.team?.abbreviation ?? "").toLowerCase();

            if (teamDisplayName.includes(normalizedTeam) || normalizedTeam.includes(teamDisplayName) ||
                teamAbbrev === normalizedTeam || normalizedTeam.includes(teamAbbrev)) {
              console.log(`[b2b] ${teamName} played 2 days ago, has 1 day rest`);
              return { isBackToBack: false, restDays: 1 };
            }
          }
        }
      }
    }

    // Played neither yesterday nor 2 days ago - well rested
    console.log(`[b2b] ${teamName} has 2+ days rest`);
    return { isBackToBack: false, restDays: 2 };
  } catch (e) {
    console.log(`[b2b] Error checking back-to-back: ${e}`);
    return { isBackToBack: false, restDays: 1 };
  }
}

// --- Minutes Trending ---
// NBA minutes trends indicate role changes (source: RotoGrinders, FantasyLabs)





// --- Pace and Opponent Defense Scoring ---

interface PaceDefenseScores {
  paceScore: number;
  defenseScore: number;
}


// --- Rest Days Scoring ---
// NBA rest impact on performance (source: NBA injury data, RotoGrinders)
// IMPORTANT: B2B (0 days rest) is handled separately to avoid double-counting

function calculateRestScore(restDays: number | null, isBackToBack: boolean): number {
  // If data unavailable, return 0
  if (restDays === null) {
    console.log(`[rest] Data unavailable, rest score: 0`);
    return 0;
  }

  // If B2B, return 0 here - the B2B factor handles the penalty separately
  if (isBackToBack || restDays === 0) {
    console.log(`[rest] Days since last game: 0, rest score: 0 (B2B handled separately)`);
    return 0;
  }

  let restScore = 0;
  if (restDays >= 5) {
    restScore = 1; // Well rested but rust concern reduces bonus
  } else if (restDays >= 3) {
    restScore = 2; // Optimal rest (3-4 days)
  } else if (restDays >= 2) {
    restScore = 1; // Good rest (2 days)
  }
  // 1 day rest (normal schedule) = 0

  console.log(`[rest] Days since last game: ${restDays}, rest score: ${restScore}`);
  return restScore;
}

// --- Opponent Defensive Stats ---


async function fetchOpponentDefensiveStats(teamId: string): Promise<OpponentStats | null> {
  if (!teamId) return null;

  // Helper: collect ALL stats from any ESPN response into a flat map
  function collectAllStats(data: Record<string, unknown>): Map<string, number> {
    const statsMap = new Map<string, number>();

    function walk(obj: unknown, depth = 0): void {
      if (depth > 10 || !obj || typeof obj !== "object") return;

      // If this looks like a stat entry {name: string, value: number}
      const o = obj as Record<string, unknown>;
      if (typeof o.name === "string" && typeof o.value === "number") {
        statsMap.set(o.name.toLowerCase(), o.value);
      }
      if (typeof o.name === "string" && typeof o.displayValue === "string") {
        const val = parseFloat(o.displayValue);
        if (!isNaN(val) && !statsMap.has(o.name.toLowerCase())) {
          statsMap.set(o.name.toLowerCase(), val);
        }
      }

      // Recurse into arrays and objects
      if (Array.isArray(obj)) {
        for (const item of obj) walk(item, depth + 1);
      } else {
        for (const val of Object.values(o)) walk(val, depth + 1);
      }
    }

    walk(data);
    return statsMap;
  }

  // Inner function to attempt fetching stats (used for retry logic)
  async function attemptFetch(): Promise<OpponentStats | null> {
    // Try URL 1: site API team statistics
    const url1 = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${teamId}/statistics`;
    console.log(`[defense] Trying URL 1: ${url1}`);
    const res1 = await debugFetch("opp-stats-url1", url1);

    if (res1.ok && res1.text) {
      try {
        const data = JSON.parse(res1.text);
        console.log(`[defense] URL 1 top-level keys: ${Object.keys(data).join(", ")}`);
        const allStats = collectAllStats(data);
        console.log(`[defense] URL 1 collected ${allStats.size} stats`);
        if (allStats.size > 0) {
          // Log all stat names for debugging
          const statNames = Array.from(allStats.keys()).sort();
          console.log(`[defense] URL 1 stat names: ${statNames.join(", ")}`);
        }

        const result = buildOpponentStats(allStats);
        if (result && result.pointsAllowedPerGame > 0) {
          console.log(`[defense] URL 1 SUCCESS: PPG allowed=${result.pointsAllowedPerGame}, RPG allowed=${result.reboundsAllowedPerGame}, FG%=${result.oppFieldGoalPct}, 3PT%=${result.oppThreePointPct}`);
          return result;
        }
        console.log(`[defense] URL 1 returned data but no points allowed found, trying URL 2...`);
      } catch (e) {
        console.log(`[defense] URL 1 parse error: ${e}`);
      }
    }

    // Try URL 2: core API team statistics (more structured) - use current season year
    const url2 = `https://sports.core.api.espn.com/v2/sports/basketball/nba/seasons/2026/types/2/teams/${teamId}/statistics`;
    console.log(`[defense] Trying URL 2: ${url2}`);
    const res2 = await debugFetch("opp-stats-url2", url2);

    if (res2.ok && res2.text) {
      try {
        const data = JSON.parse(res2.text);
        console.log(`[defense] URL 2 top-level keys: ${Object.keys(data).join(", ")}`);
        const allStats = collectAllStats(data);
        console.log(`[defense] URL 2 collected ${allStats.size} stats`);
        if (allStats.size > 0) {
          const statNames = Array.from(allStats.keys()).sort();
          console.log(`[defense] URL 2 stat names: ${statNames.join(", ")}`);
        }

        const result = buildOpponentStats(allStats);
        if (result && result.pointsAllowedPerGame > 0) {
          console.log(`[defense] URL 2 SUCCESS: PPG allowed=${result.pointsAllowedPerGame}, RPG allowed=${result.reboundsAllowedPerGame}, FG%=${result.oppFieldGoalPct}, 3PT%=${result.oppThreePointPct}`);
          return result;
        }
        console.log(`[defense] URL 2 returned data but no points allowed found`);
      } catch (e) {
        console.log(`[defense] URL 2 parse error: ${e}`);
      }
    }

    return null;
  }

  // First attempt
  let result = await attemptFetch();
  if (result) return result;

  // Retry once after 2 second delay
  console.log(`[oppStats-retry] Retrying ESPN fetch for team ${teamId} after failure`);
  await new Promise(r => setTimeout(r, 2000));
  result = await attemptFetch();

  if (!result) {
    console.log(`[oppStats-warn] NULL oppStats for team ${teamId} — ESPN fetch failed even after retry`);
  }

  return result;
}

function findStatWithLog(allStats: Map<string, number>, label: string, names: string[]): number {
  for (const name of names) {
    const val = allStats.get(name);
    if (val !== undefined && val > 0) {
      console.log(`[defense-build] ${label}: found "${name}" = ${val}`);
      return val;
    }
  }
  console.log(`[defense-build] ${label}: no match found (tried: ${names.join(", ")})`);
  return 0;
}

// D-155: parity helper matching process-games' findStat — returns first
// non-zero match across the candidate key list, else 0. Used by the 7 new
// opp-own field extractions below.
function findStat(allStats: Map<string, number>, keys: string[]): number {
  for (const k of keys) {
    const v = allStats.get(k.toLowerCase());
    if (typeof v === "number" && v !== 0) return v;
  }
  return 0;
}

function buildOpponentStats(allStats: Map<string, number>): OpponentStats | null {
  // Points allowed - prioritize "against" variants, then fallback to team's own PPG
  const pointsAllowed = findStatWithLog(allStats, "PPG allowed", [
    "avgpointsagainst", "pointsagainst", "opppoints",
    "opposingteamavgpoints", "opponentpointspergame",
    "avgpoints", "points", // fallback: team's own PPG (imperfect proxy)
  ]);

  const reboundsAllowed = findStatWithLog(allStats, "RPG allowed", [
    "avgreboundsagainst", "opprebounds", "reboundsagainst",
    "opposingteamavgrebounds",
    "avgrebounds", "totalrebounds",
  ]);

  const assistsAllowed = findStatWithLog(allStats, "APG allowed", [
    "oppassists", "assistsagainst", "opposingteamavgassists",
    "avgassists", "assists",
  ]);

  const oppFgPct = findStatWithLog(allStats, "Opp FG%", [
    "oppfieldgoalpct", "fieldgoalpctagainst",
    "opponentfieldgoalpercentage", "opposingteamfieldgoalpct",
  ]);

  const oppThreePct = findStatWithLog(allStats, "Opp 3PT%", [
    "oppthreepointpct", "threepointpctagainst",
    "opponentthreepointpercentage", "oppthreepointfieldgoalpercentage",
    "opposingteamthreepointpct",
  ]);

  const pace = findStatWithLog(allStats, "Pace", [
    "pace", "possessions", "possessionspergame", "estimatedpossessions",
  ]);

  const defRating = findStatWithLog(allStats, "Def Rating", [
    "defensiverating", "defrating", "drtg", "defensiveefficiency",
  ]);

  // Determine defensive rank description
  let defenseRank = "average";
  if (defRating > 0) {
    if (defRating <= 108) defenseRank = "elite (top 5)";
    else if (defRating <= 112) defenseRank = "good (top 10)";
    else if (defRating <= 115) defenseRank = "average";
    else if (defRating <= 118) defenseRank = "below average";
    else defenseRank = "poor (bottom 5)";
  } else if (pointsAllowed > 0) {
    if (pointsAllowed <= 108) defenseRank = "elite defense";
    else if (pointsAllowed <= 112) defenseRank = "good defense";
    else if (pointsAllowed <= 116) defenseRank = "average defense";
    else defenseRank = "weak defense";
  }

  // D-155 (May 14, 2026): 7 additional opp-own fields populated to match
  // scoring.ts OpponentStats interface. These power per-prop-type defense
  // routing (steals/blocks/turnovers/threes) in calculatePaceDefenseScores.
  // Pattern mirrors process-games' fetchOpponentDefensiveStats at L872-878.
  // Each lookup falls back to 0 if not found in allStats — calculatePaceDefenseScores
  // gracefully returns 0 defenseScore when the matching field is 0.
  const oppOwnTurnovers = findStat(allStats, ["avgturnovers", "turnoverspergame"]);
  const oppOwnSteals = findStat(allStats, ["avgsteals", "stealspergame"]);
  const oppOwnBlocks = findStat(allStats, ["avgblocks", "blockspergame"]);
  const oppOwnTwoPtFGPct = findStat(allStats, ["twopointfieldgoalpct", "twopointfgpct"]);
  const oppOwnThreePtFGPct = findStat(allStats, ["threepointpct", "threepointfieldgoalpct"]);
  const oppOwnFGPct = findStat(allStats, ["fieldgoalpct"]);
  const oppPaceFactor = findStat(allStats, ["pacefactor", "avgestimatedpossessions"]);

  return {
    pointsAllowedPerGame: pointsAllowed,
    reboundsAllowedPerGame: reboundsAllowed,
    assistsAllowedPerGame: assistsAllowed,
    oppFieldGoalPct: oppFgPct,
    oppThreePointPct: oppThreePct,
    pace,
    defensiveRating: defRating,
    defenseRank,
    oppOwnTurnovers, oppOwnSteals, oppOwnBlocks,
    oppOwnTwoPtFGPct, oppOwnThreePtFGPct, oppOwnFGPct, oppPaceFactor,
  };
}

// --- Team Injuries ---

// === BallDontLie Injury System (same as get-recommendations) ===
const BALLDONTLIE_API_KEY = Deno.env.get("BALLDONTLIE_API_KEY") || "";
let bdlInjuriesLoaded = false;
const bdlInjuriesByTeam = new Map<string, BdlInjury[]>();  // D-155: typed via scoring.ts BdlInjury interface

async function loadBdlInjuries(): Promise<void> {
  if (bdlInjuriesLoaded) return;
  bdlInjuriesLoaded = true;
  if (!BALLDONTLIE_API_KEY) { console.log("[injuries-bdl] No API key"); return; }
  try {
    const teamsRes = await fetch("https://api.balldontlie.io/v1/teams", { headers: { "Authorization": BALLDONTLIE_API_KEY } });
    if (!teamsRes.ok) { console.log("[injuries-bdl] Teams fetch failed: " + teamsRes.status); return; }
    const teamsData = await teamsRes.json();
    const teamMap = new Map<number, string>();
    for (const t of teamsData.data) teamMap.set(t.id, t.full_name.toLowerCase());

    let cursor: number | null = null;
    const allInjuries: any[] = [];
    do {
      const url = cursor ? "https://api.balldontlie.io/v1/player_injuries?per_page=100&cursor=" + cursor : "https://api.balldontlie.io/v1/player_injuries?per_page=100";
      const res = await fetch(url, { headers: { "Authorization": BALLDONTLIE_API_KEY } });
      if (!res.ok) break;
      const data = await res.json();
      allInjuries.push(...data.data);
      cursor = data.meta?.next_cursor || null;
    } while (cursor);

    for (const inj of allInjuries) {
      const teamName = teamMap.get(inj.player?.team_id) || "unknown";
      // Parity with process-games (May 10, 2026) — capture return_date so the
      // data is available if/when analyze-pick gains scoring logic. analyze-pick
      // currently does NOT have getPlayerInjuryStatus or playerInjuryPenalty —
      // it only forwards injury text to the AI prompt. Storing return_date now
      // keeps the loader signature in sync between the two functions (C8 work).
      const entry: BdlInjury = {
        playerName: ((inj.player?.first_name || "") + " " + (inj.player?.last_name || "")).trim(),
        status: inj.status || "Unknown",
        description: inj.description || "",
        // D-155: teamName field required to match scoring.ts BdlInjury type
        // (process-games' BdlInjury also has this field; structural typing
        // expects it across both consumers of the shared interface).
        teamName,
        returnDate: inj.return_date || null,
      };
      if (!bdlInjuriesByTeam.has(teamName)) bdlInjuriesByTeam.set(teamName, []);
      bdlInjuriesByTeam.get(teamName)!.push(entry);
    }
    console.log("[injuries-bdl] Loaded " + allInjuries.length + " injuries across " + bdlInjuriesByTeam.size + " teams");
  } catch (err) { console.log("[injuries-bdl] Error: " + err); }
}

async function fetchTeamInjuries(teamName: string): Promise<string[]> {
  await loadBdlInjuries();
  const key = teamName.toLowerCase();
  const injuries = bdlInjuriesByTeam.get(key) || [];
  return injuries.map(inj => inj.playerName + ": " + inj.status + (inj.description ? " - " + inj.description.substring(0, 120) : ""));
}

async function fetchTodaysGameContext(teamName: string, sport: string): Promise<GameContext | null> {
  if (sport !== "basketball") {
    console.log(`[gameContext] Skipping for sport: ${sport}`);
    return null;
  }

  // Generate today's date in YYYYMMDD format for the API
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
  const url = `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${dateStr}`;
  console.log(`[gameContext] Fetching NBA schedule for ${dateStr}...`);
  console.log(`[gameContext] URL: ${url}`);
  const { ok, text } = await debugFetch("scoreboard", url);
  if (!ok || !text) return null;

  try {
    const data = JSON.parse(text);
    const events = data?.events ?? [];
    console.log(`[gameContext] Found ${events.length} games today`);

    // Normalize team name for matching (handle abbreviations and full names)
    const normalizedTeam = teamName.toLowerCase().trim();

    for (const event of events) {
      const competitions = event?.competitions ?? [];
      for (const comp of competitions) {
        const competitors = comp?.competitors ?? [];
        if (competitors.length !== 2) continue;

        const home = competitors.find((c: { homeAway?: string }) => c.homeAway === "home");
        const away = competitors.find((c: { homeAway?: string }) => c.homeAway === "away");

        if (!home || !away) continue;

        const homeTeamName = (home?.team?.displayName ?? home?.team?.name ?? "").toLowerCase();
        const awayTeamName = (away?.team?.displayName ?? away?.team?.name ?? "").toLowerCase();
        const homeAbbrev = (home?.team?.abbreviation ?? "").toLowerCase();
        const awayAbbrev = (away?.team?.abbreviation ?? "").toLowerCase();

        // Check if the player's team matches either home or away
        const isHomeTeam = homeTeamName.includes(normalizedTeam) || normalizedTeam.includes(homeTeamName) ||
          homeAbbrev === normalizedTeam || normalizedTeam.includes(homeAbbrev);
        const isAwayTeam = awayTeamName.includes(normalizedTeam) || normalizedTeam.includes(awayTeamName) ||
          awayAbbrev === normalizedTeam || normalizedTeam.includes(awayAbbrev);

        if (isHomeTeam) {
          const gameTime = event?.date ? formatGameTime(event.date) : "";
          const opponentTeamId = away?.team?.id ?? away?.id ?? "";
          console.log(`[gameContext] Found game: ${away?.team?.displayName} @ ${home?.team?.displayName} (player is HOME, oppId=${opponentTeamId})`);
          return {
            opponent: away?.team?.displayName ?? away?.team?.name ?? "",
            opponentTeamId: String(opponentTeamId),
            gameTime,
            isHome: true,
            gameId: event.id,
          };
        }

        if (isAwayTeam) {
          const gameTime = event?.date ? formatGameTime(event.date) : "";
          const opponentTeamId = home?.team?.id ?? home?.id ?? "";
          console.log(`[gameContext] Found game: ${away?.team?.displayName} @ ${home?.team?.displayName} (player is AWAY, oppId=${opponentTeamId})`);
          return {
            opponent: home?.team?.displayName ?? home?.team?.name ?? "",
            opponentTeamId: String(opponentTeamId),
            gameTime,
            isHome: false,
            gameId: event.id,
          };
        }
      }
    }

    console.log(`[gameContext] No game found today for team: ${teamName}`);
    return null;
  } catch (e) {
    console.log(`[gameContext] Parse error: ${e}`);
    return null;
  }
}

function formatGameTime(isoTime: string): string {
  try {
    const date = new Date(isoTime);
    return date.toLocaleTimeString("en-US", {
      hour: "numeric",
      minute: "2-digit",
      timeZone: "America/New_York"
    }) + " ET";
  } catch {
    return "";
  }
}

// --- Confidence scoring (mirrored from src/lib/confidence.ts) ---



// --- Gemini AI Analysis ---

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
if (!GEMINI_API_KEY) {
  console.error("[analyze-pick] GEMINI_API_KEY not set in environment");
}

async function getGeminiAnalysis(data: {
  playerName: string;
  team: string;
  position: string;
  propType: string;
  pickSide: string;
  line: number;
  odds: number;
  seasonAvg: number;
  recentAvg: number;
  floor: number;
  ceiling: number;
  confidence: number;
  last5Values: number[];
  hitRates: { l5: string; l10: string };
  // Tier 1 Fix #2 (May 11, 2026): gamesPlayed exposed so Season avg has an explicit
  // sample size in the prompt. Prevents the AI from inventing scope or back-converting
  // a season percentage into a wrong "X in N" framing (LeBron-style mislabel).
  gamesPlayed?: number;
  isHome: boolean;
  opponent?: string;
  opponentStats?: OpponentStats | null;
  minutesTrend?: MinutesTrend;
  isBackToBack?: boolean;
  restDays?: number;
  absenceInfo?: AbsenceInfo | null;
  teamInjuries?: string[];
  opponentInjuries?: string[];
}): Promise<string | null> {
  console.log(`\n[gemini-context] === Building prompt for ${data.playerName} ===`);

  // Format the last 5 values as a string
  const last5Str = data.last5Values.join(", ");
  const homeAway = data.isHome ? "HOME" : "AWAY";

  // Get opponent stats context
  const opp = data.opponentStats;
  const defenseRank = opp?.defenseRank ?? "unknown";

  // Build absence line if player had a recent absence
  const absenceLine = data.absenceInfo
    ? `- RECENT ABSENCE: Player missed approximately ${data.absenceInfo.gamesEstimate} games (${data.absenceInfo.daysGap}-day gap between ${data.absenceInfo.fromDate} and ${data.absenceInfo.toDate})`
    : "";

  // Build injury sections
  const teamInjuriesStr = data.teamInjuries && data.teamInjuries.length > 0
    ? data.teamInjuries.join("\n  ")
    : "None reported";
  const oppInjuriesStr = data.opponentInjuries && data.opponentInjuries.length > 0
    ? data.opponentInjuries.join("\n  ")
    : "None reported";

  // Minutes trend info
  const minTrend = data.minutesTrend;
  const minTrendStr = minTrend
    ? `${minTrend.direction.toUpperCase()} (L5: ${minTrend.l5Avg} min, L10: ${minTrend.l10Avg} min)`
    : "N/A";

  // Determine opponent stat value and label based on prop type
  const normalizedProp = data.propType.replace("player_", "").toLowerCase();
  let oppStatValue = 0;
  let oppStatLabel = "PPG";
  if (opp) {
    if (normalizedProp === "points") {
      oppStatValue = opp.pointsAllowedPerGame;
      oppStatLabel = "PPG";
    } else if (normalizedProp === "assists") {
      oppStatValue = opp.assistsAllowedPerGame;
      oppStatLabel = "APG";
    } else if (normalizedProp === "rebounds") {
      oppStatValue = opp.reboundsAllowedPerGame;
      oppStatLabel = "RPG";
    } else {
      oppStatValue = opp.pointsAllowedPerGame;
      oppStatLabel = "PPG";
    }
  }

  console.log(`[gemini-context] Opponent stat for prompt: ${oppStatValue.toFixed(1)} ${oppStatLabel} (raw opponentStats=${opp ? "present" : "NULL"})`);

  const prompt = `You are a sharp sports betting analyst. Your job is to give a concise 2-3 sentence analysis that tells the bettor something they CAN'T already see from the raw stats. Focus on WHY this pick is good or risky, not WHAT the numbers are. Never just list the last 5 game values — the user already sees those. Be direct and opinionated.

MANDATORY DATA (reference only, do not restate these to the user):
- Player: ${data.playerName} (${data.position || "Player"}) - ${data.team}
- Prop: ${data.propType} ${data.pickSide} ${data.line}
- Last 5 game values: [${last5Str}]
- L5 avg: ${data.recentAvg} | Season-to-date avg (${data.gamesPlayed ?? "?"} games): ${data.seasonAvg}
- Hit rate vs this ${data.line} line — L5: ${data.hitRates.l5} | L10: ${data.hitRates.l10}
- Floor (last 10): ${data.floor} | Ceiling (last 10): ${data.ceiling}
- Minutes trend: ${minTrendStr}
- Opponent: ${data.opponent ?? "Unknown"} (${homeAway})
- Opp allows ${oppStatValue.toFixed(1)} ${oppStatLabel} (${defenseRank})
${absenceLine}
- Back-to-back: ${data.isBackToBack ? "Yes" : "No"}
- Rest days: ${data.restDays ?? 1}

TEAMMATE INJURIES (${data.team}):
  ${teamInjuriesStr}

OPPONENT INJURIES (${data.opponent ?? "Unknown"}):
  ${oppInjuriesStr}

Based on the data above, write a 2-3 sentence betting analysis. You MUST follow these rules:

0. DATA INTEGRITY (read first): Cite only stats explicitly provided above. Never invent denominators, sample sizes, percentages, or splits. If you reference a window, match the label exactly — "season-to-date" means the ${data.gamesPlayed ?? "?"}-game sample above. Never call L5 or L10 "season." Subscribers verify our claims against external sources, so mislabeling breaks trust.
1. CRITICAL: The algorithm picked the ${data.pickSide.toUpperCase()} (${data.pickSide === "over" ? "player EXCEEDS" : "player STAYS BELOW"} ${data.line} ${normalizedProp}). Your analysis MUST argue for or critique the ${data.pickSide.toUpperCase()} direction. NEVER argue for the opposite side.
2. Do NOT restate the last 5 values, season average, or hit rates — the user already sees these on the dashboard.
3. DO analyze: momentum/trends (hot streak vs cooling off), the matchup (what makes ${data.opponent ?? "this opponent"} good/bad for ${normalizedProp} specifically), any red flags (volatile floor, minute restrictions, absence return), and whether the line feels soft or tight relative to recent performance.
4. If RECENT ABSENCE is flagged, lead with that — it's the most important factor.
5. Reference ${data.opponent ?? "the opponent"} by name and say something specific about them defensively (not just 'they allow X ${oppStatLabel}').
6. End with TAKE, LEAN, or FADE the ${data.pickSide.toUpperCase()} — not just TAKE every time. LEAN means slight edge but risky. FADE means the numbers look good but something concerns you.
7. Keep it to 2-3 sentences max. Be sharp, not verbose.
8. Quote the correct opponent stat for this prop type (${oppStatLabel} for ${normalizedProp}). Do not cite PPG for an assists prop.
9. IMPORTANT: Players listed as "Suspended" or who have been out ALL SEASON are NOT game-day factors. Do not reference them as if their absence changes tonight's game. Only reference RECENT injuries/absences.
10. If key teammates have a RECENT injury (Out or Day-To-Day within the last few weeks), consider how their absence affects the player's role.

No markdown formatting, no asterisks, no disclaimers.`;

  console.log(`[gemini-context] Prompt built with: B2B=${data.isBackToBack}, Rest=${data.restDays}, MinTrend=${minTrend?.direction}`);

  const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;
  console.log(`[gemini] URL: ${apiUrl.replace(GEMINI_API_KEY, "***")}`);
  console.log(`[gemini] Prompt length: ${prompt.length} chars`);

  const requestBody = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      maxOutputTokens: 200,
      temperature: 0.7,
    },
  };

  // Helper function to make the API call
  async function makeRequest(): Promise<{ status: number; text: string }> {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });
    const text = await response.text();
    return { status: response.status, text };
  }

  try {
    console.log(`[gemini] Sending POST request...`);
    let result = await makeRequest();
    console.log(`[gemini] Response status: ${result.status}`);

    // Retry once with 3s backoff if rate limited (429)
    if (result.status === 429) {
      console.log(`[gemini] Rate limited (429), waiting 3s and retrying...`);
      await new Promise(r => setTimeout(r, 3000));
      result = await makeRequest();
      console.log(`[gemini] Retry response status: ${result.status}`);
    }

    console.log(`[gemini] Response body (first 500 chars): ${result.text.slice(0, 500)}`);

    if (result.status !== 200) {
      console.log(`[gemini] API error! Status: ${result.status}, Body: ${result.text}`);
      return null;
    }

    const json = JSON.parse(result.text);
    console.log(`[gemini] Parsed response keys: ${Object.keys(json).join(", ")}`);

    const candidates = json?.candidates;
    console.log(`[gemini] Candidates count: ${candidates?.length ?? 0}`);

    if (candidates && candidates[0]) {
      console.log(`[gemini] Candidate[0] keys: ${Object.keys(candidates[0]).join(", ")}`);
      const content = candidates[0]?.content;
      console.log(`[gemini] Content keys: ${content ? Object.keys(content).join(", ") : "null"}`);
      const parts = content?.parts;
      console.log(`[gemini] Parts count: ${parts?.length ?? 0}`);
    }

    const text = json?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (text) {
      console.log(`[gemini] SUCCESS! Analysis (${text.length} chars): "${text.slice(0, 150)}..."`);
      return text.trim();
    } else {
      console.log(`[gemini] No text found in response structure`);
      return null;
    }
  } catch (err) {
    console.log(`[gemini] EXCEPTION: ${err}`);
    return null;
  }
}

// --- Main handler ---

console.log("[analyze-pick] Registering handler...");

Deno.serve(async (req) => {
  console.log("[analyze-pick] Handler invoked:", req.method);
  const _startMs = Date.now();
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    // D-262 dry-run gate: parse body. When body.dry_run === true, we run the
    // full read + scoring path (ESPN search, game log, opponent stats,
    // confidence calculation, Gemini AI) but SKIP the only mutating call:
    // the upsert_pick_history RPC at line ~1758.
    const _reqBody = await req.json();
    const { playerName, sport, propType, line, pickSide, odds } = _reqBody;
    const _dryRun = _reqBody?.dry_run === true;

    if (!playerName || !sport || !propType || line === undefined || !pickSide) {
      return jsonResponse({ error: "playerName, sport, propType, line, and pickSide are required" }, 400);
    }

    if (pickSide !== "over" && pickSide !== "under") {
      return jsonResponse({ error: "pickSide must be 'over' or 'under'" }, 400);
    }

    // Parse line as number to ensure proper comparisons
    const lineNum = parseFloat(String(line));
    if (isNaN(lineNum)) {
      return jsonResponse({ error: "line must be a valid number" }, 400);
    }

    const oddsNum = typeof odds === "number" ? odds : parseFloat(String(odds ?? -110)) || -110;

    // Fetch player data from ESPN
    const player = await searchPlayer(playerName, sport);
    if (!player) {
      return jsonResponse({ error: `Player "${playerName}" not found` }, 404);
    }

    // D-179 (May 15-16, 2026): cache-first read path. Try cache_player_game_logs
    // first; fall through to live ESPN fetch if cache returns <10 rows. Game
    // context lookup stays live (cache_team_metadata doesn't carry today's
    // opponent context — that requires the scoreboard endpoint).
    let cacheGameLogHit = false;
    let cacheOppStatsHit = false;
    let cacheTeamMetaHit = false;

    const cachedLog = await readPlayerGameLogFromCache(player.displayName, sport);
    let gameLog: GameLogEntry[];
    let gameContext: GameContext | null = null;
    if (cachedLog) {
      cacheGameLogHit = true;
      gameLog = cachedLog;
      gameContext = await fetchTodaysGameContext(player.team, sport);
    } else {
      const [liveLog, liveCtx] = await Promise.all([
        fetchGameLog(player.id, sport),
        fetchTodaysGameContext(player.team, sport),
      ]);
      gameLog = liveLog;
      gameContext = liveCtx;
    }

    if (!gameLog.length) {
      return jsonResponse({ error: `No game log data found for ${player.displayName}` }, 404);
    }

    // D-179: probe team metadata cache for the opponent (informational —
    // not yet used to short-circuit anything but contributes to cacheStatus).
    if (gameContext?.opponent) {
      const teamMeta = await readTeamMetadataFromCache(gameContext.opponent, sport);
      cacheTeamMetaHit = teamMeta !== null;
    }

    // Calculate hit rates
    const hitRates = calcHitRates(gameLog, propType, lineNum, pickSide);
    if (!hitRates.values.length) {
      return jsonResponse({ error: `No "${propType}" stat data found in game log. Available stats: ${Object.keys(gameLog[0]?.stats ?? {}).join(", ")}` }, 400);
    }

    // Floor, ceiling, averages
    const allValues = hitRates.values;
    const playerFloor = Math.min(...allValues);
    const playerCeiling = Math.max(...allValues);
    const seasonAvg = Math.round((allValues.reduce((a, b) => a + b, 0) / allValues.length) * 100) / 100;
    const recentValues = allValues.slice(0, 5);
    const recentAvg = Math.round((recentValues.reduce((a, b) => a + b, 0) / recentValues.length) * 100) / 100;

    // Calculate L5 score for hard reject filter
    const l5Score = hitRates.l5.rate >= 100 ? 15 : hitRates.l5.rate >= 80 ? 12 : hitRates.l5.rate >= 60 ? 5 : hitRates.l5.rate >= 40 ? 0 : hitRates.l5.rate >= 20 ? -8 : -15;

    // HARD REJECT FILTERS - check before running full algorithm
    let hardRejectReason: string | null = null;

    // Hard reject: recent avg more than 3 below line = 0% historical hit rate
    if (pickSide === "over" && recentAvg < lineNum - 3) {
      hardRejectReason = "Recent average too far below line";
      console.log(`[hardReject] ${hardRejectReason}: recentAvg=${recentAvg}, line=${lineNum}`);
    }

    // Hard reject: 0 of last 5 games cleared the line = 20% hit rate
    if (l5Score === -15) {
      hardRejectReason = "No recent games clearing line (0/5)";
      console.log(`[hardReject] ${hardRejectReason}: l5HitRate=${hitRates.l5.rate}%`);
    }

    // Use today's game context for home/away - return null if unavailable
    const isHome = gameContext?.isHome ?? null;
    console.log(`[main] Home/Away: ${isHome === null ? "UNAVAILABLE" : isHome ? "HOME" : "AWAY"} (from ${gameContext ? "today's schedule" : "no game today"})`);

    // D-179: cache-first opp stats. Try cache_opponent_defensive_stats by
    // team_name first; fall through to live ESPN if cache miss. B2B check
    // stays live (no cache table for it).
    let opponentStats: OpponentStats | null = null;
    let backToBackResult: BackToBackResult = { isBackToBack: false, restDays: 1 };

    let oppStatsResolved: OpponentStats | null = null;
    if (gameContext?.opponent) {
      oppStatsResolved = await readOpponentStatsFromCache(gameContext.opponent, sport);
      if (oppStatsResolved) cacheOppStatsHit = true;
    }
    const oppStatsPromise = oppStatsResolved
      ? Promise.resolve(oppStatsResolved)
      : (gameContext?.opponentTeamId
          ? fetchOpponentDefensiveStats(gameContext.opponentTeamId)
          : Promise.resolve(null));

    const [oppStatsResult, b2bResult] = await Promise.all([
      oppStatsPromise,
      checkBackToBack(player.team, sport),
    ]);

    opponentStats = oppStatsResult;
    backToBackResult = b2bResult;
    console.log(`[main] Opponent stats: ${opponentStats ? JSON.stringify(opponentStats) : "null"}`);
    console.log(`[main] Back-to-back: ${backToBackResult.isBackToBack}, Rest days: ${backToBackResult.restDays}`);

    // D-155 (May 14, 2026, CEO §19.3): scoring delegated to _shared/scoring.ts.
    // Closes D-148 v2 Finding #1 (Evaluator/Dashboard divergence). Closes
    // D-152 atomically — verdict + 3 stored-confidence sites below all
    // implicitly read post-everything finalScore via scoringResult.confidence.
    const minutesTrend = calculateMinutesTrend(gameLog);
    console.log(`[main] Minutes trend: L5=${minutesTrend.l5Avg}, L10=${minutesTrend.l10Avg}, direction=${minutesTrend.direction}`);

    // Pace/defense kept for downstream log + adapter — scoreOneSide also
    // computes these internally but we surface them here for parity with the
    // pre-D-155 log format.
    const { paceScore, defenseScore } = calculatePaceDefenseScores(opponentStats, propType, pickSide);
    console.log(`[main] Pace score: ${paceScore}, Defense score: ${defenseScore}`);

    // Load weights + ensure BDL injuries loaded (analyze-pick already has
    // loadBdlInjuries fetcher at L1001-ish; this ensures it's populated before
    // helpers.getPlayerInjury is invoked).
    const weights = await loadWeightsFromDB();
    await loadBdlInjuries();

    // D-156 (May 14, 2026): Load game-line snapshot from cache_game_lines so
    // D-137 blowoutRisk + D-139 lineMovement factors can compute in Evaluator
    // (closes the D-155 acknowledged tradeoff where getGameLine was returning
    // null). Uses service-role key (RLS bypass) — same pattern as the BDL
    // injuries load above. Graceful degradation: any failure leaves
    // cachedGameLine = null and the two factors return 0 (same as pre-D-156).
    const propHomeTeam_d156 = (gameContext?.isHome === true) ? player.team : (gameContext?.opponent ?? "");
    const propAwayTeam_d156 = (gameContext?.isHome === true) ? (gameContext?.opponent ?? "") : player.team;
    const propGameDate_d156 = new Date().toISOString().slice(0, 10);  // YYYY-MM-DD
    const gameLineKey_d156 = `${propHomeTeam_d156}|${propAwayTeam_d156}|${propGameDate_d156}`;
    let cachedGameLine_d156: GameLineSnapshot | null = null;
    try {
      const supaUrl_d156 = Deno.env.get("SUPABASE_URL") ?? "";
      const supaKey_d156 = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
      if (supaUrl_d156 && supaKey_d156 && propHomeTeam_d156 && propAwayTeam_d156) {
        const res = await fetch(
          `${supaUrl_d156}/rest/v1/cache_game_lines?` +
          `home_team=eq.${encodeURIComponent(propHomeTeam_d156)}` +
          `&away_team=eq.${encodeURIComponent(propAwayTeam_d156)}` +
          `&game_date=eq.${propGameDate_d156}` +
          `&select=spread_line,spread_line_t0,favored_team&limit=1`,
          { headers: { apikey: supaKey_d156, Authorization: `Bearer ${supaKey_d156}` } },
        );
        if (res.ok) {
          const rows = await res.json();
          if (Array.isArray(rows) && rows.length > 0) {
            const r = rows[0];
            cachedGameLine_d156 = {
              spread: typeof r.spread_line === "number" ? r.spread_line : (r.spread_line ? Number(r.spread_line) : null),
              favoredTeam: r.favored_team ?? null,
              spreadT0: typeof r.spread_line_t0 === "number" ? r.spread_line_t0 : (r.spread_line_t0 ? Number(r.spread_line_t0) : null),
            };
            console.log(`[d156] game-line cache hit for ${gameLineKey_d156}: spread=${cachedGameLine_d156.spread} t0=${cachedGameLine_d156.spreadT0}`);
          } else {
            console.log(`[d156] game-line cache miss for ${gameLineKey_d156} (no game-line row for this matchup today)`);
          }
        }
      }
    } catch (e) {
      console.log(`[d156] game-line fetch error (graceful degradation, factor returns 0): ${e instanceof Error ? e.message : String(e)}`);
    }

    // Helpers wrap analyze-pick's local state for scoreOneSide. D-156 wires
    // getGameLine to the pre-fetched cache snapshot above (was returning null
    // pre-D-156, causing D-137/D-139 factors to silently return 0).
    const helpers: ScoreOneSideHelpers = {
      getTeamInjuries: (team) => fetchTeamInjuries(team),
      getGameLine: (h, a, gd) => {
        const key = `${h}|${a}|${gd}`;
        return key === gameLineKey_d156 ? cachedGameLine_d156 : null;
      },
      getPlayerInjury: (p, t) => getPlayerInjuryStatus(p, t, bdlInjuriesByTeam, undefined),
    };

    // Adapter: build {playerData, prop, edgeData} shapes scoreOneSide expects
    // from analyze-pick's flat HTTP-body inputs.
    const playerData: CachedPlayerData = {
      player: {
        id: player.id,
        displayName: player.displayName,
        team: player.team,
        position: player.position ?? "",
      },
      gameLog,
      minutesTrend,
    };
    const prop: ExtractedProp = {
      playerName,
      propType,
      line: lineNum,
      odds: oddsNum,
      // isHome derived from gameContext; if true, player.team is home.
      // D-156: reuse propHomeTeam_d156 / propAwayTeam_d156 / propGameDate_d156
      // so the cache key inside scoreOneSide matches what we pre-loaded above.
      homeTeam: propHomeTeam_d156,
      awayTeam: propAwayTeam_d156,
      gameTime: propGameDate_d156,
    };
    const edgeData = {
      b2b: { isBackToBack: backToBackResult.isBackToBack, restDays: backToBackResult.restDays },
      oppStats: opponentStats,
    };

    // Single scoreOneSide call. Internally applies base 13 factors + 13
    // post-calc bonuses + D-127 trivial cap (L1) + D-140 layer-2 cap +
    // D-142 verdict-from-finalScore + D-136/D-137/D-139 new factors.
    const scoringResult = await scoreOneSide(playerData, prop, edgeData, pickSide, weights, helpers);
    if (!scoringResult) {
      return jsonResponse({
        error: "Scoring returned null — likely insufficient game log data (<5 valid games)",
      }, 400);
    }

    // Hard-reject override: keep scoring's breakdown for logging fidelity, but
    // force confidence to 0 + verdict to "Hard Reject" per pre-D-155 semantics.
    const finalConfidence = hardRejectReason ? 0 : scoringResult.confidence;
    const finalVerdict = hardRejectReason ? "Hard Reject" : scoringResult.verdict;
    const finalBreakdown: Record<string, number> = hardRejectReason
      ? { ...(scoringResult.breakdown ?? {}), hardReject: -100 }
      : (scoringResult.breakdown ?? {});

    // Maintain backward-compat shape: downstream code reads confidence.score
    // and confidence.breakdown (the 4 D-152 sister-bug read sites — L1718,
    // L1791, L1831 + verdict literal below). After D-155 finalConfidence IS
    // the post-everything finalScore (scoreOneSide already applied D-140 cap
    // + D-142 verdict-from-finalScore).
    const confidence = { score: finalConfidence, breakdown: finalBreakdown };

    const verdict = finalVerdict;
    const hitRatesFormatted = {
      l5: `${hitRates.l5.hits}/${hitRates.l5.total}`,
      l10: `${hitRates.l10.hits}/${hitRates.l10.total}`,
      season: `${Math.round(hitRates.season.rate)}%`,
    };

    // Detect recent absences from game log
    const absenceInfo = detectRecentAbsence(gameLog);
    if (absenceInfo) {
      console.log(`[main] Absence detected: ${absenceInfo.gamesEstimate} games missed (${absenceInfo.daysGap}-day gap)`);
    }

    // Fetch injuries for both teams
    const [teamInjuries, opponentInjuries] = await Promise.all([
      fetchTeamInjuries(player.team),
      gameContext?.opponent ? fetchTeamInjuries(gameContext.opponent) : Promise.resolve([]),
    ]);
    const teamAbbrev = TEAM_ABBREV[player.team.toLowerCase()] ?? player.team;
    const oppAbbrev = gameContext?.opponent ? (TEAM_ABBREV[gameContext.opponent.toLowerCase()] ?? gameContext.opponent) : "N/A";
    console.log(`[injuries] ${player.displayName}: team=${teamAbbrev} teamInjuries=${teamInjuries.length}, opponent=${oppAbbrev} oppInjuries=${opponentInjuries.length}`);

    // Get Gemini AI analysis (with 3s delay to avoid rate limits)
    console.log(`\n[main] Waiting 3s before Gemini call to avoid rate limits...`);
    await new Promise(r => setTimeout(r, 3000));
    console.log(`[main] About to call getGeminiAnalysis for ${player.displayName}...`);
    let aiAnalysis = await getGeminiAnalysis({
      playerName: player.displayName,
      team: player.team,
      position: player.position,
      propType,
      pickSide,
      line: lineNum,
      odds: oddsNum,
      seasonAvg,
      recentAvg,
      floor: playerFloor,
      ceiling: playerCeiling,
      confidence: confidence.score,
      last5Values: recentValues,
      hitRates: { l5: `${hitRates.l5.hits}/${hitRates.l5.total}`, l10: `${hitRates.l10.hits}/${hitRates.l10.total}` },
      gamesPlayed: allValues.length,
      isHome: isHome ?? true,
      opponent: gameContext?.opponent,
      opponentStats,
      minutesTrend,
      isBackToBack: backToBackResult.isBackToBack,
      restDays: backToBackResult.restDays,
      absenceInfo,
      teamInjuries,
      opponentInjuries,
    });

    // Strip markdown formatting from Gemini response
    if (aiAnalysis) {
      aiAnalysis = aiAnalysis
        .replace(/\*\*/g, '')
        .replace(/\*/g, '')
        .replace(/##/g, '')
        .replace(/#/g, '')
        .trim();
    }
    console.log(`[main] Gemini result: ${aiAnalysis ? `"${aiAnalysis.slice(0, 50)}..."` : "null"}`);

    // D-177-A (May 15-16, 2026): switched from direct POST → upsert_pick_history
    // RPC. Pre-D-177-A the direct POST was missing 22 active columns
    // (game_date, sport, score_z_score..score_minutes_stability, D-136/137/139,
    // D-164/166/167, projection data) because the writer had not been kept in
    // sync with column additions since May 9. D-172a fixed the RPC to write the
    // full column set; D-177-A routes analyze-pick through the same RPC so
    // source='evaluator' rows carry the same analytical fidelity as
    // source='process-games' rows.
    //
    // Builds the payload from scoringResult (PropAnalysisResult from
    // scoreOneSide post-D-155). Mirrors process-games' logPickToHistory
    // construction at supabase/functions/process-games/index.ts:2377-2400.
    try {
      const breakdown = scoringResult.breakdown ?? {};
      // D-162-style DST-safe ET game_date (pre-fix: never set → NULL in pick_history,
      // root cause of D-062 null-game_date observation).
      const gameDateYmd = new Date()
        .toLocaleDateString("en-CA", { timeZone: "America/New_York" })
        .replace(/-/g, "");
      const pickHistoryRow = {
        // Player & Game Context
        player_name: player.displayName,
        team: player.team,
        opponent: gameContext?.opponent ?? null,
        game_time: gameContext?.gameTime ?? null,
        game_date: gameDateYmd,
        is_home: gameContext?.isHome ?? null,
        // Prop Details
        prop_type: propType,
        line: lineNum,
        pick_side: pickSide,
        odds: oddsNum,
        // Player Stats Snapshot
        season_avg: scoringResult.seasonAvg ?? seasonAvg,
        recent_avg: scoringResult.recentAvg ?? recentAvg,
        floor_val: scoringResult.floor ?? playerFloor,
        ceiling_val: scoringResult.ceiling ?? playerCeiling,
        l5_hit_count: scoringResult.hitRatesRaw?.l5Hits ?? hitRates.l5.hits,
        l10_hit_count: scoringResult.hitRatesRaw?.l10Hits ?? hitRates.l10.hits,
        season_hit_pct: scoringResult.hitRatesRaw?.seasonRate ?? hitRates.season.rate,
        // Edge Factors
        is_b2b: scoringResult.isBackToBack ?? backToBackResult.isBackToBack,
        rest_days: scoringResult.restDays ?? backToBackResult.restDays,
        minutes_l5_avg: scoringResult.minutesTrend?.l5Avg ?? minutesTrend.l5Avg,
        minutes_l10_avg: scoringResult.minutesTrend?.l10Avg ?? minutesTrend.l10Avg,
        minutes_trend: scoringResult.minutesTrend?.direction ?? minutesTrend.direction,
        opp_ppg_allowed: scoringResult.oppStats?.pointsAllowedPerGame ?? null,
        opp_rpg_allowed: scoringResult.oppStats?.reboundsAllowedPerGame ?? null,
        opp_fg_pct_allowed: scoringResult.oppStats?.oppFieldGoalPct ?? null,
        opp_3pt_pct_allowed: scoringResult.oppStats?.oppThreePointPct ?? null,
        pace_opp_ppg: scoringResult.oppStats?.pointsAllowedPerGame ?? null,
        // Scoring Factors (base 13)
        score_l5: breakdown.l5HitRate ?? 0,
        score_l10: breakdown.l10HitRate ?? 0,
        score_season: breakdown.seasonHitRate ?? 0,
        score_floor_ceiling: breakdown.floorCeiling ?? 0,
        score_recent_form: breakdown.recentForm ?? 0,
        score_home_away: breakdown.homeAway ?? 0,
        score_rest: breakdown.restDays ?? 0,
        score_b2b: breakdown.backToBack ?? 0,
        score_minutes_trend: breakdown.minutesTrend ?? 0,
        score_pace: breakdown.pace ?? 0,
        score_opp_defense: breakdown.opponentDefense ?? 0,
        score_odds_value: breakdown.oddsValue ?? 0,
        score_prop_type_penalty: breakdown.propTypePenalty ?? 0,
        // Scoring Factors (13 post-calc bonuses, present in mergedBreakdown post-D-155)
        score_z_score: breakdown.zScoreBonus ?? 0,
        score_role_change: breakdown.roleChangeBonus ?? 0,
        score_vig_filter: breakdown.vigFilterPenalty ?? 0,
        score_usg_rate: breakdown.usgBonus ?? 0,
        score_regression: breakdown.regressionBonus ?? 0,
        score_market_conf: breakdown.marketConfBonus ?? 0,
        score_home_away_split: breakdown.homeAwaySplitBonus ?? 0,
        score_minutes_floor: breakdown.minutesFloorBonus ?? 0,
        score_minutes_volume: breakdown.minutesVolumeBonus ?? 0,
        score_minutes_stability: breakdown.minutesStabilityBonus ?? 0,
        score_consistency: breakdown.consistencyBonus ?? 0,
        score_stale_data: breakdown.staleDataPenalty ?? 0,
        score_player_injury: breakdown.playerInjuryPenalty ?? 0,
        // D-127 trivial line (May 12) + D-136/137/139 (May 13)
        score_trivial_line_penalty: breakdown.trivialLinePenalty ?? 0,
        score_trivial_line_cap: (breakdown.trivialLineCapApplied ?? 0) > 0,
        score_low_min_risk: breakdown.lowMinRiskPenalty ?? 0,
        score_blowout_risk: breakdown.blowoutRiskPenalty ?? 0,
        score_line_movement: breakdown.lineMovementBonus ?? 0,
        // D-164/166/167 flag set (May 14)
        unbettable_juice_flag: scoringResult.unbettableJuiceFlag ?? false,
        coin_flip_flag: scoringResult.coinFlipFlag ?? false,
        negative_stacking_flag: scoringResult.negativeStackingFlag ?? false,
        negative_factor_count: scoringResult.negativeFactorCount ?? 0,
        // Projection data
        projected_stat: scoringResult.projectionData?.projectedStat ?? null,
        stat_stdev: scoringResult.projectionData?.statStdDev ?? null,
        z_score: scoringResult.projectionData?.zScore ?? null,
        per_minute_rate: scoringResult.projectionData?.perMinRate ?? null,
        projected_minutes: scoringResult.projectionData?.projectedMinutes ?? null,
        teammate_injuries_count: scoringResult.projectionData?.teammateInjuriesCount ?? null,
        usage_boost: scoringResult.projectionData?.usageBoost ?? null,
        // Final Output
        confidence: confidence.score,
        verdict,
        ai_analysis: aiAnalysis,
        // D-198 (May 17, 2026): tier-aware audit. Equals confidence on identity
        // multipliers; diverges once §19.3 tunes algorithm_weights_tier_modifiers.
        confidence_pre_tier_aware: (scoringResult as { confidence_pre_tier_aware?: number | null }).confidence_pre_tier_aware ?? confidence.score,
        // Source
        source: "evaluator",
        recommendation_shown: false,
        sport: "nba",
      };

      // D-262: skip the only mutating call in this function when dry-run.
      // D-489 STAGE 4: route through the canonical helper. Validates BEFORE
      // the RPC call (hour-0 catch). Output byte-identical for the DB write
      // (same upsert_pick_history RPC, same payload body). The helper's
      // dryRun option mirrors the existing _dryRun guard; we pass it through.
      const writeResult = await canonicalWritePickHistory(
        pickHistoryRow as PickHistoryPayload,
        {
          dryRun: _dryRun,
          supabaseUrl: Deno.env.get("SUPABASE_URL") ?? "",
          supabaseKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
        },
      );
      if (_dryRun) {
        console.log(`[pick_history] DRY-RUN: skipping upsert_pick_history RPC (would have written 1 row for ${player.displayName}).`);
      } else if (writeResult.ok) {
        console.log(`[pick_history] Successfully logged pick for ${player.displayName}`);
      } else if (writeResult.code === "CLIENT_VALIDATION") {
        // D-489: hour-0 catch — the helper rejected before the RPC call.
        // Distinct from RPC failures; the message identifies the validation
        // errors so a future batch can fix the payload at source.
        console.log(`[pick_history] CLIENT_VALIDATION rejected for ${player.displayName}: ${writeResult.errors.join("; ")}`);
      } else {
        // D-489: RPC failure — same surface as the pre-migration console.log.
        console.log(`[pick_history] RPC error: ${writeResult.status} - ${writeResult.body.slice(0, 300)}`);
      }
    } catch (logErr) {
      console.log(`[pick_history] Logging failed (non-fatal): ${logErr}`);
    }

    // D-179: 3-state cache status for Evaluator caption.
    const hitCount_d179 = (cacheGameLogHit ? 1 : 0) + (cacheOppStatsHit ? 1 : 0) + (cacheTeamMetaHit ? 1 : 0);
    const cacheStatus_d179: "full" | "partial" | "miss" =
      hitCount_d179 === 3 ? "full" : hitCount_d179 > 0 ? "partial" : "miss";

    return jsonResponse({
      playerName: player.displayName,
      team: player.team,
      propType,
      line: lineNum,
      pickSide,
      odds: oddsNum,
      confidenceScore: confidence.score,
      label: verdict,
      hitRates: hitRatesFormatted,
      stats: {
        floor: playerFloor,
        ceiling: playerCeiling,
        seasonAvg,
        recentAvg,
      },
      factors: confidence.breakdown,
      aiAnalysis,
      // Game context (if available)
      opponent: gameContext?.opponent ?? null,
      gameTime: gameContext?.gameTime ?? null,
      isHome: gameContext?.isHome ?? null,
      // New edge data
      backToBack: backToBackResult.isBackToBack,
      restDays: backToBackResult.restDays,
      minutesTrend: {
        l5Avg: minutesTrend.l5Avg,
        l10Avg: minutesTrend.l10Avg,
        direction: minutesTrend.direction,
      },
      // D-179 cache status (full | partial | miss) + per-source breakdown.
      cacheStatus: cacheStatus_d179,
      cacheSources: {
        playerGameLog: cacheGameLogHit,
        opponentStats: cacheOppStatsHit,
        teamMetadata: cacheTeamMetaHit,
      },
      // D-262 dry-run gate echo (omitted from body when not dry-run).
      ...(_dryRun ? {
        dry_run: true,
        would_write: { pick_history: 1 },
        elapsed_ms: Date.now() - _startMs,
      } : {}),
    });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : "Internal server error" }, 500);
  }
});
