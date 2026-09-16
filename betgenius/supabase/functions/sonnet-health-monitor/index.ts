// sonnet-health-monitor — Sonnet-focused hourly health-check (D-459).
//
// Watches the silent-degradation failure modes the D-457→D-460 outage
// exposed. Complements (NOT replaces) the existing `health-monitor` fn
// which covers generic infra; this one is Sonnet-specific.
//
// 4 checks, each writes one row to public.health_status with status
// ok/warn/fail/info + structured metadata:
//
//   1. sonnet_probe         — minimal Anthropic API call. Status fail
//                              if non-200 (would have caught D-457 at
//                              hour 1 instead of hour 46).
//   2. sonnet_400_rate      — count `sonnet_http_error` rows in last
//                              60 min. Threshold warn=1, fail=5.
//   3. mlb_cron_freshness   — last successful process-games-mlb tick
//                              vs expected interval. During the MLB
//                              cron window (UTC 17-04) we expect ≤30 min
//                              since last fire.
//   4. mlb_write_velocity   — count of pick_history rows written in last
//                              60 min during MLB cron window. Expect ≥10
//                              during active window (catches silent
//                              pick_history write failures).
//
// Auth: service-role bearer OR vault BACKFILL_AUTH_TOKEN (matches D-313
// auth pattern). Hourly cron passes via vault-decrypted token.
//
// Deploy: npx supabase functions deploy sonnet-health-monitor --no-verify-jwt

import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { assertMlbMarketTypeSetSynced } from "../_shared/pick_history_writer.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SUPABASE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const BACKFILL_TOKEN = Deno.env.get("BACKFILL_AUTH_TOKEN") || "";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") || "";

type Status = "ok" | "warn" | "fail" | "info";
interface CheckResult { check_name: string; status: Status; detail: string; metadata: Record<string, unknown>; }

function j(d: unknown, s = 200) {
  return new Response(JSON.stringify(d, null, 2), {
    status: s,
    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
  });
}

const sH = () => ({
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
});

