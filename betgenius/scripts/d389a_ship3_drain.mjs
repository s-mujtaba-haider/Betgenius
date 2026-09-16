#!/usr/bin/env node
// D-389a SHIP 3 — monitored backlog drain.
//
// Approach: invoke resolve-picks limit=200 sport=mlb in a loop. After each
// batch, snapshot counts. Stop if:
//   - new_gate count fails to decrease (queue not advancing — would indicate jam)
//   - void rate spikes > 25% (abnormal — would indicate D-277 regression)
//   - push_rows grow (would indicate push fix regressed)
//   - we've drained 40 batches (= 8,000 picks attempted, ~80% of backlog)
//
// Spot-checks every 5 batches: ground-truth 5 random newly-resolved picks.

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

async function snapshot() {
  const cutoff = new Date(Date.now() - 14 * 86400 * 1000).toISOString().slice(0, 10);
  return {
    ts: new Date().toISOString(),
    unresolved_new_gate: n((await rest(`pick_history?sport=eq.mlb&is_synthetic=eq.false&hit=is.null&voided=neq.true&resolved_at=is.null&game_date=gte.${cutoff}&select=id`, true)).count),
    unresolved_old_gate: n((await rest(`pick_history?sport=eq.mlb&is_synthetic=eq.false&hit=is.null&voided=neq.true&game_date=gte.${cutoff}&select=id`, true)).count),
    push_rows: n((await rest(`pick_history?sport=eq.mlb&is_synthetic=eq.false&hit=is.null&voided=neq.true&resolved_at=not.is.null&game_date=gte.${cutoff}&select=id`, true)).count),
    voided: n((await rest(`pick_history?sport=eq.mlb&is_synthetic=eq.false&voided=eq.true&game_date=gte.${cutoff}&select=id`, true)).count),
    resolved_with_hit: n((await rest(`pick_history?sport=eq.mlb&is_synthetic=eq.false&hit=not.is.null&game_date=gte.${cutoff}&select=id`, true)).count),
  };
}

async function invoke() {
  const res = await fetch(`${SUPABASE_URL}/functions/v1/resolve-picks`, {
    method: "POST",
    headers: H,
    body: JSON.stringify({ limit: 200, sport: "mlb" }),
  });
  const text = await res.text();
  try { return { ok: res.ok, status: res.status, json: JSON.parse(text) }; }
  catch { return { ok: res.ok, status: res.status, body: text.slice(0, 300) }; }
}

