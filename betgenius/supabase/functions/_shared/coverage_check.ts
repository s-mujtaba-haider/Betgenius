export interface CoverageCheckResult {
  sufficientData: boolean;
  sampleSize: number;
  gradingCompleteness: number; // 0.0 to 1.0
  skewFlags: string[];
}

export interface PickHistoryMetrics {
  totalPicks: number;
  gradedPicks: number;
  wins: number;
  losses: number;
  pushes: number;
}

const MIN_SAMPLE_SIZE = 100;
const MIN_GRADING_COMPLETENESS = 0.98;

export function evaluateCoverage(marketId: string, metrics: PickHistoryMetrics): CoverageCheckResult {
  const sampleSize = metrics.gradedPicks;
  
  // Calculate grading completeness. If totalPicks is 0, completeness is technically 100% 
  // but it will fail the sample size check anyway.
  const gradingCompleteness = metrics.totalPicks > 0 
    ? metrics.gradedPicks / metrics.totalPicks 
    : 1.0;
    
  const sufficientData = sampleSize >= MIN_SAMPLE_SIZE && gradingCompleteness >= MIN_GRADING_COMPLETENESS;
  
  const skewFlags: string[] = [];
  
  // Basic skew checks if we have any data
  if (sampleSize > 0) {
    const winRate = metrics.wins / sampleSize;
    if (winRate > 0.85) {
      skewFlags.push("abnormally_high_win_rate");
    } else if (winRate < 0.15) {
      skewFlags.push("abnormally_low_win_rate");
    }
  }

  return {
    sufficientData,
    sampleSize,
    gradingCompleteness,
    skewFlags
  };
}
