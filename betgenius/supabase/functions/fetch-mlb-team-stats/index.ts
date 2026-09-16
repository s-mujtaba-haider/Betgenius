// fetch-mlb-team-stats — D-204 Batch 3 Task 3.0.
// Daily writer for cache_team_batting_stats. Source: MLB Stats API.
// Cron: jobid 19, daily 12:30 UTC.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
function jsonResponse(d: unknown, s = 200) {
  return new Response(JSON.stringify(d, null, 2), { status: s, headers: { ...corsHeaders, "Content-Type": "application/json" } });
}

const MLB_API = "https://statsapi.mlb.com/api/v1";
const GAP_MS = 600;
let lastMs = 0;

async function mlbFetch<T>(path: string): Promise<T | null> {
  const wait = Math.max(0, GAP_MS - (Date.now() - lastMs));
  if (wait) await new Promise((r) => setTimeout(r, wait));
  lastMs = Date.now();
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15_000);
  try {
    const r = await fetch(`${MLB_API}${path}`, { signal: ctl.signal });
    if (!r.ok) return null;
    return await r.json() as T;
  } catch { return null; }
  finally { clearTimeout(t); }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const SUPA_URL = Deno.env.get("SUPABASE_URL") ?? "";
  const SUPA_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const BACKFILL = Deno.env.get("BACKFILL_AUTH_TOKEN") ?? "";

  // D-214 Fix 2 — error_log instrumentation.
  async function elog(phase: string, errorType: string, message: string, context: Record<string, unknown> = {}) {
    try {
      if (!SUPA_URL || !SUPA_KEY) return;
      await fetch(`${SUPA_URL}/rest/v1/error_log`, {
        method: "POST",
        headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify({ function_name: "fetch-mlb-team-stats", phase, error_type: errorType, error_message: message, context }),
      });
    } catch { /* swallow */ }
  }

  const auth = req.headers.get("Authorization") ?? "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!bearer || (bearer !== BACKFILL && bearer !== SUPA_KEY)) {
    await elog("auth", "unauthorized", "missing or wrong Bearer token", { bearer_prefix: bearer.slice(0, 8) });
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  // D-262 dry-run gate: parse body.dry_run.
  let dryRun = false;
  if (req.method === "POST") {
    try {
      const body = await req.json();
      if (body?.dry_run === true) dryRun = true;
    } catch { /* empty body ok */ }
  }

  const t0 = Date.now();
  const today = new Date();
  const eastern = new Date(today.getTime() - 4 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const season = new Date(eastern + "T12:00:00Z").getFullYear();

  if (dryRun) {
    return jsonResponse({
      dry_run: true,
      snapshot_date: eastern,
      would_write: {
        cache_team_batting_stats: null,  // unknown without hitting MLB Stats API (~30 teams expected)
        error_log: 0,
      },
      note: "fetch-mlb-team-stats skipped MLB Stats API + writes entirely",
      elapsed_ms: Date.now() - t0,
    });
  }

  // Get all 30 MLB teams
  const teamsRes = await mlbFetch<{ teams: Array<{ id: number; name: string }> }>(`/teams?sportId=1`);
  if (!teamsRes?.teams) {
    await elog("teams_list", "http_error", "MLB Stats API /teams?sportId=1 returned no teams", { eastern });
    return jsonResponse({ error: "teams fetch failed" }, 502);
  }
  const teams = teamsRes.teams.filter((t) => t.id < 1000); // MLB teams (filter affiliates)

  const rows: Array<Record<string, unknown>> = [];
  let processed = 0;
  for (const team of teams) {
    // D-562 — fetch BOTH hitting + pitching season stats in parallel so we
    // can populate runs_allowed_per_game (was silently NULL/default-4.5
    // per D-550 §B.4). hitting gives runs scored; pitching gives runs
    // allowed (`runs` on the pitching endpoint is total runs allowed).
    // D-666 SHIP 2b — also fetch hitting splits vs LHP/RHP to populate
    // vs_lhp_k_rate + vs_rhp_k_rate (NULL pre-D-666 → score_handedness_matchup
    // factor never fired). Probe (2026-06-21): vl/vr splits give PA + K.
    const [hitStats, pitchStats, vsHandSplits] = await Promise.all([
      mlbFetch<{ stats: Array<{ splits: Array<{ stat: Record<string, unknown> }> }> }>(
        `/teams/${team.id}/stats?stats=season&group=hitting&season=${season}`,
      ),
      mlbFetch<{ stats: Array<{ splits: Array<{ stat: Record<string, unknown> }> }> }>(
        `/teams/${team.id}/stats?stats=season&group=pitching&season=${season}`,
      ),
      mlbFetch<{ stats: Array<{ splits: Array<{ split: { code?: string }; stat: Record<string, unknown> }> }> }>(
        `/teams/${team.id}/stats?stats=statSplits&group=hitting&sitCodes=vl,vr&season=${season}&sportIds=1`,
      ),
    ]);
    const stat = hitStats?.stats?.[0]?.splits?.[0]?.stat;
    if (!stat) continue;
    const pitchStat = pitchStats?.stats?.[0]?.splits?.[0]?.stat ?? null;
    const pa = Number(stat.plateAppearances ?? 0);
    const k = Number(stat.strikeOuts ?? 0);
    const kRate = pa > 0 ? Math.round((k / pa) * 1000) / 1000 : 0;
    // D-562 — runs_allowed_per_game from pitching endpoint. Pitching stat
    // `runs` is total earned + unearned runs allowed; `gamesPlayed` is the
    // team's games played (same value as hitting). Fallback null if the
    // pitching call failed so we don't poison the cache.
    let runsAllowedPerGame: number | null = null;
    if (pitchStat) {
      const pitchGP = Number(pitchStat.gamesPlayed ?? 0);
      const runsAllowed = Number(pitchStat.runs ?? 0);
      if (pitchGP > 0) {
        runsAllowedPerGame = Math.round((runsAllowed / pitchGP) * 100) / 100;
      }
    }
    // D-666 SHIP 2b — extract vs_lhp/vs_rhp K rates from the statSplits payload.
    let vsLhpKRate: number | null = null;
    let vsRhpKRate: number | null = null;
    const splits = vsHandSplits?.stats?.[0]?.splits ?? [];
    for (const sp of splits) {
      const code = sp?.split?.code;
      const stat = sp?.stat ?? {};
      const pa = Number(stat.plateAppearances ?? 0);
      const k = Number(stat.strikeOuts ?? 0);
      if (pa <= 0) continue;
      const rate = Math.round((k / pa) * 1000) / 1000;
      if (code === "vl") vsLhpKRate = rate;
      else if (code === "vr") vsRhpKRate = rate;
    }
    // D-664 — pull slg, avg, homeRuns, atBats from the SAME hitting payload.
    // ISO = SLG − AVG (true isolated power). Zero new HTTP.
    const slgSeason = stat.slg !== undefined && stat.slg !== null ? Number(stat.slg) : null;
    const avgSeason = stat.avg !== undefined && stat.avg !== null ? Number(stat.avg) : null;
    const isoSeason = (slgSeason !== null && avgSeason !== null) ? Math.round((slgSeason - avgSeason) * 1000) / 1000 : null;
    const homeRunsTotal = stat.homeRuns !== undefined && stat.homeRuns !== null ? Number(stat.homeRuns) : null;
    const atBatsTotal = stat.atBats !== undefined && stat.atBats !== null ? Number(stat.atBats) : null;
    // D-668 — opponent-patience / pitch-burden signals from SAME hitting payload.
    // Zero new HTTP. Drives 3 new pitcher_outs factors:
    //   bb_rate (baseOnBalls / PA) → score_opp_walk_rate
    //   obp_season (.obp) → score_opp_obp_patience
    //   pitches_per_pa (numberOfPitches / PA) → score_opp_pitch_grind
    const baseOnBalls = stat.baseOnBalls !== undefined && stat.baseOnBalls !== null ? Number(stat.baseOnBalls) : null;
    const obpSeason = stat.obp !== undefined && stat.obp !== null ? Number(stat.obp) : null;
    const numberOfPitches = stat.numberOfPitches !== undefined && stat.numberOfPitches !== null ? Number(stat.numberOfPitches) : null;
    const bbRate = (baseOnBalls !== null && pa > 0) ? Math.round((baseOnBalls / pa) * 1000) / 1000 : null;
    const pitchesPerPa = (numberOfPitches !== null && pa > 0) ? Math.round((numberOfPitches / pa) * 100) / 100 : null;
    rows.push({
      team_name: team.name, sport: "mlb", snapshot_date: eastern,
      games_played: Number(stat.gamesPlayed ?? 0),
      plate_appearances: pa, strikeouts: k, k_rate: kRate,
      // D-666 SHIP 2b — populated from statSplits sitCodes=vl,vr.
      vs_lhp_k_rate: vsLhpKRate, vs_rhp_k_rate: vsRhpKRate,
      runs_per_game: Number(stat.gamesPlayed) > 0 ? Math.round((Number(stat.runs ?? 0) / Number(stat.gamesPlayed)) * 100) / 100 : 0,
      runs_allowed_per_game: runsAllowedPerGame,  // D-562
      ops_l10: null, ops_season: Number(stat.ops ?? 0),
      // D-664 — ISO/SLG/AVG.
      slg_season: slgSeason, avg_season: avgSeason, iso_season: isoSeason,
      home_runs: homeRunsTotal, at_bats: atBatsTotal,
      // D-668 — opponent-patience / pitch-burden cols for pitcher_outs scorer.
      bb_rate: bbRate, obp_season: obpSeason, pitches_per_pa: pitchesPerPa,
    });
    processed++;
  }

  let upserts = 0;
  if (rows.length > 0) {
    const r = await fetch(`${SUPA_URL}/rest/v1/cache_team_batting_stats?on_conflict=team_name,sport,snapshot_date`, {
      method: "POST",
      headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(rows),
    });
    if (r.ok) upserts = rows.length;
    else {
      const errBody = await r.text();
      await elog("upsert", "http_error", `cache_team_batting_stats POST status=${r.status}: ${errBody.slice(0, 300)}`, { eastern, rows_attempted: rows.length });
    }
  }
  if (teams.length > 0 && processed === 0) {
    await elog("scoring", "zero_processed", `attempted ${teams.length} teams, processed 0`, { eastern });
  }
  return jsonResponse({ snapshot_date: eastern, teams_attempted: teams.length, teams_processed: processed, rows_upserted: upserts });
});
