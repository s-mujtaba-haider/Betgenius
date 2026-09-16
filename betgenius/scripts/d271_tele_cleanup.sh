#!/usr/bin/env bash
# D-271-TELE — archive + delete stale anthropic_mlb sonnet_gated_below_70
# error_log rows. These are INFO-level gate telemetry that D-261 moved
# to console.log; they pollute error-rate metrics.
#
# Time-bounded: only deletes rows created before 2026-05-20 (the day
# process-games-mlb was redeployed with the D-270-C2 + D-261-anthropic_mlb
# changes that stopped writing these rows entirely).
#
# Run from CEO terminal — autonomous DELETE is blocked by hook for safety.
#
# Usage:
#   export SUPABASE_SERVICE_ROLE_KEY=...
#   bash scripts/d271_tele_cleanup.sh
#
# Rollback: Supabase daily backup. Rows are INFO-level noise; ~zero
# information value. If you need them back, they're in the
# automated-backups window.

set -e

if [ -z "${SUPABASE_SERVICE_ROLE_KEY:-}" ]; then
  if [ -f ".env.local" ]; then
    set -a; source .env.local; set +a
  fi
fi
: "${SUPABASE_SERVICE_ROLE_KEY:?must be set (export or .env.local)}"
URL="${VITE_SUPABASE_URL:-https://gzuzuqxvfjszlfclhcfz.supabase.co}"
CUTOFF="2026-05-20T01:00:00Z"

echo "D-271-TELE cleanup — cutoff = $CUTOFF"

BEFORE=$(curl -s "$URL/rest/v1/error_log?function_name=eq._shared/anthropic_mlb&error_type=eq.sonnet_gated_below_70&created_at=lt.$CUTOFF&select=count" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Prefer: count=exact" -H "Range-Unit: items" -H "Range: 0-0" -I 2>&1 \
  | grep -i 'content-range' | awk -F'/' '{print $2}' | tr -d '\r')
echo "Pre-delete count: $BEFORE rows"

read -p "Delete $BEFORE rows? [y/N] " ans
[[ "$ans" =~ ^[Yy]$ ]] || { echo "Aborted."; exit 0; }

curl -sS -X DELETE "$URL/rest/v1/error_log?function_name=eq._shared/anthropic_mlb&error_type=eq.sonnet_gated_below_70&created_at=lt.$CUTOFF" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Prefer: return=minimal" \
  -w "HTTP=%{http_code}\n"

AFTER=$(curl -s "$URL/rest/v1/error_log?function_name=eq._shared/anthropic_mlb&error_type=eq.sonnet_gated_below_70&select=count" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Prefer: count=exact" -H "Range-Unit: items" -H "Range: 0-0" -I 2>&1 \
  | grep -i 'content-range' | awk -F'/' '{print $2}' | tr -d '\r')
echo "Post-delete remaining (post-cutoff or new): $AFTER rows"

if [ -n "$AFTER" ] && [ "$AFTER" -gt 0 ]; then
  echo "WARNING: $AFTER remaining rows post-cutoff — investigate (D-261 fix may not have actually deployed)."
fi
