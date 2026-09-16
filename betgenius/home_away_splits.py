import sys
f = sys.argv[1]
with open(f, 'r') as file:
    code = file.read()

anchor = "// === #123: Hot Streak Anti-Signal"
assert anchor in code, "FAIL: #123 anchor not found"

new_func = """// === #113: Home/Away Splits per Prop Type ===
function calculateHomeAwaySplit(gameLog: GameLogEntry[], propType: string, isHome: boolean): { splitAvg: number; oppSplitAvg: number; edgePct: number } {
  const homeVals: number[] = [], awayVals: number[] = [];
  for (const game of gameLog.slice(0, 20)) {
    if (isDNPGame(game)) continue;
    const stat = getStatValue(game.stats, propType);
    if (stat === null) continue;
    const gameIsHome = game.stats["homeAway"] === "home" || game.stats["HOME_AWAY"] === "HOME" || game.stats["isHome"] === true;
    if (gameIsHome) homeVals.push(stat);
    else awayVals.push(stat);
  }
  if (homeVals.length < 2 || awayVals.length < 2) return { splitAvg: 0, oppSplitAvg: 0, edgePct: 0 };
  const homeAvg = homeVals.reduce((a, b) => a + b, 0) / homeVals.length;
  const awayAvg = awayVals.reduce((a, b) => a + b, 0) / awayVals.length;
  const splitAvg = isHome ? homeAvg : awayAvg;
  const oppSplitAvg = isHome ? awayAvg : homeAvg;
  const overall = (homeAvg * homeVals.length + awayAvg * awayVals.length) / (homeVals.length + awayVals.length);
  const edgePct = overall > 0 ? ((splitAvg - overall) / overall) * 100 : 0;
  return { splitAvg: Math.round(splitAvg * 100) / 100, oppSplitAvg: Math.round(oppSplitAvg * 100) / 100, edgePct: Math.round(edgePct) };
}

"""
code = code.replace(anchor, new_func + anchor, 1)
print("1/4 calculateHomeAwaySplit function added")

wire_anchor = "  // === #123: Hot Streak Anti-Signal ===\n  const marketConf = detectMarketConfirmation"
assert wire_anchor in code, "FAIL: #123 wire not found"

wire_code = """  // === #113: Home/Away Splits ===
  const hasSplit = calculateHomeAwaySplit(gameLog, prop.propType, isHome);
  if (Math.abs(hasSplit.edgePct) >= 10) {
    console.log("[split] " + playerData.player.displayName + " | " + (isHome ? "HOME" : "AWAY") + " avg=" + hasSplit.splitAvg + " vs opposite=" + hasSplit.oppSplitAvg + " (" + (hasSplit.edgePct > 0 ? "+" : "") + hasSplit.edgePct + "%)");
  }

"""
code = code.replace(wire_anchor, wire_code + wire_anchor, 1)
print("2/4 Home/Away splits wired into main loop")

old_clamp = "  finalScore = Math.max(0, Math.min(100, finalScore + marketConfBonus));"
new_clamp = """  finalScore += marketConfBonus;

  // === #113: HOME/AWAY SPLIT BONUS ===
  let homeAwaySplitBonus = 0;
  if (Math.abs(hasSplit.edgePct) >= 15) {
    homeAwaySplitBonus = hasSplit.edgePct > 0 ? 3 : -3;
  } else if (Math.abs(hasSplit.edgePct) >= 10) {
    homeAwaySplitBonus = hasSplit.edgePct > 0 ? 2 : -2;
  }
  finalScore = Math.max(0, Math.min(100, finalScore + homeAwaySplitBonus));"""

assert old_clamp in code, "FAIL: marketConf clamp not found"
code = code.replace(old_clamp, new_clamp, 1)
print("3/4 Home/Away split bonus added")

old_bd = "    breakdown: { ...confidenceResult.breakdown, zScoreBonus, consistencyBonus, roleChangeBonus, vigFilterPenalty, usgBonus, usgRate, regressionBonus, marketConfBonus, projectedStat, zScore: zScore, statStdDev },"
new_bd = "    breakdown: { ...confidenceResult.breakdown, zScoreBonus, consistencyBonus, roleChangeBonus, vigFilterPenalty, usgBonus, usgRate, regressionBonus, marketConfBonus, homeAwaySplitBonus, projectedStat, zScore: zScore, statStdDev },"
assert old_bd in code, "FAIL: breakdown not found"
code = code.replace(old_bd, new_bd, 1)
print("4/4 homeAwaySplitBonus stored in breakdown")

with open(f, 'w') as file:
    file.write(code)
print("\n#113 DONE — Home/Away Splits")
