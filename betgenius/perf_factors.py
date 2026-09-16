import sys
f = sys.argv[1]
with open(f, 'r') as file:
    code = file.read()

# 1. Add type definitions
old_type = "  score_z_score: number | null;"
new_type = """  score_z_score: number | null;
  score_role_change: number | null;
  score_vig_filter: number | null;
  score_usg_rate: number | null;"""
assert old_type in code, "FAIL: type def not found"
code = code.replace(old_type, new_type, 1)
print("1/3 Type definitions added")

# 2. Add to scoreColumns array
old_cols = '      "usage_boost",\n    ];'
new_cols = """      "usage_boost",
      "score_role_change",
      "score_vig_filter",
      "score_usg_rate",
    ];"""
assert old_cols in code, "FAIL: scoreColumns not found"
code = code.replace(old_cols, new_cols, 1)
print("2/3 scoreColumns updated")

# 3. Add to factorNames
old_names = '      usage_boost: "Injury Usage Boost",'
new_names = """      usage_boost: "Injury Usage Boost",
      score_role_change: "Role Change",
      score_vig_filter: "Vig Filter",
      score_usg_rate: "Usage Rate (USG%)","""
assert old_names in code, "FAIL: factorNames not found"
code = code.replace(old_names, new_names, 1)
print("3/3 factorNames updated")

with open(f, 'w') as file:
    file.write(code)
print("Performance page updated — 3 new factors visible")
