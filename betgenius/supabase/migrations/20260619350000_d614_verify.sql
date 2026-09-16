-- D-614 SHIP 3 verify — confirm NaN fix is working.

DO $$
DECLARE
  r RECORD;
  v_nan_60       bigint;
  v_nan_60_prior bigint;
  v_diag_60      bigint;
  v_diag_60_prior bigint;
  v_picks_60     bigint;
  v_picks_60_prior bigint;
  v_picks_hits_60 bigint;
  v_picks_hr_60   bigint;
  v_picks_tb_60   bigint;
  v_last_diag     timestamptz;
  v_first_diag    timestamptz;
BEGIN
  SET LOCAL statement_timeout TO '60s';

  RAISE NOTICE '════════════════════════════════════════════════════════════════';
  RAISE NOTICE 'D-614 verify — NaN-fix landed?';
  RAISE NOTICE '════════════════════════════════════════════════════════════════';

  -- §A — d611 diagnostic rows (these only fire when confidence is NaN).
  -- If the fix landed, NO new rows appear after the deploy.
  SELECT count(*), min(created_at), max(created_at)
    INTO v_diag_60, v_first_diag, v_last_diag
    FROM public.error_log
   WHERE error_type = 'd611_confidence_nan_diag';
  RAISE NOTICE '';
  RAISE NOTICE '[A] d611_confidence_nan_diag rows total: %', v_diag_60;
  RAISE NOTICE '    first: %  /  last: %', v_first_diag, v_last_diag;

  SELECT count(*) INTO v_diag_60
    FROM public.error_log
   WHERE error_type = 'd611_confidence_nan_diag'
     AND created_at >= (now() - interval '60 minutes');
  SELECT count(*) INTO v_diag_60_prior
    FROM public.error_log
   WHERE error_type = 'd611_confidence_nan_diag'
     AND created_at >= (now() - interval '120 minutes')
     AND created_at <  (now() - interval '60 minutes');
  RAISE NOTICE '[A.window] d611 last 60 min: %  prior 60 min: %', v_diag_60, v_diag_60_prior;

  -- §B — pick_history_validation_failed (NaN-confidence) recent vs prior
  SELECT count(*) INTO v_nan_60
    FROM public.error_log
   WHERE error_type = 'pick_history_validation_failed'
     AND error_message ILIKE '%confidence%non-finite%'
     AND created_at >= (now() - interval '60 minutes');
  SELECT count(*) INTO v_nan_60_prior
    FROM public.error_log
   WHERE error_type = 'pick_history_validation_failed'
     AND error_message ILIKE '%confidence%non-finite%'
     AND created_at >= (now() - interval '120 minutes')
     AND created_at <  (now() - interval '60 minutes');
  RAISE NOTICE '';
  RAISE NOTICE '[B] NaN-rejection count last 60 min: %  prior 60 min: %', v_nan_60, v_nan_60_prior;

  -- §C — batter pick volume last 60 min vs prior 60 min
  SELECT count(*) INTO v_picks_60
    FROM public.pick_history
   WHERE created_at >= (now() - interval '60 minutes')
     AND sport = 'mlb' AND is_synthetic = false
     AND mlb_market_type IN ('batter_hits','batter_hr','batter_total_bases','batter_rbis');
  SELECT count(*) INTO v_picks_60_prior
    FROM public.pick_history
   WHERE created_at >= (now() - interval '120 minutes')
     AND created_at <  (now() - interval '60 minutes')
     AND sport = 'mlb' AND is_synthetic = false
     AND mlb_market_type IN ('batter_hits','batter_hr','batter_total_bases','batter_rbis');
  RAISE NOTICE '';
  RAISE NOTICE '[C] batter pick writes last 60 min: %  prior 60 min: %',
    v_picks_60, v_picks_60_prior;

  SELECT
    count(*) FILTER (WHERE mlb_market_type = 'batter_hits'),
    count(*) FILTER (WHERE mlb_market_type = 'batter_hr'),
    count(*) FILTER (WHERE mlb_market_type = 'batter_total_bases')
    INTO v_picks_hits_60, v_picks_hr_60, v_picks_tb_60
    FROM public.pick_history
   WHERE created_at >= (now() - interval '60 minutes')
     AND sport = 'mlb' AND is_synthetic = false;
  RAISE NOTICE '[C.detail] last 60 min by-market: hits=% hr=% tb=%',
    v_picks_hits_60, v_picks_hr_60, v_picks_tb_60;

  -- §D — spot-check: do recent batter picks now carry a finite
  -- score_opp_pitcher_pitchtype_quality in breakdown JSONB?
  RAISE NOTICE '';
  RAISE NOTICE '[D] recent batter picks: score_opp_pitcher_pitchtype_quality finite?';
  FOR r IN
    SELECT
      created_at,
      mlb_market_type,
      player_name,
      breakdown->>'score_opp_pitcher_pitchtype_quality' AS score_val,
      confidence
    FROM public.pick_history
    WHERE created_at >= (now() - interval '60 minutes')
      AND sport = 'mlb' AND is_synthetic = false
      AND mlb_market_type IN ('batter_hits','batter_hr','batter_total_bases','batter_rbis')
    ORDER BY created_at DESC LIMIT 10
  LOOP
    RAISE NOTICE '  at=% market=% player=% conf=% score_opp_pp=%',
      r.created_at, r.mlb_market_type, r.player_name, r.confidence, r.score_val;
  END LOOP;

  -- §E — also check batter picks broader window (whole day's slate)
  RAISE NOTICE '';
  RAISE NOTICE '[E] today batter picks by market:';
  FOR r IN
    SELECT
      mlb_market_type,
      count(*) AS n_today,
      count(*) FILTER (WHERE (breakdown->>'score_opp_pitcher_pitchtype_quality') IS NOT NULL) AS n_with_factor,
      count(DISTINCT (breakdown->>'score_opp_pitcher_pitchtype_quality')::int) AS distinct_vals
    FROM public.pick_history
    WHERE created_at >= ((now() AT TIME ZONE 'America/New_York')::date)
      AND sport = 'mlb' AND is_synthetic = false
      AND mlb_market_type LIKE 'batter_%'
    GROUP BY mlb_market_type ORDER BY count(*) DESC
  LOOP
    RAISE NOTICE '  market=%  n=%  with_factor=%  distinct=%',
      r.mlb_market_type, r.n_today, r.n_with_factor, r.distinct_vals;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE 'D-614 verify complete.';
END $$;
