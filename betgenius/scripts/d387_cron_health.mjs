#!/usr/bin/env node
// D-387 — MLB auto-cron health diagnostic. READ-ONLY.
//
// Pulls evidence from:
//   1. list_active_crons() RPC (D-272 INF-1) — pg_cron + recent run details
//   2. cron_heartbeat table (D-272 INF-2) — what each cron self-reports
//   3. recommendations_cache — actual rows landed per day (cross-check vs cron success)
//   4. pick_history — live MLB writes per day (downstream check)
//   5. run_log — process-games run history if present
//
// The point: never trust a cron's "success" flag without confirming rows
// actually landed downstream. The #21 + #32 + #45 + #25 failure pattern is
// "cron reports success but writes nothing." Cross-check both sides.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const REPORT_DIR = resolve(projectRoot, "docs", "loop", "reports");
mkdirSync(REPORT_DIR, { recursive: true });

const envLocal = readFileSync(resolve(projectRoot, ".env.local"), "utf8");
const SUPABASE_URL = envLocal.match(/VITE_SUPABASE_URL=["']?([^"'\n]+)/)[1];
const SERVICE_ROLE = envLocal.match(/SUPABASE_SERVICE_ROLE_KEY=["']?([^"'\n]+)/)[1];

const HEADERS = {
  apikey: SERVICE_ROLE,
  Authorization: `Bearer ${SERVICE_ROLE}`,
  "Content-Type": "application/json",
};

async function rpc(name, body = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    return { error: `${res.status} ${await res.text()}` };
  }
  return { data: await res.json() };
}

async function rest(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: HEADERS });
  if (!res.ok) return { error: `${res.status} ${await res.text()}` };
  return { data: await res.json(), countRange: res.headers.get("content-range") };
}

const result = {
  ts_utc: new Date().toISOString(),
  ship1_topology: null,
  ship1_mlb_crons: [],
  ship1_heartbeats: [],
  ship2_recs_cache_daily: [],
  ship2_pick_history_daily: [],
  ship2_recs_cache_today_writers: [],
  ship2_recs_freshness: null,
  ship2_frozen_rows_check: null,
  ship2_run_log_recent: null,
  ship3_anomalies: [],
};

async function main() {
  console.log("=== D-387 SHIP 1: cron topology + firing history ===\n");

  // (1) list_active_crons RPC — pg_cron source of truth
  const lac = await rpc("list_active_crons");
  if (lac.error) {
    console.error("list_active_crons RPC failed:", lac.error);
    result.ship1_topology = { error: lac.error };
  } else {
    result.ship1_topology = lac.data;
    console.log(`Total cron jobs: ${lac.data.length}\n`);
    console.log("  jobid | active | name                                | schedule        | last_run_started_at  | last_status   | streak");
    console.log("  ------+--------+-------------------------------------+-----------------+----------------------+---------------+-------");
    const mlbRe = /mlb|process-games|fetch-odds|fetch-weather|fetch-ballpark|fetch-umpire|fetch-baseball-savant|calibration|replay-historical/i;
    for (const r of lac.data) {
      const isMlb = (r.jobname && mlbRe.test(r.jobname));
      if (isMlb) result.ship1_mlb_crons.push(r);
      const t = r.last_run_started_at ? new Date(r.last_run_started_at).toISOString().slice(0, 19).replace("T", " ") : "(never)";
      console.log(`  ${String(r.jobid).padStart(5)} | ${String(r.active).padEnd(6)} | ${String(r.jobname || "(null)").padEnd(35).slice(0, 35)} | ${String(r.schedule || "").padEnd(15)} | ${t.padEnd(20)} | ${String(r.last_run_status || "").padEnd(13)} | ${r.consecutive_failures}`);
    }
    console.log(`\nMLB-relevant crons: ${result.ship1_mlb_crons.length}`);
  }

  // (2) cron_heartbeat — what crons self-report (separate from pg_cron's status)
  const hb = await rest("cron_heartbeat?select=job_name,last_fired_at,last_status,last_duration_ms,last_error,consecutive_failures,expected_interval_seconds&order=last_fired_at.desc&limit=100");
  if (hb.error) {
    console.error("cron_heartbeat fetch failed:", hb.error);
  } else {
    result.ship1_heartbeats = hb.data;
    console.log(`\n=== cron_heartbeat (self-reported, ${hb.data.length} rows) ===\n`);
    console.log("  job_name                                  | last_fired_at        | status   | dur_ms | fails | interval_s | last_error_short");
    console.log("  ------------------------------------------+----------------------+----------+--------+-------+------------+-----------------");
    for (const r of hb.data) {
      const t = r.last_fired_at ? new Date(r.last_fired_at).toISOString().slice(0, 19).replace("T", " ") : "(never)";
      const err = (r.last_error || "").replace(/\s+/g, " ").slice(0, 40);
      console.log(`  ${String(r.job_name).padEnd(41).slice(0, 41)} | ${t} | ${String(r.last_status).padEnd(8)} | ${String(r.last_duration_ms ?? "").padStart(6)} | ${String(r.consecutive_failures).padStart(5)} | ${String(r.expected_interval_seconds ?? "").padStart(10)} | ${err}`);
    }
  }

  console.log("\n=== D-387 SHIP 2: ground-truth — are picks landing? ===\n");

  // (3) recommendations_cache rows per day for last 14 days (MLB only)
  const sinceIso = new Date(Date.now() - 14 * 86400 * 1000).toISOString();
  const recsRecent = await rest(`recommendations_cache?sport=eq.mlb&created_at=gte.${sinceIso}&select=created_at,player_name,confidence,last_writer,prop_type&order=created_at.desc&limit=10000`);
  if (recsRecent.error) {
    console.error("recommendations_cache fetch failed:", recsRecent.error);
  } else {
    // Bucket by day
    const byDay = new Map();
    const byWriter = new Map();
    const byPropType = new Map();
    let oldestSeen = null;
    let newestSeen = null;
    for (const r of recsRecent.data) {
      const day = r.created_at.slice(0, 10);
      byDay.set(day, (byDay.get(day) || 0) + 1);
      const w = r.last_writer || "(null)";
      byWriter.set(w, (byWriter.get(w) || 0) + 1);
      const pt = r.prop_type || "(null)";
      byPropType.set(pt, (byPropType.get(pt) || 0) + 1);
      if (!oldestSeen || r.created_at < oldestSeen) oldestSeen = r.created_at;
      if (!newestSeen || r.created_at > newestSeen) newestSeen = r.created_at;
    }
    result.ship2_recs_cache_daily = [...byDay.entries()].sort();
    console.log("recommendations_cache MLB rows by created_at day (last 14d):");
    for (const [day, n] of result.ship2_recs_cache_daily) console.log(`  ${day}: ${n}`);
    console.log(`  newest: ${newestSeen}  oldest_in_window: ${oldestSeen}  total_fetched: ${recsRecent.data.length}`);
    result.ship2_recs_freshness = { newest_created_at: newestSeen, oldest_in_window: oldestSeen, total: recsRecent.data.length };

    console.log("\nMLB rec_cache by last_writer (last 14d, cap 10k):");
    const writerSorted = [...byWriter.entries()].sort((a, b) => b[1] - a[1]);
    for (const [w, n] of writerSorted) {
      console.log(`  ${String(w).padEnd(40).slice(0, 40)}  ${n}`);
      result.ship2_recs_cache_today_writers.push({ writer: w, count: n });
    }

    console.log("\nMLB rec_cache by prop_type (last 14d):");
    for (const [pt, n] of [...byPropType.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(pt).padEnd(28).slice(0, 28)}  ${n}`);
    }
  }

  // (4) Frozen-row check: any rec_cache row with created_at significantly older than its game_date?
  const frozen = await rest(`recommendations_cache?sport=eq.mlb&select=player_name,prop_type,confidence,game_date,created_at&game_date=gte.${new Date(Date.now() - 14 * 86400 * 1000).toISOString().slice(0, 10)}&order=created_at.asc&limit=20`);
  if (!frozen.error) {
    const fz = frozen.data.map((r) => {
      const gd = r.game_date;
      const ca = r.created_at;
      const ageDays = gd && ca ? Math.floor((new Date(`${gd}T00:00:00Z`).getTime() - new Date(ca).getTime()) / 86400000) : null;
      return { ...r, age_days: ageDays };
    });
    result.ship2_frozen_rows_check = fz;
    console.log("\nOldest-created MLB rec_cache rows (window: game_date last 14d):");
    for (const r of fz.slice(0, 8)) {
      console.log(`  game_date=${r.game_date}  created_at=${r.created_at}  age_days=${r.age_days}  ${r.player_name}/${r.prop_type}/${r.confidence}`);
    }
  }

  // (5) pick_history live MLB writes per day last 14d
  const ph = await rest(`pick_history?sport=eq.mlb&is_synthetic=eq.false&created_at=gte.${sinceIso}&select=created_at,confidence,hit&order=created_at.desc&limit=10000`);
  if (!ph.error) {
    const byDay = new Map();
    let hitCount = 0, unresolvedCount = 0, totalCount = ph.data.length;
    let newestSeen = null;
    for (const r of ph.data) {
      const day = r.created_at.slice(0, 10);
      byDay.set(day, (byDay.get(day) || 0) + 1);
      if (r.hit === true || r.hit === false) hitCount++;
      else unresolvedCount++;
      if (!newestSeen || r.created_at > newestSeen) newestSeen = r.created_at;
    }
    result.ship2_pick_history_daily = [...byDay.entries()].sort();
    console.log("\npick_history live MLB rows by created_at day (last 14d):");
    for (const [day, n] of result.ship2_pick_history_daily) console.log(`  ${day}: ${n}`);
    console.log(`  total: ${totalCount}  resolved: ${hitCount}  unresolved: ${unresolvedCount}  newest: ${newestSeen}`);
  }

  // (6) run_log recent (process-games tracker)
  const rl = await rest(`run_log?select=*&order=created_at.desc&limit=10`);
  if (!rl.error) {
    result.ship2_run_log_recent = rl.data;
    console.log("\nrun_log recent (10 newest):");
    for (const r of rl.data.slice(0, 10)) {
      const t = r.created_at ? r.created_at.slice(0, 19).replace("T", " ") : "(null)";
      console.log(`  ${t}  ${(r.notes || "").slice(0, 90)}`);
    }
  } else {
    console.log("\nrun_log not accessible:", rl.error.slice(0, 80));
  }

  // (7) Cron-level cross-check: for each MLB-relevant cron with recent run, did rec_cache get rows?
  console.log("\n=== Cron-vs-output cross-check ===");
  const now = Date.now();
  for (const cron of result.ship1_mlb_crons) {
    const lastRun = cron.last_run_started_at ? new Date(cron.last_run_started_at).getTime() : null;
    const ageMin = lastRun ? Math.floor((now - lastRun) / 60000) : null;
    let writerHits = null;
    const writeMatch = result.ship2_recs_cache_today_writers.find((w) => cron.jobname && (w.writer.includes(cron.jobname.split("-")[0]) || cron.jobname.includes(w.writer.split("-")[0])));
    if (writeMatch) writerHits = writeMatch.count;
    console.log(`  ${cron.jobname} (jobid=${cron.jobid}) last_ran=${ageMin === null ? "never" : ageMin + "m ago"} status=${cron.last_run_status} streak=${cron.consecutive_failures}`);
  }

  // Persist full JSON
  const outPath = resolve(REPORT_DIR, "d387_cron_health.json");
  writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`\nWrote ${outPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
