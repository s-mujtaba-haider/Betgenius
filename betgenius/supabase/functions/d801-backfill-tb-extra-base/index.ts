// D-801 — Point-in-time backfill of D-797's 4 extra-base factors on the
// D-789 consistent-model TB cohort, so D-798 can re-tune NOW (not wait 14
// days).
//
// IMPORTS the real scorer (scoreBatterTotalBases) — does NOT re-implement
// the D-797 factor logic. The Statcast cache has daily snapshots
// (cache_statcast_batters_xstats / _exit_velo) with snapshot_date column,
// allowing point-in-time lookup.
//
// LEAKAGE PROOF: filter is snapshot_date < pick.game_date STRICTLY.
// The pick's game_date is the day the player's at-bats happened. The
// snapshot taken on snapshot_date X reflects all batted balls THROUGH
// X (i.e., games completed by end-of-day X). For a pick on game_date Y:
//   - snapshot_date = Y-1: stats through Y-1 night games (player hasn't
//     yet played Y's game) → SAFE
//   - snapshot_date = Y: stats through Y night games (player HAS played
//     Y's game) → LEAKAGE
// The strict `<` filter ensures we never use snapshot_date = Y for a
// pick whose outcome is the Y game.
//
// Scope: TB market only, D-789 consistent-model cohort (created_at
// 2026-06-13 → 2026-06-25T12:20:08Z, hit IS NOT NULL, voided=false).
//
// Run: POST {} (no args) or {limit: N, dry_run: true} for testing.

import { scoreBatterTotalBases, type BatterScoringContext } from "../_shared/scoring_mlb_v2.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";

const supaHeaders = (): Record<string, string> => ({
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
});

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface Pick {
  id: string;
  player_id: number | null;
  player_name: string;
  game_date: string;   // 'YYYYMMDD' format
  pick_side: "over" | "under";
  line: number;
  odds: number;
}

interface XstatsRow {
  player_id: number;
  snapshot_date: string;
  est_woba: number | null;
  est_woba_minus_woba_diff: number | null;
  est_ba: number | null;
  est_slg: number | null;
  est_slg_minus_slg_diff: number | null;
}

interface ExitVeloRow {
  player_id: number;
  snapshot_date: string;
  ev95percent: number | null;
  avg_hit_speed: number | null;
  avg_hit_angle: number | null;
  anglesweetspotpercent: number | null;
  brl_pa: number | null;
  brl_percent: number | null;
}

function ymdToIsoDate(ymd: string): string {
  if (ymd.length === 8) return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;
  return ymd;
}

async function fetchAll<T>(url: string): Promise<T[]> {
  const out: T[] = [];
  let offset = 0;
  const limit = 1000;
  while (true) {
    const res = await fetch(`${url}${url.includes("?") ? "&" : "?"}limit=${limit}&offset=${offset}`, { headers: supaHeaders() });
    if (!res.ok) {
      console.error(`fetchAll ${res.status}: ${(await res.text()).slice(0, 200)}`);
      break;
    }
    const rows = await res.json() as T[];
    out.push(...rows);
    if (rows.length < limit) break;
    offset += limit;
    if (offset >= 20000) break;  // safety cap
  }
  return out;
}

