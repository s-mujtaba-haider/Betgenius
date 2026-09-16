import { describe, it, expect } from 'vitest';
import { engineerDynamicFeatures } from '../supabase/functions/_shared/feature_engineering.ts';

describe('Feature Engineering', () => {
  it('should compute implied probability from decimal odds', () => {
    const result = engineerDynamicFeatures(2.0, 65, {weather: true, homeLineup: true, awayLineup: true, venue: true}, null);
    expect(result.impliedProbability).toBeCloseTo(0.5, 2);
  });

  it('should compute market delta correctly', () => {
    // rawConfidence = 65 => rawProb = 0.65
    // impliedProbability from odds 2.0 = 0.5
    // delta = 0.65 - 0.5 = 0.15
    const result = engineerDynamicFeatures(2.0, 65, {weather: true, homeLineup: true, awayLineup: true, venue: true}, null);
    expect(result.marketDelta).toBeCloseTo(0.15, 2);
  });

  it('should penalize missing context fields', () => {
    // 2 missing critical fields out of 4 => 1.0 - 2*0.1 = 0.8
    const result = engineerDynamicFeatures(2.0, 65, {weather: true, venue: true}, null);
    expect(result.contextCompleteness).toBe(0.8);
  });

  it('should apply heavy penalty for null context', () => {
    const result = engineerDynamicFeatures(2.0, 65, null, null);
    expect(result.contextCompleteness).toBe(0.5);
  });

  it('should dampen for high variance', () => {
    const result = engineerDynamicFeatures(2.0, 65, {weather: true, homeLineup: true, awayLineup: true, venue: true}, 25);
    expect(result.varianceDampener).toBe(0.90);
  });

  it('should not dampen for moderate variance', () => {
    const result = engineerDynamicFeatures(2.0, 65, {weather: true, homeLineup: true, awayLineup: true, venue: true}, 10);
    expect(result.varianceDampener).toBe(1.0);
  });

  it('should handle zero/invalid odds gracefully', () => {
    const result = engineerDynamicFeatures(0, 65, {weather: true, homeLineup: true, awayLineup: true, venue: true}, null);
    expect(result.impliedProbability).toBe(0);
  });
});
