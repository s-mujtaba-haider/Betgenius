-- C40 fix — pick_history upsert RPC function (May 9, 2026).
--
-- Background: migration 20260506000003 introduced a partial UNIQUE index
-- `pick_history_production_natural_uniq ON (player_name, prop_type, line, game_date)
-- WHERE is_synthetic = false`. Process-games' direct-table writer path uses
-- PostgREST `?on_conflict=player_name,prop_type,line,game_date` which generates
-- `ON CONFLICT (cols) DO UPDATE` — which Postgres rejects with 42P10 because
-- partial indexes require the WHERE predicate in the conflict_target. Empirically
-- verified May 9, 2026 by migration 20260509000012.
--
-- Result: every player-prop pick_history POST has 400'd silently for 3 days
-- (May 6 14:17 → May 9 fix), masked by `} catch (_e) { /* ignore */ }` at
-- process-games:2927 + 2995. /performance page missing 3 days of organic
-- algorithm rows.
--
-- Fix: SECURITY DEFINER RPC function that does the INSERT ... ON CONFLICT
-- (cols) WHERE is_synthetic = false DO UPDATE server-side. Edge function will
-- call /rest/v1/rpc/upsert_pick_history with the row payload as `payload`
-- JSON arg. Returns the row's id (whether INSERTed or UPDATEd) for write-
-- confirmation observability.
--
-- Why SECURITY DEFINER: the calling role (service_role via Bearer auth) has
-- table privileges, but RPC function execution is more reliable when DEFINER
-- runs as table-owner. Also, this lets us tighten EXECUTE grants if we ever
-- want to lock down the RPC.
--
-- The function uses jsonb_populate_record to read the payload into a row of
-- the pick_history table type. Any keys in the payload not present in the
-- table are ignored. Any required NOT NULL columns missing from the payload
-- will trigger a NOT NULL violation (raised back to caller).
--
-- ON CONFLICT update list: explicit list of columns process-games actually
-- updates on rerun. Excludes id / created_at (immutable identity / timestamp).

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
  -- Map JSON payload onto the pick_history rowtype. Unknown keys ignored.
  rec := jsonb_populate_record(NULL::public.pick_history, payload);

  -- Insert with partial-index-aware ON CONFLICT. The WHERE predicate is
  -- required for Postgres to resolve the conflict_target to the partial
  -- index pick_history_production_natural_uniq.
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

GRANT EXECUTE ON FUNCTION public.upsert_pick_history(JSONB) TO service_role, authenticated;

COMMENT ON FUNCTION public.upsert_pick_history(JSONB) IS
  'C40 fix (May 9, 2026). Server-side INSERT ... ON CONFLICT ... WHERE predicate '
  'for pick_history. Required because PostgREST `?on_conflict=cols` URL syntax '
  'cannot supply the WHERE predicate that the partial unique index '
  '`pick_history_production_natural_uniq` (WHERE is_synthetic = false) needs '
  'for conflict resolution. Returns the inserted/updated row id.';
