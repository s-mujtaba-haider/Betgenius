import sys

f = sys.argv[1]
with open(f, 'r') as file:
    code = file.read()

# STEP 1: Add helper functions before calculateConfidenceScore
anchor = 'function calculateConfidenceScore(input: {'
assert anchor in code, 'FAIL: calculateConfidenceScore not found'

new_functions = '''
// === #105: Standard Deviation from game values ===
function calculateStdDev(values: number[]): number {
  if (values.length < 3) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + Math.pow(v - mean, 2), 0) / values.length;
  return Math.round(Math.sqrt(variance) * 100) / 100;
}

// === #108: Per-minute production rate from game log ===
function calculatePerMinuteRate(gameLog: GameLogEntry[], propType: string): number {
  let totalStat = 0, totalMinutes = 0;
  for (const game of gameLog.slice(0, 10)) {
    if (isDNPGame(game)) continue;
    const mins = game.stats["MIN"] ?? game.stats["min"] ?? game.stats["Minutes"] ?? 0;
    const stat = getStatValue(game.stats, propType);
    if (mins > 0 && stat !== null) {
      totalStat += stat;
      totalMinutes += mins;
    }
  }
  return totalMinutes > 0 ? Math.round((totalStat / totalMinutes) * 1000) / 1000 : 0;
}

// === #109: Projected minutes (recency-weighted, B2B adjusted) ===
function projectMinutes(gameLog: GameLogEntry[], isB2B: boolean): number {
  const minutesValues: number[] = [];
  for (const game of gameLog.slice(0, 10)) {
    if (isDNPGame(game)) continue;
    const mins = game.stats["MIN"] ?? game.stats["min"] ?? game.stats["Minutes"] ?? 0;
    if (mins > 0) minutesValues.push(mins);
  }
  if (!minutesValues.length) return 0;
  const l5 = minutesValues.slice(0, 5);
  const l6_10 = minutesValues.slice(5);
  const l5Avg = l5.reduce((a, b) => a + b, 0) / l5.length;
  const l6_10Avg = l6_10.length ? l6_10.reduce((a, b) => a + b, 0) / l6_10.length : l5Avg;
  let projected = (l5Avg * 2 + l6_10Avg) / 3;
  if (isB2B) projected *= 0.93;
  return Math.round(projected * 10) / 10;
}

// === #104: Compute projected stat ===
function computeProjectedStat(perMinRate: number, projectedMins: number, paceScore: number): number {
  const paceFactor = 1 + (paceScore * 0.01);
  return Math.round(perMinRate * projectedMins * paceFactor * 100) / 100;
}

// === #106: Z-score (projected stat vs line / stdev) ===
function calculateZScore(projected: number, line: number, stdev: number, pickSide: "over" | "under"): number {
  if (stdev <= 0) return 0;
  const edge = pickSide === "over" ? projected - line : line - projected;
  return Math.round((edge / stdev) * 100) / 100;
}

// === #54/#107: Teammate injury usage boost ===
function calculateUsageBoost(teamInjuries: string[], playerMinutes: number): { boostPct: number; injuredCount: number } {
  const significantInjuries = teamInjuries.filter(inj => {
    const lower = inj.toLowerCase();
    return lower.includes("out") || lower.includes("day-to-day");
  });
  const count = significantInjuries.length;
  const isStarter = playerMinutes >= 25;
  let boostPct = 0;
  if (count >= 3) boostPct = isStarter ? 0.10 : 0.05;
  else if (count >= 2) boostPct = isStarter ? 0.06 : 0.03;
  else if (count >= 1) boostPct = isStarter ? 0.03 : 0.01;
  return { boostPct, injuredCount: count };
}

'''

code = code.replace(anchor, new_functions + anchor, 1)
print('STEP 1: 6 helper functions added')

# STEP 2: Wire into main loop
old_pace = '  const { paceScore, defenseScore } = calculatePaceDefenseScores(edgeData.oppStats, prop.propType, "over");\n\n  const confidenceResult = calculateConfidenceScore({'

