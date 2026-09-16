// Apply current MLB_EV policy to graded pick_history rows (no re-score).
// Writes harness/out/phase1_pick_history_policy_replay.json

import { closePool, getDbFromEnv } from "../lib/env.ts";
import { unitProfit } from "../lib/oddsmath.ts";
import { mlbRecommendationShown } from "../../supabase/functions/_shared/mlb_ev_policy.ts";

interface Row {
  mkt: string;
  pick_side: string;
  hit: boolean;
  odds: number;
  confidence: number | null;
  unbettable_juice_flag: boolean | null;
  ev_per_unit: number | null;
}

function summarize(
  rows: Array<{ mkt: string; side: string; hit: boolean; odds: number }>,
) {
  const by = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = by.get(r.mkt) ?? [];
    list.push(r);
    by.set(r.mkt, list);
  }
  const out: Record<string, unknown> = {};
  for (const [mkt, xs] of [...by.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const profits = xs.map((x) => unitProfit(x.odds, x.hit));
    const n = profits.length;
    const wr = n ? (xs.filter((x) => x.hit).length / n) * 100 : 0;
    const roi = n ? (profits.reduce((a, b) => a + b, 0) / n) * 100 : 0;
    const verdict = n >= 500 && roi > 0
      ? "PASS"
      : n < 500
      ? "FAIL_n"
      : "FAIL_roi";
    out[mkt] = { n, wrPct: +wr.toFixed(2), roiPct: +roi.toFixed(2), verdict };
  }
  return out;
}

const db = getDbFromEnv();
try {
  const rows = await db.query<Row>(
    `SELECT COALESCE(mlb_market_type, prop_type) AS mkt,
            pick_side,
            hit,
            odds,
            confidence,
            unbettable_juice_flag,
            NULL::numeric AS ev_per_unit
     FROM pick_history
     WHERE sport = 'mlb'
       AND COALESCE(is_synthetic, false) = false
       AND COALESCE(voided, false) = false
       AND hit IS NOT NULL
       AND odds IS NOT NULL`,
  );

  const afterPolicy = [];
  for (const r of rows) {
    const shown = mlbRecommendationShown(r.mkt, r.pick_side ?? "", {
      confidence: r.confidence ?? 0,
      unbettableJuiceFlag: r.unbettable_juice_flag ?? false,
      evPerUnit: r.ev_per_unit == null ? undefined : Number(r.ev_per_unit),
    });
    if (!shown) continue;
    afterPolicy.push({
      mkt: r.mkt,
      side: r.pick_side ?? "",
      hit: Boolean(r.hit),
      odds: Number(r.odds),
    });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    note:
      "Replay of graded MLB pick_history through current mlb_ev_policy (veto + side). ev_per_unit not on pick_history — EV floor not applied.",
    gradedRows: rows.length,
    afterPolicyN: afterPolicy.length,
    afterPolicy: summarize(afterPolicy),
  };

  const outPath = new URL("../out/phase1_pick_history_policy_replay.json", import.meta.url);
  await Deno.mkdir(new URL(".", outPath), { recursive: true });
  await Deno.writeTextFile(outPath, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  console.log(`[harness] Wrote ${outPath.pathname}`);
} finally {
  await closePool();
}
