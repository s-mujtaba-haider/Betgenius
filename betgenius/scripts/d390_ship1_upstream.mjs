#!/usr/bin/env node
// D-390 SHIP 1 — quantify today's MLB side picks (whole-number vs ±1.5)
// and check whether ±1.5 exists in props_cache for whole-number example games.

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
  if (!res.ok) return { error: `${res.status} ${(await res.text()).slice(0, 200)}` };
  return { data: await res.json() };
}

async function main() {
  // The slate's game_date is in Eastern Time (not UTC). After ~midnight UTC
  // the UTC date is "tomorrow" while the slate is still keyed to today ET.
  const today = new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);  // shift to approximate ET
  const todayCompact = today.replace(/-/g, "");
  console.log(`Using slate date (ET-shifted): ${today}\n`);
  const out = { ts: new Date().toISOString() };

  // (1) Today's MLB side picks from recommendations_cache
  console.log("=== (1) Today's MLB side picks from recommendations_cache ===");
  const recs = await rest(`recommendations_cache?sport=eq.mlb&game_date=eq.${today}&prop_type=eq.spreads&select=player_name,pick_side,line,odds,confidence,bookmaker,created_at,last_writer&order=created_at.asc&limit=500`);
  if (recs.error) { console.error(recs.error); return; }
  console.log(`Total spread picks today: ${recs.data.length}`);

  // Bucket by absolute line value
  const byLine = new Map();
  const byMatchup = new Map();  // matchup -> {pick_side -> { line, odds, bookmaker } }
  for (const r of recs.data) {
    const abs = Math.abs(r.line);
    byLine.set(abs, (byLine.get(abs) || 0) + 1);
    if (!byMatchup.has(r.player_name)) byMatchup.set(r.player_name, []);
    byMatchup.get(r.player_name).push({ side: r.pick_side, line: r.line, odds: r.odds, conf: r.confidence, book: r.bookmaker });
  }
  console.log("\nAbsolute-line distribution:");
  for (const [abs, n] of [...byLine.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`  |line|=${abs}: ${n} pick(s)`);
  }

  // Identify whole-number side picks (|line|=1 or other whole numbers, NOT 1.5)
  const wholeNumberPicks = recs.data.filter((r) => Number.isInteger(r.line));
  const halfPointPicks = recs.data.filter((r) => !Number.isInteger(r.line));
  console.log(`\nWhole-number side picks: ${wholeNumberPicks.length}`);
  console.log(`Half-point side picks (±1.5 etc): ${halfPointPicks.length}`);
  out.summary = {
    total_spread_picks: recs.data.length,
    whole_number_count: wholeNumberPicks.length,
    half_point_count: halfPointPicks.length,
    abs_line_distribution: Object.fromEntries(byLine),
  };

  console.log("\nSample whole-number side picks:");
  const seenMatchup = new Set();
  const sampled = [];
  for (const r of wholeNumberPicks) {
    if (seenMatchup.has(r.player_name)) continue;
    seenMatchup.add(r.player_name);
    sampled.push(r);
    if (sampled.length >= 8) break;
    console.log(`  ${r.player_name}  pick=${r.pick_side} line=${r.line} odds=${r.odds} conf=${r.confidence} book=${r.bookmaker} created_at=${r.created_at.slice(11,19)}`);
  }

  console.log("\nSample half-point side picks:");
  for (const r of halfPointPicks.slice(0, 5)) {
    console.log(`  ${r.player_name}  pick=${r.pick_side} line=${r.line} odds=${r.odds} conf=${r.confidence} book=${r.bookmaker}`);
  }

  // (2) For each sampled whole-number game, check props_cache for ±1.5 standard runline existence
  console.log("\n=== (2) For sampled whole-number side picks — does ±1.5 exist in props_cache? ===");
  out.examples = [];
  for (const r of sampled) {
    const bareMatchup = r.player_name.replace(/\s+\((?:side|total)\s+\w+\)$/, "");
    const enc = (v) => encodeURIComponent(v);
    // Pull ALL spreads runline rows for this matchup today from props_cache (cross-bookmaker, cross-line-point)
    const url = `props_cache?sport=eq.mlb&game_date=eq.${todayCompact}&player_name=eq.${enc(bareMatchup)}&prop_type=eq.spreads&select=line,odds,bookmaker,pick_side,first_seen,last_seen&order=last_seen.desc&limit=200`;
    const pc = await rest(url);
    if (pc.error) {
      console.log(`\n  ${bareMatchup}  pick: ${r.pick_side} ${r.line} (REC) → props_cache ERR: ${pc.error}`);
      continue;
    }
    const distinctLines = [...new Set(pc.data.map(p => p.line))].sort((a, b) => Math.abs(a) - Math.abs(b));
    const has15 = pc.data.some(p => Math.abs(p.line) === 1.5);
    const has1 = pc.data.some(p => Math.abs(p.line) === 1);
    const has2 = pc.data.some(p => Math.abs(p.line) === 2);
    const has25 = pc.data.some(p => Math.abs(p.line) === 2.5);
    console.log(`\n  ${bareMatchup}  REC pick: ${r.pick_side} line=${r.line} odds=${r.odds}  book=${r.bookmaker}`);
    console.log(`    props_cache rows: ${pc.data.length}   distinct lines: ${distinctLines.join(", ")}`);
    console.log(`    ±1.5 in props_cache: ${has15 ? "YES" : "NO"}  | ±1: ${has1 ? "YES" : "NO"} | ±2: ${has2 ? "YES" : "NO"} | ±2.5: ${has25 ? "YES" : "NO"}`);
    if (has15) {
      // Show ±1.5 sample
      const sample15 = pc.data.filter(p => Math.abs(p.line) === 1.5 && p.pick_side === r.pick_side).slice(0, 3);
      for (const s of sample15) {
        console.log(`    ±1.5 ${s.pick_side} sample: line=${s.line} odds=${s.odds} book=${s.bookmaker} first_seen=${s.first_seen?.slice(11,19)} last_seen=${s.last_seen?.slice(11,19)}`);
      }
    }
    out.examples.push({
      matchup: bareMatchup,
      rec_pick: { side: r.pick_side, line: r.line, odds: r.odds, book: r.bookmaker },
      props_cache_lines: distinctLines,
      has_pm_1_5: has15,
      has_pm_1: has1,
      props_cache_count: pc.data.length,
    });
  }

  writeFileSync(resolve(REPORT_DIR, "d390_upstream_check.json"), JSON.stringify(out, null, 2));
  console.log(`\nWrote d390_upstream_check.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
