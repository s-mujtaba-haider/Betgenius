/**
 * MLB Dynamic ML Policy Engine - Feature Engineering Module
 * Calculates dynamic features to bridge raw inputs and the scoring algorithms.
 */

export interface EngineeredFeatures {
  impliedProbability: number;
  marketDelta: number; // Delta between model raw confidence and implied probability
  contextCompleteness: number; // Penalty score for missing data density (0.0 to 1.0)
  varianceDampener: number; // Dampener based on historical variance
}

export function engineerDynamicFeatures(
  decimalOdds: number,
  rawConfidence: number,
  context: any,
  varianceRaw: number | null
): EngineeredFeatures {
  // 1. Implied Probability
  let impliedProbability = 0;
  if (decimalOdds && decimalOdds > 1.0) {
    impliedProbability = 1.0 / decimalOdds;
  }

  // 2. Market Delta
  // Using rawConfidence (0-100) converted to probability (0-1.0)
  const rawProb = rawConfidence / 100.0;
  const marketDelta = rawProb - impliedProbability;

  // 3. Context Completeness
  let completeness = 1.0;
  if (context) {
    let missingFields = 0;
    const criticalFields = ['weather', 'homeLineup', 'awayLineup', 'venue'];
    for (const field of criticalFields) {
      if (!context[field]) {
        missingFields++;
      }
    }
    // Penalize 0.1 for every missing critical field (min 0.6)
    completeness = Math.max(0.6, 1.0 - (missingFields * 0.1));
  } else {
    completeness = 0.5; // Heavy penalty if entire context is missing
  }

  // 4. Variance Dampener
  // High variance (unpredictable markets) dampens the win rate.
  // Standard deviations typically range 0-30 in 0-100 scale.
  let varianceDampener = 1.0;
  if (varianceRaw !== null && varianceRaw !== undefined) {
    if (varianceRaw > 20) {
      varianceDampener = 0.90;
    } else if (varianceRaw > 15) {
      varianceDampener = 0.95;
    }
  }

  return {
    impliedProbability,
    marketDelta,
    contextCompleteness: completeness,
    varianceDampener,
  };
}
