-- D-172a — fix upsert_pick_history RPC silently dropping 8 columns
--   (production blocker discovered during D-172 §1.12 verification, May 15 2026)
--
-- Background:
--   The May 9 RPC (migration 20260509000013, commit `c82de30`) wrapped the
--   pick_history upsert in a stored function with an EXPLICIT column list.
--   Every algorithm column added since that day has been silently dropped
--   on insert/update — the columns exist on the table (added via ALTER
--   TABLE in their respective migrations) but the RPC's INSERT column
--   list never received the matching `rec.column_name` line, so every
--   row carries the table-default value (FALSE for booleans, 0 for ints).
--
-- D-172 §1.12 verification (May 15 2026, 14:00 UTC cron tick) empirically
-- detected this for:
--   score_low_min_risk        (D-136 May 13)
--   score_blowout_risk        (D-137 May 13)
--   score_line_movement       (D-139 May 13)
--   unbettable_juice_flag     (D-164 May 14)
--   is_secondary_market       (D-165 May 14)
--   coin_flip_flag            (D-166 May 14)
--   negative_stacking_flag    (D-167 May 14)
--   negative_factor_count     (D-167 May 14)
--
-- Confirmed via cross-read: recommendations_cache (which writes via direct
-- PostgREST POST, not RPC) DOES have correct flag values for the same
-- (player_name, prop_type, line, game_date) row. pick_history was the
-- only silent loss path.
--
-- Fix:
--   Recreate the RPC with the FULL pick_history column set. Both INSERT
--   column list AND DO UPDATE SET clause updated. Strategy preserved
--   (jsonb_populate_record + partial-index-aware ON CONFLICT). Function
--   signature, return type, security definer, search_path all unchanged.
--
-- Backfill:
--   Today's pick_history rows (game_date = 2026-05-15) are updated from
--   recommendations_cache for the 8 columns. Older rows leave at default
--   because no recommendations_cache match exists (cache TTL).
--
-- Rollback:
--   git revert this migration's commit + run the prior RPC body. Detailed
--   in the comment block at bottom of file.
-- =============================================================================

BEGIN;

-- ============================================================================
-- 1. Recreate the RPC with full column set
-- ============================================================================

CREATE OR REPLACE FUNCTION public.upsert_pick_history(payload JSONB)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  rec       public.pick_history;
  result_id UUID;
