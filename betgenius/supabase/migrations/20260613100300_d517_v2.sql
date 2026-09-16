-- D-517 v2 — try NEGATIVE-ONLY penalty (no positive reward) with stronger
-- magnitudes. Rationale from v1 result: v1 lifted high-l10 picks INTO higher
-- bands, inflating mid-band WR and not fixing the inversion. v2 only
-- PENALIZES weak l10, no positive boost.
CREATE OR REPLACE FUNCTION public.d517_new_conf_v2(
  p_old_conf INTEGER,
  p_market   TEXT,
  p_pick_side TEXT,
  p_breakdown JSONB
)
RETURNS INTEGER LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  v_l10 NUMERIC;
  v_factor INTEGER;
  v_weight NUMERIC := 2.0;  -- stronger than v1 (was 1.5)
  v_weighted INTEGER;
BEGIN
  IF p_market IS NULL OR p_market NOT LIKE 'batter_%' THEN RETURN p_old_conf; END IF;
  IF p_breakdown IS NULL OR NOT (p_breakdown ? 'last10_hit_rate_pct') THEN
    RETURN p_old_conf;
  END IF;
  v_l10 := (p_breakdown->>'last10_hit_rate_pct')::NUMERIC;
  v_factor := CASE
    WHEN v_l10 >= 60 THEN 0
    WHEN v_l10 >= 50 THEN -3
    WHEN v_l10 >= 40 THEN -6
    WHEN v_l10 >= 30 THEN -10
    ELSE -15
  END;
  v_weighted := ROUND(v_factor * v_weight)::INTEGER;
  RETURN LEAST(100, GREATEST(0, p_old_conf + v_weighted));
END;
$$;
GRANT EXECUTE ON FUNCTION public.d517_new_conf_v2(INTEGER, TEXT, TEXT, JSONB) TO PUBLIC;

DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '300s';

  -- §C2 AFTER v2 — WR-by-band
  RAISE NOTICE '[D-517 v2 §C2] AFTER v2 (neg-only, w=2.0) — WR-by-band, batter only:';
  FOR r IN
    WITH t AS (
      SELECT public.d517_new_conf_v2(confidence, mlb_market_type, pick_side, breakdown) AS new_conf, hit
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
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0), 2) AS wr
    FROM t GROUP BY band
  LOOP RAISE NOTICE '  band=% n=% WR=%', r.band, r.n, r.wr; END LOOP;

  -- §D2 inversion test under v2
  RAISE NOTICE '[D-517 v2 §D2] inversion test under v2 (does 90+ beat 70-84?):';
  FOR r IN
    WITH t AS (
      SELECT public.d517_new_conf_v2(confidence, mlb_market_type, pick_side, breakdown) AS new_conf, hit
      FROM public.pick_history_real
      WHERE sport='mlb' AND is_synthetic=false
        AND mlb_market_type LIKE 'batter_%'
        AND hit IS NOT NULL
        AND game_date >= (NOW() AT TIME ZONE 'America/New_York')::DATE - 60
    )
    SELECT
      CASE WHEN new_conf >= 90 THEN '90+'
           WHEN new_conf BETWEEN 70 AND 84 THEN '70-84' ELSE 'other' END AS megaband,
      count(*) AS n,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0), 2) AS wr
    FROM t WHERE new_conf >= 70
    GROUP BY megaband
  LOOP RAISE NOTICE '  megaband=% n=% WR=%', r.megaband, r.n, r.wr; END LOOP;

  -- §F2 per-batter-market under v2
  RAISE NOTICE '[D-517 v2 §F2] per-batter-market 90+ shift under v2:';
  FOR r IN
    SELECT mlb_market_type,
           count(*) FILTER (WHERE confidence >= 90) AS before_n,
           ROUND(100.0 * count(*) FILTER (WHERE confidence >= 90 AND hit)
                 / NULLIF(count(*) FILTER (WHERE confidence >= 90), 0), 2) AS before_wr,
           count(*) FILTER (WHERE public.d517_new_conf_v2(confidence, mlb_market_type, pick_side, breakdown) >= 90) AS after_n,
           ROUND(100.0 * count(*) FILTER (WHERE public.d517_new_conf_v2(confidence, mlb_market_type, pick_side, breakdown) >= 90 AND hit)
                 / NULLIF(count(*) FILTER (WHERE public.d517_new_conf_v2(confidence, mlb_market_type, pick_side, breakdown) >= 90), 0), 2) AS after_wr
    FROM public.pick_history_real
    WHERE sport='mlb' AND is_synthetic=false
      AND mlb_market_type LIKE 'batter_%'
      AND hit IS NOT NULL
      AND game_date >= (NOW() AT TIME ZONE 'America/New_York')::DATE - 60
    GROUP BY mlb_market_type ORDER BY mlb_market_type
  LOOP RAISE NOTICE '  market=% before(n=% WR=%) after(n=% WR=%)',
    r.mlb_market_type, r.before_n, r.before_wr, r.after_n, r.after_wr; END LOOP;

  -- §E2 Canzone cohort under v2
  RAISE NOTICE '[D-517 v2 §E2] Canzone cohort (batter_total_bases, season_hit_rate<40):';
  FOR r IN
    SELECT
      CASE WHEN public.d517_new_conf_v2(confidence, mlb_market_type, pick_side, breakdown) >= 90 THEN '90+'
           WHEN public.d517_new_conf_v2(confidence, mlb_market_type, pick_side, breakdown) BETWEEN 70 AND 89 THEN '70-89'
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
  LOOP RAISE NOTICE '  v2 band=% n=% WR=%', r.band, r.n, r.wr; END LOOP;
END $$;
