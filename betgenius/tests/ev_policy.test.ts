import { describe, it, expect, vi, beforeEach } from 'vitest';

// We need to mock the imports that mlb_ev_policy uses (Deno-specific modules)
// Since we're running in Node/Vitest, we mock the modules.
vi.mock('../supabase/functions/_shared/notify.ts', () => ({
  notify: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../supabase/functions/_shared/market_gate.ts', () => ({
  evaluateMarketGate: (metrics: any) => {
    const reasons: string[] = [];
    if (metrics.roiLowerBound <= 0) reasons.push('roi_lower_bound_negative');
    if (metrics.sampleSize < 100) reasons.push('insufficient_sample_size');
    if (metrics.brierScore >= metrics.baselineBrierScore) reasons.push('brier_score_underperforms_baseline');
    if (metrics.avgClv <= 0) reasons.push('negative_avg_clv');
    if (metrics.gradingCompleteness < 0.98) reasons.push('poor_grading_completeness');
    return { pass: reasons.length === 0, reasons };
  },
}));

// Now import the function under test
import { mlbRecommendationShown } from '../supabase/functions/_shared/mlb_ev_policy.ts';

const goodMetrics = {
  roiLowerBound: 0.05,
  sampleSize: 150,
  brierScore: 0.20,
  baselineBrierScore: 0.25,
  avgClv: 0.03,
  gradingCompleteness: 0.99,
};

describe('MLB EV Policy', () => {
  it('should return false when oddsUpdatedAt is null', () => {
    const result = mlbRecommendationShown('batter_hits', 'over', 0.60, 2.0, null, goodMetrics);
    expect(result).toBe(false);
  });

  it('should return false when odds are stale (>10 minutes old)', () => {
    const staleTime = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const result = mlbRecommendationShown('batter_hits', 'over', 0.60, 2.0, staleTime, goodMetrics);
    expect(result).toBe(false);
  });

  it('should return false when marketGateMetrics is null', () => {
    const freshTime = new Date().toISOString();
    const result = mlbRecommendationShown('batter_hits', 'over', 0.60, 2.0, freshTime, null);
    expect(result).toBe(false);
  });

  it('should return false when market gate fails', () => {
    const freshTime = new Date().toISOString();
    const badMetrics = { ...goodMetrics, roiLowerBound: -0.01 };
    const result = mlbRecommendationShown('batter_hits', 'over', 0.60, 2.0, freshTime, badMetrics);
    expect(result).toBe(false);
  });

  it('should return true when EV is positive and gate passes', () => {
    const freshTime = new Date().toISOString();
    // winRate = 0.60, decimalOdds = 2.0 => EV = 0.60 * 2.0 - 1.0 = 0.20 > 0.005
    const result = mlbRecommendationShown('batter_hits', 'over', 0.60, 2.0, freshTime, goodMetrics);
    expect(result).toBe(true);
  });

  it('should return false when EV is slightly negative', () => {
    const freshTime = new Date().toISOString();
    // winRate = 0.40, decimalOdds = 2.0 => EV = 0.40 * 2.0 - 1.0 = -0.20 < 0.005
    const result = mlbRecommendationShown('batter_hits', 'over', 0.40, 2.0, freshTime, goodMetrics);
    expect(result).toBe(false);
  });

  it('should return false when EV is barely below margin', () => {
    const freshTime = new Date().toISOString();
    // winRate = 0.5025, decimalOdds = 2.0 => EV = 0.5025 * 2.0 - 1.0 = 0.005 (exactly at margin, not above)
    const result = mlbRecommendationShown('batter_hits', 'over', 0.5025, 2.0, freshTime, goodMetrics);
    expect(result).toBe(false);
  });
});
