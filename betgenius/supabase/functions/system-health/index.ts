// D-609 — system-health edge function.
//
// Runs 6 checks against live state and writes one row per check_name to
// public.health_status. Admin.tsx red/green banner reads
// health_status_current and surfaces any RED.
//
// Six checks:
//   1. page_fetch          — actual HTTP probes of key page queries
//   2. pick_nan_today      — confidence-NaN validation rejections today
//   3. ai_sonnet_1h        — sonnet HTTP error count last 1h
//   4. resolution_gap      — pending picks >48h + unhandled markets
//   5. game_coverage       — today's MLB scheduled-vs-scored
//   6. factor_flatline     — D-585 flatline pattern on key breakdown factors
//
// Distinct from the existing `health-monitor` (SMS alerting) and
// `health-check` (Odds API quota) functions.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") || "";
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const headers = {
  apikey: SERVICE_ROLE,
  Authorization: `Bearer ${SERVICE_ROLE}`,
  "Content-Type": "application/json",
};

interface CheckResult {
  check_name: string;
  status: "ok" | "fail" | "info";
  detail: string;
  metadata?: Record<string, unknown>;
}

// ─── CHECK 1: page_fetch ───────────────────────────────────────────
async function check_pageFetch(): Promise<CheckResult> {
  const cutoff30d = new Date(Date.now() - 30 * 86400_000).toISOString();
  // 5 probes mirror the EXACT URLs the live pages fire. service_role used
  // for the underlying fetch — RLS is bypassed but column-mismatch /
  // URL-syntax 400s (the D-608 bug class) ARE still detected because
  // they're upstream of RLS.
  const probes: Array<{ name: string; url: string }> = [
    {
      name: "real_money_bets",
      // D-624 — must include a scoped predicate or the view's
      // ranked_matches CTE sorts 74K pick_history rows by lower()
      // casts and times out at 8s (D-623). Real callers (Performance.tsx)
      // pass user_id=eq.${userId} — which short-circuits the join
      // (rm subtree elided when bn is empty). We use a sentinel UUID
      // here so the probe still exercises view-definition + column
      // resolution (catches D-608-class breakage) but completes in <200ms.
      url: `${SUPABASE_URL}/rest/v1/real_money_bets?user_id=eq.00000000-0000-0000-0000-000000000000&order=placed_at.desc,bet_id.desc&limit=1`,
    },
    {
      name: "fetch30d_mlb",
      url: `${SUPABASE_URL}/rest/v1/pick_history?sport=eq.mlb&confidence=gte.80&is_synthetic=eq.false&source=eq.process-games-mlb&created_at=gte.${cutoff30d}&voided=eq.false&select=hit,coin_flip_flag,negative_stacking_flag,unbettable_juice_flag,is_secondary_market,is_d214_quarantined&limit=10`,
    },
    {
      name: "fetchAlgoPicks_mlb",
      url: `${SUPABASE_URL}/rest/v1/pick_history?sport=eq.mlb&recommendation_shown=eq.true&voided=eq.false&hit=not.is.null&select=id,game_date,hit,odds,prop_type,pick_side&order=game_date.asc,id.asc&limit=1`,
    },
    {
      name: "admin_panel_keyset",
      url: `${SUPABASE_URL}/rest/v1/pick_history?voided=not.eq.true&is_synthetic=eq.false&or=(is_d214_quarantined.is.null,is_d214_quarantined.eq.false)&game_date=not.is.null&order=game_date.desc,created_at.desc&limit=1`,
    },
    {
      name: "admin_props_count",
      url: `${SUPABASE_URL}/rest/v1/props_cache?select=id&limit=1`,
    },
  ];

  const failures: Array<{ name: string; status: number; body: string }> = [];
  await Promise.all(probes.map(async (p) => {
    try {
      const res = await fetch(p.url, { headers });
      if (!res.ok) {
        const body = await res.text();
        failures.push({ name: p.name, status: res.status, body: body.slice(0, 300) });
      }
    } catch (e) {
      failures.push({
        name: p.name, status: 0,
        body: e instanceof Error ? e.message.slice(0, 300) : String(e).slice(0, 300),
      });
    }
  }));

  if (failures.length === 0) {
    return {
      check_name: "d609_page_fetch", status: "ok",
      detail: `all ${probes.length} page-fetch probes returned 200`,
      metadata: { probes_count: probes.length, failures: [] },
    };
  }
  return {
    check_name: "d609_page_fetch", status: "fail",
    detail: `${failures.length}/${probes.length} probes failed: ${
      failures.map((f) => `${f.name}=${f.status}`).join(", ")
    }`,
    metadata: { probes_count: probes.length, failures },
  };
}

// ─── CHECK 2: pick_nan_today ───────────────────────────────────────
async function check_pickNanToday(): Promise<CheckResult> {
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const baseUrl =
    `${SUPABASE_URL}/rest/v1/error_log?error_type=eq.pick_history_validation_failed&error_message=ilike.*confidence*non-finite*&created_at=gte.${since}`;
  const sampleRes = await fetch(`${baseUrl}&select=error_message,context&limit=20&order=created_at.desc`, { headers });
  if (!sampleRes.ok) {
    return {
      check_name: "d609_pick_nan_today", status: "info",
      detail: `error_log fetch failed: HTTP ${sampleRes.status}`,
    };
  }
  const rows = await sampleRes.json() as Array<{ error_message: string; context: Record<string, unknown> }>;

  const countRes = await fetch(`${baseUrl}&select=id`, {
    method: "HEAD",
    headers: { ...headers, Prefer: "count=exact", Range: "0-0" },
  });
  let total = rows.length;
  const cr = countRes.headers.get("content-range");
  if (cr) { const t = cr.split("/")[1]; if (t && t !== "*") total = parseInt(t, 10); }

  const byMarket: Record<string, number> = {};
  for (const r of rows) {
    const m = (r.context?.market as string | undefined) ?? "unknown";
    byMarket[m] = (byMarket[m] ?? 0) + 1;
  }

  if (total === 0) {
    return {
      check_name: "d609_pick_nan_today", status: "ok",
      detail: "no NaN-confidence rejections in last 24h",
      metadata: { count: 0 },
    };
  }
  return {
    check_name: "d609_pick_nan_today", status: "fail",
    detail: `${total} NaN-confidence rejections last 24h (sample by-market: ${
      Object.entries(byMarket).map(([k, v]) => `${k}=${v}`).join(", ")
    })`,
    metadata: { count: total, sample_by_market: byMarket },
  };
}

