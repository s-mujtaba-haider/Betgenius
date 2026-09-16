import { describe, it, expect } from 'vitest';
import { evaluateCoverage } from '../supabase/functions/_shared/coverage_check.ts';

describe('Coverage Check', () => {
  it('should pass for clean criteria', () => {
    const result = evaluateCoverage('market_1', { totalPicks: 152, gradedPicks: 150, wins: 75, losses: 75, pushes: 0 });
    expect(result.sufficientData).toBe(true);
    expect(result.skewFlags.length).toBe(0);
  });

  it('should fail for insufficient sample size', () => {
    const result = evaluateCoverage('market_2', { totalPicks: 50, gradedPicks: 50, wins: 25, losses: 25, pushes: 0 });
    expect(result.sufficientData).toBe(false);
    expect(result.sampleSize).toBe(50);
  });

  it('should fail for poor grading completeness', () => {
    const result = evaluateCoverage('market_3', { totalPicks: 150, gradedPicks: 130, wins: 65, losses: 65, pushes: 0 });
    expect(result.sufficientData).toBe(false);
    expect(result.gradingCompleteness).toBeLessThan(0.90);
  });

  it('should flag abnormally high win rate skew', () => {
    const result = evaluateCoverage('market_4', { totalPicks: 150, gradedPicks: 150, wins: 140, losses: 10, pushes: 0 });
    expect(result.skewFlags).toContain('abnormally_high_win_rate');
  });

  it('should flag abnormally low win rate skew', () => {
    const result = evaluateCoverage('market_5', { totalPicks: 150, gradedPicks: 150, wins: 10, losses: 140, pushes: 0 });
    expect(result.skewFlags).toContain('abnormally_low_win_rate');
  });
});
