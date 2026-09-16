import sys

f = sys.argv[1]
with open(f, 'r') as file:
    code = file.read()

old_type = '  score_z_score: number | null;'
new_type = '  score_z_score: number | null;\n  projected_stat: number | null;\n  stat_stdev: number | null;\n  z_score: number | null;\n  per_minute_rate: number | null;\n  projected_minutes: number | null;\n  usage_boost: number | null;'
assert old_type in code, 'FAIL: score_z_score type not found'
code = code.replace(old_type, new_type, 1)
print('1/3 Types added')

old_cols = '      "score_z_score",'
new_cols = '      "score_z_score",\n      "projected_stat",\n      "stat_stdev",\n      "z_score",\n      "per_minute_rate",\n      "projected_minutes",\n      "usage_boost",'
assert old_cols in code, 'FAIL: score_z_score in columns not found'
code = code.replace(old_cols, new_cols, 1)
print('2/3 Columns added')

old_names = 'score_z_score: "Z-Score (Projection)",'
if old_names not in code:
    old_names = 'score_z_score: "Projection Edge",'
new_names = 'score_z_score: "Projection Edge",\n      projected_stat: "Projected Stat",\n      stat_stdev: "Consistency (StdDev)",\n      z_score: "Edge vs Line",\n      per_minute_rate: "Per-Minute Production",\n      projected_minutes: "Projected Minutes",\n      usage_boost: "Injury Usage Boost",'
assert old_names in code, 'FAIL: name not found'
code = code.replace(old_names, new_names, 1)
print('3/3 Factor names added')

with open(f, 'w') as file:
    file.write(code)
print('Done - 7 projection factors added to Performance page')
