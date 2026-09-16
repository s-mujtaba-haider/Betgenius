#!/usr/bin/env bash
# M5 gate runs — one market at a time to avoid harness_readonly connection limits.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
RUN="deno run --no-check --allow-net --allow-env --allow-read --allow-write run_backtest.ts"
WINDOW="2026-04-25 2026-05-24"
LOG="$ROOT/out/m5_gate_sequential.log"
echo "=== M5 sequential gates $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" | tee -a "$LOG"

run_one() {
  local extra=("$@")
  echo "--- ${extra[*]} ---" | tee -a "$LOG"
  $RUN "${extra[@]}" --format=both 2>&1 | tee -a "$LOG"
}

# Warehouse markets (M3 comparable window)
for m in batter_total_bases batter_home_runs batter_rbis pitcher_strikeouts batter_hits; do
  run_one --market="$m" --start=2026-04-25 --end=2026-05-24 --out="${m}_gate_m5"
done

# pick_history — use windows with live pick_history rows (Apr-May 2026 empty for runs_scored)
run_one --market=batter_runs_scored --source=pick_history --start=2026-06-01 --end=2026-07-15 --out=batter_runs_scored_gate_m5
run_one --market=pitcher_outs --source=pick_history --start=2026-06-13 --end=2026-07-08 --out=pitcher_outs_gate_m5

echo "=== done $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" | tee -a "$LOG"
