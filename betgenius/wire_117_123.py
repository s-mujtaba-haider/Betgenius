import sys

f1 = sys.argv[1]
with open(f1, 'r') as file:
    code = file.read()
old = "      score_usg_rate: result.breakdown?.usgBonus ?? 0,"
new = """      score_usg_rate: result.breakdown?.usgBonus ?? 0,
      score_regression: result.breakdown?.regressionBonus ?? 0,
      score_market_conf: result.breakdown?.marketConfBonus ?? 0,"""
assert old in code, "FAIL: usg insert not found"
code = code.replace(old, new, 1)
with open(f1, 'w') as file:
    file.write(code)
print("Backend: 2 new columns wired into INSERT")

f2 = sys.argv[2]
with open(f2, 'r') as file:
    code = file.read()

old_type = "  score_usg_rate: number | null;"
new_type = """  score_usg_rate: number | null;
  score_regression: number | null;
  score_market_conf: number | null;"""
assert old_type in code, "FAIL: type not found"
code = code.replace(old_type, new_type, 1)

old_cols = '      "score_usg_rate",\n    ];'
new_cols = """      "score_usg_rate",
      "score_regression",
      "score_market_conf",
    ];"""
assert old_cols in code, "FAIL: scoreColumns not found"
code = code.replace(old_cols, new_cols, 1)

old_names = '      score_usg_rate: "Usage Rate (USG%)",'
new_names = """      score_usg_rate: "Usage Rate (USG%)",
      score_regression: "Regression to Mean",
      score_market_conf: "Market Confirmation","""
assert old_names in code, "FAIL: factorNames not found"
code = code.replace(old_names, new_names, 1)

with open(f2, 'w') as file:
    file.write(code)
print("Frontend: 2 new factors on Performance page")
