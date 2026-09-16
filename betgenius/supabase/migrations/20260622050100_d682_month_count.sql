-- D-682 second-pass: exact per-year row count (sample was thin; verify 2026).
DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE 'D-682 — per-year exact row count (indexed via commence_time)';
  FOR r IN
    SELECT
      EXTRACT(YEAR FROM commence_time)::INT AS yr,
      COUNT(*) AS n_rows
    FROM public.cache_mlb_historical_odds
    WHERE commence_time >= '2023-01-01' AND commence_time < '2027-01-01'
    GROUP BY EXTRACT(YEAR FROM commence_time)
    ORDER BY 1
  LOOP
    RAISE NOTICE 'D-682 yr=% rows=%', r.yr, r.n_rows;
  END LOOP;

  -- Bookmaker distribution (count per book)
  RAISE NOTICE '──────────';
  FOR r IN
    SELECT bookmaker_key, COUNT(*) AS n_rows
    FROM public.cache_mlb_historical_odds TABLESAMPLE SYSTEM (0.1)
    GROUP BY bookmaker_key
    ORDER BY COUNT(*) DESC
    LIMIT 20
  LOOP
    RAISE NOTICE 'D-682 book=% sample_rows=%', r.bookmaker_key, r.n_rows;
  END LOOP;

  -- Time range exact
  DECLARE
    v_min TIMESTAMPTZ; v_max TIMESTAMPTZ;
  BEGIN
    SELECT MIN(commence_time), MAX(commence_time)
    INTO v_min, v_max
    FROM public.cache_mlb_historical_odds;
    RAISE NOTICE 'D-682 time range: min=% max=%', v_min, v_max;
  END;

  -- Total row count (exact via index-only scan from PK)
  DECLARE
    v_total BIGINT;
  BEGIN
    SELECT COUNT(*) INTO v_total FROM public.cache_mlb_historical_odds;
    RAISE NOTICE 'D-682 exact row count=%', v_total;
  END;

  -- ALSO: check fetched_at distribution (was data fetched in one big run?)
  DECLARE
    v_fmin TIMESTAMPTZ; v_fmax TIMESTAMPTZ;
  BEGIN
    SELECT MIN(fetched_at), MAX(fetched_at) INTO v_fmin, v_fmax
    FROM public.cache_mlb_historical_odds;
    RAISE NOTICE 'D-682 fetched_at range: min=% max=%', v_fmin, v_fmax;
  END;
END $$;
