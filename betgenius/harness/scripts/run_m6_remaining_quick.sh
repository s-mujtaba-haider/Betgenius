#!/usr/bin/env bash
# M6.2 + M6.3 fast finish — --limit=500 on full detected windows (~15–30 min each).
set -euo pipefail
cd "$(dirname "$0")/../.."
BETGENIUS="$(pwd)"
RUN="deno run --no-check --allow-net --allow-env --allow-read --allow-write harness/run_backtest.ts"
LOG="$BETGENIUS/harness/out/m6_remaining_quick.log"
LIMIT="${REMAINING_LIMIT:-500}"
OUT="$BETGENIUS/harness/out"
mkdir -p "$OUT"

run_bt() {
  local out_name="$1"
  shift
  echo "--- $(date -u +%H:%M:%S) $out_name ---" | tee -a "$LOG"
  $RUN "$@" --format=both 2>&1 | tee -a "$LOG"
}

echo "=== M6.2 + M6.3 quick (limit=$LIMIT) $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" | tee "$LOG"

# M6.2 — pitcher K on full warehouse coverage (auto window), quick sample
run_bt pitcher_strikeouts_m6_full_window_quick \
  --market=pitcher_strikeouts --limit="$LIMIT" \
  --out=pitcher_strikeouts_m6_full_window_quick

# M6.3 — outs isotonic A/B (pick_history widest), quick sample
run_bt pitcher_outs_m6_isotonic_d780_quick \
  --market=pitcher_outs --source=pick_history --scoring=isotonic \
  --limit="$LIMIT" --out=pitcher_outs_m6_isotonic_d780_quick

python3 harness/scripts/finalize_m6_remaining.py

echo "=== M6.2 + M6.3 quick done $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" | tee -a "$LOG"
