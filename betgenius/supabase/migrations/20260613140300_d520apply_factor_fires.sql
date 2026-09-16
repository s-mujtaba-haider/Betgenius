-- D-520-APPLY SHIP 2 §E + §F (v1 superseded by 20260613140400_d520apply_factor_fires_v2.sql)
-- v1 errored on `mlb_market_type` column reference for recommendations_cache
-- (that table uses a different column). v2 fixes via dynamic SQL. This file
-- is left as a no-op so the migration history stays linear.
DO $$ BEGIN
  RAISE NOTICE '[D-520-APPLY 140300] no-op — superseded by 140400_v2.';
END $$;