async function persistResult(r: CheckResult): Promise<void> {
  // Best-effort: never let persistence failure block other checks.
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/health_status`, {
      method: "POST",
      headers: { ...sH(), Prefer: "return=minimal" },
      body: JSON.stringify(r),
    });
  } catch { /* swallow */ }
}

async function countSince(table: string, filter: string, sinceIso: string): Promise<number> {
  try {
    const url = `${SUPABASE_URL}/rest/v1/${table}?${filter}&created_at=gte.${encodeURIComponent(sinceIso)}&select=id`;
    const res = await fetch(url, { method: "HEAD", headers: { ...sH(), Prefer: "count=exact" } });
    const range = res.headers.get("content-range") || "";
    const m = range.match(/\/(\d+)$/);
    return m ? parseInt(m[1], 10) : 0;
  } catch { return -1; }
}

// =====================================================================
// CHECK 1 — Sonnet probe (the D-457 catcher)
// =====================================================================
async function checkSonnetProbe(): Promise<CheckResult> {
  if (!ANTHROPIC_API_KEY) {
    return {
      check_name: "sonnet_probe",
      status: "fail",
      detail: "ANTHROPIC_API_KEY missing from edge function env",
      metadata: { reason: "config_missing" },
    };
  }

  const t0 = Date.now();
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      // 5 tokens cap — minimal cost (~$0.00001 per probe at $15/M output).
      // Same model + headers as production MLB anthropic_mlb.ts:244-246.
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 5,
        messages: [{ role: "user", content: "Reply OK" }],
      }),
    });
    const latency_ms = Date.now() - t0;
    if (res.ok) {
      const data = await res.json();
      const text = data?.content?.[0]?.text || "";
      return {
        check_name: "sonnet_probe",
        status: "ok",
        detail: `200 in ${latency_ms}ms; reply: "${text.substring(0, 30)}"`,
        metadata: {
          status: 200,
          latency_ms,
          model: "claude-sonnet-4-6",
          input_tokens: data?.usage?.input_tokens ?? null,
          output_tokens: data?.usage?.output_tokens ?? null,
        },
      };
    } else {
      const body = (await res.text()).substring(0, 300);
      return {
        check_name: "sonnet_probe",
        status: "fail",
        detail: `Anthropic API returned ${res.status} in ${latency_ms}ms — ${body.substring(0, 100)}`,
        metadata: { status: res.status, latency_ms, body },
      };
    }
  } catch (e) {
    return {
      check_name: "sonnet_probe",
      status: "fail",
      detail: `Anthropic API fetch threw: ${e instanceof Error ? e.message : String(e)}`,
      metadata: { error: e instanceof Error ? e.message : String(e), latency_ms: Date.now() - t0 },
    };
  }
}

// =====================================================================
// CHECK 2 — sonnet_400 rate (the consecutive-failure proxy)
// =====================================================================
async function checkSonnet400Rate(): Promise<CheckResult> {
  const sinceIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const count = await countSince("error_log", "error_type=eq.sonnet_http_error", sinceIso);
  if (count < 0) {
    return {
      check_name: "sonnet_400_rate",
      status: "info",
      detail: "error_log count fetch failed",
      metadata: { threshold_warn: 1, threshold_fail: 5 },
    };
  }
  const status: Status = count >= 5 ? "fail" : count >= 1 ? "warn" : "ok";
  return {
    check_name: "sonnet_400_rate",
    status,
    detail: `${count} sonnet_http_error rows in last 60 min (warn=1, fail=5)`,
    metadata: { count, window_min: 60, threshold_warn: 1, threshold_fail: 5 },
  };
}

// =====================================================================
// CHECK 3 — MLB cron freshness (process-games-mlb run_log)
// =====================================================================
function isInMlbCronWindowUtc(): boolean {
  // process-games-mlb cron schedule: 5,35 17-23,0-4 UTC (per CLAUDE.md).
  const h = new Date().getUTCHours();
  return (h >= 17 && h <= 23) || (h >= 0 && h <= 4);
}

async function checkMlbCronFreshness(): Promise<CheckResult> {
  if (!isInMlbCronWindowUtc()) {
    return {
      check_name: "mlb_cron_freshness",
      status: "info",
      detail: `outside MLB cron window UTC 17-04 (current UTC hour=${new Date().getUTCHours()}) — skipping`,
      metadata: { utc_hour: new Date().getUTCHours() },
    };
  }
  // process-games-mlb does NOT write to run_log (only NBA process-games does).
  // Use recommendations_cache as the freshness signal — it's the direct output
  // of MLB scoring runs. ANY MLB row written in the last 240 min during cron
  // window = healthy; longer gap = silent outage. 240 min tolerates the D-374
  // in-progress-filter skip-the-game pattern + the natural 30-min cron cadence.
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/recommendations_cache?sport=eq.mlb&order=created_at.desc&limit=1&select=created_at`,
      { headers: sH() },
    );
    if (!res.ok) {
      return {
        check_name: "mlb_cron_freshness",
        status: "info",
        detail: `recommendations_cache query returned ${res.status}`,
        metadata: { status: res.status },
      };
    }
    const rows = await res.json() as Array<{ created_at: string }>;
    if (!rows.length) {
      return {
        check_name: "mlb_cron_freshness",
        status: "fail",
        detail: "no recommendations_cache MLB rows found at all",
        metadata: { signal_source: "recommendations_cache" },
      };
    }
    const ageMin = Math.round((Date.now() - new Date(rows[0].created_at).getTime()) / 60000);
    // Threshold raised to tolerate D-374 in-progress skips on light-game days.
    const status: Status = ageMin <= 240 ? "ok" : ageMin <= 480 ? "warn" : "fail";
    return {
      check_name: "mlb_cron_freshness",
      status,
      detail: `recommendations_cache last MLB row ${ageMin} min ago (warn=240, fail=480 during cron window)`,
      metadata: {
        age_min: ageMin,
        last_write_at: rows[0].created_at,
        threshold_warn_min: 240,
        threshold_fail_min: 480,
        signal_source: "recommendations_cache",
      },
    };
  } catch (e) {
    return {
      check_name: "mlb_cron_freshness",
      status: "info",
      detail: `query threw: ${e instanceof Error ? e.message : String(e)}`,
      metadata: { error: e instanceof Error ? e.message : String(e) },
    };
  }
}

