DO $$
DECLARE r RECORD;
BEGIN
  -- §a Write health: tables with recent writes (last 24h)
  RAISE NOTICE '[D-513 §2a] Tables written in last 24h (proxy: count rows by created_at if available):';
  FOR r IN
    -- Tables we know are written: pick_history, recommendations_cache, props_cache,
    -- mlb_scoring_progress, bets, error_log, notifications_log, health_status,
    -- cache_mlb_*, pick_closing_odds (D-511 stamps).
    SELECT 'pick_history' AS tbl, count(*) AS n_24h FROM public.pick_history
     WHERE created_at > NOW() - INTERVAL '24 hours'
    UNION ALL
    SELECT 'recommendations_cache', count(*) FROM public.recommendations_cache
     WHERE created_at > NOW() - INTERVAL '24 hours'
    UNION ALL
    SELECT 'props_cache', count(*) FROM public.props_cache
     WHERE last_seen > NOW() - INTERVAL '24 hours'
    UNION ALL
    SELECT 'mlb_scoring_progress', count(*) FROM public.mlb_scoring_progress
     WHERE scored_at > NOW() - INTERVAL '24 hours'
    UNION ALL
    SELECT 'error_log', count(*) FROM public.error_log
     WHERE created_at > NOW() - INTERVAL '24 hours'
    UNION ALL
    SELECT 'bets', count(*) FROM public.bets
     WHERE placed_at > NOW() - INTERVAL '24 hours'
  LOOP RAISE NOTICE '  table=% rows_in_24h=%', r.tbl, r.n_24h; END LOOP;

  -- §b Existing health_status checks (D-512 §6 showed health_status warn/fail was empty 24h)
  RAISE NOTICE '[D-513 §2b] health_status distinct check_names (24h):';
  BEGIN
    FOR r IN
      SELECT check_name, max(created_at) AS last_run, count(*) AS n
      FROM public.health_status
      WHERE created_at > NOW() - INTERVAL '24 hours'
      GROUP BY check_name ORDER BY last_run DESC
    LOOP RAISE NOTICE '  check=% last=% n=%', r.check_name, r.last_run, r.n; END LOOP;
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE '  health_status error: %', SQLERRM; END;

  -- §c CLV stamps: are picks getting closing_odds NOW?
  RAISE NOTICE '[D-513 §2c] D-511 CLV pipeline 24h:';
  FOR r IN
    SELECT
      count(*) FILTER (WHERE closing_captured_at IS NOT NULL) AS stamped_24h,
      count(*) FILTER (WHERE closing_captured_at IS NULL) AS unstamped_24h,
      max(closing_captured_at) AS last_stamp_at
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false
      AND created_at > NOW() - INTERVAL '24 hours'
  LOOP RAISE NOTICE '  stamped=% unstamped=% last_stamp=%',
    r.stamped_24h, r.unstamped_24h, r.last_stamp_at; END LOOP;
END $$;
