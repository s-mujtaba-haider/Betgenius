-- D-520 SHIP 1 — OOS robustness check using NTILE(2) so each half has equal n.
DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '300s';

  RAISE NOTICE '[D-520 §1] inversion check — split via NTILE(2) on game_date:';
  RAISE NOTICE '  HALF_A = older breakdown-available picks; HALF_B = newer (incl. OOS post-D499)';
  FOR r IN
    WITH src AS (
      SELECT mlb_market_type, hit, breakdown,
             NTILE(2) OVER (ORDER BY game_date, id) AS halfn
      FROM public.pick_history_real
      WHERE sport='mlb' AND is_synthetic=false AND hit IS NOT NULL
        AND mlb_market_type LIKE 'batter_%'
        AND breakdown IS NOT NULL
    ),
    factor_kv AS (
      SELECT s.hit,
             CASE WHEN s.halfn = 1 THEN 'A_older' ELSE 'B_newer' END AS split,
             j.key AS factor_name,
             CASE WHEN (j.value::text) ~ '^-?[0-9]+(\.[0-9]+)?$' THEN (j.value::text)::numeric END AS v
      FROM src s, LATERAL jsonb_each_text(s.breakdown) AS j(key, value)
      WHERE j.key IN ('score_handedness_matchup','score_weather_wind','score_lineup_consistency',
                      'score_wind_direction_hr','score_weather_temp','score_batter_form_power',
                      'score_batter_babip','score_opposing_pitcher_quality','score_recent_at_bats')
    )
    SELECT factor_name, split,
           count(*) FILTER (WHERE v > 0) AS n_pos,
           ROUND(100.0 * count(*) FILTER (WHERE v > 0 AND hit) / NULLIF(count(*) FILTER (WHERE v > 0), 0), 2) AS wr_pos,
           count(*) FILTER (WHERE v < 0) AS n_neg,
           ROUND(100.0 * count(*) FILTER (WHERE v < 0 AND hit) / NULLIF(count(*) FILTER (WHERE v < 0), 0), 2) AS wr_neg,
           ROUND(100.0 * count(*) FILTER (WHERE v > 0 AND hit) / NULLIF(count(*) FILTER (WHERE v > 0), 0), 2) -
           ROUND(100.0 * count(*) FILTER (WHERE v < 0 AND hit) / NULLIF(count(*) FILTER (WHERE v < 0), 0), 2) AS edge_pp
    FROM factor_kv WHERE v IS NOT NULL
    GROUP BY factor_name, split
    HAVING count(*) FILTER (WHERE v > 0) >= 20 AND count(*) FILTER (WHERE v < 0) >= 20
    ORDER BY factor_name, split
  LOOP RAISE NOTICE '  factor=% split=% n_pos=% WR(+)=% n_neg=% WR(-)=% edge_pp=%',
    r.factor_name, r.split, r.n_pos, r.wr_pos, r.n_neg, r.wr_neg, r.edge_pp; END LOOP;

  -- Verdict
  RAISE NOTICE '[D-520 §1b] verdict — robust if BOTH halves <-3pp:';
  FOR r IN
    WITH src AS (
      SELECT mlb_market_type, hit, breakdown,
             NTILE(2) OVER (ORDER BY game_date, id) AS halfn
      FROM public.pick_history_real
      WHERE sport='mlb' AND is_synthetic=false AND hit IS NOT NULL
        AND mlb_market_type LIKE 'batter_%'
        AND breakdown IS NOT NULL
    ),
    factor_kv AS (
      SELECT s.hit,
             CASE WHEN s.halfn = 1 THEN 'A' ELSE 'B' END AS split,
             j.key AS factor_name,
             CASE WHEN (j.value::text) ~ '^-?[0-9]+(\.[0-9]+)?$' THEN (j.value::text)::numeric END AS v
      FROM src s, LATERAL jsonb_each_text(s.breakdown) AS j(key, value)
      WHERE j.key IN ('score_handedness_matchup','score_weather_wind','score_lineup_consistency',
                      'score_wind_direction_hr','score_weather_temp','score_batter_form_power',
                      'score_batter_babip','score_opposing_pitcher_quality','score_recent_at_bats')
    ),
    per_split AS (
      SELECT factor_name, split,
             100.0 * count(*) FILTER (WHERE v > 0 AND hit) / NULLIF(count(*) FILTER (WHERE v > 0), 0) -
             100.0 * count(*) FILTER (WHERE v < 0 AND hit) / NULLIF(count(*) FILTER (WHERE v < 0), 0) AS edge_pp,
             count(*) FILTER (WHERE v > 0) AS n_pos,
             count(*) FILTER (WHERE v < 0) AS n_neg
      FROM factor_kv WHERE v IS NOT NULL
      GROUP BY factor_name, split
      HAVING count(*) FILTER (WHERE v > 0) >= 20 AND count(*) FILTER (WHERE v < 0) >= 20
    ),
    pivot AS (
      SELECT factor_name,
        MAX(edge_pp) FILTER (WHERE split='A') AS a_edge,
        MAX(edge_pp) FILTER (WHERE split='B') AS b_edge
      FROM per_split GROUP BY factor_name
    )
    SELECT factor_name,
           ROUND(a_edge::numeric, 2) AS a_edge_pp,
           ROUND(b_edge::numeric, 2) AS b_edge_pp,
           CASE WHEN a_edge < -3 AND b_edge < -3 THEN 'CONFIRMED-INVERTED'
                WHEN a_edge IS NULL OR b_edge IS NULL THEN 'INSUFFICIENT-DATA'
                WHEN a_edge < -3 AND b_edge >= -3 THEN 'A-only-inverted (SPURIOUS)'
                WHEN a_edge >= -3 AND b_edge < -3 THEN 'B-only-inverted (SPURIOUS)'
                ELSE 'NOT-INVERTED' END AS verdict
    FROM pivot
    ORDER BY GREATEST(a_edge, b_edge) ASC NULLS LAST
  LOOP RAISE NOTICE '  factor=% A_edge=% B_edge=% verdict=%',
    r.factor_name, r.a_edge_pp, r.b_edge_pp, r.verdict; END LOOP;
END $$;
