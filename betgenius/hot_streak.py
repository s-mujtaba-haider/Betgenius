import sys
f = sys.argv[1]
with open(f, 'r') as file:
    code = file.read()

anchor = "// === #117: Regression to Mean Detection ==="
assert anchor in code, "FAIL: #117 anchor not found"

new_func = """// === #123: Hot Streak Anti-Signal (market confirmation) ===
function detectMarketConfirmation(l5HitRate: number, l10HitRate: number): { isOverpriced: boolean; isColdBuy: boolean } {
  // If L5 hit rate is 100% but L10 is only 60-70%, market likely adjusted line up already
  const isOverpriced = l5HitRate >= 100 && l10HitRate < 80;
  // If L5 hit rate is 0-20% but L10 is 50%+, market may not have dropped line yet
  const isColdBuy = l5HitRate <= 20 && l10HitRate >= 50;
  return { isOverpriced, isColdBuy };
}

"""
code = code.replace(anchor, new_func + anchor, 1)
print("1/4 detectMarketConfirmation function added")

wire_anchor = "  // === #117: Regression to Mean ===\n  const regression = detectRegression"
assert wire_anchor in code, "FAIL: regression wire not found"

wire_code = """  // === #123: Hot Streak Anti-Signal ===
  const marketConf = detectMarketConfirmation(hitRates.l5.rate, hitRates.l10.rate);
  if (marketConf.isOverpriced) {
    console.log("[mkt] " + playerData.player.displayName + " | OVERPRICED — L5 100% but L10 < 80%, line likely moved up");
  }
  if (marketConf.isColdBuy) {
    console.log("[mkt] " + playerData.player.displayName + " | COLD BUY — L5 ≤20% but L10 ≥50%, line may not have dropped");
  }

"""
code = code.replace(wire_anchor, wire_code + wire_anchor, 1)
print("2/4 Market confirmation wired into main loop")

old_reg_clamp = "  finalScore = Math.max(0, Math.min(100, finalScore + regressionBonus));"
new_reg_clamp = """  finalScore += regressionBonus;

  // === #123: HOT STREAK ANTI-SIGNAL ===
  let marketConfBonus = 0;
  if (marketConf.isOverpriced) marketConfBonus = -4;  // Line already moved, edge gone
  if (marketConf.isColdBuy) marketConfBonus = 3;      // Market slow to drop, buy the dip
  finalScore = Math.max(0, Math.min(100, finalScore + marketConfBonus));"""

assert old_reg_clamp in code, "FAIL: regression clamp not found"
code = code.replace(old_reg_clamp, new_reg_clamp, 1)
print("3/4 Market confirmation bonus added (-4 overpriced / +3 cold buy)")

old_bd = "    breakdown: { ...confidenceResult.breakdown, zScoreBonus, consistencyBonus, roleChangeBonus, vigFilterPenalty, usgBonus, usgRate, regressionBonus, projectedStat, zScore: zScore, statStdDev },"
new_bd = "    breakdown: { ...confidenceResult.breakdown, zScoreBonus, consistencyBonus, roleChangeBonus, vigFilterPenalty, usgBonus, usgRate, regressionBonus, marketConfBonus, projectedStat, zScore: zScore, statStdDev },"
assert old_bd in code, "FAIL: breakdown not found"
code = code.replace(old_bd, new_bd, 1)
print("4/4 marketConfBonus stored in breakdown")

with open(f, 'w') as file:
    file.write(code)
print("\n#123 DONE — Hot Streak Anti-Signal")
