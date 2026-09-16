DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '300s';

  -- §1 OOS-check the 8+ flagged inversions
  -- Split: derive on OLDER half (training window), validate on NEWER half (holdout).
  -- Sample: batter MLB picks last 60d with hit IS NOT NULL.
  RAISE NOTICE '[D-520 §1] inversion robustness check — TRAIN (older 30d) vs HOLDOUT (newer 30d):';
  FOR r IN
    WITH src AS (
      SELECT mlb_market_type, pick_side, hit, game_date, breakdown
      FROM public.pick_history_real
      WHERE sport='mlb' AND is_synthetic=false AND hit IS NOT NULL
        AND mlb_market_type LIKE 'batter_%'
        AND game_date >= (NOW() AT TIME ZONE 'America/New_York')::DATE - 60
    ),
    factor_kv AS (
      SELECT s.hit,
             CASE WHEN s.game_date < (NOW() AT TIME ZONE 'America/New_York')::DATE - 30
                  THEN 'TRAIN' ELSE 'HOLDOUT' END AS split,
             j.key AS factor_name,
             CASE WHEN (j.value::text) ~ '^-?[0-9]+(\.[0-9]+)?$' THEN (j.value::text)::numeric END AS v
      FROM src s, LATERAL jsonb_each_text(s.breakdown) AS j(key, value)
      WHERE j.key IN (
        'score_handedness_matchup', 'score_weather_wind', 'score_lineup_consistency',
        'score_wind_direction_hr',  'score_weather_temp', 'score_batter_form_power',
        'score_batter_babip',       'score_opposing_pitcher_quality',
        'score_recent_at_bats'
      )
    )
    SELECT factor_name, split,
           count(*) FILTER (WHERE v > 0) AS n_pos,
           ROUND(100.0 * count(*) FILTER (WHERE v > 0 AND hit)
                 / NULLIF(count(*) FILTER (WHERE v > 0), 0), 2) AS wr_pos,
           count(*) FILTER (WHERE v < 0) AS n_neg,
           ROUND(100.0 * count(*) FILTER (WHERE v < 0 AND hit)
                 / NULLIF(count(*) FILTER (WHERE v < 0), 0), 2) AS wr_neg,
           ROUND(100.0 * count(*) FILTER (WHERE v > 0 AND hit) / NULLIF(count(*) FILTER (WHERE v > 0), 0), 2) -
           ROUND(100.0 * count(*) FILTER (WHERE v < 0 AND hit) / NULLIF(count(*) FILTER (WHERE v < 0), 0), 2) AS edge_pp
    FROM factor_kv WHERE v IS NOT NULL
    GROUP BY factor_name, split
    HAVING count(*) FILTER (WHERE v > 0) >= 20 AND count(*) FILTER (WHERE v < 0) >= 20
    ORDER BY factor_name, split
  LOOP RAISE NOTICE '  factor=% split=% n_pos=% WR(+)=% n_neg=% WR(-)=% edge_pp=%',
    r.factor_name, r.split, r.n_pos, r.wr_pos, r.n_neg, r.wr_neg, r.edge_pp; END LOOP;

  -- §1b — verdict per factor: confirmed inversion if BOTH halves show edge_pp < -3
  -- (3pp tolerance for noise). Spurious otherwise.
  RAISE NOTICE '[D-520 §1b] verdict — CONFIRMED inversion (both halves <-3pp) vs SPURIOUS:';
  FOR r IN
    WITH src AS (
      SELECT mlb_market_type, hit, game_date, breakdown
      FROM public.pick_history_real
      WHERE sport='mlb' AND is_synthetic=false AND hit IS NOT NULL
        AND mlb_market_type LIKE 'batter_%'
        AND game_date >= (NOW() AT TIME ZONE 'America/New_York')::DATE - 60
    ),
    factor_kv AS (
      SELECT s.hit,
             CASE WHEN s.game_date < (NOW() AT TIME ZONE 'America/New_York')::DATE - 30
                  THEN 'TRAIN' ELSE 'HOLDOUT' END AS split,
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
        MAX(edge_pp) FILTER (WHERE split='TRAIN') AS train_edge,
        MAX(edge_pp) FILTER (WHERE split='HOLDOUT') AS holdout_edge,
        MAX(n_pos)   FILTER (WHERE split='HOLDOUT') AS holdout_n_pos,
        MAX(n_neg)   FILTER (WHERE split='HOLDOUT') AS holdout_n_neg
      FROM per_split GROUP BY factor_name
    )
    SELECT factor_name, ROUND(train_edge::numeric, 2) AS train_edge_pp,
           ROUND(holdout_edge::numeric, 2) AS holdout_edge_pp,
           holdout_n_pos, holdout_n_neg,
           CASE WHEN train_edge < -3 AND holdout_edge < -3 THEN 'CONFIRMED-INVERTED'
                WHEN train_edge < -3 AND holdout_edge >= -3 THEN 'SPURIOUS-train-only'
                WHEN train_edge >= -3 AND holdout_edge < -3 THEN 'EMERGING-INVERSION'
                ELSE 'NOT-INVERTED' END AS verdict
    FROM pivot
    ORDER BY train_edge ASC
  LOOP RAISE NOTICE '  factor=% train=% holdout=% holdout_n_pos=% holdout_n_neg=% verdict=%',
    r.factor_name, r.train_edge_pp, r.holdout_edge_pp, r.holdout_n_pos, r.holdout_n_neg, r.verdict; END LOOP;
END $$;
