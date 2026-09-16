#!/usr/bin/env bash
# D-194 rescore v2 — 2-week chunks to stay under 150s edge ceiling.
# Per-pick cost ~300-500ms due to scoreboard + opp_stats lookups +
# UPDATE; monthly chunks (~230 picks) consistently hit 150s.
# Two-week chunks (~115 picks) finish in ~50-70s safely.

set -uo pipefail  # NOTE: -e dropped — transient curl failures should not kill the orchestration
PROJECT_REF="${PROJECT_REF:-gzuzuqxvfjszlfclhcfz}"
TOKEN="${BACKFILL_AUTH_TOKEN:?BACKFILL_AUTH_TOKEN required}"
ENDPOINT="https://${PROJECT_REF}.supabase.co/functions/v1/rescore-backfill-picks"

build_windows() {
  python3 -c "
import datetime
# Two-week windows over the full cohort
windows = [
    ('2023-10-01','2023-10-14'),('2023-10-15','2023-10-28'),('2023-10-29','2023-11-11'),
    ('2023-11-12','2023-11-25'),('2023-11-26','2023-12-09'),('2023-12-10','2023-12-23'),
    ('2023-12-24','2024-01-06'),('2024-01-07','2024-01-20'),('2024-01-21','2024-02-03'),
    ('2024-02-04','2024-02-17'),('2024-02-18','2024-03-02'),('2024-03-03','2024-03-16'),
    ('2024-03-17','2024-03-30'),('2024-03-31','2024-04-14'),
    ('2024-10-22','2024-11-04'),('2024-11-05','2024-11-18'),('2024-11-19','2024-12-02'),
    ('2024-12-03','2024-12-16'),('2024-12-17','2024-12-31'),
    ('2025-01-01','2025-01-14'),('2025-01-15','2025-01-28'),('2025-01-29','2025-02-11'),
    ('2025-02-12','2025-02-25'),('2025-02-26','2025-03-11'),('2025-03-12','2025-03-25'),
    ('2025-03-26','2025-04-08'),('2025-04-09','2025-04-22'),('2025-04-23','2025-04-30'),
]
for s, e in windows: print(f'{s},{e}')
"
}

TOTAL_RESCORED=0
TOTAL_OPP_SIG=0
TOTAL_FAIL=0
TOTAL_NO_CHANGE=0
BATCH_IDX=0
NUM_BATCHES=$(build_windows | wc -l | tr -d ' ')

while IFS=',' read -r START END; do
  BATCH_IDX=$((BATCH_IDX + 1))
  RESP=$(curl --silent --show-error --max-time 160 \
    -X POST "$ENDPOINT" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"start_date\":\"${START}\",\"end_date\":\"${END}\"}")
  PARSED=$(echo "$RESP" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    s = d.get('summary', {})
    print(f\"total={s.get('total',0)} rescored={s.get('rescored',0)} no_change={s.get('skipped_no_change',0)} opp_signal={s.get('opp_defense_signal_count',0)} failures={s.get('update_failures',0)}\")
except Exception as e:
    print(f'parse-failed: {str(e)[:80]} body_head={sys.stdin.read()[:120] if False else \"\"}')
" 2>/dev/null || echo "shell-parse-failed")
  echo "[$(date +%H:%M:%S)] batch ${BATCH_IDX}/${NUM_BATCHES} ${START}..${END} → ${PARSED}"

  R=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('summary',{}).get('rescored',0))" 2>/dev/null || echo 0)
  S=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('summary',{}).get('opp_defense_signal_count',0))" 2>/dev/null || echo 0)
  F=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('summary',{}).get('update_failures',0))" 2>/dev/null || echo 0)
  N=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('summary',{}).get('skipped_no_change',0))" 2>/dev/null || echo 0)
  TOTAL_RESCORED=$((TOTAL_RESCORED + R))
  TOTAL_OPP_SIG=$((TOTAL_OPP_SIG + S))
  TOTAL_FAIL=$((TOTAL_FAIL + F))
  TOTAL_NO_CHANGE=$((TOTAL_NO_CHANGE + N))
  sleep 1
done < <(build_windows)

echo
echo "=== rescore v2 complete ==="
echo "Batches: $BATCH_IDX"
echo "Total rescored: $TOTAL_RESCORED"
echo "Total opp_defense signal lifts: $TOTAL_OPP_SIG"
echo "Total no-change skips: $TOTAL_NO_CHANGE"
echo "Total update failures: $TOTAL_FAIL"
