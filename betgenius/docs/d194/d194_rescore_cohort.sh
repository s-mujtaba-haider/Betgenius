#!/usr/bin/env bash
# D-194 — rescore-backfill-picks cohort orchestrator.
#
# Re-rescores the entire backfill-historical cohort post-D-194 scoreboard
# backfill. Uses D-190 idempotency: reads confidence_pre_d186_phase4 as
# the audit baseline and re-derives confidence with NOW-AVAILABLE oppStats.
#
# Chunks by month to stay under 150s edge function ceiling. Each month's
# rescore typically processes 100-300 picks (~0.3s/pick due to scoreboard +
# oppStats lookups + UPDATE).
#
# Resume-safe by D-190 design — re-invoking lands the same final state.

set -euo pipefail

PROJECT_REF="${PROJECT_REF:-gzuzuqxvfjszlfclhcfz}"
TOKEN="${BACKFILL_AUTH_TOKEN:?BACKFILL_AUTH_TOKEN required}"
ENDPOINT="https://${PROJECT_REF}.supabase.co/functions/v1/rescore-backfill-picks"
INTER_SLEEP_SEC="${INTER_SLEEP_SEC:-3}"

# Cohort spans 2023-10-24 → 2025-04-18. Chunk by month boundaries.
build_months() {
  python3 -c "
import datetime
out = []
# inclusive month windows over the cohort
months = [
    ('2023-10-01','2023-10-31'),('2023-11-01','2023-11-30'),('2023-12-01','2023-12-31'),
    ('2024-01-01','2024-01-31'),('2024-02-01','2024-02-29'),('2024-03-01','2024-03-31'),
    ('2024-04-01','2024-04-30'),
    ('2024-10-01','2024-10-31'),('2024-11-01','2024-11-30'),('2024-12-01','2024-12-31'),
    ('2025-01-01','2025-01-31'),('2025-02-01','2025-02-28'),('2025-03-01','2025-03-31'),
    ('2025-04-01','2025-04-30'),
]
for s, e in months:
    print(f'{s},{e}')
"
}

TOTAL_RESCORED=0
TOTAL_FAILURES=0
TOTAL_OPP_DEF_SIGNAL=0
BATCH_IDX=0

while IFS=',' read -r START END; do
  BATCH_IDX=$((BATCH_IDX + 1))
  echo "[$(date +%H:%M:%S)] batch ${BATCH_IDX} → ${START}..${END}"
  RESP=$(curl --silent --show-error --max-time 180 \
    -X POST "$ENDPOINT" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"start_date\":\"${START}\",\"end_date\":\"${END}\"}")
  echo "  $(echo "$RESP" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f\"total={d.get('summary',{}).get('total',0)} rescored={d.get('summary',{}).get('rescored',0)} no_change={d.get('summary',{}).get('skipped_no_change',0)} opp_signal={d.get('summary',{}).get('opp_defense_signal_count',0)} failures={d.get('summary',{}).get('update_failures',0)}\")" 2>/dev/null || echo "<parse-failed: $RESP>")"
  R=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('summary',{}).get('rescored',0))" 2>/dev/null || echo 0)
  F=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('summary',{}).get('update_failures',0))" 2>/dev/null || echo 0)
  S=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('summary',{}).get('opp_defense_signal_count',0))" 2>/dev/null || echo 0)
  TOTAL_RESCORED=$((TOTAL_RESCORED + R))
  TOTAL_FAILURES=$((TOTAL_FAILURES + F))
  TOTAL_OPP_DEF_SIGNAL=$((TOTAL_OPP_DEF_SIGNAL + S))
  sleep "$INTER_SLEEP_SEC"
done < <(build_months)

echo
echo "=== rescore orchestration complete ==="
echo "Batches: $BATCH_IDX"
echo "Total rescored: $TOTAL_RESCORED"
echo "Total opp_defense signal lifts: $TOTAL_OPP_DEF_SIGNAL"
echo "Total update failures: $TOTAL_FAILURES"
