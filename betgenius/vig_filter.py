import sys
f = sys.argv[1]
with open(f, 'r') as file:
    code = file.read()

# Add vig filter after role change bonus, before the final clamp
old_clamp = '  finalScore = Math.max(0, Math.min(100, finalScore + roleChangeBonus));'
new_clamp = '''  finalScore += roleChangeBonus;

  // === #125: MINIMUM EDGE THRESHOLD (VIG FILTER) ===
  // If projected stat is within 5% of line and z-score is weak, penalize — not enough edge to beat vig
  let vigFilterPenalty = 0;
  if (projectedStat > 0 && prop.line > 0) {
    const edgePct = Math.abs(projectedStat - prop.line) / prop.line;
    if (edgePct < 0.05 && Math.abs(zScore) < 0.5) {
      vigFilterPenalty = -6;
      console.log("[vig] " + playerData.player.displayName + " | " + prop.propType + " | proj=" + projectedStat.toFixed(1) + " vs line=" + prop.line + " | edge=" + (edgePct*100).toFixed(1) + "% | z=" + zScore + " | FILTERED -6");
    }
  }
  finalScore = Math.max(0, Math.min(100, finalScore + vigFilterPenalty));'''

assert old_clamp in code, 'FAIL: role change clamp not found'
code = code.replace(old_clamp, new_clamp, 1)
print('1/2 Vig filter penalty added')

old_bd = '    breakdown: { ...confidenceResult.breakdown, zScoreBonus, consistencyBonus, roleChangeBonus, projectedStat, zScore: zScore, statStdDev },'
new_bd = '    breakdown: { ...confidenceResult.breakdown, zScoreBonus, consistencyBonus, roleChangeBonus, vigFilterPenalty, projectedStat, zScore: zScore, statStdDev },'
assert old_bd in code, 'FAIL: breakdown not found'
code = code.replace(old_bd, new_bd, 1)
print('2/2 vigFilterPenalty stored in breakdown')

with open(f, 'w') as file:
    file.write(code)
print('\n#125 DONE — Vig Filter deployed')
print('  Edge < 5% of line AND z-score < 0.5 = -6 penalty')
print('  Example: proj 15.3 vs line 15.5 (1.3% edge, z=0.2) → FILTERED')
