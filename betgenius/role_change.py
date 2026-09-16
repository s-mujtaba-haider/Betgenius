import sys
f = sys.argv[1]
with open(f, 'r') as file:
    code = file.read()

# 1. Add detectRoleChange function after calculateUsageBoost
anchor = "function calculateConfidenceScore(input: {"
assert anchor in code, "FAIL: calculateConfidenceScore not found"

new_func = """// === #119: Role Change Detection (bench→starter / starter→bench) ===
function detectRoleChange(gameLog: GameLogEntry[]): { detected: boolean; direction: "promotion" | "demotion" | "none"; l3Avg: number; l10Avg: number; pctChange: number } {
  const validMins: number[] = [];
  for (const game of gameLog.slice(0, 10)) {
    if (isDNPGame(game)) continue;
    const mins = game.stats["MIN"] ?? game.stats["min"] ?? game.stats["Minutes"] ?? 0;
    if (mins > 0) validMins.push(mins);
  }
  if (validMins.length < 5) return { detected: false, direction: "none", l3Avg: 0, l10Avg: 0, pctChange: 0 };
  const l3 = validMins.slice(0, 3);
  const l10 = validMins;
  const l3Avg = l3.reduce((a, b) => a + b, 0) / l3.length;
  const l10Avg = l10.reduce((a, b) => a + b, 0) / l10.length;
  if (l10Avg === 0) return { detected: false, direction: "none", l3Avg, l10Avg, pctChange: 0 };
  const pctChange = ((l3Avg - l10Avg) / l10Avg) * 100;
  if (pctChange >= 30) return { detected: true, direction: "promotion", l3Avg: Math.round(l3Avg * 10) / 10, l10Avg: Math.round(l10Avg * 10) / 10, pctChange: Math.round(pctChange) };
  if (pctChange <= -30) return { detected: true, direction: "demotion", l3Avg: Math.round(l3Avg * 10) / 10, l10Avg: Math.round(l10Avg * 10) / 10, pctChange: Math.round(pctChange) };
  return { detected: false, direction: "none", l3Avg: Math.round(l3Avg * 10) / 10, l10Avg: Math.round(l10Avg * 10) / 10, pctChange: Math.round(pctChange) };
}

"""

code = code.replace(anchor, new_func + anchor, 1)
print("1/4 detectRoleChange function added")

# 2. Wire into main loop — after projection engine, before confidenceResult
wire_anchor = "  const confidenceResult = calculateConfidenceScore({"
assert wire_anchor in code, "FAIL: confidenceResult call not found"

wire_code = """  // === #119: Role Change Detection ===
  const roleChange = detectRoleChange(gameLog);
  if (roleChange.detected) {
    console.log("[role] " + playerData.player.displayName + " | " + roleChange.direction.toUpperCase() + " | L3=" + roleChange.l3Avg + "min vs L10=" + roleChange.l10Avg + "min (" + (roleChange.pctChange > 0 ? "+" : "") + roleChange.pctChange + "%)");
  }

"""

code = code.replace(wire_anchor, wire_code + wire_anchor, 1)
print("2/4 Role change detection wired into main loop")

# 3. Add role change bonus after consistency bonus, before finalScore clamp
old_clamp = "  finalScore = Math.max(0, Math.min(100, finalScore + consistencyBonus));"
new_clamp = """  finalScore += consistencyBonus;

  // === #119: ROLE CHANGE BONUS/PENALTY ===
  let roleChangeBonus = 0;
  if (roleChange.detected) {
    if (roleChange.direction === "promotion") roleChangeBonus = 5;
    else if (roleChange.direction === "demotion") roleChangeBonus = -6;
  }
  finalScore = Math.max(0, Math.min(100, finalScore + roleChangeBonus));"""

assert old_clamp in code, "FAIL: consistency clamp not found"
code = code.replace(old_clamp, new_clamp, 1)
print("3/4 Role change bonus/penalty added (+5 promo / -6 demotion)")

# 4. Add to breakdown and projectionData
old_breakdown = "    breakdown: { ...confidenceResult.breakdown, zScoreBonus, consistencyBonus, projectedStat, zScore: zScore, statStdDev },"
new_breakdown = "    breakdown: { ...confidenceResult.breakdown, zScoreBonus, consistencyBonus, roleChangeBonus, projectedStat, zScore: zScore, statStdDev },"
assert old_breakdown in code, "FAIL: breakdown not found"
code = code.replace(old_breakdown, new_breakdown, 1)
print("4/4 roleChangeBonus stored in breakdown")

with open(f, 'w') as file:
    file.write(code)
print("\n#119 DONE — Role Change Detection deployed")
print("  Promotion (L3 mins +30% vs L10): +5 confidence")
print("  Demotion (L3 mins -30% vs L10): -6 confidence")
print("  Logs: [role] PlayerName | PROMOTION | L3=32.5min vs L10=24.1min (+35%)")
