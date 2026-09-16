#!/usr/bin/env node
// D-390 SHIP 2 — quantify push exposure of whole-number runlines historically.
//
// Hypothesis: whole-number runlines (|line|=1) push MUCH more often than
// half-point runlines (|line|=1.5) because the most common MLB game margin
// is 1 run. Confirm with resolved pick_history data.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const envLocal = readFileSync(resolve(projectRoot, ".env.local"), "utf8");
const SUPABASE_URL = envLocal.match(/VITE_SUPABASE_URL=["]?([^"\n]+)/)[1];
const SERVICE_ROLE = envLocal.match(/SUPABASE_SERVICE_ROLE_KEY=["]?([^"\n]+)/)[1];
const H = { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` };

async function rest(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: H });
  if (!res.ok) return { error: `${res.status} ${(await res.text()).slice(0, 200)}` };
  return { data: await res.json() };
}

async function main() {
  // Last 30 days of resolved MLB live spread picks: hit IS NOT NULL OR (hit IS NULL + resolved_at IS NOT NULL = push)
  const cutoff = new Date(Date.now() - 30 * 86400 * 1000).toISOString().slice(0, 10);

  // Pull all spread picks with resolved_at set in the window
  console.log("=== Pulling resolved MLB spread picks (last 30d) ===");
  const data = await rest(`pick_history?sport=eq.mlb&is_synthetic=eq.false&prop_type=eq.spreads&resolved_at=not.is.null&game_date=gte.${cutoff}&voided=eq.false&select=id,line,pick_side,hit,actual_value,game_date&order=game_date.desc&limit=10000`);
  if (data.error) { console.error(data.error); return; }
  console.log(`  ${data.data.length} resolved spread picks fetched`);

  // Bucket by |line|
  const buckets = new Map(); // |line| → { total, hit, miss, push }
  for (const r of data.data) {
    const abs = Math.abs(r.line);
    if (!buckets.has(abs)) buckets.set(abs, { total: 0, hit: 0, miss: 0, push: 0 });
    const b = buckets.get(abs);
    b.total++;
    if (r.hit === true) b.hit++;
    else if (r.hit === false) b.miss++;
    else b.push++;  // hit=null + resolved_at set = push
  }

  console.log("\n=== Hit/Miss/Push by |line| (resolved MLB spread picks, last 30d) ===");
  console.log("  |line|  total    hit%   miss%  push%  (raw counts)");
  console.log("  ------  -----    ----   -----  -----");
  for (const [abs, b] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
    if (b.total === 0) continue;
    const hpct = (b.hit / b.total * 100).toFixed(1);
    const mpct = (b.miss / b.total * 100).toFixed(1);
    const ppct = (b.push / b.total * 100).toFixed(1);
    console.log(`  ${String(abs).padStart(4)}    ${String(b.total).padStart(5)}    ${hpct.padStart(4)}%   ${mpct.padStart(4)}%  ${ppct.padStart(4)}%  (h=${b.hit} m=${b.miss} p=${b.push})`);
  }

  // Aggregate: whole-number vs half-point
  let wholeTotal = 0, wholeHit = 0, wholeMiss = 0, wholePush = 0;
  let halfTotal = 0, halfHit = 0, halfMiss = 0, halfPush = 0;
  for (const [abs, b] of buckets) {
    if (Number.isInteger(abs)) {
      wholeTotal += b.total; wholeHit += b.hit; wholeMiss += b.miss; wholePush += b.push;
    } else {
      halfTotal += b.total; halfHit += b.hit; halfMiss += b.miss; halfPush += b.push;
    }
  }
  console.log("\n=== Aggregate: whole-number vs half-point runlines ===");
  if (wholeTotal > 0) console.log(`  whole-number (|line| 1/2/3/...): n=${wholeTotal}  hit=${(wholeHit/wholeTotal*100).toFixed(1)}%  miss=${(wholeMiss/wholeTotal*100).toFixed(1)}%  PUSH=${(wholePush/wholeTotal*100).toFixed(1)}%`);
  if (halfTotal > 0) console.log(`  half-point   (|line| 1.5/2.5/...): n=${halfTotal}  hit=${(halfHit/halfTotal*100).toFixed(1)}%  miss=${(halfMiss/halfTotal*100).toFixed(1)}%  PUSH=${(halfPush/halfTotal*100).toFixed(1)}%`);

  // Quantify: if all whole-number spread picks had been ±1.5 standard instead, how many fewer pushes?
  if (wholeTotal > 0 && halfTotal > 0) {
    const halfPushRate = halfPush / halfTotal;
    const expectedHalfPushes = Math.round(wholeTotal * halfPushRate);
    const actualWholePushes = wholePush;
    const excessPushes = actualWholePushes - expectedHalfPushes;
    console.log(`\n  If today's ${wholeTotal} whole-number picks had been half-point instead:`);
    console.log(`    expected pushes at half-point rate (${(halfPushRate*100).toFixed(1)}%):  ${expectedHalfPushes}`);
    console.log(`    actual whole-number pushes:                                  ${actualWholePushes}`);
    console.log(`    EXCESS pushes from whole-number choice:                      ${excessPushes}`);
  }

  // Bookmaker breakdown on the whole-number picks: which book sourced them?
  console.log("\n=== Bookmaker breakdown on resolved whole-number spread picks (last 30d) ===");
  const wholeNum = await rest(`pick_history?sport=eq.mlb&is_synthetic=eq.false&prop_type=eq.spreads&resolved_at=not.is.null&game_date=gte.${cutoff}&voided=eq.false&line=in.%28-1%2C1%2C-2%2C2%2C-3%2C3%29&select=line,pick_side&limit=5000`);
  // pick_history doesn't have bookmaker — need to cross-ref with rec_cache. Skip for now; instead show line value distribution.
  if (!wholeNum.error) {
    const lineCounts = new Map();
    for (const r of wholeNum.data) {
      lineCounts.set(r.line, (lineCounts.get(r.line) || 0) + 1);
    }
    for (const [l, n] of [...lineCounts.entries()].sort((a, b) => a[0] - b[0])) {
      console.log(`  line=${l}: ${n} picks`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
