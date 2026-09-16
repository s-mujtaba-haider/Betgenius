#!/usr/bin/env node
// D-389a SHIP 2 controlled verify (the D-277 gate).
//
// Process:
//   1. Snapshot pre-state (unresolved count, push count, queue head IDs).
//   2. Invoke resolve-picks with a controlled small batch (limit=50, sport=mlb).
//   3. Snapshot post-state. Identify which picks moved from unresolved to resolved.
//   4. Ground-truth a sample of resolved picks against MLB Stats API.
//   5. Confirm no NEW voids and no mis-resolutions.
//   6. Invoke resolve-picks AGAIN with same params.
//   7. Confirm zero pushes re-queued (no row went from resolved_at-set back to
//      hit=null without resolved_at, and no resolved_at row got re-touched
//      and re-resolved — verify by comparing run2's response vs run1's).
//
// SAFETY: limit=50 keeps the impact tiny. If anything is wrong we'll see it
// before draining 9,639. This is the D-277 lesson — verify BEFORE drain.

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

const H = { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}`, "Content-Type": "application/json" };

async function rest(path, useCount = false) {
  const h = { ...H };
  if (useCount) { h.Prefer = "count=exact"; h.Range = "0-0"; }
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: h });
  if (!res.ok) return { error: `${res.status} ${(await res.text()).slice(0, 200)}` };
  return { data: await res.json(), count: res.headers.get("content-range") };
}
function n(c) { return c ? parseInt(c.split("/").pop(), 10) : null; }

async function snapshot(label) {
  const cutoff = new Date(Date.now() - 14 * 86400 * 1000).toISOString().slice(0, 10);
  const out = { label, ts: new Date().toISOString() };
  // total live MLB unresolved by NEW gate (hit=null + voided!=true + resolved_at=null)
  out.unresolved_new_gate = n((await rest(`pick_history?sport=eq.mlb&is_synthetic=eq.false&hit=is.null&voided=neq.true&resolved_at=is.null&game_date=gte.${cutoff}&select=id`, true)).count);
  // total live MLB unresolved by OLD gate (hit=null + voided!=true) — should be NEW + pushes
  out.unresolved_old_gate = n((await rest(`pick_history?sport=eq.mlb&is_synthetic=eq.false&hit=is.null&voided=neq.true&game_date=gte.${cutoff}&select=id`, true)).count);
  // push rows: hit=null + resolved_at NOT NULL + voided!=true
  out.push_rows = n((await rest(`pick_history?sport=eq.mlb&is_synthetic=eq.false&hit=is.null&voided=neq.true&resolved_at=not.is.null&game_date=gte.${cutoff}&select=id`, true)).count);
  // voided count for sanity
  out.voided = n((await rest(`pick_history?sport=eq.mlb&is_synthetic=eq.false&voided=eq.true&game_date=gte.${cutoff}&select=id`, true)).count);
  // resolved count
  out.resolved_with_hit = n((await rest(`pick_history?sport=eq.mlb&is_synthetic=eq.false&hit=not.is.null&game_date=gte.${cutoff}&select=id`, true)).count);
  return out;
}

async function invokeResolvePicks(body) {
  const url = `${SUPABASE_URL}/functions/v1/resolve-picks`;
  const res = await fetch(url, {
    method: "POST",
    headers: { ...H, Authorization: `Bearer ${SERVICE_ROLE}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return { ok: res.ok, status: res.status, json: JSON.parse(text) };
  } catch {
    return { ok: res.ok, status: res.status, body: text.slice(0, 500) };
  }
}

