#!/usr/bin/env node
// D-388 frozen-slate v2 — uses correct props_cache schema (first_seen / last_seen).
//
// Strategy: find a rec_cache row with old created_at (e.g., from morning batch
// at 04:05 UTC). For that exact (player, prop_type, pick_side):
//   - props_cache: what is first_seen vs last_seen? (does the INPUT update?)
//   - rec_cache: how many rows, what line/odds/confidence?
// Compare line/odds in rec_cache (old created_at) vs props_cache (latest snapshot).
// If they MATCH → upsert is overwriting columns but NOT created_at → confirmed
//   B2-flavor: subscriber sees stale-looking created_at but values are fresh.
// If rec_cache line/odds DIFFER from props_cache latest → B2 confirmed: merge
//   isn't overwriting line/odds either.
// If props_cache first_seen == last_seen (no update) → B1: upstream stale.

import { readFileSync, writeFileSync } from "node:fs";
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

  // (1) Distribution of rec_cache created_at hours for today
  console.log("=== (1) rec_cache created_at hour distribution today (which hours have rows?) ===");
  const recAll = await rest(`recommendations_cache?sport=eq.mlb&game_date=eq.${today}&select=created_at,line,odds,confidence,last_writer&limit=5000`);
  if (recAll.error) { console.error(recAll.error); return; }
  const byHour = new Map();
  for (const r of recAll.data) {
    const h = r.created_at.slice(0, 13);
    byHour.set(h, (byHour.get(h) || 0) + 1);
  }
  for (const [h, n] of [...byHour.entries()].sort()) console.log(`  ${h}: ${n}`);

  // (2) Pick 5 rec_cache rows whose created_at is OLDEST (probably morning batch ~04:05 UTC)
  console.log("\n=== (2) 5 oldest rec_cache rows today (morning batch) ===");
  const oldest = await rest(`recommendations_cache?sport=eq.mlb&game_date=eq.${today}&select=player_name,prop_type,pick_side,line,odds,confidence,created_at,last_writer&order=created_at.asc&limit=5`);
  for (const r of oldest.data) {
    console.log(`  ${r.player_name} ${r.prop_type} ${r.pick_side} line=${r.line} odds=${r.odds} conf=${r.confidence} created_at=${r.created_at.slice(0, 19)} writer=${r.last_writer}`);
  }

  // (3) For each of those 5, dump props_cache rows (all bookmakers) — see first_seen/last_seen + latest line/odds
  console.log("\n=== (3) props_cache snapshots for each old rec_cache prop (input freshness check) ===");
  for (const r of oldest.data) {
    const enc = (v) => encodeURIComponent(v);
    const url = `props_cache?sport=eq.mlb&game_date=eq.${todayCompact}&player_name=eq.${enc(r.player_name)}&prop_type=eq.${enc(r.prop_type)}&pick_side=eq.${enc(r.pick_side)}&select=line,odds,bookmaker,first_seen,last_seen&order=last_seen.desc&limit=20`;
    const pc = await rest(url);
    if (pc.error) { console.log(`  ${r.player_name}: ${pc.error}`); continue; }
    console.log(`\n  PROP: ${r.player_name} / ${r.prop_type} / ${r.pick_side}`);
    console.log(`    rec_cache: line=${r.line} odds=${r.odds} created_at=${r.created_at.slice(0, 19)}`);
    if (pc.data.length === 0) {
      console.log("    props_cache: 0 rows (no upstream input — unusual)");
      continue;
    }
    console.log(`    props_cache: ${pc.data.length} bookmaker rows (showing top 5 by last_seen)`);
    for (const p of pc.data.slice(0, 5)) {
      const firstS = p.first_seen?.slice(0, 19) ?? "-";
      const lastS = p.last_seen?.slice(0, 19) ?? "-";
      const updated = firstS !== lastS;
      const updateLagMin = updated ? Math.floor((new Date(p.last_seen).getTime() - new Date(p.first_seen).getTime()) / 60000) : 0;
      console.log(`      book=${p.bookmaker.padEnd(12).slice(0, 12)} line=${String(p.line).padEnd(6)} odds=${String(p.odds).padEnd(6)} first_seen=${firstS} last_seen=${lastS} ${updated ? `(updated +${updateLagMin}m)` : "(never updated)"}`);
    }
    // Compare: is the rec_cache line/odds present in any current props_cache row?
    const recPair = `${r.line}|${r.odds}`;
    const matchingBook = pc.data.find((p) => `${p.line}|${p.odds}` === recPair);
    if (matchingBook) {
      console.log(`    → rec_cache line/odds (${r.line}/${r.odds}) STILL PRESENT in props_cache (bookmaker=${matchingBook.bookmaker}, last_seen=${matchingBook.last_seen.slice(0, 19)})`);
    } else {
      console.log(`    → rec_cache line/odds (${r.line}/${r.odds}) NOT FOUND in current props_cache. Current values:`);
      const distinct = new Set(pc.data.map((p) => `${p.line}/${p.odds}`));
      for (const d of [...distinct].slice(0, 5)) console.log(`        ${d}`);
    }
  }

  // (4) Sample 5 FRESH rec_cache rows (created in last hour) — sanity check
  console.log("\n=== (4) 5 freshest rec_cache rows today ===");
  const freshest = await rest(`recommendations_cache?sport=eq.mlb&game_date=eq.${today}&select=player_name,prop_type,pick_side,line,odds,confidence,created_at,last_writer&order=created_at.desc&limit=5`);
  for (const r of freshest.data) {
    console.log(`  ${r.player_name} ${r.prop_type} ${r.pick_side} line=${r.line} odds=${r.odds} created_at=${r.created_at.slice(0, 19)} writer=${r.last_writer}`);
  }

  // (5) Count rec_cache rows per hour by created_at hour — re-confirm
  // Also compute: of the 4:05 batch, are any updated to fresh values?
  console.log("\n=== (5) Sample 10 rec_cache rows from 04:05 UTC batch (early morning) — are any updated to current values? ===");
  const morning = await rest(`recommendations_cache?sport=eq.mlb&game_date=eq.${today}&created_at=lt.${today}T05:00:00Z&select=player_name,prop_type,pick_side,line,odds,confidence,created_at&order=created_at.asc&limit=10`);
  if (!morning.error) {
    for (const r of morning.data) {
      const enc = (v) => encodeURIComponent(v);
      // Look up props_cache latest for same prop
      const url = `props_cache?sport=eq.mlb&game_date=eq.${todayCompact}&player_name=eq.${enc(r.player_name)}&prop_type=eq.${enc(r.prop_type)}&pick_side=eq.${enc(r.pick_side)}&select=line,odds,bookmaker,last_seen&order=last_seen.desc&limit=1`;
      const pc = await rest(url);
      const latest = pc.data?.[0];
      if (!latest) {
        console.log(`  ${r.player_name} ${r.prop_type} ${r.pick_side}: REC line=${r.line} odds=${r.odds} created_at=${r.created_at.slice(11, 19)} → NO MATCHING PROPS_CACHE`);
        continue;
      }
      const recVal = `${r.line}/${r.odds}`;
      const pcVal = `${latest.line}/${latest.odds}`;
      const match = recVal === pcVal;
      console.log(`  ${r.player_name} ${r.prop_type} ${r.pick_side}: REC line/odds=${recVal} (created ${r.created_at.slice(11, 19)})  PROPS latest=${pcVal} (book=${latest.bookmaker}, last_seen ${latest.last_seen.slice(11, 19)})  ${match ? "MATCH" : "MISMATCH"}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
