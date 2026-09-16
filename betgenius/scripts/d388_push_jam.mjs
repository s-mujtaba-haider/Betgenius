#!/usr/bin/env node
// D-388 SHIP 1 — confirm the PUSH-queue-jam hypothesis.
//
// Hypothesis: updatePickResult writes hit=null for push outcomes; the
// resolver's query treats hit IS NULL as "unresolved"; so every push
// gets re-resolved every cron run, occupying the head of the 200-limit
// ordered-by-created_at.asc queue indefinitely. New picks never get
// reached → 58% gap.

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const envLocal = readFileSync(resolve(projectRoot, ".env.local"), "utf8");
const SUPABASE_URL = envLocal.match(/VITE_SUPABASE_URL=["']?([^"'\n]+)/)[1];
const SERVICE_ROLE = envLocal.match(/SUPABASE_SERVICE_ROLE_KEY=["']?([^"'\n]+)/)[1];
const H = { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` };

async function rest(path, useCount = false) {
  const h = { ...H };
  if (useCount) { h.Prefer = "count=exact"; h.Range = "0-0"; }
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: h });
  if (!res.ok) return { error: `${res.status} ${(await res.text()).slice(0, 200)}` };
  return { data: await res.json(), count: res.headers.get("content-range") };
}
function n(c) { return c ? parseInt(c.split("/").pop(), 10) : null; }

async function main() {
  const cutoff14 = new Date(Date.now() - 14 * 86400 * 1000).toISOString().slice(0, 10);

  // (1) Of the unresolved MLB picks in cron window, how many have resolved_at set vs null?
  console.log("=== Unresolved MLB live picks in cron 14d window: resolved_at split ===");
  const withResAt   = await rest(`pick_history?sport=eq.mlb&is_synthetic=eq.false&hit=is.null&voided=eq.false&game_date=gte.${cutoff14}&resolved_at=not.is.null&select=id`, true);
  const noResAt     = await rest(`pick_history?sport=eq.mlb&is_synthetic=eq.false&hit=is.null&voided=eq.false&game_date=gte.${cutoff14}&resolved_at=is.null&select=id`, true);
  const withResVal  = await rest(`pick_history?sport=eq.mlb&is_synthetic=eq.false&hit=is.null&voided=eq.false&game_date=gte.${cutoff14}&actual_value=not.is.null&select=id`, true);
  console.log(`  hit IS NULL + voided=false + resolved_at IS NOT NULL: ${n(withResAt.count)}`);
  console.log(`  hit IS NULL + voided=false + resolved_at IS NULL:     ${n(noResAt.count)}`);
  console.log(`  hit IS NULL + voided=false + actual_value IS NOT NULL: ${n(withResVal.count)}  ← PUSHED rows (cron processed them; recorded the actual_value but left hit=null)`);

  // (2) Same split for ONLY game-market picks (where push is mathematically common)
  console.log("\n=== Game-market unresolved subset (spreads/totals/h2h): resolved_at + actual_value split ===");
  const gmPropFilter = "&prop_type=in.%28spreads%2Ctotals%2Ch2h%29";
  const gmWithRes = await rest(`pick_history?sport=eq.mlb&is_synthetic=eq.false&hit=is.null&voided=eq.false&game_date=gte.${cutoff14}${gmPropFilter}&resolved_at=not.is.null&select=id`, true);
  const gmNoRes   = await rest(`pick_history?sport=eq.mlb&is_synthetic=eq.false&hit=is.null&voided=eq.false&game_date=gte.${cutoff14}${gmPropFilter}&resolved_at=is.null&select=id`, true);
  const gmActVal  = await rest(`pick_history?sport=eq.mlb&is_synthetic=eq.false&hit=is.null&voided=eq.false&game_date=gte.${cutoff14}${gmPropFilter}&actual_value=not.is.null&select=id`, true);
  console.log(`  game-market hit=null + resolved_at NOT NULL: ${n(gmWithRes.count)}`);
  console.log(`  game-market hit=null + resolved_at IS NULL:  ${n(gmNoRes.count)}`);
  console.log(`  game-market hit=null + actual_value NOT NULL (push outcomes): ${n(gmActVal.count)}`);

  // (3) Same for player-market picks (where push should be rare due to half-integer lines)
  console.log("\n=== Player-market unresolved subset (hits/home_runs/total_bases/rbis/pitcher_strikeouts): resolved_at split ===");
  const pmPropFilter = "&prop_type=in.%28hits%2Chome_runs%2Ctotal_bases%2Crbis%2Cpitcher_strikeouts%29";
  const pmWithRes = await rest(`pick_history?sport=eq.mlb&is_synthetic=eq.false&hit=is.null&voided=eq.false&game_date=gte.${cutoff14}${pmPropFilter}&resolved_at=not.is.null&select=id`, true);
  const pmNoRes   = await rest(`pick_history?sport=eq.mlb&is_synthetic=eq.false&hit=is.null&voided=eq.false&game_date=gte.${cutoff14}${pmPropFilter}&resolved_at=is.null&select=id`, true);
  const pmActVal  = await rest(`pick_history?sport=eq.mlb&is_synthetic=eq.false&hit=is.null&voided=eq.false&game_date=gte.${cutoff14}${pmPropFilter}&actual_value=not.is.null&select=id`, true);
  console.log(`  player-market hit=null + resolved_at NOT NULL: ${n(pmWithRes.count)}`);
  console.log(`  player-market hit=null + resolved_at IS NULL:  ${n(pmNoRes.count)}`);
  console.log(`  player-market hit=null + actual_value NOT NULL: ${n(pmActVal.count)}`);

  // (4) Sample a few "resolved_at set + hit=null + actual_value set" rows — these are pushes occupying the queue
  console.log("\n=== Sample 5 PUSH rows (hit=null + resolved_at set + actual_value set, game-market) ===");
  const pushSample = await rest(`pick_history?sport=eq.mlb&is_synthetic=eq.false&hit=is.null&voided=eq.false&actual_value=not.is.null&game_date=gte.${cutoff14}${gmPropFilter}&select=id,player_name,prop_type,pick_side,line,actual_value,game_date,resolved_at&order=created_at.asc&limit=5`);
  if (!pushSample.error) {
    for (const r of pushSample.data) {
      const diff = Math.abs(r.actual_value - r.line);
      console.log(`  ${r.player_name} ${r.prop_type} ${r.pick_side} line=${r.line} actual=${r.actual_value} |diff|=${diff}  gd=${r.game_date}  resolved_at=${r.resolved_at?.slice(0, 19)}`);
    }
  }

  // (5) How many of the historically-resolved MLB picks have hit=null (i.e. how big is the push universe normally)?
  console.log("\n=== Historic push detection: hit=null + actual_value NOT NULL on ALL resolved MLB picks (no date filter) ===");
  const historicPush = await rest(`pick_history?sport=eq.mlb&is_synthetic=eq.false&hit=is.null&voided=eq.false&actual_value=not.is.null&select=id`, true);
  console.log(`  total PUSH rows ever (live MLB): ${n(historicPush.count)}`);
  const allResolved = await rest(`pick_history?sport=eq.mlb&is_synthetic=eq.false&actual_value=not.is.null&select=id`, true);
  console.log(`  total rows with actual_value set (resolved or push) ever: ${n(allResolved.count)}`);
  const resolvedHits = await rest(`pick_history?sport=eq.mlb&is_synthetic=eq.false&hit=eq.true&select=id`, true);
  const resolvedMiss = await rest(`pick_history?sport=eq.mlb&is_synthetic=eq.false&hit=eq.false&select=id`, true);
  console.log(`  hit=true:  ${n(resolvedHits.count)}`);
  console.log(`  hit=false: ${n(resolvedMiss.count)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