BEGIN
  -- jsonb_populate_record handles unknown payload keys gracefully and
  -- maps the matching keys onto the public.pick_history rowtype.
  rec := jsonb_populate_record(NULL::public.pick_history, payload);

  INSERT INTO public.pick_history (
    player_name, team, opponent, game_time, game_date, is_home,
    prop_type, line, pick_side, odds,
    season_avg, recent_avg, floor_val, ceiling_val,
    l5_hit_count, l10_hit_count, season_hit_pct,
    is_b2b, rest_days, minutes_l5_avg, minutes_l10_avg, minutes_trend,
    opp_ppg_allowed,
    score_l5, score_l10, score_season, score_floor_ceiling, score_recent_form,
    score_home_away, score_rest, score_b2b, score_minutes_trend, score_pace,
    score_opp_defense, score_z_score, score_role_change, score_vig_filter,
    score_usg_rate, score_regression, score_market_conf, score_home_away_split,
    score_minutes_floor, score_consistency, score_prop_type_penalty,
    score_stale_data, score_player_injury,
    score_trivial_line_penalty, score_trivial_line_cap,
    score_minutes_volume, score_minutes_stability,
    -- D-172a additions (May 13-14 columns previously silently dropped):
    score_low_min_risk, score_blowout_risk, score_line_movement,
    unbettable_juice_flag, is_secondary_market,
    coin_flip_flag, negative_stacking_flag, negative_factor_count,
    -- end D-172a additions
    projected_stat, stat_stdev, z_score, per_minute_rate, projected_minutes,
    teammate_injuries_count, usage_boost,
    confidence, verdict, ai_analysis,
    source, recommendation_shown,
    is_synthetic, sport
  ) VALUES (
    rec.player_name, rec.team, rec.opponent, rec.game_time, rec.game_date, rec.is_home,
    rec.prop_type, rec.line, rec.pick_side, rec.odds,
    rec.season_avg, rec.recent_avg, rec.floor_val, rec.ceiling_val,
    rec.l5_hit_count, rec.l10_hit_count, rec.season_hit_pct,
    rec.is_b2b, rec.rest_days, rec.minutes_l5_avg, rec.minutes_l10_avg, rec.minutes_trend,
    rec.opp_ppg_allowed,
    rec.score_l5, rec.score_l10, rec.score_season, rec.score_floor_ceiling, rec.score_recent_form,
    rec.score_home_away, rec.score_rest, rec.score_b2b, rec.score_minutes_trend, rec.score_pace,
    rec.score_opp_defense, rec.score_z_score, rec.score_role_change, rec.score_vig_filter,
    rec.score_usg_rate, rec.score_regression, rec.score_market_conf, rec.score_home_away_split,
    rec.score_minutes_floor, rec.score_consistency, rec.score_prop_type_penalty,
    rec.score_stale_data, rec.score_player_injury,
    rec.score_trivial_line_penalty, rec.score_trivial_line_cap,
    rec.score_minutes_volume, rec.score_minutes_stability,
    -- D-172a additions
    rec.score_low_min_risk, rec.score_blowout_risk, rec.score_line_movement,
    rec.unbettable_juice_flag, rec.is_secondary_market,
    rec.coin_flip_flag, rec.negative_stacking_flag, rec.negative_factor_count,
    -- end D-172a additions
    rec.projected_stat, rec.stat_stdev, rec.z_score, rec.per_minute_rate, rec.projected_minutes,
    rec.teammate_injuries_count, rec.usage_boost,
    rec.confidence, rec.verdict, rec.ai_analysis,
    COALESCE(rec.source, 'process-games'), rec.recommendation_shown,
    COALESCE(rec.is_synthetic, false), COALESCE(rec.sport, 'nba')
  )
  ON CONFLICT (player_name, prop_type, line, game_date) WHERE is_synthetic = false
  DO UPDATE SET
    team = EXCLUDED.team,
    opponent = EXCLUDED.opponent,
    game_time = EXCLUDED.game_time,
    is_home = EXCLUDED.is_home,
    pick_side = EXCLUDED.pick_side,
    odds = EXCLUDED.odds,
    season_avg = EXCLUDED.season_avg,
    recent_avg = EXCLUDED.recent_avg,
    floor_val = EXCLUDED.floor_val,
    ceiling_val = EXCLUDED.ceiling_val,
    l5_hit_count = EXCLUDED.l5_hit_count,
    l10_hit_count = EXCLUDED.l10_hit_count,
    season_hit_pct = EXCLUDED.season_hit_pct,
    is_b2b = EXCLUDED.is_b2b,
    rest_days = EXCLUDED.rest_days,
    minutes_l5_avg = EXCLUDED.minutes_l5_avg,
    minutes_l10_avg = EXCLUDED.minutes_l10_avg,
    minutes_trend = EXCLUDED.minutes_trend,
    opp_ppg_allowed = EXCLUDED.opp_ppg_allowed,
    score_l5 = EXCLUDED.score_l5,
    score_l10 = EXCLUDED.score_l10,
    score_season = EXCLUDED.score_season,
    score_floor_ceiling = EXCLUDED.score_floor_ceiling,
    score_recent_form = EXCLUDED.score_recent_form,
    score_home_away = EXCLUDED.score_home_away,
    score_rest = EXCLUDED.score_rest,
    score_b2b = EXCLUDED.score_b2b,
    score_minutes_trend = EXCLUDED.score_minutes_trend,
    score_pace = EXCLUDED.score_pace,
    score_opp_defense = EXCLUDED.score_opp_defense,
    score_z_score = EXCLUDED.score_z_score,
    score_role_change = EXCLUDED.score_role_change,
    score_vig_filter = EXCLUDED.score_vig_filter,
    score_usg_rate = EXCLUDED.score_usg_rate,
    score_regression = EXCLUDED.score_regression,
    score_market_conf = EXCLUDED.score_market_conf,
    score_home_away_split = EXCLUDED.score_home_away_split,
    score_minutes_floor = EXCLUDED.score_minutes_floor,
    score_consistency = EXCLUDED.score_consistency,
    score_prop_type_penalty = EXCLUDED.score_prop_type_penalty,
    score_stale_data = EXCLUDED.score_stale_data,
    score_player_injury = EXCLUDED.score_player_injury,
    score_trivial_line_penalty = EXCLUDED.score_trivial_line_penalty,
    score_trivial_line_cap = EXCLUDED.score_trivial_line_cap,
    score_minutes_volume = EXCLUDED.score_minutes_volume,
    score_minutes_stability = EXCLUDED.score_minutes_stability,
    -- D-172a additions in DO UPDATE
    score_low_min_risk = EXCLUDED.score_low_min_risk,
    score_blowout_risk = EXCLUDED.score_blowout_risk,
    score_line_movement = EXCLUDED.score_line_movement,
    unbettable_juice_flag = EXCLUDED.unbettable_juice_flag,
    is_secondary_market = EXCLUDED.is_secondary_market,
    coin_flip_flag = EXCLUDED.coin_flip_flag,
    negative_stacking_flag = EXCLUDED.negative_stacking_flag,
    negative_factor_count = EXCLUDED.negative_factor_count,
    -- end D-172a additions
    projected_stat = EXCLUDED.projected_stat,
    stat_stdev = EXCLUDED.stat_stdev,
    z_score = EXCLUDED.z_score,
    per_minute_rate = EXCLUDED.per_minute_rate,
    projected_minutes = EXCLUDED.projected_minutes,
    teammate_injuries_count = EXCLUDED.teammate_injuries_count,
    usage_boost = EXCLUDED.usage_boost,
    confidence = EXCLUDED.confidence,
    verdict = EXCLUDED.verdict,
    ai_analysis = EXCLUDED.ai_analysis,
    source = EXCLUDED.source,
    recommendation_shown = EXCLUDED.recommendation_shown,
    sport = EXCLUDED.sport
  RETURNING id INTO result_id;

  RETURN result_id;