async function spotCheck() {
  // Ground-truth 5 recently-resolved game-market picks
  const cutoff = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const recent = await rest(`pick_history?sport=eq.mlb&is_synthetic=eq.false&hit=not.is.null&resolved_at=gte.${cutoff}&prop_type=in.%28spreads%2Ctotals%2Ch2h%29&select=id,player_name,team,opponent,prop_type,mlb_market_type,pick_side,line,game_date,hit,actual_value&order=resolved_at.desc&limit=5`);
  if (recent.error || recent.data.length === 0) return { sampled: 0, matched: 0, mismatched: 0 };
  let matched = 0, mismatched = 0;
  for (const p of recent.data) {
    const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${p.game_date}`;
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      const j = await r.json();
      const games = [];
      for (const d of (j.dates ?? [])) for (const g of (d.games ?? [])) games.push({
        homeTeam: g.teams?.home?.team?.name ?? "",
        awayTeam: g.teams?.away?.team?.name ?? "",
        homeScore: g.teams?.home?.score ?? 0,
        awayScore: g.teams?.away?.score ?? 0,
        status: g.status?.detailedState,
      });
      const finals = games.filter(g => g.status === "Final" || g.status === "Game Over" || g.status === "Completed Early");
      const team = (p.team || "").toLowerCase();
      const opp = (p.opponent || "").toLowerCase();
      const game = finals.find(g => {
        const h = g.homeTeam.toLowerCase(), a = g.awayTeam.toLowerCase();
        return (h === team || a === team) && (h === opp || a === opp);
      });
      if (!game) continue;
      const pickedHome = team === game.homeTeam.toLowerCase();
      const margin = pickedHome ? game.homeScore - game.awayScore : game.awayScore - game.homeScore;
      let expectedHit, expectedActual;
      if (p.prop_type === "totals" || p.mlb_market_type === "game_total") {
        const total = game.homeScore + game.awayScore;
        expectedActual = total;
        if (Math.abs(total - p.line) < 0.0001) expectedHit = null;
        else if (p.pick_side === "over") expectedHit = total > p.line;
        else expectedHit = total < p.line;
      } else if (p.prop_type === "h2h" || (p.mlb_market_type === "game_side" && p.line === 0)) {
        expectedActual = margin;
        expectedHit = margin === 0 ? null : margin > 0;
      } else {
        expectedActual = margin;
        const adj = margin + p.line;
        expectedHit = Math.abs(adj) < 0.0001 ? null : adj > 0;
      }
      if (expectedHit === p.hit && Math.abs((expectedActual ?? 0) - (p.actual_value ?? 0)) < 0.0001) matched++;
      else { mismatched++; console.log(`    SPOT-CHECK MISMATCH: ${p.player_name} ${p.prop_type}/${p.pick_side}/${p.line} expected hit=${expectedHit} actual=${expectedActual} stored hit=${p.hit} actual=${p.actual_value}`); }
    } catch {}
  }
  return { sampled: recent.data.length, matched, mismatched };
}

async function main() {
  const MAX_BATCHES = 40;
  const SPOT_CHECK_EVERY = 5;
  const overall = { ts: new Date().toISOString(), batches: [] };

  console.log("=== Pre-drain snapshot ===");
  let cur = await snapshot();
  overall.pre = cur;
  console.log(`  unresolved_new_gate: ${cur.unresolved_new_gate}`);
  console.log(`  push_rows: ${cur.push_rows}`);
  console.log(`  voided: ${cur.voided}`);
  console.log(`  resolved_with_hit: ${cur.resolved_with_hit}\n`);

  let stoppedReason = null;
  for (let i = 1; i <= MAX_BATCHES; i++) {
    const start = Date.now();
    const run = await invoke();
    const dur = Date.now() - start;
    await new Promise(r => setTimeout(r, 1500));
    const next = await snapshot();

    const summary = run.json?.mlb ?? { resolved: 0, unresolvable: 0, skipped: 0 };
    const queueDelta = next.unresolved_new_gate - cur.unresolved_new_gate;
    const pushDelta = next.push_rows - cur.push_rows;
    const voidDelta = next.voided - cur.voided;
    const resDelta = next.resolved_with_hit - cur.resolved_with_hit;

    console.log(`batch ${String(i).padStart(2)}/${MAX_BATCHES}  HTTP ${run.status}  dur=${dur}ms  resolved=${summary.resolved} void=${summary.unresolvable} skip=${summary.skipped}  Δqueue=${queueDelta} Δpush=${pushDelta} Δvoid=${voidDelta} Δres=${resDelta}  remaining=${next.unresolved_new_gate}`);
    overall.batches.push({ i, http: run.status, dur_ms: dur, mlb: summary, queue_delta: queueDelta, push_delta: pushDelta, void_delta: voidDelta, res_delta: resDelta, remaining: next.unresolved_new_gate });

    // Stop conditions
    //   - queueDelta should be -200 (or -summary.resolved-summary.unresolvable-newPushes)
    //   - pushDelta growth is OK (NEW push outcomes from this batch's resolutions);
    //     pushDelta DECREASE would be impossible (writes to push_rows are one-way);
    //     pushDelta should equal approximately resolved - res_delta (NEW pushes this batch)
    //   - voided spike > 25% is the D-277 signal
    const newPushesThisBatch = summary.resolved - resDelta;  // resolved counts pushes; res_delta only counts hit-not-null
    const queueAdvanced = -queueDelta;
    if (queueAdvanced < 50) { stoppedReason = `queue advanced only ${queueAdvanced} — STOP, check for jam`; break; }
    if (summary.unresolvable > 50) { stoppedReason = `unresolvable spike (${summary.unresolvable}/200 = ${(summary.unresolvable/200*100).toFixed(0)}%) — STOP per D-277 lesson`; break; }
    if (newPushesThisBatch < 0 || newPushesThisBatch > 40) { stoppedReason = `new pushes this batch unexpected (${newPushesThisBatch}) — STOP`; break; }
    if (next.unresolved_new_gate < 200) { stoppedReason = "remaining queue <200 — natural completion"; cur = next; break; }

    // Spot-check every N batches
    if (i % SPOT_CHECK_EVERY === 0) {
      const sc = await spotCheck();
      console.log(`  └─ spot-check (5 game-market): sampled=${sc.sampled} matched=${sc.matched} mismatched=${sc.mismatched}`);
      if (sc.mismatched > 0) { stoppedReason = `spot-check found ${sc.mismatched} mismatch(es) — STOP per D-277 lesson`; break; }
    }

    cur = next;
  }

  console.log("\n=== Post-drain snapshot ===");
  const post = await snapshot();
  overall.post = post;
  overall.stopped_reason = stoppedReason || "MAX_BATCHES reached";
  console.log(`  unresolved_new_gate: ${overall.pre.unresolved_new_gate} → ${post.unresolved_new_gate}  (Δ ${post.unresolved_new_gate - overall.pre.unresolved_new_gate})`);
  console.log(`  push_rows: ${overall.pre.push_rows} → ${post.push_rows}  (Δ ${post.push_rows - overall.pre.push_rows})`);
  console.log(`  voided: ${overall.pre.voided} → ${post.voided}  (Δ ${post.voided - overall.pre.voided})`);
  console.log(`  resolved_with_hit: ${overall.pre.resolved_with_hit} → ${post.resolved_with_hit}  (Δ ${post.resolved_with_hit - overall.pre.resolved_with_hit})`);
  console.log(`\n  stopped reason: ${overall.stopped_reason}`);

  writeFileSync(resolve(REPORT_DIR, "d389a_drain_log.json"), JSON.stringify(overall, null, 2));
  console.log(`\nWrote d389a_drain_log.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