// ─── CHECK 3: ai_sonnet_1h ─────────────────────────────────────────
async function check_aiSonnet1h(): Promise<CheckResult> {
  const since = new Date(Date.now() - 3600_000).toISOString();
  const countUrl =
    `${SUPABASE_URL}/rest/v1/error_log?error_type=ilike.*sonnet*&created_at=gte.${since}&select=id`;
  const countRes = await fetch(countUrl, {
    method: "HEAD",
    headers: { ...headers, Prefer: "count=exact", Range: "0-0" },
  });
  let count = 0;
  const cr = countRes.headers.get("content-range");
  if (cr) { const t = cr.split("/")[1]; if (t && t !== "*") count = parseInt(t, 10); }

  const sampleUrl =
    `${SUPABASE_URL}/rest/v1/error_log?error_type=ilike.*sonnet*&created_at=gte.${since}&select=error_type,error_message,context&order=created_at.desc&limit=1`;
  const sampleRes = await fetch(sampleUrl, { headers });
  let sampleHint = "";
  if (sampleRes.ok) {
    const samples = await sampleRes.json() as Array<{ error_message: string; context: Record<string, unknown> }>;
    if (samples.length > 0) {
      sampleHint = ((samples[0].context?.body as string) ?? samples[0].error_message ?? "").slice(0, 200);
    }
  }

  const THRESHOLD = 5;
  if (count <= THRESHOLD) {
    return {
      check_name: "d609_ai_sonnet_1h", status: "ok",
      detail: `${count} sonnet errors last 1h (threshold ${THRESHOLD})`,
      metadata: { count, threshold: THRESHOLD },
    };
  }
  return {
    check_name: "d609_ai_sonnet_1h", status: "fail",
    detail: `${count} sonnet errors last 1h (threshold ${THRESHOLD}). sample: ${sampleHint}`,
    metadata: { count, threshold: THRESHOLD, sample: sampleHint },
  };
}

// ─── CHECK 4: resolution_gap ───────────────────────────────────────
const RESOLVER_HANDLED_MARKETS = new Set([
  "pitcher_k", "batter_hits", "batter_hr",
  "batter_total_bases", "batter_rbis",
  "game_side", "game_total",
]);

async function check_resolutionGap(): Promise<CheckResult> {
  const cutoff = new Date(Date.now() - 48 * 3600_000).toISOString().slice(0, 10);
  const floor = new Date(Date.now() - 14 * 86400_000).toISOString().slice(0, 10);
  // Per-market HEAD count via Prefer: count=exact. Avoids the HTTP 500
  // that fetching a 2K+ row body triggered. ~9 small probes; each
  // returns just Content-Range. Total ~200 ms.
  const ALL_MARKETS = [
    "batter_hits", "batter_hr", "batter_total_bases", "batter_rbis",
    "batter_runs_scored", "batter_strikeouts", "pitcher_k", "pitcher_outs",
    "game_side", "game_total",
  ];
  const baseFilter =
    `hit=is.null&voided=neq.true&game_date=lte.${cutoff}&game_date=gte.${floor}&sport=eq.mlb&is_synthetic=eq.false`;
  const counts: Record<string, number> = {};
  await Promise.all(ALL_MARKETS.map(async (m) => {
    const url = `${SUPABASE_URL}/rest/v1/pick_history?${baseFilter}&mlb_market_type=eq.${m}&select=id`;
    const res = await fetch(url, {
      method: "HEAD",
      headers: { ...headers, Prefer: "count=exact", Range: "0-0" },
    });
    const cr = res.headers.get("content-range");
    if (cr) {
      const t = cr.split("/")[1];
      if (t && t !== "*") counts[m] = parseInt(t, 10);
    }
  }));
  if (Object.keys(counts).length === 0) {
    return {
      check_name: "d609_resolution_gap", status: "info",
      detail: "no per-market counts returned",
    };
  }
  const unhandled: Record<string, number> = {};
  const handledStuck: Record<string, number> = {};
  for (const [m, n] of Object.entries(counts)) {
    if (!RESOLVER_HANDLED_MARKETS.has(m)) unhandled[m] = n;
    else if (n > 100) handledStuck[m] = n;
  }
  const totalUnhandled = Object.values(unhandled).reduce((a, b) => a + b, 0);
  const totalHandledStuck = Object.values(handledStuck).reduce((a, b) => a + b, 0);

  const totalPending = Object.values(counts).reduce((a, b) => a + b, 0);
  if (totalUnhandled === 0 && totalHandledStuck === 0) {
    return {
      check_name: "d609_resolution_gap", status: "ok",
      detail: `no unhandled markets stuck; all handled markets <100 pending >48h. total pending (14d window): ${totalPending}`,
      metadata: { total_pending: totalPending, by_market: counts },
    };
  }
  return {
    check_name: "d609_resolution_gap", status: "fail",
    detail: `${totalUnhandled} picks in resolver-UNHANDLED markets (${
      Object.keys(unhandled).join("/")
    }) + ${totalHandledStuck} pending in handled markets >100 (${
      Object.keys(handledStuck).join("/")
    }). total pending (14d): ${totalPending}`,
    metadata: {
      unhandled, handled_stuck_over_100: handledStuck,
      total_pending: totalPending, total_unhandled: totalUnhandled,
      total_handled_stuck: totalHandledStuck,
      by_market: counts,
    },
  };
}

