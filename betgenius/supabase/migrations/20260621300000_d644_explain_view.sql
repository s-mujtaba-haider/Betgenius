-- D-644 — diagnose the real_money_bets timeout via EXPLAIN ANALYZE of
-- the actual Performance.tsx query. Shape per src/pages/Performance.tsx:424
--   GET /rest/v1/real_money_bets?user_id=eq.<uid>
--       &order=placed_at.desc,bet_id.desc&limit=1000
--
-- Run as authenticated role (PostgREST executes under the JWT role).
-- RLS plan + the view's ranked_matches CTE both contribute to the cost.
-- We measure the full pipeline.
--
-- Rollback: DROP FUNCTION via 20260621301000_d644_drop_diag.sql

CREATE OR REPLACE FUNCTION public.d644_explain_perf_query(p_user_id UUID DEFAULT NULL)
RETURNS TEXT
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_catalog, pg_temp
AS $$
DECLARE
  uid UUID := p_user_id;
  out TEXT := '';
  r   RECORD;
BEGIN
  SET LOCAL statement_timeout = '120s';
  IF uid IS NULL THEN
    SELECT id INTO uid FROM auth.users WHERE email = 'admin@example.com' LIMIT 1;
    IF uid IS NULL THEN uid := '00000000-0000-0000-0000-000000000001'; END IF;
  END IF;
  out := out || E'user_id=' || uid::TEXT || E'\n\n';
  FOR r IN
    EXPLAIN (ANALYZE TRUE, BUFFERS TRUE, VERBOSE FALSE, FORMAT TEXT)
    SELECT bet_id, user_id, placed_at, settled_at, player_name, prop_type,
           line, pick_side, odds, stake, status, result_value, payout, book,
           bet_game_date_et, matched_pick_id, matched_pick_source,
           matched_pick_confidence, matched_pick_game_date,
           matched_pick_created_at, is_matched, sport
    FROM public.real_money_bets
    WHERE user_id = uid
    ORDER BY placed_at DESC, bet_id DESC
    LIMIT 1000
  LOOP
    out := out || r."QUERY PLAN" || E'\n';
  END LOOP;
  RETURN out;
END $$;
GRANT EXECUTE ON FUNCTION public.d644_explain_perf_query(UUID) TO service_role;

CREATE OR REPLACE FUNCTION public.d644_time_perf_query(p_user_id UUID DEFAULT NULL)
RETURNS TABLE (label TEXT, ms NUMERIC, rows_returned INT, err TEXT)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_catalog, pg_temp
AS $$
DECLARE
  uid UUID := p_user_id;
  t0  TIMESTAMPTZ;
  n   INT;
BEGIN
  SET LOCAL statement_timeout = '60s';
  IF uid IS NULL THEN
    SELECT id INTO uid FROM auth.users WHERE email = 'admin@example.com' LIMIT 1;
    IF uid IS NULL THEN uid := '00000000-0000-0000-0000-000000000001'; END IF;
  END IF;
  t0 := clock_timestamp();
  BEGIN
    SELECT COUNT(*) INTO n FROM (
      SELECT bet_id FROM public.real_money_bets
      WHERE user_id = uid
      ORDER BY placed_at DESC, bet_id DESC LIMIT 1000
    ) t;
    RETURN QUERY SELECT 'perf_real_money_bets'::TEXT,
      ROUND(EXTRACT(EPOCH FROM (clock_timestamp() - t0))::NUMERIC * 1000, 1),
      n, NULL::TEXT;
  EXCEPTION WHEN OTHERS THEN
    RETURN QUERY SELECT 'perf_real_money_bets'::TEXT,
      ROUND(EXTRACT(EPOCH FROM (clock_timestamp() - t0))::NUMERIC * 1000, 1),
      0,
      SQLERRM || ' (state=' || SQLSTATE || ')';
  END;
END $$;
GRANT EXECUTE ON FUNCTION public.d644_time_perf_query(UUID) TO service_role;

-- Inventory of relevant indexes on pick_history (to confirm what's missing).
CREATE OR REPLACE FUNCTION public.d644_ph_join_indexes()
RETURNS TABLE (indexname TEXT, indexdef TEXT)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_catalog, pg_temp
AS $$
BEGIN
  RETURN QUERY
  SELECT i.indexname::TEXT, i.indexdef::TEXT
  FROM pg_indexes i
  WHERE i.tablename = 'pick_history'
    AND (i.indexdef ILIKE '%player_name%'
      OR i.indexdef ILIKE '%lower%'
      OR i.indexdef ILIKE '%prop_type%'
      OR i.indexdef ILIKE '%pick_side%')
  ORDER BY i.indexname;
END $$;
GRANT EXECUTE ON FUNCTION public.d644_ph_join_indexes() TO service_role;
