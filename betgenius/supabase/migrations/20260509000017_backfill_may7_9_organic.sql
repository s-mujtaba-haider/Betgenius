-- May 7-9 organic player-prop pick_history backfill (May 9, 2026).
--
-- Background: C40 (framework v2.31 §15.1) — partial UNIQUE index
-- pick_history_production_natural_uniq (added by 20260506000003) is
-- incompatible with PostgREST's `?on_conflict=cols` URL syntax, so every
-- player-prop POST from process-games:logPickToHistory has 400'd silently
-- since May 6 14:17 UTC. Empirically verified May 9 by 20260509000012.
-- Forward fix shipped commit c82de30 (RPC `upsert_pick_history` +
-- edge function rewrite). Last good organic day in pick_history was
-- May 6 (155 player-prop rows); May 7-9 = 0 rows.
--
-- This migration backfills the 3-day gap by copying from
-- recommendations_cache (which has all the scoring data already
-- computed by the cron's recs-cache writer, which DOES work because it
-- uses a regular non-partial UNIQUE constraint that PostgREST handles).
--
-- Source: recommendations_cache rows for May 7-9, sport=nba, player-prop
-- types only (NOT spread/game_total — those write to pick_history fine via
-- ignore-duplicates path; their rows already exist in pick_history per
-- audit migration 20260509000016).
--
-- Target: pick_history with is_synthetic=false (organic) and
-- source='backfill-may7-9-organic' for audit/rollback distinction from real
-- cron rows ('process-games').
--
-- Pre-flight counts (captured by 20260509000016 audit @ 18:46 UTC May 9):
--   recommendations_cache player-prop / nba: May 7=158, May 8=146, May 9=161
--   pick_history baseline player-prop:        May 7=0,   May 8=0,   May 9=0
--
-- Idempotency: ON CONFLICT (player_name, prop_type, line, game_date)
-- WHERE is_synthetic = false DO NOTHING — the WHERE predicate is REQUIRED
-- to match the partial unique index per the C40 lesson empirically tested
-- May 9 (Option (a) ON CONFLICT (cols) DO UPDATE → 42P10).
--
-- Settlement: hit=NULL, actual_value=NULL, resolved_at=NULL on insert.
-- resolve-picks nightly run (jobid 3, schedule '30 5 * * *') picks up
-- unresolved pre-today rows automatically — no manual settle pass needed.
--
-- Rollback: DELETE FROM pick_history WHERE source = 'backfill-may7-9-organic';
-- The unique source marker isolates these rows from real-cron rows.
-- Frontend reads (Performance, Tracker) treat all source values equally
-- so users see backfilled rows the same as live rows.

DO $$
DECLARE
  v_pre_may7  INTEGER;
  v_pre_may8  INTEGER;
  v_pre_may9  INTEGER;
  v_post_may7 INTEGER;
  v_post_may8 INTEGER;
  v_post_may9 INTEGER;
  v_inserted  INTEGER;
  v_recs_may7 INTEGER;
  v_recs_may8 INTEGER;
  v_recs_may9 INTEGER;