function buildMinimalContext(
  sc: {
    est_ba: number | null; est_slg: number | null; est_slg_minus_slg_diff: number | null;
    brl_pa: number | null; brl_percent: number | null; avg_hit_speed: number | null;
    est_woba: number | null; est_woba_minus_woba_diff: number | null;
    ev95percent: number | null; avg_hit_angle: number | null; anglesweetspotpercent: number | null;
  } | null,
  pickSide: "over" | "under",
  line: number,
  odds: number,
): BatterScoringContext {
  // Minimal safe context — only `statcast` is point-in-time populated.
  // All other factors will compute 0 (game log empty, no pitcher, no
  // weather, no ballpark, etc.). For D-801's purpose we only extract
  // the 4 D-797 factor values from the result; the other fields are
  // discarded by the caller.
  return {
    batter: {
      fullName: "_d801_backfill",
      team: "_",
      opponentTeam: "_",
      isHome: true,
      gameTime: "",
      venue: null,
    },
    season: {
      gamesPlayed: 0,
      atBats: 0,
      hits: 0,
      plateAppearances: 0,
      battingAvg: 0,
      babip: 0,
      obp: 0,
      bats: null,
      homeRuns: 0,
      totalBases: 0,
      rbi: 0,
      hrPerPA: 0,
      iso: 0,
      avgVsLHP: null,
      avgVsRHP: null,
      strikeOuts: 0,
      runs: 0,
    },
    gameLog: [],
    opposingPitcher: null,
    ballpark: null,
    weather: null,
    prop: { propType: "total_bases", line, odds, pickSide, bookmaker: "" },
    statcast: sc,
    splits: null,
    opposingBullpen: null,
    ballparkOrientation: null,
    lineupSpot: null,
    dayAfterNight: false,
    travelContext: null,
    opposingPitcherSplits: null,
    consecutiveStarts: null,
    opposingPitcherId: null,
    opposingPitcherArsenal: null,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const t0 = Date.now();

  let body: { limit?: number; dry_run?: boolean; offset?: number; only_unbackfilled?: boolean } = {};
  try { body = await req.json(); } catch { /* allow empty body */ }
  const limit = typeof body.limit === "number" ? body.limit : 5000;
  const offset = typeof body.offset === "number" ? body.offset : 0;
  const dryRun = body.dry_run === true;
  // When true, query filters to only un-backfilled picks (score_batter_xwoba IS NULL).
  // Use this for chunked resume after timeout.
  const onlyUnbackfilled = body.only_unbackfilled === true;

  // STEP 1: Pull D-789 cohort TB picks (no straddle, resolved, not voided).
  // Optionally filter to only-unbackfilled (resume after timeout).
  const xwobaFilter = onlyUnbackfilled ? "&score_batter_xwoba=is.null" : "";
  // D-821b — extended cohort window to full D-820 38-day snapshot range.
  // Pre-D-821b: created_at 2026-06-13 to 06-25 (D-789 model-consistent narrow).
  // D-821b: game_date 2026-05-22 to 06-28 = 8,071 resolved TB picks. The snapshot
  // tables hold daily history back to 2026-05-20, so any pick with game_date >=
  // 2026-05-22 has at least 1 day of strictly-prior snapshot available. Leakage
  // gate (snapshot_date < game_date) is unchanged.
  const picksUrl = `${SUPABASE_URL}/rest/v1/pick_history?select=id,player_id,player_name,game_date,pick_side,line,odds&mlb_market_type=eq.batter_total_bases&hit=not.is.null&voided=eq.false&game_date=gte.2026-05-22&game_date=lte.2026-06-28${xwobaFilter}&order=game_date.asc`;
  const picks = (await fetchAll<Pick>(picksUrl)).slice(offset);
  console.log(`[d801] pulled ${picks.length} TB cohort picks`);

  // STEP 2: Pull all Statcast snapshots for the relevant player_ids,
  // covering snapshot_date range that strictly precedes the picks'
  // earliest game_date.
  // Earliest game_date in cohort minus 1 day = lowest snapshot we might use.
  // We pre-load all snapshots once, then filter per pick.
  const playerIds = Array.from(new Set(picks.map(p => p.player_id).filter(Boolean) as number[]));
  console.log(`[d801] distinct player_ids: ${playerIds.length}`);

  // Pull all xstats + exit_velo snapshots for these players, all dates.
  // We'll filter per pick to (max snapshot_date < pick.game_date).
  const xstats: XstatsRow[] = [];
  const exitVelo: ExitVeloRow[] = [];
  const chunkSize = 100;
  for (let i = 0; i < playerIds.length; i += chunkSize) {
    const chunk = playerIds.slice(i, i + chunkSize);
    const idList = chunk.join(",");
    const xUrl = `${SUPABASE_URL}/rest/v1/cache_statcast_batters_xstats?player_id=in.(${idList})&select=player_id,snapshot_date,est_woba,est_woba_minus_woba_diff,est_ba,est_slg,est_slg_minus_slg_diff&order=snapshot_date.desc`;
    const eUrl = `${SUPABASE_URL}/rest/v1/cache_statcast_batters_exit_velo?player_id=in.(${idList})&select=player_id,snapshot_date,ev95percent,avg_hit_speed,avg_hit_angle,anglesweetspotpercent,brl_pa,brl_percent&order=snapshot_date.desc`;
    const [xRows, eRows] = await Promise.all([fetchAll<XstatsRow>(xUrl), fetchAll<ExitVeloRow>(eUrl)]);
    xstats.push(...xRows);
    exitVelo.push(...eRows);
  }
  console.log(`[d801] loaded xstats=${xstats.length} exitVelo=${exitVelo.length} snapshots`);

  // Index snapshots by (player_id, snapshot_date) for fast point-in-time lookup.
  // For each (player_id, pick.game_date_iso), find the latest snapshot_date < game_date_iso.
  // Pre-sort each player's snapshots by date desc so binary lookup is O(log n).
  const xByPlayer = new Map<number, XstatsRow[]>();
  for (const r of xstats) {
    if (!xByPlayer.has(r.player_id)) xByPlayer.set(r.player_id, []);
    xByPlayer.get(r.player_id)!.push(r);
  }
  for (const arr of xByPlayer.values()) arr.sort((a, b) => b.snapshot_date.localeCompare(a.snapshot_date));
  const eByPlayer = new Map<number, ExitVeloRow[]>();
  for (const r of exitVelo) {
    if (!eByPlayer.has(r.player_id)) eByPlayer.set(r.player_id, []);
    eByPlayer.get(r.player_id)!.push(r);
  }
  for (const arr of eByPlayer.values()) arr.sort((a, b) => b.snapshot_date.localeCompare(a.snapshot_date));

  // STEP 3: For each pick, find point-in-time snapshots + compute factors.
  let processed = 0;
  let skippedNoPlayerId = 0;
  let skippedNoSnapshot = 0;
  let scored = 0;
  let updatedRows = 0;
  let updateErrors = 0;
  const factorStats = {
    xwoba_non_null: 0, xwoba_non_zero: 0,
    launch_non_null: 0, launch_non_zero: 0,
    sweet_non_null: 0, sweet_non_zero: 0,
    hard_non_null: 0, hard_non_zero: 0,
  };
  const sampleLeakageProof: Array<{ pick_id: string; player_id: number; pick_game_date: string; snapshot_date_used: string; est_woba: number | null; computed_xwoba: number }> = [];

  const PATCH_BATCH_SIZE = 25;
  const pendingPatches: Array<{ id: string; xwoba: number; launch: number; sweet: number; hard: number }> = [];
  const picksToProcess = picks.slice(0, limit);
  for (const p of picksToProcess) {
    processed++;
    if (!p.player_id) { skippedNoPlayerId++; continue; }
    const isoGameDate = ymdToIsoDate(p.game_date);

    // Find latest snapshot STRICTLY BEFORE game_date (the leakage gate).
    const xList = xByPlayer.get(p.player_id) || [];
    const eList = eByPlayer.get(p.player_id) || [];
    const xRow = xList.find(r => r.snapshot_date < isoGameDate) ?? null;
    const eRow = eList.find(r => r.snapshot_date < isoGameDate) ?? null;
    if (!xRow && !eRow) { skippedNoSnapshot++; continue; }

    // Build a BatterStatcastContext from the point-in-time snapshot.
    const sc = {
      est_ba: xRow?.est_ba ?? null,
      est_slg: xRow?.est_slg ?? null,
      est_slg_minus_slg_diff: xRow?.est_slg_minus_slg_diff ?? null,
      brl_pa: eRow?.brl_pa ?? null,
      brl_percent: eRow?.brl_percent ?? null,
      avg_hit_speed: eRow?.avg_hit_speed ?? null,
      est_woba: xRow?.est_woba ?? null,
      est_woba_minus_woba_diff: xRow?.est_woba_minus_woba_diff ?? null,
      ev95percent: eRow?.ev95percent ?? null,
      avg_hit_angle: eRow?.avg_hit_angle ?? null,
      anglesweetspotpercent: eRow?.anglesweetspotpercent ?? null,
    };

    const ctx = buildMinimalContext(sc, p.pick_side, p.line, p.odds);
    let result: ReturnType<typeof scoreBatterTotalBases>;
    try {
      result = scoreBatterTotalBases(ctx);
    } catch (e) {
      console.error(`[d801] scorer error pick_id=${p.id} err=${e}`);
      continue;
    }
    scored++;
    const xwoba = result.score_batter_xwoba;
    const launch = result.score_batter_launch_angle;
    const sweet = result.score_batter_sweet_spot;
    const hard = result.score_batter_hard_hit;

    if (xwoba !== null) factorStats.xwoba_non_null++;
    if (xwoba !== 0) factorStats.xwoba_non_zero++;
    if (launch !== null) factorStats.launch_non_null++;
    if (launch !== 0) factorStats.launch_non_zero++;
    if (sweet !== null) factorStats.sweet_non_null++;
    if (sweet !== 0) factorStats.sweet_non_zero++;
    if (hard !== null) factorStats.hard_non_null++;
    if (hard !== 0) factorStats.hard_non_zero++;

    // Capture first 10 picks as leakage-proof samples.
    if (sampleLeakageProof.length < 10) {
      sampleLeakageProof.push({
        pick_id: p.id,
        player_id: p.player_id,
        pick_game_date: isoGameDate,
        snapshot_date_used: xRow?.snapshot_date ?? eRow?.snapshot_date ?? "(none)",
        est_woba: xRow?.est_woba ?? null,
        computed_xwoba: xwoba,
      });
    }

    if (!dryRun) {
      // Queue the PATCH; flushed in batches of 25 below for ~10x speedup.
      pendingPatches.push({ id: p.id, xwoba, launch, sweet, hard });
      if (pendingPatches.length >= PATCH_BATCH_SIZE) {
        const results = await Promise.all(pendingPatches.map(pp =>
          fetch(`${SUPABASE_URL}/rest/v1/pick_history?id=eq.${pp.id}`, {
            method: "PATCH", headers: supaHeaders(),
            body: JSON.stringify({
              score_batter_xwoba: pp.xwoba,
              score_batter_launch_angle: pp.launch,
              score_batter_sweet_spot: pp.sweet,
              score_batter_hard_hit: pp.hard,
            }),
          }).then(r => r.ok)
        ));
        for (const ok of results) ok ? updatedRows++ : updateErrors++;
        pendingPatches.length = 0;
      }
    }
  }

  // Flush remaining patches.
  if (!dryRun && pendingPatches.length > 0) {
    const results = await Promise.all(pendingPatches.map(pp =>
      fetch(`${SUPABASE_URL}/rest/v1/pick_history?id=eq.${pp.id}`, {
        method: "PATCH", headers: supaHeaders(),
        body: JSON.stringify({
          score_batter_xwoba: pp.xwoba,
          score_batter_launch_angle: pp.launch,
          score_batter_sweet_spot: pp.sweet,
          score_batter_hard_hit: pp.hard,
        }),
      }).then(r => r.ok)
    ));
    for (const ok of results) ok ? updatedRows++ : updateErrors++;
    pendingPatches.length = 0;
  }

  const duration_ms = Date.now() - t0;
  return new Response(JSON.stringify({
    success: true,
    dry_run: dryRun,
    duration_ms,
    cohort_picks: picks.length,
    picks_processed: processed,
    skipped_no_player_id: skippedNoPlayerId,
    skipped_no_snapshot: skippedNoSnapshot,
    scored,
    updated_rows: updatedRows,
    update_errors: updateErrors,
    factor_coverage: factorStats,
    leakage_proof_samples: sampleLeakageProof,
  }, null, 2), { headers: { ...corsHeaders, "Content-Type": "application/json" } });
});
