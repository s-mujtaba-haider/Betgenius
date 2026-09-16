// rescore-backfill-picks — D-186 Phase 4 (May 15, 2026, CEO §19.3).
//
// Re-scores existing backfill-historical pick_history rows. Applies the
// dominant deltas from the D-187/D-188/D-189 + D-186-Phase-1/2/3 stack
// WITHOUT re-running scoreOneSide end-to-end. Rationale: the BDL-heavy
// full-rerun approach exceeds the 150s edge function ceiling (~80 unique
// players × ~1.5s BDL pacing > 150s). Delta-only approach reads ONLY the
// already-populated cache, runs in <30s per date, and captures the two
// signals that actually changed:
//
//   1) score_stale_data delta: +67 (always).
//      Pre-D-187: every backfill pick had staleDataPenalty = -30 because
//      helpers.asOfDate defaulted to new Date() (today) → daysSinceLastGame
//      against 2024 game logs = 500+ days → -30 bucket. With weight 2.25,
//      this contributed Math.round(-30 × 2.25) = -67 per pick.
//      Post-D-187: asOfDate threaded as game_date → daysSinceLastGame ~= 1-3
//      days → bucket = 0. Contribution = 0. Reversal delta = +67.
//
//   2) score_opp_defense delta: calculatePaceDefenseScores(oppStats, prop,
//      pickSide, playerPosition).defenseScore × w_opp_defense.
//      Pre-D-189: w_opp_defense = 0.0 → contribution = 0 regardless.
//      Post-D-189: w_opp_defense = 1.0 → contribution = newScore × 1.0.
//      oppStats now reads cache_opponent_defensive_stats + cache_team_
//      advanced_stats_by_position with nearest-prior fallback.
//
// new_confidence = clamp(0..100, old_confidence + 67 + new_score_opp_defense)
// new_score_stale_data := 0
// new_score_opp_defense := computed value
// confidence_pre_d186_phase4 := old_confidence (set once)
//
// AUTH: service-role gated.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  type OpponentStats, calculatePaceDefenseScores, getScoreLabel,
  loadWeightsFromDB,
} from "../_shared/scoring.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

const SUPA_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SUPA_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

// Read OpponentStats from cache for (opp_team_name, snapshot_date). Mirrors
// the readOpponentStatsFromCache pattern. Includes nearest-prior fallback
// when exact-date row absent (D-186 Phase 3 covers only 37/55 historical
// dates due to BDL throttling; missing dates degrade to nearest-prior).
async function readOpponentStatsFromCache(opponentName: string, snapshotDate: string): Promise<OpponentStats | null> {
  if (!opponentName) return null;
  try {
    const baseUrl = `${SUPA_URL}/rest/v1/cache_opponent_defensive_stats?` +
      `team_name=eq.${encodeURIComponent(opponentName)}&sport=eq.nba` +
      `&select=ppg_allowed,rpg_allowed,apg_allowed,fg_pct_allowed,three_pct_allowed,pace,net_rating,def_rating,rpg_allowed_bdl,apg_allowed_bdl,snapshot_date`;
    let res = await fetch(`${baseUrl}&snapshot_date=eq.${snapshotDate}&limit=1`, {
      headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` },
    });
    let rows = res.ok ? await res.json() : [];
    if (!Array.isArray(rows) || rows.length === 0) {
      res = await fetch(`${baseUrl}&snapshot_date=lte.${snapshotDate}&order=snapshot_date.desc&limit=1`, {
        headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` },
      });
      rows = res.ok ? await res.json() : [];
    }
    if (!Array.isArray(rows) || rows.length === 0) return null;
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
      oppOwnTurnovers: 0, oppOwnSteals: 0, oppOwnBlocks: 0,
      oppOwnTwoPtFGPct: 0, oppOwnThreePtFGPct: 0, oppOwnFGPct: 0,
      oppPaceFactor: 0,
    };
    // D-186 per-position lookups: team_metadata abbr lookup then by-position rows
    try {
      const tmUrl = `${SUPA_URL}/rest/v1/cache_team_metadata?team_name=eq.${encodeURIComponent(opponentName)}&sport=eq.nba&select=abbreviation&limit=1`;
      const tmRes = await fetch(tmUrl, { headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` } });
      const tmRows = tmRes.ok ? await tmRes.json() : [];
      const abbr = Array.isArray(tmRows) && tmRows[0]?.abbreviation;
      if (abbr) {
        const posUrl = `${SUPA_URL}/rest/v1/cache_team_advanced_stats_by_position?` +
          `team_abbr=eq.${encodeURIComponent(abbr)}&sport=eq.nba` +
          `&snapshot_date=lte.${snapshotDate}&order=snapshot_date.desc&limit=10` +
          `&select=position,defensive_rating,defensive_rebound_percentage,assist_percentage,snapshot_date`;
        const posRes = await fetch(posUrl, { headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` } });
        let posRows: Array<{ position: string; defensive_rating: number | null; defensive_rebound_percentage: number | null; assist_percentage: number | null; snapshot_date: string }>
          = posRes.ok ? await posRes.json() : [];
        if (Array.isArray(posRows) && posRows.length > 0) {
          const latest = posRows[0].snapshot_date;
          posRows = posRows.filter((p) => p.snapshot_date === latest);
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
        }
      }
    } catch (_e) { /* graceful degradation */ }
    return stats;
  } catch (_e) {
    return null;
  }
}

