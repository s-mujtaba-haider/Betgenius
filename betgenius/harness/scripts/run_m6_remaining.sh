#!/usr/bin/env bash
# M6 remaining runs — OOS first, then sweep, then K/outs. Sequential for DB limit.
set -euo pipefail
cd "$(dirname "$0")/../.."
BETGENIUS="$(pwd)"
RUN="deno run --no-check --allow-net --allow-env --allow-read --allow-write harness/run_backtest.ts"
LOG="$BETGENIUS/harness/out/m6_remaining.log"
TB_WINDOW="--start=2026-04-25 --end=2026-05-24"
mkdir -p "$BETGENIUS/harness/out"

run_bt() {
  echo "--- $(date -u +%H:%M:%S) $* ---" | tee -a "$LOG"
  $RUN "$@" --format=both 2>&1 | tee -a "$LOG"
}

echo "=== M6 remaining $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" | tee "$LOG"

# M6.1c OOS holdout first (smaller window — gates prod side-policy decision)
run_bt --market=batter_total_bases --start=2026-05-11 --end=2026-05-24 \
  --out=batter_total_bases_m6_unders_oos_holdout

# M6.1b sweep (pick best ev_filtered-under ROI at n≥500)
for lc in 0.001 0.002 0.003; do
  for sh in 0.25 0.4; do
    run_bt --market=batter_total_bases $TB_WINDOW \
      --lambda-coeff="$lc" --shrink="$sh" \
      --out="batter_total_bases_m6_lc${lc}_sh${sh}"
  done
done

# M6.2 full warehouse K window
run_bt --market=pitcher_strikeouts --out=pitcher_strikeouts_m6_full_window

# M6.3 outs isotonic A/B
run_bt --market=pitcher_outs --source=pick_history --scoring=isotonic \
  --out=pitcher_outs_m6_isotonic_d780

echo "=== M6 remaining complete $(date -u +%Y-%m-%dT%H:%M:%SZ) ===" | tee -a "$LOG"
