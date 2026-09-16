-- Tier 4 #10 Phase 2 step 1 — current weights probe (read-only).
-- Dumps w_recent_form / w_regression + every other weight that touches
-- player-prop scoring so the simulation downstream uses real values.
DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '=== algorithm_weights latest row (full) ===';
  FOR r IN
    SELECT * FROM algorithm_weights ORDER BY id DESC LIMIT 1
  LOOP
    RAISE NOTICE 'id=% w_recent_form=% w_regression=% w_l5=% w_l10=% w_season=% w_floor_ceiling=% w_market_conf=% w_minutes_trend=% w_pace=% w_opp_defense=% w_vig_filter=% w_consistency=% w_z_score=% w_prop_type=%',
      r.id, r.w_recent_form, r.w_regression, r.w_l5, r.w_l10, r.w_season,
      r.w_floor_ceiling, r.w_market_conf, r.w_minutes_trend, r.w_pace,
      r.w_opp_defense, r.w_vig_filter, r.w_consistency, r.w_z_score,
      r.w_prop_type;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE '=== all algorithm_weights columns (introspection) ===';
  FOR r IN
    SELECT column_name FROM information_schema.columns
    WHERE table_schema='public' AND table_name='algorithm_weights'
      AND column_name LIKE 'w_%'
    ORDER BY column_name
  LOOP
    RAISE NOTICE 'col=%', r.column_name;
  END LOOP;
END $$;
