DO $$
DECLARE r RECORD; v_n INT;
BEGIN
  -- 1. Recent migrations applied
  RAISE NOTICE '[D-512 §1] last 25 migrations applied:';
  FOR r IN
    SELECT version FROM supabase_migrations.schema_migrations
    ORDER BY version DESC LIMIT 25
  LOOP RAISE NOTICE '  %', r.version; END LOOP;

  -- 2. All cron jobs
  RAISE NOTICE '[D-512 §2] all cron jobs:';
  FOR r IN SELECT jobid, jobname, schedule, active FROM cron.job ORDER BY jobid
  LOOP RAISE NOTICE '  jobid=% name=% sched=% active=%',
    r.jobid, r.jobname, r.schedule, r.active; END LOOP;

  -- 3. D-499 weights live in algorithm_weights
  RAISE NOTICE '[D-512 §3] algorithm_weights — recent updates (last 20 by updated_at):';
  BEGIN
    FOR r IN
      SELECT weight_key, weight_value, updated_at
      FROM public.algorithm_weights
      WHERE updated_at > '2026-06-08'::DATE
      ORDER BY updated_at DESC LIMIT 25
    LOOP RAISE NOTICE '  key=% value=% updated=%', r.weight_key, r.weight_value, r.updated_at; END LOOP;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE '  algorithm_weights query error: %', SQLERRM; END;

  -- 4. idx_ph_unresolved_recent (D-506)
  RAISE NOTICE '[D-512 §4] D-506 partial index check:';
  SELECT count(*) INTO v_n FROM pg_indexes
    WHERE schemaname='public' AND indexname='idx_ph_unresolved_recent';
  RAISE NOTICE '  idx_ph_unresolved_recent exists: %', v_n;

  -- 5. CLV columns (D-511)
  RAISE NOTICE '[D-512 §5] D-511 CLV columns check:';
  SELECT count(*) INTO v_n FROM information_schema.columns
   WHERE table_schema='public' AND table_name='pick_history'
     AND column_name IN ('closing_odds','closing_line','clv_pct',
                         'closing_captured_at','closing_capture_reason');
  RAISE NOTICE '  pick_history CLV columns: % of 5', v_n;

  SELECT count(*) INTO v_n FROM pg_indexes
    WHERE schemaname='public' AND indexname='idx_ph_closing_pending';
  RAISE NOTICE '  idx_ph_closing_pending exists: %', v_n;

  -- 6. allowed_emails table + RLS policy (D-500)
  RAISE NOTICE '[D-512 §6] D-500 allowed_emails check:';
  BEGIN
    SELECT count(*) INTO v_n FROM public.allowed_emails;
    RAISE NOTICE '  allowed_emails row count: %', v_n;
    -- check RLS enabled
    FOR r IN
      SELECT relrowsecurity AS rls_enabled FROM pg_class
      WHERE relname='allowed_emails' AND relnamespace=(SELECT oid FROM pg_namespace WHERE nspname='public')
    LOOP RAISE NOTICE '  RLS enabled: %', r.rls_enabled; END LOOP;
    -- check policies
    FOR r IN
      SELECT policyname, cmd, roles FROM pg_policies
      WHERE schemaname='public' AND tablename='allowed_emails'
    LOOP RAISE NOTICE '  policy=% cmd=% roles=%', r.policyname, r.cmd, r.roles; END LOOP;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE '  allowed_emails error: %', SQLERRM; END;

  -- 7. Resolution freshness — max(game_date) in pick_history_real and pending old picks
  RAISE NOTICE '[D-512 §7] resolution freshness:';
  FOR r IN
    SELECT max(game_date) AS max_gd, count(*) AS n_real
    FROM public.pick_history_real WHERE is_synthetic=false
  LOOP RAISE NOTICE '  pick_history_real: max_gd=% n=%', r.max_gd, r.n_real; END LOOP;

  -- pending > 3 days old
  SELECT count(*) INTO v_n FROM public.pick_history
   WHERE hit IS NULL AND resolved_at IS NULL AND voided <> true
     AND is_synthetic=false
     AND game_date < (NOW() AT TIME ZONE 'America/New_York')::DATE - 3;
  RAISE NOTICE '  pending > 3 days old: %', v_n;

  -- 8. D-499/510 algorithm_weights: specific 7 D-499 weights (look for the SHIP 2+3 batch)
  -- pulled from D-499 spec — list any weights changed on or after D-499 apply date
  RAISE NOTICE '[D-512 §8] D-499 weight-apply records (any updates 2026-06-10):';
  BEGIN
    FOR r IN
      SELECT weight_key, weight_value, updated_at
      FROM public.algorithm_weights
      WHERE updated_at::DATE = '2026-06-10'::DATE
      ORDER BY updated_at LIMIT 20
    LOOP RAISE NOTICE '  key=% value=% updated=%', r.weight_key, r.weight_value, r.updated_at; END LOOP;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE '  query error: %', SQLERRM; END;

  -- 9. D-509/510 quick cluster check on TODAY's picks
  RAISE NOTICE '[D-512 §9] D-509/D-510 cluster check on today (should be 0):';
  FOR r IN
    SELECT count(*) FILTER (WHERE pick_side='over' AND confidence>=80 AND odds>=150
                              AND mlb_market_type NOT IN ('batter_hr')) AS cluster_n,
           count(*) FILTER (WHERE pick_side='over' AND confidence>=80
                              AND mlb_market_type='game_total') AS game_total_n,
           count(*) FILTER (WHERE pick_side='over' AND confidence>=80 AND odds>=150
                              AND mlb_market_type='batter_rbis') AS rbi_n,
           count(*) FILTER (WHERE pick_side='over' AND confidence>=80 AND odds>=150
                              AND mlb_market_type='batter_hr') AS hr_carveout_n
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false
      AND game_date=(NOW() AT TIME ZONE 'America/New_York')::DATE
  LOOP RAISE NOTICE '  cluster_excl_carveout=% game_total=% rbi_should_be_0=% hr_carveout_should_be_nonzero=%',
    r.cluster_n, r.game_total_n, r.rbi_n, r.hr_carveout_n; END LOOP;

  -- 10. D-508 volume shard checkpoint (last 30 min, should show post_d508_volume_shard payload)
  RAISE NOTICE '[D-512 §10] D-508 last process-games-mlb checkpoint markers (last 12h):';
  FOR r IN
    SELECT created_at, error_message,
           context->>'cap_projected_picks' AS cap, context->>'picks_per_prop_rate' AS rate
    FROM public.error_log
    WHERE created_at > NOW() - INTERVAL '12 hours'
      AND function_name='process-games-mlb' AND error_message='post_d508_volume_shard'
    ORDER BY created_at DESC LIMIT 3
  LOOP RAISE NOTICE '  at=% cap=% rate=%', r.created_at, r.cap, r.rate; END LOOP;

  -- 11. CLV cron health
  RAISE NOTICE '[D-512 §11] D-511 CLV cron health:';
  FOR r IN
    SELECT jobid, jobname, schedule, active FROM cron.job
    WHERE jobname='capture-closing-odds-mlb-5min'
  LOOP RAISE NOTICE '  jobid=% sched=% active=%', r.jobid, r.schedule, r.active; END LOOP;

  -- 12. D-511 capture function exists + helper
  RAISE NOTICE '[D-512 §12] D-511 SQL functions present:';
  SELECT count(*) INTO v_n FROM pg_proc
    WHERE proname='capture_closing_odds_mlb' AND pronamespace=(SELECT oid FROM pg_namespace WHERE nspname='public');
  RAISE NOTICE '  capture_closing_odds_mlb: %', v_n;
  SELECT count(*) INTO v_n FROM pg_proc
    WHERE proname='_d511_implied_prob' AND pronamespace=(SELECT oid FROM pg_namespace WHERE nspname='public');
  RAISE NOTICE '  _d511_implied_prob: %', v_n;
END $$;
