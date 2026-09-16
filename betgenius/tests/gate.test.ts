import { describe, it, expect } from 'vitest';
import { evaluateMarketGate } from '../supabase/functions/_shared/market_gate.ts';

describe('Market Gate', () => {
  it('should pass for clean criteria', () => {
    const metrics = {
      roiLowerBound: 0.05,
      sampleSize: 150,
      brierScore: 0.20,
      baselineBrierScore: 0.25,
      avgClv: 0.03,
      gradingCompleteness: 0.99
    };
    const result = evaluateMarketGate(metrics);
    expect(result.pass).toBe(true);
    expect(result.reasons.length).toBe(0);
  });

  it('should fail for negative ROI', () => {
    const metrics = {
      roiLowerBound: -0.01,
      sampleSize: 150,
      brierScore: 0.20,
      baselineBrierScore: 0.25,
      avgClv: 0.03,
      gradingCompleteness: 0.99
    };
    const result = evaluateMarketGate(metrics);
    expect(result.pass).toBe(false);
    expect(result.reasons.some(r => r.includes('roi_lower_bound_negative'))).toBe(true);
  });

  it('should fail for insufficient sample size', () => {
    const metrics = {
      roiLowerBound: 0.05,
      sampleSize: 50,
      brierScore: 0.20,
      baselineBrierScore: 0.25,
      avgClv: 0.03,
      gradingCompleteness: 0.99
    };
    const result = evaluateMarketGate(metrics);
    expect(result.pass).toBe(false);
    expect(result.reasons.some(r => r.includes('insufficient_sample_size'))).toBe(true);
  });

  it('should fail for poor brier score', () => {
    const metrics = {
      roiLowerBound: 0.05,
      sampleSize: 150,
      brierScore: 0.26,
      baselineBrierScore: 0.25,
      avgClv: 0.03,
      gradingCompleteness: 0.99
    };
    const result = evaluateMarketGate(metrics);
    expect(result.pass).toBe(false);
    expect(result.reasons.some(r => r.includes('brier_score_underperforms_baseline'))).toBe(true);
  });

  it('should fail for negative CLV', () => {
    const metrics = {
      roiLowerBound: 0.05,
      sampleSize: 150,
      brierScore: 0.20,
      baselineBrierScore: 0.25,
      avgClv: -0.01,
      gradingCompleteness: 0.99
    };
    const result = evaluateMarketGate(metrics);
    expect(result.pass).toBe(false);
    expect(result.reasons.some(r => r.includes('negative_avg_clv'))).toBe(true);
  });

  it('should fail for poor grading completeness', () => {
    const metrics = {
      roiLowerBound: 0.05,
      sampleSize: 150,
      brierScore: 0.20,
      baselineBrierScore: 0.25,
      avgClv: 0.03,
      gradingCompleteness: 0.90
    };
    const result = evaluateMarketGate(metrics);
    expect(result.pass).toBe(false);
    expect(result.reasons.some(r => r.includes('poor_grading_completeness'))).toBe(true);
  });
});
