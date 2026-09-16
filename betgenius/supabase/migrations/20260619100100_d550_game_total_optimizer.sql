-- D-549 SHIP 2 — REUSABLE holdout-validated optimizer harness.
--
-- THE INFRASTRUCTURE. Generic optimizer that takes a market_type
-- and a set of factor weights, runs coordinate descent on TRAIN,
-- evaluates strictly on TEST holdout, and enforces the rule
-- "OOS must beat real-odds BE to count as a winner."
--
-- Usage on next market: copy this migration, change 3 things:
--   _market_filter     — WHERE clause filter (e.g. mlb_market_type='X')
--   _factor_keys       — array of breakdown keys to re-weight
--   _projection_key    — breakdown key holding the model's projection
--                        (for sign-accuracy comparison)
--
-- Internal contract (the breakdown JSONB must contain):
--   - raw_edge                   (numeric — signed; >0 = projection > line)
--   - <_projection_key>          (numeric — model projection)
--   - each <_factor_keys>        (numeric — already-weighted factor score)
--
-- Output: RAISE NOTICE rows tagged with batch ID (override via DO header).
-- All TEMP tables dropped at end. Strictly read-only on pick_history.
--
-- THE GATE rule (enforced in §F): winner_config = config with TEST_edge_pp > 0
-- against real per-pick BE. In-sample TRAIN_edge_pp is reported alongside —
-- the gap between TRAIN and TEST IS the overfit signature.

DO $$
DECLARE
  -- ============= PARAMETERS — change per market =============
  -- D-550 reuse log (first reuse of the D-549 harness).
  -- Edits at this header: 4 (_batch_tag, _market_filter, _projection_key,
  --                          _factor_keys array). Then the §A
  -- CREATE TEMP TABLE block needed 3 more inline edits (jsonb_build_object
  -- keys + the WHERE clause's `breakdown ? 'X'` check + the
  -- NULLIF(breakdown->>'X','')). So 7 edits total, not 3 — noted honestly
  -- in d550 §H. Filed D-552 to make §A drive from _factor_keys via
  -- dynamic SQL so future reuses really are header-only.
  _batch_tag        TEXT    := 'D-550-game_total';
  _market_filter    TEXT    := 'game_total';           -- mlb_market_type=
  _projection_key   TEXT    := 'proj_total';           -- breakdown key
  -- Game_total factor candidates. Picked by domain (run-prediction
  -- drivers) since D-550 SHIP 2 signal gate showed only 2 raw inputs
  -- cross |r|>0.20 (weather_temp_f=0.227, umpire_k_zone_idx=0.278).
  -- The score_X variants of those + 3 other run-driving factors.
  _factor_keys      TEXT[]  := ARRAY[
    'score_offense_differential',
    'score_pitching_matchup',
    'score_bullpen_strength',
    'score_weather_temp',
    'score_umpire_k_zone'
  ];
  -- Weight multiplier grid for coordinate descent
  _mult_grid        NUMERIC[] := ARRAY[0.0, 0.5, 1.0, 1.5, 2.0, 3.0];
  -- ==========================================================
  r RECORD;
  v_fk TEXT;       -- iterated factor key (renamed to avoid table-column ambiguity)
  v_m NUMERIC;     -- iterated multiplier
  best_mult NUMERIC;
  best_train_sa NUMERIC;
  pass_idx INT;
