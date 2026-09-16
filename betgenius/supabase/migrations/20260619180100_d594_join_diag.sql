DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '======== D-594 diag §1: cache_statcast_pitcher_arsenal coverage ========';
  FOR r IN
    SELECT
      count(*) AS rows,
      count(DISTINCT player_id) AS distinct_pids,
      count(*) FILTER (WHERE player_name IS NOT NULL AND player_name <> '') AS w_name,
      max(snapshot_date) AS latest,
      min(snapshot_date) AS earliest
    FROM public.cache_statcast_pitcher_arsenal
  LOOP RAISE NOTICE '[D-594 diag §1] rows=% pids=% w_name=% (% .. %)',
    r.rows, r.distinct_pids, r.w_name, r.earliest, r.latest; END LOOP;

  RAISE NOTICE '======== D-594 diag §2: pitcher_k pick_history distinct names sample ========';
  FOR r IN
    SELECT DISTINCT player_name FROM public.pick_history
    WHERE sport='mlb' AND mlb_market_type='pitcher_k' AND hit IS NOT NULL
    ORDER BY player_name LIMIT 10
  LOOP RAISE NOTICE '[D-594 diag §2] pick_name=%', r.player_name; END LOOP;

  RAISE NOTICE '======== D-594 diag §3: cache arsenal name sample ========';
  FOR r IN
    SELECT player_name, player_id FROM public.cache_statcast_pitcher_arsenal
    WHERE snapshot_date >= (now() - interval '60 days')::date
    ORDER BY player_name LIMIT 10
  LOOP RAISE NOTICE '[D-594 diag §3] cache_name=% pid=%', r.player_name, r.player_id; END LOOP;

  RAISE NOTICE '======== D-594 diag §4: how many distinct pitcher_k names match cache by name? ========';
  FOR r IN
    WITH pk_names AS (
      SELECT DISTINCT LOWER(player_name) AS lname FROM public.pick_history
      WHERE sport='mlb' AND mlb_market_type='pitcher_k' AND hit IS NOT NULL
    ),
    cache_names AS (
      SELECT DISTINCT LOWER(player_name) AS lname, player_id FROM public.cache_statcast_pitcher_arsenal
      WHERE snapshot_date >= (now() - interval '60 days')::date
    )
    SELECT
      (SELECT count(*) FROM pk_names) AS pk_distinct,
      (SELECT count(*) FROM cache_names) AS cache_distinct,
      (SELECT count(*) FROM pk_names JOIN cache_names USING (lname)) AS matched
  LOOP RAISE NOTICE '[D-594 diag §4] pk_distinct=% cache_distinct=% matched=%',
    r.pk_distinct, r.cache_distinct, r.matched; END LOOP;
END $$;
