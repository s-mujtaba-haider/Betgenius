#!/usr/bin/env bash
# M6 tuning sprint — sequential harness runs (harness_readonly connection limit).
set -euo pipefail
cd "$(dirname "$0")/../.."
BETGENIUS="$(pwd)"
RUN="deno run --no-check --allow-net --allow-env --allow-read --allow-write harness/run_backtest.ts"
LOG="$BETGENIUS/harness/out/m6_sequential.log"
TB_WINDOW="--start=2026-04-25 --end=2026-05-24"
mkdir -p "$BETGENIUS/harness/out"
echo "=== M6 sequential $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" | tee "$LOG"

run_bt() {
  echo "--- $* ---" | tee -a "$LOG"
  $RUN "$@" --format=both 2>&1 | tee -a "$LOG"
}

# M6.1a — TB Poisson baseline reused from M5 (identical window/scorer); isotonic A/B below
python3 harness/scripts/augment_gate_json.py \
  harness/out/batter_total_bases_gate_m5.json \
  harness/out/batter_total_bases_m6_poisson_baseline.json
cp harness/out/batter_total_bases_gate_m5.csv harness/out/batter_total_bases_m6_poisson_baseline.csv

run_bt --market=batter_total_bases $TB_WINDOW --scoring=isotonic --out=batter_total_bases_m6_isotonic_d789

# M6.1b — λ coeff × shrink sweep (Poisson path; pick best by ev_filtered-under ROI)
for lc in 0.001 0.002 0.003; do
  for sh in 0.25 0.4; do
    run_bt --market=batter_total_bases $TB_WINDOW \
      --lambda-coeff="$lc" --shrink="$sh" \
      --out="batter_total_bases_m6_lc${lc}_sh${sh}"
  done
done

# M6.1c — best-config unders OOS holdout (update lc/sh if sweep picks different winner)
run_bt --market=batter_total_bases --start=2026-05-11 --end=2026-05-24 \
  --out=batter_total_bases_m6_unders_oos_holdout

# M6.2 — pitcher K full warehouse window + comparability slice
run_bt --market=pitcher_strikeouts --out=pitcher_strikeouts_m6_full_window
run_bt --market=pitcher_strikeouts $TB_WINDOW --out=pitcher_strikeouts_m6_apr_may_slice

# M6.3 — pitcher outs widest pick_history + Poisson vs D-780 isotonic A/B
run_bt --market=pitcher_outs --source=pick_history --out=pitcher_outs_m6_poisson_full
run_bt --market=pitcher_outs --source=pick_history --scoring=isotonic --out=pitcher_outs_m6_isotonic_d780

echo "=== M6 sequential complete $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" | tee -a "$LOG"
