import sys
f = sys.argv[1]
with open(f, 'r') as file:
    code = file.read()

anchor = "// === #122: Usage Rate (USG%)"
assert anchor in code, "FAIL: #122 anchor not found"

new_func = """// === #117: Regression to Mean Detection ===
function detectRegression(recentAvg: number, seasonAvg: number, line: number, pickSide: "over" | "under"): { signal: "buy_low" | "sell_high" | "none"; pctDiff: number } {
  if (seasonAvg === 0) return { signal: "none", pctDiff: 0 };
  const pctDiff = ((recentAvg - seasonAvg) / seasonAvg) * 100;
  // Buy low: L5 is 20%+ below season avg AND we're picking over — regression UP expected
  if (pctDiff <= -20 && pickSide === "over") return { signal: "buy_low", pctDiff: Math.round(pctDiff) };
  // Sell high: L5 is 20%+ above season avg AND we're picking over — regression DOWN expected, risky
  if (pctDiff >= 20 && pickSide === "over") return { signal: "sell_high", pctDiff: Math.round(pctDiff) };
  return { signal: "none", pctDiff: Math.round(pctDiff) };
}

"""
code = code.replace(anchor, new_func + anchor, 1)
print("1/4 detectRegression function added")

# Wire after USG rate, before confidenceResult
wire_anchor = "  // === #122: Usage Rate ===\n  const usgRate = calculateUSGRate(gameLog);"
assert wire_anchor in code, "FAIL: USG wire not found"

wire_code = """  // === #117: Regression to Mean ===
  const regression = detectRegression(recentAvg, seasonAvg, prop.line, "over");
  if (regression.signal !== "none") {
    console.log("[regr] " + playerData.player.displayName + " | " + regression.signal.toUpperCase() + " | L5 vs Season: " + regression.pctDiff + "%");
  }

"""
code = code.replace(wire_anchor, wire_code + wire_anchor, 1)
print("2/4 Regression wired into main loop")

# Add bonus after USG bonus
old_usg_clamp = "  finalScore = Math.max(0, Math.min(100, finalScore + usgBonus));"
new_usg_clamp = """  finalScore += usgBonus;

  // === #117: REGRESSION TO MEAN BONUS ===
  let regressionBonus = 0;
  if (regression.signal === "buy_low") regressionBonus = 4;     // Cold streak = bounce back expected
  else if (regression.signal === "sell_high") regressionBonus = -4; // Hot streak = regression down likely
  finalScore = Math.max(0, Math.min(100, finalScore + regressionBonus));"""

assert old_usg_clamp in code, "FAIL: USG clamp not found"
code = code.replace(old_usg_clamp, new_usg_clamp, 1)
print("3/4 Regression bonus added (+4 buy low / -4 sell high)")

old_bd = "    breakdown: { ...confidenceResult.breakdown, zScoreBonus, consistencyBonus, roleChangeBonus, vigFilterPenalty, usgBonus, usgRate, projectedStat, zScore: zScore, statStdDev },"
new_bd = "    breakdown: { ...confidenceResult.breakdown, zScoreBonus, consistencyBonus, roleChangeBonus, vigFilterPenalty, usgBonus, usgRate, regressionBonus, projectedStat, zScore: zScore, statStdDev },"
assert old_bd in code, "FAIL: breakdown not found"
code = code.replace(old_bd, new_bd, 1)
print("4/4 regressionBonus stored in breakdown")

with open(f, 'w') as file:
    file.write(code)
print("\n#117 DONE — Regression to Mean")
