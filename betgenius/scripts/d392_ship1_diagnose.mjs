#!/usr/bin/env node
// D-392 SHIP 1 — diagnose whether whole-number game_total picks are M2
// write-order artifacts (like sides) OR legitimately the books' primary
// posted total. CRITICAL distinction — totals can legitimately land on
// whole numbers (e.g. 9.0 is a real standard line), unlike runlines.
//
// Probes:
//  (1) Today's totals: whole-number vs half-point count + line distribution
//  (2) For each whole-number total game: enumerate ALL bookmaker (line, odds)
//      tuples in props_cache. Is hardrockbet posting a half-point too? Is
//      the whole-number the primary at every book or just at one (e.g. rebet)?
//  (3) The race-path check is identical to D-390 for sides (conflict key
//      omits line, last-writer-wins). Confirm structurally.
//  (4) Push exposure on 30d resolved game_total picks: whole-number push%
//      vs half-point push% (half-point can never push, but worth confirming).

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
const H = { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` };

async function rest(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { headers: H });
  if (!res.ok) return { error: `${res.status} ${(await res.text()).slice(0, 200)}` };
  return { data: await res.json() };
}

const PRIORITY_BOOKS = ["hardrockbet", "hardrockbet_oh", "draftkings", "fanduel", "betmgm", "bovada", "pointsbet"];

async function main() {
  const slateDate = new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
  const slateCompact = slateDate.replace(/-/g, "");
  console.log(`Slate (ET-shifted): ${slateDate}\n`);
  const out = { ts: new Date().toISOString(), slate: slateDate };

  // (1) Today's MLB totals from rec_cache
  console.log("=== (1) Today's MLB game_total picks from rec_cache ===");
  const totals = await rest(`recommendations_cache?sport=eq.mlb&game_date=eq.${slateDate}&prop_type=eq.totals&select=player_name,pick_side,line,odds,confidence,bookmaker,created_at&order=created_at.asc&limit=200`);
  if (totals.error) { console.error(totals.error); return; }
  console.log(`Total game_total picks today: ${totals.data.length}`);
  const wholeNumber = totals.data.filter(r => Number.isInteger(r.line));
  const halfPoint = totals.data.filter(r => !Number.isInteger(r.line));
  console.log(`  whole-number: ${wholeNumber.length}`);
  console.log(`  half-point  : ${halfPoint.length}`);
  const lineDist = {};
  for (const r of totals.data) {
    const k = r.line;
    lineDist[k] = (lineDist[k] || 0) + 1;
  }
  console.log(`  line distribution: ${JSON.stringify(lineDist)}`);
  out.summary = {
    total_picks: totals.data.length,
    whole_number_count: wholeNumber.length,
    half_point_count: halfPoint.length,
    line_distribution: lineDist,
  };

  console.log("\nSample whole-number total picks (matchup × side):");
  const seenMatchupSide = new Set();
  const samples = [];
  for (const r of wholeNumber) {
    const key = `${r.player_name}|${r.pick_side}`;
    if (seenMatchupSide.has(key)) continue;
    seenMatchupSide.add(key);
    samples.push(r);
    console.log(`  ${r.player_name.slice(0,55).padEnd(55)}  pick=${r.pick_side}  line=${r.line}  odds=${r.odds}  conf=${r.confidence}  book=${r.bookmaker}`);
    if (samples.length >= 8) break;
  }

  console.log("\nSample half-point total picks:");
  for (const r of halfPoint.slice(0, 5)) {
    console.log(`  ${r.player_name.slice(0,55).padEnd(55)}  pick=${r.pick_side}  line=${r.line}  odds=${r.odds}  conf=${r.confidence}  book=${r.bookmaker}`);
  }

  // (2) THE CRITICAL TEST: for each whole-number total sample, what does
  //     props_cache look like across bookmakers? Is half-point ALSO available
  //     from priority books?
  console.log("\n=== (2) CRITICAL TEST: per whole-number total game, is half-point also in props_cache? ===");
  out.per_game_analysis = [];
  for (const r of samples) {
    const bare = r.player_name.replace(/\s+\(total\s+\w+\)$/, "");
    const enc = (v) => encodeURIComponent(v);
    const url = `props_cache?sport=eq.mlb&game_date=eq.${slateCompact}&player_name=eq.${enc(bare)}&prop_type=eq.totals&pick_side=eq.${enc(r.pick_side)}&select=line,odds,bookmaker,first_seen,last_seen&order=last_seen.desc&limit=50`;
    const pc = await rest(url);
    if (pc.error) {
      console.log(`\n  ${bare} ${r.pick_side}: ${pc.error}`);
      continue;
    }
    if (pc.data.length === 0) {
      console.log(`\n  ${bare} ${r.pick_side}: 0 props_cache rows (UNUSUAL — would expect upstream data)`);
      continue;
    }

    // Distinct (line, bookmaker) tuples
    const byLine = new Map();
    for (const p of pc.data) {
      const k = `${p.line}`;
      if (!byLine.has(k)) byLine.set(k, []);
      byLine.get(k).push(p);
    }
    const distinctLines = [...byLine.keys()].map(Number).sort((a, b) => a - b);

    console.log(`\n  ${bare} ${r.pick_side}`);
    console.log(`    REC pick: line=${r.line} odds=${r.odds} book=${r.bookmaker} conf=${r.confidence}`);
    console.log(`    props_cache distinct lines: ${distinctLines.join(", ")}`);

    // For each line, list bookmakers
    for (const lineVal of distinctLines) {
      const rows = byLine.get(String(lineVal));
      const books = rows.map((x) => x.bookmaker).sort();
      const priorityBooks = books.filter((b) => PRIORITY_BOOKS.includes(b));
      const isHalfPoint = !Number.isInteger(lineVal);
      const marker = isHalfPoint ? "HALF-POINT" : "WHOLE-NUMBER";
      console.log(`      line=${String(lineVal).padEnd(5)}  ${marker}  ${books.length} book(s): ${books.join(",")}${priorityBooks.length > 0 ? `  ← PRIORITY: ${priorityBooks.join(",")}` : ""}`);
    }

    // Verdict per-game
    const halfPointLines = distinctLines.filter((l) => !Number.isInteger(l));
    const wholeNumberLines = distinctLines.filter((l) => Number.isInteger(l));
    const halfPointBooks = new Set();
    const wholeNumberBooks = new Set();
    for (const lineVal of halfPointLines) for (const row of byLine.get(String(lineVal))) halfPointBooks.add(row.bookmaker);
    for (const lineVal of wholeNumberLines) for (const row of byLine.get(String(lineVal))) wholeNumberBooks.add(row.bookmaker);
    const halfHasPriority = [...halfPointBooks].some((b) => PRIORITY_BOOKS.includes(b));
    const wholeHasPriority = [...wholeNumberBooks].some((b) => PRIORITY_BOOKS.includes(b));
    const verdict =
      (halfPointLines.length === 0) ? "ONLY-WHOLE-NUMBER (no half-point in any book)" :
      (wholeNumberLines.length === 0) ? "ONLY-HALF-POINT (no whole-number in any book)" :
      (halfHasPriority && wholeHasPriority) ? "BOTH-AT-PRIORITY-BOOKS (race condition with both legitimate)" :
      (halfHasPriority && !wholeHasPriority) ? "M2 ARTIFACT (half-point at priority, whole-number only at non-priority)" :
      (!halfHasPriority && wholeHasPriority) ? "WHOLE-NUMBER-PRIMARY (whole-number at priority, half-point only at non-priority)" :
      "MIXED (neither at priority)";
    console.log(`    PER-GAME VERDICT: ${verdict}`);
    out.per_game_analysis.push({
      matchup: bare,
      pick_side: r.pick_side,
      rec_line: r.line,
      rec_book: r.bookmaker,
      distinct_lines: distinctLines,
      half_point_books: [...halfPointBooks],
      whole_number_books: [...wholeNumberBooks],
      half_at_priority: halfHasPriority,
      whole_at_priority: wholeHasPriority,
      verdict,
    });
  }

  // (3) 30-day push exposure on resolved game_total picks
  console.log("\n=== (3) 30-day push exposure on resolved game_total picks (hit IS NULL + resolved_at set OR hit=true/false) ===");
  const cutoff = new Date(Date.now() - 30 * 86400 * 1000).toISOString().slice(0, 10);
  const resolved = await rest(`pick_history?sport=eq.mlb&is_synthetic=eq.false&prop_type=eq.totals&resolved_at=not.is.null&game_date=gte.${cutoff}&voided=eq.false&select=line,pick_side,hit,actual_value&limit=10000`);
  if (resolved.error) { console.error(resolved.error); }
  else {
    const buckets = new Map();
    for (const r of resolved.data) {
      const abs = r.line;
      if (!buckets.has(abs)) buckets.set(abs, { total: 0, hit: 0, miss: 0, push: 0 });
      const b = buckets.get(abs);
      b.total++;
      if (r.hit === true) b.hit++;
      else if (r.hit === false) b.miss++;
      else b.push++;
    }
    console.log(`  ${resolved.data.length} resolved game_total picks fetched`);
    console.log("  line   total    hit%   miss%  push%   (h/m/p)");
    for (const [abs, b] of [...buckets.entries()].sort((a, b) => a[0] - b[0])) {
      if (b.total === 0) continue;
      const hpct = (b.hit / b.total * 100).toFixed(1);
      const mpct = (b.miss / b.total * 100).toFixed(1);
      const ppct = (b.push / b.total * 100).toFixed(1);
      console.log(`  ${String(abs).padStart(5)}  ${String(b.total).padStart(5)}    ${hpct.padStart(4)}%   ${mpct.padStart(4)}%  ${ppct.padStart(4)}%   (${b.hit}/${b.miss}/${b.push})`);
    }

    // Aggregate
    let wT = 0, wH = 0, wM = 0, wP = 0;
    let hT = 0, hH = 0, hM = 0, hP = 0;
    for (const [abs, b] of buckets) {
      if (Number.isInteger(abs)) { wT += b.total; wH += b.hit; wM += b.miss; wP += b.push; }
      else { hT += b.total; hH += b.hit; hM += b.miss; hP += b.push; }
    }
    console.log(`\n  whole-number (n=${wT}): hit=${(wH/wT*100).toFixed(1)}% miss=${(wM/wT*100).toFixed(1)}% PUSH=${(wP/wT*100).toFixed(1)}%`);
    console.log(`  half-point   (n=${hT}): hit=${(hH/hT*100).toFixed(1)}% miss=${(hM/hT*100).toFixed(1)}% PUSH=${(hP/hT*100).toFixed(1)}%`);
    out.push_exposure_30d = {
      by_line: Object.fromEntries(buckets),
      whole_number: { n: wT, hit_pct: wH/wT*100, push_pct: wP/wT*100 },
      half_point: { n: hT, hit_pct: hH/hT*100, push_pct: hP/hT*100 },
    };
  }

  writeFileSync(resolve(REPORT_DIR, "d392_diagnosis.json"), JSON.stringify(out, null, 2));
  console.log(`\nWrote d392_diagnosis.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
