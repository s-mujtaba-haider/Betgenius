import sys
f = sys.argv[1]
with open(f, 'r') as file:
    code = file.read()

# Add calculateUSGRate function before detectRoleChange
anchor = "// === #119: Role Change Detection"
assert anchor in code, "FAIL: #119 anchor not found"

new_func = """// === #122: Usage Rate (USG%) from game logs ===
function calculateUSGRate(gameLog: GameLogEntry[]): number {
  let totalFGA = 0, totalFTA = 0, totalTOV = 0, totalMIN = 0;
  let gamesUsed = 0;
  for (const game of gameLog.slice(0, 10)) {
    if (isDNPGame(game)) continue;
    const mins = game.stats["MIN"] ?? game.stats["min"] ?? game.stats["Minutes"] ?? 0;
    if (mins < 5) continue;
    const fga = game.stats["FGA"] ?? game.stats["fga"] ?? 0;
    const fta = game.stats["FTA"] ?? game.stats["fta"] ?? 0;
    const tov = game.stats["TO"] ?? game.stats["to"] ?? game.stats["TOV"] ?? game.stats["tov"] ?? game.stats["Turnovers"] ?? 0;
    totalFGA += fga;
    totalFTA += fta;
    totalTOV += tov;
    totalMIN += mins;
    gamesUsed++;
  }
  if (totalMIN < 30 || gamesUsed < 3) return 0;
  // Simplified USG%: (FGA + 0.44*FTA + TOV) * 48 / (MIN * 5)
  // Approximation without team stats. ~20% is average, 30%+ is high usage star.
  const usg = ((totalFGA + 0.44 * totalFTA + totalTOV) * 48) / (totalMIN * 5);
  return Math.round(usg * 10) / 10;
}

"""

code = code.replace(anchor, new_func + anchor, 1)
print("1/4 calculateUSGRate function added")

# Wire into main loop — after roleChange, before confidenceResult
wire_anchor = "  const confidenceResult = calculateConfidenceScore({"
assert wire_anchor in code, "FAIL: confidenceResult not found"

# Check that roleChange wire is before it
wire_code = """  // === #122: Usage Rate ===
  const usgRate = calculateUSGRate(gameLog);
  if (usgRate > 0) {
    console.log("[usg] " + playerData.player.displayName + " | USG=" + usgRate + "%");
  }

"""

# Insert before the existing roleChange wire (which is before confidenceResult)
# Actually roleChange is already before confidenceResult. Insert after roleChange log.
role_end = '  const confidenceResult = calculateConfidenceScore({'
code = code.replace(role_end, wire_code + role_end, 1)
print("2/4 USG rate wired into main loop")

# Add USG bonus after vig filter, before final clamp
old_clamp = '  finalScore = Math.max(0, Math.min(100, finalScore + vigFilterPenalty));'
new_clamp = '''  finalScore += vigFilterPenalty;

  // === #122: USG RATE BONUS ===
  // High-usage players are more predictable for overs. Low-usage = fewer touches = volatile.
  let usgBonus = 0;
  if (usgRate >= 30) usgBonus = 3;        // Star usage (Luka, Jokic tier)
  else if (usgRate >= 25) usgBonus = 1;   // Above average
  else if (usgRate > 0 && usgRate < 15) usgBonus = -3;  // Very low usage, unreliable for overs
  finalScore = Math.max(0, Math.min(100, finalScore + usgBonus));'''

assert old_clamp in code, 'FAIL: vig filter clamp not found'
code = code.replace(old_clamp, new_clamp, 1)
print("3/4 USG bonus added (+3 high / -3 low usage)")

old_bd = '    breakdown: { ...confidenceResult.breakdown, zScoreBonus, consistencyBonus, roleChangeBonus, vigFilterPenalty, projectedStat, zScore: zScore, statStdDev },'
new_bd = '    breakdown: { ...confidenceResult.breakdown, zScoreBonus, consistencyBonus, roleChangeBonus, vigFilterPenalty, usgBonus, usgRate, projectedStat, zScore: zScore, statStdDev },'
assert old_bd in code, 'FAIL: breakdown not found'
code = code.replace(old_bd, new_bd, 1)
print("4/4 usgBonus + usgRate stored in breakdown")

with open(f, 'w') as file:
    file.write(code)
print("\n#122 DONE — Usage Rate (USG%)")
print("  USG >= 30%: +3 (star usage)")
print("  USG >= 25%: +1 (above avg)")  
print("  USG < 15%:  -3 (low usage, volatile)")
print("  ~20% is league average")