BEGIN
  -- Pre-counts
  SELECT COUNT(*) INTO v_pre_may7 FROM pick_history
    WHERE game_date = '2026-05-07' AND is_synthetic = false
      AND prop_type NOT IN ('spread','game_total');
  SELECT COUNT(*) INTO v_pre_may8 FROM pick_history
    WHERE game_date = '2026-05-08' AND is_synthetic = false
      AND prop_type NOT IN ('spread','game_total');
  SELECT COUNT(*) INTO v_pre_may9 FROM pick_history
    WHERE game_date = '2026-05-09' AND is_synthetic = false
      AND prop_type NOT IN ('spread','game_total');

  SELECT COUNT(*) INTO v_recs_may7 FROM recommendations_cache
    WHERE game_date = '2026-05-07' AND sport = 'nba'
      AND prop_type NOT IN ('spread','game_total');
  SELECT COUNT(*) INTO v_recs_may8 FROM recommendations_cache
    WHERE game_date = '2026-05-08' AND sport = 'nba'
      AND prop_type NOT IN ('spread','game_total');
  SELECT COUNT(*) INTO v_recs_may9 FROM recommendations_cache
    WHERE game_date = '2026-05-09' AND sport = 'nba'
      AND prop_type NOT IN ('spread','game_total');

  RAISE NOTICE '=== May 7-9 organic backfill @ % ===', NOW();
  RAISE NOTICE 'Pre-counts pick_history (player-prop, nba, organic):';
  RAISE NOTICE '  May 7=%  May 8=%  May 9=%', v_pre_may7, v_pre_may8, v_pre_may9;
  RAISE NOTICE 'Source-availability recs_cache (player-prop, nba):';
  RAISE NOTICE '  May 7=%  May 8=%  May 9=%', v_recs_may7, v_recs_may8, v_recs_may9;

  -- The actual backfill: INSERT...SELECT with ON CONFLICT WHERE predicate
  -- to honor the partial unique index. Score columns cast to INTEGER (recs_cache
  -- stored them as NUMERIC; pick_history schema is INTEGER). Other columns
  -- map 1:1 by name. Columns only in pick_history take their column defaults
  -- or are explicitly set: source='backfill-may7-9-organic', is_synthetic=false,
  -- algorithm_version='2026-05-04-megadeploy' (matches the algorithm that
  -- produced the recs_cache rows — these were scored by the post-megadeploy
  -- cron just like any production day's rows).
  INSERT INTO public.pick_history (
    player_name, team, opponent, game_time, game_date, is_home,
    prop_type, line, pick_side, odds,
    season_avg, recent_avg, floor_val, ceiling_val,
    l5_hit_count, l10_hit_count, season_hit_pct,
    is_b2b, rest_days, minutes_l5_avg, minutes_l10_avg, minutes_trend,
    opp_ppg_allowed, opp_rpg_allowed, opp_fg_pct_allowed, opp_3pt_pct_allowed, pace_opp_ppg,
    score_l5, score_l10, score_season, score_floor_ceiling, score_recent_form,
    score_home_away, score_rest, score_b2b, score_minutes_trend, score_pace,
    score_opp_defense, score_z_score, score_role_change, score_vig_filter,
    score_usg_rate, score_regression, score_market_conf, score_home_away_split,
    score_minutes_floor, score_consistency, score_prop_type_penalty,
    score_stale_data, score_player_injury,
    score_trivial_line_penalty, score_trivial_line_cap,
    score_minutes_volume, score_minutes_stability,
    projected_stat, stat_stdev, z_score, per_minute_rate, projected_minutes,
    teammate_injuries_count, usage_boost,
    confidence, verdict, ai_analysis,
    source, is_synthetic, sport, algorithm_version,
    created_at
  )
  SELECT
    rc.player_name, rc.team, rc.opponent, rc.game_time, rc.game_date, rc.is_home,
    rc.prop_type, rc.line, rc.pick_side, rc.odds,
    rc.season_avg, rc.recent_avg, rc.floor_val, rc.ceiling_val,
    rc.l5_hit_count, rc.l10_hit_count, rc.season_hit_pct,
    rc.is_b2b, rc.rest_days, rc.minutes_l5_avg, rc.minutes_l10_avg, rc.minutes_trend,
    rc.opp_ppg_allowed, rc.opp_rpg_allowed, rc.opp_fg_pct_allowed, rc.opp_3pt_pct_allowed, rc.pace_opp_ppg,
    -- Score columns: NUMERIC → INTEGER cast (round to nearest int)
    ROUND(rc.score_l5)::INTEGER, ROUND(rc.score_l10)::INTEGER,
    ROUND(rc.score_season)::INTEGER, ROUND(rc.score_floor_ceiling)::INTEGER,
    ROUND(rc.score_recent_form)::INTEGER, ROUND(rc.score_home_away)::INTEGER,
    ROUND(rc.score_rest)::INTEGER, ROUND(rc.score_b2b)::INTEGER,
    ROUND(rc.score_minutes_trend)::INTEGER, ROUND(rc.score_pace)::INTEGER,
    ROUND(rc.score_opp_defense)::INTEGER, rc.score_z_score, rc.score_role_change, rc.score_vig_filter,
    rc.score_usg_rate, rc.score_regression, rc.score_market_conf, rc.score_home_away_split,
    rc.score_minutes_floor, rc.score_consistency, rc.score_prop_type_penalty,
    rc.score_stale_data, rc.score_player_injury,
    rc.score_trivial_line_penalty, rc.score_trivial_line_cap,
    rc.score_minutes_volume, rc.score_minutes_stability,
    rc.projected_stat, rc.stat_stdev, rc.z_score, rc.per_minute_rate, rc.projected_minutes,
    rc.teammate_injuries_count, rc.usage_boost,
    rc.confidence, rc.verdict, rc.ai_analysis,
    -- Backfill-specific columns:
    'backfill-may7-9-organic',
    false,
    rc.sport,
    '2026-05-04-megadeploy',
    -- Preserve created_at from recs_cache so pick_history.created_at reflects
    -- when the row was originally scored, not when this backfill ran.
    rc.created_at
  FROM public.recommendations_cache rc
  WHERE rc.game_date IN ('2026-05-07', '2026-05-08', '2026-05-09')
    AND rc.sport = 'nba'
    AND rc.prop_type NOT IN ('spread', 'game_total')
  ON CONFLICT (player_name, prop_type, line, game_date) WHERE is_synthetic = false
  DO NOTHING;

  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  RAISE NOTICE 'INSERT completed: % rows inserted (conflicts skipped)', v_inserted;

  -- Post-counts
  SELECT COUNT(*) INTO v_post_may7 FROM pick_history
    WHERE game_date = '2026-05-07' AND is_synthetic = false
      AND prop_type NOT IN ('spread','game_total');
  SELECT COUNT(*) INTO v_post_may8 FROM pick_history
    WHERE game_date = '2026-05-08' AND is_synthetic = false
      AND prop_type NOT IN ('spread','game_total');
  SELECT COUNT(*) INTO v_post_may9 FROM pick_history
    WHERE game_date = '2026-05-09' AND is_synthetic = false
      AND prop_type NOT IN ('spread','game_total');

  RAISE NOTICE '';
  RAISE NOTICE 'Post-counts pick_history (player-prop, nba, organic):';
  RAISE NOTICE '  May 7=% (delta +%)  May 8=% (delta +%)  May 9=% (delta +%)',
    v_post_may7, v_post_may7 - v_pre_may7,
    v_post_may8, v_post_may8 - v_pre_may8,
    v_post_may9, v_post_may9 - v_pre_may9;

  RAISE NOTICE '';
  RAISE NOTICE 'Coverage check (post / source):';
  RAISE NOTICE '  May 7: %/%  (% pct)',
    v_post_may7, v_recs_may7,
    CASE WHEN v_recs_may7 > 0 THEN ROUND(100.0 * v_post_may7 / v_recs_may7, 1) ELSE 0 END;
  RAISE NOTICE '  May 8: %/%  (% pct)',
    v_post_may8, v_recs_may8,
    CASE WHEN v_recs_may8 > 0 THEN ROUND(100.0 * v_post_may8 / v_recs_may8, 1) ELSE 0 END;
  RAISE NOTICE '  May 9: %/%  (% pct)',
    v_post_may9, v_recs_may9,
    CASE WHEN v_recs_may9 > 0 THEN ROUND(100.0 * v_post_may9 / v_recs_may9, 1) ELSE 0 END;
END $$;
