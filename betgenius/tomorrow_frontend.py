import sys
f = sys.argv[1]
with open(f, 'r') as file:
    code = file.read()

# 1. Add dateOffset state
old_state = '  const [confidenceFilter, setConfidenceFilter] = useState<number>(60); // Default: show all 60+'
new_state = """  const [confidenceFilter, setConfidenceFilter] = useState<number>(60); // Default: show all 60+
  const [dateOffset, setDateOffset] = useState<number>(0); // 0=today, 1=tomorrow"""
assert old_state in code, "FAIL: confidenceFilter state not found"
code = code.replace(old_state, new_state, 1)
print("1/4 dateOffset state added")

# 2. Update fetchRecommendations to pass dateOffset
old_invoke = '      const { data: result, error: fnError } = await supabase.functions.invoke("get-recommendations");'
new_invoke = '      const { data: result, error: fnError } = await supabase.functions.invoke("get-recommendations", { body: { dateOffset } });'
assert old_invoke in code, "FAIL: supabase invoke not found"
code = code.replace(old_invoke, new_invoke, 1)
print("2/4 fetchRecommendations now passes dateOffset")

# 3. Add Today/Tomorrow toggle buttons above the analyze button
old_ready = '            <h2 className="text-xl font-semibold text-zinc-200 mb-2">Ready to Analyze</h2>'
new_ready = """            <h2 className="text-xl font-semibold text-zinc-200 mb-2">Ready to Analyze</h2>
            <div className="flex gap-2 justify-center mb-4">
              <button onClick={() => setDateOffset(0)} className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${dateOffset === 0 ? "bg-emerald-600 text-white" : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"}`}>Today</button>
              <button onClick={() => setDateOffset(1)} className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${dateOffset === 1 ? "bg-emerald-600 text-white" : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700"}`}>Tomorrow</button>
            </div>"""
assert old_ready in code, "FAIL: Ready to Analyze not found"
code = code.replace(old_ready, new_ready, 1)
print("3/4 Today/Tomorrow toggle added to Ready state")

# 4. Update button text to reflect selection
old_btn = """            Analyze Today's Games"""
new_btn = """            {dateOffset === 0 ? "Analyze Today's Games" : "Analyze Tomorrow's Games"}"""
assert old_btn in code, "FAIL: button text not found"
code = code.replace(old_btn, new_btn, 1)
print("4/4 Button text updates based on selection")

with open(f, 'w') as file:
    file.write(code)
print("\n#127 Frontend DONE — Today/Tomorrow toggle")
