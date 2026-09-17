#!/usr/bin/env bash
# BetGenius MLB Phase 1 -- full reproduction from the packaged data.
# No network, no credentials, no API credits. Roughly 2 hours end to end.
set -euo pipefail
cd "$(dirname "$0")/../project/betgenius"

export UPLIFT_DATA_DIR="$PWD/harness/uplift/data_expanded_6h"
export UPLIFT_CACHE_DIR="$PWD/harness/uplift/cache_fam"
export UPLIFT_MEMBERS="rf,et,gbmB,gbmC,gbmD"

echo; echo "[1/6] smoke test -- the gate port"
python harness/uplift/verify_gate.py

echo; echo "[2/6] building the member cache  (~90 minutes, ~940 MB)"
python harness/uplift/build_cache.py

echo; echo "[3/6] the final run  (~5 minutes)"
python harness/uplift/run_final_model.py --conf=60 --tag=_v1

echo; echo "[4/6] production parity  -- expect 0 of 28,141 rejected"
python harness/uplift/parity_audit.py --tag=_v1

echo; echo "[5/6] the current production board"
python harness/uplift/live_board.py --tag=_v1 --windows=1,7,30

echo; echo "[6/6] season split"
python harness/uplift/season_analysis.py --tag=_v1

echo
echo "Now compare what you produced against what shipped:"
echo "    diff harness/uplift/reports/final_v1.csv        ../../results/final_v1.csv"
echo "    diff harness/uplift/reports/parity_audit_v1.csv ../../results/parity_audit_v1.csv"
echo "    diff harness/uplift/reports/season_split_v1.csv ../../results/season_split_v1.csv"
echo
echo "Expected: 6/11 both gates, 7/11 full OOS, 6/11 verdict, 202.7 verdict units,"
echo "          0 of 28,141 board rows rejected."
echo
echo "The final client table needs the robustness roll-up as an input:"
echo "    cp ../../results/robustness_v1.csv harness/uplift/reports/"
echo "    python harness/uplift/final_matrix.py --tag=_v1"
