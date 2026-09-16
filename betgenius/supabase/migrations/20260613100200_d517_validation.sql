DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '300s';

  -- §A — sample size + coverage on resolved batter picks last 60d
  RAISE NOTICE '[D-517 §A] validation sample (resolved batter MLB picks, 60d):';
  FOR r IN
    SELECT count(*) AS total,
           count(*) FILTER (WHERE breakdown ? 'last10_hit_rate_pct') AS has_l10,
           ROUND(100.0 * count(*) FILTER (WHERE breakdown ? 'last10_hit_rate_pct')
                 / NULLIF(count(*), 0), 2) AS pct_with_l10
    FROM public.pick_history_real
    WHERE sport='mlb' AND is_synthetic=false
      AND mlb_market_type LIKE 'batter_%'
      AND hit IS NOT NULL
      AND game_date >= (NOW() AT TIME ZONE 'America/New_York')::DATE - 60
  LOOP RAISE NOTICE '  total=% has_l10=% pct=%', r.total, r.has_l10, r.pct_with_l10; END LOOP;

  -- §B — WR-by-band BEFORE (current confidence) on batter markets only
  RAISE NOTICE '[D-517 §B] BEFORE — WR-by-band (current confidence), batter markets only:';
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
      count(*) FILTER (WHERE hit) AS wins,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0), 2) AS wr
    FROM public.pick_history_real
    WHERE sport='mlb' AND is_synthetic=false
      AND mlb_market_type LIKE 'batter_%'
      AND hit IS NOT NULL
      AND game_date >= (NOW() AT TIME ZONE 'America/New_York')::DATE - 60
    GROUP BY band
  LOOP RAISE NOTICE '  band=% n=% wins=% WR=%', r.band, r.n, r.wins, r.wr; END LOOP;

  -- §C — WR-by-band AFTER (new confidence via d517_new_conf), batter markets only
  RAISE NOTICE '[D-517 §C] AFTER — WR-by-band (new confidence), batter markets only:';
  FOR r IN
    WITH t AS (
      SELECT public.d517_new_conf(confidence, mlb_market_type, pick_side, breakdown) AS new_conf,
             hit
      FROM public.pick_history_real
      WHERE sport='mlb' AND is_synthetic=false
        AND mlb_market_type LIKE 'batter_%'
        AND hit IS NOT NULL
        AND game_date >= (NOW() AT TIME ZONE 'America/New_York')::DATE - 60
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
      count(*) FILTER (WHERE hit) AS wins,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0), 2) AS wr
    FROM t GROUP BY band
  LOOP RAISE NOTICE '  band=% n=% wins=% WR=%', r.band, r.n, r.wins, r.wr; END LOOP;

  -- §D — Inversion test: in the AFTER world, do 90+ picks beat 70-84?
  RAISE NOTICE '[D-517 §D] INVERSION test — does 90+ beat 70-84 (AFTER)?:';
  FOR r IN
    WITH t AS (
      SELECT public.d517_new_conf(confidence, mlb_market_type, pick_side, breakdown) AS new_conf, hit
      FROM public.pick_history_real
      WHERE sport='mlb' AND is_synthetic=false
        AND mlb_market_type LIKE 'batter_%'
        AND hit IS NOT NULL
        AND game_date >= (NOW() AT TIME ZONE 'America/New_York')::DATE - 60
    )
    SELECT
      CASE WHEN new_conf >= 90 THEN '90+'
           WHEN new_conf BETWEEN 70 AND 84 THEN '70-84'
           ELSE 'other' END AS megaband,
      count(*) AS n,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0), 2) AS wr
    FROM t WHERE new_conf >= 70
    GROUP BY megaband
  LOOP RAISE NOTICE '  megaband=% n=% WR=%', r.megaband, r.n, r.wr; END LOOP;

  -- §E — Canzone cohort: batter_total_bases with season hit-rate < 40%
  RAISE NOTICE '[D-517 §E] Canzone cohort (batter_total_bases, season_hit_rate_pct<40):';
  FOR r IN
    SELECT 'BEFORE' AS view,
           CASE WHEN confidence >= 90 THEN '90+'
                WHEN confidence BETWEEN 70 AND 89 THEN '70-89'
                ELSE '<70' END AS band,
           count(*) AS n,
           ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0), 2) AS wr
    FROM public.pick_history_real
    WHERE sport='mlb' AND is_synthetic=false
      AND mlb_market_type = 'batter_total_bases'
      AND hit IS NOT NULL
      AND breakdown ? 'season_hit_rate_pct'
      AND (breakdown->>'season_hit_rate_pct')::numeric < 40
      AND game_date >= (NOW() AT TIME ZONE 'America/New_York')::DATE - 60
    GROUP BY band
    UNION ALL
    SELECT 'AFTER' AS view,
           CASE WHEN public.d517_new_conf(confidence, mlb_market_type, pick_side, breakdown) >= 90 THEN '90+'
                WHEN public.d517_new_conf(confidence, mlb_market_type, pick_side, breakdown) BETWEEN 70 AND 89 THEN '70-89'
                ELSE '<70' END AS band,
           count(*) AS n,
           ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0), 2) AS wr
    FROM public.pick_history_real
    WHERE sport='mlb' AND is_synthetic=false
      AND mlb_market_type = 'batter_total_bases'
      AND hit IS NOT NULL
      AND breakdown ? 'season_hit_rate_pct'
      AND (breakdown->>'season_hit_rate_pct')::numeric < 40
      AND game_date >= (NOW() AT TIME ZONE 'America/New_York')::DATE - 60
    GROUP BY band
    ORDER BY view, band
  LOOP RAISE NOTICE '  view=% band=% n=% WR=%', r.view, r.band, r.n, r.wr; END LOOP;

  -- §F — Regression test: per-batter-market WR shift (before/after, all bands together)
  RAISE NOTICE '[D-517 §F] regression per-batter-market (90+ band shift):';
  FOR r IN
    SELECT
      mlb_market_type,
      count(*) FILTER (WHERE confidence >= 90) AS before_n_90plus,
      ROUND(100.0 * count(*) FILTER (WHERE confidence >= 90 AND hit)
            / NULLIF(count(*) FILTER (WHERE confidence >= 90), 0), 2) AS before_wr_90plus,
      count(*) FILTER (WHERE public.d517_new_conf(confidence, mlb_market_type, pick_side, breakdown) >= 90) AS after_n_90plus,
      ROUND(100.0 * count(*) FILTER (WHERE public.d517_new_conf(confidence, mlb_market_type, pick_side, breakdown) >= 90 AND hit)
            / NULLIF(count(*) FILTER (WHERE public.d517_new_conf(confidence, mlb_market_type, pick_side, breakdown) >= 90), 0), 2) AS after_wr_90plus
    FROM public.pick_history_real
    WHERE sport='mlb' AND is_synthetic=false
      AND mlb_market_type LIKE 'batter_%'
      AND hit IS NOT NULL
      AND game_date >= (NOW() AT TIME ZONE 'America/New_York')::DATE - 60
    GROUP BY mlb_market_type ORDER BY mlb_market_type
  LOOP RAISE NOTICE '  market=% before(n=% WR=%) after(n=% WR=%)',
    r.mlb_market_type, r.before_n_90plus, r.before_wr_90plus, r.after_n_90plus, r.after_wr_90plus; END LOOP;

  -- §G — Sanity: non-batter markets untouched (should be 0 changes)
  RAISE NOTICE '[D-517 §G] non-batter regression — count of picks where new_conf != old:';
  FOR r IN
    SELECT mlb_market_type, count(*) AS n,
           count(*) FILTER (WHERE public.d517_new_conf(confidence, mlb_market_type, pick_side, breakdown) <> confidence) AS changed
    FROM public.pick_history_real
    WHERE sport='mlb' AND is_synthetic=false
      AND mlb_market_type NOT LIKE 'batter_%'
      AND hit IS NOT NULL
      AND game_date >= (NOW() AT TIME ZONE 'America/New_York')::DATE - 60
    GROUP BY mlb_market_type ORDER BY mlb_market_type
  LOOP RAISE NOTICE '  market=% n=% changed=% (expect changed=0)',
    r.mlb_market_type, r.n, r.changed; END LOOP;

  -- §H — How many high-conf picks dropped below 70 (would no longer surface)?
  RAISE NOTICE '[D-517 §H] picks that were conf>=80 BEFORE but new_conf<70 AFTER (would be removed from sellable):';
  FOR r IN
    WITH t AS (
      SELECT confidence AS old_conf,
             public.d517_new_conf(confidence, mlb_market_type, pick_side, breakdown) AS new_conf,
             hit, mlb_market_type
      FROM public.pick_history_real
      WHERE sport='mlb' AND is_synthetic=false
        AND mlb_market_type LIKE 'batter_%'
        AND hit IS NOT NULL
        AND game_date >= (NOW() AT TIME ZONE 'America/New_York')::DATE - 60
    )
    SELECT
      count(*) FILTER (WHERE old_conf >= 80 AND new_conf < 70) AS dropped_from_sellable,
      count(*) FILTER (WHERE old_conf >= 80) AS total_old_80plus,
      ROUND(100.0 * count(*) FILTER (WHERE old_conf >= 80 AND new_conf < 70 AND hit)
            / NULLIF(count(*) FILTER (WHERE old_conf >= 80 AND new_conf < 70), 0), 2) AS wr_of_dropped
    FROM t
  LOOP RAISE NOTICE '  dropped_from_sellable=% total_old_80plus=% WR_of_dropped=%',
    r.dropped_from_sellable, r.total_old_80plus, r.wr_of_dropped; END LOOP;
END $$;
