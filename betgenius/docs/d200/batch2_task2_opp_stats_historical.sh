#!/usr/bin/env bash
# Batch 2 Task 2.2 / D-200 — historical opp-stats backfill for 2023-24 NBA season.
#
# Backfills cache_opponent_defensive_stats for Oct 24, 2023 - Apr 14, 2024
# by invoking fetch-team-advanced-stats per date with a 10-day lookback
# window (function-native parameter). Each invocation produces one snapshot
# date's worth of per-team GOAT advanced metrics aggregated over the
# preceding 10 game-days.
#
# Idempotent: PK (team_name, snapshot_date, sport) on cache_opponent_defensive_stats.
# 5-10s inter-date sleep to stay under BDL rate limits.

set -uo pipefail  # no -e so transient curl failures don't kill the long-running script

PROJECT_REF="${PROJECT_REF:-gzuzuqxvfjszlfclhcfz}"
TOKEN="${BACKFILL_AUTH_TOKEN:?BACKFILL_AUTH_TOKEN required}"
ENDPOINT="https://${PROJECT_REF}.supabase.co/functions/v1/fetch-team-advanced-stats"
SLEEP_SEC="${SLEEP_SEC:-7}"

build_dates() {
  python3 -c "
import datetime, sys
d = datetime.date(2023,10,24)
end = datetime.date(2024,4,14)
while d <= end:
    print(d.isoformat())
    d += datetime.timedelta(days=1)
"
}

TOTAL_OK=0
TOTAL_FAIL=0
TOTAL_ROWS=0
IDX=0
NUM=$(build_dates | wc -l | tr -d ' ')

while IFS= read -r DATE; do
  IDX=$((IDX + 1))
  RESP=$(curl --silent --show-error --max-time 120 \
    -X POST "$ENDPOINT" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"snapshot_date\":\"${DATE}\",\"lookback_days\":10}")
  PARSED=$(echo "$RESP" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(f\"by_team_rows={d.get('by_team_upserts',0)} by_pos_rows={d.get('by_position_upserts',0)} bdl_calls={d.get('bdl_calls',0)} ms={d.get('wall_clock_ms',0)} err={d.get('error','')}\")
except Exception as e:
    print(f'parse-failed: {str(e)[:80]}')
" 2>/dev/null || echo "shell-parse-failed")
  echo "[$(date +%H:%M:%S)] date ${IDX}/${NUM} ${DATE} → ${PARSED}"

  R=$(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('by_team_upserts',0))" 2>/dev/null || echo 0)
  if [[ "$R" -gt 0 ]]; then
    TOTAL_OK=$((TOTAL_OK + 1))
    TOTAL_ROWS=$((TOTAL_ROWS + R))
  else
    TOTAL_FAIL=$((TOTAL_FAIL + 1))
  fi
  sleep "$SLEEP_SEC"
done < <(build_dates)

echo
echo "=== batch2 task2 historical opp-stats complete ==="
echo "Dates ok: $TOTAL_OK / $NUM"
echo "Dates failed: $TOTAL_FAIL"
echo "Total team-rows upserted: $TOTAL_ROWS"
