-- D-598 SHIP 2 VERIFY (read-only) — post-deploy populate + non-flatline check.
--
-- Run AFTER the next process-games-mlb cron tick has generated fresh batter
-- picks with the new code. Confirms:
--   1. score_opp_pitcher_pitchtype_quality populated across all 4 batter markets
--      (hits / TB / HR / batter_strikeouts) per spec.
--   2. opp_pitcher_id stored in breakdown JSONB (the gap D-599 hit).
--   3. D-585 variance gate (distinct >= 5 AND top_pct < 80%) passes per market.
--   4. NBA / pitcher / game scorers UNTOUCHED — sanity sweep across markets
--      that should NOT carry the factor.
--
-- Read-only. No writes. Safe to run repeatedly.

DO $$
DECLARE
  v_now        timestamptz := now();
  v_cutoff     timestamptz := v_now - interval '24 hours';
  v_deploy_sha text := '<post-d598-commit>';

  -- 4 spec'd markets + the 2 incidentally-shared scorers (RBI / runs_scored).
  v_markets text[] := ARRAY['batter_hits','batter_total_bases','batter_hr','batter_strikeouts','batter_rbis','batter_runs_scored'];
  m         text;

  v_total_picks      bigint;
  v_with_factor      bigint;
  v_factor_populated_pct numeric;
  v_distinct_values  bigint;
  v_top_value        int;
  v_top_count        bigint;
  v_top_pct          numeric;
  v_with_opp_id      bigint;
  v_opp_id_pct       numeric;
  v_passes_gate      boolean;

  v_nba_factor_count bigint;
  v_pitcher_factor_count bigint;
  v_game_factor_count bigint;
BEGIN
  RAISE NOTICE '════════════════════════════════════════════════════════════════';
  RAISE NOTICE 'D-598 SHIP 2 VERIFY — score_opp_pitcher_pitchtype_quality wire-up';
  RAISE NOTICE 'cutoff: % (last 24h since now=%)', v_cutoff, v_now;
  RAISE NOTICE '════════════════════════════════════════════════════════════════';

  FOREACH m IN ARRAY v_markets LOOP
    SELECT count(*) INTO v_total_picks
      FROM pick_history
     WHERE created_at >= v_cutoff
       AND mlb_market_type = m
       AND is_synthetic = false;

    IF v_total_picks = 0 THEN
      RAISE NOTICE '[%]: 0 post-deploy picks (cron has not run yet, or no slate)', m;
      CONTINUE;
    END IF;

    SELECT
      count(*) FILTER (WHERE (breakdown->>'score_opp_pitcher_pitchtype_quality') IS NOT NULL),
      count(DISTINCT (breakdown->>'score_opp_pitcher_pitchtype_quality')::int),
      count(*) FILTER (WHERE (breakdown->>'opp_pitcher_id') IS NOT NULL)
      INTO v_with_factor, v_distinct_values, v_with_opp_id
      FROM pick_history
     WHERE created_at >= v_cutoff
       AND mlb_market_type = m
       AND is_synthetic = false;

    v_factor_populated_pct := round(100.0 * v_with_factor / GREATEST(v_total_picks,1), 1);
    v_opp_id_pct           := round(100.0 * v_with_opp_id / GREATEST(v_total_picks,1), 1);

    -- D-585 variance gate: top value's frequency.
    SELECT (breakdown->>'score_opp_pitcher_pitchtype_quality')::int,
           count(*)
      INTO v_top_value, v_top_count
      FROM pick_history
     WHERE created_at >= v_cutoff
       AND mlb_market_type = m
       AND is_synthetic = false
       AND (breakdown->>'score_opp_pitcher_pitchtype_quality') IS NOT NULL
     GROUP BY (breakdown->>'score_opp_pitcher_pitchtype_quality')::int
     ORDER BY count(*) DESC
     LIMIT 1;

    v_top_pct := round(100.0 * v_top_count / GREATEST(v_with_factor,1), 1);
    v_passes_gate := (v_distinct_values >= 5 AND v_top_pct < 80);

    RAISE NOTICE '';
    RAISE NOTICE '[%] n=% factor_pop_pct=% (%/%) opp_id_pct=% distinct=% top_value=% top_pct=% gate=%',
      m, v_total_picks, v_factor_populated_pct, v_with_factor, v_total_picks,
      v_opp_id_pct, v_distinct_values, v_top_value, v_top_pct,
      CASE WHEN v_passes_gate THEN 'PASS' ELSE 'FAIL (flatline / under-distinct)' END;
  END LOOP;

  -- Sanity: NBA / pitcher / game scorers must NOT carry this factor.
  SELECT count(*) INTO v_nba_factor_count
    FROM pick_history
   WHERE created_at >= v_cutoff
     AND sport = 'nba'
     AND (breakdown->>'score_opp_pitcher_pitchtype_quality') IS NOT NULL;

  SELECT count(*) INTO v_pitcher_factor_count
    FROM pick_history
   WHERE created_at >= v_cutoff
     AND sport = 'mlb'
     AND mlb_market_type LIKE 'pitcher_%'
     AND (breakdown->>'score_opp_pitcher_pitchtype_quality') IS NOT NULL;

  SELECT count(*) INTO v_game_factor_count
    FROM pick_history
   WHERE created_at >= v_cutoff
     AND sport = 'mlb'
     AND mlb_market_type IN ('game_side','game_total','game_spread')
     AND (breakdown->>'score_opp_pitcher_pitchtype_quality') IS NOT NULL;

  RAISE NOTICE '';
  RAISE NOTICE '── ISOLATION CHECK (batter-only) ──';
  RAISE NOTICE 'NBA picks with factor: % (MUST be 0)', v_nba_factor_count;
  RAISE NOTICE 'MLB pitcher picks with factor: % (MUST be 0)', v_pitcher_factor_count;
  RAISE NOTICE 'MLB game picks with factor: % (MUST be 0)', v_game_factor_count;

  IF v_nba_factor_count > 0 OR v_pitcher_factor_count > 0 OR v_game_factor_count > 0 THEN
    RAISE EXCEPTION 'D-598 ISOLATION VIOLATION — factor leaked into non-batter scorer.';
  END IF;

  RAISE NOTICE '';
  RAISE NOTICE 'D-598 SHIP 2 VERIFY complete.';
END $$;
