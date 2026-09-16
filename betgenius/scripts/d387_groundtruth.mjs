#!/usr/bin/env node
// D-387 SHIP 2 ground-truth deep probe — narrower windows so PostgREST
// doesn't timeout. Specifically MLB-focused: is process-games-mlb writing
// picks on schedule, are old rows getting refreshed, is the D-374
// Live/Final skip still holding.

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

const H = { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` };

async function rest(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: H });
  if (!res.ok) return { error: `${res.status} ${(await res.text()).slice(0, 150)}` };
  return { data: await res.json(), count: res.headers.get("content-range") };
}
async function head(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: { ...H, Prefer: "count=exact", Range: "0-0" } });
  return { count: res.headers.get("content-range"), status: res.status };
}

const out = { ts_utc: new Date().toISOString() };

async function main() {
  const todayUtc = new Date().toISOString().slice(0, 10);
  const yest = new Date(Date.now() - 86400 * 1000).toISOString().slice(0, 10);
  const day2 = new Date(Date.now() - 2 * 86400 * 1000).toISOString().slice(0, 10);
  const day3 = new Date(Date.now() - 3 * 86400 * 1000).toISOString().slice(0, 10);
  const day7 = new Date(Date.now() - 7 * 86400 * 1000).toISOString().slice(0, 10);

  console.log(`Today (UTC): ${todayUtc}\n`);

  // (a) MLB rec_cache row counts per day, last 7 days, via HEAD count
  console.log("=== (a) MLB recommendations_cache row counts per game_date (last 7d) ===");
  out.recs_by_day = [];
  for (let i = 0; i <= 7; i++) {
    const d = new Date(Date.now() - i * 86400 * 1000).toISOString().slice(0, 10);
    const h = await head(`recommendations_cache?sport=eq.mlb&game_date=eq.${d}&select=id`);
    const n = h.count ? parseInt(h.count.split("/").pop(), 10) : null;
    out.recs_by_day.push({ game_date: d, count: n });
    console.log(`  ${d}: ${n} rows`);
  }

  // (b) Today's MLB rec_cache: created_at min/max + last_writer distribution
  console.log("\n=== (b) Today MLB rec_cache freshness + last_writer ===");
  const today = await rest(`recommendations_cache?sport=eq.mlb&game_date=eq.${todayUtc}&select=created_at,last_writer,prop_type,confidence&order=created_at.asc&limit=2000`);
  if (today.error) {
    console.log("  query error:", today.error);
  } else {
    const writers = new Map();
    const propTypes = new Map();
    let minCa = null, maxCa = null;
    for (const r of today.data) {
      const w = r.last_writer || "(null)";
      writers.set(w, (writers.get(w) || 0) + 1);
      const pt = r.prop_type || "(null)";
      propTypes.set(pt, (propTypes.get(pt) || 0) + 1);
      if (!minCa || r.created_at < minCa) minCa = r.created_at;
      if (!maxCa || r.created_at > maxCa) maxCa = r.created_at;
    }
    console.log(`  total today: ${today.data.length}`);
    console.log(`  oldest created_at: ${minCa}`);
    console.log(`  newest created_at: ${maxCa}`);
    console.log(`  age of newest: ${maxCa ? Math.floor((Date.now() - new Date(maxCa).getTime()) / 60000) + "m" : "n/a"}`);
    console.log("\n  last_writer distribution:");
    for (const [w, n] of [...writers.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(w).padEnd(40).slice(0, 40)}  ${n}`);
    }
    console.log("\n  prop_type distribution:");
    for (const [pt, n] of [...propTypes.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(pt).padEnd(28).slice(0, 28)}  ${n}`);
    }
    out.recs_today = { total: today.data.length, min_created_at: minCa, max_created_at: maxCa, writers: Object.fromEntries(writers), prop_types: Object.fromEntries(propTypes) };
  }

  // (c) Yesterday's slate — any picks frozen on already-final games?
  console.log("\n=== (c) Yesterday MLB rec_cache (game_date=yesterday) — any frozen rows? ===");
  const yestRows = await rest(`recommendations_cache?sport=eq.mlb&game_date=eq.${yest}&select=created_at,last_writer,prop_type&order=created_at.asc&limit=500`);
  if (!yestRows.error) {
    let minCa = null, maxCa = null;
    const writers = new Map();
    for (const r of yestRows.data) {
      if (!minCa || r.created_at < minCa) minCa = r.created_at;
      if (!maxCa || r.created_at > maxCa) maxCa = r.created_at;
      const w = r.last_writer || "(null)";
      writers.set(w, (writers.get(w) || 0) + 1);
    }
    console.log(`  total yesterday: ${yestRows.data.length}`);
    console.log(`  oldest created_at: ${minCa}`);
    console.log(`  newest created_at: ${maxCa}`);
    console.log(`  last_writer distribution:`);
    for (const [w, n] of [...writers.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`    ${String(w).padEnd(40).slice(0, 40)}  ${n}`);
    }
    out.recs_yesterday = { total: yestRows.data.length, min_created_at: minCa, max_created_at: maxCa, writers: Object.fromEntries(writers) };
  }

  // (d) D-374 Live/Final skip: are there any rec_cache rows from today that
  //     were UPDATED (created_at older than current cron tick) during a
  //     live/final game?
  //     Simpler proxy: check pick_history for live MLB picks created today,
  //     and look for rows with the same (player_name, prop_type, line) that
  //     have multiple created_at timestamps in the same day — indicates
  //     re-scoring.
  console.log("\n=== (d) Today MLB pick_history live writes — duplicate-write check (D-374 regression check) ===");
  const ph = await rest(`pick_history?sport=eq.mlb&is_synthetic=eq.false&created_at=gte.${todayUtc}&select=player_name,prop_type,pick_side,line,created_at,confidence&order=created_at.asc&limit=5000`);
  if (!ph.error) {
    const sigCounts = new Map();
    const sigTimes = new Map();
    for (const r of ph.data) {
      const sig = `${r.player_name}|${r.prop_type}|${r.pick_side}|${r.line}`;
      sigCounts.set(sig, (sigCounts.get(sig) || 0) + 1);
      const arr = sigTimes.get(sig) || [];
      arr.push(r.created_at);
      sigTimes.set(sig, arr);
    }
    const dupes = [...sigCounts.entries()].filter(([_, n]) => n > 1).sort((a, b) => b[1] - a[1]);
    console.log(`  total today rows: ${ph.data.length}`);
    console.log(`  unique signatures: ${sigCounts.size}`);
    console.log(`  signatures appearing >1× today: ${dupes.length}`);
    if (dupes.length > 0) {
      console.log("  top 10 dupes (signature: count):");
      for (const [sig, n] of dupes.slice(0, 10)) {
        const times = sigTimes.get(sig).map(t => t.slice(11, 19)).join(", ");
        console.log(`    ${sig}  ×${n}  at: ${times}`);
      }
    } else {
      console.log("  no dupes — D-374 Live/Final skip appears to be holding");
    }
    out.ph_today_dupes = dupes.slice(0, 20).map(([sig, n]) => ({ signature: sig, count: n, times: sigTimes.get(sig) }));
  }

  // (e) audit-resolution-coverage heartbeat: chronic partial — what does the error say in full?
  console.log("\n=== (e) audit-resolution-coverage heartbeat detail ===");
  const arc = await rest(`cron_heartbeat?job_name=eq.audit-resolution-coverage&select=*&limit=1`);
  if (!arc.error && arc.data[0]) {
    const r = arc.data[0];
    console.log(`  last_fired_at: ${r.last_fired_at}`);
    console.log(`  status: ${r.last_status}`);
    console.log(`  consecutive_failures: ${r.consecutive_failures}`);
    console.log(`  expected_interval_seconds: ${r.expected_interval_seconds}`);
    console.log(`  last_error: ${r.last_error || "(null)"}`);
    out.audit_resolution_coverage = r;
  }

  // (f) Run log: any non-skip MLB recent entries?
  console.log("\n=== (f) run_log non-skip recent entries (any?) ===");
  const runlog = await rest(`run_log?select=created_at,notes&order=created_at.desc&limit=100&notes=not.like.skipped*`);
  if (!runlog.error) {
    out.run_log_nonskip = runlog.data;
    if (runlog.data.length === 0) {
      console.log("  NONE — all recent run_log entries are 'skipped'");
    } else {
      console.log(`  ${runlog.data.length} non-skip entries:`);
      for (const r of runlog.data.slice(0, 10)) {
        console.log(`    ${r.created_at.slice(0, 19)}  ${(r.notes || "").slice(0, 100)}`);
      }
    }
  }

  // (g) NBA props_cache check (out of D-387 scope but informative — confirms why process-games NBA is skipping)
  console.log("\n=== (g) NBA props_cache freshness (informational — confirms why NBA is skipping) ===");
  const propsToday = await head(`props_cache?game_date=eq.${todayUtc.replace(/-/g, "")}&select=id`);
  const propsYest = await head(`props_cache?game_date=eq.${yest.replace(/-/g, "")}&select=id`);
  const props2d = await head(`props_cache?game_date=eq.${day2.replace(/-/g, "")}&select=id`);
  const props3d = await head(`props_cache?game_date=eq.${day3.replace(/-/g, "")}&select=id`);
  console.log(`  ${todayUtc}: ${propsToday.count} / ${yest}: ${propsYest.count} / ${day2}: ${props2d.count} / ${day3}: ${props3d.count}`);
  out.props_cache_recent = {
    [todayUtc]: propsToday.count,
    [yest]: propsYest.count,
    [day2]: props2d.count,
    [day3]: props3d.count,
  };

  // (h) Heartbeat lag: process-games-mlb pg_cron last vs heartbeat last
  console.log("\n=== (h) Heartbeat lag: pg_cron vs cron_heartbeat for process-games-mlb ===");
  const lac = await fetch(`${SUPABASE_URL}/rest/v1/rpc/list_active_crons`, { method: "POST", headers: { ...H, "Content-Type": "application/json" }, body: "{}" });
  if (lac.ok) {
    const crons = await lac.json();
    const pgm = crons.find((c) => c.jobname === "process-games-mlb-30min");
    const hb = await rest(`cron_heartbeat?job_name=eq.process-games-mlb&select=last_fired_at,last_status,last_duration_ms,consecutive_failures&limit=1`);
    if (pgm && hb.data?.[0]) {
      console.log(`  pg_cron jobid=${pgm.jobid} last_run_started_at=${pgm.last_run_started_at} status=${pgm.last_run_status} dur_ms=${pgm.last_run_duration_ms}`);
      console.log(`  heartbeat last_fired_at=${hb.data[0].last_fired_at} status=${hb.data[0].last_status} fails=${hb.data[0].consecutive_failures}`);
      const lagMs = new Date(pgm.last_run_started_at).getTime() - new Date(hb.data[0].last_fired_at).getTime();
      console.log(`  delta (pg_cron last_run_started − heartbeat last_fired): ${(lagMs / 60000).toFixed(1)} minutes`);
      out.heartbeat_lag_process_games_mlb = {
        pg_cron_last_run_started_at: pgm.last_run_started_at,
        pg_cron_status: pgm.last_run_status,
        heartbeat_last_fired_at: hb.data[0].last_fired_at,
        heartbeat_status: hb.data[0].last_status,
        lag_minutes: (lagMs / 60000).toFixed(1),
      };
    }
  }

  // (i) Same heartbeat lag check for NBA process-games (the 50h stale entry)
  console.log("\n=== (i) Heartbeat lag: process-games (NBA) — heartbeat says May 30, pg_cron job 9 says today ===");
  const job9 = await rest(`cron_heartbeat?job_name=eq.process-games&select=last_fired_at,last_status,last_duration_ms,consecutive_failures&limit=1`);
  if (!job9.error && job9.data?.[0]) {
    const h = job9.data[0];
    console.log(`  heartbeat last_fired_at: ${h.last_fired_at}  status: ${h.last_status}  fails: ${h.consecutive_failures}`);
    console.log(`  (compare pg_cron jobid 9 process-games-progressive last fire: 2026-06-01 20:30 — these may be the same or different functions)`);
    out.heartbeat_lag_process_games_nba = h;
  }

  // (j) Same for resolve-picks heartbeat 4d stale
  const job_rp = await rest(`cron_heartbeat?job_name=eq.resolve-picks&select=last_fired_at,last_status,last_duration_ms,consecutive_failures&limit=1`);
  if (!job_rp.error && job_rp.data?.[0]) {
    console.log(`\n=== (j) resolve-picks heartbeat ===`);
    const h = job_rp.data[0];
    console.log(`  heartbeat last_fired_at: ${h.last_fired_at}  status: ${h.last_status}  fails: ${h.consecutive_failures}`);
    out.heartbeat_resolve_picks = h;
  }

  writeFileSync(resolve(REPORT_DIR, "d387_groundtruth.json"), JSON.stringify(out, null, 2));
  console.log(`\nWrote ${resolve(REPORT_DIR, "d387_groundtruth.json")}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
