DO $$
DECLARE r RECORD; v_n_now BIGINT; v_n_mlb_now BIGINT;
BEGIN
  -- Pull the response of request_id=12078
  FOR r IN SELECT status_code, content, error_msg, created
   FROM net._http_response WHERE id = 12078
  LOOP
    RAISE NOTICE '[D-506 RESP] status=% created=% error=%',
      r.status_code, r.created, COALESCE(r.error_msg, '<none>');
    IF r.content IS NOT NULL THEN
      RAISE NOTICE '[D-506 RESP body 0-2000]: %', substring(r.content, 1, 2000);
      IF length(r.content) > 2000 THEN
        RAISE NOTICE '[D-506 RESP body 2000-4000]: %', substring(r.content, 2001, 2000);
      END IF;
    END IF;
  END LOOP;

  -- Has anything resolved as a result?
  SELECT count(*) INTO v_n_now FROM public.pick_history
    WHERE hit IS NULL AND resolved_at IS NULL AND voided IS DISTINCT FROM true
      AND is_synthetic = false AND game_date >= DATE '2026-05-30';
  SELECT count(*) INTO v_n_mlb_now FROM public.pick_history
    WHERE hit IS NULL AND resolved_at IS NULL AND voided IS DISTINCT FROM true
      AND is_synthetic = false AND game_date >= DATE '2026-05-30' AND sport='mlb';
  RAISE NOTICE '[D-506] pending post-trigger: total=% mlb=%', v_n_now, v_n_mlb_now;

  -- Has anything been recently RESOLVED (any sport)?
  FOR r IN SELECT count(*) AS n, max(resolved_at) AS most_recent FROM public.pick_history
    WHERE resolved_at >= NOW() - INTERVAL '15 minutes' AND is_synthetic = false
  LOOP
    RAISE NOTICE '[D-506] picks resolved in last 15min: % most_recent=%', r.n, r.most_recent;
  END LOOP;
END $$;
