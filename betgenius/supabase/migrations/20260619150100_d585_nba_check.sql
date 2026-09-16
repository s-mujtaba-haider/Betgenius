-- D-585 NBA check — figure out why §A.1 had no NBA rows.
DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '60s';

  RAISE NOTICE '======== D-585 NBA §1: recent NBA pick volume ========';
  FOR r IN
    SELECT
      count(*) AS n_all,
      count(*) FILTER (WHERE hit IS NOT NULL) AS n_resolved,
      count(*) FILTER (WHERE hit IS NOT NULL AND breakdown IS NOT NULL AND breakdown <> '{}'::jsonb) AS n_resolved_w_breakdown,
      max(game_date) AS latest, min(game_date) AS earliest
    FROM public.pick_history
    WHERE sport='nba' AND is_synthetic=false AND voided IS NOT TRUE
      AND game_date >= (now() - interval '30 days')::date
  LOOP RAISE NOTICE '[D-585 NBA §1] n_all=% resolved=% w_breakdown=% (%..% )',
    r.n_all, r.n_resolved, r.n_resolved_w_breakdown, r.earliest, r.latest; END LOOP;

  RAISE NOTICE '======== D-585 NBA §2: NBA breakdown coverage all time (last 90d) ========';
  FOR r IN
    SELECT
      count(*) AS n_resolved,
      count(*) FILTER (WHERE breakdown IS NOT NULL AND breakdown <> '{}'::jsonb) AS n_w_breakdown,
      ROUND(100.0 * count(*) FILTER (WHERE breakdown IS NOT NULL AND breakdown <> '{}'::jsonb) / NULLIF(count(*),0)::numeric, 1) AS pct
    FROM public.pick_history
    WHERE sport='nba' AND is_synthetic=false AND voided IS NOT TRUE AND hit IS NOT NULL
      AND game_date >= (now() - interval '90 days')::date
  LOOP RAISE NOTICE '[D-585 NBA §2] last 90d resolved=% w_breakdown=% pct=%',
    r.n_resolved, r.n_w_breakdown, r.pct; END LOOP;

  -- Lift the date filter for NBA to capture last 60d (assuming NBA had recent
  -- resolved picks pre-30d only)
  RAISE NOTICE '======== D-585 NBA §3: per-market top flatlines (last 60d, w/breakdown) ========';
  CREATE TEMP TABLE d585_nba_unnest AS
  SELECT
    LOWER(ph.prop_type) AS market,
    j.key AS bk_key,
    CASE WHEN j.value::text ~ '^-?[0-9]+(\.[0-9]+)?$'
         THEN (j.value::text)::numeric
         WHEN j.value::text = 'true' THEN 1
         WHEN j.value::text = 'false' THEN 0
         END AS num_value
  FROM public.pick_history ph,
       LATERAL jsonb_each(COALESCE(ph.breakdown, '{}'::jsonb)) AS j
  WHERE ph.sport='nba' AND ph.is_synthetic=false AND ph.voided IS NOT TRUE
    AND ph.hit IS NOT NULL AND ph.breakdown IS NOT NULL AND ph.breakdown <> '{}'::jsonb
    AND ph.game_date >= (now() - interval '60 days')::date;

  FOR r IN
    SELECT market, count(DISTINCT bk_key) AS keys, count(*) AS rows
    FROM d585_nba_unnest GROUP BY 1 ORDER BY 1
  LOOP RAISE NOTICE '[D-585 NBA §3.0] market=% keys=% rows=%', r.market, r.keys, r.rows; END LOOP;

  -- The top flatlines
  FOR r IN
    WITH counts AS (
      SELECT market, bk_key,
        count(*) AS n_picks, count(DISTINCT num_value) AS n_distinct,
        stddev(num_value) AS sd
      FROM d585_nba_unnest GROUP BY 1,2
    ), top_mode AS (
      SELECT market, bk_key, num_value, count(*) AS cnt,
        row_number() OVER (PARTITION BY market, bk_key ORDER BY count(*) DESC) AS rn
      FROM d585_nba_unnest WHERE num_value IS NOT NULL
      GROUP BY 1,2,3
    )
    SELECT c.market, c.bk_key, c.n_picks, c.n_distinct,
      ROUND(c.sd::numeric, 4) AS sd,
      tm.num_value AS mode,
      ROUND(100.0 * tm.cnt / NULLIF(c.n_picks, 0)::numeric, 2) AS pct
    FROM counts c
    LEFT JOIN top_mode tm ON tm.market=c.market AND tm.bk_key=c.bk_key AND tm.rn=1
    WHERE c.n_picks >= 30 AND c.n_distinct < 5
      AND 100.0 * tm.cnt / NULLIF(c.n_picks, 0)::numeric >= 80
    ORDER BY pct DESC, bk_key LIMIT 40
  LOOP RAISE NOTICE '[D-585 NBA §3.1] %/% n=% distinct=% sd=% mode=% pct=%',
    r.market, r.bk_key, r.n_picks, r.n_distinct, r.sd, r.mode, r.pct; END LOOP;

  DROP TABLE d585_nba_unnest;
END $$;
