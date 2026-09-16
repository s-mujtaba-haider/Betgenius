import sys
f = sys.argv[1]
with open(f, 'r') as file:
    code = file.read()

# 1. Make fetchTodaysProps accept a dateOffset parameter
old_sig = "async function fetchTodaysProps(): Promise<{ events: OddsEvent[]; allProps: ExtractedProp[] }> {"
new_sig = "async function fetchTodaysProps(dateOffset: number = 0): Promise<{ events: OddsEvent[]; allProps: ExtractedProp[] }> {"
assert old_sig in code, "FAIL: fetchTodaysProps signature not found"
code = code.replace(old_sig, new_sig, 1)
print("1/4 fetchTodaysProps now accepts dateOffset param")

# 2. Shift the Eastern date by offset
old_date = """      const easternNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
      const todayStart = new Date(easternNow);
      todayStart.setHours(0, 0, 0, 0);
      const todayEnd = new Date(easternNow);
      todayEnd.setHours(23, 59, 59, 999);"""

new_date = """      const easternNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }));
      // Apply date offset (0 = today, 1 = tomorrow)
      const targetDate = new Date(easternNow);
      targetDate.setDate(targetDate.getDate() + dateOffset);
      const todayStart = new Date(targetDate);
      todayStart.setHours(0, 0, 0, 0);
      const todayEnd = new Date(targetDate);
      todayEnd.setHours(23, 59, 59, 999);
      if (dateOffset > 0) {
        console.log("[odds] TOMORROW MODE — looking for games on " + todayStart.toDateString());
      }"""

assert old_date in code, "FAIL: date range block not found"
code = code.replace(old_date, new_date, 1)
print("2/4 Date range shifted by dateOffset")

# 3. Skip "already started" filter for tomorrow (all games are in the future)
old_filter = """      // Filter out games that have already started
      events = todayEvents.filter(event => {
        const commenceTime = new Date(event.commence_time);
        const hasStarted = commenceTime < now;
        if (hasStarted) {
          console.log`[odds] Skipping started game: ${event.away_team} @ ${event.home_team} (started ${event.commence_time})`;
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

assert old_filter in code, "FAIL: started filter not found"
code = code.replace(old_filter, new_filter, 1)
print("3/4 Started-game filter skipped for tomorrow")

# 4. Parse dateOffset from request body in Deno.serve
old_phase1 = '    const { events, allProps } = await fetchTodaysProps();'
new_phase1 = """    // Parse date offset from request body (0=today, 1=tomorrow)
    let dateOffset = 0;
    try {
      const body = await req.json();
      if (body?.dateOffset === 1) dateOffset = 1;
    } catch {
      // No body or invalid JSON — default to today
    }
    console.log("[recs] Date offset: " + dateOffset + " (" + (dateOffset === 0 ? "today" : "tomorrow") + ")");
    const { events, allProps } = await fetchTodaysProps(dateOffset);"""

assert old_phase1 in code, "FAIL: fetchTodaysProps call not found"
code = code.replace(old_phase1, new_phase1, 1)
print("4/4 Request body parsed for dateOffset")

with open(f, 'w') as file:
    file.write(code)
print("\n#127 Backend DONE — Tomorrow mode supported via dateOffset param")
