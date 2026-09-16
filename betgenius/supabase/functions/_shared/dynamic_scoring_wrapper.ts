/**
 * MLB Dynamic ML Policy Engine - Dynamic Scoring Wrapper
 * Intercepts raw confidence from scoring models (treating them as black boxes),
 * applies Isotonic Regression/Platt Scaling calibration, and integrates dynamic features.
 */

import { engineerDynamicFeatures } from "./feature_engineering.ts";

/**
 * Generic inline Isotonic Regression mapping for markets without specific curves.
 * Transforms raw 0-100 confidence into a true probability (0.0 to 1.0).
 */
function applyGenericIsotonicCalibration(rawConfidence: number): number {
  if (rawConfidence < 40) return 0.35;
  if (rawConfidence < 50) return 0.45;
  if (rawConfidence < 60) return 0.52;
  if (rawConfidence < 70) return 0.58;
  if (rawConfidence < 80) return 0.65;
  return 0.70; // ceiling
}

export function getCalibratedMarketWinRate(
  market: string,
  rawConfidence: number,
  decimalOdds: number,
  context: any,
  varianceRaw: number | null
): number {
  // 1. Engineer Features
  const features = engineerDynamicFeatures(decimalOdds, rawConfidence, context, varianceRaw);
  
  // 2. Apply Calibration Mapping
  // For this Epic, we apply a generic mapping to all markets that aren't internally calibrated.
  // We can expand this with per-market logic as needed.
  let baseProbability = applyGenericIsotonicCalibration(rawConfidence);
  
  // 3. Integrate dynamic features to compute final Market Win Rate
  const finalWinRate = baseProbability * features.contextCompleteness * features.varianceDampener;
  
  return finalWinRate;
}
