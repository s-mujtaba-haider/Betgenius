// D-653 SHIP 2 — fetch Baseball Savant team-level OAA + upsert cache_mlb_team_oaa.
//
// Source CSV: https://baseballsavant.mlb.com/leaderboard/outs_above_average?type=Fielding_Team&year={YYYY}&csv=true
// Returns 30 rows (all teams). Free, no auth, no rate limit observed at daily cadence.
//
// Run cadence: daily at 10:00 UTC (before the 13:00 UTC scoring-window opens).
// This fn is idempotent — upserts per (team_id, snapshot_date) primary key, so
// re-running on the same day overwrites that day's snapshot harmlessly.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

// Savant team-name shortcuts → canonical MLB Stats API team names.
const TEAM_NAME_MAP: Record<string, string> = {
  "Angels": "Los Angeles Angels",
  "Astros": "Houston Astros",
  "Athletics": "Athletics",
  "Blue Jays": "Toronto Blue Jays",
  "Braves": "Atlanta Braves",
  "Brewers": "Milwaukee Brewers",
  "Cardinals": "St. Louis Cardinals",
  "Cubs": "Chicago Cubs",
  "D-backs": "Arizona Diamondbacks",
  "Dodgers": "Los Angeles Dodgers",
  "Giants": "San Francisco Giants",
  "Guardians": "Cleveland Guardians",
  "Mariners": "Seattle Mariners",
  "Marlins": "Miami Marlins",
  "Mets": "New York Mets",
  "Nationals": "Washington Nationals",
  "Orioles": "Baltimore Orioles",
  "Padres": "San Diego Padres",
  "Phillies": "Philadelphia Phillies",
  "Pirates": "Pittsburgh Pirates",
  "Rangers": "Texas Rangers",
  "Rays": "Tampa Bay Rays",
  "Red Sox": "Boston Red Sox",
  "Reds": "Cincinnati Reds",
  "Rockies": "Colorado Rockies",
  "Royals": "Kansas City Royals",
  "Tigers": "Detroit Tigers",
  "Twins": "Minnesota Twins",
  "White Sox": "Chicago White Sox",
  "Yankees": "New York Yankees",
};

function parseSuccessRate(s: string | undefined | null): number | null {
  if (!s) return null;
  const m = s.match(/(-?\d+(?:\.\d+)?)\s*%/);
  if (!m) return null;
  return Number(m[1]) / 100;
}

function parseCsvLine(line: string): string[] {
  // Robust enough for this CSV: handles "quoted, fields" and commas inside.
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (c === "," && !inQ) {
      out.push(cur); cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out.map(s => s.trim());
}

Deno.serve(async (_req) => {
  const tStart = Date.now();
  const year = new Date().getUTCFullYear();
  const url = `https://baseballsavant.mlb.com/leaderboard/outs_above_average?type=Fielding_Team&year=${year}&csv=true`;
  const today = new Date().toISOString().slice(0, 10);

  let csvText = "";
  try {
    const res = await fetch(url, { headers: { "User-Agent": "betgenius-d653/1.0" } });
    if (!res.ok) {
      return new Response(JSON.stringify({ success: false, error: `savant ${res.status}` }), { status: 500 });
    }
    csvText = await res.text();
  } catch (e) {
    return new Response(JSON.stringify({ success: false, error: String(e) }), { status: 500 });
  }

  // Strip BOM if present.
  if (csvText.charCodeAt(0) === 0xFEFF) csvText = csvText.slice(1);
  const lines = csvText.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) {
    return new Response(JSON.stringify({ success: false, error: "empty csv" }), { status: 500 });
  }
  const header = parseCsvLine(lines[0]).map(h => h.replace(/^"|"$/g, ""));
  const idx = (name: string) => header.indexOf(name);
  const i_team = idx("team_name");
  const i_id = idx("team_id");
  const i_year = idx("year");
  const i_oaa = idx("outs_above_average");
  const i_infront = idx("outs_above_average_infront");
  const i_lat3 = idx("outs_above_average_lateral_toward3bline");
  const i_lat1 = idx("outs_above_average_lateral_toward1bline");
  const i_behind = idx("outs_above_average_behind");
  const i_rhh = idx("outs_above_average_rhh");
  const i_lhh = idx("outs_above_average_lhh");
  const i_actual = idx("actual_success_rate_formatted");
  const i_expected = idx("adj_estimated_success_rate_formatted");
  const i_diff = idx("diff_success_rate_formatted");

  const rows: Array<Record<string, unknown>> = [];
  for (let li = 1; li < lines.length; li++) {
    const c = parseCsvLine(lines[li]);
    if (c.length < 5) continue;
    const teamShort = c[i_team]?.replace(/^"|"$/g, "");
    const teamId = Number(c[i_id]?.replace(/^"|"$/g, ""));
    if (!teamShort || !teamId) continue;
    rows.push({
      team_name: teamShort,
      team_id: teamId,
      full_team_name: TEAM_NAME_MAP[teamShort] ?? null,
      snapshot_date: today,
      year: Number(c[i_year]?.replace(/^"|"$/g, "")) || year,
      oaa: Number(c[i_oaa]) || 0,
      oaa_infront: Number(c[i_infront]),
      oaa_lateral_to_3b: Number(c[i_lat3]),
      oaa_lateral_to_1b: Number(c[i_lat1]),
      oaa_behind: Number(c[i_behind]),
      oaa_vs_rhh: Number(c[i_rhh]),
      oaa_vs_lhh: Number(c[i_lhh]),
      actual_success_rate: parseSuccessRate(c[i_actual]?.replace(/^"|"$/g, "")),
      expected_success_rate: parseSuccessRate(c[i_expected]?.replace(/^"|"$/g, "")),
      diff_success_rate: parseSuccessRate(c[i_diff]?.replace(/^"|"$/g, "")),
    });
  }

  // Upsert via PostgREST.
  const upsertUrl = `${SUPABASE_URL}/rest/v1/cache_mlb_team_oaa?on_conflict=team_id,snapshot_date`;
  const upRes = await fetch(upsertUrl, {
    method: "POST",
    headers: {
      "apikey": SERVICE_KEY,
      "Authorization": `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(rows),
  });
  if (!upRes.ok) {
    const body = await upRes.text();
    return new Response(JSON.stringify({ success: false, error: `upsert ${upRes.status}: ${body.slice(0, 300)}` }), { status: 500 });
  }

  return new Response(JSON.stringify({
    success: true,
    rows_upserted: rows.length,
    teams_mapped: rows.filter(r => r.full_team_name).length,
    teams_unmapped: rows.filter(r => !r.full_team_name).length,
    duration_ms: Date.now() - tStart,
    snapshot_date: today,
  }), { headers: { "Content-Type": "application/json" } });
});