// =====================================================================
// CHECK 4 — MLB write velocity (pick_history writes during cron window)
// =====================================================================
async function checkMlbWriteVelocity(): Promise<CheckResult> {
  if (!isInMlbCronWindowUtc()) {
    return {
      check_name: "mlb_write_velocity",
      status: "info",
      detail: `outside MLB cron window — skipping`,
      metadata: { utc_hour: new Date().getUTCHours() },
    };
  }
  // 4-hour window tolerates D-374 in-progress-filter skips on light-game days
  // (some MLB days have early-window-only games; the 17:00-04:00 UTC cron
  // schedule may fire many skips between actual write ticks). 4h is short
  // enough to catch real silent-write failures but long enough to ignore the
  // 30-min cadence skip-pattern noise.
  const sinceIso = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
  const count = await countSince(
    "recommendations_cache",
    "sport=eq.mlb",
    sinceIso,
  );
  if (count < 0) {
    return {
      check_name: "mlb_write_velocity",
      status: "info",
      detail: "recommendations_cache count fetch failed",
      metadata: {},
    };
  }
  // Threshold: ≥50 writes/4h during MLB cron window = healthy (typical slate
  // produces ~150-2000 rows per 4h-window depending on game count).
  // Below 50 = warn (light slate or partial-write); 0 = fail (silent outage).
  const status: Status = count >= 50 ? "ok" : count >= 1 ? "warn" : "fail";
  return {
    check_name: "mlb_write_velocity",
    status,
    detail: `${count} MLB recommendations_cache rows written in last 4h during cron window (warn=<50, fail=0)`,
    metadata: {
      count,
      window_min: 240,
      threshold_warn: 50,
      threshold_fail: 0,
      signal_source: "recommendations_cache",
    },
  };
}

// =====================================================================
// CHECK 5 — D-481: rpc_failed rate on process-games-mlb
// Closes the D-459 monitoring gap surfaced by D-480: when D-474/D-475/D-476
// added new market types not covered by the D-204 CHECK constraint on
// pick_history.mlb_market_type, every new-market write failed with Postgres
// code 23514 and incremented histErrors → ~560 picks LOST over 24h with
// zero alerts. This check counts rpc_failed rows in error_log for
// process-games-mlb in the last 60 min. Thresholds chosen so the historical
// D-480 spike (avg 60/hr, peaks higher) would fire within the first hour
// of D-474 deploy.
// =====================================================================
async function checkRpcFailedRate(): Promise<CheckResult> {
  const sinceIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const count = await countSince(
    "error_log",
    "function_name=eq.process-games-mlb&error_type=eq.rpc_failed",
    sinceIso,
  );
  if (count < 0) {
    return {
      check_name: "rpc_failed_rate",
      status: "info",
      detail: "error_log count fetch failed",
      metadata: { threshold_warn: 10, threshold_fail: 50 },
    };
  }
  const status: Status = count >= 50 ? "fail" : count >= 10 ? "warn" : "ok";
  return {
    check_name: "rpc_failed_rate",
    status,
    detail: `${count} rpc_failed rows in last 60 min for process-games-mlb (warn=10, fail=50)`,
    metadata: {
      count,
      window_min: 60,
      threshold_warn: 10,
      threshold_fail: 50,
      signal_source: "error_log",
      d480_context: "D-480 historical spike avg 60/hr — fail threshold tuned to fire within 1h of recurrence",
    },
  };
}

