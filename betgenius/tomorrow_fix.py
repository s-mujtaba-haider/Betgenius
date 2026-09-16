import sys
f = sys.argv[1]
with open(f, 'r') as file:
    code = file.read()

# 3. Fix the started-game filter
old_filter = """      // Filter out games that have already started
      events = todayEvents.filter(event => {
        const commenceTime = new Date(event.commence_time);
        const hasStarted = commenceTime < now;
        if (hasStarted) {
          console.log`[odds] Skipping started game: ${event.away_team} @ ${event.home_team} (started ${event.commence_time})`;
        }
        return !hasStarted;
      });"""

# Check with closing paren version too
alt_filter = """      // Filter out games that have already started
      events = todayEvents.filter(event => {
        const commenceTime = new Date(event.commence_time);
        const hasStarted = commenceTime < now;
        if (hasStarted) {
          console.log`[odds] Skipping started game: ${event.away_team} @ ${event.home_team} (started ${event.commence_time})`);
        }
        return !hasStarted;
      });"""

new_filter = """      // Filter out games that have already started (skip for tomorrow — all future)
      if (dateOffset === 0) {
        events = todayEvents.filter(event => {
          const commenceTime = new Date(event.commence_time);
          const hasStarted = commenceTime < now;
          if (hasStarted) {
            console.log("[odds] Skipping started game: " + event.away_team + " @ " + event.home_team);
          }
          return !hasStarted;
        });
      } else {
        events = todayEvents;
      }"""

if old_filter in code:
    code = code.replace(old_filter, new_filter, 1)
    print("3/4 Started-game filter updated (version A)")
elif alt_filter in code:
    code = code.replace(alt_filter, new_filter, 1)
    print("3/4 Started-game filter updated (version B)")
else:
    print("FAIL: Could not find filter block")
    sys.exit(1)

# 4. Parse dateOffset from request body
old_phase1 = '    const { events, allProps } = await fetchTodaysProps(dateOffset);'
if old_phase1 in code:
    print("4/4 SKIP — dateOffset already wired (from partial run)")
else:
    old_call = '    const { events, allProps } = await fetchTodaysProps();'
    new_call = """    // Parse date offset from request body (0=today, 1=tomorrow)
    let dateOffset = 0;
    try {
      const body = await req.json();
      if (body?.dateOffset === 1) dateOffset = 1;
    } catch {
      // No body or invalid JSON — default to today
    }
    console.log("[recs] Date offset: " + dateOffset + " (" + (dateOffset === 0 ? "today" : "tomorrow") + ")");
    const { events, allProps } = await fetchTodaysProps(dateOffset);"""
    assert old_call in code, "FAIL: fetchTodaysProps() call not found"
    code = code.replace(old_call, new_call, 1)
    print("4/4 Request body parsed for dateOffset")

with open(f, 'w') as file:
    file.write(code)
print("\nBackend fix complete")
