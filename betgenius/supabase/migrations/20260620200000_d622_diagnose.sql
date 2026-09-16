DO $$ DECLARE r RECORD; BEGIN
  RAISE NOTICE '════════════════════════════════════════════════════════════════';
  RAISE NOTICE 'D-622 pick_history_validation_failed diagnose — READ-ONLY — % UTC', now();
  RAISE NOTICE '════════════════════════════════════════════════════════════════';

  -- §1 — COUNTS BY WINDOW
  RAISE NOTICE '';
  RAISE NOTICE '[1] Count by time window:';
  FOR r IN
    SELECT
      count(*) AS all_time,
      count(*) FILTER (WHERE created_at >= now() - interval '1 hour') AS last_1h,
      count(*) FILTER (WHERE created_at >= now() - interval '24 hours') AS last_24h,
      count(*) FILTER (WHERE created_at >= now() - interval '7 days') AS last_7d,
      count(*) FILTER (WHERE created_at >= now() - interval '30 days') AS last_30d,
      min(created_at) AS first_seen,
      max(created_at) AS last_seen
    FROM public.error_log
    WHERE error_type = 'pick_history_validation_failed'
  LOOP
    RAISE NOTICE '  all-time:    %', r.all_time;
    RAISE NOTICE '  last 1h:     %', r.last_1h;
    RAISE NOTICE '  last 24h:    %', r.last_24h;
    RAISE NOTICE '  last 7d:     %', r.last_7d;
    RAISE NOTICE '  last 30d:    %', r.last_30d;
    RAISE NOTICE '  first_seen:  %', r.first_seen;
    RAISE NOTICE '  last_seen:   %', r.last_seen;
  END LOOP;

  -- §2 — DAILY DISTRIBUTION (last 14 days)
  RAISE NOTICE '';
  RAISE NOTICE '[2] Daily distribution (last 14 days):';
  FOR r IN
    SELECT
      date_trunc('day', created_at AT TIME ZONE 'America/New_York')::date AS day_et,
      count(*) AS n
    FROM public.error_log
    WHERE error_type = 'pick_history_validation_failed'
      AND created_at >= now() - interval '14 days'
    GROUP BY date_trunc('day', created_at AT TIME ZONE 'America/New_York')
    ORDER BY day_et DESC
  LOOP
    RAISE NOTICE '  %  : %', r.day_et, r.n;
  END LOOP;

  -- §2b — HOURLY DISTRIBUTION (today)
  RAISE NOTICE '';
  RAISE NOTICE '[2b] Hourly distribution (today, UTC):';
  FOR r IN
    SELECT
      date_trunc('hour', created_at) AS hour_utc,
      count(*) AS n
    FROM public.error_log
    WHERE error_type = 'pick_history_validation_failed'
      AND created_at::date = (now() AT TIME ZONE 'America/New_York')::date
    GROUP BY date_trunc('hour', created_at)
    ORDER BY hour_utc
  LOOP
    RAISE NOTICE '  %  : %', r.hour_utc, r.n;
  END LOOP;

  -- §3 — FAILURE REASONS (group by error_message + sample context)
  RAISE NOTICE '';
  RAISE NOTICE '[3] Group by error_message (top 15):';
  FOR r IN
    SELECT
      COALESCE(error_message, '(null)') AS msg,
      count(*) AS n,
      min(created_at) AS first_at,
      max(created_at) AS last_at
    FROM public.error_log
    WHERE error_type = 'pick_history_validation_failed'
    GROUP BY error_message
    ORDER BY count(*) DESC
    LIMIT 15
  LOOP
    RAISE NOTICE '  count=%  msg="%"', r.n, LEFT(r.msg, 80);
    RAISE NOTICE '    first=% last=%', r.first_at, r.last_at;
  END LOOP;

  -- §3b — FAILURE BY function_name
  RAISE NOTICE '';
  RAISE NOTICE '[3b] Group by function_name:';
  FOR r IN
    SELECT
      COALESCE(function_name, '(null)') AS fn,
      count(*) AS n
    FROM public.error_log
    WHERE error_type = 'pick_history_validation_failed'
    GROUP BY function_name
    ORDER BY count(*) DESC
    LIMIT 10
  LOOP
    RAISE NOTICE '  function=%  count=%', r.fn, r.n;
  END LOOP;

  -- §3c — CONTEXT inspection — common keys + sample values
  RAISE NOTICE '';
  RAISE NOTICE '[3c] Context keys sampled from 5 most-recent rows:';
  FOR r IN
    SELECT created_at, error_message, LEFT(COALESCE(context::text, '(no context)'), 400) AS ctx
    FROM public.error_log
    WHERE error_type = 'pick_history_validation_failed'
    ORDER BY created_at DESC
    LIMIT 5
  LOOP
    RAISE NOTICE '  at=%', r.created_at;
    RAISE NOTICE '    msg=%', LEFT(r.error_message, 100);
    RAISE NOTICE '    ctx=%', r.ctx;
  END LOOP;

  -- §3d — by market (parse from context)
  RAISE NOTICE '';
  RAISE NOTICE '[3d] By market (extracted from context.market or context.prop_type):';
  FOR r IN
    SELECT
      COALESCE(
        context->>'market',
        context->>'prop_type',
        context->>'mlb_market_type',
        '(none)'
      ) AS mkt,
      count(*) AS n
    FROM public.error_log
    WHERE error_type = 'pick_history_validation_failed'
    GROUP BY 1
    ORDER BY count(*) DESC
    LIMIT 10
  LOOP
    RAISE NOTICE '  market=% count=%', r.mkt, r.n;
  END LOOP;
END $$;