// =====================================================================
// CHECK 6 — D-489 STAGE 5: pick_history_validation_failed rate
// Closes the hour-0 alerting loop. The D-487/D-488/D-489 unified write-path
// rollout introduced a distinct error_type='pick_history_validation_failed'
// emitted whenever the canonical writer's client-side validation rejects a
// payload BEFORE the upsert_pick_history RPC call. This catches D-480-class
// silent-failure incidents at the call site (hour 0) — but it only matters
// if someone alerts on the rate. This check covers process-games-mlb +
// process-games (NBA cron) since they're the high-volume cron writers;
// analyze-pick is single-shot UI and would surface differently if broken.
// Thresholds were proposed in d486_write_path_design.md: warn @ 5/60min,
// fail @ 25/60min. Lower than rpc_failed_rate because client-side rejection
// indicates a code/constraint mismatch (always a bug), unlike RPC failures
// which can be transient network issues.
// =====================================================================
async function checkPickHistoryValidationFailedRate(): Promise<CheckResult> {
  const sinceIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const count = await countSince(
    "error_log",
    "function_name=in.(process-games-mlb,process-games)&error_type=eq.pick_history_validation_failed",
    sinceIso,
  );
  if (count < 0) {
    return {
      check_name: "pick_history_validation_failed_rate",
      status: "info",
      detail: "error_log count fetch failed",
      metadata: { threshold_warn: 5, threshold_fail: 25 },
    };
  }
  const status: Status = count >= 25 ? "fail" : count >= 5 ? "warn" : "ok";
  return {
    check_name: "pick_history_validation_failed_rate",
    status,
    detail: `${count} pick_history_validation_failed rows in last 60 min across cron writers (warn=5, fail=25)`,
    metadata: {
      count,
      window_min: 60,
      threshold_warn: 5,
      threshold_fail: 25,
      signal_source: "error_log",
      monitored_functions: ["process-games-mlb", "process-games"],
      d489_context: "D-489 STAGE 5 — closes the hour-0 alerting loop on the unified write-path program (D-487/D-488/D-489). Lower threshold than rpc_failed_rate because client-side rejection always indicates a code/constraint mismatch (constraint set updated without updating the helper's ALLOWED_MLB_MARKET_TYPES, or payload-shape regression).",
    },
  };
}

// =====================================================================
// D-515 SHIP 2 — close D-513 silent-failure findings.
// 5 new checks: props_cache write velocity, CLV stamp velocity,
// mlb_scoring_progress velocity, odds_api quota, MLB Stats API failure.
// Each gates on "today has MLB games" or equivalent to avoid quiet-day
// false-positives.
//
// Count helper using GET + Range = "0-0" + Prefer count=exact. Returns -1
// on error. More reliable than HEAD (PostgREST HEAD edge cases observed:
// HEAD with select=id returned count=0 even when SQL confirmed nonzero).
// =====================================================================
async function d515Count(urlNoSelect: string): Promise<number> {
  // Direct GET + Array.length. Tried HEAD+count=exact and GET+Range — both
  // returned the wrong value for some filters on this PostgREST instance.
  // Fetching the id column is small enough for the bounded windows used by
  // these checks (≤5000 rows × ~40 bytes = 200KB worst case).
  try {
    const url = `${urlNoSelect}&select=id`;
    const r = await fetch(url, { method: "GET", headers: sH() });
    if (!r.ok) return -1;
    const rows = await r.json();
    return Array.isArray(rows) ? rows.length : -1;
  } catch { return -1; }
}

function todayYyyymmddEt(): string {
  const now = new Date();
  // ET = UTC-4 (DST) or UTC-5 (standard). Use America/New_York TZ via toLocaleString.
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const y = et.getFullYear();
  const m = String(et.getMonth() + 1).padStart(2, "0");
  const d = String(et.getDate()).padStart(2, "0");
  return `${y}${m}${d}`;
}