// cache_player_metadata: player_name → position (best-effort). NULL fallback
// is fine — calculatePaceDefenseScores treats missing position as pre-D-186
// behavior (no position-aware refinement).
async function readPlayerPositionFromCache(playerName: string): Promise<string | null> {
  try {
    const url = `${SUPA_URL}/rest/v1/cache_player_metadata?player_name=eq.${encodeURIComponent(playerName)}&select=position&limit=1`;
    const res = await fetch(url, { headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` } });
    if (!res.ok) return null;
    const rows = await res.json();
    return (Array.isArray(rows) && rows[0]?.position) || null;
  } catch (_e) {
    return null;
  }
}

interface PickRow {
  id: string;
  player_name: string;
  team: string;
  game_date: string;
  prop_type: string;
  pick_side: string;
  line: number;
  confidence: number;
  is_home: boolean;
  confidence_pre_d186_phase4: number | null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const startMs = Date.now();

  if (!SUPA_URL || !SUPA_KEY) return jsonResponse({ success: false, error: "SUPABASE env missing" }, 500);

  // Service-role auth gate
  const auth = req.headers.get("authorization") || "";
  const customToken = Deno.env.get("BACKFILL_AUTH_TOKEN") || "";
  const matches = (SUPA_KEY && auth.includes(SUPA_KEY)) || (customToken && auth.includes(customToken));
  if (!matches) return jsonResponse({ success: false, error: "service_role key required" }, 401);

  let body: { start_date?: string; end_date?: string; dry_run?: boolean; limit?: number; date?: string } = {};
  try { body = await req.json(); } catch { /* empty body OK */ }
  const startDate = body.start_date || body.date || "2024-10-22";
  const endDate   = body.end_date   || body.date || "2024-12-31";
  const dryRun = body.dry_run ?? false;
  const limit = body.limit ?? 9999;

  // 1. Pull pick rows in window.
  const pickUrl = `${SUPA_URL}/rest/v1/pick_history?source=eq.backfill-historical` +
    `&game_date=gte.${startDate}&game_date=lte.${endDate}` +
    `&select=id,player_name,team,game_date,prop_type,pick_side,line,confidence,is_home,confidence_pre_d186_phase4` +
    `&order=game_date.asc&limit=${limit}`;
  const pickRes = await fetch(pickUrl, { headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, Range: "0-9999", "Range-Unit": "items" } });
  if (!pickRes.ok) return jsonResponse({ success: false, error: `pick_history fetch failed status=${pickRes.status}` }, 500);
  const picks: PickRow[] = await pickRes.json();

  // 2. Load weights (D-189 active: w_opp_defense = 1.0)
  const weights = await loadWeightsFromDB();
  const wOppDefense = weights.oppDefense;
  const wStaleData = weights.staleData;

  // 3. Memoize oppStats reads + player position reads.
  const oppStatsCache = new Map<string, OpponentStats | null>();
  const playerPosCache = new Map<string, string | null>();

  // 4. Iterate picks. Lookup opponent via cache_game_scoreboard if present;
  // otherwise infer from team metadata (best effort — opp not strictly needed
  // for the stale fix, only for the opp_defense refinement).
  const summary = {
    total: picks.length,
    rescored: 0,
    update_failures: 0,
    skipped_no_change: 0,
    dry_run: dryRun,
    opp_defense_signal_count: 0,
  };
  const preTiers: Record<string, number> = { elite: 0, strong: 0, good: 0, lean: 0, pass: 0 };
  const postTiers: Record<string, number> = { elite: 0, strong: 0, good: 0, lean: 0, pass: 0 };
  const tierOf = (c: number) =>
    c >= 90 ? "elite" : c >= 80 ? "strong" : c >= 70 ? "good" : c >= 60 ? "lean" : "pass";
  const errors: string[] = [];

  for (const pick of picks) {
    preTiers[tierOf(pick.confidence)]++;

    // Get player position (memoized)
    if (!playerPosCache.has(pick.player_name)) {
      playerPosCache.set(pick.player_name, await readPlayerPositionFromCache(pick.player_name));
    }
    const playerPosition = playerPosCache.get(pick.player_name) ?? null;

    // For oppStats we'd ideally key by opp_team name. The pick row has
    // pick.team (player's team) but not opponent. Lookup opponent from
    // cache_game_scoreboard for (pick.team, pick.game_date). If miss, skip
    // opp_defense delta (stale-data delta still applies).
    let oppStats: OpponentStats | null = null;
    const scoreboardUrl = `${SUPA_URL}/rest/v1/cache_game_scoreboard?game_date=eq.${pick.game_date}&sport=eq.nba` +
      `&or=(home_team.eq.${encodeURIComponent(pick.team)},away_team.eq.${encodeURIComponent(pick.team)})` +
      `&select=home_team,away_team&limit=1`;
    try {
      const sbRes = await fetch(scoreboardUrl, { headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}` } });
      if (sbRes.ok) {
        const sbRows: Array<{ home_team: string; away_team: string }> = await sbRes.json();
        if (Array.isArray(sbRows) && sbRows.length > 0) {
          const oppName = sbRows[0].home_team === pick.team ? sbRows[0].away_team : sbRows[0].home_team;
          const ck = `${oppName}|${pick.game_date}`;
          if (!oppStatsCache.has(ck)) oppStatsCache.set(ck, await readOpponentStatsFromCache(oppName, pick.game_date));
          oppStats = oppStatsCache.get(ck) ?? null;
        }
      }
    } catch (_e) { /* graceful degradation */ }

    // Compute new score_opp_defense via calculatePaceDefenseScores
    const { defenseScore: newDefScore } = oppStats
      ? calculatePaceDefenseScores(oppStats, pick.prop_type, pick.pick_side as "over" | "under", playerPosition)
      : { defenseScore: 0 };
    if (newDefScore !== 0) summary.opp_defense_signal_count++;

    // Compute new confidence: old + stale delta + opp_defense delta
    // - stale delta: +67 universal (Math.round(-30 × 2.25) = -67 reversed)
    // - opp_defense delta: newDefScore × wOppDefense - 0 × 0.0 = newDefScore × wOppDefense
    const deltaStale = -1 * Math.round(-30 * wStaleData); // = +52 with wStaleData=1.75
    const deltaOppDef = Math.round(newDefScore * wOppDefense);
    // D-190 idempotency fix: derive from the ORIGINAL confidence (audit
    // column) when available, not from the current value. Without this,
    // re-running the rescore on a date double-applies the delta (52→104→100),
    // inflating picks to clamped 100. Audit column is set on first rescore
    // and never overwritten, so it's the stable basis for deterministic
    // re-derivation.
    const baseConfidence = pick.confidence_pre_d186_phase4 ?? pick.confidence;
    const newConfidence = Math.max(0, Math.min(100, baseConfidence + deltaStale + deltaOppDef));
    postTiers[tierOf(newConfidence)]++;

    if (newConfidence === pick.confidence && newDefScore === 0) {
      summary.skipped_no_change++;
      continue;
    }
    summary.rescored++;
    if (dryRun) continue;

    const updates: Record<string, unknown> = {
      confidence: newConfidence,
      verdict: getScoreLabel(newConfidence),
      score_stale_data: 0,
      score_opp_defense: newDefScore,
    };
    if (pick.confidence_pre_d186_phase4 === null || pick.confidence_pre_d186_phase4 === undefined) {
      updates.confidence_pre_d186_phase4 = pick.confidence;
    }
    const upRes = await fetch(
      `${SUPA_URL}/rest/v1/pick_history?id=eq.${pick.id}`,
      {
        method: "PATCH",
        headers: { apikey: SUPA_KEY, Authorization: `Bearer ${SUPA_KEY}`, "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify(updates),
      },
    );
    if (!upRes.ok) {
      summary.update_failures++;
      const txt = await upRes.text();
      errors.push(`${pick.id} update-failed: ${upRes.status} ${txt.slice(0, 120)}`);
    }
  }

  const durationMs = Date.now() - startMs;
  return jsonResponse({
    success: true,
    range: { start_date: startDate, end_date: endDate },
    duration_ms: durationMs,
    summary,
    pre_tiers: preTiers,
    post_tiers: postTiers,
    sample_errors: errors.slice(0, 5),
  });
});
