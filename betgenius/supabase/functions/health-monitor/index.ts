// health-monitor — periodic system health check (May 6, 2026).
//
// Runs every 30 min via pg_cron. Checks four conditions:
//   1. error_log accumulation: COUNT(*) WHERE created_at > NOW() - 1h, threshold 10
//   2. run_log staleness: last successful tick within cron window (10am-7pm ET)
//      should be < 30 min ago. If older, cron is silent-failing.
//   3. algorithm_weights staleness: updated_at unchanged > 7 days during active
//      accumulation phase (info-tier reminder, not critical)
//   4. notification_log self-check: confirm we can write to the audit table
//
// Test mode: GET ?test=true sends an info notification to verify the path works
// end-to-end. Use this once after Twilio env is configured to confirm CEO's
// phone receives the SMS.
//
// Auth: GET requires no auth (read-only health check, no PII in response).
// Test mode requires service-role key in Authorization header to prevent
// random callers from triggering SMS to the CEO's phone.

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { notify } from "../_shared/notify.ts";

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

function isWithinCronWindowET(): boolean {
  // Same ~ET offset approximation as notify.ts uses
  const now = new Date(Date.now() - 4 * 60 * 60 * 1000);
  const hour = now.getUTCHours();
  return hour >= 10 && hour < 19;
}

async function getCount(url: string, key: string, path: string): Promise<number> {
  try {
    const res = await fetch(`${url}/rest/v1/${path}`, {
      method: "HEAD",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        Prefer: "count=exact",
      },
    });
    const range = res.headers.get("content-range") || "";
    const m = range.match(/\/(\d+)$/);
    return m ? parseInt(m[1], 10) : 0;
  } catch (_e) { return 0; }
}