// ─── CHECK 5: game_coverage (MLB) ──────────────────────────────────
function todayEtYmdAndDate(): { ymd: string; iso: string } {
  const ymdRaw = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  return { ymd: ymdRaw.replace(/-/g, ""), iso: ymdRaw };
}

async function check_gameCoverage(): Promise<CheckResult> {
  const { ymd, iso } = todayEtYmdAndDate();

  const schedRes = await fetch(
    `${SUPABASE_URL}/rest/v1/cache_mlb_game_scoreboard?game_date=eq.${iso}&select=game_id,home_team,away_team,status`,
    { headers },
  );
  if (!schedRes.ok) {
    return {
      check_name: "d609_game_coverage", status: "info",
      detail: `scoreboard fetch failed: HTTP ${schedRes.status}`,
    };
  }
  const scheduled = await schedRes.json() as Array<{ game_id: number; home_team: string; away_team: string; status: string }>;
  if (scheduled.length === 0) {
    return {
      check_name: "d609_game_coverage", status: "ok",
      detail: "no scheduled games today (off day / pre-cron)",
      metadata: { scheduled: 0 },
    };
  }

  const scoredRes = await fetch(
    `${SUPABASE_URL}/rest/v1/mlb_scoring_progress?game_date=eq.${ymd}&select=game_pk`,
    { headers },
  );
  if (!scoredRes.ok) {
    return {
      check_name: "d609_game_coverage", status: "info",
      detail: `mlb_scoring_progress fetch failed: HTTP ${scoredRes.status}`,
    };
  }
  const scored = await scoredRes.json() as Array<{ game_pk: number }>;
  const scoredSet = new Set(scored.map((s) => s.game_pk));

  const picksRes = await fetch(
    `${SUPABASE_URL}/rest/v1/pick_history?game_date=eq.${iso}&sport=eq.mlb&is_synthetic=eq.false&select=team,opponent`,
    { headers: { ...headers, Range: "0-9999", "Range-Unit": "items" } },
  );
  const teamPickCount: Record<string, number> = {};
  if (picksRes.ok) {
    const picks = await picksRes.json() as Array<{ team: string; opponent: string }>;
    for (const p of picks) {
      const key = `${p.team}|${p.opponent}`;
      teamPickCount[key] = (teamPickCount[key] ?? 0) + 1;
    }
  }

  const silentDrops: Array<{ game_id: number; home: string; away: string }> = [];
  for (const g of scheduled) {
    if (!scoredSet.has(g.game_id)) continue;
    const a = teamPickCount[`${g.home_team}|${g.away_team}`] ?? 0;
    const b = teamPickCount[`${g.away_team}|${g.home_team}`] ?? 0;
    if (a + b === 0) silentDrops.push({ game_id: g.game_id, home: g.home_team, away: g.away_team });
  }

  const scheduledN = scheduled.length;
  const scoredN = scoredSet.size;
  if (silentDrops.length === 0) {
    return {
      check_name: "d609_game_coverage", status: "ok",
      detail: `${scoredN}/${scheduledN} games scored today, no silent drops`,
      metadata: { scheduled: scheduledN, scored: scoredN },
    };
  }
  return {
    check_name: "d609_game_coverage", status: "fail",
    detail: `${silentDrops.length} scored game(s) have ZERO picks (D-537 class). ${scoredN}/${scheduledN} scored`,
    metadata: { scheduled: scheduledN, scored: scoredN, silent_drops: silentDrops },
  };
}

// ─── CHECK 6: factor_flatline ──────────────────────────────────────
const KEY_FACTORS = [
  "home_rapg", "away_rapg",
  "score_batter_hit_rate", "score_opp_pitcher_pitchtype_quality",
];

