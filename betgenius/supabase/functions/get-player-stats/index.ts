import "jsr:@supabase/functions-js/edge-runtime.d.ts";

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

// --- ESPN player search & game log ---

interface PlayerResult {
  id: string;
  displayName: string;
  team: string;
  position: string;
}

interface GameLogEntry {
  date: string;
  opponent: string;
  homeAway: string;
  stats: Record<string, number>;
}

function getSportPath(sport: string): string {
  if (sport === "basketball") return "basketball/nba";
  if (sport === "football") return "football/nfl";
  if (sport === "baseball") return "baseball/mlb";
  if (sport === "hockey") return "hockey/nhl";
  return `${sport}/${sport}`;
}

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

function namesMatch(query: string, candidate: string): boolean {
  const q = query.toLowerCase().trim();
  const c = candidate.toLowerCase().trim();
  if (c === q) return true;
  if (c.includes(q) || q.includes(c)) return true;
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
        const refs: string[] = [];
        for (const item of Array.isArray(items) ? items : []) {
          const ref = item?.$ref;
          if (typeof ref === "string" && ref.includes("athletes/")) {
            refs.push(ref);
          }
        }
        console.log(`[search-attempt-3] Found ${refs.length} athlete refs, resolving top 5...`);

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

function calculateStatSummary(games: GameLogEntry[]) {
  if (!games.length) return { floor: {}, ceiling: {}, average: {}, games: 0 };

  const allKeys = new Set<string>();
  for (const g of games) {
    for (const k of Object.keys(g.stats)) allKeys.add(k);
  }

  const floor: Record<string, number> = {};
  const ceiling: Record<string, number> = {};
  const average: Record<string, number> = {};

  for (const key of allKeys) {
    const values = games.map((g) => g.stats[key]).filter((v) => v !== undefined);
    if (!values.length) continue;
    floor[key] = Math.min(...values);
    ceiling[key] = Math.max(...values);
    average[key] = Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100;
  }

  return { floor, ceiling, average, games: games.length };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { playerName, sport } = await req.json();

    if (!playerName || !sport) {
      return jsonResponse({ error: "playerName and sport are required" }, 400);
    }

    const player = await searchPlayer(playerName, sport);
    if (!player) {
      return jsonResponse({ error: `Player "${playerName}" not found` }, 404);
    }

    const gameLog = await fetchGameLog(player.id, sport);
    const summary = calculateStatSummary(gameLog);

    return jsonResponse({
      player: {
        espnId: player.id,
        name: player.displayName,
        team: player.team,
        position: player.position,
        sport,
      },
      stats: summary,
      gameLog,
    });
  } catch (err) {
    return jsonResponse({ error: err instanceof Error ? err.message : "Internal server error" }, 500);
  }
});