async function todayHasMlbGames(): Promise<boolean> {
  // Cheap signal: at least 1 props_cache row exists for today's game_date.
  try {
    const gd = todayYyyymmddEt();
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/props_cache?sport=eq.mlb&game_date=eq.${gd}&select=id&limit=1`,
      { headers: sH() },
    );
    if (!res.ok) return false;
    const rows = await res.json();
    return Array.isArray(rows) && rows.length > 0;
  } catch { return false; }
}

// =====================================================================
// CHECK 7 — D-515: props_cache write velocity (closes D-513 §2 props_cache gap)
// fetch-odds-mlb runs the props_cache write loop; if it succeeds but writes
// 0 rows over a 90-min window during a game day, that's a silent fetch
// failure (Odds API quota, auth, parsing regression, etc.).
// =====================================================================
async function checkPropsCacheWriteVelocity(): Promise<CheckResult> {
  if (!(await todayHasMlbGames())) {
    return {
      check_name: "props_cache_write_velocity",
      status: "info",
      detail: "no MLB games scheduled today — skipping",
      metadata: { gated_by: "todayHasMlbGames" },
    };
  }
  // Call SQL RPC (D-515 SHIP 2 — HTTP GET with multi-filter datetime URLs
  // failed reliably on this PostgREST; RPC is the working path).
  let count = -1;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/d515_props_cache_velocity`, {
      method: "POST", headers: sH(), body: "{}",
    });
    if (r.ok) {
      const v = await r.json();
      count = typeof v === "number" ? v : -1;
    }
  } catch { count = -1; }
  if (count < 0) {
    return { check_name: "props_cache_write_velocity", status: "info", detail: "RPC fetch failed", metadata: {} };
  }
  const status: Status = count >= 1000 ? "ok" : count >= 100 ? "warn" : "fail";
  return {
    check_name: "props_cache_write_velocity",
    status,
    detail: `${count} props_cache rows touched in last 90 min on a game day (ok>=1000, warn>=100, fail<100)`,
    metadata: { count, window_min: 90, threshold_warn: 100, threshold_fail: 100, signal_source: "props_cache.last_seen" },
  };
}

// =====================================================================
// CHECK 8 — D-515: CLV stamp velocity (closes D-513 §2 CLV gap; would
// have caught the D-511 V1/V2 overload break in 5 min instead of 13h).
// Gate: at least one MLB game started in the last 6h (then the capture
// cron should be stamping closing_odds on those picks).
// =====================================================================
async function checkClvStampVelocity(): Promise<CheckResult> {
  // SQL RPC returns both counts atomically (one round-trip).
  let gamesStarted = -1, stamps = -1;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/rpc/d515_clv_window_counts`, {
      method: "POST", headers: sH(), body: "{}",
    });
    if (r.ok) {
      const v = await r.json();
      const row = Array.isArray(v) ? v[0] : v;
      gamesStarted = row?.games_started ?? -1;
      stamps = row?.stamps ?? -1;
    }
  } catch { /* leave -1 */ }
  if (gamesStarted <= 0) {
    return {
      check_name: "clv_stamp_velocity",
      status: "info",
      detail: `no MLB games started in last 6h — skipping (count=${gamesStarted})`,
      metadata: { gated_by: "gamesStarted_in_window", gamesStarted },
    };
  }
  if (stamps < 0) {
    return { check_name: "clv_stamp_velocity", status: "info", detail: "stamp count fetch failed", metadata: {} };
  }
  const status: Status = stamps >= 10 ? "ok" : stamps >= 1 ? "warn" : "fail";
  return {
    check_name: "clv_stamp_velocity",
    status,
    detail: `${stamps} CLV stamps in last 2h while ${gamesStarted} games started in last 6h (ok>=10, warn>=1, fail=0)`,
    metadata: {
      stamps_2h: stamps,
      games_in_window: gamesStarted,
      threshold_warn: 1,
      threshold_fail: 0,
      signal_source: "pick_history.closing_captured_at",
      d513_finding: "P2 CLV monitoring; D-511 V1/V2 overload would have been caught within 5 min of breakage.",
    },
  };
}

// =====================================================================
// CHECK 9 — D-515: mlb_scoring_progress velocity (closes D-513 §2 marker
// gap). If picks are being written but progress markers aren't, the
// scoring loop is wasting Sonnet credits re-processing the same games.
// =====================================================================
async function checkMlbScoringProgressVelocity(): Promise<CheckResult> {
  // Gate: are picks being written? If not, no scoring activity to monitor.
  const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString();
  const picks = await d515Count(
    `${SUPABASE_URL}/rest/v1/pick_history?sport=eq.mlb&is_synthetic=eq.false&created_at=gte.${encodeURIComponent(fourHoursAgo)}`,
  );
  if (picks <= 0) {
    return {
      check_name: "mlb_scoring_progress_velocity",
      status: "info",
      detail: `no picks written in last 4h (count=${picks}) — skipping`,
      metadata: { gated_by: "picks_written_in_window", picks },
    };
  }
  // Today's marker count (not just last-4h scored_at — markers are
  // upserted ON CONFLICT DO NOTHING, so scored_at doesn't refresh on
  // re-scores. Real signal: do markers exist for today's slate at all?)
  const todayGd = todayYyyymmddEt();
  const markersToday = await d515Count(
    `${SUPABASE_URL}/rest/v1/mlb_scoring_progress?game_date=eq.${todayGd}`,
  );
  if (markersToday < 0) {
    return { check_name: "mlb_scoring_progress_velocity", status: "info", detail: "markers count fetch failed", metadata: {} };
  }
  // If picks are being written for today's slate AND today has 0 markers,
  // that's a real silent marker-write failure. >= 1 marker on today's
  // slate means the marker write IS landing.
  const status: Status = markersToday >= 1 ? "ok" : "fail";
  return {
    check_name: "mlb_scoring_progress_velocity",
    status,
    detail: `${markersToday} progress markers for today's slate (${todayGd}) vs ${picks} picks in last 4h (ok>=1 marker, fail=0)`,
    metadata: {
      markers_today: markersToday,
      picks_4h: picks,
      game_date_et: todayGd,
      threshold_fail: 0,
      signal_source: "mlb_scoring_progress (today's slate count)",
      d513_finding: "P2 D-473/D-508 marker write swallow; if writes fail silently the function re-scores the same games each tick.",
    },
  };
}

