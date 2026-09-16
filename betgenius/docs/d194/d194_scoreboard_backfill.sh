#!/usr/bin/env bash
# D-194 — cache_game_scoreboard backfill orchestrator.
#
# Chunks the full historical date set into per-invocation batches sized to
# fit the 150s edge function ceiling. With 1100ms BDL pacing + 30s per-fetch
# timeout (D-191b discipline), each invocation safely handles ~30 dates
# (worst case ~33s wall-clock per date counting pagination + UPSERT).
#
# Pre-flight check:
#   • backfill-game-scoreboard edge function deployed
#   • BALLDONTLIE_API_KEY in Supabase secrets (verify: supabase secrets list)
#   • BACKFILL_AUTH_TOKEN in environment, OR use SUPABASE_SERVICE_ROLE_KEY
#   • PROJECT_REF set to the Supabase project ref
#
# Usage:
#   PROJECT_REF=gzuzuqxvfjszlfclhcfz \
#   BACKFILL_AUTH_TOKEN=... \
#   bash docs/d194/d194_scoreboard_backfill.sh
#
# Resume-safe: re-running on already-backfilled dates re-UPSERTs (no harm).
# Idempotent on the function side via PK (game_id, sport).

set -euo pipefail

PROJECT_REF="${PROJECT_REF:-gzuzuqxvfjszlfclhcfz}"
TOKEN="${BACKFILL_AUTH_TOKEN:?BACKFILL_AUTH_TOKEN required (or pass SUPABASE_SERVICE_ROLE_KEY)}"
ENDPOINT="https://${PROJECT_REF}.supabase.co/functions/v1/backfill-game-scoreboard"

INTER_BATCH_SLEEP_SEC="${INTER_BATCH_SLEEP_SEC:-10}"  # gentle on BDL between batches
BATCH_SIZE="${BATCH_SIZE:-25}"                          # dates per invocation; ~28s wall-clock worst case

# Full historical date set to backfill. Three cohorts per task spec:
#   D-185:   Oct 22 - Dec 31 2024 (NBA regular season opening)
#   D-191P2: Jan 1 - Apr 30 2025 (mid-season + playoffs)
#   D-191P3: Oct 24 2023 - Apr 14 2024 (previous season)
#
# Build the date list by iterating from start to end inclusive.
# (Calls Python for portable date arithmetic — macOS `date` differs from GNU.)

build_date_list() {
  python3 -c "
import datetime, sys
start, end = sys.argv[1], sys.argv[2]
d = datetime.date.fromisoformat(start)
e = datetime.date.fromisoformat(end)
out = []
while d <= e:
    out.append(d.isoformat())
    d += datetime.timedelta(days=1)
print('\n'.join(out))
" "$1" "$2"
}

ALL_DATES=()
while IFS= read -r d; do ALL_DATES+=("$d"); done < <(build_date_list 2024-10-22 2024-12-31)
while IFS= read -r d; do ALL_DATES+=("$d"); done < <(build_date_list 2025-01-01 2025-04-30)
while IFS= read -r d; do ALL_DATES+=("$d"); done < <(build_date_list 2023-10-24 2024-04-14)

echo "Total dates: ${#ALL_DATES[@]}"
echo "Batch size: $BATCH_SIZE"
echo "Inter-batch sleep: ${INTER_BATCH_SLEEP_SEC}s"
echo "Endpoint: $ENDPOINT"
echo

TOTAL_LANDED=0
TOTAL_FAILED=0
TOTAL_BATCHES=$(( (${#ALL_DATES[@]} + BATCH_SIZE - 1) / BATCH_SIZE ))
BATCH_IDX=0

for ((i=0; i<${#ALL_DATES[@]}; i+=BATCH_SIZE)); do
  BATCH_IDX=$((BATCH_IDX + 1))
  CHUNK=("${ALL_DATES[@]:i:BATCH_SIZE}")
  # Build JSON array of dates
  JSON_DATES=$(printf '"%s",' "${CHUNK[@]}")
  JSON_DATES="[${JSON_DATES%,}]"

  LAST_IDX=$((${#CHUNK[@]} - 1))
  echo "[$(date +%H:%M:%S)] batch ${BATCH_IDX}/${TOTAL_BATCHES} → ${#CHUNK[@]} dates (${CHUNK[0]} → ${CHUNK[$LAST_IDX]})"

  RESP=$(curl --silent --show-error --max-time 180 \
    -X POST "$ENDPOINT" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d "{\"dates\":${JSON_DATES}}")

  echo "  response: $RESP"

  LANDED=$(echo "$RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('games_landed',0))" 2>/dev/null || echo 0)
  FAILED=$(echo "$RESP" | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('dates_failed',[])))" 2>/dev/null || echo 0)
  TOTAL_LANDED=$((TOTAL_LANDED + LANDED))
  TOTAL_FAILED=$((TOTAL_FAILED + FAILED))

  if [[ $BATCH_IDX -lt $TOTAL_BATCHES ]]; then
    sleep "$INTER_BATCH_SLEEP_SEC"
  fi
done

echo
echo "=== D-194 orchestration complete ==="
echo "Batches: $TOTAL_BATCHES"
echo "Total games landed: $TOTAL_LANDED"
echo "Total dates failed: $TOTAL_FAILED"
echo
echo "Next steps:"
echo "  1. Run verification queries (docs/d194/d194_verification.sql) to confirm coverage."
echo "  2. Invoke rescore-backfill-picks endpoint for the same date cohort to lift opp_defense signal."
echo "  3. Re-run verification post-rescore for tier-distribution shift."
