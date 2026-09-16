DO $$
DECLARE r RECORD;
BEGIN
  -- pick_history overall by game_date month (any state)
  RAISE NOTICE '[D-505] pick_history total non-synthetic by month:';
  FOR r IN
    SELECT date_trunc('month', game_date)::date AS month,
           count(*) AS total,
           count(*) FILTER (WHERE hit IS NOT NULL) AS resolved,
           count(*) FILTER (WHERE hit IS NULL AND voided IS DISTINCT FROM true AND resolved_at IS NULL) AS pending,
           count(*) FILTER (WHERE voided = true) AS voided
    FROM public.pick_history
    WHERE is_synthetic = false AND game_date IS NOT NULL
    GROUP BY month ORDER BY month DESC LIMIT 6
  LOOP
    RAISE NOTICE '  month=% total=% resolved=% pending=% voided=%',
      r.month, r.total, r.resolved, r.pending, r.voided;
  END LOOP;

  -- Just June 2026 detail
  RAISE NOTICE '[D-505] June 2026 by day:';
  FOR r IN
    SELECT game_date, count(*) AS total,
           count(*) FILTER (WHERE hit IS NOT NULL) AS resolved,
           count(*) FILTER (WHERE hit IS NULL AND voided IS DISTINCT FROM true AND resolved_at IS NULL) AS pending,
           count(*) FILTER (WHERE voided = true) AS voided
    FROM public.pick_history
    WHERE is_synthetic = false
      AND game_date BETWEEN DATE '2026-05-28' AND DATE '2026-06-10'
    GROUP BY game_date ORDER BY game_date
  LOOP
    RAISE NOTICE '  date=% total=% resolved=% pending=% voided=%',
      r.game_date, r.total, r.resolved, r.pending, r.voided;
  END LOOP;

  -- recent run_log entries for resolve-picks
  RAISE NOTICE '[D-505] recent resolve-picks runs:';
  FOR r IN
    SELECT created_at, status, duration_ms, notes
    FROM public.run_log
    WHERE function_name = 'resolve-picks'
    ORDER BY created_at DESC LIMIT 5
  LOOP
    RAISE NOTICE '  at=% status=% dur=%ms notes=%',
      r.created_at, r.status, r.duration_ms, COALESCE(substring(r.notes,1,100), '<null>');
  END LOOP;
END $$;
