import { describe, it, expect } from 'vitest';
import { getCalibratedMarketWinRate } from '../supabase/functions/_shared/dynamic_scoring_wrapper.ts';

describe('Dynamic Scoring Wrapper', () => {
  it('should return a probability between 0 and 1', () => {
    const result = getCalibratedMarketWinRate('batter_hits', 65, 2.0, {weather: true, homeLineup: true, awayLineup: true, venue: true}, null);
    expect(result).toBeGreaterThan(0);
    expect(result).toBeLessThanOrEqual(1);
  });

  it('should return lower probability for low confidence', () => {
    const high = getCalibratedMarketWinRate('batter_hits', 75, 2.0, {weather: true, homeLineup: true, awayLineup: true, venue: true}, null);
    const low = getCalibratedMarketWinRate('batter_hits', 35, 2.0, {weather: true, homeLineup: true, awayLineup: true, venue: true}, null);
    expect(high).toBeGreaterThan(low);
  });

  it('should reduce probability with high variance', () => {
    const noVariance = getCalibratedMarketWinRate('pitcher_k', 65, 2.0, {weather: true, homeLineup: true, awayLineup: true, venue: true}, null);
    const highVariance = getCalibratedMarketWinRate('pitcher_k', 65, 2.0, {weather: true, homeLineup: true, awayLineup: true, venue: true}, 25);
    expect(highVariance).toBeLessThan(noVariance);
  });

  it('should reduce probability with missing context', () => {
    const fullContext = getCalibratedMarketWinRate('batter_hits', 65, 2.0, {weather: true, homeLineup: true, awayLineup: true, venue: true}, null);
    const noContext = getCalibratedMarketWinRate('batter_hits', 65, 2.0, null, null);
    expect(noContext).toBeLessThan(fullContext);
  });

  it('should apply isotonic ceiling at 0.70 for very high confidence', () => {
    // rawConfidence = 95 => applyGenericIsotonicCalibration returns 0.70
    // With full context (1.0) and no variance (1.0) => 0.70 * 1.0 * 1.0 = 0.70
    const result = getCalibratedMarketWinRate('batter_hits', 95, 2.0, {weather: true, homeLineup: true, awayLineup: true, venue: true}, null);
    expect(result).toBeCloseTo(0.70, 2);
  });
});
