-- D-643 — one-off helpers to invoke resolve-picks via pg_net (vault auth)
-- and to insert+remove a small test cohort of pending bets that exercise
-- the 3 new paths. Throwaway; dropped via 20260621201000 after verify.

-- Trigger resolve-picks. Dry-run flag honored by the function.
CREATE OR REPLACE FUNCTION public.d643_fire_resolve_picks(p_dry_run BOOLEAN DEFAULT TRUE)
RETURNS BIGINT
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, extensions, pg_temp
AS $$
DECLARE rid BIGINT;
BEGIN
  SELECT net.http_post(
    url := 'https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/resolve-picks',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'BACKFILL_AUTH_TOKEN' LIMIT 1),
      'Content-Type', 'application/json'
    ),
    body := jsonb_build_object('dry_run', p_dry_run),
    timeout_milliseconds := 180000
  ) INTO rid;
  RETURN rid;
END $$;
GRANT EXECUTE ON FUNCTION public.d643_fire_resolve_picks(BOOLEAN) TO service_role;

-- Read the net response body for a given request id.
CREATE OR REPLACE FUNCTION public.d643_net_response(p_request_id BIGINT)
RETURNS TABLE (status INT, body TEXT)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, extensions, pg_temp
AS $$
BEGIN
  SET LOCAL statement_timeout = '20s';
  RETURN QUERY
  SELECT (response).status_code, LEFT((response).body::text, 4000)
  FROM net._http_response WHERE id = p_request_id;
END $$;
GRANT EXECUTE ON FUNCTION public.d643_net_response(BIGINT) TO service_role;

-- Insert 3 test bets to exercise SHIP 1, 2, 3. Uses the existing
-- admin seed user_id (CEO seed). All synthetic; deleted by
-- d643_cleanup_test_bets() after verification.
CREATE OR REPLACE FUNCTION public.d643_insert_test_bets()
RETURNS TEXT[]
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
  uid UUID;
  ids TEXT[] := ARRAY[]::TEXT[];
  bid UUID;
BEGIN
  SELECT id INTO uid FROM auth.users WHERE email = 'admin@example.com' LIMIT 1;
  IF uid IS NULL THEN
    -- Fallback to the system seed id used by D-641-era bets.
    uid := '00000000-0000-0000-0000-000000000001';
  END IF;

  -- TEST 1 — SHIP 1 + 2: NULL pick_id MLB player prop on a known
  -- Final game from yesterday (Paul Goldschmidt total_bases — same
  -- shape D-641 drained). placed_at WITHIN 6h to verify removal of
  -- the 6h skip; game_date older so it's safely Final.
  INSERT INTO public.bets (
    id, user_id, pick_id, player_name, prop_type, line, pick_side,
    odds, stake, sport, status, placed_at, book
  ) VALUES (
    gen_random_uuid(), uid, NULL, 'Paul Goldschmidt', 'total_bases',
    1.5, 'over', -120, 10, 'mlb', 'pending',
    (NOW() - INTERVAL '2 hours'), 'hard_rock'
  ) RETURNING id::TEXT INTO bid;
  ids := array_append(ids, bid::TEXT);

  -- TEST 2 — SHIP 3: matchup-tag game-side bet. Same yesterday game.
  INSERT INTO public.bets (
    id, user_id, pick_id, player_name, prop_type, line, pick_side,
    odds, stake, sport, status, placed_at, book
  ) VALUES (
    gen_random_uuid(), uid, NULL,
    'New York Yankees vs Cincinnati Reds (side home)', 'spreads',
    -1.5, 'home', 110, 10, 'mlb', 'pending',
    (NOW() - INTERVAL '3 hours'), 'hard_rock'
  ) RETURNING id::TEXT INTO bid;
  ids := array_append(ids, bid::TEXT);

  -- TEST 3 — SHIP 3 total: game_total over/under.
  INSERT INTO public.bets (
    id, user_id, pick_id, player_name, prop_type, line, pick_side,
    odds, stake, sport, status, placed_at, book
  ) VALUES (
    gen_random_uuid(), uid, NULL,
    'Cleveland Guardians vs New York Yankees (total over)', 'game_total',
    8.0, 'over', -110, 10, 'mlb', 'pending',
    (NOW() - INTERVAL '2 hours 30 minutes'), 'hard_rock'
  ) RETURNING id::TEXT INTO bid;
  ids := array_append(ids, bid::TEXT);

  RETURN ids;
END $$;
GRANT EXECUTE ON FUNCTION public.d643_insert_test_bets() TO service_role;

CREATE OR REPLACE FUNCTION public.d643_cleanup_test_bets(p_ids TEXT[])
RETURNS INT
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE n INT;
BEGIN
  DELETE FROM public.bets WHERE id::TEXT = ANY(p_ids);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
GRANT EXECUTE ON FUNCTION public.d643_cleanup_test_bets(TEXT[]) TO service_role;

-- Read the current status of a list of test bet ids.
CREATE OR REPLACE FUNCTION public.d643_read_bets(p_ids TEXT[])
RETURNS TABLE (
  id            UUID,
  pick_id       UUID,
  player_name   TEXT,
  prop_type     TEXT,
  pick_side     TEXT,
  status        TEXT,
  result_value  NUMERIC,
  payout        NUMERIC,
  settled_at    TIMESTAMPTZ
)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = public, pg_temp
AS $$
BEGIN
  SET LOCAL statement_timeout = '15s';
  RETURN QUERY
  SELECT b.id, b.pick_id, b.player_name, b.prop_type, b.pick_side,
         b.status, b.result_value, b.payout, b.settled_at
  FROM public.bets b WHERE b.id::TEXT = ANY(p_ids);
END $$;
GRANT EXECUTE ON FUNCTION public.d643_read_bets(TEXT[]) TO service_role;
