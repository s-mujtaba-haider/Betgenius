#!/usr/bin/env bash
# D-194 metric capture — pre/post-rescore aggregate counts.
#
# Usage:
#   bash docs/d194/d194_metrics.sh
#
# Reads via PostgREST with service-role key from .env.local.

set -euo pipefail
ENVF="/Users/matthewperdomo/Desktop/betting-deploy/betgenius/.env.local"
set -a; . "$ENVF"; set +a
SUPA_URL="https://gzuzuqxvfjszlfclhcfz.supabase.co"
H=(-H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY")

cnt() {
  # $1 = filter query; prints count from content-range header
  curl --silent "${H[@]}" "$SUPA_URL/rest/v1/pick_history?$1&select=count" -H "Prefer: count=exact" -I 2>&1 | awk -F'/' '/content-range/{print $NF}' | tr -d '\r\n'
}

cgs_cnt() {
  curl --silent "${H[@]}" "$SUPA_URL/rest/v1/cache_game_scoreboard?$1&select=count" -H "Prefer: count=exact" -I 2>&1 | awk -F'/' '/content-range/{print $NF}' | tr -d '\r\n'
}

# ---------- cache_game_scoreboard coverage ----------
echo "=== cache_game_scoreboard ==="
echo "total NBA rows: $(cgs_cnt 'sport=eq.nba')"
echo "  D-191P3 cohort (2023-10-24..2024-04-14): $(cgs_cnt 'sport=eq.nba&game_date=gte.2023-10-24&game_date=lte.2024-04-14')"
echo "  D-185 cohort   (2024-10-22..2024-12-31): $(cgs_cnt 'sport=eq.nba&game_date=gte.2024-10-22&game_date=lte.2024-12-31')"
echo "  D-191P2 cohort (2025-01-01..2025-04-30): $(cgs_cnt 'sport=eq.nba&game_date=gte.2025-01-01&game_date=lte.2025-04-30')"
echo "  sample-date 2024-11-15: $(cgs_cnt 'sport=eq.nba&game_date=eq.2024-11-15')"
echo

# ---------- pick_history backfill-historical cohort ----------
echo "=== pick_history backfill cohort ==="
echo "total: $(cnt 'source=eq.backfill-historical')"
echo "score_opp_defense=0:    $(cnt 'source=eq.backfill-historical&score_opp_defense=eq.0')"
echo "score_opp_defense!=0:   $(cnt 'source=eq.backfill-historical&score_opp_defense=neq.0')"
echo
echo "--- confidence tier distribution ---"
echo "  90+ (Elite):  $(cnt 'source=eq.backfill-historical&confidence=gte.90')"
echo "  80-89:        $(cnt 'source=eq.backfill-historical&confidence=gte.80&confidence=lt.90')"
echo "  70-79:        $(cnt 'source=eq.backfill-historical&confidence=gte.70&confidence=lt.80')"
echo "  60-69:        $(cnt 'source=eq.backfill-historical&confidence=gte.60&confidence=lt.70')"
echo "  <60 (Pass):   $(cnt 'source=eq.backfill-historical&confidence=lt.60')"
echo
echo "--- Elite-tier resolution stats ---"
echo "  90+ resolved (hit not null): $(cnt 'source=eq.backfill-historical&confidence=gte.90&hit=not.is.null')"
echo "  90+ hit=true:                $(cnt 'source=eq.backfill-historical&confidence=gte.90&hit=is.true')"
echo "  80+ resolved (hit not null): $(cnt 'source=eq.backfill-historical&confidence=gte.80&hit=not.is.null')"
echo "  80+ hit=true:                $(cnt 'source=eq.backfill-historical&confidence=gte.80&hit=is.true')"
echo "  70+ resolved (hit not null): $(cnt 'source=eq.backfill-historical&confidence=gte.70&hit=not.is.null')"
echo "  70+ hit=true:                $(cnt 'source=eq.backfill-historical&confidence=gte.70&hit=is.true')"
echo
echo "--- audit column populated ---"
echo "  confidence_pre_d186_phase4 not null: $(cnt 'source=eq.backfill-historical&confidence_pre_d186_phase4=not.is.null')"