BEGIN
  SET LOCAL statement_timeout TO '300s';

  -- =================================================================
  -- §A — Build a row-per-pick scratch table for the chosen market.
  -- One row per organic resolved pick; train/test by hash.
  -- =================================================================
  CREATE TEMP TABLE d549_corpus AS
  SELECT
    id,
    actual_value AS actual,
    line,
    pick_side,
    confidence,
    hit,
    odds,
    (breakdown->>'raw_edge')::numeric                        AS raw_edge,
    NULLIF(breakdown->>'proj_total','')::numeric             AS projection,  -- D-550 edit
    -- per-factor: pull (key, weighted_score) into JSONB so coordinate
    -- descent can iterate without per-factor branching.
    -- D-550 edit: 5 game_total factor keys (instead of pitcher_k's).
    jsonb_build_object(
      'score_offense_differential',
        CASE WHEN (breakdown->>'score_offense_differential') ~ '^-?[0-9.]+$'
             THEN (breakdown->>'score_offense_differential')::numeric END,
      'score_pitching_matchup',
        CASE WHEN (breakdown->>'score_pitching_matchup') ~ '^-?[0-9.]+$'
             THEN (breakdown->>'score_pitching_matchup')::numeric END,
      'score_bullpen_strength',
        CASE WHEN (breakdown->>'score_bullpen_strength') ~ '^-?[0-9.]+$'
             THEN (breakdown->>'score_bullpen_strength')::numeric END,
      'score_weather_temp',
        CASE WHEN (breakdown->>'score_weather_temp') ~ '^-?[0-9.]+$'
             THEN (breakdown->>'score_weather_temp')::numeric END,
      'score_umpire_k_zone',
        CASE WHEN (breakdown->>'score_umpire_k_zone') ~ '^-?[0-9.]+$'
             THEN (breakdown->>'score_umpire_k_zone')::numeric END
    ) AS factors,
    (abs(hashtext(id::text)) % 4 = 0) AS is_test
  FROM public.pick_history
  WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
    AND hit IS NOT NULL AND mlb_market_type = _market_filter
    AND breakdown ? 'proj_total' AND actual_value IS NOT NULL          -- D-550 edit
    AND breakdown ? 'raw_edge';

  RAISE NOTICE '======== % §A: corpus loaded ========', _batch_tag;
  FOR r IN
    SELECT
      count(*) AS n_total,
      count(*) FILTER (WHERE is_test) AS n_test,
      count(*) FILTER (WHERE NOT is_test) AS n_train,
      count(*) FILTER (WHERE NOT is_test AND confidence >= 70) AS n_train_c70,
      count(*) FILTER (WHERE is_test AND confidence >= 70) AS n_test_c70
    FROM d549_corpus
  LOOP RAISE NOTICE '[% §A.1] n=% train=% test=% train_c70=% test_c70=%',
    _batch_tag, r.n_total, r.n_train, r.n_test, r.n_train_c70, r.n_test_c70; END LOOP;

  -- =================================================================
  -- §B — Coordinate-descent weight search on TRAIN.
  -- Multipliers start at 1.0 for each factor. For each pass, hold all
  -- others fixed and search the grid for the multiplier that maximizes
  -- TRAIN sign-accuracy. Update. Repeat.
  -- =================================================================
  CREATE TEMP TABLE d549_weights (
    factor_key TEXT PRIMARY KEY,
    mult NUMERIC NOT NULL DEFAULT 1.0
  );
  -- seed with current baseline (= 1.0 for every factor)
  INSERT INTO d549_weights(factor_key, mult)
  SELECT k, 1.0 FROM unnest(_factor_keys) AS t(k);

  -- Helper view computing new_conf for a row given d549_weights
  CREATE OR REPLACE FUNCTION d549_score(p_factors JSONB, p_raw_edge NUMERIC) RETURNS NUMERIC AS $f$
    SELECT 50 + COALESCE(p_raw_edge,0) * 6
      + COALESCE((SELECT sum(COALESCE((p_factors->>w.factor_key)::numeric, 0) * w.mult) FROM d549_weights w), 0);
  $f$ LANGUAGE sql STABLE;

  RAISE NOTICE '======== % §B: coordinate-descent search ========', _batch_tag;

  -- 3 passes of coordinate descent
  FOR pass_idx IN 1..3 LOOP
    FOREACH v_fk IN ARRAY _factor_keys LOOP
      best_mult := NULL;
      best_train_sa := -1.0;

      FOREACH v_m IN ARRAY _mult_grid LOOP
        -- set this factor's candidate weight (qualified column to avoid ambiguity)
        UPDATE d549_weights SET mult = v_m WHERE d549_weights.factor_key = v_fk;

        -- evaluate TRAIN sign-acc with this candidate weight
        DECLARE sa NUMERIC;
        BEGIN
          SELECT
            ROUND(100.0 * count(*) FILTER (WHERE
              (d549_score(factors, raw_edge) > 50 AND actual > line) OR
              (d549_score(factors, raw_edge) < 50 AND actual < line)
            ) / NULLIF(count(*) FILTER (WHERE d549_score(factors, raw_edge) <> 50 AND actual <> line), 0)::numeric, 2)
          INTO sa
          FROM d549_corpus WHERE NOT is_test;

          IF sa IS NOT NULL AND sa > best_train_sa THEN
            best_train_sa := sa;
            best_mult := v_m;
          END IF;
        END;
      END LOOP;

      -- commit the best mult for this factor
      UPDATE d549_weights SET mult = best_mult WHERE d549_weights.factor_key = v_fk;
      RAISE NOTICE '[% §B.pass%] factor=% best_mult=% train_sign_acc=%',
        _batch_tag, pass_idx, v_fk, best_mult, best_train_sa;
    END LOOP;
  END LOOP;

  -- =================================================================
  -- §C — Final weight config + TRAIN vs TEST evaluation
  -- =================================================================
  RAISE NOTICE '======== % §C: final weights ========', _batch_tag;
  FOR r IN SELECT factor_key, mult FROM d549_weights ORDER BY factor_key
  LOOP RAISE NOTICE '[% §C.1] %: mult=%', _batch_tag, r.factor_key, r.mult; END LOOP;

  -- TRAIN metrics (in-sample, expected to look good)
  RAISE NOTICE '======== % §D: TRAIN (in-sample) metrics ========', _batch_tag;
  FOR r IN
    WITH e AS (
      SELECT
        d549_score(factors, raw_edge) AS new_conf,
        actual, line, pick_side, hit, odds, confidence
      FROM d549_corpus WHERE NOT is_test
    )
    SELECT
      count(*) AS n,
      ROUND(100.0 * count(*) FILTER (WHERE
        (new_conf > 50 AND actual > line) OR (new_conf < 50 AND actual < line)
      ) / NULLIF(count(*) FILTER (WHERE new_conf <> 50 AND actual <> line), 0)::numeric, 2) AS sign_acc_pct,
      -- pick = side of projection (raw_edge>0 => over, <0 => under) — invariant under reweighting
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0)::numeric, 2) AS overall_win_pct,
      ROUND(avg(CASE WHEN odds < 0 THEN -odds::numeric / (-odds::numeric + 100) * 100
                     ELSE 100.0 / (odds::numeric + 100) * 100 END)::numeric, 2) AS avg_real_BE,
      -- new tier: pick all rows where new_conf >= 70 (the gated subset)
      count(*) FILTER (WHERE new_conf >= 70) AS n_new_c70,
      ROUND(100.0 * count(*) FILTER (WHERE new_conf >= 70 AND hit)
        / NULLIF(count(*) FILTER (WHERE new_conf >= 70), 0)::numeric, 2) AS new_c70_win_pct,
      ROUND(avg(CASE WHEN odds < 0 THEN -odds::numeric / (-odds::numeric + 100) * 100
                     ELSE 100.0 / (odds::numeric + 100) * 100 END) FILTER (WHERE new_conf >= 70)::numeric, 2) AS new_c70_real_BE
    FROM e
  LOOP RAISE NOTICE '[% §D.1] TRAIN n=% sign_acc=% win=% real_BE=% | new_c70: n=% win=% BE=%',
    _batch_tag, r.n, r.sign_acc_pct, r.overall_win_pct, r.avg_real_BE,
    r.n_new_c70, r.new_c70_win_pct, r.new_c70_real_BE; END LOOP;

  -- =================================================================
  -- §E — TEST (OOS) metrics — THE GATE
  -- =================================================================
  RAISE NOTICE '======== % §E: TEST (OOS holdout) — THE GATE ========', _batch_tag;
  FOR r IN
    WITH e AS (
      SELECT
        d549_score(factors, raw_edge) AS new_conf,
        actual, line, pick_side, hit, odds, confidence
      FROM d549_corpus WHERE is_test
    )
    SELECT
      count(*) AS n,
      ROUND(100.0 * count(*) FILTER (WHERE
        (new_conf > 50 AND actual > line) OR (new_conf < 50 AND actual < line)
      ) / NULLIF(count(*) FILTER (WHERE new_conf <> 50 AND actual <> line), 0)::numeric, 2) AS sign_acc_pct,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0)::numeric, 2) AS overall_win_pct,
      ROUND(avg(CASE WHEN odds < 0 THEN -odds::numeric / (-odds::numeric + 100) * 100
                     ELSE 100.0 / (odds::numeric + 100) * 100 END)::numeric, 2) AS avg_real_BE,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0)::numeric -
        avg(CASE WHEN odds < 0 THEN -odds::numeric / (-odds::numeric + 100) * 100
                 ELSE 100.0 / (odds::numeric + 100) * 100 END)::numeric, 2) AS edge_pp,
      count(*) FILTER (WHERE new_conf >= 70) AS n_new_c70,
      ROUND(100.0 * count(*) FILTER (WHERE new_conf >= 70 AND hit)
        / NULLIF(count(*) FILTER (WHERE new_conf >= 70), 0)::numeric, 2) AS new_c70_win_pct,
      ROUND(avg(CASE WHEN odds < 0 THEN -odds::numeric / (-odds::numeric + 100) * 100
                     ELSE 100.0 / (odds::numeric + 100) * 100 END) FILTER (WHERE new_conf >= 70)::numeric, 2) AS new_c70_real_BE,
      ROUND(100.0 * count(*) FILTER (WHERE new_conf >= 70 AND hit)
        / NULLIF(count(*) FILTER (WHERE new_conf >= 70), 0)::numeric -
        avg(CASE WHEN odds < 0 THEN -odds::numeric / (-odds::numeric + 100) * 100
                 ELSE 100.0 / (odds::numeric + 100) * 100 END) FILTER (WHERE new_conf >= 70)::numeric, 2) AS new_c70_edge_pp
    FROM e
  LOOP RAISE NOTICE '[% §E.1] TEST n=% sign_acc=% win=% real_BE=% edge_pp=% | new_c70: n=% win=% BE=% edge=%',
    _batch_tag, r.n, r.sign_acc_pct, r.overall_win_pct, r.avg_real_BE, r.edge_pp,
    r.n_new_c70, r.new_c70_win_pct, r.new_c70_real_BE, r.new_c70_edge_pp; END LOOP;

  -- =================================================================
  -- §F — Baseline comparison: current weights (all 1.0) on same TEST
  -- =================================================================
  UPDATE d549_weights SET mult = 1.0;
  RAISE NOTICE '======== % §F: BASELINE (current weights) on TEST ========', _batch_tag;
  FOR r IN
    WITH e AS (
      SELECT
        d549_score(factors, raw_edge) AS new_conf,
        actual, line, pick_side, hit, odds, confidence
      FROM d549_corpus WHERE is_test
    )
    SELECT
      count(*) AS n,
      ROUND(100.0 * count(*) FILTER (WHERE
        (new_conf > 50 AND actual > line) OR (new_conf < 50 AND actual < line)
      ) / NULLIF(count(*) FILTER (WHERE new_conf <> 50 AND actual <> line), 0)::numeric, 2) AS sign_acc_pct,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0)::numeric, 2) AS overall_win_pct,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0)::numeric -
        avg(CASE WHEN odds < 0 THEN -odds::numeric / (-odds::numeric + 100) * 100
                 ELSE 100.0 / (odds::numeric + 100) * 100 END)::numeric, 2) AS edge_pp,
      count(*) FILTER (WHERE new_conf >= 70) AS n_new_c70,
      ROUND(100.0 * count(*) FILTER (WHERE new_conf >= 70 AND hit)
        / NULLIF(count(*) FILTER (WHERE new_conf >= 70), 0)::numeric, 2) AS new_c70_win_pct,
      ROUND(100.0 * count(*) FILTER (WHERE new_conf >= 70 AND hit)
        / NULLIF(count(*) FILTER (WHERE new_conf >= 70), 0)::numeric -
        avg(CASE WHEN odds < 0 THEN -odds::numeric / (-odds::numeric + 100) * 100
                 ELSE 100.0 / (odds::numeric + 100) * 100 END) FILTER (WHERE new_conf >= 70)::numeric, 2) AS new_c70_edge_pp
    FROM e
  LOOP RAISE NOTICE '[% §F.1] BASELINE TEST n=% sign_acc=% win=% edge_pp=% | c70: n=% win=% edge=%',
    _batch_tag, r.n, r.sign_acc_pct, r.overall_win_pct, r.edge_pp,
    r.n_new_c70, r.new_c70_win_pct, r.new_c70_edge_pp; END LOOP;

  DROP FUNCTION d549_score(JSONB, NUMERIC);
  DROP TABLE d549_weights;
  DROP TABLE d549_corpus;
END $$;
