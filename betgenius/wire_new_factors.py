import sys
f = sys.argv[1]
with open(f, 'r') as file:
    code = file.read()

old_insert = "      score_z_score: result.breakdown?.zScoreBonus ?? 0,"
new_insert = """      score_z_score: result.breakdown?.zScoreBonus ?? 0,
      score_role_change: result.breakdown?.roleChangeBonus ?? 0,
      score_vig_filter: result.breakdown?.vigFilterPenalty ?? 0,
      score_usg_rate: result.breakdown?.usgBonus ?? 0,"""

assert old_insert in code, "FAIL: score_z_score insert not found"
code = code.replace(old_insert, new_insert, 1)
print("1/1 New factor columns wired into pick_history INSERT")

with open(f, 'w') as file:
    file.write(code)
print("Backend logging done — 3 new score columns will be saved")
