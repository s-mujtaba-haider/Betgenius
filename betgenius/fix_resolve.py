import sys

f = sys.argv[1] if len(sys.argv) > 1 else 'supabase/functions/resolve-picks/index.ts'
with open(f, 'r') as file:
    lines = file.readlines()

# Find "const elapsed" after line 900
target = None
for i, line in enumerate(lines):
    if 'const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);' in line and i > 900:
        target = i
        break

if target is None:
    print("ERROR: Could not find elapsed line after line 900")
    sys.exit(1)

print(f"Found elapsed at line {target+1}")

# Find the return jsonResponse closing }); after it
end = None
for i in range(target, min(target+15, len(lines))):
    if lines[i].strip() == '});':
        end = i
        break

if end is None:
    print("ERROR: Could not find closing });")
    sys.exit(1)

print(f"Found closing at line {end+1}")
print(f"Replacing lines {target+1} through {end+1}")

# Build replacement
replacement = []
replacement.append("    totalResolved += resolved;\n")
replacement.append("    totalSkipped += skipped;\n")
replacement.append("    totalUnresolvable += unresolvable;\n")
replacement.append("    totalErrors += errors;\n")
replacement.append("    totalBetsUpdated += betsUpdated;\n")
replacement.append("    processedDates.push(targetDate);\n")
replacement.append("    } // end for loop over dates\n")
replacement.append("\n")
replacement.append("    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);\n")
replacement.append("    console.log(`[resolve] All dates done in ${elapsed}s: resolved=${totalResolved}, dates=${processedDates.join(',')}`);\n")
replacement.append("\n")
replacement.append("    return jsonResponse({\n")
replacement.append("      success: true,\n")
replacement.append("      message: `Resolved ${totalResolved} picks across ${processedDates.length} dates, updated ${totalBetsUpdated} bets`,\n")
replacement.append("      resolved: totalResolved, skipped: totalSkipped, unresolvable: totalUnresolvable, errors: totalErrors, betsUpdated: totalBetsUpdated,\n")
replacement.append("      processedDates,\n")
replacement.append("      totalUnresolved: allPicks.length,\n")
replacement.append("      elapsedSeconds: parseFloat(elapsed),\n")
replacement.append("    });\n")

lines[target:end+1] = replacement
with open(f, 'w') as file:
    file.writelines(lines)
print("Done - multi-date loop closed successfully")
