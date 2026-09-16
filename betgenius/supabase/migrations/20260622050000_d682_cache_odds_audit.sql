-- D-682 SHIP 1-5 — READ-ONLY audit of cache_mlb_historical_odds (9.3 GB).
-- Single migration; bounded queries; NOTICEs surface diagnostic via supabase
-- db push CLI. NO writes to the table itself.
DO $$
DECLARE
  v_row_estimate BIGINT;
  v_n_live BIGINT;
  v_n_dead BIGINT;
  v_size_total TEXT;
  v_size_table TEXT;
  v_size_indexes TEXT;
  v_size_toast TEXT;
  v_last_vacuum TIMESTAMPTZ;
  v_last_autovacuum TIMESTAMPTZ;
  v_last_analyze TIMESTAMPTZ;
  v_avg_row_width INT;
  v_sample_avg_width NUMERIC;
  r RECORD;
BEGIN
  RAISE NOTICE '════════════════════════════════════════════════════════════════';
  RAISE NOTICE 'D-682 — cache_mlb_historical_odds audit @ %', now();
  RAISE NOTICE '════════════════════════════════════════════════════════════════';

  -- 1) SIZES (pg_relation / total / index / toast)
  v_size_total := pg_size_pretty(pg_total_relation_size('public.cache_mlb_historical_odds'));
  v_size_table := pg_size_pretty(pg_relation_size('public.cache_mlb_historical_odds'));
  v_size_indexes := pg_size_pretty(pg_indexes_size('public.cache_mlb_historical_odds'));
  BEGIN
    SELECT pg_size_pretty(pg_total_relation_size((SELECT reltoastrelid FROM pg_class WHERE oid='public.cache_mlb_historical_odds'::regclass)))
    INTO v_size_toast;
  EXCEPTION WHEN OTHERS THEN v_size_toast := '(n/a)'; END;
  RAISE NOTICE 'D-682 SIZE total=% table-heap=% indexes=% toast=%',
    v_size_total, v_size_table, v_size_indexes, v_size_toast;

  -- 2) ROW COUNT + WIDTH (use pg_class.reltuples — exact count too slow)
  SELECT reltuples::BIGINT INTO v_row_estimate
  FROM pg_class WHERE oid = 'public.cache_mlb_historical_odds'::regclass;
  v_avg_row_width := CASE WHEN v_row_estimate > 0
    THEN (pg_relation_size('public.cache_mlb_historical_odds')::NUMERIC / v_row_estimate)::INT
    ELSE 0 END;
  RAISE NOTICE 'D-682 ROWS estimate=% (pg_class.reltuples) avg_row_bytes=% (heap/rows)',
    v_row_estimate, v_avg_row_width;

  -- 3) VACUUM + LIVE/DEAD TUPLE STATS
  SELECT n_live_tup, n_dead_tup, last_vacuum, last_autovacuum, last_analyze
  INTO v_n_live, v_n_dead, v_last_vacuum, v_last_autovacuum, v_last_analyze
  FROM pg_stat_user_tables
  WHERE relname = 'cache_mlb_historical_odds' AND schemaname = 'public';
  RAISE NOTICE 'D-682 VACUUM n_live_tup=% n_dead_tup=% last_vacuum=% last_autovacuum=% last_analyze=%',
    v_n_live, v_n_dead, v_last_vacuum, v_last_autovacuum, v_last_analyze;
  IF v_n_live > 0 THEN
    RAISE NOTICE 'D-682 BLOAT dead/live ratio=%%%', (100.0 * v_n_dead / v_n_live)::INT;
  END IF;

  -- 4) COLUMN BREAKDOWN — sample 1,000 rows and avg pg_column_size per column
  RAISE NOTICE '────────── D-682 per-column avg bytes (sample n=1000) ──────────';
  -- One pass per column, sampled via TABLESAMPLE SYSTEM for speed
  CREATE TEMP TABLE _d682_sample ON COMMIT DROP AS
  SELECT * FROM public.cache_mlb_historical_odds TABLESAMPLE SYSTEM (0.01) LIMIT 1000;

  FOR r IN
    SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='cache_mlb_historical_odds'
    ORDER BY ordinal_position
  LOOP
    EXECUTE format('SELECT AVG(pg_column_size(%I))::NUMERIC(8,2) FROM _d682_sample', r.column_name)
      INTO v_sample_avg_width;
    RAISE NOTICE 'D-682 col % avg_bytes=%', r.column_name, v_sample_avg_width;
  END LOOP;

  -- 5) DISTINCT-ness — how many distinct values per dimension (sample)
  RAISE NOTICE '────────── D-682 distinct values per dim in sample ──────────';
  EXECUTE 'SELECT COUNT(DISTINCT event_id) FROM _d682_sample' INTO v_row_estimate;
  RAISE NOTICE 'D-682 sample distinct event_id=%', v_row_estimate;
  EXECUTE 'SELECT COUNT(DISTINCT snapshot_timestamp) FROM _d682_sample' INTO v_row_estimate;
  RAISE NOTICE 'D-682 sample distinct snapshot_timestamp=%', v_row_estimate;
  EXECUTE 'SELECT COUNT(DISTINCT bookmaker_key) FROM _d682_sample' INTO v_row_estimate;
  RAISE NOTICE 'D-682 sample distinct bookmaker_key=%', v_row_estimate;
  EXECUTE 'SELECT COUNT(DISTINCT market_key) FROM _d682_sample' INTO v_row_estimate;
  RAISE NOTICE 'D-682 sample distinct market_key=%', v_row_estimate;
  EXECUTE 'SELECT COUNT(DISTINCT player_name) FROM _d682_sample' INTO v_row_estimate;
  RAISE NOTICE 'D-682 sample distinct player_name=%', v_row_estimate;

  -- 6) DATE RANGE — span of snapshots
  RAISE NOTICE '────────── D-682 date range + per-month breakdown ──────────';
  FOR r IN
    SELECT
      DATE_TRUNC('month', commence_time) AS month,
      COUNT(*) AS rows
    FROM _d682_sample
    GROUP BY 1 ORDER BY 1
  LOOP
    RAISE NOTICE 'D-682 month=% sample_rows=%', r.month, r.rows;
  END LOOP;

  -- 7) DUPLICATE DETECTION — within sample, how many rows share identical
  --    (event_id, snapshot_timestamp, bookmaker_key, market_key, player_name, line)?
  --    (That's the PK so it should be 0 by definition — confirm.)
  --    Then check NEAR-dupes: same key but different `fetched_at` (re-runs).
  --    Note: PK guarantees uniqueness on the listed columns; the only way to
  --    have "duplicates" is rows that should be the same snapshot but got
  --    different snapshot_timestamps (clock drift between fetches).
  RAISE NOTICE '────────── D-682 dup-check on sample ──────────';
  EXECUTE $X$
    SELECT COUNT(*) FROM (
      SELECT event_id, bookmaker_key, market_key, player_name, line,
             DATE_TRUNC('hour', snapshot_timestamp) AS hour_bucket,
             COUNT(*) AS c
      FROM _d682_sample
      GROUP BY 1,2,3,4,5,6 HAVING COUNT(*) > 1
    ) X
  $X$ INTO v_row_estimate;
  RAISE NOTICE 'D-682 sample near-dups (same key + same hour bucket)=%', v_row_estimate;

  -- 8) MARKET MIX — what's the row distribution by market_key?
  RAISE NOTICE '────────── D-682 market_key mix (sample) ──────────';
  FOR r IN
    SELECT market_key, COUNT(*) AS rows
    FROM _d682_sample
    GROUP BY market_key ORDER BY COUNT(*) DESC
  LOOP
    RAISE NOTICE 'D-682 market=% sample_rows=%', r.market_key, r.rows;
  END LOOP;

  -- 9) ALSO check sibling table cache_mlb_historical_odds_snapshot
  RAISE NOTICE '────────── D-682 sibling cache_mlb_historical_odds_snapshot ──────────';
  BEGIN
    RAISE NOTICE 'D-682 sibling total=% rows=%',
      pg_size_pretty(pg_total_relation_size('public.cache_mlb_historical_odds_snapshot')),
      (SELECT reltuples::BIGINT FROM pg_class WHERE oid='public.cache_mlb_historical_odds_snapshot'::regclass);
  EXCEPTION WHEN OTHERS THEN RAISE NOTICE 'D-682 sibling table not present'; END;
END $$;