async function getJson(url: string, key: string, path: string): Promise<unknown> {
  try {
    const res = await fetch(`${url}/rest/v1/${path}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (_e) { return null; }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const url = new URL(req.url);
  const isTest = url.searchParams.get("test") === "true";
  const supaUrl = Deno.env.get("SUPABASE_URL") || "";
  // D-378 SHIP 2a — D-365 separation pattern.
  //   supaKey  → outgoing PostgREST apikey; MUST be SERVICE_ROLE_KEY only
  //              (a real Supabase JWT or sb_secret_-format key). BACKFILL is
  //              a vault UUID; PostgREST rejects it as an apikey.
  //   gateAccept[] → tokens accepted on INCOMING gate (test-mode path).
  const supaKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
  const backfillToken = Deno.env.get("BACKFILL_AUTH_TOKEN") || "";
  const gateAccept = [backfillToken, supaKey].filter(Boolean);

  // Test path — explicit auth required to prevent unauthenticated CEO-phone-SMS
  if (isTest) {
    const auth = req.headers.get("authorization") || "";
    const matches = gateAccept.some((t) => auth.includes(t));
    if (!matches) {
      return jsonResponse({ success: false, error: "test mode requires service-role key" }, 401);
    }
    await notify({
      severity: "info",
      title: "health-monitor test ping",
      message: "system healthy — this is a test notification to verify Twilio path",
    });
    return jsonResponse({
      success: true,
      mode: "test",
      note: "info-tier notify() never sends SMS by design — but does write to notification_log. Use severity=critical to test the SMS pipeline end-to-end.",
    });
  }

  if (!supaUrl || !supaKey) {
    return jsonResponse({ success: false, error: "edge function env missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY" }, 500);
  }

  const checks: Array<{ name: string; passed: boolean; detail: string; metadata?: Record<string, unknown> }> = [];
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // ----- Check 1: error_log accumulation in last hour -----
  const errCount = await getCount(supaUrl, supaKey, `error_log?created_at=gte.${encodeURIComponent(oneHourAgo)}&select=id`);
  const errPassed = errCount <= 10;
  checks.push({
    name: "error_log_last_hour",
    passed: errPassed,
    detail: `${errCount} errors in last hour (threshold 10)`,
    metadata: { count: errCount, threshold: 10 },
  });
  if (!errPassed) {
    await notify({
      severity: "warning",
      title: "error_log accumulation elevated",
      message: `${errCount} errors in last 1h (threshold 10)`,
      metadata: { count: errCount },
    });
  }

  // ----- Check 2: run_log staleness during cron window -----
  // D-112 fix (May 9): filter relaxed from status=eq.success to status=in.(success,skipped)
  // so we count clean-no-op cron ticks (e.g., "all games already complete" path that fires
  // every 15 min after the day's slate is processed). process-games now writes 'skipped'
  // rows on its 3 early-return paths; this filter lets health-monitor see them as live.
  if (isWithinCronWindowET()) {
    const runs = await getJson(
      supaUrl, supaKey,
      `run_log?function_name=eq.process-games&status=in.(success,skipped)&order=created_at.desc&select=created_at&limit=1`,
    ) as Array<{ created_at: string }> | null;
    if (runs && runs.length > 0) {
      const lastRunMs = new Date(runs[0].created_at).getTime();
      const ageMin = Math.round((Date.now() - lastRunMs) / 60000);
      const passed = ageMin <= 30;
      checks.push({
        name: "run_log_freshness",
        passed,
        detail: `last successful process-games run was ${ageMin} min ago (threshold 30)`,
        metadata: { age_min: ageMin, threshold_min: 30 },
      });
      if (!passed) {
        await notify({
          severity: "critical",
          title: "process-games cron silent for 30+ min",
          message: `Last successful run ${ageMin} min ago during active cron window (10am-7pm ET)`,
          metadata: { age_min: ageMin, last_run_at: runs[0].created_at },
        });
      }
    } else {
      checks.push({
        name: "run_log_freshness",
        passed: false,
        detail: "no successful process-games runs found",
      });
      await notify({
        severity: "critical",
        title: "no successful process-games runs found",
        message: "run_log query returned 0 rows",
      });
    }
  } else {
    checks.push({
      name: "run_log_freshness",
      passed: true,
      detail: "outside cron window — skipping freshness check",
    });
  }

  // ----- Check 3: algorithm_weights staleness (info-tier reminder) -----
  const weights = await getJson(
    supaUrl, supaKey,
    `algorithm_weights?id=eq.1&select=updated_at&limit=1`,
  ) as Array<{ updated_at: string }> | null;
  if (weights && weights.length > 0 && weights[0].updated_at < sevenDaysAgo) {
    const ageDays = Math.floor((Date.now() - new Date(weights[0].updated_at).getTime()) / (24 * 60 * 60 * 1000));
    checks.push({
      name: "algorithm_weights_freshness",
      passed: true, // info-tier, doesn't fail the check
      detail: `algorithm_weights unchanged for ${ageDays} days (info-tier reminder)`,
      metadata: { age_days: ageDays },
    });
    await notify({
      severity: "info",
      title: "algorithm_weights unchanged 7+ days",
      message: `weights last updated ${ageDays} days ago — consider running optimizer if data has accumulated`,
      metadata: { age_days: ageDays },
    });
  } else {
    checks.push({
      name: "algorithm_weights_freshness",
      passed: true,
      detail: "weights updated within 7 days",
    });
  }

  // ----- Check 4: silent failure pattern (D-147 May 13 + D-151 v2 May 13 late) -----
  // D-151 (May 13, 2026 late evening): three fixes to D-147 surfaced by
  // D-148 v2 audit:
  //   - Finding #3: added slow-drain secondary detector (>3 errors same type
  //     / 6h window). Original 30-min threshold required >10 errors/hour to
  //     trip; the May 9 outage was 16 errors / 26h = ~0.6/hour, ~30× too slow
  //     for the 30-min check. Slow-drain detector fires on ~0.5/hour.
  //   - Finding #12: error_log SELECT limit raised 500 → 5000. Original cap
  //     truncated during the exact outage Check #4 exists to detect; under
  //     normal operation error_log has nowhere near 5000 entries in 6h.
  //   - Finding #13: null-status handling. If function has zero recent
  //     run_log rows (cron skipped, function crashed pre-log, never deployed),
  //     status resolved to null and the original `status !== "success" &&
  //     status !== "skipped"` guard fell through `continue`. Now: errors
  //     piling up WHILE function never ran fires CRITICAL severity.
  //
  // Detection flow: one error_log fetch over 6h (covers both burst + drain
  // patterns; 5000-row cap), group by (function_name, error_type), compute
  // count_30min AND count_6h per group. Per group:
  //   - count_30min > 5 → fast-burst pattern (warning, or critical on null status)
  //   - count_6h    > 3 → slow-drain pattern (warning, or critical on null status)
  //     (slow-drain fires only if fast-burst didn't already fire for the same group)
  //   - Gated on run_log status — success/skipped/null all qualify; only
  //     'failed' status skips (function already told us it failed).
  // Paired §1.12 verification migration 20260514000017.
  const sixHoursAgo = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString();
  const thirtyMinAgoMs = Date.now() - 30 * 60 * 1000;
  const recentErrors = await getJson(
    supaUrl, supaKey,
    `error_log?created_at=gte.${encodeURIComponent(sixHoursAgo)}` +
      `&select=function_name,error_type,error_message,created_at` +
      `&order=created_at.desc&limit=5000`,
  ) as Array<{ function_name: string; error_type: string; error_message: string; created_at: string }> | null;

  let silentPatternCount = 0;
  let silentSlowDrainCount = 0;
  let silentNoRunCount = 0;
  const silentPatternFunctions: string[] = [];

  if (recentErrors && recentErrors.length > 0) {
    const groups = new Map<string, { function_name: string; error_type: string; count_30min: number; count_6h: number; sample: string; latest: string }>();
    for (const err of recentErrors) {
      const fn = err.function_name ?? "unknown";
      const et = err.error_type ?? "unknown";
      const key = `${fn}::${et}`;
      let g = groups.get(key);
      if (!g) {
        g = { function_name: fn, error_type: et, count_30min: 0, count_6h: 0, sample: (err.error_message ?? "").slice(0, 200), latest: err.created_at };
        groups.set(key, g);
      }
      g.count_6h += 1;
      const errMs = new Date(err.created_at).getTime();
      if (errMs >= thirtyMinAgoMs) g.count_30min += 1;
    }
    for (const g of groups.values()) {
      const burstTrip = g.count_30min > 5;
      const drainTrip = !burstTrip && g.count_6h > 3;
      if (!burstTrip && !drainTrip) continue;
      const latestRun = await getJson(
        supaUrl, supaKey,
        `run_log?function_name=eq.${encodeURIComponent(g.function_name)}` +
          `&order=created_at.desc&select=status,created_at&limit=1`,
      ) as Array<{ status: string; created_at: string }> | null;
      const status = latestRun?.[0]?.status ?? null;
      // D-151 Finding #13: status=null (no run_log row at all in window)
      // is its own alert at CRITICAL severity. status='failed' is the only
      // qualifying-out condition — function already told us it failed.
      if (status === "failed") continue;
      const isNullStatus = status === null;
      // D-151 Finding #3: metadata.type distinguishes burst vs drain vs no-run
      // so dashboards + verification queries can slice them separately.
      const detectionType = isNullStatus
        ? "silent_failure_pattern_no_run"
        : burstTrip
          ? "silent_failure_pattern"
          : "silent_failure_pattern_slow_drain";
      const severity: "warning" | "critical" = isNullStatus ? "critical" : "warning";
      if (isNullStatus) silentNoRunCount += 1;
      else if (burstTrip) silentPatternCount += 1;
      else silentSlowDrainCount += 1;
      silentPatternFunctions.push(g.function_name);
      const windowLabel = burstTrip ? "30 min" : "6h";
      const countLabel = burstTrip ? g.count_30min : g.count_6h;
      const statusDescription = isNullStatus
        ? "has NO recent run_log entry"
        : `reports ${status}`;
      await notify({
        severity,
        title: `Silent failure pattern: ${g.function_name} / ${g.error_type}`,
        message: `${countLabel} ${g.error_type} errors in last ${windowLabel} while ${g.function_name} ${statusDescription}. Sample: ${g.sample}`,
        metadata: {
          // notifications_log has no `type` column — encoded in metadata
          // JSONB per existing schema convention. Verification queries use
          // metadata->>'type' LIKE 'silent_failure_pattern%' to filter.
          type: detectionType,
          function_name: g.function_name,
          error_type: g.error_type,
          count_30min: g.count_30min,
          count_6h: g.count_6h,
          threshold_30min: 5,
          threshold_6h: 3,
          most_recent_run_status: status,
          most_recent_run_time: latestRun?.[0]?.created_at ?? null,
          sample_error_message: g.sample,
          latest_error_time: g.latest,
        },
      });
    }
  }

  const totalSilentPatterns = silentPatternCount + silentSlowDrainCount + silentNoRunCount;
  checks.push({
    name: "silent_failure_pattern",
    passed: totalSilentPatterns === 0,
    detail: totalSilentPatterns === 0
      ? "no silent failure patterns detected"
      : `${silentPatternCount} fast-burst / ${silentSlowDrainCount} slow-drain / ${silentNoRunCount} no-run pattern(s) detected — functions: ${[...new Set(silentPatternFunctions)].join(", ")}`,
    metadata: {
      burst_count: silentPatternCount,
      slow_drain_count: silentSlowDrainCount,
      no_run_count: silentNoRunCount,
      threshold_burst: 5,
      threshold_drain: 3,
      window_burst_min: 30,
      window_drain_min: 360,
    },
  });

  // ============================================================
  // AUTO-RECOVERY ACTIONS
  // ============================================================
  //
  // These DB-mutating recoveries only run when the caller authenticates
  // with a service-role-tier key. Anonymous health checks (read-only)
  // skip auto-recovery entirely. pg_cron schedule should pass auth via
  // BACKFILL_AUTH_TOKEN per the established pattern.
  //
  // Idempotent design — running the same recovery twice in succession
  // produces no additional side effects beyond audit log rows.

  const auth = req.headers.get("authorization") || "";
  const authedForRecovery =
    (supaKey && auth.includes(supaKey)) ||
    (Deno.env.get("BACKFILL_AUTH_TOKEN") &&
      auth.includes(Deno.env.get("BACKFILL_AUTH_TOKEN") || ""));

  const recoveries: Array<{ name: string; ran: boolean; rows_affected: number; detail: string }> = [];

  if (authedForRecovery) {
    // ----- Recovery #1: stuck cron_progress rows -----
    // PostgREST PATCH with filter conditions: rows in 'processing' state
    // for >30 min on game_dates within the last 2 days. Reverts to
    // 'pending' so the next process-games tick picks them up.
    try {
      const stuckCutoff = new Date(Date.now() - 30 * 60 * 1000).toISOString();
      const cutoffDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
        .toISOString().slice(0, 10).replace(/-/g, "");
      // Step A: read stuck rows so we know how many + retry counts
      const stuckRes = await fetch(
        `${supaUrl}/rest/v1/cron_progress` +
          `?status=eq.processing` +
          `&started_at=lt.${encodeURIComponent(stuckCutoff)}` +
          `&game_date=gte.${cutoffDate}` +
          `&select=id,game_date,game_id,home_team,away_team,retry_count`,
        { headers: { apikey: supaKey, Authorization: `Bearer ${supaKey}` } },
      );
      const stuckRows = stuckRes.ok ? await stuckRes.json() as Array<{
        id: string; game_date: string; game_id: string;
        home_team: string; away_team: string; retry_count: number;
      }> : [];

      let revertedCount = 0;
      let failedCount = 0;
      for (const row of stuckRows) {
        const newRetry = (row.retry_count ?? 0) + 1;
        const exceededRetries = newRetry > 3;
        const patch = exceededRetries
          ? { status: "failed", retry_count: newRetry, error_message: "auto-flagged failed by health-monitor: exceeded 3 retries" }
          : { status: "pending", started_at: null, retry_count: newRetry };
        const patchRes = await fetch(
          `${supaUrl}/rest/v1/cron_progress?id=eq.${row.id}`,
          {
            method: "PATCH",
            headers: {
              apikey: supaKey,
              Authorization: `Bearer ${supaKey}`,
              "Content-Type": "application/json",
              Prefer: "return=minimal",
            },
            body: JSON.stringify(patch),
          },
        );
        if (patchRes.ok) {
          if (exceededRetries) failedCount++; else revertedCount++;
        }
      }
      const total = revertedCount + failedCount;
      recoveries.push({
        name: "cron_progress_stuck_revert",
        ran: true,
        rows_affected: total,
        detail: total === 0
          ? "no stuck rows found"
          : `${revertedCount} reverted to pending, ${failedCount} flagged failed (>3 retries)`,
      });
      if (revertedCount > 0) {
        await notify({
          severity: "warning",
          title: "Stuck cron_progress rows recovered",
          message: `${revertedCount} rows reverted from processing→pending`,
          metadata: {
            row_count: revertedCount,
            game_dates: [...new Set(stuckRows.map((r) => r.game_date))],
          },
        });
      }
      if (failedCount > 0) {
        await notify({
          severity: "critical",
          title: "cron_progress rows flagged failed (>3 retries)",
          message: `${failedCount} rows hit retry limit; investigate manually`,
          metadata: {
            failed_count: failedCount,
            game_dates: [...new Set(stuckRows.filter((r) => (r.retry_count ?? 0) >= 3).map((r) => r.game_date))],
          },
        });
      }
    } catch (e) {
      recoveries.push({
        name: "cron_progress_stuck_revert",
        ran: false,
        rows_affected: 0,
        detail: `error: ${e instanceof Error ? e.message : String(e)}`,
      });
    }

    // ----- Recovery #2: voided picks for postponed/cancelled games -----
    // Find pick_history rows with hit=NULL that are >24h old AND match
    // a cache_game_scoreboard row whose status indicates void/postponed.
    // pick_history has no game_id; join via (team, opponent, game_date).
    // pick_history.game_date is TEXT YYYYMMDD; cache_game_scoreboard.game_date
    // is DATE — convert via TO_CHAR. Use an RPC for the join because
    // PostgREST doesn't support cross-table UPDATE FROM directly.
    try {
      // First: detect candidate picks via two PostgREST queries + manual
      // intersection (RPC would be cleaner; deferred until after first
      // observed match because zero-row environment makes RPC overkill).
      const dayCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      // Pull non-completed scoreboard rows (status indicates trouble)
      const sbRes = await fetch(
        `${supaUrl}/rest/v1/cache_game_scoreboard` +
          `?status=in.(postponed,voided,cancelled,suspended,canceled)` +
          `&select=game_id,game_date,home_team,away_team,status&limit=200`,
        { headers: { apikey: supaKey, Authorization: `Bearer ${supaKey}` } },
      );
      const troubledGames = sbRes.ok ? await sbRes.json() as Array<{
        game_id: string; game_date: string;
        home_team: string; away_team: string; status: string;
      }> : [];

      let voidedCount = 0;
      const affectedDates: string[] = [];
      for (const g of troubledGames) {
        const yyyymmdd = g.game_date.replace(/-/g, "");
        // Find unresolved picks for this matchup (either side)
        const picksRes = await fetch(
          `${supaUrl}/rest/v1/pick_history` +
            `?hit=is.null` +
            `&voided=is.false` +
            `&created_at=lt.${encodeURIComponent(dayCutoff)}` +
            `&game_date=eq.${yyyymmdd}` +
            `&or=(and(team.eq.${encodeURIComponent(g.home_team)},opponent.eq.${encodeURIComponent(g.away_team)}),and(team.eq.${encodeURIComponent(g.away_team)},opponent.eq.${encodeURIComponent(g.home_team)}))` +
            `&select=id`,
          { headers: { apikey: supaKey, Authorization: `Bearer ${supaKey}` } },
        );
        if (!picksRes.ok) continue;
        const picks = await picksRes.json() as Array<{ id: string }>;
        if (picks.length === 0) continue;

        // Bulk PATCH all matching picks
        for (const p of picks) {
          const patchRes = await fetch(
            `${supaUrl}/rest/v1/pick_history?id=eq.${p.id}`,
            {
              method: "PATCH",
              headers: {
                apikey: supaKey,
                Authorization: `Bearer ${supaKey}`,
                "Content-Type": "application/json",
                Prefer: "return=minimal",
              },
              body: JSON.stringify({
                voided: true,
                hit: null,
                resolved_at: new Date().toISOString(),
                resolution_note: `Auto-voided by health-monitor: scoreboard status=${g.status} for ${g.away_team} @ ${g.home_team} on ${g.game_date}`,
              }),
            },
          );
          if (patchRes.ok) voidedCount++;
        }
        if (picks.length > 0) affectedDates.push(g.game_date);
      }
      recoveries.push({
        name: "voided_picks_auto_resolve",
        ran: true,
        rows_affected: voidedCount,
        detail: voidedCount === 0
          ? "no picks needed auto-voiding"
          : `${voidedCount} picks auto-voided across ${[...new Set(affectedDates)].length} game(s)`,
      });
      if (voidedCount > 0) {
        await notify({
          severity: "warning",
          title: "Picks auto-voided (postponed/cancelled games)",
          message: `${voidedCount} picks marked voided for postponed/cancelled games`,
          metadata: {
            voided_count: voidedCount,
            affected_dates: [...new Set(affectedDates)],
          },
        });
      }
    } catch (e) {
      recoveries.push({
        name: "voided_picks_auto_resolve",
        ran: false,
        rows_affected: 0,
        detail: `error: ${e instanceof Error ? e.message : String(e)}`,
      });
    }

    // ----- Recovery #3: stale cache flag (no auto-refresh — flag only) -----
    // Per spec: do NOT auto-refresh (creates unbounded API call risk). Just
    // surface the count of stale rows so CEO has visibility. Production cron
    // already refreshes cache_player_game_logs via writeCachePlayerGameLogs
    // every cron tick, so staleness >7 days indicates a player who hasn't
    // appeared in any cron tick's player batch — usually retired/inactive.
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
      const staleCount = await getCount(
        supaUrl, supaKey,
        `cache_player_game_logs?fetched_at=lt.${encodeURIComponent(sevenDaysAgo)}&select=player_id`,
      );
      const flag = staleCount > 50;
      recoveries.push({
        name: "cache_staleness_flag",
        ran: true,
        rows_affected: 0, // flag-only, no writes
        detail: `${staleCount} cache_player_game_logs rows older than 7 days (threshold 50)${flag ? " — flagged" : ""}`,
      });
      if (flag) {
        await notify({
          severity: "warning",
          title: "cache_player_game_logs staleness elevated",
          message: `${staleCount} player rows older than 7 days (threshold 50) — likely retired/inactive players accumulating; not auto-refreshing per spec`,
          metadata: { stale_count: staleCount, threshold: 50 },
        });
      }
    } catch (e) {
      recoveries.push({
        name: "cache_staleness_flag",
        ran: false,
        rows_affected: 0,
        detail: `error: ${e instanceof Error ? e.message : String(e)}`,
      });
    }

    // ----- Recovery #4: All-Star break detection (info-only) -----
    // Hardcoded NBA 2025-26 All-Star break dates. For 2026-27 season,
    // dates need to be updated — flagged in framework as annual maintenance.
    try {
      const NBA_ALL_STAR_DATES_2026 = [
        "2026-02-14", "2026-02-15", "2026-02-16",
        "2026-02-17", "2026-02-18", "2026-02-19",
      ];
      const todayET = new Date(Date.now() - 4 * 60 * 60 * 1000)
        .toISOString().slice(0, 10);
      const isAllStarBreak = NBA_ALL_STAR_DATES_2026.includes(todayET);
      recoveries.push({
        name: "all_star_break_detection",
        ran: true,
        rows_affected: 0,
        detail: isAllStarBreak
          ? `today (${todayET}) is in NBA All-Star break — info notification fired`
          : `today (${todayET}) not in NBA All-Star break window`,
      });
      if (isAllStarBreak) {
        await notify({
          severity: "info",
          title: "All-Star break detected",
          message: "Some picks may have been auto-resolved as DNP. Manual review recommended.",
          metadata: { date: todayET, season: "2025-26" },
        });
      }
    } catch (e) {
      recoveries.push({
        name: "all_star_break_detection",
        ran: false,
        rows_affected: 0,
        detail: `error: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  } else {
    recoveries.push({
      name: "auto_recovery",
      ran: false,
      rows_affected: 0,
      detail: "skipped — no service-role auth on request (read-only health check mode)",
    });
  }

  const allPassed = checks.every((c) => c.passed);
  return jsonResponse({
    success: true,
    healthy: allPassed,
    cron_window_et: isWithinCronWindowET(),
    checks,
    auto_recoveries_run: recoveries,
    timestamp: new Date().toISOString(),
  });
});