async function check_factorFlatline(): Promise<CheckResult> {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/pick_history?game_date=eq.${today}&sport=eq.mlb&is_synthetic=eq.false&select=breakdown&limit=2000`,
    { headers },
  );
  if (!res.ok) {
    return {
      check_name: "d609_factor_flatline", status: "info",
      detail: `pick_history fetch failed: HTTP ${res.status}`,
    };
  }
  const rows = await res.json() as Array<{ breakdown: Record<string, unknown> }>;
  if (rows.length < 100) {
    return {
      check_name: "d609_factor_flatline", status: "ok",
      detail: `n=${rows.length} too few picks today to flatline-check`,
      metadata: { n: rows.length },
    };
  }
  const flatlined: Record<string, { top_value: unknown; top_pct: number; distinct: number }> = {};
  for (const factor of KEY_FACTORS) {
    const counts = new Map<string, number>();
    let total = 0;
    for (const r of rows) {
      const v = r.breakdown?.[factor];
      if (v === undefined || v === null) continue;
      const key = JSON.stringify(v);
      counts.set(key, (counts.get(key) ?? 0) + 1);
      total++;
    }
    if (total < 50) continue;
    let topKey = ""; let topN = 0;
    for (const [k, n] of counts.entries()) if (n > topN) { topKey = k; topN = n; }
    const topPct = (topN / total) * 100;
    if (topPct > 80 && counts.size < 5) {
      flatlined[factor] = {
        top_value: JSON.parse(topKey),
        top_pct: Math.round(topPct * 10) / 10,
        distinct: counts.size,
      };
    }
  }
  if (Object.keys(flatlined).length === 0) {
    return {
      check_name: "d609_factor_flatline", status: "ok",
      detail: `no key factor flatlined (n=${rows.length})`,
      metadata: { n: rows.length },
    };
  }
  return {
    check_name: "d609_factor_flatline", status: "fail",
    detail: `${Object.keys(flatlined).length} factor(s) flatlined: ${Object.keys(flatlined).join(", ")}`,
    metadata: { n: rows.length, flatlined },
  };
}

// ─── D-610 generic error_log threshold check ───────────────────────
// Helper: count error_log rows by filter, return CheckResult based on threshold.
async function check_errorLogThreshold(args: {
  checkName: string;
  filter: string;           // PostgREST filter string (without leading &)
  windowMs: number;
  threshold: number;
  label: string;            // human-readable label for detail msg
}): Promise<CheckResult> {
  const since = new Date(Date.now() - args.windowMs).toISOString();
  const url =
    `${SUPABASE_URL}/rest/v1/error_log?${args.filter}&created_at=gte.${since}&select=id`;
  const res = await fetch(url, {
    method: "HEAD",
    headers: { ...headers, Prefer: "count=exact", Range: "0-0" },
  });
  let count = 0;
  const cr = res.headers.get("content-range");
  if (cr) { const t = cr.split("/")[1]; if (t && t !== "*") count = parseInt(t, 10); }
  const windowLabel = args.windowMs >= 86400_000 ? `${args.windowMs / 86400_000}d` : `${args.windowMs / 3600_000}h`;

  if (!res.ok) {
    return {
      check_name: args.checkName, status: "info",
      detail: `error_log HEAD ${args.label}: HTTP ${res.status}`,
    };
  }
  if (count <= args.threshold) {
    return {
      check_name: args.checkName, status: "ok",
      detail: `${count} ${args.label} last ${windowLabel} (threshold ${args.threshold})`,
      metadata: { count, threshold: args.threshold, window: windowLabel },
    };
  }
  return {
    check_name: args.checkName, status: "fail",
    detail: `${count} ${args.label} last ${windowLabel} (threshold ${args.threshold})`,
    metadata: { count, threshold: args.threshold, window: windowLabel },
  };
}

// ─── CHECK 7: d610_rpc_failed_1h ───────────────────────────────────
// D-610 evidence: process-games-mlb type=rpc_failed n=11,303/30d. Last
// active 2026-06-08. May be historical; check catches resurgence.
function check_rpcFailed1h(): Promise<CheckResult> {
  return check_errorLogThreshold({
    checkName: "d610_rpc_failed_1h",
    filter: "error_type=eq.rpc_failed",
    windowMs: 3600_000,
    threshold: 10,
    label: "rpc_failed errors",
  });
}

// ─── CHECK 8: d610_splits_cache_miss_1h ────────────────────────────
// D-610 evidence: process-games-mlb type=splits_cache_miss n=818/30d
// (71 last 24h, recurring). Indicates batter-splits cache holes.
function check_splitsCacheMiss1h(): Promise<CheckResult> {
  return check_errorLogThreshold({
    checkName: "d610_splits_cache_miss_1h",
    filter: "error_type=eq.splits_cache_miss",
    windowMs: 3600_000,
    threshold: 20,
    label: "splits_cache_miss",
  });
}

// ─── CHECK 9: d610_runtime_timeout_24h ─────────────────────────────
// D-610 evidence: process-games-mlb type=runtime_approaching_timeout n=102/30d.
// Last 2026-06-16. Cron tick crossing 130s alert (150s ceiling).
function check_runtimeTimeout24h(): Promise<CheckResult> {
  return check_errorLogThreshold({
    checkName: "d610_runtime_timeout_24h",
    filter: "error_type=eq.runtime_approaching_timeout",
    windowMs: 86400_000,
    threshold: 3,
    label: "runtime_approaching_timeout",
  });
}

// ─── CHECK 10: d610_sonnet_timeout_1h ──────────────────────────────
// D-610 evidence: _shared/anthropic_mlb type=sonnet_timeout n=46/30d
// (4 last 24h). DISTINCT from sonnet_http_error (credit class) — this
// is genuine network/upstream timeout.
function check_sonnetTimeout1h(): Promise<CheckResult> {
  return check_errorLogThreshold({
    checkName: "d610_sonnet_timeout_1h",
    filter: "error_type=eq.sonnet_timeout",
    windowMs: 3600_000,
    threshold: 3,
    label: "sonnet_timeout",
  });
}

// ─── CHECK 11: d610_circuit_breaker_24h ────────────────────────────
// D-610 evidence: fetch-odds + fetch-odds-mlb type=circuit_breaker
// n=150/30d combined. Last 2026-05-27. Odds API quota guard.
function check_circuitBreaker24h(): Promise<CheckResult> {
  return check_errorLogThreshold({
    checkName: "d610_circuit_breaker_24h",
    filter: "error_type=eq.circuit_breaker",
    windowMs: 86400_000,
    threshold: 5,
    label: "Odds API circuit_breaker fires",
  });
}

// ─── CHECK: d654_data_accumulation ─────────────────────────────────
// D-654 SHIP 1 — Standing data-integrity check. Catches the silent-empty
// pattern that lost weeks of data on D-635/D-636/D-562/D-585/D-586.
// Every "accumulating for later validation" dataset must show daily writes.
//
// FAIL when ANY tracked dataset has 0 rows in the LAST 24h while it had
// rows in the prior day (drop-to-zero = silent break). OK when all green.
async function check_d654DataAccumulation(): Promise<CheckResult> {
  try {
    // Each entry: human label + PostgREST URL fragment for last-24h count.
    // PostgREST returns Content-Range header with count when Prefer=count=exact.
    // D-655 SHIP 2 — universal coverage. Every accumulating dataset is
    // registered here, including NBA markets (registered while off-season
    // so we never silently miss a resumed-season write). FAIL on
    // drop-to-zero or >80% drop vs the prior 24h.
    // ── Helpers to compose the URL fragments concisely.
    const playerProps = "batter_hits,batter_hr,batter_total_bases,batter_rbis,batter_strikeouts,batter_runs_scored,pitcher_strikeouts,pitcher_outs";
    const nbaProps = "points,rebounds,assists,steals,blocks,three_pointers_made,double_double,triple_double";
    const datasets: Array<{ key: string; label: string; path24h: string; path_prior24h: string }> = [
      // ─── MLB BATTER MARKETS ────────────────────────────────────────
      {
        key: "mlb_batter_picks_with_breakdown",
        label: "MLB batter picks with non-null breakdown",
        path24h: `pick_history?mlb_market_type=in.(batter_hits,batter_hr,batter_total_bases,batter_rbis,batter_strikeouts,batter_runs_scored)&is_synthetic=eq.false&breakdown=not.is.null&created_at=gte.{NOW_MINUS_24H}`,
        path_prior24h: `pick_history?mlb_market_type=in.(batter_hits,batter_hr,batter_total_bases,batter_rbis,batter_strikeouts,batter_runs_scored)&is_synthetic=eq.false&breakdown=not.is.null&created_at=gte.{NOW_MINUS_48H}&created_at=lt.{NOW_MINUS_24H}`,
      },
      {
        key: "d520_batter_line_hit_rate_writes",
        label: "D-517-v2 batter_line_hit_rate (penalty-only factor) firings",
        path24h: `pick_history?mlb_market_type=in.(batter_hits,batter_hr,batter_total_bases,batter_rbis,batter_strikeouts,batter_runs_scored)&is_synthetic=eq.false&breakdown->>score_batter_line_hit_rate=not.is.null&created_at=gte.{NOW_MINUS_24H}`,
        path_prior24h: `pick_history?mlb_market_type=in.(batter_hits,batter_hr,batter_total_bases,batter_rbis,batter_strikeouts,batter_runs_scored)&is_synthetic=eq.false&breakdown->>score_batter_line_hit_rate=not.is.null&created_at=gte.{NOW_MINUS_48H}&created_at=lt.{NOW_MINUS_24H}`,
      },
      // ─── MLB PITCHER MARKETS ───────────────────────────────────────
      {
        key: "mlb_pitcher_picks_with_breakdown",
        label: "MLB pitcher picks (k + outs) with non-null breakdown",
        path24h: `pick_history?mlb_market_type=in.(pitcher_strikeouts,pitcher_outs)&is_synthetic=eq.false&breakdown=not.is.null&created_at=gte.{NOW_MINUS_24H}`,
        path_prior24h: `pick_history?mlb_market_type=in.(pitcher_strikeouts,pitcher_outs)&is_synthetic=eq.false&breakdown=not.is.null&created_at=gte.{NOW_MINUS_48H}&created_at=lt.{NOW_MINUS_24H}`,
      },
      {
        key: "d596_pitch_type_matchup_writes",
        label: "D-596 score_pitch_type_matchup (pitcher_k Statcast factor) firings",
        path24h: `pick_history?mlb_market_type=eq.pitcher_strikeouts&is_synthetic=eq.false&breakdown->>score_pitch_type_matchup=not.is.null&created_at=gte.{NOW_MINUS_24H}`,
        path_prior24h: `pick_history?mlb_market_type=eq.pitcher_strikeouts&is_synthetic=eq.false&breakdown->>score_pitch_type_matchup=not.is.null&created_at=gte.{NOW_MINUS_48H}&created_at=lt.{NOW_MINUS_24H}`,
      },
      // ─── MLB GAME-SIDE / GAME-TOTAL (v3) ───────────────────────────
      {
        key: "d652_v3_game_side_picks",
        label: "v3-promoted game_side picks (D-652 forward-test)",
        path24h: `pick_history?mlb_market_type=eq.game_side&is_synthetic=eq.false&breakdown->>d652_v3_promoted=eq.true&created_at=gte.{NOW_MINUS_24H}`,
        path_prior24h: `pick_history?mlb_market_type=eq.game_side&is_synthetic=eq.false&breakdown->>d652_v3_promoted=eq.true&created_at=gte.{NOW_MINUS_48H}&created_at=lt.{NOW_MINUS_24H}`,
      },
      {
        key: "d652_v3_game_total_picks",
        label: "v3-promoted game_total picks (D-652 forward-test)",
        path24h: `pick_history?mlb_market_type=eq.game_total&is_synthetic=eq.false&breakdown->>d652_v3_promoted=eq.true&created_at=gte.{NOW_MINUS_24H}`,
        path_prior24h: `pick_history?mlb_market_type=eq.game_total&is_synthetic=eq.false&breakdown->>d652_v3_promoted=eq.true&created_at=gte.{NOW_MINUS_48H}&created_at=lt.{NOW_MINUS_24H}`,
      },
      {
        key: "d653_team_oaa_snapshots",
        label: "Baseball Savant team OAA daily snapshots (D-653)",
        path24h: `cache_mlb_team_oaa?fetched_at=gte.{NOW_MINUS_24H}`,
        path_prior24h: `cache_mlb_team_oaa?fetched_at=gte.{NOW_MINUS_48H}&fetched_at=lt.{NOW_MINUS_24H}`,
      },
      // ─── MLB MARKET SIGNALS (D-635/D-636 — universal across markets) ───
      {
        key: "d635_lm_raw_score_writes_player",
        label: "D-635 line-movement raw scores on PLAYER props",
        path24h: `pick_history?mlb_market_type=in.(${playerProps})&is_synthetic=eq.false&breakdown->>lm_raw_score=not.is.null&created_at=gte.{NOW_MINUS_24H}`,
        path_prior24h: `pick_history?mlb_market_type=in.(${playerProps})&is_synthetic=eq.false&breakdown->>lm_raw_score=not.is.null&created_at=gte.{NOW_MINUS_48H}&created_at=lt.{NOW_MINUS_24H}`,
      },
      {
        key: "d636_rlm_raw_score_writes_player",
        label: "D-636 sharp-money/RLM raw scores on PLAYER props",
        path24h: `pick_history?mlb_market_type=in.(${playerProps})&is_synthetic=eq.false&breakdown->>rlm_raw_score=not.is.null&created_at=gte.{NOW_MINUS_24H}`,
        path_prior24h: `pick_history?mlb_market_type=in.(${playerProps})&is_synthetic=eq.false&breakdown->>rlm_raw_score=not.is.null&created_at=gte.{NOW_MINUS_48H}&created_at=lt.{NOW_MINUS_24H}`,
      },
      {
        key: "d654_lm_raw_score_writes_game",
        label: "D-654 line-movement raw scores on GAME markets (post-fix)",
        path24h: `pick_history?mlb_market_type=in.(game_side,game_total)&is_synthetic=eq.false&breakdown->>lm_raw_score=not.is.null&created_at=gte.{NOW_MINUS_24H}`,
        path_prior24h: `pick_history?mlb_market_type=in.(game_side,game_total)&is_synthetic=eq.false&breakdown->>lm_raw_score=not.is.null&created_at=gte.{NOW_MINUS_48H}&created_at=lt.{NOW_MINUS_24H}`,
      },
      {
        key: "cache_odds_snapshots_writes",
        label: "cache_odds_snapshots (line-movement source)",
        path24h: `cache_odds_snapshots?snapshot_time=gte.{NOW_MINUS_24H}`,
        path_prior24h: `cache_odds_snapshots?snapshot_time=gte.{NOW_MINUS_48H}&snapshot_time=lt.{NOW_MINUS_24H}`,
      },
      // ─── NBA — registered while off-season so the watch is in place
      // when the season resumes (late October). prior-24h=0 → check NOOPs
      // until season resumes; not-a-FAIL because the guard is symmetric.
      {
        key: "nba_player_picks_with_breakdown",
        label: "NBA player-prop picks with non-null breakdown",
        path24h: `pick_history?sport=eq.NBA&is_synthetic=eq.false&breakdown=not.is.null&created_at=gte.{NOW_MINUS_24H}`,
        path_prior24h: `pick_history?sport=eq.NBA&is_synthetic=eq.false&breakdown=not.is.null&created_at=gte.{NOW_MINUS_48H}&created_at=lt.{NOW_MINUS_24H}`,
      },
      {
        key: "nba_blocks_picks",
        label: "NBA blocks picks (highest +EV market per D-557)",
        path24h: `pick_history?sport=eq.NBA&prop_type=eq.blocks&is_synthetic=eq.false&created_at=gte.{NOW_MINUS_24H}`,
        path_prior24h: `pick_history?sport=eq.NBA&prop_type=eq.blocks&is_synthetic=eq.false&created_at=gte.{NOW_MINUS_48H}&created_at=lt.{NOW_MINUS_24H}`,
      },
      {
        key: "nba_spread_picks",
        label: "NBA spread picks (+5.64pp confirmed +EV per D-557)",
        path24h: `pick_history?sport=eq.NBA&prop_type=in.(spread,spreads)&is_synthetic=eq.false&created_at=gte.{NOW_MINUS_24H}`,
        path_prior24h: `pick_history?sport=eq.NBA&prop_type=in.(spread,spreads)&is_synthetic=eq.false&created_at=gte.{NOW_MINUS_48H}&created_at=lt.{NOW_MINUS_24H}`,
      },
      {
        key: "nba_all_player_markets",
        label: "NBA all player-prop markets (broad watch when season active)",
        path24h: `pick_history?sport=eq.NBA&prop_type=in.(${nbaProps})&is_synthetic=eq.false&created_at=gte.{NOW_MINUS_24H}`,
        path_prior24h: `pick_history?sport=eq.NBA&prop_type=in.(${nbaProps})&is_synthetic=eq.false&created_at=gte.{NOW_MINUS_48H}&created_at=lt.{NOW_MINUS_24H}`,
      },
      // ─── CRON HEARTBEAT ────────────────────────────────────────────
      // recommendations_cache fresh-write count — proxy for "scoring path actually wrote something today"
      {
        key: "rec_cache_recent_writes",
        label: "recommendations_cache new writes (any sport, any market)",
        path24h: `recommendations_cache?created_at=gte.{NOW_MINUS_24H}`,
        path_prior24h: `recommendations_cache?created_at=gte.{NOW_MINUS_48H}&created_at=lt.{NOW_MINUS_24H}`,
      },
    ];

    const now = new Date();
    const minus24h = new Date(now.getTime() - 24 * 3600_000).toISOString();
    const minus48h = new Date(now.getTime() - 48 * 3600_000).toISOString();

    async function countViaContentRange(pathFragment: string): Promise<number> {
      const url = `${SUPABASE_URL}/rest/v1/${pathFragment
        .replace("{NOW_MINUS_24H}", encodeURIComponent(minus24h))
        .replace("{NOW_MINUS_48H}", encodeURIComponent(minus48h))}`;
      const r = await fetch(url, {
        headers: { ...headers, Prefer: "count=exact", Range: "0-0" },
      });
      const cr = r.headers.get("Content-Range") ?? "";
      const m = cr.match(/\/(\d+)$/);
      return m ? Number(m[1]) : -1;
    }

    const breaks: Array<{ key: string; label: string; today: number; yesterday: number }> = [];
    const summary: Array<{ key: string; today: number; yesterday: number }> = [];
    for (const ds of datasets) {
      const today = await countViaContentRange(ds.path24h);
      const yesterday = await countViaContentRange(ds.path_prior24h);
      summary.push({ key: ds.key, today, yesterday });
      // FAIL pattern: yesterday had data but today does not → silent break
      if (yesterday > 0 && today === 0) {
        breaks.push({ key: ds.key, label: ds.label, today, yesterday });
      }
      // ALSO surface when yesterday had data and today dropped >80%
      else if (yesterday >= 20 && today < yesterday * 0.2) {
        breaks.push({ key: ds.key, label: `${ds.label} (DROP)`, today, yesterday });
      }
    }

    if (breaks.length > 0) {
      return {
        check_name: "d654_data_accumulation",
        status: "fail",
        detail: `${breaks.length} silent-empty / drop pattern(s): ${breaks.map(b => `${b.key} today=${b.today} yesterday=${b.yesterday}`).join("; ")}`,
        metadata: { breaks, summary, sampled_at: now.toISOString() },
      };
    }
    return {
      check_name: "d654_data_accumulation",
      status: "ok",
      detail: `all ${datasets.length} datasets accumulating today (vs yesterday)`,
      metadata: { summary, sampled_at: now.toISOString() },
    };
  } catch (e) {
    return {
      check_name: "d654_data_accumulation",
      status: "info",
      detail: `check threw: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

// ─── CHECK: d657_worker_resource_limit (D-657 SHIP 4) ──────────────
// D-654's 24h-totals check missed a 2-hour stall — process-games-mlb
// returned WORKER_RESOURCE_LIMIT (status 546) on every */5 tick for 2h
// while d654 still counted yesterday's totals as "ok". FAIL when any 5xx
// or 546 response occurs in the last 30 minutes on the relevant fns.
async function check_d657WorkerResourceLimit(): Promise<CheckResult> {
  try {
    // Use a SECURITY DEFINER RPC to peek at net._http_response (the table
    // isn't reachable directly via PostgREST without elevated privileges).
    const rpcUrl = `${SUPABASE_URL}/rest/v1/rpc/d657_worker_resource_limit_count`;
    const res = await fetch(rpcUrl, {
      method: "POST", headers,
      body: JSON.stringify({}),
    });
    if (!res.ok) {
      return {
        check_name: "d657_worker_resource_limit",
        status: "info",
        detail: `RPC unreachable (HTTP ${res.status}); cannot evaluate`,
      };
    }
    const data = await res.json() as Array<{ window_minutes: number; n_546: number; n_5xx: number; recent_sample: string | null }>;
    const r = (data && data[0]) || { window_minutes: 30, n_546: 0, n_5xx: 0, recent_sample: null };
    if (r.n_546 > 0 || r.n_5xx >= 3) {
      return {
        check_name: "d657_worker_resource_limit",
        status: "fail",
        detail: `${r.n_546} WORKER_RESOURCE_LIMIT (546) responses in last ${r.window_minutes}min, ${r.n_5xx} total 5xx. Sample: ${r.recent_sample ?? "(none)"}`,
        metadata: { ...r },
      };
    }
    return {
      check_name: "d657_worker_resource_limit",
      status: "ok",
      detail: `0 WORKER_RESOURCE_LIMIT in last ${r.window_minutes}min (${r.n_5xx} 5xx total)`,
      metadata: { ...r },
    };
  } catch (e) {
    return {
      check_name: "d657_worker_resource_limit",
      status: "info",
      detail: `check threw: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

// ─── CHECK: d657_snapshot_freshness (D-657 SHIP 4) ─────────────────
// Catches the line-movement-freeze symptom directly: if no row landed
// in cache_odds_snapshots within the last 45 minutes during the active
// snapshot window (`*/30 17-23,0-4 UTC`), flag FAIL.
async function check_d657SnapshotFreshness(): Promise<CheckResult> {
  try {
    const url = `${SUPABASE_URL}/rest/v1/cache_odds_snapshots?select=snapshot_time&order=snapshot_time.desc&limit=1`;
    const res = await fetch(url, { headers });
    if (!res.ok) {
      return {
        check_name: "d657_snapshot_freshness",
        status: "info",
        detail: `query failed HTTP ${res.status}`,
      };
    }
    const rows = await res.json() as Array<{ snapshot_time: string }>;
    if (!rows || rows.length === 0) {
      return {
        check_name: "d657_snapshot_freshness",
        status: "fail",
        detail: "cache_odds_snapshots is EMPTY — no snapshots ever",
      };
    }
    const lastSnap = new Date(rows[0].snapshot_time);
    const ageMinutes = Math.round((Date.now() - lastSnap.getTime()) / 60_000);
    // Only flag during the active window (17:00-04:00 UTC); outside that,
    // a stale snapshot is expected.
    const nowUTC = new Date();
    const hourUTC = nowUTC.getUTCHours();
    const inWindow = hourUTC >= 17 || hourUTC <= 4;
    if (inWindow && ageMinutes > 45) {
      return {
        check_name: "d657_snapshot_freshness",
        status: "fail",
        detail: `last cache_odds_snapshots write was ${ageMinutes}min ago (during active window, threshold 45min). Line movement is FROZEN.`,
        metadata: { age_minutes: ageMinutes, last_snapshot_time: rows[0].snapshot_time, in_active_window: true },
      };
    }
    return {
      check_name: "d657_snapshot_freshness",
      status: "ok",
      detail: `last snapshot ${ageMinutes}min ago; in_active_window=${inWindow}`,
      metadata: { age_minutes: ageMinutes, last_snapshot_time: rows[0].snapshot_time, in_active_window: inWindow },
    };
  } catch (e) {
    return {
      check_name: "d657_snapshot_freshness",
      status: "info",
      detail: `check threw: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
}

// ─── Orchestrator ──────────────────────────────────────────────────
async function writeCheck(c: CheckResult): Promise<void> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/health_status`, {
    method: "POST",
    headers: { ...headers, Prefer: "return=minimal" },
    body: JSON.stringify({
      check_name: c.check_name, status: c.status,
      detail: c.detail, metadata: c.metadata ?? {},
    }),
  });
  if (!res.ok) console.log(`[system-health] write failed for ${c.check_name}: HTTP ${res.status}`);
}

Deno.serve(async (req) => {
  if (!SUPABASE_URL || !SERVICE_ROLE) {
    return new Response(JSON.stringify({ success: false, error: "missing supabase env" }), {
      status: 500, headers: { "Content-Type": "application/json" },
    });
  }
  void req;

  const started = Date.now();
  const results = await Promise.all([
    check_pageFetch().catch((e) => ({
      check_name: "d609_page_fetch", status: "info" as const,
      detail: `check threw: ${e instanceof Error ? e.message : String(e)}`,
    })),
    check_pickNanToday().catch((e) => ({
      check_name: "d609_pick_nan_today", status: "info" as const,
      detail: `check threw: ${e instanceof Error ? e.message : String(e)}`,
    })),
    check_aiSonnet1h().catch((e) => ({
      check_name: "d609_ai_sonnet_1h", status: "info" as const,
      detail: `check threw: ${e instanceof Error ? e.message : String(e)}`,
    })),
    check_resolutionGap().catch((e) => ({
      check_name: "d609_resolution_gap", status: "info" as const,
      detail: `check threw: ${e instanceof Error ? e.message : String(e)}`,
    })),
    check_gameCoverage().catch((e) => ({
      check_name: "d609_game_coverage", status: "info" as const,
      detail: `check threw: ${e instanceof Error ? e.message : String(e)}`,
    })),
    check_factorFlatline().catch((e) => ({
      check_name: "d609_factor_flatline", status: "info" as const,
      detail: `check threw: ${e instanceof Error ? e.message : String(e)}`,
    })),
    // D-610 evidence-driven additions:
    check_rpcFailed1h().catch((e) => ({
      check_name: "d610_rpc_failed_1h", status: "info" as const,
      detail: `check threw: ${e instanceof Error ? e.message : String(e)}`,
    })),
    check_splitsCacheMiss1h().catch((e) => ({
      check_name: "d610_splits_cache_miss_1h", status: "info" as const,
      detail: `check threw: ${e instanceof Error ? e.message : String(e)}`,
    })),
    check_runtimeTimeout24h().catch((e) => ({
      check_name: "d610_runtime_timeout_24h", status: "info" as const,
      detail: `check threw: ${e instanceof Error ? e.message : String(e)}`,
    })),
    check_sonnetTimeout1h().catch((e) => ({
      check_name: "d610_sonnet_timeout_1h", status: "info" as const,
      detail: `check threw: ${e instanceof Error ? e.message : String(e)}`,
    })),
    check_circuitBreaker24h().catch((e) => ({
      check_name: "d610_circuit_breaker_24h", status: "info" as const,
      detail: `check threw: ${e instanceof Error ? e.message : String(e)}`,
    })),
    // D-654 SHIP 1 — silent-empty / drop guard on accumulating datasets.
    check_d654DataAccumulation().catch((e) => ({
      check_name: "d654_data_accumulation", status: "info" as const,
      detail: `check threw: ${e instanceof Error ? e.message : String(e)}`,
    })),
    // D-657 SHIP 4 — WORKER_RESOURCE_LIMIT burn + snapshot freshness.
    check_d657WorkerResourceLimit().catch((e) => ({
      check_name: "d657_worker_resource_limit", status: "info" as const,
      detail: `check threw: ${e instanceof Error ? e.message : String(e)}`,
    })),
    check_d657SnapshotFreshness().catch((e) => ({
      check_name: "d657_snapshot_freshness", status: "info" as const,
      detail: `check threw: ${e instanceof Error ? e.message : String(e)}`,
    })),
  ]);

  for (const r of results) await writeCheck(r);

  const elapsed = Date.now() - started;
  return new Response(JSON.stringify({
    success: true, elapsed_ms: elapsed,
    checks: results.map((r) => ({ name: r.check_name, status: r.status, detail: r.detail })),
    red_count: results.filter((r) => r.status === "fail").length,
    unknown_count: results.filter((r) => r.status === "info").length,
  }, null, 2), { status: 200, headers: { "Content-Type": "application/json" } });
});
