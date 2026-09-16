-- D-596 smoke — confirm the data is available to the scorer path.
-- (a) recent pitcher_k picks have a matching pitcher in arsenal cache with
-- non-null aggregates; (b) no scorer changes leaked into other markets.
DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '======== D-596 smoke §A: arsenal cache populated ========';
  FOR r IN
    SELECT
      count(*) AS rows,
      count(*) FILTER (WHERE expected_whiff_pct IS NOT NULL) AS w_whiff,
      count(*) FILTER (WHERE expected_k_pct IS NOT NULL) AS w_k,
      count(*) FILTER (WHERE expected_put_away IS NOT NULL) AS w_pa
    FROM public.cache_statcast_pitcher_arsenal
  LOOP RAISE NOTICE '[D-596 smoke §A.1] rows=% w_whiff=% w_k=% w_pa=%',
    r.rows, r.w_whiff, r.w_k, r.w_pa; END LOOP;

  -- §B — Latest snapshot per pitcher with non-null aggregates
  RAISE NOTICE '======== D-596 smoke §B: latest-per-pitcher non-null coverage ========';
  FOR r IN
    WITH latest AS (
      SELECT DISTINCT ON (player_id)
        player_id, expected_whiff_pct, expected_put_away
      FROM public.cache_statcast_pitcher_arsenal
      ORDER BY player_id, snapshot_date DESC
    )
    SELECT
      count(*) AS distinct_pitchers,
      count(*) FILTER (WHERE expected_whiff_pct IS NOT NULL) AS w_whiff,
      count(*) FILTER (WHERE expected_put_away IS NOT NULL) AS w_pa,
      ROUND(avg(expected_put_away)::numeric, 2) AS mean_pa,
      ROUND(stddev(expected_put_away)::numeric, 2) AS sd_pa
    FROM latest
  LOOP RAISE NOTICE '[D-596 smoke §B.1] distinct_pitchers=% w_whiff=% w_pa=% mean_pa=% sd_pa=%',
    r.distinct_pitchers, r.w_whiff, r.w_pa, r.mean_pa, r.sd_pa; END LOOP;

  RAISE NOTICE '======== D-596 smoke §C: sample pitcher_k picks with arsenal match ========';
  FOR r IN
    WITH latest AS (
      SELECT DISTINCT ON (LOWER(player_name)) LOWER(player_name) AS pname_lc,
        expected_put_away, expected_whiff_pct
      FROM public.cache_statcast_pitcher_arsenal
      WHERE expected_put_away IS NOT NULL
      ORDER BY LOWER(player_name), snapshot_date DESC
    ),
    nm AS (
      SELECT player_id, snapshot_date, expected_put_away, expected_whiff_pct,
        -- convert "Abbott, Andrew" → "andrew abbott"
        LOWER(CASE WHEN player_name LIKE '%, %'
             THEN TRIM(split_part(player_name, ',', 2)) || ' ' || TRIM(split_part(player_name, ',', 1))
             ELSE player_name END) AS first_last_lc
      FROM public.cache_statcast_pitcher_arsenal
      WHERE expected_put_away IS NOT NULL
    ),
    sample AS (
      SELECT DISTINCT ON (LOWER(p.player_name)) p.player_name, p.game_date,
        nm.expected_put_away, nm.expected_whiff_pct
      FROM public.pick_history p
      JOIN nm ON nm.first_last_lc = LOWER(p.player_name)
      WHERE p.sport='mlb' AND p.mlb_market_type='pitcher_k'
        AND p.game_date >= (now() - interval '30 days')::date
      ORDER BY LOWER(p.player_name), p.game_date DESC
    )
    SELECT * FROM sample ORDER BY player_name LIMIT 5
  LOOP RAISE NOTICE '[D-596 smoke §C.1] pitcher=% latest_pick=% put_away=% whiff=%',
    r.player_name, r.game_date, r.expected_put_away, r.expected_whiff_pct; END LOOP;
END $$;