// =====================================================================
// CHECK 10 — D-515: odds_api_quota_low (closes D-513 §4 / surfaces the
// existing api_usage data as an alertable check, not just a logged row).
// =====================================================================
async function checkOddsApiQuotaLow(): Promise<CheckResult> {
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/api_usage?http_status=eq.200&select=requests_remaining,called_at&order=called_at.desc&limit=1`,
      { headers: sH() },
    );
    if (!r.ok) {
      return { check_name: "odds_api_quota_low", status: "info", detail: "api_usage fetch failed", metadata: { http: r.status } };
    }
    const rows = await r.json() as Array<{ requests_remaining: number; called_at: string }>;
    if (!Array.isArray(rows) || rows.length === 0) {
      return { check_name: "odds_api_quota_low", status: "info", detail: "no api_usage rows recorded", metadata: {} };
    }
    const { requests_remaining, called_at } = rows[0];
    // Plan is 5M/month per D-342. Warn <20% (1M), fail <10% (500K).
    const status: Status = requests_remaining < 500_000 ? "fail"
                        : requests_remaining < 1_000_000 ? "warn"
                        : "ok";
    return {
      check_name: "odds_api_quota_low",
      status,
      detail: `requests_remaining=${requests_remaining} as of ${called_at} (warn<1M, fail<500K)`,
      metadata: { requests_remaining, called_at, threshold_warn: 1_000_000, threshold_fail: 500_000, plan: "5M/month per D-342" },
    };
  } catch (e) {
    return {
      check_name: "odds_api_quota_low",
      status: "info",
      detail: `query threw: ${e instanceof Error ? e.message : String(e)}`,
      metadata: {},
    };
  }
}

// =====================================================================
// CHECK 11 — D-515: mlb_stats_api_failure (closes D-513 §4 — single
// failures stay logged; persistent failures fire). Counts http_error
// rows from fetch-schedule / fetch-mlb-* error_log entries.
// =====================================================================
async function checkMlbStatsApiFailure(): Promise<CheckResult> {
  const sinceIso = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const count = await d515Count(
    `${SUPABASE_URL}/rest/v1/error_log?phase=in.(fetch-schedule,fetch-boxscore,fetch-people,fetch-pitcher-stats)&error_type=eq.http_error&created_at=gte.${encodeURIComponent(sinceIso)}`,
  );
  if (count < 0) {
    return { check_name: "mlb_stats_api_failure", status: "info", detail: "count fetch failed", metadata: {} };
  }
  const status: Status = count >= 5 ? "fail" : count >= 3 ? "warn" : "ok";
  return {
    check_name: "mlb_stats_api_failure",
    status,
    detail: `${count} MLB Stats API http_error rows in last 60 min (warn=3, fail=5)`,
    metadata: {
      count,
      window_min: 60,
      threshold_warn: 3,
      threshold_fail: 5,
      signal_source: "error_log",
      monitored_phases: ["fetch-schedule", "fetch-boxscore", "fetch-people", "fetch-pitcher-stats"],
      d513_finding: "P2 MLB Stats API single failures logged; D-515 adds the persistent-failure alert.",
    },
  };
}

// =====================================================================
// CHECK 12 — mlb_market_type_constraint_drift (D-529 SHIP 2, the X10 fix)
//
// Closes the D-481 silent-failure class structurally: detect when the
// in-code ALLOWED_MLB_MARKET_TYPES Set in _shared/pick_history_writer.ts
// drifts from the live `pick_history_mlb_market_type_check` CHECK
// constraint. Either side of drift causes silent pick rejection:
//   - missing in code → writer rejects a market the DB accepts (D-481 shape)
//   - extra in code → writer accepts a market the DB rejects (server 23514)
//
// On drift, status=fail + metadata.missingInCode / extraInCode so the
// notify pipeline pages CEO. RPC error → status=warn (transient).
// =====================================================================
async function checkMlbMarketTypeConstraintDrift(): Promise<CheckResult> {
  const report = await assertMlbMarketTypeSetSynced(SUPABASE_URL, SUPABASE_KEY);
  if (report.rpcError) {
    return {
      check_name: "mlb_market_type_constraint_drift",
      status: "warn",
      detail: `drift detector RPC failed: ${report.rpcError.slice(0, 200)}`,
      metadata: { rpc_error: report.rpcError },
    };
  }
  if (report.ok) {
    return {
      check_name: "mlb_market_type_constraint_drift",
      status: "ok",
      detail: `in-code Set matches live CHECK constraint (${report.parsedFromConstraint.length} values)`,
      metadata: {
        parsed_from_constraint: report.parsedFromConstraint,
        d481_class: "structurally_closed",
      },
    };
  }
  // Drift detected. Either side is loud.
  return {
    check_name: "mlb_market_type_constraint_drift",
    status: "fail",
    detail:
      `DRIFT: missingInCode=[${report.missingInCode.join(",")}] ` +
      `extraInCode=[${report.extraInCode.join(",")}] — ` +
      `D-481 incident class. Update ALLOWED_MLB_MARKET_TYPES in ` +
      `_shared/pick_history_writer.ts OR add an ALTER CONSTRAINT migration.`,
    metadata: {
      missingInCode: report.missingInCode,
      extraInCode: report.extraInCode,
      parsedFromConstraint: report.parsedFromConstraint,
      d481_class: "active_drift",
    },
  };
}

// =====================================================================
// CHECK 13 — d537_zero_pick_games (the D-537/D-538 fold-in)
//
// D-537 found that the 10th game of 2026-06-15's slate (STL @ SD,
// gamePk=823046) had its scoring tick logged but ZERO picks written.
// Silent — no error_log row. The dashboard's "9 of 10" hid a whole
// dropped game.
//
// This check compares mlb_scoring_progress (got_scored events) to
// distinct game-team pairs that landed in recommendations_cache for
// the same MLB game_date. Any scored game with 0 rec_cache rows
// triggers a fail.
// =====================================================================
async function checkZeroPickGames(): Promise<CheckResult> {
  // Use the ET game_date used by the cron — yesterday in UTC if it's
  // pre-noon; today otherwise. Approximate: take both today + yesterday
  // (UTC) and report the most recent one with games.
  try {
    const url = `${SUPABASE_URL}/rest/v1/rpc/d538_zero_pick_games`;
    const res = await fetch(url, {
      method: "POST",
      headers: { ...sH(), "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!res.ok) {
      return {
        check_name: "zero_pick_games",
        status: "info",
        detail: `RPC HTTP ${res.status} — check skipped`,
        metadata: { rpc_status: res.status },
      };
    }
    const body = (await res.json()) as {
      game_date?: string;
      scored?: number;
      surfaced?: number;
      missing?: number;
      missing_gamepks?: number[];
    };
    const missing = body.missing ?? 0;
    const status: Status = missing === 0 ? "ok" : missing >= 2 ? "fail" : "warn";
    return {
      check_name: "zero_pick_games",
      status,
      detail: missing === 0
        ? `all ${body.scored ?? "?"} scored gamePks have rec_cache rows on ${body.game_date ?? "?"}`
        : `${missing} scored gamePk(s) have ZERO rec_cache rows on ${body.game_date ?? "?"} — silent game-drop class (D-536/D-537/D-538)`,
      metadata: {
        game_date: body.game_date,
        scored_games: body.scored,
        surfaced_games: body.surfaced,
        missing_count: missing,
        missing_gamepks: body.missing_gamepks ?? [],
        d537_class: missing > 0 ? "ACTIVE_DROP" : "clear",
      },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      check_name: "zero_pick_games",
      status: "info",
      detail: `check error: ${msg.slice(0, 200)}`,
      metadata: { error: msg },
    };
  }
}

// =====================================================================
// MAIN
// =====================================================================
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: { "Access-Control-Allow-Origin": "*" } });

  // Auth gate: accept service-role bearer OR vault BACKFILL_AUTH_TOKEN.
  const auth = req.headers.get("Authorization") ?? "";
  const ok = (SUPABASE_KEY && auth.includes(SUPABASE_KEY)) || (BACKFILL_TOKEN && auth.includes(BACKFILL_TOKEN));
  if (!ok) return j({ error: "unauthorized" }, 401);

  // Run all 12 checks in parallel (each writes independently to health_status).
  // D-515 SHIP 2 added 5 new checks closing D-513's silent-failure findings.
  // D-529 SHIP 2 added mlb_market_type_constraint_drift closing the D-481 class.
  const results = await Promise.all([
    checkSonnetProbe(),
    checkSonnet400Rate(),
    checkMlbCronFreshness(),
    checkMlbWriteVelocity(),
    checkRpcFailedRate(),  // D-481 — closes D-480 monitoring gap
    checkPickHistoryValidationFailedRate(),  // D-489 STAGE 5 — closes hour-0 alerting loop on the unified write-path
    // D-515 SHIP 2 — close D-513 P2 gaps:
    checkPropsCacheWriteVelocity(),
    checkClvStampVelocity(),
    checkMlbScoringProgressVelocity(),
    checkOddsApiQuotaLow(),
    checkMlbStatsApiFailure(),
    // D-529 SHIP 2 — X10 drift detector (closes D-481 incident class):
    checkMlbMarketTypeConstraintDrift(),
    // D-538 (D-537 fold-in) — zero-pick-game detector (the STL@SD class):
    checkZeroPickGames(),
  ]);

  // Persist each result (best-effort, parallel).
  await Promise.all(results.map(persistResult));

  const summary = results.reduce(
    (acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }),
    {} as Record<string, number>,
  );
  const overall: Status = results.some((r) => r.status === "fail")
    ? "fail"
    : results.some((r) => r.status === "warn")
    ? "warn"
    : "ok";

  return j({
    success: true,
    overall,
    summary,
    checks: results,
    timestamp: new Date().toISOString(),
  });
});
