#!/usr/bin/env node
// D-385 — empirical settle probe.
//
// Pulls RESOLVED live MLB picks (is_synthetic=false, hit IS NOT NULL,
// ai_analysis IS NOT NULL), parses Sonnet verdict from ai_analysis prose
// using the same conservative tail-regex the frontend chip uses, and
// computes hit-rate comparisons:
//   (a) high-tier picks (conf >= 70) by verdict bucket
//   (b) high-tier picks by whether breakdown shows Statcast quality-of-
//       contact factors (barrel/xBA/xSLG regression/exit velo trend) as
//       the dominant positive driver vs recent-execution factors
//       (batter_form, batter_hit_rate, recent_at_bats, recent_run_diff)
//
// Read-only. No mutations. CLAUDE.md autonomy: "Query the database
// read-only via supabase CLI" — fetch via REST with service role.

import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(__dirname, "..");
const REPORT_DIR = resolve(projectRoot, "docs", "loop", "reports");
mkdirSync(REPORT_DIR, { recursive: true });

const envLocal = readFileSync(resolve(projectRoot, ".env.local"), "utf8");
const SUPABASE_URL = envLocal.match(/VITE_SUPABASE_URL=["']?([^"'\n]+)/)[1];
const SERVICE_ROLE = envLocal.match(/SUPABASE_SERVICE_ROLE_KEY=["']?([^"'\n]+)/)[1];

// Conservative tail regex — same logic as src/lib/ai_verdict.ts
// extractAIVerdict: scan last 160 chars, FADE > LEAN > TAKE tie-break.
function extractAIVerdict(text) {
  if (!text || typeof text !== "string") return null;
  const tail = text.slice(-160).toUpperCase();
  const hasFade = /\bFADE\b/.test(tail);
  const hasLean = /\bLEAN\b/.test(tail);
  const hasTake = /\bTAKE\b/.test(tail);
  if (hasFade) return "FADE";
  if (hasLean) return "LEAN";
  if (hasTake) return "TAKE";
  return null;
}

// Statcast quality-of-contact factors. These are the hypothesized
// over-weighting drivers — if a high-tier pick was driven by these but
// Sonnet faded on "recent execution," and the pick LOST, that's evidence
// the algorithm over-trusts peripherals.
const STATCAST_PERIPHERAL_FACTORS = [
  "score_batter_xba",
  "score_batter_exit_velo_trend",
  "score_batter_barrel_rate",
  "score_batter_xslg_regression",
  "score_batter_babip",
  "score_pitcher_xera_edge",
  "score_pitcher_baa",
  "score_pitcher_pitch_mix_k",
];

// Recent-execution factors (what Sonnet keys on when it fades the periph).
const EXECUTION_FACTORS = [
  "score_batter_form",
  "score_batter_form_power",
  "score_batter_hit_rate",
  "score_recent_at_bats",
  "score_recent_run_diff",
  "score_pitcher_form",
  "score_team_form",
];

async function fetchPicks() {
  // Hard-rule filter: live MLB resolved picks with Sonnet narrative.
  // Range header to grab up to 5000; if more exist we'll page.
  const out = [];
  let from = 0;
  const PAGE = 1000;
  while (true) {
    const url = `${SUPABASE_URL}/rest/v1/pick_history` +
      `?sport=eq.mlb` +
      `&is_synthetic=eq.false` +
      `&hit=not.is.null` +
      `&ai_analysis=not.is.null` +
      `&confidence=gte.70` +
      `&select=id,player_name,prop_type,pick_side,line,confidence,verdict,ai_analysis,hit,breakdown,created_at,resolved_at,mlb_market_type` +
      `&order=created_at.desc`;
    const res = await fetch(url, {
      headers: {
        apikey: SERVICE_ROLE,
        Authorization: `Bearer ${SERVICE_ROLE}`,
        Range: `${from}-${from + PAGE - 1}`,
      },
    });
    if (!res.ok) throw new Error(`fetch failed: ${res.status} ${await res.text()}`);
    const rows = await res.json();
    out.push(...rows);
    if (rows.length < PAGE) break;
    from += PAGE;
  }
  return out;
}

function tierOf(c) {
  if (c >= 90) return "ELITE";
  if (c >= 80) return "STRONG";
  if (c >= 70) return "GOOD";
  return "LEAN";
}

// Classify whether breakdown shows Statcast peripheral or execution factors
// as the dominant positive driver. Return: "statcast" / "execution" / "mixed" / "neither".
function classifyDriver(breakdown) {
  if (!breakdown || typeof breakdown !== "object") return "no_breakdown";
  const peripheralSum = STATCAST_PERIPHERAL_FACTORS.reduce((s, k) => {
    const v = Number(breakdown[k]) || 0;
    return s + Math.max(0, v);
  }, 0);
  const executionSum = EXECUTION_FACTORS.reduce((s, k) => {
    const v = Number(breakdown[k]) || 0;
    return s + Math.max(0, v);
  }, 0);
  if (peripheralSum === 0 && executionSum === 0) return "neither";
  if (peripheralSum > executionSum * 1.5) return "statcast";
  if (executionSum > peripheralSum * 1.5) return "execution";
  return "mixed";
}

function hitRate(arr) {
  const resolved = arr.filter((p) => p.hit === true || p.hit === false);
  if (resolved.length === 0) return { rate: null, n: 0 };
  const hits = resolved.filter((p) => p.hit === true).length;
  return { rate: hits / resolved.length, n: resolved.length, hits };
}

async function main() {
  console.log("Fetching live MLB resolved picks with confidence>=70 and ai_analysis...");
  const picks = await fetchPicks();
  console.log(`Total candidate rows: ${picks.length}`);

  // Parse verdict from ai_analysis. Picks lacking parseable verdict
  // (e.g., template fallback narratives slipping through) bucketed separately.
  const enriched = picks.map((p) => ({
    ...p,
    parsed_verdict: extractAIVerdict(p.ai_analysis),
    tier: tierOf(p.confidence),
    driver: classifyDriver(p.breakdown),
  }));

  const withVerdict = enriched.filter((p) => p.parsed_verdict);
  const withBreakdown = enriched.filter((p) => p.breakdown);
  console.log(`With parseable verdict: ${withVerdict.length} of ${enriched.length}`);
  console.log(`With breakdown column populated: ${withBreakdown.length} of ${enriched.length}`);

  const buckets = {
    by_tier: {},
    by_verdict: {},
    by_tier_x_verdict: {},
    by_driver: {},
    by_tier_x_driver: {},
    by_driver_x_verdict: {},
  };

  for (const tier of ["ELITE", "STRONG", "GOOD"]) {
    const t = enriched.filter((p) => p.tier === tier);
    buckets.by_tier[tier] = hitRate(t);
    for (const v of ["TAKE", "LEAN", "FADE"]) {
      const tv = enriched.filter((p) => p.tier === tier && p.parsed_verdict === v);
      buckets.by_tier_x_verdict[`${tier}_${v}`] = hitRate(tv);
    }
  }
  for (const v of ["TAKE", "LEAN", "FADE"]) {
    buckets.by_verdict[v] = hitRate(enriched.filter((p) => p.parsed_verdict === v));
  }
  for (const d of ["statcast", "execution", "mixed", "neither", "no_breakdown"]) {
    buckets.by_driver[d] = hitRate(enriched.filter((p) => p.driver === d));
  }
  for (const tier of ["ELITE", "STRONG", "GOOD"]) {
    for (const d of ["statcast", "execution", "mixed"]) {
      buckets.by_tier_x_driver[`${tier}_${d}`] = hitRate(enriched.filter((p) => p.tier === tier && p.driver === d));
    }
  }
  for (const d of ["statcast", "execution", "mixed"]) {
    for (const v of ["TAKE", "FADE"]) {
      buckets.by_driver_x_verdict[`${d}_${v}`] = hitRate(enriched.filter((p) => p.driver === d && p.parsed_verdict === v));
    }
  }

  // The headline question: did high-tier (GOOD+) picks Sonnet FADED hit
  // better or worse than ones Sonnet TOOK?
  const highTier = enriched;  // already conf>=70
  const highTierTake = highTier.filter((p) => p.parsed_verdict === "TAKE");
  const highTierFade = highTier.filter((p) => p.parsed_verdict === "FADE");
  const headline = {
    high_tier_TAKE: hitRate(highTierTake),
    high_tier_FADE: hitRate(highTierFade),
    high_tier_LEAN: hitRate(highTier.filter((p) => p.parsed_verdict === "LEAN")),
    high_tier_no_verdict: hitRate(highTier.filter((p) => !p.parsed_verdict)),
  };

  // Substantive-FADE list — high-tier + FADE verdict. Strip ai_analysis to keep file small.
  const substantive = highTierFade.map((p) => ({
    id: p.id,
    created_at: p.created_at,
    player_name: p.player_name,
    prop_type: p.prop_type,
    pick_side: p.pick_side,
    line: p.line,
    confidence: p.confidence,
    tier: p.tier,
    hit: p.hit,
    driver: p.driver,
    mlb_market_type: p.mlb_market_type,
    has_breakdown: !!p.breakdown,
    fade_tail: p.ai_analysis?.slice(-220) ?? null,
  }));

  const report = {
    ts: new Date().toISOString(),
    universe: {
      sport: "mlb",
      is_synthetic: false,
      confidence_gte: 70,
      hit_not_null: true,
      ai_analysis_not_null: true,
      total_rows: enriched.length,
      with_parseable_verdict: withVerdict.length,
      with_breakdown: withBreakdown.length,
    },
    headline,
    buckets,
    substantive_fade_list: substantive,
  };

  const outPath = resolve(REPORT_DIR, "d385_probe.json");
  writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`Wrote ${outPath}`);

  // Print a human summary.
  console.log("\n=== HEADLINE (high tier = conf >= 70) ===");
  for (const [k, v] of Object.entries(headline)) {
    const pct = v.rate === null ? "n/a" : (v.rate * 100).toFixed(1) + "%";
    console.log(`  ${k.padEnd(28)} ${pct.padStart(7)}  (n=${v.n})`);
  }
  console.log("\n=== BY TIER × VERDICT ===");
  for (const [k, v] of Object.entries(buckets.by_tier_x_verdict)) {
    const pct = v.rate === null ? "n/a" : (v.rate * 100).toFixed(1) + "%";
    console.log(`  ${k.padEnd(20)} ${pct.padStart(7)}  (n=${v.n})`);
  }
  console.log("\n=== BY BREAKDOWN DRIVER ===");
  for (const [k, v] of Object.entries(buckets.by_driver)) {
    const pct = v.rate === null ? "n/a" : (v.rate * 100).toFixed(1) + "%";
    console.log(`  ${k.padEnd(16)} ${pct.padStart(7)}  (n=${v.n})`);
  }
  console.log("\n=== BY TIER × DRIVER ===");
  for (const [k, v] of Object.entries(buckets.by_tier_x_driver)) {
    const pct = v.rate === null ? "n/a" : (v.rate * 100).toFixed(1) + "%";
    console.log(`  ${k.padEnd(22)} ${pct.padStart(7)}  (n=${v.n})`);
  }
  console.log("\n=== BY DRIVER × VERDICT (peripheral-driven FADE is the key cell) ===");
  for (const [k, v] of Object.entries(buckets.by_driver_x_verdict)) {
    const pct = v.rate === null ? "n/a" : (v.rate * 100).toFixed(1) + "%";
    console.log(`  ${k.padEnd(22)} ${pct.padStart(7)}  (n=${v.n})`);
  }
  console.log(`\nSubstantive-FADE picks (high tier + Sonnet FADE) sample: ${substantive.length}`);
  console.log("Top 8:");
  for (const p of substantive.slice(0, 8)) {
    console.log(`  [${p.tier} ${p.confidence}] ${p.player_name} ${p.prop_type} ${p.pick_side} ${p.line} → hit=${p.hit} driver=${p.driver}`);
    console.log(`    fade_tail: ...${(p.fade_tail || "").replace(/\s+/g, " ").slice(-140)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
