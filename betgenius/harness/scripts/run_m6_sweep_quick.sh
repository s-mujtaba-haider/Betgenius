#!/usr/bin/env bash
# M6.1b quick λ/shrink sweep — --limit=500 for fast knob ranking (~10–20 min/config).
# Full-window confirm only if winner != default (0.002 / 0.4).
set -euo pipefail
cd "$(dirname "$0")/../.."
BETGENIUS="$(pwd)"
RUN="deno run --no-check --allow-net --allow-env --allow-read --allow-write harness/run_backtest.ts"
LOG="$BETGENIUS/harness/out/m6_sweep_quick.log"
TB_WINDOW="--start=2026-04-25 --end=2026-05-24"
LIMIT="${SWEEP_LIMIT:-500}"
OUT="$BETGENIUS/harness/out"
mkdir -p "$OUT"

run_bt() {
  local out_name="$1"
  shift
  echo "--- $(date -u +%H:%M:%S) $out_name ---" | tee -a "$LOG"
  $RUN "$@" --format=both 2>&1 | tee -a "$LOG"
}

echo "=== M6.1b quick sweep (limit=$LIMIT) $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" | tee "$LOG"

for lc in 0.001 0.002 0.003; do
  for sh in 0.25 0.4; do
    out="batter_total_bases_m6_lc${lc}_sh${sh}_quick"
    run_bt "$out" --market=batter_total_bases $TB_WINDOW \
      --lambda-coeff="$lc" --shrink="$sh" \
      --limit="$LIMIT" --out="$out"
  done
done

python3 harness/scripts/pick_m6_sweep_winner.py --quick

echo "=== M6.1b quick sweep done $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" | tee -a "$LOG"
