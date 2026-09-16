-- §15.10 High #9 — score_player_injury side-flip verification.
-- READ-ONLY. Tests whether OVER+UNDER picks on the same player+prop+date
-- store opposite-sign score_player_injury values (correct) vs same-sign
-- (bug).

DO $$
DECLARE r RECORD;
BEGIN
  -- TASK 3: post-megadeploy organic pairs
  RAISE NOTICE '========================================================';
  RAISE NOTICE '=== TASK 3 — post-megadeploy organic (created_at >= 2026-05-04) ===';
  RAISE NOTICE '   pairs where same player + same prop + same date had both';
  RAISE NOTICE '   OVER and UNDER picks AND non-zero score_player_injury ===';
  RAISE NOTICE '========================================================';
  FOR r IN
    WITH pairs AS (
      SELECT a.player_name, a.prop_type, a.game_date,
        a.pick_side AS side_a, a.score_player_injury AS inj_a,
        b.pick_side AS side_b, b.score_player_injury AS inj_b
      FROM pick_history a
      JOIN pick_history b
        ON LOWER(a.player_name) = LOWER(b.player_name)
       AND a.prop_type = b.prop_type
       AND a.game_date = b.game_date
       AND a.pick_side = 'over'
       AND b.pick_side = 'under'
      WHERE a.source = 'process-games' AND b.source = 'process-games'
        AND a.is_synthetic = false AND b.is_synthetic = false
        AND a.created_at >= '2026-05-04'::timestamptz
        AND b.created_at >= '2026-05-04'::timestamptz
        AND (a.score_player_injury != 0 OR b.score_player_injury != 0)
    )
    SELECT
      COUNT(*) AS total_pairs,
      COUNT(*) FILTER (WHERE inj_a = inj_b)              AS same_value_bug,
      COUNT(*) FILTER (WHERE inj_a = -inj_b)             AS flipped_correctly,
      COUNT(*) FILTER (WHERE inj_a != inj_b AND inj_a != -inj_b) AS other,
      COUNT(*) FILTER (WHERE inj_a = 0 AND inj_b != 0)   AS over_zero_under_nonzero,
      COUNT(*) FILTER (WHERE inj_a != 0 AND inj_b = 0)   AS over_nonzero_under_zero
    FROM pairs
  LOOP
    RAISE NOTICE 'total_pairs=%', r.total_pairs;
    RAISE NOTICE '  same_value_bug:           % (inj_a == inj_b — BUG signature)', r.same_value_bug;
    RAISE NOTICE '  flipped_correctly:        % (inj_a == -inj_b — WORKING)', r.flipped_correctly;
    RAISE NOTICE '  other (mixed):            %', r.other;
    RAISE NOTICE '  over_zero_under_nonzero:  %', r.over_zero_under_nonzero;
    RAISE NOTICE '  over_nonzero_under_zero:  %', r.over_nonzero_under_zero;
  END LOOP;

  -- Sample 10 actual pairs for visual inspection
  RAISE NOTICE '';
  RAISE NOTICE '=== Sample matched-pair rows (post-megadeploy organic) ===';
  RAISE NOTICE '% | % | % | % | %',
    RPAD('player', 22), RPAD('prop_type', 12),
    LPAD('over_inj', 9), LPAD('under_inj', 10), RPAD('verdict', 18);
  FOR r IN
    WITH pairs AS (
      SELECT a.player_name, a.prop_type, a.game_date,
        a.score_player_injury AS inj_a,
        b.score_player_injury AS inj_b
      FROM pick_history a
      JOIN pick_history b
        ON LOWER(a.player_name) = LOWER(b.player_name)
       AND a.prop_type = b.prop_type
       AND a.game_date = b.game_date
       AND a.pick_side = 'over'
       AND b.pick_side = 'under'
      WHERE a.source = 'process-games' AND b.source = 'process-games'
        AND a.is_synthetic = false AND b.is_synthetic = false
        AND a.created_at >= '2026-05-04'::timestamptz
        AND b.created_at >= '2026-05-04'::timestamptz
        AND (a.score_player_injury != 0 OR b.score_player_injury != 0)
    )
    SELECT player_name, prop_type, game_date, inj_a, inj_b
    FROM pairs
    ORDER BY game_date DESC, player_name
    LIMIT 15
  LOOP
    RAISE NOTICE '% | % | % | % | %',
      RPAD(LEFT(r.player_name, 22), 22),
      RPAD(r.prop_type, 12),
      LPAD(r.inj_a::TEXT, 9), LPAD(r.inj_b::TEXT, 10),
      RPAD(CASE
        WHEN r.inj_a = r.inj_b THEN 'BUG: same value'
        WHEN r.inj_a = -r.inj_b THEN 'flip OK'
        WHEN r.inj_a = 0 OR r.inj_b = 0 THEN 'one zero (mixed)'
        ELSE 'other'
      END, 18);
  END LOOP;

  -- TASK 4 — pre-megadeploy comparison
  RAISE NOTICE '';
  RAISE NOTICE '========================================================';
  RAISE NOTICE '=== TASK 4 — pre-megadeploy (created_at < 2026-05-04) ===';
  RAISE NOTICE '========================================================';
  FOR r IN
    WITH pairs AS (
      SELECT a.score_player_injury AS inj_a, b.score_player_injury AS inj_b
      FROM pick_history a
      JOIN pick_history b
        ON LOWER(a.player_name) = LOWER(b.player_name)
       AND a.prop_type = b.prop_type
       AND a.game_date = b.game_date
       AND a.pick_side = 'over'
       AND b.pick_side = 'under'
      WHERE a.is_synthetic = false AND b.is_synthetic = false
        AND a.created_at < '2026-05-04'::timestamptz
        AND b.created_at < '2026-05-04'::timestamptz
        AND (a.score_player_injury != 0 OR b.score_player_injury != 0)
    )
    SELECT
      COUNT(*) AS total_pairs,
      COUNT(*) FILTER (WHERE inj_a = inj_b)              AS same_value_bug,
      COUNT(*) FILTER (WHERE inj_a = -inj_b)             AS flipped_correctly,
      COUNT(*) FILTER (WHERE inj_a != inj_b AND inj_a != -inj_b) AS other
    FROM pairs
  LOOP
    RAISE NOTICE 'total_pairs=% same_value_bug=% flipped_correctly=% other=%',
      r.total_pairs, r.same_value_bug, r.flipped_correctly, r.other;
  END LOOP;

  -- Bonus: how often does each side get a non-zero injury value
  -- post-megadeploy organic? Independent test of whether the gate works.
  RAISE NOTICE '';
  RAISE NOTICE '=== Side-wise non-zero count (post-megadeploy organic, player-prop only) ===';
  FOR r IN
    SELECT pick_side, COUNT(*) AS total,
      COUNT(*) FILTER (WHERE score_player_injury = 0) AS zero,
      COUNT(*) FILTER (WHERE score_player_injury > 0) AS positive,
      COUNT(*) FILTER (WHERE score_player_injury < 0) AS negative,
      MIN(score_player_injury) AS mn, MAX(score_player_injury) AS mx
    FROM pick_history
    WHERE source = 'process-games' AND is_synthetic = false
      AND created_at >= '2026-05-04'::timestamptz
      AND prop_type NOT IN ('spread','game_total')
    GROUP BY pick_side ORDER BY pick_side
  LOOP
    RAISE NOTICE 'side=% total=% zero=% positive=% negative=% range=%..%',
      RPAD(r.pick_side, 6), r.total, r.zero, r.positive, r.negative, r.mn, r.mx;
  END LOOP;
END $$;
