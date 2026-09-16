#!/usr/bin/env bash
# Block 1 harness runs — sequential to respect harness_readonly connection limit.
set -euo pipefail
cd "$(dirname "$0")/../.."
BETGENIUS="$(pwd)"
RUN="deno run --no-check --allow-net --allow-env --allow-read --allow-write harness/run_backtest.ts"
LOG="$BETGENIUS/harness/out/block1_sequential.log"
mkdir -p "$BETGENIUS/harness/out"
echo "=== Block 1 sequential $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" | tee "$LOG"

run_bt() {
  echo "--- $* ---" | tee -a "$LOG"
  $RUN "$@" --format=both 2>&1 | tee -a "$LOG"
}

# M4.1 OOS
run_bt --market=batter_hits --start=2026-05-11 --end=2026-05-24 --out=batter_hits_oos_holdout_2026-05-11_to_2026-05-24
run_bt --market=batter_hits --start=2025-04-25 --end=2025-05-24 --out=batter_hits_oos_2025-04-25_to_2025-05-24

# M4.2 CLV fix verification on M3 window
run_bt --market=batter_hits --start=2026-04-25 --end=2026-05-24 --out=batter_hits_m3_clv_fix

# M5 warehouse gates
for m in batter_total_bases batter_home_runs batter_rbis pitcher_strikeouts; do
  run_bt --market="$m" --start=2026-04-25 --end=2026-05-24 --out="${m}_gate_m5"
done

# M5 pick_history
run_bt --market=batter_runs_scored --source=pick_history --start=2026-06-01 --end=2026-07-15 --out=batter_runs_scored_gate_m5
run_bt --market=pitcher_outs --source=pick_history --start=2026-06-13 --end=2026-07-08 --out=pitcher_outs_gate_m5

echo "=== Block 1 sequential complete $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" | tee -a "$LOG"
