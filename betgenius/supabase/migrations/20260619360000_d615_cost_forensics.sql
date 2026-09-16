-- D-615 — cost forensics. PRE vs POST NaN fix split + outcome attribution
-- + retry detection + day-over-day driver.
--
-- NaN fix deployed at ~2026-06-19 11:55 UTC (D-614).
-- READ-ONLY.

DO $$
DECLARE
  r RECORD;
  v_fix_ts timestamptz := '2026-06-19 11:55:00+00';
  -- PRE/POST cost + calls
  v_pre_calls bigint;  v_pre_cost numeric;
  v_post_calls bigint; v_post_cost numeric;
  -- Picks written PRE/POST
  v_pre_picks bigint; v_post_picks bigint;
  -- NaN rejections PRE/POST
  v_pre_nan bigint;   v_post_nan bigint;
  -- Day-over-day
  v_day_yest_cost numeric; v_day_yest_calls bigint; v_day_yest_picks bigint;
  v_day_today_cost numeric; v_day_today_calls bigint; v_day_today_picks bigint;
  -- Credit-exhaustion
  v_credit_errors bigint;
  v_sonnet_timeouts bigint;
  -- Retry analysis
  v_dup_calls bigint;
BEGIN
  SET LOCAL statement_timeout TO '60s';

  RAISE NOTICE '════════════════════════════════════════════════════════════════';
  RAISE NOTICE 'D-615 — Sonnet cost forensics (NaN fix at %)', v_fix_ts;
  RAISE NOTICE '════════════════════════════════════════════════════════════════';

  --
  -- §A — PRE/POST NaN fix split (over the last 48h)
  --
  SELECT count(*), round(coalesce(sum(computed_cost_usd),0)::numeric,4)
    INTO v_pre_calls, v_pre_cost
    FROM public.sonnet_usage_log
   WHERE source = 'mlb_pick'
     AND created_at >= (now() - interval '48 hours')
     AND created_at <  v_fix_ts;
  SELECT count(*), round(coalesce(sum(computed_cost_usd),0)::numeric,4)
    INTO v_post_calls, v_post_cost
    FROM public.sonnet_usage_log
   WHERE source = 'mlb_pick'
     AND created_at >= v_fix_ts;
  RAISE NOTICE '';
  RAISE NOTICE '[A] Sonnet mlb_pick 48h window split at NaN fix:';
  RAISE NOTICE '  PRE  (48h..fix):  % calls  $%', v_pre_calls, v_pre_cost;
  RAISE NOTICE '  POST (fix..now):  % calls  $%', v_post_calls, v_post_cost;

  -- §B — picks WRITTEN vs sonnet calls (the outcome attribution)
  SELECT count(*) INTO v_pre_picks
    FROM public.pick_history
   WHERE sport = 'mlb' AND is_synthetic = false
     AND created_at >= (now() - interval '48 hours')
     AND created_at <  v_fix_ts;
  SELECT count(*) INTO v_post_picks
    FROM public.pick_history
   WHERE sport = 'mlb' AND is_synthetic = false
     AND created_at >= v_fix_ts;
  RAISE NOTICE '';
  RAISE NOTICE '[B] MLB picks WRITTEN in same windows:';
  RAISE NOTICE '  PRE-fix:  % writes', v_pre_picks;
  RAISE NOTICE '  POST-fix: % writes', v_post_picks;

  -- §C — NaN rejections
  SELECT count(*) INTO v_pre_nan
    FROM public.error_log
   WHERE error_type = 'pick_history_validation_failed'
     AND error_message ILIKE '%confidence%non-finite%'
     AND created_at >= (now() - interval '48 hours')
     AND created_at <  v_fix_ts;
  SELECT count(*) INTO v_post_nan
    FROM public.error_log
   WHERE error_type = 'pick_history_validation_failed'
     AND error_message ILIKE '%confidence%non-finite%'
     AND created_at >= v_fix_ts;
  RAISE NOTICE '';
  RAISE NOTICE '[C] NaN-confidence rejections same windows:';
  RAISE NOTICE '  PRE-fix:  %', v_pre_nan;
  RAISE NOTICE '  POST-fix: %', v_post_nan;

  -- §D — efficiency: cost per WRITTEN pick + estimated waste
  RAISE NOTICE '';
  RAISE NOTICE '[D] efficiency (cost per WRITTEN pick):';
  IF v_pre_picks > 0 THEN
    RAISE NOTICE '  PRE  cost/written: $%  ($%/%)',
      round(v_pre_cost / v_pre_picks, 5), v_pre_cost, v_pre_picks;
  END IF;
  IF v_post_picks > 0 THEN
    RAISE NOTICE '  POST cost/written: $%  ($%/%)',
      round(v_post_cost / v_post_picks, 5), v_post_cost, v_post_picks;
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE '[D.waste] Sonnet calls that wrote NO pick (waste estimate):';
  -- Each cron tick that has Sonnet calls but no pick written means the picks
  -- were rejected post-Sonnet. Approximate waste = (calls - picks_with_ai)
  -- × avg cost-per-call.
  -- Note: written picks have ai_analysis populated when sonnet success.
  -- Wasted calls produced no row but did cost.
  IF v_pre_calls > v_pre_picks THEN
    RAISE NOTICE '  PRE-fix wasted calls: % ($% est. at avg)',
      v_pre_calls - v_pre_picks,
      CASE WHEN v_pre_calls > 0
           THEN round((v_pre_cost / v_pre_calls) * (v_pre_calls - v_pre_picks), 4)
           ELSE 0 END;
  ELSE
    RAISE NOTICE '  PRE-fix: 0 wasted calls (all calls produced picks)';
  END IF;
  IF v_post_calls > v_post_picks THEN
    RAISE NOTICE '  POST-fix wasted calls: % ($% est.)',
      v_post_calls - v_post_picks,
      CASE WHEN v_post_calls > 0
           THEN round((v_post_cost / v_post_calls) * (v_post_calls - v_post_picks), 4)
           ELSE 0 END;
  ELSE
    RAISE NOTICE '  POST-fix: 0 wasted calls';
  END IF;

  --
  -- §E — RETRY analysis: same (player, market) called > 1× within 10 min
  --
  RAISE NOTICE '';
  RAISE NOTICE '[E] Retry analysis (same player+market within 10 min, 48h):';
  SELECT coalesce(count(*) FILTER (WHERE n_in_min > 1), 0) INTO v_dup_calls
    FROM (
      SELECT count(*) AS n_in_min
        FROM public.sonnet_usage_log
       WHERE source = 'mlb_pick'
         AND created_at >= (now() - interval '48 hours')
       GROUP BY context->>'player', context->>'market', date_trunc('minute', created_at)
    ) sub;
  RAISE NOTICE '  retry-buckets (same player+market same minute, >1 calls): %', v_dup_calls;

  -- Show top retry storms
  RAISE NOTICE '';
  RAISE NOTICE '[E.detail] top 10 retry hot-spots (last 48h):';
  FOR r IN
    WITH per_pair AS (
      SELECT
        context->>'player' AS player,
        context->>'market' AS market,
        count(*) AS n_calls_48h,
        round(sum(computed_cost_usd)::numeric, 4) AS cost_48h,
        min(created_at) AS first_call,
        max(created_at) AS last_call
      FROM public.sonnet_usage_log
      WHERE source = 'mlb_pick'
        AND created_at >= (now() - interval '48 hours')
      GROUP BY context->>'player', context->>'market'
      HAVING count(*) > 5
    )
    SELECT * FROM per_pair ORDER BY n_calls_48h DESC LIMIT 10
  LOOP
    RAISE NOTICE '  player=% market=% n_calls=% cost=$% first=% last=%',
      r.player, r.market, r.n_calls_48h, r.cost_48h, r.first_call, r.last_call;
  END LOOP;

  --
  -- §F — DAY-OVER-DAY: yesterday full vs today partial
  --
  RAISE NOTICE '';
  RAISE NOTICE '[F] day-over-day cost (UTC days):';
  FOR r IN
    SELECT
      date_trunc('day', created_at) AS d,
      count(*) AS n_calls,
      round(sum(computed_cost_usd)::numeric, 4) AS cost_usd
    FROM public.sonnet_usage_log
    WHERE source = 'mlb_pick'
      AND created_at >= (now() - interval '4 days')
    GROUP BY date_trunc('day', created_at)
    ORDER BY d DESC
  LOOP
    RAISE NOTICE '  day=%  calls=%  cost=$%', r.d, r.n_calls, r.cost_usd;
  END LOOP;

  -- Picks-per-day for normalization
  RAISE NOTICE '';
  RAISE NOTICE '[F.picks] picks written per UTC day (last 4d):';
  FOR r IN
    SELECT
      date_trunc('day', created_at) AS d,
      count(*) AS n_picks
    FROM public.pick_history
    WHERE sport = 'mlb' AND is_synthetic = false
      AND created_at >= (now() - interval '4 days')
    GROUP BY date_trunc('day', created_at)
    ORDER BY d DESC
  LOOP
    RAISE NOTICE '  day=%  picks=%', r.d, r.n_picks;
  END LOOP;

  --
  -- §G — credit-exhaustion loop: failed Sonnet calls
  --
  SELECT count(*) INTO v_credit_errors
    FROM public.error_log
   WHERE error_type ILIKE '%sonnet_http_error%'
     AND created_at >= (now() - interval '48 hours');
  SELECT count(*) INTO v_sonnet_timeouts
    FROM public.error_log
   WHERE error_type = 'sonnet_timeout'
     AND created_at >= (now() - interval '48 hours');

  RAISE NOTICE '';
  RAISE NOTICE '[G] Sonnet failure log last 48h:';
  RAISE NOTICE '  sonnet_http_error (likely credit class): %', v_credit_errors;
  RAISE NOTICE '  sonnet_timeout: %', v_sonnet_timeouts;
  RAISE NOTICE '  (sonnet_usage_log only logs SUCCESSES, so failures do NOT';
  RAISE NOTICE '   contribute to cost — but they DO show retry storms in §E.)';

  RAISE NOTICE '';
  RAISE NOTICE 'D-615 forensics complete.';
END $$;
