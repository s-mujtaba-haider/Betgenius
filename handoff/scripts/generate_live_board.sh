#!/usr/bin/env bash
# Regenerate the current production board under the LOCKED configuration.
# It READS the shipped configuration and changes no model, threshold or policy.
# Requires the member cache to exist (scripts/reproduce.sh step 2).
set -euo pipefail
cd "$(dirname "$0")/../project/betgenius"
export UPLIFT_DATA_DIR="$PWD/harness/uplift/data_expanded_6h"
export UPLIFT_CACHE_DIR="$PWD/harness/uplift/cache_fam"
mkdir -p harness/uplift/reports
cp -n ../../results/final_v1.csv harness/uplift/reports/ 2>/dev/null || true
python harness/uplift/live_board.py --tag=_v1 --windows=1,7,30
echo
echo "Wrote harness/uplift/reports/live_production_results.csv and live_summary.txt"
