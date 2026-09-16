#!/usr/bin/env node
// D-396 SHIP 3 — architecture audit. READ-ONLY.
//
// For each edge function: classify LIVE / DELETE-CANDIDATE / UNSURE.
// Evidence:
//   (a) cron.job command references (pg_cron schedules)
//   (b) frontend src/ fetch references
//   (c) inter-function references (one function calling another)

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const REPORT_DIR = resolve(projectRoot, "docs", "loop", "reports");
const FUNCTIONS_DIR = resolve(projectRoot, "supabase", "functions");
const FRONTEND_DIR = resolve(projectRoot, "src");

const envLocal = readFileSync(resolve(projectRoot, ".env.local"), "utf8");
const SUPABASE_URL = envLocal.match(/VITE_SUPABASE_URL=["]?([^"\n]+)/)[1];
const SERVICE_ROLE = envLocal.match(/SUPABASE_SERVICE_ROLE_KEY=["]?([^"\n]+)/)[1];
const H = { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}`, "Content-Type": "application/json" };

// 1. List all function directories
const allEntries = readdirSync(FUNCTIONS_DIR);
const functions = allEntries.filter(name => {
  if (name === "_shared") return false;
  const stat = statSync(join(FUNCTIONS_DIR, name));
  return stat.isDirectory();
});
console.log(`Found ${functions.length} edge function directories`);

// 2. Fetch cron schedule from pg_cron via list_active_crons RPC
async function fetchCrons() {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/list_active_crons`, { method: "POST", headers: H, body: "{}" });
  if (!res.ok) return [];
  return await res.json();
}

// 3. Map cron jobname → function URL (best-effort: jobname often matches function name pattern)
const crons = await fetchCrons();
console.log(`Active pg_cron jobs: ${crons.length}`);

// We need to know which function each cron INVOKES. The command text isn't in
// list_active_crons; we infer from jobname + the URL pattern we know
// (functions/v1/<fn-name>). Most cron jobnames include the function name.

// Build a map: function name → list of crons that probably reference it (by jobname matching)
const cronRefByFn = new Map();
for (const c of crons) {
  const jn = (c.jobname || "").toLowerCase();
  for (const fn of functions) {
    const fnKey = fn.toLowerCase();
    // jobname often == "<fn-name>-30min" or "<fn-name>-daily" etc; check if fn name is a prefix substring
    if (jn.includes(fnKey)) {
      if (!cronRefByFn.has(fn)) cronRefByFn.set(fn, []);
      cronRefByFn.get(fn).push({ jobid: c.jobid, jobname: c.jobname, schedule: c.schedule });
    }
  }
}

// 4. Frontend references: grep src/ for `functions/v1/<fn-name>` or fn-name in URLs
function gitGrep(pattern, dir) {
  try {
    const out = execSync(`grep -rE "${pattern}" "${dir}" --include="*.ts" --include="*.tsx" -l 2>/dev/null || true`, { encoding: "utf8" });
    return out.split("\n").filter(Boolean);
  } catch { return []; }
}

const frontendRefByFn = new Map();
for (const fn of functions) {
  const refs = gitGrep(`functions/v1/${fn}|/v1/${fn}|"${fn}"`, FRONTEND_DIR);
  if (refs.length > 0) frontendRefByFn.set(fn, refs);
}

// 5. Inter-function references: grep functions/ for one function name in another function (excluding self)
const interRefByFn = new Map();
for (const fn of functions) {
  // Search for the function name as a string literal or path inside OTHER functions
  const cmd = `grep -rE "${fn}" "${FUNCTIONS_DIR}" --include="*.ts" -l 2>/dev/null || true`;
  try {
    const out = execSync(cmd, { encoding: "utf8" });
    const refs = out.split("\n").filter(Boolean).filter(f => !f.includes(`/functions/${fn}/`));
    if (refs.length > 0) interRefByFn.set(fn, refs);
  } catch {}
}

// 6. Classify each function
const classifications = [];
for (const fn of functions) {
  const cronRefs = cronRefByFn.get(fn) || [];
  const frontendRefs = frontendRefByFn.get(fn) || [];
  const interRefs = interRefByFn.get(fn) || [];
  const isLive = cronRefs.length > 0 || frontendRefs.length > 0 || interRefs.length > 0;

  // Naming-based heuristics for DELETE-CANDIDATE flag:
  const isProbe = /^(d\d+-probe|d\d+-inspect|d\d+-)/.test(fn) || fn.endsWith("-probe");
  const isSupersededOptimizer = /^d(364|366|371)-optimize-mlb$/.test(fn);
  const isOldBacktest = /^backtest(-mlb-v[12])?$|^run-optimizer$/.test(fn);
  const isCompletedBackfill = /^backfill-/.test(fn);
  const isOneOffMint = /^d359-mint-props$|^d359-backfill/.test(fn);
  const isHealthChecker = /^health-(check|monitor)$|^dashboard-health/.test(fn);

  let classification, evidence;
  if (isLive) {
    classification = "LIVE";
    const parts = [];
    if (cronRefs.length > 0) parts.push(`cron×${cronRefs.length} (${cronRefs.map(c => "jobid="+c.jobid).join(",")})`);
    if (frontendRefs.length > 0) parts.push(`frontend×${frontendRefs.length}`);
    if (interRefs.length > 0) parts.push(`inter-fn×${interRefs.length}`);
    evidence = parts.join("; ");
  } else if (isProbe || isSupersededOptimizer || (isOldBacktest && !cronRefs.length)) {
    classification = "DELETE-CANDIDATE";
    evidence = "no cron + no frontend + no inter-fn refs; naming-pattern suggests one-off probe/backfill or superseded version";
  } else {
    classification = "UNSURE";
    evidence = "no live refs found — verify manually before deleting";
  }

  classifications.push({
    fn,
    classification,
    cron_refs: cronRefs,
    frontend_ref_count: frontendRefs.length,
    inter_fn_ref_count: interRefs.length,
    inter_fn_refs: interRefs,
    naming_heuristic: { isProbe, isSupersededOptimizer, isOldBacktest, isCompletedBackfill, isOneOffMint, isHealthChecker },
    evidence,
  });
}

// 7. Summarize
const liveCount = classifications.filter(c => c.classification === "LIVE").length;
const deleteCount = classifications.filter(c => c.classification === "DELETE-CANDIDATE").length;
const unsureCount = classifications.filter(c => c.classification === "UNSURE").length;
console.log(`\nLIVE: ${liveCount}  DELETE-CANDIDATE: ${deleteCount}  UNSURE: ${unsureCount}  total: ${classifications.length}`);

// 8. Print compact summary
console.log("\n=== Summary table ===");
console.log("  function                                       | classification    | evidence");
for (const c of classifications.sort((a, b) => a.fn.localeCompare(b.fn))) {
  console.log(`  ${c.fn.padEnd(45).slice(0, 45)}  | ${c.classification.padEnd(17)} | ${c.evidence.slice(0, 80)}`);
}

writeFileSync(resolve(REPORT_DIR, "d396_architecture.json"), JSON.stringify({
  ts: new Date().toISOString(),
  function_count: classifications.length,
  summary: { live: liveCount, delete_candidate: deleteCount, unsure: unsureCount },
  classifications,
  active_crons: crons.length,
}, null, 2));
console.log(`\nWrote d396_architecture.json`);
