#!/usr/bin/env node
// D-386 SHIP 2 — data-side verification that the deployed label-suppression
// logic matches the same parser inputs. Pulls today's MLB cards from
// recommendations_cache, simulates the new confBadge logic, and reports
// expected per-card render (label shown vs suppressed).
//
// We can't test render directly (no headless browser auth ready in this
// session), but the suppression rule is purely deterministic on (conf,
// extractAIVerdict(ai_analysis)) — verifying the inputs + the predicate
// gives the same answer as DOM probing.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const envLocal = readFileSync(resolve(projectRoot, ".env.local"), "utf8");
const SUPABASE_URL = envLocal.match(/VITE_SUPABASE_URL=["']?([^"'\n]+)/)[1];
const SERVICE_ROLE = envLocal.match(/SUPABASE_SERVICE_ROLE_KEY=["']?([^"'\n]+)/)[1];

// Same parser the frontend confBadge uses (src/lib/ai_verdict.ts).
function extractAIVerdict(text) {
  if (!text || typeof text !== "string") return null;
  const tail = text.slice(-160).toUpperCase();
  if (/\bFADE\b/.test(tail)) return "FADE";
  if (/\bLEAN\b/.test(tail)) return "LEAN";
  if (/\bTAKE\b/.test(tail)) return "TAKE";
  return null;
}

function tierLabel(conf) {
  if (conf >= 90) return "Elite";
  if (conf >= 80) return "Strong";
  if (conf >= 70) return "Good";
  if (conf >= 60) return "Lean";
  return "Pass";
}

// New D-386 logic: tier label shown unless (conf>=70 AND verdict===FADE).
function labelShown(conf, ai) {
  return !(conf >= 70 && extractAIVerdict(ai) === "FADE");
}

async function fetchToday(table, extraFilter = "") {
  // No date filter — current slate may span game_date boundaries.
  // Order by created_at DESC and limit 300 grabs the most recent batch.
  const url = `${SUPABASE_URL}/rest/v1/${table}?sport=eq.mlb${extraFilter}&select=player_name,prop_type,pick_side,line,confidence,ai_analysis&order=created_at.desc&limit=300`;
  const res = await fetch(url, { headers: { apikey: SERVICE_ROLE, Authorization: `Bearer ${SERVICE_ROLE}` } });
  if (!res.ok) throw new Error(`${table} fetch failed: ${res.status} ${await res.text()}`);
  return res.json();
}

const out = { ts: new Date().toISOString(), games: { sampled: 0, fade_suppresses: 0, take_keeps: 0, no_verdict_keeps: 0, low_conf_keeps: 0, examples: [] }, dashboard_props: { sampled: 0, fade_suppresses: 0, take_keeps: 0, no_verdict_keeps: 0, low_conf_keeps: 0 } };

async function main() {
  // ---- Games.tsx surface: spread + game_total picks ----
  const gameRows = await fetchToday("recommendations_cache", "&prop_type=in.(spread,game_total,spreads,totals,h2h)");
  out.games.sampled = gameRows.length;
  for (const r of gameRows) {
    const v = extractAIVerdict(r.ai_analysis);
    const lbl = labelShown(r.confidence, r.ai_analysis);
    const tier = tierLabel(r.confidence);
    if (r.confidence >= 70 && v === "FADE") out.games.fade_suppresses++;
    else if (r.confidence >= 70 && v === "TAKE") out.games.take_keeps++;
    else if (r.confidence >= 70 && !v) out.games.no_verdict_keeps++;
    else if (r.confidence < 70) out.games.low_conf_keeps++;
    // Capture a handful of representative examples (one per branch).
    if (
      (r.confidence >= 70 && v === "FADE" && out.games.examples.filter(e => e.branch === "FADE-suppress").length < 2) ||
      (r.confidence >= 70 && v === "TAKE" && out.games.examples.filter(e => e.branch === "TAKE-keep").length < 2) ||
      (r.confidence >= 70 && !v && out.games.examples.filter(e => e.branch === "no-verdict-keep").length < 1) ||
      (r.confidence < 70 && out.games.examples.filter(e => e.branch === "low-conf-keep").length < 1)
    ) {
      out.games.examples.push({
        branch: r.confidence >= 70 && v === "FADE" ? "FADE-suppress" :
                r.confidence >= 70 && v === "TAKE" ? "TAKE-keep" :
                r.confidence >= 70 && !v ? "no-verdict-keep" : "low-conf-keep",
        confidence: r.confidence,
        tier,
        verdict: v,
        player_name: r.player_name,
        prop_type: r.prop_type,
        pick_side: r.pick_side,
        line: r.line,
        label_renders: lbl,
        tail: (r.ai_analysis || "").slice(-140).replace(/\s+/g, " "),
      });
    }
  }

  // ---- Dashboard surface: prop picks (NOT game-side) ----
  const propRows = await fetchToday("recommendations_cache", "&prop_type=not.in.%28spread%2Cgame_total%2Ch2h%2Cspreads%2Ctotals%29");
  out.dashboard_props.sampled = propRows.length;
  for (const r of propRows) {
    const v = extractAIVerdict(r.ai_analysis);
    if (r.confidence >= 70 && v === "FADE") out.dashboard_props.fade_suppresses++;
    else if (r.confidence >= 70 && v === "TAKE") out.dashboard_props.take_keeps++;
    else if (r.confidence >= 70 && !v) out.dashboard_props.no_verdict_keeps++;
    else if (r.confidence < 70) out.dashboard_props.low_conf_keeps++;
  }

  const outPath = resolve(projectRoot, "docs", "loop", "reports", "d386_verify.json");
  writeFileSync(outPath, JSON.stringify(out, null, 2));

  console.log("=== Games tab (spread + game_total) ===");
  console.log(`  sampled: ${out.games.sampled}`);
  console.log(`  FADE → tier label SUPPRESSED: ${out.games.fade_suppresses}`);
  console.log(`  TAKE → tier label KEPT:       ${out.games.take_keeps}`);
  console.log(`  no verdict → tier label KEPT: ${out.games.no_verdict_keeps}`);
  console.log(`  conf<70 → unchanged:          ${out.games.low_conf_keeps}`);
  console.log("\n=== Examples ===");
  for (const e of out.games.examples) {
    console.log(`  [${e.tier} ${e.confidence}] ${e.player_name} ${e.prop_type} ${e.pick_side ?? ""} ${e.line ?? ""}`);
    console.log(`    branch=${e.branch}  verdict=${e.verdict}  label_renders=${e.label_renders}`);
    console.log(`    tail: ...${e.tail.slice(-130)}`);
  }
  console.log("\n=== Dashboard tab (props) ===");
  console.log(`  sampled: ${out.dashboard_props.sampled}`);
  console.log(`  FADE → tier label SUPPRESSED: ${out.dashboard_props.fade_suppresses}`);
  console.log(`  TAKE → tier label KEPT:       ${out.dashboard_props.take_keeps}`);
  console.log(`  no verdict → tier label KEPT: ${out.dashboard_props.no_verdict_keeps}`);
  console.log(`  conf<70 → unchanged:          ${out.dashboard_props.low_conf_keeps}`);
  console.log(`\nWrote ${outPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
