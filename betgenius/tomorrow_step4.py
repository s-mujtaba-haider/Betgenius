import sys
f = sys.argv[1]
with open(f, 'r') as file:
    code = file.read()

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
print("4/4 dateOffset parsed from request body and passed to fetchTodaysProps")

with open(f, 'w') as file:
    file.write(code)
