// fetch-weather — D-204 Batch 3 Task 3.0.
//
// Periodic writer for cache_mlb_game_scoreboard weather columns. Reads
// today's scheduled MLB games from MLB Stats API, then enriches each with
// OpenWeather (temp_f / wind_speed / wind_dir / condition) per CEO decision
// #1 ($10/mo OpenWeather sub).
//
// Cron: jobid 22, every 4h during game window (15:00, 19:00, 23:00, 03:00 UTC).
//
// GRACEFUL FALLBACK: if OPENWEATHER_API_KEY is unset, function still
// UPSERTs schedule + venue rows with weather fields NULL (so scoring can
// degrade gracefully via score_weather_* = neutral 0).
//
// AUTH: service-role gated.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
function jsonResponse(d: unknown, s = 200) {
  return new Response(JSON.stringify(d, null, 2), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

const MLB_API = "https://statsapi.mlb.com/api/v1";
const OW_API = "https://api.openweathermap.org/data/2.5";

// MLB park -> lat/lon for OpenWeather lookups
//
// D-630 — synchronized with `_shared/mlb_venues.ts` (canonical reference
// for the team/venue mapping). Pre-D-630 had 4 stale names that caused
// weather to be silently NULL for those teams' home games:
//   - "Oakland Coliseum"      → Athletics moved to "Sutter Health Park" (Sacramento)
//   - "Guaranteed Rate Field" → White Sox renamed to "Rate Field"
//   - "Minute Maid Park"      → Astros renamed to "Daikin Park"
//   - "Dodger Stadium"        → Dodgers renamed to "UNIQLO Field at Dodger Stadium"
// All 4 modern names added below. Old names kept as aliases for any
// historical fetch-weather rows or upstream returning the legacy string.
const PARK_COORDS: Record<string, { lat: number; lon: number; indoor?: boolean }> = {
  "Angel Stadium":               { lat: 33.800, lon: -117.882 },
  "Busch Stadium":               { lat: 38.622, lon: -90.193 },
  "Camden Yards":                { lat: 39.284, lon: -76.622 },
  "Oriole Park at Camden Yards": { lat: 39.284, lon: -76.622 },
  "Chase Field":                 { lat: 33.445, lon: -112.067, indoor: true },
  "Citi Field":                  { lat: 40.757, lon: -73.846 },
  "Citizens Bank Park":          { lat: 39.906, lon: -75.166 },
  "Comerica Park":               { lat: 42.339, lon: -83.049 },
  "Coors Field":                 { lat: 39.756, lon: -104.994 },
  // D-630 — current Dodgers venue name. "Dodger Stadium" kept as alias below.
  "UNIQLO Field at Dodger Stadium": { lat: 34.074, lon: -118.240 },
  "Dodger Stadium":              { lat: 34.074, lon: -118.240 },
  "Fenway Park":                 { lat: 42.346, lon: -71.097 },
  "American Family Field":       { lat: 43.028, lon: -87.971, indoor: true },
  "Globe Life Field":            { lat: 32.747, lon: -97.083, indoor: true },
  "Great American Ball Park":    { lat: 39.097, lon: -84.507 },
  // D-630 — White Sox renamed Guaranteed Rate Field → Rate Field (2025).
  "Rate Field":                  { lat: 41.830, lon: -87.634 },
  "Guaranteed Rate Field":       { lat: 41.830, lon: -87.634 },
  "Kauffman Stadium":            { lat: 39.052, lon: -94.481 },
  // D-640 — Athletics off-site series in Las Vegas (2026; identified
  // from cache_mlb_game_scoreboard 6 missing-weather rows). Outdoor
  // park in Summerlin, NV.
  "Las Vegas Ballpark":          { lat: 36.115, lon: -115.330 },
  "loanDepot park":              { lat: 25.778, lon: -80.220, indoor: true },
  // D-630 — Astros renamed Minute Maid Park → Daikin Park (2025).
  "Daikin Park":                 { lat: 29.757, lon: -95.355, indoor: true },
  "Minute Maid Park":            { lat: 29.757, lon: -95.355, indoor: true },
  "Nationals Park":              { lat: 38.873, lon: -77.008 },
  // D-630 — Athletics moved Oakland Coliseum → Sutter Health Park (Sacramento, 2025).
  "Sutter Health Park":          { lat: 38.580, lon: -121.512 },
  "Oakland Coliseum":            { lat: 37.752, lon: -122.201 },
  "Oracle Park":                 { lat: 37.778, lon: -122.389 },
  "Petco Park":                  { lat: 32.708, lon: -117.157 },
  "PNC Park":                    { lat: 40.447, lon: -80.006 },
  "Progressive Field":           { lat: 41.496, lon: -81.685 },
  "Rogers Centre":               { lat: 43.641, lon: -79.389, indoor: true },
  "T-Mobile Park":                { lat: 47.591, lon: -122.332 },
  "Target Field":                { lat: 44.982, lon: -93.278 },
  "Tropicana Field":             { lat: 27.768, lon: -82.654, indoor: true },
  // D-630 — Rays at Steinbrenner Field for 2025 after Tropicana hurricane damage.
  "George M. Steinbrenner Field": { lat: 27.981, lon: -82.506 },
  "Steinbrenner Field":          { lat: 27.981, lon: -82.506 },
  "Truist Park":                 { lat: 33.890, lon: -84.468 },
  "Wrigley Field":               { lat: 41.948, lon: -87.655 },
  "Yankee Stadium":              { lat: 40.829, lon: -73.926 },
};

function bearingToCompass(deg: number): string {
  const dirs = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
  return dirs[Math.round(deg / 22.5) % 16];
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const SUPA_URL = Deno.env.get("SUPABASE_URL") ?? "";
  const SUPA_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const BACKFILL = Deno.env.get("BACKFILL_AUTH_TOKEN") ?? "";
  const OW_KEY = Deno.env.get("OPENWEATHER_API_KEY") ?? "";
  const auth = req.headers.get("Authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!bearer || (bearer !== BACKFILL && bearer !== SUPA_KEY)) return jsonResponse({ error: "unauthorized" }, 401);

  const today = new Date();
  const eastern = new Date(today.getTime() - 4 * 60 * 60 * 1000).toISOString().slice(0, 10);

  // Pull today's MLB schedule
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15_000);
  let sched: { dates?: Array<{ games: Array<{ gamePk: number; teams: { home: { team: { name: string } }; away: { team: { name: string } } }; status: { abstractGameState: string; detailedState?: string }; venue?: { name: string } }> }> } | null = null;
  try {
    const r = await fetch(`${MLB_API}/schedule?sportId=1&date=${eastern}&hydrate=venue`, { signal: ctl.signal });
    if (r.ok) sched = await r.json();
  } catch { /* swallow */ }
  finally { clearTimeout(t); }

  const games = sched?.dates?.[0]?.games ?? [];
  if (games.length === 0) return jsonResponse({ snapshot_date: eastern, games_attempted: 0, rows_upserted: 0, note: "no games on schedule" });

  const rows: Array<Record<string, unknown>> = [];
  let weatherFetched = 0;
  for (const g of games) {
    const venue = g.venue?.name ?? null;
    // D-300V SHIP 2 — read detailedState so Postponed games get
    // stored as "postponed" not "final". Pre-fix bug: MLB Stats
    // API returns abstractGameState="Final" + detailedState="Postponed"
    // for postponed games. Reading only abstract loses the distinction;
    // Dashboard showed postponed games as Final/with-no-scores.
    const detailedState = g.status?.detailedState ?? "";
    const abstractState = g.status?.abstractGameState ?? "Preview";
    const normalizedStatus = detailedState.toLowerCase() === "postponed"
      ? "postponed"
      : detailedState.toLowerCase() === "suspended"
        ? "suspended"
        : abstractState.toLowerCase();
    // D-324 SHIP 2 — fetch home plate umpire from boxscore.
    // Pre-fix bug: this column was hardcoded null on every row, blocking
    // score_umpire_k_zone from firing in production (D-323 trace).
    // For preview-status games, officials array is empty until MLB
    // announces; leave null and let next 4h tick fill it in.
    let umpireName: string | null = null;
    if (normalizedStatus !== "postponed" && normalizedStatus !== "suspended") {
      const uctl = new AbortController();
      const ut = setTimeout(() => uctl.abort(), 8_000);
      try {
        const br = await fetch(`${MLB_API}/game/${g.gamePk}/boxscore`, { signal: uctl.signal });
        if (br.ok) {
          const bx = await br.json() as { officials?: Array<{ officialType?: string; official?: { fullName?: string } }> };
          const hp = (bx.officials ?? []).find(o => o.officialType === "Home Plate");
          if (hp?.official?.fullName) umpireName = hp.official.fullName;
        }
      } catch { /* swallow per-game */ }
      finally { clearTimeout(ut); }
    }

    const row: Record<string, unknown> = {
      game_id: g.gamePk,
      game_date: eastern,
      home_team: g.teams.home.team.name,
      away_team: g.teams.away.team.name,
      home_score: null,
      away_score: null,
      status: normalizedStatus,
      venue,
      weather_temp_f: null,
      weather_wind_speed: null,
      weather_wind_dir: null,
      weather_wind_dir_deg: null,  // D-287 SHIP 1
      weather_condition: null,
      umpire_name: umpireName,
      // D-300V SHIP 2 — explicit fetched_at so upsert merge-duplicates
      // refreshes the value. DB default now() only triggers on INSERT,
      // not on UPSERT-merge UPDATE, so existing rows kept stale
      // fetched_at (e.g., pk=824840 carried 2026-05-23T15:00 into the
      // May 24 doubleheader cycle).
      fetched_at: new Date().toISOString(),
    };

    // D-287 SHIP 1: Enrich with weather. OpenWeather (paid) → Open-Meteo
    // (free, no API key) fallback. Open-Meteo returns wind direction in
    // raw degrees, populating new weather_wind_dir_deg column.
    const coord = venue ? PARK_COORDS[venue] : undefined;
    if (coord && !coord.indoor) {
      const wctl = new AbortController();
      const wt = setTimeout(() => wctl.abort(), 10_000);
      try {
        if (OW_KEY) {
          const wr = await fetch(`${OW_API}/weather?lat=${coord.lat}&lon=${coord.lon}&appid=${OW_KEY}&units=imperial`, { signal: wctl.signal });
          if (wr.ok) {
            const w = await wr.json() as { main?: { temp?: number }; wind?: { speed?: number; deg?: number }; weather?: Array<{ main?: string }> };
            if (w.main?.temp !== undefined) row.weather_temp_f = Math.round(w.main.temp);
            if (w.wind?.speed !== undefined) row.weather_wind_speed = Math.round(w.wind.speed);
            if (w.wind?.deg !== undefined) {
              row.weather_wind_dir = bearingToCompass(w.wind.deg);
              row.weather_wind_dir_deg = Math.round(w.wind.deg);
            }
            if (w.weather?.[0]?.main) row.weather_condition = w.weather[0].main;
            weatherFetched++;
          }
        } else {
          // D-287 — Open-Meteo fallback (free, no API key required).
          // D-640 — single retry on transient failure (the previous
          // single-shot pattern left ~25% of outdoor games per day with
          // null weather when Open-Meteo intermittently returned 5xx
          // or timed out, per V5 trace. One retry typically clears it.
          const omUrl = `https://api.open-meteo.com/v1/forecast?latitude=${coord.lat}&longitude=${coord.lon}&current=temperature_2m,wind_speed_10m,wind_direction_10m,weathercode&temperature_unit=fahrenheit&wind_speed_unit=mph`;
          let wr: Response | null = null;
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              const r1 = await fetch(omUrl, { signal: wctl.signal });
              if (r1.ok) { wr = r1; break; }
            } catch (_e) {
              // network / abort — retry once
            }
            if (attempt === 0) await new Promise((res) => setTimeout(res, 500));
          }
          if (wr && wr.ok) {
            const w = await wr.json() as { current?: { temperature_2m?: number; wind_speed_10m?: number; wind_direction_10m?: number; weathercode?: number } };
            const c = w.current ?? {};
            if (typeof c.temperature_2m === "number") row.weather_temp_f = Math.round(c.temperature_2m);
            if (typeof c.wind_speed_10m === "number") row.weather_wind_speed = Math.round(c.wind_speed_10m);
            if (typeof c.wind_direction_10m === "number") {
              row.weather_wind_dir = bearingToCompass(c.wind_direction_10m);
              row.weather_wind_dir_deg = Math.round(c.wind_direction_10m);
            }
            // Map WMO weather codes to coarse condition strings
            if (typeof c.weathercode === "number") {
              const wc = c.weathercode;
              row.weather_condition =
                wc === 0 ? "Clear"
                : wc <= 3 ? "Clouds"
                : wc <= 48 ? "Fog"
                : wc <= 67 ? "Rain"
                : wc <= 77 ? "Snow"
                : wc <= 82 ? "Rain"
                : "Clear";
            }
            weatherFetched++;
          }
        }
      } catch { /* swallow per-game */ }
      finally { clearTimeout(wt); }
    } else if (coord?.indoor) {
      row.weather_condition = "indoor";
    }

    rows.push(row);
  }

  const r = await fetch(`${SUPA_URL}/rest/v1/cache_mlb_game_scoreboard?on_conflict=game_id`, {
    method: "POST",
    headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
    body: JSON.stringify(rows),
  });
  const upserts = r.ok ? rows.length : 0;
  const err = r.ok ? null : (await r.text()).slice(0, 300);
  return jsonResponse({ snapshot_date: eastern, games_attempted: games.length, weather_fetched: weatherFetched, rows_upserted: upserts, openweather_configured: !!OW_KEY, error: err });
});
