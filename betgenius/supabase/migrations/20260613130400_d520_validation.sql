DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '300s';

  -- §A sample: full 60d batter sample with breakdown
  RAISE NOTICE '[D-520 §A] sample (batter MLB with breakdown, 60d):';
  FOR r IN
    SELECT count(*) AS total,
           count(*) FILTER (WHERE breakdown ? 'last10_hit_rate_pct') AS has_l10
    FROM public.pick_history_real
    WHERE sport='mlb' AND is_synthetic=false AND hit IS NOT NULL
      AND mlb_market_type LIKE 'batter_%' AND breakdown IS NOT NULL
  LOOP RAISE NOTICE '  total=% has_l10=%', r.total, r.has_l10; END LOOP;

  -- §B BEFORE WR-by-band (current conf), batter only
  RAISE NOTICE '[D-520 §B] BEFORE — WR-by-band (current conf), batter only:';
  FOR r IN
    SELECT
      CASE WHEN confidence = 100 THEN '100'
           WHEN confidence BETWEEN 95 AND 99 THEN '95-99'
           WHEN confidence BETWEEN 90 AND 94 THEN '90-94'
           WHEN confidence BETWEEN 85 AND 89 THEN '85-89'
           WHEN confidence BETWEEN 80 AND 84 THEN '80-84'
           WHEN confidence BETWEEN 75 AND 79 THEN '75-79'
           WHEN confidence BETWEEN 70 AND 74 THEN '70-74'
           WHEN confidence BETWEEN 65 AND 69 THEN '65-69'
           ELSE '<65' END AS band,
      count(*) AS n,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0), 2) AS wr
    FROM public.pick_history_real
    WHERE sport='mlb' AND is_synthetic=false AND hit IS NOT NULL
      AND mlb_market_type LIKE 'batter_%' AND breakdown IS NOT NULL
    GROUP BY band
  LOOP RAISE NOTICE '  band=% n=% WR=%', r.band, r.n, r.wr; END LOOP;

  -- §C AFTER WR-by-band (d520_new_conf), batter only
  RAISE NOTICE '[D-520 §C] AFTER — WR-by-band (d520_new_conf), batter only:';
  FOR r IN
    WITH t AS (
      SELECT public.d520_new_conf(confidence, mlb_market_type, pick_side, breakdown) AS new_conf, hit
      FROM public.pick_history_real
      WHERE sport='mlb' AND is_synthetic=false AND hit IS NOT NULL
        AND mlb_market_type LIKE 'batter_%' AND breakdown IS NOT NULL
    )
    SELECT
      CASE WHEN new_conf = 100 THEN '100'
           WHEN new_conf BETWEEN 95 AND 99 THEN '95-99'
           WHEN new_conf BETWEEN 90 AND 94 THEN '90-94'
           WHEN new_conf BETWEEN 85 AND 89 THEN '85-89'
           WHEN new_conf BETWEEN 80 AND 84 THEN '80-84'
           WHEN new_conf BETWEEN 75 AND 79 THEN '75-79'
           WHEN new_conf BETWEEN 70 AND 74 THEN '70-74'
           WHEN new_conf BETWEEN 65 AND 69 THEN '65-69'
           ELSE '<65' END AS band,
      count(*) AS n,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0), 2) AS wr
    FROM t GROUP BY band
  LOOP RAISE NOTICE '  band=% n=% WR=%', r.band, r.n, r.wr; END LOOP;

  -- §D Inversion test: does 90+ beat 70-84 AFTER?
  RAISE NOTICE '[D-520 §D] inversion test AFTER:';
  FOR r IN
    WITH t AS (
      SELECT public.d520_new_conf(confidence, mlb_market_type, pick_side, breakdown) AS new_conf, hit
      FROM public.pick_history_real
      WHERE sport='mlb' AND is_synthetic=false AND hit IS NOT NULL
        AND mlb_market_type LIKE 'batter_%' AND breakdown IS NOT NULL
    )
    SELECT
      CASE WHEN new_conf >= 90 THEN '90+'
           WHEN new_conf BETWEEN 70 AND 84 THEN '70-84'
           ELSE 'other' END AS megaband,
      count(*) AS n,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0), 2) AS wr
    FROM t WHERE new_conf >= 70 GROUP BY megaband
  LOOP RAISE NOTICE '  megaband=% n=% WR=%', r.megaband, r.n, r.wr; END LOOP;

  -- §E Per-market regression: BEFORE vs AFTER at 80+ tier and 90+ tier
  RAISE NOTICE '[D-520 §E] per-market at sellable conf>=80 — BEFORE vs AFTER:';
  FOR r IN
    SELECT mlb_market_type,
           count(*) FILTER (WHERE confidence >= 80) AS before_n,
           ROUND(100.0 * count(*) FILTER (WHERE confidence >= 80 AND hit)
                 / NULLIF(count(*) FILTER (WHERE confidence >= 80), 0), 2) AS before_wr,
           count(*) FILTER (WHERE public.d520_new_conf(confidence, mlb_market_type, pick_side, breakdown) >= 80) AS after_n,
           ROUND(100.0 * count(*) FILTER (WHERE public.d520_new_conf(confidence, mlb_market_type, pick_side, breakdown) >= 80 AND hit)
                 / NULLIF(count(*) FILTER (WHERE public.d520_new_conf(confidence, mlb_market_type, pick_side, breakdown) >= 80), 0), 2) AS after_wr
    FROM public.pick_history_real
    WHERE sport='mlb' AND is_synthetic=false AND hit IS NOT NULL
      AND mlb_market_type LIKE 'batter_%' AND breakdown IS NOT NULL
    GROUP BY mlb_market_type ORDER BY mlb_market_type
  LOOP RAISE NOTICE '  market=% before(n=% WR=%) after(n=% WR=%)',
    r.mlb_market_type, r.before_n, r.before_wr, r.after_n, r.after_wr; END LOOP;

  -- §F Holdout-only (NEWER half): repeat §D on B half
  RAISE NOTICE '[D-520 §F] HOLDOUT (newer half via NTILE) — inversion test AFTER:';
  FOR r IN
    WITH src AS (
      SELECT confidence, mlb_market_type, pick_side, breakdown, hit,
             NTILE(2) OVER (ORDER BY game_date, id) AS halfn
      FROM public.pick_history_real
      WHERE sport='mlb' AND is_synthetic=false AND hit IS NOT NULL
        AND mlb_market_type LIKE 'batter_%' AND breakdown IS NOT NULL
    ),
    t AS (
      SELECT public.d520_new_conf(confidence, mlb_market_type, pick_side, breakdown) AS new_conf, hit, halfn
      FROM src WHERE halfn = 2  -- newer half = holdout
    )
    SELECT
      CASE WHEN new_conf >= 90 THEN '90+'
           WHEN new_conf BETWEEN 70 AND 84 THEN '70-84'
           ELSE 'other' END AS megaband,
      count(*) AS n,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0), 2) AS wr
    FROM t WHERE new_conf >= 70 GROUP BY megaband
  LOOP RAISE NOTICE '  HOLDOUT megaband=% n=% WR=%', r.megaband, r.n, r.wr; END LOOP;

  -- §G NEW 90+ batter WR vs OLD across the whole 60d
  RAISE NOTICE '[D-520 §G] summary delta: 90+ batter cohort BEFORE vs AFTER:';
  FOR r IN
    WITH t AS (
      SELECT confidence AS old_conf,
             public.d520_new_conf(confidence, mlb_market_type, pick_side, breakdown) AS new_conf,
             hit
      FROM public.pick_history_real
      WHERE sport='mlb' AND is_synthetic=false AND hit IS NOT NULL
        AND mlb_market_type LIKE 'batter_%' AND breakdown IS NOT NULL
    )
    SELECT
      count(*) FILTER (WHERE old_conf >= 90) AS before_n,
      ROUND(100.0 * count(*) FILTER (WHERE old_conf >= 90 AND hit) / NULLIF(count(*) FILTER (WHERE old_conf >= 90), 0), 2) AS before_wr,
      count(*) FILTER (WHERE new_conf >= 90) AS after_n,
      ROUND(100.0 * count(*) FILTER (WHERE new_conf >= 90 AND hit) / NULLIF(count(*) FILTER (WHERE new_conf >= 90), 0), 2) AS after_wr,
      count(*) FILTER (WHERE old_conf >= 80) AS before_n_80,
      ROUND(100.0 * count(*) FILTER (WHERE old_conf >= 80 AND hit) / NULLIF(count(*) FILTER (WHERE old_conf >= 80), 0), 2) AS before_wr_80,
      count(*) FILTER (WHERE new_conf >= 80) AS after_n_80,
      ROUND(100.0 * count(*) FILTER (WHERE new_conf >= 80 AND hit) / NULLIF(count(*) FILTER (WHERE new_conf >= 80), 0), 2) AS after_wr_80
    FROM t
  LOOP RAISE NOTICE '  90+ before(n=% WR=%) after(n=% WR=%)', r.before_n, r.before_wr, r.after_n, r.after_wr;
       RAISE NOTICE '  80+ before(n=% WR=%) after(n=% WR=%)', r.before_n_80, r.before_wr_80, r.after_n_80, r.after_wr_80;
  END LOOP;
END $$;
