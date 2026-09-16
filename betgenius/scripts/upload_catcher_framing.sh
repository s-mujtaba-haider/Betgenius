#!/usr/bin/env bash
# upload_catcher_framing.sh — D-282 SHIP 2
#
# Upload Baseball Savant catcher framing CSV to the
# cache_statcast_catcher_framing table.
#
# Usage:
#   bash scripts/upload_catcher_framing.sh /path/to/savant_catcher_framing.csv
#
# Requires SUPABASE_SERVICE_ROLE_KEY in env (sourced from .env.local
# if present).
#
# See docs/loop/playbooks/catcher_framing_weekly.md for the full
# CEO workflow.

set -e

if [ -z "$1" ]; then
  echo "Usage: bash scripts/upload_catcher_framing.sh /path/to/file.csv"
  exit 1
fi

CSV_PATH="$1"
[ -f "$CSV_PATH" ] || { echo "ERROR: file not found: $CSV_PATH"; exit 1; }

# Source env if available
if [ -z "${SUPABASE_SERVICE_ROLE_KEY:-}" ]; then
  if [ -f ".env.local" ]; then
    set -a; source .env.local; set +a
  fi
fi
: "${SUPABASE_SERVICE_ROLE_KEY:?must be set (export or .env.local)}"
URL="${VITE_SUPABASE_URL:-https://gzuzuqxvfjszlfclhcfz.supabase.co}"

echo "Uploading $CSV_PATH to ingest-catcher-framing-csv..."
RESP=$(curl -sS -X POST "$URL/functions/v1/ingest-catcher-framing-csv" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: text/csv" \
  --data-binary @"$CSV_PATH" \
  --max-time 60)

echo "$RESP" | python3 -m json.tool

# Quick verify
echo ""
echo "Post-upload row count for today's snapshot_date:"
TODAY=$(date -u -v-4H +%Y-%m-%d 2>/dev/null || date -u --date='-4 hours' +%Y-%m-%d)
curl -sS "$URL/rest/v1/cache_statcast_catcher_framing?snapshot_date=eq.$TODAY&select=count" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Prefer: count=exact" -H "Range-Unit: items" -H "Range: 0-0" -I 2>&1 \
  | grep -i 'content-range' || echo "(no rows visible)"
