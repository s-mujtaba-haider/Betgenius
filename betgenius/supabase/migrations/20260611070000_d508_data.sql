DO $$
DECLARE r RECORD;
BEGIN
  -- 1. props_cache structure + recent per-game volume
  RAISE NOTICE '[D-508 §a] props_cache columns:';
  FOR r IN
    SELECT column_name, data_type FROM information_schema.columns
    WHERE table_schema='public' AND table_name='props_cache'
    ORDER BY ordinal_position
  LOOP RAISE NOTICE '  % %', r.column_name, r.data_type; END LOOP;

  -- 2. Per-game prop counts on the last 3 days of MLB props
  RAISE NOTICE '[D-508 §b] per-game prop counts last 3 days (MLB):';
  FOR r IN
    SELECT game_date,
           home_team || ' vs ' || away_team AS matchup,
           count(*) AS prop_count
    FROM public.props_cache
    WHERE sport = 'mlb' AND game_date IN (
      to_char(NOW() AT TIME ZONE 'America/New_York' - INTERVAL '0 day', 'YYYY-MM-DD'),
      to_char(NOW() AT TIME ZONE 'America/New_York' - INTERVAL '1 day', 'YYYY-MM-DD'),
      to_char(NOW() AT TIME ZONE 'America/New_York' - INTERVAL '2 day', 'YYYY-MM-DD')
    )
    GROUP BY game_date, home_team, away_team
    ORDER BY game_date DESC, prop_count DESC LIMIT 30
  LOOP RAISE NOTICE '  gd=% matchup=% props=%', r.game_date, r.matchup, r.prop_count; END LOOP;

  -- 3. distribution: min / median / mean / max prop count per game (last 7 days MLB)
  DECLARE r2 RECORD;
  BEGIN
    RAISE NOTICE '[D-508 §c] per-game prop count distribution (last 7 days MLB):';
    FOR r2 IN
      WITH per_game AS (
        SELECT game_date, home_team || '|' || away_team AS key, count(*) AS pc
        FROM public.props_cache
        WHERE sport='mlb' AND game_date >= to_char(NOW() - INTERVAL '7 days', 'YYYY-MM-DD')
        GROUP BY game_date, home_team, away_team
      )
      SELECT count(*) AS games, min(pc) AS min_pc,
             percentile_disc(0.5) WITHIN GROUP (ORDER BY pc) AS p50_pc,
             percentile_disc(0.75) WITHIN GROUP (ORDER BY pc) AS p75_pc,
             percentile_disc(0.95) WITHIN GROUP (ORDER BY pc) AS p95_pc,
             max(pc) AS max_pc, ROUND(avg(pc)) AS avg_pc
        FROM per_game
    LOOP RAISE NOTICE '  games=% min=% p50=% p75=% p95=% max=% avg=%',
      r2.games, r2.min_pc, r2.p50_pc, r2.p75_pc, r2.p95_pc, r2.max_pc, r2.avg_pc; END LOOP;
  END;

  -- 4. recent process-games-mlb tick durations via net._http_response duration_ms
  RAISE NOTICE '[D-508 §d] recent process-games-mlb tick durations (last 50, 2h window):';
  FOR r IN
    SELECT id, status_code, created,
           (regexp_match(content::text, '"duration_ms"\s*:\s*([0-9]+)'))[1]::int AS dur_ms,
           (regexp_match(content::text, '"games_count"\s*:\s*([0-9]+)'))[1]::int AS games_ct,
           (regexp_match(content::text, '"selected_for_this_tick"\s*:\s*([0-9]+)'))[1]::int AS picked,
           (regexp_match(content::text, '"skipped"\s*:\s*(true|false)'))[1] AS skipped
    FROM net._http_response
    WHERE created > NOW() - INTERVAL '2 hours'
      AND content::text ILIKE '%process-games-mlb%'
    ORDER BY (regexp_match(content::text, '"duration_ms"\s*:\s*([0-9]+)'))[1]::int DESC NULLS LAST
    LIMIT 15
  LOOP RAISE NOTICE '  rid=% at=% status=% dur_ms=% games_ct=% picked=% skipped=%',
    r.id, r.created, r.status_code, r.dur_ms, r.games_ct, r.picked, r.skipped; END LOOP;

  -- 5. recent process-games-mlb checkpoint runtime markers
  RAISE NOTICE '[D-508 §e] recent process-games-mlb checkpoint markers last 24h:';
  FOR r IN
    SELECT created_at, error_type, function_name,
           left(COALESCE(error_message,''), 200) AS msg
    FROM public.error_log
    WHERE created_at > NOW() - INTERVAL '24 hours'
      AND function_name = 'process-games-mlb'
      AND error_type IN ('runtime_approaching_timeout','checkpoint')
    ORDER BY created_at DESC LIMIT 8
  LOOP RAISE NOTICE '  at=% type=% msg=%', r.created_at, r.error_type, r.msg; END LOOP;

  -- 6. mlb_scoring_progress columns (to check for per-game runtime info)
  RAISE NOTICE '[D-508 §f] mlb_scoring_progress columns:';
  FOR r IN
    SELECT column_name, data_type FROM information_schema.columns
    WHERE table_schema='public' AND table_name='mlb_scoring_progress'
    ORDER BY ordinal_position
  LOOP RAISE NOTICE '  % %', r.column_name, r.data_type; END LOOP;
END $$;
