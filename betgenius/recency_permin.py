import sys
f = sys.argv[1]
with open(f, 'r') as file:
    code = file.read()

old_func = """function calculatePerMinuteRate(gameLog: GameLogEntry[], propType: string): number {
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
}"""

new_func = """// === #120: Recency-weighted per-minute rate (L5 games weighted 2x over L6-10) ===
function calculatePerMinuteRate(gameLog: GameLogEntry[], propType: string): number {
  let weightedStat = 0, weightedMinutes = 0;
  const recent = gameLog.slice(0, 10);
  for (let i = 0; i < recent.length; i++) {
    const game = recent[i];
    if (isDNPGame(game)) continue;
    const mins = game.stats["MIN"] ?? game.stats["min"] ?? game.stats["Minutes"] ?? 0;
    const stat = getStatValue(game.stats, propType);
    if (mins > 0 && stat !== null) {
      const weight = i < 5 ? 2 : 1;  // L5 = 2x weight, L6-10 = 1x
      weightedStat += stat * weight;
      weightedMinutes += mins * weight;
    }
  }
  return weightedMinutes > 0 ? Math.round((weightedStat / weightedMinutes) * 1000) / 1000 : 0;
}"""

assert old_func in code, "FAIL: calculatePerMinuteRate not found"
code = code.replace(old_func, new_func, 1)
print("#120 DONE — Per-minute rate now weights L5 games 2x over L6-10")

with open(f, 'w') as file:
    file.write(code)