async function groundTruthSample(picks) {
  const out = [];
  for (const p of picks) {
    const date = p.game_date;
    const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${date}&hydrate=linescore`;
    try {
      const r = await fetch(url);
      if (!r.ok) { out.push({ pick: p, error: `schedule ${r.status}` }); continue; }
      const j = await r.json();
      const games = [];
      for (const d of (j.dates ?? [])) {
        for (const g of (d.games ?? [])) {
          games.push({
            gamePk: g.gamePk,
            status: g.status?.detailedState ?? "",
            homeTeam: g.teams?.home?.team?.name ?? "",
            awayTeam: g.teams?.away?.team?.name ?? "",
            homeScore: g.teams?.home?.score ?? 0,
            awayScore: g.teams?.away?.score ?? 0,
          });
        }
      }
      const finalGames = games.filter((g) => g.status === "Final" || g.status === "Game Over" || g.status === "Completed Early");
      const isGameMarket = p.prop_type === "spreads" || p.prop_type === "totals" || p.prop_type === "h2h" ||
                           p.mlb_market_type === "game_side" || p.mlb_market_type === "game_total";
      if (isGameMarket) {
        const team = (p.team || "").toLowerCase();
        const opp = (p.opponent || "").toLowerCase();
        const game = finalGames.find((g) => {
          const h = g.homeTeam.toLowerCase(), a = g.awayTeam.toLowerCase();
          return (h === team || a === team) && (h === opp || a === opp);
        });
        if (!game) { out.push({ pick: p, ground_truth: { error: "game not matched on MLB Stats API" } }); continue; }
        const pickedTeamIsHome = team === game.homeTeam.toLowerCase();
        const margin = pickedTeamIsHome ? (game.homeScore - game.awayScore) : (game.awayScore - game.homeScore);
        let expectedHit, expectedActualValue;
        if (p.prop_type === "totals" || p.mlb_market_type === "game_total") {
          const total = game.homeScore + game.awayScore;
          expectedActualValue = total;
          if (Math.abs(total - p.line) < 0.0001) expectedHit = null;
          else if (p.pick_side === "over") expectedHit = total > p.line;
          else expectedHit = total < p.line;
        } else if (p.prop_type === "h2h" || (p.mlb_market_type === "game_side" && p.line === 0)) {
          expectedActualValue = margin;
          if (margin === 0) expectedHit = null;
          else expectedHit = margin > 0;
        } else {
          expectedActualValue = margin;
          const adj = margin + p.line;
          if (Math.abs(adj) < 0.0001) expectedHit = null;
          else expectedHit = adj > 0;
        }
        out.push({
          pick: p,
          ground_truth: { final_score: `${game.homeScore}-${game.awayScore}`, expected_hit: expectedHit, expected_actual_value: expectedActualValue },
          stored: { hit: p.hit, actual_value: p.actual_value, resolved_at: p.resolved_at },
          match: expectedHit === p.hit && Math.abs((expectedActualValue ?? 0) - (p.actual_value ?? 0)) < 0.0001,
        });
      } else {
        // player markets: skip detailed ground-truth (would need boxscore for each, expensive)
        out.push({
          pick: p,
          ground_truth: { skipped: "player-market — requires per-game boxscore" },
          stored: { hit: p.hit, actual_value: p.actual_value, resolved_at: p.resolved_at },
        });
      }
    } catch (e) {
      out.push({ pick: p, error: e.message });
    }
  }
  return out;
}

async function main() {
  console.log("=== Pre-state snapshot ===");
  const pre = await snapshot("pre");
  console.log(JSON.stringify(pre, null, 2));

  console.log("\n=== Run 1: resolve-picks limit=50 sport=mlb ===");
  const start1 = Date.now();
  const run1 = await invokeResolvePicks({ limit: 50, sport: "mlb" });
  console.log(`  HTTP ${run1.status}  duration_ms=${Date.now() - start1}`);
  console.log(`  body: ${JSON.stringify(run1.json ?? run1.body)}`);

  // Wait briefly for writes to land
  await new Promise(r => setTimeout(r, 2000));

  console.log("\n=== Post-run-1 snapshot ===");
  const post1 = await snapshot("post-run-1");
  console.log(JSON.stringify(post1, null, 2));

  console.log("\n=== Delta after run 1 ===");
  console.log(`  unresolved_new_gate: ${pre.unresolved_new_gate} → ${post1.unresolved_new_gate}  (Δ ${post1.unresolved_new_gate - pre.unresolved_new_gate})`);
  console.log(`  unresolved_old_gate: ${pre.unresolved_old_gate} → ${post1.unresolved_old_gate}  (Δ ${post1.unresolved_old_gate - pre.unresolved_old_gate})`);
  console.log(`  push_rows:           ${pre.push_rows} → ${post1.push_rows}  (Δ ${post1.push_rows - pre.push_rows})`);
  console.log(`  voided:              ${pre.voided} → ${post1.voided}  (Δ ${post1.voided - pre.voided})`);
  console.log(`  resolved_with_hit:   ${pre.resolved_with_hit} → ${post1.resolved_with_hit}  (Δ ${post1.resolved_with_hit - pre.resolved_with_hit})`);

  // Identify picks resolved in this run — those whose resolved_at is fresh (within last 60s)
  const justResolved = await rest(`pick_history?sport=eq.mlb&is_synthetic=eq.false&resolved_at=gte.${new Date(start1).toISOString()}&select=id,player_name,team,opponent,prop_type,mlb_market_type,pick_side,line,game_date,hit,actual_value,resolved_at,voided&order=resolved_at.desc&limit=100`);

  console.log(`\n=== Picks touched this run (resolved_at >= run start): ${justResolved.data?.length ?? 0} ===`);
  if (justResolved.data) {
    for (const p of justResolved.data.slice(0, 15)) {
      console.log(`  ${p.player_name?.slice(0, 50).padEnd(50)} ${p.prop_type}/${p.pick_side ?? ""}/${p.line ?? ""}  hit=${p.hit}  actual=${p.actual_value}  voided=${p.voided}`);
    }
  }

  console.log("\n=== Ground-truth check on 10 sampled resolved picks ===");
  // Sample 10 game-market resolved picks (player markets need boxscore — slower)
  const gmSample = (justResolved.data || []).filter(p => p.prop_type === "spreads" || p.prop_type === "totals" || p.prop_type === "h2h").slice(0, 10);
  if (gmSample.length === 0) console.log("  (no game-market picks resolved this run — sample is player-market only)");
  const gt = await groundTruthSample(gmSample);
  let matchCount = 0, mismatchCount = 0;
  for (const r of gt) {
    if (r.match === true) matchCount++;
    else if (r.match === false) mismatchCount++;
    const matchStr = r.match === true ? "MATCH" : r.match === false ? "MISMATCH" : "n/a";
    console.log(`  ${r.pick.player_name?.slice(0, 50).padEnd(50)} ${r.pick.prop_type}/${r.pick.pick_side}/${r.pick.line}  ${matchStr}`);
    if (r.ground_truth?.final_score) console.log(`    final=${r.ground_truth.final_score} expected_hit=${r.ground_truth.expected_hit} stored_hit=${r.stored.hit}`);
    if (r.ground_truth?.error) console.log(`    ground_truth_error: ${r.ground_truth.error}`);
  }
  console.log(`\n  ground-truth matches: ${matchCount}  mismatches: ${mismatchCount}  skipped: ${gt.length - matchCount - mismatchCount}`);

  console.log("\n=== Run 2 (immediately after run 1) — confirm pushes don't re-queue ===");
  const start2 = Date.now();
  const run2 = await invokeResolvePicks({ limit: 50, sport: "mlb" });
  console.log(`  HTTP ${run2.status}  duration_ms=${Date.now() - start2}`);
  console.log(`  body: ${JSON.stringify(run2.json ?? run2.body)}`);

  // Wait for writes
  await new Promise(r => setTimeout(r, 2000));

  console.log("\n=== Post-run-2 snapshot ===");
  const post2 = await snapshot("post-run-2");
  console.log(JSON.stringify(post2, null, 2));

  console.log("\n=== Run 2 delta — should equal NEW picks resolved (not re-touched pushes) ===");
  console.log(`  unresolved_new_gate: ${post1.unresolved_new_gate} → ${post2.unresolved_new_gate}  (Δ ${post2.unresolved_new_gate - post1.unresolved_new_gate})`);
  console.log(`  push_rows: ${post1.push_rows} → ${post2.push_rows}  (Δ ${post2.push_rows - post1.push_rows})  ← should be 0 or close to 0`);
  console.log(`  voided:    ${post1.voided} → ${post2.voided}  (Δ ${post2.voided - post1.voided})  ← any NEW voids = D-277-class flag`);

  const report = { pre, post1, post2, run1: run1.json, run2: run2.json, ground_truth_sample: gt, ground_truth_match_count: matchCount, ground_truth_mismatch_count: mismatchCount };
  writeFileSync(resolve(REPORT_DIR, "d389a_ship2_controlled.json"), JSON.stringify(report, null, 2));
  console.log(`\nWrote d389a_ship2_controlled.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