new_pace = '''  const { paceScore, defenseScore } = calculatePaceDefenseScores(edgeData.oppStats, prop.propType, "over");

  // === PROJECTION ENGINE (#104-#107) ===
  const statStdDev = calculateStdDev(allValues.slice(0, 10));
  const perMinRate = calculatePerMinuteRate(gameLog, prop.propType);
  const projMins = projectMinutes(gameLog, edgeData.b2b.isBackToBack);
  const rawProjected = computeProjectedStat(perMinRate, projMins, paceScore);
  const teamInjuriesArr = edgeData.injuries?.team ?? [];
  const usageBoostResult = calculateUsageBoost(teamInjuriesArr, projMins);
  const projectedStat = Math.round(rawProjected * (1 + usageBoostResult.boostPct) * 100) / 100;
  const zScore = calculateZScore(projectedStat, prop.line, statStdDev, "over");
  if (zScore !== 0) {
    console.log("[proj] " + playerData.player.displayName + " | " + prop.propType + " O" + prop.line + " | proj=" + projectedStat.toFixed(1) + " | stdev=" + statStdDev + " | z=" + zScore + " | perMin=" + perMinRate + " | mins=" + projMins + " | injuries=" + usageBoostResult.injuredCount + " boost=" + (usageBoostResult.boostPct*100).toFixed(0) + "%");
  }

  const confidenceResult = calculateConfidenceScore({'''

assert old_pace in code, 'FAIL: paceScore block not found'
code = code.replace(old_pace, new_pace, 1)
print('STEP 2: Projection engine wired into main loop')

# STEP 3: Z-score confidence adjustment
old_return = '''  return {
    playerName: player.displayName,
    team: player.team,
    propType: prop.propType.replace("player_", ""),
    line: prop.line,
    pickSide: "over",
    odds: prop.odds,
    confidence: confidenceResult.score,'''

new_return = '''  // === Z-SCORE CONFIDENCE ADJUSTMENT (#106) ===
  let finalScore = confidenceResult.score;
  let zScoreBonus = 0;
  if (zScore >= 1.5) zScoreBonus = 8;
  else if (zScore >= 1.0) zScoreBonus = 5;
  else if (zScore >= 0.5) zScoreBonus = 2;
  else if (zScore <= -1.0) zScoreBonus = -8;
  else if (zScore <= -0.5) zScoreBonus = -4;
  finalScore = Math.max(0, Math.min(100, finalScore + zScoreBonus));

  return {
    playerName: player.displayName,
    team: player.team,
    propType: prop.propType.replace("player_", ""),
    line: prop.line,
    pickSide: "over",
    odds: prop.odds,
    confidence: finalScore,'''

assert old_return in code, 'FAIL: return block not found'
code = code.replace(old_return, new_return, 1)
print('STEP 3: Z-score confidence adjustment added')

# STEP 4: Add projectionData to result object
old_result_obj = '''    breakdown: confidenceResult.breakdown,
    absenceInfo,
  };
}'''

new_result_obj = '''    breakdown: { ...confidenceResult.breakdown, zScoreBonus, projectedStat, zScore: zScore, statStdDev },
    absenceInfo,
    projectionData: { projectedStat, statStdDev, zScore, perMinRate, projectedMinutes: projMins, teammateInjuriesCount: usageBoostResult.injuredCount, usageBoost: usageBoostResult.boostPct },
  };
}'''

assert old_result_obj in code, 'FAIL: result object not found'
code = code.replace(old_result_obj, new_result_obj, 1)
print('STEP 4: Projection data added to result')

# STEP 5: Log to pick_history
old_log = '      score_odds_value: result.breakdown?.oddsValue ?? 0,'
new_log = '      score_odds_value: result.breakdown?.oddsValue ?? 0,\n      projected_stat: (result as any).projectionData?.projectedStat ?? null,\n      stat_stdev: (result as any).projectionData?.statStdDev ?? null,\n      z_score: (result as any).projectionData?.zScore ?? null,\n      per_minute_rate: (result as any).projectionData?.perMinRate ?? null,\n      projected_minutes: (result as any).projectionData?.projectedMinutes ?? null,\n      teammate_injuries_count: (result as any).projectionData?.teammateInjuriesCount ?? null,\n      usage_boost: (result as any).projectionData?.usageBoost ?? null,'

assert old_log in code, 'FAIL: score_odds_value not found'
code = code.replace(old_log, new_log, 1)
print('STEP 5: Projection data logged to pick_history')

with open(f, 'w') as file:
    file.write(code)

print('')
print('ALL DONE:')
print('  #105 - calculateStdDev()')
print('  #108 - calculatePerMinuteRate()')
print('  #109 - projectMinutes()')
print('  #104 - computeProjectedStat()')
print('  #106 - calculateZScore() + confidence adjustment')
print('  #54/#107 - calculateUsageBoost()')
