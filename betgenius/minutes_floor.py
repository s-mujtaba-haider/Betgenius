import sys
f = sys.argv[1]
with open(f, 'r') as file:
    code = file.read()

anchor = "// === #113: Home/Away Splits per Prop Type ==="
assert anchor in code, "FAIL: #113 anchor not found"

new_func = """// === #126: Minutes Floor Detection (role stability) ===
function detectMinutesFloor(gameLog: GameLogEntry[]): { minMinutes: number; maxMinutes: number; spread: number; isStable: boolean; isVolatile: boolean } {
  const mins: number[] = [];
  for (const game of gameLog.slice(0, 5)) {
    if (isDNPGame(game)) continue;
    const m = game.stats["MIN"] ?? game.stats["min"] ?? game.stats["Minutes"] ?? 0;
    if (m > 0) mins.push(m);
  }
  if (mins.length < 3) return { minMinutes: 0, maxMinutes: 0, spread: 0, isStable: false, isVolatile: false };
  const minM = Math.min(...mins);
  const maxM = Math.max(...mins);
  const spread = maxM - minM;
  const isStable = minM >= 28 && spread <= 8;
  const isVolatile = spread >= 15 || minM < 15;
  return { minMinutes: Math.round(minM), maxMinutes: Math.round(maxM), spread: Math.round(spread), isStable, isVolatile };
}

"""
code = code.replace(anchor, new_func + anchor, 1)
print("1/4 detectMinutesFloor function added")

wire_anchor = "  // === #113: Home/Away Splits ===\n  const hasSplit = calculateHomeAwaySplit"
assert wire_anchor in code, "FAIL: #113 wire not found"

wire_code = """  // === #126: Minutes Floor Detection ===
  const minsFloor = detectMinutesFloor(gameLog);
  if (minsFloor.isStable) {
    console.log("[mins] " + playerData.player.displayName + " | STABLE role | min=" + minsFloor.minMinutes + " max=" + minsFloor.maxMinutes + " spread=" + minsFloor.spread);
  }
  if (minsFloor.isVolatile) {
    console.log("[mins] " + playerData.player.displayName + " | VOLATILE role | min=" + minsFloor.minMinutes + " max=" + minsFloor.maxMinutes + " spread=" + minsFloor.spread);
  }

"""
code = code.replace(wire_anchor, wire_code + wire_anchor, 1)
print("2/4 Minutes floor wired into main loop")

old_clamp = "  finalScore = Math.max(0, Math.min(100, finalScore + homeAwaySplitBonus));"
new_clamp = """  finalScore += homeAwaySplitBonus;

  // === #126: MINUTES FLOOR BONUS ===
  let minutesFloorBonus = 0;
  if (minsFloor.isStable) minutesFloorBonus = 3;
  if (minsFloor.isVolatile) minutesFloorBonus = -4;
  finalScore = Math.max(0, Math.min(100, finalScore + minutesFloorBonus));"""

assert old_clamp in code, "FAIL: homeAway clamp not found"
code = code.replace(old_clamp, new_clamp, 1)
print("3/4 Minutes floor bonus added (+3 stable / -4 volatile)")

old_bd = "    breakdown: { ...confidenceResult.breakdown, zScoreBonus, consistencyBonus, roleChangeBonus, vigFilterPenalty, usgBonus, usgRate, regressionBonus, marketConfBonus, homeAwaySplitBonus, projectedStat, zScore: zScore, statStdDev },"
new_bd = "    breakdown: { ...confidenceResult.breakdown, zScoreBonus, consistencyBonus, roleChangeBonus, vigFilterPenalty, usgBonus, usgRate, regressionBonus, marketConfBonus, homeAwaySplitBonus, minutesFloorBonus, projectedStat, zScore: zScore, statStdDev },"
assert old_bd in code, "FAIL: breakdown not found"
code = code.replace(old_bd, new_bd, 1)
print("4/4 minutesFloorBonus stored in breakdown")

with open(f, 'w') as file:
    file.write(code)
print("\n#126 DONE — Minutes Floor Detection")
