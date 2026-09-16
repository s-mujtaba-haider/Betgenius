#!/usr/bin/env node
// D-388 SHIP 1 — resolve-picks root-cause probe. READ-ONLY.
//
// Hypothesis tests:
//   H1: queue head jammed by stuck picks (oldest-first ordering →
//       same 200 processed every run, all skip, no progress)
//   H2: limit=200/run × 3 daily runs = 600 max resolved/day, but
//       ~706/day created → ~106/day permanent deficit
//   H3: cron has been firing but resolveMlbPicks() returns
//       resolved/unresolvable/skipped distribution skewed toward skip
//   H4: 14-day cutoff drops genuinely-resolvable picks if queue
//       head accumulates and prevents new picks from being reached
//   H5: voidPick() failing silently (HTTP 500 or RLS denial) — pick
//       stays hit=null + voided=null indefinitely

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

async function rest(path, useCountExact = false) {
  const h = { ...H };
  if (useCountExact) { h.Prefer = "count=exact"; h.Range = "0-0"; }
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: h });
  if (!res.ok) return { error: `${res.status} ${(await res.text()).slice(0, 200)}` };
  return { data: await res.json(), count: res.headers.get("content-range") };
}

async function rpc(name, body = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${name}`, { method: "POST", headers: H, body: JSON.stringify(body) });
  if (!res.ok) return { error: `${res.status} ${(await res.text()).slice(0, 200)}` };
  return { data: await res.json() };
}

const out = { ts: new Date().toISOString() };

async function main() {
  // (0) Actual cron commands for jobids 1, 2, 3 — what URL + body?
  // list_active_crons doesn't return command text; need a separate RPC.
  // Try a SECURITY DEFINER probe via SQL — no SQL exec path via REST.
  // Workaround: read the migration that created these crons.
  console.log("=== (0) resolve-picks pg_cron commands ===");
  console.log("  (no direct access to cron.job.command via REST — read from migrations / code below)");

  // (1) The current unresolved universe. By sport, by game_date.
  const cutoff14 = new Date(Date.now() - 14 * 86400 * 1000).toISOString().slice(0, 10);
  const cutoff30 = new Date(Date.now() - 30 * 86400 * 1000).toISOString().slice(0, 10);

  console.log("\n=== (1) Unresolved MLB picks universe ===");
  // Use HEAD count for the gross totals
  const allMlb = await rest("pick_history?sport=eq.mlb&is_synthetic=eq.false&hit=is.null&voided=neq.true&select=id", true);
  const mlb14 = await rest(`pick_history?sport=eq.mlb&is_synthetic=eq.false&hit=is.null&voided=neq.true&game_date=gte.${cutoff14}&select=id`, true);
  const mlb30 = await rest(`pick_history?sport=eq.mlb&is_synthetic=eq.false&hit=is.null&voided=neq.true&game_date=gte.${cutoff30}&select=id`, true);

  function nfromcount(c) { return c ? parseInt(c.split("/").pop(), 10) : null; }
  out.unresolved_universe = {
    all: nfromcount(allMlb.count),
    last_14d: nfromcount(mlb14.count),
    last_30d: nfromcount(mlb30.count),
  };
  console.log(`  ALL unresolved MLB live picks: ${out.unresolved_universe.all}`);
  console.log(`  last 14d (in cron's window):   ${out.unresolved_universe.last_14d}`);
  console.log(`  last 30d:                       ${out.unresolved_universe.last_30d}`);

  // (2) Distribution by game_date — what dates are stuck?
  console.log("\n=== (2) Unresolved MLB picks by game_date (last 30d) ===");
  const byDate = await rest(`pick_history?sport=eq.mlb&is_synthetic=eq.false&hit=is.null&voided=neq.true&game_date=gte.${cutoff30}&select=game_date&order=game_date.asc&limit=10000`);
  if (!byDate.error) {
    const counts = new Map();
    for (const r of byDate.data) counts.set(r.game_date, (counts.get(r.game_date) || 0) + 1);
    const sorted = [...counts.entries()].sort();
    out.unresolved_by_date = sorted.map(([d, n]) => ({ game_date: d, count: n }));
    for (const [d, n] of sorted) console.log(`  ${d}: ${n}`);
  }

  // (3) Distribution by mlb_market_type / prop_type — is one class jamming?
  console.log("\n=== (3) Unresolved MLB picks by prop_type (last 14d) ===");
  const byProp = await rest(`pick_history?sport=eq.mlb&is_synthetic=eq.false&hit=is.null&voided=neq.true&game_date=gte.${cutoff14}&select=prop_type,mlb_market_type&limit=10000`);
  if (!byProp.error) {
    const counts = new Map();
    for (const r of byProp.data) {
      const k = `${r.prop_type || "(null)"}__${r.mlb_market_type || "(null)"}`;
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    out.unresolved_by_prop = [];
    for (const [k, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${k.padEnd(40).slice(0, 40)}  ${n}`);
      out.unresolved_by_prop.push({ key: k, count: n });
    }
  }

  // (4) The OLDEST 20 unresolved MLB picks in the cron's window — head of queue
  console.log("\n=== (4) Oldest 20 unresolved MLB live picks in cron's 14d window (queue head) ===");
  const head = await rest(`pick_history?sport=eq.mlb&is_synthetic=eq.false&hit=is.null&voided=neq.true&game_date=gte.${cutoff14}&select=id,player_name,prop_type,mlb_market_type,pick_side,line,game_date,game_time,created_at,opponent,is_home,team&order=created_at.asc&limit=20`);
  if (!head.error) {
    out.queue_head_20 = head.data;
    for (const r of head.data) {
      console.log(`  ${r.created_at.slice(0, 19)}  gd=${r.game_date}  ${r.player_name}  ${r.prop_type}/${r.mlb_market_type ?? "-"}  ${r.pick_side} ${r.line}  vs ${r.opponent ?? "-"}`);
    }
  }

  // (5) For the oldest 5, fetch the MLB schedule for their game_date — was the game Final?
  console.log("\n=== (5) Are queue-head game_dates Final on MLB Stats API? ===");
  if (head.data) {
    const distinctDates = [...new Set(head.data.slice(0, 5).map(r => r.game_date))];
    out.head_dates_final_check = [];
    for (const d of distinctDates) {
      const url = `https://statsapi.mlb.com/api/v1/schedule?sportId=1&date=${d}`;
      try {
        const r = await fetch(url);
        if (!r.ok) {
          console.log(`  ${d}: FETCH FAILED status=${r.status}`);
          out.head_dates_final_check.push({ date: d, error: `status=${r.status}` });
          continue;
        }
        const j = await r.json();
        const games = (j.dates?.[0]?.games) || [];
        const total = games.length;
        const finals = games.filter(g => g.status?.detailedState === "Final" || g.status?.detailedState === "Game Over" || g.status?.detailedState === "Completed Early").length;
        console.log(`  ${d}: total=${total} final=${finals} (others: ${games.filter(g => !["Final","Game Over","Completed Early"].includes(g.status?.detailedState)).map(g => g.status?.detailedState).slice(0, 5).join(",")})`);
        out.head_dates_final_check.push({ date: d, total, finals, statuses: games.map(g => g.status?.detailedState) });
      } catch (e) {
        console.log(`  ${d}: ERROR ${e.message}`);
        out.head_dates_final_check.push({ date: d, error: e.message });
      }
    }
  }

  // (6) Resolved cadence — how many resolved per day in last 14d?
  console.log("\n=== (6) Resolved MLB picks per day (last 14d) by resolved_at ===");
  const resolved = await rest(`pick_history?sport=eq.mlb&is_synthetic=eq.false&hit=not.is.null&resolved_at=gte.${cutoff14}&select=resolved_at&order=resolved_at.desc&limit=10000`);
  if (!resolved.error) {
    const counts = new Map();
    for (const r of resolved.data) {
      const day = r.resolved_at.slice(0, 10);
      counts.set(day, (counts.get(day) || 0) + 1);
    }
    out.resolved_per_day = [...counts.entries()].sort();
    for (const [d, n] of out.resolved_per_day) console.log(`  ${d}: ${n}`);
  }

  // (7) Voided cadence — how many voided per day in last 14d?
  console.log("\n=== (7) Voided MLB picks per day (last 14d) ===");
  const voided = await rest(`pick_history?sport=eq.mlb&is_synthetic=eq.false&voided=eq.true&created_at=gte.${cutoff14}&select=created_at&order=created_at.desc&limit=10000`);
  if (!voided.error) {
    const counts = new Map();
    for (const r of voided.data) {
      const day = r.created_at.slice(0, 10);
      counts.set(day, (counts.get(day) || 0) + 1);
    }
    out.voided_per_day = [...counts.entries()].sort();
    for (const [d, n] of out.voided_per_day) console.log(`  ${d}: ${n}`);
  }

  // (8) Created cadence (denominator) — picks created per day last 14d
  console.log("\n=== (8) MLB live picks CREATED per day (last 14d) — denominator ===");
  const created = await rest(`pick_history?sport=eq.mlb&is_synthetic=eq.false&created_at=gte.${cutoff14}&select=created_at&order=created_at.desc&limit=10000`);
  if (!created.error) {
    const counts = new Map();
    for (const r of created.data) {
      const day = r.created_at.slice(0, 10);
      counts.set(day, (counts.get(day) || 0) + 1);
    }
    out.created_per_day = [...counts.entries()].sort();
    for (const [d, n] of out.created_per_day) console.log(`  ${d}: ${n}`);
  }

  // (9) Reverse the queue — what are the NEWEST unresolved picks? Are they recent (expected) or old (queue jammed)?
  console.log("\n=== (9) Newest 10 unresolved MLB picks (queue tail) ===");
  const tail = await rest(`pick_history?sport=eq.mlb&is_synthetic=eq.false&hit=is.null&voided=neq.true&game_date=gte.${cutoff14}&select=id,player_name,prop_type,game_date,created_at&order=created_at.desc&limit=10`);
  if (!tail.error) {
    for (const r of tail.data) {
      console.log(`  ${r.created_at.slice(0, 19)}  gd=${r.game_date}  ${r.player_name} ${r.prop_type}`);
    }
  }

  // (10) Sanity: how many MLB picks have resolved_at NULL AND hit IS NULL AND voided IS NULL — distinguish "in-flight unresolved" vs "voided-but-not-marked"
  console.log("\n=== (10) MLB picks with resolved_at NULL split by voided state ===");
  const splitA = await rest("pick_history?sport=eq.mlb&is_synthetic=eq.false&hit=is.null&voided=is.null&select=id", true);
  const splitB = await rest("pick_history?sport=eq.mlb&is_synthetic=eq.false&hit=is.null&voided=eq.false&select=id", true);
  const splitC = await rest("pick_history?sport=eq.mlb&is_synthetic=eq.false&hit=is.null&voided=eq.true&select=id", true);
  console.log(`  hit=null + voided=null  (unresolved + never-voided-flag-set): ${nfromcount(splitA.count)}`);
  console.log(`  hit=null + voided=false (unresolved + explicitly not voided): ${nfromcount(splitB.count)}`);
  console.log(`  hit=null + voided=true  (voided but hit still null):           ${nfromcount(splitC.count)}`);
  out.unresolved_voided_split = {
    voided_null: nfromcount(splitA.count),
    voided_false: nfromcount(splitB.count),
    voided_true: nfromcount(splitC.count),
  };

  writeFileSync(resolve(REPORT_DIR, "d388_resolve_probe.json"), JSON.stringify(out, null, 2));
  console.log(`\nWrote d388_resolve_probe.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
