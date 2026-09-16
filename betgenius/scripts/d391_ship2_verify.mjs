#!/usr/bin/env node
// D-391 SHIP 2 — live verify: trigger one process-games-mlb tick, then
// confirm:
//   (a) all MLB spreads picks have |line| === 1.5 (no whole-number)
//   (b) every scheduled game still has a spreads side pick
//   (c) totals/player props/h2h are unchanged in count/character
//
// CRITICAL: snapshot pre + post; the filter only takes effect on NEW
// scoring writes. Existing rec_cache rows with whole-number lines
// REMAIN until the next process-games-mlb tick overwrites them
// (because line is not in conflict key, the new ±1.5 write replaces
// the old ±1 row for the same (matchup, pick_side)).

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const REPORT_DIR = resolve(projectRoot, "docs", "loop", "reports");
mkdirSync(REPORT_DIR, { recursive: true });

const envLocal = readFileSync(resolve(projectRoot, ".env.local"), "utf8");
const SUPABASE_URL = envLocal.match(/VITE_SUPABASE_URL=["]?([^"\n]+)/)[1];
const SERVICE_ROLE = envLocal.match(/SUPABASE_SERVICE_ROLE_KEY=["]?([^"\n]+)/)[1];
const H = { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}`, "Content-Type": "application/json" };

async function rest(path, useCount = false) {
  const h = { ...H };
  if (useCount) { h.Prefer = "count=exact"; h.Range = "0-0"; }
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: h });
  if (!res.ok) return { error: `${res.status} ${(await res.text()).slice(0, 200)}` };
  return { data: await res.json(), count: res.headers.get("content-range") };
}
function n(c) { return c ? parseInt(c.split("/").pop(), 10) : null; }

// ET-shifted slate date
const slateDate = new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);

async function snapshot(label) {
  const out = { label, ts: new Date().toISOString(), slate_date: slateDate };
  // Spread picks today
  const sp = await rest(`recommendations_cache?sport=eq.mlb&game_date=eq.${slateDate}&prop_type=eq.spreads&select=player_name,pick_side,line,odds,confidence,bookmaker,created_at`);
  if (!sp.error) {
    out.spreads = sp.data;
    out.spreads_count = sp.data.length;
    out.whole_number_count = sp.data.filter(r => Number.isInteger(r.line)).length;
    out.half_point_count = sp.data.filter(r => !Number.isInteger(r.line)).length;
    out.line_distribution = {};
    for (const r of sp.data) {
      const k = Math.abs(r.line);
      out.line_distribution[k] = (out.line_distribution[k] || 0) + 1;
    }
  }
  // h2h count
  const h2h = await rest(`recommendations_cache?sport=eq.mlb&game_date=eq.${slateDate}&prop_type=eq.h2h&select=id`, true);
  out.h2h_count = n(h2h.count);
  // totals count
  const tot = await rest(`recommendations_cache?sport=eq.mlb&game_date=eq.${slateDate}&prop_type=eq.totals&select=id`, true);
  out.totals_count = n(tot.count);
  // player props counts
  const player = await rest(`recommendations_cache?sport=eq.mlb&game_date=eq.${slateDate}&prop_type=in.%28hits%2Chome_runs%2Ctotal_bases%2Crbis%2Cpitcher_strikeouts%29&select=id`, true);
  out.player_props_count = n(player.count);

  // Distinct matchups with a spread pick
  if (!sp.error) {
    const matchups = new Set();
    for (const r of sp.data) {
      const bare = r.player_name.replace(/\s+\((?:side|total)\s+\w+\)$/, "");
      matchups.add(bare);
    }
    out.distinct_matchups_with_spread = matchups.size;
    out.matchups_with_spread = [...matchups];
  }

  return out;
}

async function invokeProcessGamesMlb() {
  const url = `${SUPABASE_URL}/functions/v1/process-games-mlb`;
  const res = await fetch(url, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ game_date: slateDate }),
  });
  const text = await res.text();
  try { return { ok: res.ok, status: res.status, json: JSON.parse(text) }; }
  catch { return { ok: res.ok, status: res.status, body: text.slice(0, 500) }; }
}

async function main() {
  console.log("=== PRE-TRIGGER snapshot ===");
  const pre = await snapshot("pre");
  console.log(`  Slate: ${pre.slate_date}`);
  console.log(`  Spreads picks: ${pre.spreads_count}  (whole-number: ${pre.whole_number_count}, half-point: ${pre.half_point_count})`);
  console.log(`  Line distribution: ${JSON.stringify(pre.line_distribution)}`);
  console.log(`  Distinct matchups with a spread pick: ${pre.distinct_matchups_with_spread}`);
  console.log(`  H2H: ${pre.h2h_count}  Totals: ${pre.totals_count}  Player-props: ${pre.player_props_count}`);

  console.log("\n=== Triggering process-games-mlb for today's slate ===");
  const start = Date.now();
  const run = await invokeProcessGamesMlb();
  console.log(`  HTTP ${run.status}  duration=${Date.now() - start}ms`);
  console.log(`  body: ${JSON.stringify(run.json ?? run.body).slice(0, 800)}`);

  // Wait for writes to land
  await new Promise(r => setTimeout(r, 3000));

  console.log("\n=== POST-TRIGGER snapshot ===");
  const post = await snapshot("post");
  console.log(`  Spreads picks: ${post.spreads_count}  (whole-number: ${post.whole_number_count}, half-point: ${post.half_point_count})`);
  console.log(`  Line distribution: ${JSON.stringify(post.line_distribution)}`);
  console.log(`  Distinct matchups with a spread pick: ${post.distinct_matchups_with_spread}`);
  console.log(`  H2H: ${post.h2h_count}  Totals: ${post.totals_count}  Player-props: ${post.player_props_count}`);

  console.log("\n=== DELTAS ===");
  console.log(`  whole-number: ${pre.whole_number_count} → ${post.whole_number_count}  (Δ ${post.whole_number_count - pre.whole_number_count})`);
  console.log(`  half-point:   ${pre.half_point_count} → ${post.half_point_count}  (Δ ${post.half_point_count - pre.half_point_count})`);
  console.log(`  total spreads: ${pre.spreads_count} → ${post.spreads_count}  (Δ ${post.spreads_count - pre.spreads_count})`);
  console.log(`  matchups with side: ${pre.distinct_matchups_with_spread} → ${post.distinct_matchups_with_spread}  (Δ ${post.distinct_matchups_with_spread - pre.distinct_matchups_with_spread})`);
  console.log(`  h2h: ${pre.h2h_count} → ${post.h2h_count}  (Δ ${post.h2h_count - pre.h2h_count})`);
  console.log(`  totals: ${pre.totals_count} → ${post.totals_count}  (Δ ${post.totals_count - pre.totals_count})`);
  console.log(`  player-props: ${pre.player_props_count} → ${post.player_props_count}  (Δ ${post.player_props_count - pre.player_props_count})`);

  // Sample 5 post spread rows
  console.log("\n=== Sample 5 post-trigger spread rows ===");
  for (const r of (post.spreads || []).slice(0, 5)) {
    console.log(`  ${r.player_name.padEnd(60).slice(0, 60)}  pick=${r.pick_side} line=${r.line} odds=${r.odds} conf=${r.confidence} book=${r.bookmaker}`);
  }

  // List matchups with side-pick in pre but NOT in post (would indicate a game lost its side pick)
  const preMatchups = new Set(pre.matchups_with_spread || []);
  const postMatchups = new Set(post.matchups_with_spread || []);
  const lostSidePick = [...preMatchups].filter((m) => !postMatchups.has(m));
  const gainedSidePick = [...postMatchups].filter((m) => !preMatchups.has(m));
  if (lostSidePick.length > 0) console.log(`\n  ⚠ Matchups that LOST their spread pick after filter: ${lostSidePick.join(", ")}`);
  if (gainedSidePick.length > 0) console.log(`\n  Matchups that GAINED a spread pick after filter: ${gainedSidePick.join(", ")}`);

  writeFileSync(resolve(REPORT_DIR, "d391_verify.json"), JSON.stringify({ pre, post, lost_side_pick: lostSidePick, gained_side_pick: gainedSidePick, run_status: run.status, run_body: run.json ?? run.body }, null, 2));
  console.log(`\nWrote d391_verify.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
