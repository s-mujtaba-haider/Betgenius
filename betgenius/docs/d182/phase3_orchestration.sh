#!/bin/bash
# D-182 Phase 3 orchestration — full October 2024 NBA backfill.
# Date-driven loop over backfill-bdl-historical edge function.
#
# Bounded per-invocation to 1 date so each call stays under the 150s
# Supabase edge function ceiling. Resume-safe: re-running the script
# skips already-persisted (player, prop_type, pick_side) tuples per
# the in-function pre-query.

set -uo pipefail

cd "/Users/matthewperdomo/Desktop/betting-deploy/betgenius"

# `.env.local` values are double-quoted; `source` strips them correctly,
# `cut` would not. Use source for robust quote handling.
set -a
source .env.local
set +a
SUPABASE_URL="${VITE_SUPABASE_URL}"
SERVICE_KEY="${SUPABASE_SERVICE_ROLE_KEY}"
if [ -z "$SUPABASE_URL" ] || [ -z "$SERVICE_KEY" ]; then
  echo "ERROR: SUPABASE_URL or SERVICE_KEY empty after source .env.local" >&2
  exit 1
fi

TOTAL_PICKS=0
TOTAL_SCORED=0
TOTAL_ATTEMPTED=0
FAILED_DATES=()
PER_DATE_LOG=()

START_TS=$(date +%s)

# D-182 resume on BDL GOAT tier (May 15-16, 2026). Yesterday's failures
# on October dates were tier-related (BDL free tier returned 0 player rows
# for Oct 24-30); today's tier probe of 2024-10-25 returned 100 rows via
# the same edge function. Full October 22 - November 30 sweep.
# 5s sleep between dates (was 2s) to avoid the 429 rate-limit collision
# observed during tier verification.
DATES_TO_RUN=()
# D-185 (May 15-16, 2026): post-D-183+D-184 full sweep.
# D-183 (cross-season prior-games) recovers October dates; D-184 (40s inter-date
# cooldown for warm-isolate fix) recovers the silent-empty alternating pattern.
# Range: Oct 22 - Dec 31 2024 = 71 dates × (30s exec + 40s sleep) ≈ 80 min wall clock.
# Resume-safety skips the ~753 already-persisted picks.
for D in 22 23 24 25 26 27 28 29 30 31; do DATES_TO_RUN+=("2024-10-${D}"); done
for D in 01 02 03 04 05 06 07 08 09 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do
  DATES_TO_RUN+=("2024-11-${D}")
done
for D in 01 02 03 04 05 06 07 08 09 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30 31; do
  DATES_TO_RUN+=("2024-12-${D}")
done

for DATE in "${DATES_TO_RUN[@]}"; do
  echo ""
  echo "=== $(date -u +%H:%M:%S) Backfilling $DATE ==="
  DATE_START=$(date +%s)

  RESPONSE=$(curl -s -X POST \
    "${SUPABASE_URL}/functions/v1/backfill-bdl-historical" \
    -H "Authorization: Bearer ${SERVICE_KEY}" \
    -H "apikey: ${SERVICE_KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"start_date\":\"$DATE\",\"end_date\":\"$DATE\"}" \
    --max-time 180)

  DATE_DUR=$(( $(date +%s) - DATE_START ))

  PICKS=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('picks_generated', d.get('total_picks_persisted','')))" 2>/dev/null)
  SCORED=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('summaries',[{}])[0].get('picks_scored',''))" 2>/dev/null)
  ATTEMPTED=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('summaries',[{}])[0].get('picks_attempted',''))" 2>/dev/null)
  PLAYERS=$(echo "$RESPONSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('summaries',[{}])[0].get('players_processed',''))" 2>/dev/null)

  if [ -z "$PICKS" ] || ! echo "$PICKS" | grep -qE '^[0-9]+$'; then
    echo "  ✗ FAILED (${DATE_DUR}s)"
    echo "    response (first 400 chars): ${RESPONSE:0:400}"
    FAILED_DATES+=("$DATE")
    PER_DATE_LOG+=("$DATE FAIL ${DATE_DUR}s")
  else
    echo "  ✓ players=$PLAYERS attempted=$ATTEMPTED scored=$SCORED persisted=$PICKS (${DATE_DUR}s)"
    TOTAL_PICKS=$((TOTAL_PICKS + PICKS))
    TOTAL_SCORED=$((TOTAL_SCORED + ${SCORED:-0}))
    TOTAL_ATTEMPTED=$((TOTAL_ATTEMPTED + ${ATTEMPTED:-0}))
    PER_DATE_LOG+=("$DATE OK persisted=$PICKS players=$PLAYERS ${DATE_DUR}s")
  fi

  sleep 40  # D-184: warm-isolate cooldown — empirical 30s sufficient to clear BDL stale-pool state; 40s margin
done

END_TS=$(date +%s)
ELAPSED=$((END_TS - START_TS))
ELAPSED_MIN=$((ELAPSED / 60))
ELAPSED_SEC=$((ELAPSED % 60))

echo ""
echo "=== Phase 3 Summary ==="
echo "Wall clock: ${ELAPSED_MIN}m ${ELAPSED_SEC}s"
echo "Dates attempted: ${#DATES_TO_RUN[@]}"
echo "Dates failed: ${#FAILED_DATES[@]}"
if [ ${#FAILED_DATES[@]} -gt 0 ]; then
  echo "  failed dates: ${FAILED_DATES[*]}"
fi
echo "Total picks attempted: $TOTAL_ATTEMPTED"
echo "Total picks scored: $TOTAL_SCORED"
echo "Total picks persisted: $TOTAL_PICKS"
echo ""
echo "Per-date breakdown:"
for line in "${PER_DATE_LOG[@]}"; do
  echo "  $line"
done
