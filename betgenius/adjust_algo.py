import sys
f = sys.argv[1]
with open(f, 'r') as file:
    code = file.read()
old_w = 'l5: 1.0, l10: 1.0, season: 1.5, floorCeiling: 1.3,'
new_w = 'l5: 1.2, l10: 1.0, season: 1.5, floorCeiling: 1.3,'
assert old_w in code, 'FAIL: weights block not found'
code = code.replace(old_w, new_w, 1)
print('1/3 L5 weight: 1.0x -> 1.2x')
old_return = '  finalScore = Math.max(0, Math.min(100, finalScore + zScoreBonus));'
new_return = '  finalScore += zScoreBonus;\n\n  // === CONSISTENCY BONUS/PENALTY ===\n  let consistencyBonus = 0;\n  if (statStdDev > 0) {\n    const coeffOfVariation = statStdDev / (projectedStat || 1);\n    if (coeffOfVariation <= 0.15) consistencyBonus = 4;\n    else if (coeffOfVariation <= 0.25) consistencyBonus = 2;\n    else if (coeffOfVariation >= 0.50) consistencyBonus = -5;\n    else if (coeffOfVariation >= 0.40) consistencyBonus = -3;\n  }\n  finalScore = Math.max(0, Math.min(100, finalScore + consistencyBonus));'
assert old_return in code, 'FAIL: z-score clamp not found'
code = code.replace(old_return, new_return, 1)
print('2/3 Consistency bonus/penalty added')
old_bd = '    breakdown: { ...confidenceResult.breakdown, zScoreBonus, projectedStat, zScore: zScore, statStdDev },'
new_bd = '    breakdown: { ...confidenceResult.breakdown, zScoreBonus, consistencyBonus, projectedStat, zScore: zScore, statStdDev },'
assert old_bd in code, 'FAIL: breakdown not found'
code = code.replace(old_bd, new_bd, 1)
print('3/3 Consistency stored in breakdown')
with open(f, 'w') as file:
    file.write(code)
print('Done - L5 bumped + consistency factor added')
