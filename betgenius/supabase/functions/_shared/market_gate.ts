/**
 * MLB Dynamic ML Policy Engine - Market Gate
 * Pure function that acts as an emergency stop for broken markets.
 */

export interface MarketGateMetrics {
  roiLowerBound: number;
  sampleSize: number;
  brierScore: number;
  baselineBrierScore: number;
  avgClv: number;
  gradingCompleteness: number; // 0.0 to 1.0
}

export interface MarketGateResult {
  pass: boolean;
  reasons: string[];
}

const MIN_SAMPLE_SIZE = 100;
const MIN_GRADING_COMPLETENESS = 0.98;

export function evaluateMarketGate(metrics: MarketGateMetrics): MarketGateResult {
  const reasons: string[] = [];

  if (metrics.roiLowerBound <= 0) {
    reasons.push(`roi_lower_bound_negative: ${metrics.roiLowerBound.toFixed(4)}`);
  }

  if (metrics.sampleSize < MIN_SAMPLE_SIZE) {
    reasons.push(`insufficient_sample_size: ${metrics.sampleSize} < ${MIN_SAMPLE_SIZE}`);
  }

  // Brier score should be lower than baseline (lower is better)
  if (metrics.brierScore >= metrics.baselineBrierScore) {
    reasons.push(`brier_score_underperforms_baseline: ${metrics.brierScore.toFixed(4)} >= ${metrics.baselineBrierScore.toFixed(4)}`);
  }

  if (metrics.avgClv <= 0) {
    reasons.push(`negative_avg_clv: ${metrics.avgClv.toFixed(4)}`);
  }

  if (metrics.gradingCompleteness < MIN_GRADING_COMPLETENESS) {
    reasons.push(`poor_grading_completeness: ${(metrics.gradingCompleteness * 100).toFixed(1)}% < ${(MIN_GRADING_COMPLETENESS * 100).toFixed(1)}%`);
  }

  return {
    pass: reasons.length === 0,
    reasons
  };
}
