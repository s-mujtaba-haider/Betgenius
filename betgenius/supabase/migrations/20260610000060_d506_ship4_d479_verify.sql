-- D-506 SHIP 4 — D-479 cap verify on fresh resolved data.
--
-- D-479 (ship 2026-06-08): cap MLB confidence to 65 for pick_side=over AND
-- odds >= +100 AND confidence in [70, 79]. This drops GOOD-tier longshot
-- OVERs into LEAN tier so they stop surfacing as high-conf buys.
--
-- The check from D-505 SHIP 1 returned TOO-EARLY because pick_history_real
-- ended at 2026-05-29 (resolution stall). Post-backfill, all D-506-stalled
-- picks (2026-05-29 → 2026-06-10) are resolved, so the D-479 cluster has
-- fresh resolved data on both sides of the ship-date.

DO $$
DECLARE r RECORD; v_total_real BIGINT; v_max_resolved DATE;
BEGIN
  -- Sanity: confirm pick_history_real now has fresh data
  SELECT count(*), max(game_date) INTO v_total_real, v_max_resolved
  FROM public.pick_history_real WHERE is_synthetic = false;
  RAISE NOTICE '[D-506 SHIP 4] pick_history_real total=%, max_game_date=%',
    v_total_real, v_max_resolved;

  -- D-479 BEFORE (game_date < 2026-06-08): longshot OVER GOOD-tier
  RAISE NOTICE '[D-506 SHIP 4] D-479 BEFORE (game_date < 2026-06-08, MLB, GOOD-tier OVER odds>=+100):';
  FOR r IN
    SELECT count(*) AS n,
           count(*) FILTER (WHERE hit) AS wins,
           ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0), 2) AS wr,
           ROUND(SUM(
             CASE WHEN hit THEN (odds * 1.0 / 100.0)
                  WHEN hit IS FALSE THEN -1.0
                  ELSE 0 END
           )::NUMERIC, 2) AS units
    FROM public.pick_history_real
    WHERE sport = 'mlb' AND is_synthetic = false
      AND confidence BETWEEN 65 AND 79 AND pick_side = 'over' AND odds >= 100
      AND game_date < DATE '2026-06-08' AND hit IS NOT NULL
  LOOP
    RAISE NOTICE '  n=% wins=% wr=% units=%', r.n, r.wins, r.wr, r.units;
  END LOOP;

  -- D-479 AFTER (game_date >= 2026-06-08): longshot OVER GOOD-tier
  -- POST-CAP: confidence in [70, 79] should be ZERO; the cap drops them to 65.
  RAISE NOTICE '[D-506 SHIP 4] D-479 AFTER (game_date >= 2026-06-08, MLB, GOOD-tier OVER odds>=+100):';
  FOR r IN
    SELECT count(*) AS n,
           count(*) FILTER (WHERE hit) AS wins,
           ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*), 0), 2) AS wr
    FROM public.pick_history_real
    WHERE sport = 'mlb' AND is_synthetic = false
      AND confidence BETWEEN 65 AND 79 AND pick_side = 'over' AND odds >= 100
      AND game_date >= DATE '2026-06-08' AND hit IS NOT NULL
  LOOP
    RAISE NOTICE '  n=% wins=% wr=%', r.n, r.wins, r.wr;
  END LOOP;

  -- D-479 cap-firing check: any GOOD-tier (70-79) longshot OVER picks
  -- created AFTER 2026-06-08 are evidence the cap did NOT fire on them
  -- (they should have been capped to 65 → LEAN tier).
  RAISE NOTICE '[D-506 SHIP 4] D-479 cap-firing audit (post-6/8 picks with confidence in [70,79] OVER odds>=+100):';
  FOR r IN
    SELECT count(*) AS n_should_be_zero_post_cap
    FROM public.pick_history_real
    WHERE sport = 'mlb' AND is_synthetic = false
      AND confidence BETWEEN 70 AND 79 AND pick_side = 'over' AND odds >= 100
      AND game_date >= DATE '2026-06-08'
  LOOP
    RAISE NOTICE '  n_should_be_zero_post_cap=%', r.n_should_be_zero_post_cap;
  END LOOP;
END $$;
