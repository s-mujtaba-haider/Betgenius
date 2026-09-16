-- D-529 SHIP 2 — RPC for the X10 drift detector.
--
-- Returns the canonical definition string of the
-- `pick_history_mlb_market_type_check` CHECK constraint so the
-- pick_history_writer's drift detector (assertMlbMarketTypeSetSynced)
-- can compare against the in-code ALLOWED_MLB_MARKET_TYPES Set.
--
-- The detector runs hourly via sonnet-health-monitor and writes a
-- `mlb_market_type_constraint_drift` row into health_status if the
-- constraint and the in-code Set diverge — the D-481 sibling pattern.
CREATE OR REPLACE FUNCTION public.d529_get_mlb_market_type_constraint_def()
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
  SELECT pg_get_constraintdef(c.oid)
  FROM pg_constraint c
  WHERE c.conrelid = 'public.pick_history'::regclass
    AND c.contype = 'c'
    AND c.conname = 'pick_history_mlb_market_type_check'
  LIMIT 1;
$$;

-- The detector is called from edge functions using either the
-- service-role key OR the BACKFILL_AUTH_TOKEN. anon should not be able
-- to read this (it's not sensitive but there's no reason to expose it).
REVOKE EXECUTE ON FUNCTION public.d529_get_mlb_market_type_constraint_def() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.d529_get_mlb_market_type_constraint_def() TO authenticated;
GRANT  EXECUTE ON FUNCTION public.d529_get_mlb_market_type_constraint_def() TO service_role;

DO $$
DECLARE r RECORD;
BEGIN
  -- Smoke: invoke the function and print the result so we know it works.
  RAISE NOTICE '[D-529 §B] RPC smoke:';
  FOR r IN SELECT public.d529_get_mlb_market_type_constraint_def() AS def
  LOOP RAISE NOTICE '  def=%', r.def; END LOOP;
END $$;
