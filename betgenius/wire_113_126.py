import sys

f1 = sys.argv[1]
with open(f1, 'r') as file:
    code = file.read()
old = "      score_market_conf: result.breakdown?.marketConfBonus ?? 0,"
new = """      score_market_conf: result.breakdown?.marketConfBonus ?? 0,
      score_home_away_split: result.breakdown?.homeAwaySplitBonus ?? 0,
      score_minutes_floor: result.breakdown?.minutesFloorBonus ?? 0,"""
assert old in code, "FAIL: market_conf insert not found"
code = code.replace(old, new, 1)
with open(f1, 'w') as file:
    file.write(code)
print("Backend: 2 new columns wired into INSERT")

f2 = sys.argv[2]
with open(f2, 'r') as file:
    code = file.read()

old_type = "  score_market_conf: number | null;"
new_type = """  score_market_conf: number | null;
  score_home_away_split: number | null;
  score_minutes_floor: number | null;"""
assert old_type in code, "FAIL: type not found"
code = code.replace(old_type, new_type, 1)

old_cols = '      "score_market_conf",\n    ];'
new_cols = """      "score_market_conf",
      "score_home_away_split",
      "score_minutes_floor",
    ];"""
assert old_cols in code, "FAIL: scoreColumns not found"
code = code.replace(old_cols, new_cols, 1)

old_names = '      score_market_conf: "Market Confirmation",'
new_names = """      score_market_conf: "Market Confirmation",
      score_home_away_split: "Home/Away Split",
      score_minutes_floor: "Minutes Stability","""
assert old_names in code, "FAIL: factorNames not found"
code = code.replace(old_names, new_names, 1)

with open(f2, 'w') as file:
    file.write(code)
print("Frontend: 2 new factors on Performance page")
