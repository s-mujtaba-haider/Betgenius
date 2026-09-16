export interface ConfidenceInput {
  l5HitRate: number;
  l10HitRate: number;
  seasonHitRate: number;
  line: number;
  playerFloor: number;
  playerCeiling: number;
  recentAvg: number;
  seasonAvg: number;
  isHome: boolean;
  restDays: number;
  isBackToBack: boolean;
  vsOpponentHitRate: number | null;
  odds: number;
}

export interface ConfidenceResult {
  score: number;
  breakdown: Record<string, number>;
}

export function calculateConfidenceScore(input: ConfidenceInput): ConfidenceResult {
  const breakdown: Record<string, number> = {};
  let score = 50;

  // L5 hit rate
  const l5 = input.l5HitRate >= 100 ? 15
    : input.l5HitRate >= 80 ? 12
    : input.l5HitRate >= 60 ? 5
    : input.l5HitRate >= 40 ? 0
    : input.l5HitRate >= 20 ? -8
    : -15;
  breakdown.l5HitRate = l5;
  score += l5;

  // L10 hit rate
  const l10 = input.l10HitRate >= 80 ? 10
    : input.l10HitRate >= 60 ? 5
    : input.l10HitRate >= 40 ? 0
    : -8;
  breakdown.l10HitRate = l10;
  score += l10;

  // Season hit rate
  const season = input.seasonHitRate >= 70 ? 10
    : input.seasonHitRate >= 50 ? 3
    : input.seasonHitRate >= 40 ? 0
    : -8;
  breakdown.seasonHitRate = season;
  score += season;

  // Floor analysis
  const floor = input.line < input.playerFloor ? 12
    : input.line > input.playerCeiling ? -10
    : 0;
  breakdown.floorAnalysis = floor;
  score += floor;

  // Recent form vs season
  const pctDiff = input.seasonAvg !== 0
    ? ((input.recentAvg - input.seasonAvg) / input.seasonAvg) * 100
    : 0;
  const form = pctDiff >= 15 ? 10
    : pctDiff >= 5 ? 5
    : pctDiff <= -15 ? -10
    : pctDiff <= -5 ? -5
    : 0;
  breakdown.recentForm = form;
  score += form;

  // Home/away
  const ha = input.isHome ? 3 : -2;
  breakdown.homeAway = ha;
  score += ha;

  // Rest
  const rest = input.isBackToBack ? -5 : input.restDays >= 3 ? 5 : 0;
  breakdown.rest = rest;
  score += rest;

  // vs Opponent
  if (input.vsOpponentHitRate !== null) {
    const vs = input.vsOpponentHitRate >= 75 ? 8
      : input.vsOpponentHitRate >= 50 ? 3
      : input.vsOpponentHitRate < 25 ? -8
      : 0;
    breakdown.vsOpponent = vs;
    score += vs;
  }

  // Disabled: data shows -1.19 delta, actively hurting win rate
  const oddsVal = 0;
  breakdown.oddsValue = oddsVal;

  return {
    score: Math.max(0, Math.min(100, score)),
    breakdown,
  };
}

export function getScoreLabel(score: number): string {
  // §15.10 Critical #4 recalibration (CEO May 12, 2026). Post-real-money
  // calibration revealed earlier May-7 cutoffs still overstated. Empirical
  // real WR by tier — 90+ 64%, 80-89 56%, 70-79 ~50%, 60-69 56% — earns:
  //   90+ Elite (only tier consistently above break-even-plus)
  //   80+ Strong (break-even-plus)
  //   70+ Good (fair signal, ~break-even)
  //   60+ Lean (above break-even but lower confidence — ordering preserved
  //             over 70-79 so subscribers' "higher conf = better label"
  //             intuition is honored)
  // Three sites stay in sync: this file + process-games:1271 + analyze-pick:1316.
  if (score >= 90) return "Elite Pick";
  if (score >= 80) return "Strong Pick";
  if (score >= 70) return "Good Pick";
  if (score >= 60) return "Lean";
  return "Pass";
}
