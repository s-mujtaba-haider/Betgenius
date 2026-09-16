#!/usr/bin/env bash
# M6.2 + M6.3 only (sweep handled by run_m6_sweep_quick.sh).
set -euo pipefail
cd "$(dirname "$0")/../.."
BETGENIUS="$(pwd)"
RUN="deno run --no-check --allow-net --allow-env --allow-read --allow-write harness/run_backtest.ts"
LOG="$BETGENIUS/harness/out/m6_post_oos.log"
OUT="$BETGENIUS/harness/out"
mkdir -p "$OUT"

run_bt() {
  local out_name="$1"
  shift
  if [[ -f "$OUT/${out_name}.json" ]]; then
    echo "--- skip (exists) $out_name ---" | tee -a "$LOG"
    return 0
  fi
  echo "--- $(date -u +%H:%M:%S) $* ---" | tee -a "$LOG"
  $RUN "$@" --format=both 2>&1 | tee -a "$LOG"
}

echo "=== M6 K + outs $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" | tee "$LOG"

run_bt pitcher_strikeouts_m6_full_window --market=pitcher_strikeouts \
  --out=pitcher_strikeouts_m6_full_window

run_bt pitcher_outs_m6_isotonic_d780 --market=pitcher_outs --source=pick_history \
  --scoring=isotonic --out=pitcher_outs_m6_isotonic_d780

echo "=== M6 K + outs complete $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" | tee -a "$LOG"
