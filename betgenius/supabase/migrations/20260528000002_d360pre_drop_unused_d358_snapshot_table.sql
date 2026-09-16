-- D-360-PRE SHIP 1 Op 3 — drop unused cache_mlb_historical_odds_snapshot table.
--
-- Background: D-358 SHIP 1 created this table assuming it would hold the
-- 2026 historical odds backfill. The SHIP 2 pre-flight (d358_ship2_preflight.md)
-- found that the existing D-289 `cache_mlb_historical_odds` table already
-- carried the data shape we needed. This snapshot table was never populated
-- — verified 0 rows immediately before this drop (d360pre_cleanup_log.md
-- Operation 3 pre-check).
--
-- Rollback: re-apply migration 20260527000015_d358_historical_odds_snapshot.sql.

DROP TABLE IF EXISTS public.cache_mlb_historical_odds_snapshot CASCADE;
