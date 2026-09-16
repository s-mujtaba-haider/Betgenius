#!/usr/bin/env node
// D-388 frozen-slate v3 — focus on PLAYER props (where rec_cache player_name
// matches props_cache player_name) AND game-markets with the proper bare-name
// lookup.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const envLocal = readFileSync(resolve(projectRoot, ".env.local"), "utf8");
const SUPABASE_URL = envLocal.match(/VITE_SUPABASE_URL=["']?([^"'\n]+)/)[1];
const SERVICE_ROLE = envLocal.match(/SUPABASE_SERVICE_ROLE_KEY=["']?([^"'\n]+)/)[1];
const H = { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` };

async function rest(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: H });
  if (!res.ok) return { error: `${res.status} ${(await res.text()).slice(0, 200)}` };
  return { data: await res.json() };
}

async function main() {
  const today = new Date().toISOString().slice(0, 10);
  const todayCompact = today.replace(/-/g, "");

  // (A) PLAYER PROPS: 5 oldest rec_cache rows for player props (created early today)
  console.log("=== (A) 5 oldest PLAYER-PROP rec_cache rows today (player_name = real player) ===");
  const oldestPP = await rest(`recommendations_cache?sport=eq.mlb&game_date=eq.${today}&prop_type=in.%28hits%2Chome_runs%2Ctotal_bases%2Crbis%2Cpitcher_strikeouts%29&select=player_name,prop_type,pick_side,line,odds,confidence,created_at,last_writer&order=created_at.asc&limit=5`);
  if (oldestPP.error) { console.error(oldestPP.error); return; }
  for (const r of oldestPP.data) {
    console.log(`  ${r.player_name} ${r.prop_type} ${r.pick_side} line=${r.line} odds=${r.odds} conf=${r.confidence} created_at=${r.created_at.slice(0, 19)} writer=${r.last_writer}`);
  }

  // (B) For each, look up props_cache with player_name = same as rec_cache (player props use real player name)
  console.log("\n=== (B) Cross-check: rec_cache vs latest props_cache snapshot for each ===");
  for (const r of oldestPP.data) {
    const enc = (v) => encodeURIComponent(v);
    const url = `props_cache?sport=eq.mlb&game_date=eq.${todayCompact}&player_name=eq.${enc(r.player_name)}&prop_type=eq.${enc(r.prop_type)}&pick_side=eq.${enc(r.pick_side)}&select=line,odds,bookmaker,first_seen,last_seen&order=last_seen.desc&limit=20`;
    const pc = await rest(url);
    console.log(`\n  ${r.player_name} ${r.prop_type} ${r.pick_side}`);
    console.log(`    REC: line=${r.line} odds=${r.odds} created_at=${r.created_at.slice(0, 19)}`);
    if (pc.error) { console.log(`    PROPS: ERR ${pc.error}`); continue; }
    if (pc.data.length === 0) { console.log(`    PROPS: 0 rows`); continue; }
    console.log(`    PROPS: ${pc.data.length} bookmaker rows (top 5 by last_seen)`);
    for (const p of pc.data.slice(0, 5)) {
      const updateLag = Math.floor((new Date(p.last_seen).getTime() - new Date(p.first_seen).getTime()) / 60000);
      const updated = p.first_seen !== p.last_seen;
      console.log(`      ${p.bookmaker.padEnd(12).slice(0, 12)}  line=${String(p.line).padEnd(6)}  odds=${String(p.odds).padEnd(6)}  first_seen=${p.first_seen.slice(11, 19)}  last_seen=${p.last_seen.slice(11, 19)}  ${updated ? `(updated +${updateLag}m)` : "(NOT updated)"}`);
    }
    // Match check
    const recVal = `${r.line}|${r.odds}`;
    const exact = pc.data.find((p) => `${p.line}|${p.odds}` === recVal);
    if (exact) {
      console.log(`    → REC values (${recVal}) match props_cache bookmaker=${exact.bookmaker}, last_seen ${exact.last_seen.slice(11, 19)}`);
    } else {
      console.log(`    → REC values (${recVal}) NOT in current props_cache. Bookmaker values:`);
      const tuples = [...new Set(pc.data.map((p) => `${p.line}/${p.odds}`))].slice(0, 5);
      for (const t of tuples) console.log(`        ${t}`);
    }
  }

  // (C) GAME MARKETS: same probe with the BARE matchup name (strip "(side X)")
  console.log("\n=== (C) Game-market rec_cache row vs props_cache (using bare matchup name) ===");
  const oldestGM = await rest(`recommendations_cache?sport=eq.mlb&game_date=eq.${today}&prop_type=in.%28spreads%2Ctotals%2Ch2h%29&select=player_name,prop_type,pick_side,line,odds,confidence,created_at,last_writer&order=created_at.asc&limit=3`);
  for (const r of oldestGM.data) {
    // Strip " (side X)" or " (total X)" suffix
    const bare = r.player_name.replace(/\s+\((?:side|total)\s+\w+\)$/, "");
    const enc = (v) => encodeURIComponent(v);
    const url = `props_cache?sport=eq.mlb&game_date=eq.${todayCompact}&player_name=eq.${enc(bare)}&prop_type=eq.${enc(r.prop_type)}&pick_side=eq.${enc(r.pick_side)}&select=line,odds,bookmaker,first_seen,last_seen&order=last_seen.desc&limit=10`;
    const pc = await rest(url);
    console.log(`\n  ${r.player_name} → bare="${bare}"  ${r.prop_type}/${r.pick_side}`);
    console.log(`    REC: line=${r.line} odds=${r.odds} created_at=${r.created_at.slice(0, 19)}`);
    if (pc.error || pc.data.length === 0) {
      console.log(`    PROPS: ${pc.error || "0 rows"}`);
      continue;
    }
    console.log(`    PROPS: ${pc.data.length} bookmaker rows`);
    for (const p of pc.data.slice(0, 5)) {
      const updateLag = Math.floor((new Date(p.last_seen).getTime() - new Date(p.first_seen).getTime()) / 60000);
      console.log(`      ${p.bookmaker.padEnd(12).slice(0, 12)}  line=${String(p.line).padEnd(6)}  odds=${String(p.odds).padEnd(6)}  first=${p.first_seen.slice(11, 19)}  last=${p.last_seen.slice(11, 19)}  (updated +${updateLag}m)`);
    }
  }

  // (D) props_cache update-rate: distribution of (last_seen - first_seen) for today's MLB props
  console.log("\n=== (D) props_cache update lag distribution (last_seen − first_seen) for today MLB ===");
  const pcAll = await rest(`props_cache?sport=eq.mlb&game_date=eq.${todayCompact}&select=first_seen,last_seen&limit=5000`);
  if (!pcAll.error) {
    const buckets = { never_updated: 0, lt_30min: 0, _30_60min: 0, _1_3h: 0, _3_6h: 0, _6_12h: 0, gt_12h: 0 };
    for (const r of pcAll.data) {
      if (!r.first_seen || !r.last_seen) continue;
      const lagM = (new Date(r.last_seen).getTime() - new Date(r.first_seen).getTime()) / 60000;
      if (lagM < 1) buckets.never_updated++;
      else if (lagM < 30) buckets.lt_30min++;
      else if (lagM < 60) buckets._30_60min++;
      else if (lagM < 180) buckets._1_3h++;
      else if (lagM < 360) buckets._3_6h++;
      else if (lagM < 720) buckets._6_12h++;
      else buckets.gt_12h++;
    }
    console.log(`  total: ${pcAll.data.length}`);
    for (const [k, n] of Object.entries(buckets)) console.log(`  ${k.padEnd(18)}  ${n}`);
  }

  // (E) The critical comparison: for ALL 04:05 UTC rec_cache rows (player props), how many have line/odds matching CURRENT props_cache?
  console.log("\n=== (E) 04:05 morning batch PLAYER props: do current values match props_cache? (B2 final test) ===");
  const m = await rest(`recommendations_cache?sport=eq.mlb&game_date=eq.${today}&prop_type=in.%28hits%2Chome_runs%2Ctotal_bases%2Crbis%2Cpitcher_strikeouts%29&created_at=lt.${today}T05:00:00Z&select=player_name,prop_type,pick_side,line,odds,created_at&order=created_at.asc&limit=30`);
  if (!m.error) {
    let matchCount = 0, mismatchCount = 0, noPropsCount = 0;
    for (const r of m.data) {
      const enc = (v) => encodeURIComponent(v);
      const url = `props_cache?sport=eq.mlb&game_date=eq.${todayCompact}&player_name=eq.${enc(r.player_name)}&prop_type=eq.${enc(r.prop_type)}&pick_side=eq.${enc(r.pick_side)}&select=line,odds,bookmaker,last_seen&order=last_seen.desc&limit=20`;
      const pc = await rest(url);
      if (pc.error || pc.data.length === 0) {
        noPropsCount++;
        continue;
      }
      const recVal = `${r.line}|${r.odds}`;
      const exact = pc.data.find((p) => `${p.line}|${p.odds}` === recVal);
      if (exact) matchCount++;
      else mismatchCount++;
    }
    console.log(`  sampled: ${m.data.length}  matched: ${matchCount}  mismatched: ${mismatchCount}  no_props_match: ${noPropsCount}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
