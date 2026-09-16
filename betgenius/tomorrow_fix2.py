import sys
f = sys.argv[1]
with open(f, 'r') as file:
    lines = file.readlines()

# Find the filter block by line content
start = None
end = None
for i, line in enumerate(lines):
    if '// Filter out games that have already started' in line:
        start = i
    if start is not None and 'return !hasStarted;' in line:
        end = i + 2  # include the closing });
        break

assert start is not None, "FAIL: filter comment not found"
assert end is not None, "FAIL: return !hasStarted not found"

print(f"Found filter block at lines {start+1}-{end+1}")
print("Replacing with dateOffset-aware version...")

replacement = [
    '      // Filter out games that have already started (skip for tomorrow — all future)\n',
    '      if (dateOffset === 0) {\n',
    '        events = todayEvents.filter(event => {\n',
    '          const commenceTime = new Date(event.commence_time);\n',
    '          const hasStarted = commenceTime < now;\n',
    '          if (hasStarted) {\n',
    '            console.log("[odds] Skipping started game: " + event.away_team + " @ " + event.home_team);\n',
    '          }\n',
    '          return !hasStarted;\n',
    '        });\n',
    '      } else {\n',
    '        events = todayEvents;\n',
    '      }\n',
]

lines[start:end] = replacement

with open(f, 'w') as file:
    file.writelines(lines)
print("3/4 Started-game filter updated")
