// D-534 — Verify per-market weight plumbing:
//   1. With empty overrides, every market resolves to the global weight
//      set byte-identically (no scoring drift on day-one deploy).
//   2. An override on ONE market doesn't leak to any other market
//      (the isolation guarantee that lets the optimizer target one
//      prop at a time without disturbing others).
import { describe, expect, it } from "vitest";
import { applyOverrides } from "../supabase/functions/_shared/mlb_weights.ts";
import {
  getMlbDefaultWeights,
  setMlbWeightsWithPerMarket,
  setActiveMarket,
  _getActiveWeightsForTest,
  type MlbScoringWeights,
} from "../supabase/functions/_shared/scoring_mlb_v2.ts";

const KNOWN_MARKETS = [
  "batter_hits", "batter_hr", "batter_total_bases", "batter_rbis",
  "batter_strikeouts", "batter_runs_scored",
  "pitcher_k", "pitcher_outs",
  "game_side", "game_total",
] as const;

function deepEqualWeights(a: MlbScoringWeights, b: MlbScoringWeights): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

describe("D-534 — per-market weight plumbing", () => {
  it("applyOverrides with EMPTY overrides yields identical weights for every market (byte-identical day-one)", () => {
    const global = getMlbDefaultWeights();
    const perMarket = applyOverrides(global, {});
    for (const market of KNOWN_MARKETS) {
      expect(perMarket[market]).toBeDefined();
      // Use JSON deep-equal as a byte-identical check
      expect(JSON.stringify(perMarket[market])).toBe(JSON.stringify(global));
    }
  });

  it("applyOverrides with overrides on ONE market does NOT leak to other markets (isolation)", () => {
    const global = getMlbDefaultWeights();
    const overrides = {
      batter_hits: {
        // D-533 R4 doubled-flip recommendation candidate for batter_hits
        w_mlb_batter_handedness_matchup: -1.5,   // 2x post-D-520 magnitude
        w_mlb_batter_weather_temp: -2.5,
      },
    };
    const perMarket = applyOverrides(global, overrides);

    // batter_hits has the override applied
    expect(perMarket.batter_hits.W_BATTER.handednessMatchup).toBe(-1.5);
    expect(perMarket.batter_hits.W_BATTER.weatherTemp).toBe(-2.5);

    // Every OTHER market still has the global values (the isolation
    // guarantee — D-533 found per-market tuning impossible because
    // weights were global; D-534 closes that).
    for (const market of KNOWN_MARKETS) {
      if (market === "batter_hits") continue;
      expect(perMarket[market].W_BATTER.handednessMatchup).toBe(global.W_BATTER.handednessMatchup);
      expect(perMarket[market].W_BATTER.weatherTemp).toBe(global.W_BATTER.weatherTemp);
    }
  });

  it("applyOverrides silently skips unknown weight columns (forward-compat)", () => {
    const global = getMlbDefaultWeights();
    const overrides = {
      batter_hits: {
        w_mlb_batter_handedness_matchup: -1.5,           // known
        w_mlb_batter_NONEXISTENT_FUTURE_WEIGHT: -999,    // unknown — skip
      },
    };
    const perMarket = applyOverrides(global, overrides);
    expect(perMarket.batter_hits.W_BATTER.handednessMatchup).toBe(-1.5);
    // No crash; no spurious changes to the rest of W_BATTER.
    expect(perMarket.batter_hits.W_BATTER.hitRate).toBe(global.W_BATTER.hitRate);
  });

  it("applyOverrides silently skips non-numeric override values (defense)", () => {
    const global = getMlbDefaultWeights();
    const overrides = {
      batter_hits: {
        w_mlb_batter_handedness_matchup: "bad string" as unknown as number,
        w_mlb_batter_weather_temp: NaN,
        w_mlb_batter_form: 1.5,
      },
    };
    const perMarket = applyOverrides(global, overrides);
    // String and NaN ignored; valid override applied.
    expect(perMarket.batter_hits.W_BATTER.handednessMatchup).toBe(global.W_BATTER.handednessMatchup);
    expect(perMarket.batter_hits.W_BATTER.weatherTemp).toBe(global.W_BATTER.weatherTemp);
    expect(perMarket.batter_hits.W_BATTER.form).toBe(1.5);
  });

  it("setActiveMarket(any) with empty overrides == setMlbWeights(global) byte-identical (day-one)", () => {
    const global = getMlbDefaultWeights();
    const perMarket = applyOverrides(global, {});
    setMlbWeightsWithPerMarket(global, perMarket);

    // Activate each market in turn; each should yield byte-identical
    // module-scope weights to the global set.
    for (const market of KNOWN_MARKETS) {
      setActiveMarket(market);
      const active = _getActiveWeightsForTest();
      expect(deepEqualWeights(active, global)).toBe(true);
    }
  });

  it("setActiveMarket(market) swap is isolated — switching markets only changes the overridden values", () => {
    const global = getMlbDefaultWeights();
    const overrides = {
      batter_hits: {
        w_mlb_batter_handedness_matchup: -1.5,
        w_mlb_batter_weather_temp: -2.5,
      },
    };
    const perMarket = applyOverrides(global, overrides);
    setMlbWeightsWithPerMarket(global, perMarket);

    // Activate batter_hits → see overrides
    setActiveMarket("batter_hits");
    const batterHits = _getActiveWeightsForTest();
    expect(batterHits.W_BATTER.handednessMatchup).toBe(-1.5);
    expect(batterHits.W_BATTER.weatherTemp).toBe(-2.5);

    // Activate batter_total_bases → see global (no override)
    setActiveMarket("batter_total_bases");
    const batterTB = _getActiveWeightsForTest();
    expect(batterTB.W_BATTER.handednessMatchup).toBe(global.W_BATTER.handednessMatchup);
    expect(batterTB.W_BATTER.weatherTemp).toBe(global.W_BATTER.weatherTemp);

    // Back to batter_hits → overrides re-apply (idempotent)
    setActiveMarket("batter_hits");
    const batterHits2 = _getActiveWeightsForTest();
    expect(deepEqualWeights(batterHits, batterHits2)).toBe(true);
  });

  it("setActiveMarket(unknown_market) falls back to global (forward-compat for new markets)", () => {
    const global = getMlbDefaultWeights();
    setMlbWeightsWithPerMarket(global, {});
    setActiveMarket("brand_new_market_not_yet_in_the_map");
    const active = _getActiveWeightsForTest();
    expect(deepEqualWeights(active, global)).toBe(true);
  });

  it("simulates the dispatcher pattern — back-to-back market swaps in a single cron tick", () => {
    const global = getMlbDefaultWeights();
    // Imagine CEO has applied R4-doubled overrides to batter_hits only.
    const overrides = {
      batter_hits: {
        w_mlb_batter_handedness_matchup: -1.5,
      },
    };
    const perMarket = applyOverrides(global, overrides);
    setMlbWeightsWithPerMarket(global, perMarket);

    // Simulate a slate with one pick per market type, scored in sequence.
    // Each setActiveMarket must yield the correct weight set.
    const expected: Record<string, number> = {
      batter_hits: -1.5,
      batter_total_bases: global.W_BATTER.handednessMatchup,
      batter_hr: global.W_BATTER.handednessMatchup,
      batter_rbis: global.W_BATTER.handednessMatchup,
      pitcher_k: global.W_BATTER.handednessMatchup,
      game_side: global.W_BATTER.handednessMatchup,
      game_total: global.W_BATTER.handednessMatchup,
    };
    for (const [market, expectedHandedness] of Object.entries(expected)) {
      setActiveMarket(market);
      const active = _getActiveWeightsForTest();
      expect(active.W_BATTER.handednessMatchup).toBe(expectedHandedness);
    }
  });
});