END;
$$;

COMMENT ON FUNCTION public.upsert_pick_history(JSONB) IS
  'D-172a (May 15 2026): full-column-set upsert. Previous version (May 9 D-090) silently dropped score_low_min_risk + score_blowout_risk + score_line_movement + unbettable_juice_flag + is_secondary_market + coin_flip_flag + negative_stacking_flag + negative_factor_count because they were added to the table after the RPC was written. Detected during D-172 §1.12 verification of May 15 14:00 UTC cron tick.';

-- ============================================================================
-- 2. Backfill today's pick_history rows from recommendations_cache.
-- ============================================================================

UPDATE public.pick_history ph
SET
  score_low_min_risk      = COALESCE(rc.score_low_min_risk, ph.score_low_min_risk),
  score_blowout_risk      = COALESCE(rc.score_blowout_risk, ph.score_blowout_risk),
  score_line_movement     = COALESCE(rc.score_line_movement, ph.score_line_movement),
  unbettable_juice_flag   = COALESCE(rc.unbettable_juice_flag, ph.unbettable_juice_flag),
  is_secondary_market     = COALESCE(rc.is_secondary_market, ph.is_secondary_market),
  coin_flip_flag          = COALESCE(rc.coin_flip_flag, ph.coin_flip_flag),
  negative_stacking_flag  = COALESCE(rc.negative_stacking_flag, ph.negative_stacking_flag),
  negative_factor_count   = COALESCE(rc.negative_factor_count, ph.negative_factor_count)
FROM public.recommendations_cache rc
WHERE ph.player_name = rc.player_name
  AND ph.prop_type   = rc.prop_type
  AND ph.line        = rc.line
  AND ph.pick_side   = rc.pick_side
  AND ph.game_date   = rc.game_date
  AND ph.game_date   = DATE '2026-05-15'
  AND ph.source      = 'process-games'
  AND ph.is_synthetic = FALSE;

COMMIT;

-- =============================================================================
-- ROLLBACK
-- =============================================================================
-- The previous RPC version is at migration 20260509000013_c40_upsert_pick_history_rpc.sql.
-- Restore via:
--   1. Drop the current RPC: DROP FUNCTION public.upsert_pick_history(JSONB);
--   2. Re-run the prior CREATE OR REPLACE block from 20260509000013, lines 35-156.
--   3. The May 13-14 columns will then revert to silently-dropped behavior on
--      subsequent upserts. Today's backfill UPDATE rows will keep their values
--      (UPDATE persists; only future inserts/updates lose them again).
