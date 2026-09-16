DO $$
DECLARE r RECORD;
BEGIN
  -- 1. pick_history rows per (game_date, team) for yesterday (full slate)
  RAISE NOTICE '[D-508 §g] picks created per (game_date, team) yesterday (MLB):';
  FOR r IN
    SELECT game_date, team, count(*) AS pick_count
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false
      AND game_date = (NOW() AT TIME ZONE 'America/New_York')::DATE - 1
    GROUP BY game_date, team ORDER BY pick_count DESC LIMIT 30
  LOOP RAISE NOTICE '  gd=% team=% n=%', r.game_date, r.team, r.pick_count; END LOOP;

  -- 2. Per-MATCHUP picks (home + away aggregated)
  RAISE NOTICE '[D-508 §h] picks per matchup (yesterday MLB, both teams combined):';
  FOR r IN
    WITH per_pick AS (
      SELECT game_date, team, opponent, count(*) AS n_picks
      FROM public.pick_history
      WHERE sport='mlb' AND is_synthetic=false
        AND game_date = (NOW() AT TIME ZONE 'America/New_York')::DATE - 1
      GROUP BY game_date, team, opponent
    )
    SELECT
      LEAST(team, opponent) || ' vs ' || GREATEST(team, opponent) AS matchup,
      SUM(n_picks) AS total_picks
    FROM per_pick GROUP BY matchup ORDER BY total_picks DESC
  LOOP RAISE NOTICE '  matchup=% total_picks=%', r.matchup, r.total_picks; END LOOP;

  -- 3. Distribution of picks-per-matchup over last 7 days MLB
  DECLARE r2 RECORD;
  BEGIN
    RAISE NOTICE '[D-508 §i] picks-per-matchup distribution last 7 days MLB:';
    FOR r2 IN
      WITH per_matchup AS (
        SELECT game_date,
               LEAST(team, opponent) || '|' || GREATEST(team, opponent) AS m,
               count(*) AS n
        FROM public.pick_history
        WHERE sport='mlb' AND is_synthetic=false
          AND game_date >= (NOW() AT TIME ZONE 'America/New_York')::DATE - 7
        GROUP BY game_date, LEAST(team, opponent), GREATEST(team, opponent)
      )
      SELECT count(*) AS games, min(n) AS min_n,
             percentile_disc(0.25) WITHIN GROUP (ORDER BY n) AS p25_n,
             percentile_disc(0.5) WITHIN GROUP (ORDER BY n) AS p50_n,
             percentile_disc(0.75) WITHIN GROUP (ORDER BY n) AS p75_n,
             percentile_disc(0.95) WITHIN GROUP (ORDER BY n) AS p95_n,
             max(n) AS max_n, ROUND(avg(n)) AS avg_n
        FROM per_matchup
    LOOP RAISE NOTICE '  games=% min=% p25=% p50=% p75=% p95=% max=% avg=%',
      r2.games, r2.min_n, r2.p25_n, r2.p50_n, r2.p75_n, r2.p95_n, r2.max_n, r2.avg_n; END LOOP;
  END;

  -- 4. Conf>=70 cohort per matchup (the Sonnet-gate cohort — closer to actual work)
  RAISE NOTICE '[D-508 §j] conf>=70 picks per matchup last 7 days MLB:';
  DECLARE r2 RECORD;
  BEGIN
    FOR r2 IN
      WITH per_matchup AS (
        SELECT game_date,
               LEAST(team, opponent) || '|' || GREATEST(team, opponent) AS m,
               count(*) FILTER (WHERE confidence >= 70) AS conf70_n,
               count(*) AS all_n
        FROM public.pick_history
        WHERE sport='mlb' AND is_synthetic=false
          AND game_date >= (NOW() AT TIME ZONE 'America/New_York')::DATE - 7
        GROUP BY game_date, LEAST(team, opponent), GREATEST(team, opponent)
      )
      SELECT count(*) AS games,
             min(conf70_n) AS min_c70, max(conf70_n) AS max_c70,
             percentile_disc(0.5) WITHIN GROUP (ORDER BY conf70_n) AS p50_c70,
             percentile_disc(0.95) WITHIN GROUP (ORDER BY conf70_n) AS p95_c70,
             ROUND(avg(conf70_n)) AS avg_c70,
             ROUND(avg(conf70_n*1.0/NULLIF(all_n,0)), 3) AS ratio_avg
        FROM per_matchup
    LOOP RAISE NOTICE '  games=% min_c70=% p50_c70=% p95_c70=% max_c70=% avg_c70=% conf70/all_ratio_avg=%',
      r2.games, r2.min_c70, r2.p50_c70, r2.p95_c70, r2.max_c70, r2.avg_c70, r2.ratio_avg; END LOOP;
  END;

  -- 5. Recent net._http_response specifically for process-games-mlb-30min (jobid 21)
  RAISE NOTICE '[D-508 §k] last 15 process-games-mlb function responses (any time):';
  FOR r IN
    SELECT id, status_code, created,
           (regexp_match(content::text, '"duration_ms"\s*:\s*([0-9]+)'))[1]::int AS dur_ms,
           (regexp_match(content::text, '"games_processed"\s*:\s*([0-9]+)'))[1]::int AS games_proc,
           (regexp_match(content::text, '"picks_written"\s*:\s*([0-9]+)'))[1]::int AS picks_w,
           left(regexp_replace(content::text, E'[\n\r]+', ' ', 'g'), 250) AS body
    FROM net._http_response
    WHERE created > NOW() - INTERVAL '12 hours'
      AND (content::text ILIKE '%games_processed%' OR content::text ILIKE '%mlb_scoring_progress%')
    ORDER BY created DESC LIMIT 15
  LOOP RAISE NOTICE '  rid=% at=% status=% dur_ms=% games_proc=% picks_w=%',
    r.id, r.created, r.status_code, r.dur_ms, r.games_proc, r.picks_w; END LOOP;

  -- 6. The TWO known runtime_approaching_timeout details
  RAISE NOTICE '[D-508 §l] last 2 runtime_approaching_timeout entries (for context):';
  FOR r IN
    SELECT created_at, function_name, error_message
    FROM public.error_log
    WHERE error_type = 'runtime_approaching_timeout'
    ORDER BY created_at DESC LIMIT 4
  LOOP RAISE NOTICE '  at=% fn=% msg=%', r.created_at, r.function_name, r.error_message; END LOOP;
END $$;
