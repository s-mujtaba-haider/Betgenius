// @ts-nocheck
declare const Deno: any;
import { assert, assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { getCalibratedMarketWinRate } from "../supabase/functions/_shared/dynamic_scoring_wrapper.ts";
import { mlbRecommendationShown } from "../supabase/functions/_shared/mlb_ev_policy.ts";
import { engineerDynamicFeatures } from "../supabase/functions/_shared/feature_engineering.ts";

// Synthetic Mocks (The Golden Path)
const mockMarketGateMetrics = {
  roiLowerBound: 0.05,
  sampleSize: 1000,
  brierScore: 0.20,
  baselineBrierScore: 0.25,
  avgClv: 0.02,
  gradingCompleteness: 0.99
};

const mockScoringContext = {
  weather: "Sunny",
  homeLineup: ["player1"],
  awayLineup: ["player2"],
  venue: "stadium",
};

const market = "batter_hits";
const pickSide = "over";
const rawConfidence = 75; // This gives baseProbability = 0.65
const varianceRaw = 1.2; // This doesn't penalize unless > 15

// ---------------------------------------------------------
// LEVEL 1: THE CORE PIPELINE
// ---------------------------------------------------------

Deno.test("Trace 1: The Happy Path (+EV, Fresh Odds, Full Data)", () => {
  const oddsUpdatedAt = new Date().toISOString();
  const decimalOdds = 2.0; // Implied probability 0.50

  const winRate = getCalibratedMarketWinRate(market, rawConfidence, decimalOdds, mockScoringContext, varianceRaw);
  assert(winRate > 0.0 && winRate < 1.0, "Win rate should be a valid probability between 0 and 1");
  
  const recommendation = mlbRecommendationShown(market, pickSide, winRate, decimalOdds, oddsUpdatedAt, mockMarketGateMetrics);
  assertEquals(recommendation, true, "Should return true for +EV and fresh odds");
});

Deno.test("Trace 2: The Stale Odds Fail-Safe (Latent Line)", () => {
  const staleDate = new Date(Date.now() - 15 * 60 * 1000); // 15 mins ago
  const oddsUpdatedAt = staleDate.toISOString();
  const decimalOdds = 2.0;

  const winRate = getCalibratedMarketWinRate(market, rawConfidence, decimalOdds, mockScoringContext, varianceRaw);
  const recommendation = mlbRecommendationShown(market, pickSide, winRate, decimalOdds, oddsUpdatedAt, mockMarketGateMetrics);
  
  assertEquals(recommendation, false, "Should return false for stale odds despite +EV");
});

Deno.test("Trace 3: The Negative EV Fail-Safe", () => {
  const oddsUpdatedAt = new Date().toISOString();
  const decimalOdds = 1.10; // Implied ~91%, mathematically negative EV for a 65% win rate

  const winRate = getCalibratedMarketWinRate(market, rawConfidence, decimalOdds, mockScoringContext, varianceRaw);
  const recommendation = mlbRecommendationShown(market, pickSide, winRate, decimalOdds, oddsUpdatedAt, mockMarketGateMetrics);
  
  assertEquals(recommendation, false, "Should return false for negative EV");
});

// ---------------------------------------------------------
// LEVEL 2: BRUTAL EDGE CASES & CORRUPTED PAYLOADS
// ---------------------------------------------------------

Deno.test("Trace 4: The Data Blackout Penalty (Zero Context)", () => {
  const oddsUpdatedAt = new Date().toISOString();
  const decimalOdds = 2.0;
  
  // Brutal: Pass completely null context. The engine should survive but heavily penalize confidence.
  const winRate = getCalibratedMarketWinRate(market, rawConfidence, decimalOdds, null, varianceRaw);
  
  // Base prob (0.65) * Context penalty (0.5) = 0.325.
  // EV at 2.0 odds = (0.325 * 2) - 1 = -0.35 (Negative EV)
  const recommendation = mlbRecommendationShown(market, pickSide, winRate, decimalOdds, oddsUpdatedAt, mockMarketGateMetrics);
  
  assertEquals(recommendation, false, "Should return false when missing context forces negative EV");
});

Deno.test("Trace 5: The Extreme Volatility Dampener", () => {
  const oddsUpdatedAt = new Date().toISOString();
  const decimalOdds = 1.6; // Implied ~62.5%. With base 65%, this is slightly +EV.
  
  // Brutal: Variance is through the roof (e.g. erratic player history).
  const extremeVariance = 30.5; 
  
  const winRate = getCalibratedMarketWinRate(market, rawConfidence, decimalOdds, mockScoringContext, extremeVariance);
  
  // Base prob (0.65) * Variance dampener (0.90) = 0.585.
  // EV at 1.6 odds = (0.585 * 1.6) - 1 = 0.936 - 1 = -0.064 (Negative EV)
  const recommendation = mlbRecommendationShown(market, pickSide, winRate, decimalOdds, oddsUpdatedAt, mockMarketGateMetrics);
  
  assertEquals(recommendation, false, "Should return false because extreme variance dampened the edge");
});

Deno.test("Trace 6: The Longshot Underdog (+EV)", () => {
  const oddsUpdatedAt = new Date().toISOString();
  const decimalOdds = 10.0; // Implied 10%. Massive underdog.
  const lowConfidence = 30; // Gives base probability of 0.45 (via calibration logic)
  
  const winRate = getCalibratedMarketWinRate(market, lowConfidence, decimalOdds, mockScoringContext, varianceRaw);
  const recommendation = mlbRecommendationShown(market, pickSide, winRate, decimalOdds, oddsUpdatedAt, mockMarketGateMetrics);
  
  // EV at 10.0 odds = (0.45 * 10) - 1 = 3.5 (+EV!)
  assertEquals(recommendation, true, "Should confidently back massive +EV underdogs");
});

Deno.test("Trace 7: Time-Traveler Anomalies (Future Odds / Clock Drift)", () => {
  // Brutal: Server clock drift puts the odds timestamp 5 minutes into the future.
  const futureDate = new Date(Date.now() + 5 * 60 * 1000); 
  const oddsUpdatedAt = futureDate.toISOString();
  const decimalOdds = 2.0;

  const winRate = getCalibratedMarketWinRate(market, rawConfidence, decimalOdds, mockScoringContext, varianceRaw);
  const recommendation = mlbRecommendationShown(market, pickSide, winRate, decimalOdds, oddsUpdatedAt, mockMarketGateMetrics);
  
  // The system should not crash on negative age, it should treat it as fresh.
  assertEquals(recommendation, true, "Should survive future timestamps caused by clock drift");
});

Deno.test("Trace 8: Market Gate Edge Case (Exactly 0 ROI)", () => {
  const oddsUpdatedAt = new Date().toISOString();
  const decimalOdds = 2.0;
  
  // Brutal: The ROI is exactly 0.000. 
  const boundaryGateMetrics = { ...mockMarketGateMetrics, roiLowerBound: 0 };

  const winRate = getCalibratedMarketWinRate(market, rawConfidence, decimalOdds, mockScoringContext, varianceRaw);
  const recommendation = mlbRecommendationShown(market, pickSide, winRate, decimalOdds, oddsUpdatedAt, boundaryGateMetrics);
  
  // Market Gate says roiLowerBound MUST be > 0. Exactly 0 fails.
  assertEquals(recommendation, false, "Should strictly reject markets with exactly 0 ROI boundary");
});

Deno.test("Trace 9: Mathematical EV Buffer Test", () => {
  const oddsUpdatedAt = new Date().toISOString();
  
  // Base prob = 0.65.
  // To hit EXACTLY 0.005 EV, Odds = 1.005 / 0.65 = 1.5461538
  // If odds are slightly lower (e.g. 1.54), EV = 0.001 < 0.005 buffer.
  const decimalOdds = 1.54; 

  const winRate = getCalibratedMarketWinRate(market, rawConfidence, decimalOdds, mockScoringContext, varianceRaw);
  const recommendation = mlbRecommendationShown(market, pickSide, winRate, decimalOdds, oddsUpdatedAt, mockMarketGateMetrics);
  
  assertEquals(recommendation, false, "Should reject bets that are technically +EV but fall under the 0.5% margin buffer");
});
