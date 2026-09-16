-- D-644 — plan-only EXPLAIN (no execution), since the actual query
-- times out under 120s and can't complete ANALYZE.
CREATE OR REPLACE FUNCTION public.d644_explain_plan_only(p_user_id UUID DEFAULT NULL)
RETURNS TEXT
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_catalog, pg_temp
AS $$
DECLARE
  uid UUID := p_user_id;
  out TEXT := '';
  r   RECORD;
BEGIN
  SET LOCAL statement_timeout = '30s';
  IF uid IS NULL THEN
    SELECT id INTO uid FROM auth.users WHERE email = 'admin@example.com' LIMIT 1;
    IF uid IS NULL THEN uid := '00000000-0000-0000-0000-000000000001'; END IF;
  END IF;
  out := out || E'user_id=' || uid::TEXT || E'\n\n';
  FOR r IN
    EXPLAIN (VERBOSE FALSE, FORMAT TEXT)
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
GRANT EXECUTE ON FUNCTION public.d644_explain_plan_only(UUID) TO service_role;
