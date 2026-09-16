-- D-606 — diagnose 4 live breaks (read-only).
--   A. confidence=NaN rejecting 138 picks (batter_total_bases sample)
--   B. sonnet_http_error ×358 — what's the actual error?
--   C. Performance/Admin Perf still failing — pinpoint
--   D. tracker stuck-pending Jun 8-18

DO $$
DECLARE
  r RECORD;
  v_now timestamptz := now();
  v_nan_count bigint;
  v_sonnet_count bigint;
  v_resolved_jun_picks bigint;
  v_pending_jun_picks bigint;
BEGIN
  SET LOCAL statement_timeout TO '60s';

  RAISE NOTICE '════════════════════════════════════════════════════════════════';
  RAISE NOTICE 'D-606 — 4-break diagnostic';
  RAISE NOTICE '════════════════════════════════════════════════════════════════';

  --
  -- PART A — confidence NaN rejections
  --
  RAISE NOTICE '';
  RAISE NOTICE '── PART A — confidence NaN rejections ──';

  SELECT count(*) INTO v_nan_count FROM public.error_log
   WHERE error_message ILIKE '%NaN%confidence%'
      OR error_message ILIKE '%confidence%NaN%'
      OR error_type ILIKE '%nan%confidence%'
     AND created_at >= (now() - interval '48 hours');
  RAISE NOTICE '[A.1] error_log rows mentioning NaN+confidence (48h): %', v_nan_count;

  RAISE NOTICE '';
  RAISE NOTICE '[A.2] error_log NaN-confidence sample (last 24h):';
  FOR r IN
    SELECT function_name, error_type, error_message, context, created_at
      FROM public.error_log
     WHERE (error_message ILIKE '%NaN%' OR error_type ILIKE '%nan%')
       AND created_at >= (now() - interval '24 hours')
     ORDER BY created_at DESC LIMIT 10
  LOOP
    RAISE NOTICE '  at=% fn=% type=% msg=% ctx=%',
      r.created_at, r.function_name, r.error_type,
      LEFT(r.error_message, 200), LEFT(r.context::text, 250);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '[A.3] all CLIENT_VALIDATION rejections in last 24h, by market:';
  FOR r IN
    SELECT context->>'market' AS market,
           context->>'reason' AS reason,
           count(*) AS n
      FROM public.error_log
     WHERE created_at >= (now() - interval '24 hours')
       AND (error_type ILIKE '%validation%' OR error_type ILIKE '%rejected%' OR error_type ILIKE '%client_validation%')
     GROUP BY context->>'market', context->>'reason'
     ORDER BY count(*) DESC LIMIT 30
  LOOP
    RAISE NOTICE '  market=% reason=% n=%', r.market, r.reason, r.n;
  END LOOP;

  --
  -- PART B — sonnet_http_error
  --
  RAISE NOTICE '';
  RAISE NOTICE '── PART B — sonnet_http_error ──';

  SELECT count(*) INTO v_sonnet_count FROM public.error_log
   WHERE error_type ILIKE '%sonnet%http%error%'
      OR error_type = 'sonnet_http_error'
     AND created_at >= (now() - interval '48 hours');
  RAISE NOTICE '[B.1] sonnet_http_error count (48h): %', v_sonnet_count;

  RAISE NOTICE '';
  RAISE NOTICE '[B.2] sonnet_http_error breakdown by HTTP status code (last 24h):';
  FOR r IN
    SELECT context->>'status' AS status,
           context->>'code' AS code,
           context->>'error_code' AS error_code,
           LEFT(error_message, 120) AS msg_excerpt,
           count(*) AS n
      FROM public.error_log
     WHERE error_type ILIKE '%sonnet%'
       AND created_at >= (now() - interval '24 hours')
     GROUP BY context->>'status', context->>'code', context->>'error_code', LEFT(error_message, 120)
     ORDER BY count(*) DESC LIMIT 15
  LOOP
    RAISE NOTICE '  status=% code=% error_code=% n=% msg=%',
      r.status, r.code, r.error_code, r.n, r.msg_excerpt;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '[B.3] sonnet_http_error 5 most-recent full samples:';
  FOR r IN
    SELECT function_name, error_message, context, created_at
      FROM public.error_log
     WHERE error_type ILIKE '%sonnet%'
       AND created_at >= (now() - interval '24 hours')
     ORDER BY created_at DESC LIMIT 5
  LOOP
    RAISE NOTICE '  at=% fn=% msg=% ctx=%',
      r.created_at, r.function_name, LEFT(r.error_message, 250), LEFT(r.context::text, 300);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '[B.4] picks WITHOUT ai_analysis (sonnet failed?) by date last 5 days:';
  FOR r IN
    SELECT game_date,
           count(*) AS total,
           count(*) FILTER (WHERE ai_analysis IS NULL OR ai_analysis = '') AS no_ai,
           round(100.0 * count(*) FILTER (WHERE ai_analysis IS NULL OR ai_analysis = '') / GREATEST(count(*),1), 1) AS pct_no_ai
      FROM public.pick_history
     WHERE game_date >= ((now() AT TIME ZONE 'America/New_York')::date - 5)
       AND sport = 'mlb' AND is_synthetic = false
     GROUP BY game_date ORDER BY game_date DESC
  LOOP
    RAISE NOTICE '  date=% total=% no_ai=% pct_no_ai=%', r.game_date, r.total, r.no_ai, r.pct_no_ai;
  END LOOP;

  --
  -- PART C — Performance / Admin Performance
  --
  -- Many possible causes; surface today's run_log + error_log for clues.
  --
  RAISE NOTICE '';
  RAISE NOTICE '── PART C — Performance / Admin Perf ──';
  RAISE NOTICE '[C.1] last 10 unique error_types in last 4h (any function):';
  FOR r IN
    SELECT error_type, function_name, count(*) AS n, max(created_at) AS latest
      FROM public.error_log
     WHERE created_at >= (now() - interval '4 hours')
     GROUP BY error_type, function_name
     ORDER BY count(*) DESC LIMIT 20
  LOOP
    RAISE NOTICE '  fn=% type=% n=% latest=%', r.function_name, r.error_type, r.n, r.latest;
  END LOOP;

  --
  -- PART D — tracker stuck pending
  --
  RAISE NOTICE '';
  RAISE NOTICE '── PART D — tracker stuck pending ──';

  SELECT count(*) INTO v_resolved_jun_picks FROM public.pick_history
   WHERE game_date BETWEEN '2026-06-08' AND '2026-06-18'
     AND sport = 'mlb' AND is_synthetic = false AND hit IS NOT NULL;
  SELECT count(*) INTO v_pending_jun_picks FROM public.pick_history
   WHERE game_date BETWEEN '2026-06-08' AND '2026-06-18'
     AND sport = 'mlb' AND is_synthetic = false AND hit IS NULL;
  RAISE NOTICE '[D.1] pick_history Jun 8-18 MLB: resolved=% pending=%',
    v_resolved_jun_picks, v_pending_jun_picks;

  RAISE NOTICE '';
  RAISE NOTICE '[D.2] pending Jun 8-18 by market (top 20):';
  FOR r IN
    SELECT mlb_market_type, count(*) AS n
      FROM public.pick_history
     WHERE game_date BETWEEN '2026-06-08' AND '2026-06-18'
       AND sport = 'mlb' AND is_synthetic = false AND hit IS NULL
     GROUP BY mlb_market_type ORDER BY count(*) DESC LIMIT 20
  LOOP RAISE NOTICE '  market=% pending=%', r.mlb_market_type, r.n; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '[D.3] last 10 resolve-picks runs (run_log):';
  FOR r IN
    SELECT function_name, duration_ms, status, errors_count, notes, created_at
      FROM public.run_log
     WHERE function_name = 'resolve-picks'
     ORDER BY created_at DESC LIMIT 10
  LOOP
    RAISE NOTICE '  at=% dur_ms=% status=% errors=% notes=%',
      r.created_at, r.duration_ms, r.status, r.errors_count, LEFT(COALESCE(r.notes,''), 150);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '[D.4] resolve-picks error_log last 10 (any error_type):';
  FOR r IN
    SELECT error_type, error_message, context, created_at
      FROM public.error_log
     WHERE function_name = 'resolve-picks'
       AND created_at >= (now() - interval '7 days')
     ORDER BY created_at DESC LIMIT 10
  LOOP
    RAISE NOTICE '  at=% type=% msg=% ctx=%',
      r.created_at, r.error_type, LEFT(r.error_message, 200), LEFT(r.context::text, 250);
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '[D.5] pending Jun 8-18 by (market, has_actual_value, has_game_score):';
  FOR r IN
    SELECT
      mlb_market_type,
      (actual_value IS NOT NULL) AS has_actual,
      count(*) AS n
      FROM public.pick_history
     WHERE game_date BETWEEN '2026-06-08' AND '2026-06-18'
       AND sport = 'mlb' AND is_synthetic = false AND hit IS NULL
     GROUP BY mlb_market_type, (actual_value IS NOT NULL)
     ORDER BY count(*) DESC LIMIT 15
  LOOP RAISE NOTICE '  market=% has_actual=% n=%', r.mlb_market_type, r.has_actual, r.n; END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE 'D-606 diagnostic complete.';
END $$;
