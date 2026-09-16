-- D-291 SHIP 2 (2026-05-22) fix — disambiguate column refs in aggregation RPC.

DROP FUNCTION IF EXISTS backtest_market_baseline_aggregate(DATE, DATE, TEXT[]);

CREATE OR REPLACE FUNCTION backtest_market_baseline_aggregate(
  p_window_start DATE,
  p_window_end DATE,
  p_bookmaker_filter TEXT[] DEFAULT ARRAY['hardrockbet','draftkings','fanduel']
)
RETURNS TABLE (
  market_name TEXT,
  n_picks BIGINT,
  n_hits BIGINT,
  n_pushes BIGINT,
  n_no_outcome BIGINT,
  wr_pct NUMERIC,
  ci_low NUMERIC,
  ci_high NUMERIC
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '120s'
AS $$
BEGIN
  RETURN QUERY
  WITH closing_snapshots AS (
    SELECT DISTINCT ON (o.event_id, o.bookmaker_key, o.market_key, o.player_name, o.line)
      o.event_id, o.snapshot_timestamp, o.commence_time, o.bookmaker_key, o.market_key,
      o.player_name, o.line, o.over_odds, o.under_odds
    FROM public.cache_mlb_historical_odds o
    WHERE o.commence_time >= p_window_start::timestamptz
      AND o.commence_time <= (p_window_end + 1)::timestamptz
      AND o.bookmaker_key = ANY(p_bookmaker_filter)
    ORDER BY o.event_id, o.bookmaker_key, o.market_key, o.player_name, o.line, o.snapshot_timestamp DESC
  ),
  picks AS (
    SELECT
      cs.event_id, cs.market_key AS mkt, cs.player_name, cs.line,
      CASE
        WHEN cs.over_odds IS NULL THEN 'under'
        WHEN cs.under_odds IS NULL THEN 'over'
        WHEN
          (CASE WHEN cs.over_odds > 0 THEN 100.0/(cs.over_odds+100) ELSE -cs.over_odds::numeric/(-cs.over_odds+100) END)
          >
          (CASE WHEN cs.under_odds > 0 THEN 100.0/(cs.under_odds+100) ELSE -cs.under_odds::numeric/(-cs.under_odds+100) END)
        THEN 'over' ELSE 'under'
      END AS pick_side,
      oc.home_score, oc.away_score, oc.resolution_data
    FROM closing_snapshots cs
    LEFT JOIN public.cache_mlb_historical_outcomes oc ON oc.event_id = cs.event_id AND oc.game_completed = TRUE
  ),
  resolved AS (
    SELECT
      p.mkt,
      CASE
        WHEN p.home_score IS NULL THEN 'no_outcome'
        WHEN p.mkt = 'h2h__home' THEN
          CASE WHEN (p.home_score > p.away_score AND p.pick_side = 'over') OR (p.home_score < p.away_score AND p.pick_side = 'under') THEN 'hit' ELSE 'miss' END
        WHEN p.mkt = 'h2h__away' THEN
          CASE WHEN (p.away_score > p.home_score AND p.pick_side = 'over') OR (p.away_score < p.home_score AND p.pick_side = 'under') THEN 'hit' ELSE 'miss' END
        WHEN p.mkt = 'totals' THEN
          CASE
            WHEN (p.home_score + p.away_score) > p.line AND p.pick_side = 'over' THEN 'hit'
            WHEN (p.home_score + p.away_score) < p.line AND p.pick_side = 'under' THEN 'hit'
            WHEN (p.home_score + p.away_score) = p.line THEN 'push'
            ELSE 'miss'
          END
        WHEN p.mkt IN ('batter_hits','batter_total_bases','batter_home_runs','batter_rbis','pitcher_strikeouts') THEN
          CASE
            WHEN p.resolution_data IS NULL OR p.resolution_data->p.player_name IS NULL THEN 'no_outcome'
            ELSE
              CASE
                WHEN (
                  CASE
                    WHEN p.mkt = 'batter_hits' THEN (p.resolution_data->p.player_name->>'hits')::numeric
                    WHEN p.mkt = 'batter_total_bases' THEN (p.resolution_data->p.player_name->>'total_bases')::numeric
                    WHEN p.mkt = 'batter_home_runs' THEN (p.resolution_data->p.player_name->>'home_runs')::numeric
                    WHEN p.mkt = 'batter_rbis' THEN (p.resolution_data->p.player_name->>'rbi')::numeric
                    WHEN p.mkt = 'pitcher_strikeouts' THEN (p.resolution_data->p.player_name->>'strikeouts')::numeric
                  END
                ) > p.line AND p.pick_side = 'over' THEN 'hit'
                WHEN (
                  CASE
                    WHEN p.mkt = 'batter_hits' THEN (p.resolution_data->p.player_name->>'hits')::numeric
                    WHEN p.mkt = 'batter_total_bases' THEN (p.resolution_data->p.player_name->>'total_bases')::numeric
                    WHEN p.mkt = 'batter_home_runs' THEN (p.resolution_data->p.player_name->>'home_runs')::numeric
                    WHEN p.mkt = 'batter_rbis' THEN (p.resolution_data->p.player_name->>'rbi')::numeric
                    WHEN p.mkt = 'pitcher_strikeouts' THEN (p.resolution_data->p.player_name->>'strikeouts')::numeric
                  END
                ) < p.line AND p.pick_side = 'under' THEN 'hit'
                WHEN (
                  CASE
                    WHEN p.mkt = 'batter_hits' THEN (p.resolution_data->p.player_name->>'hits')::numeric
                    WHEN p.mkt = 'batter_total_bases' THEN (p.resolution_data->p.player_name->>'total_bases')::numeric
                    WHEN p.mkt = 'batter_home_runs' THEN (p.resolution_data->p.player_name->>'home_runs')::numeric
                    WHEN p.mkt = 'batter_rbis' THEN (p.resolution_data->p.player_name->>'rbi')::numeric
                    WHEN p.mkt = 'pitcher_strikeouts' THEN (p.resolution_data->p.player_name->>'strikeouts')::numeric
                  END
                ) = p.line THEN 'push'
                ELSE 'miss'
              END
          END
        ELSE 'no_outcome'
      END AS result
    FROM picks p
  )
  SELECT
    r.mkt::TEXT,
    COUNT(*) FILTER (WHERE r.result IN ('hit','miss'))::BIGINT,
    COUNT(*) FILTER (WHERE r.result = 'hit')::BIGINT,
    COUNT(*) FILTER (WHERE r.result = 'push')::BIGINT,
    COUNT(*) FILTER (WHERE r.result = 'no_outcome')::BIGINT,
    CASE WHEN COUNT(*) FILTER (WHERE r.result IN ('hit','miss')) > 0
      THEN ROUND(100.0 * COUNT(*) FILTER (WHERE r.result = 'hit')::numeric / COUNT(*) FILTER (WHERE r.result IN ('hit','miss')), 2)
      ELSE 0 END,
    CASE WHEN COUNT(*) FILTER (WHERE r.result IN ('hit','miss')) > 0 THEN
      ROUND(100.0 * GREATEST(0,(
        (COUNT(*) FILTER (WHERE r.result = 'hit')::numeric / COUNT(*) FILTER (WHERE r.result IN ('hit','miss'))) -
        1.96 * SQRT(
          (COUNT(*) FILTER (WHERE r.result = 'hit')::numeric / COUNT(*) FILTER (WHERE r.result IN ('hit','miss'))) *
          (1 - COUNT(*) FILTER (WHERE r.result = 'hit')::numeric / COUNT(*) FILTER (WHERE r.result IN ('hit','miss'))) /
          COUNT(*) FILTER (WHERE r.result IN ('hit','miss'))
        )
      )), 2) ELSE 0 END,
    CASE WHEN COUNT(*) FILTER (WHERE r.result IN ('hit','miss')) > 0 THEN
      ROUND(100.0 * LEAST(1,(
        (COUNT(*) FILTER (WHERE r.result = 'hit')::numeric / COUNT(*) FILTER (WHERE r.result IN ('hit','miss'))) +
        1.96 * SQRT(
          (COUNT(*) FILTER (WHERE r.result = 'hit')::numeric / COUNT(*) FILTER (WHERE r.result IN ('hit','miss'))) *
          (1 - COUNT(*) FILTER (WHERE r.result = 'hit')::numeric / COUNT(*) FILTER (WHERE r.result IN ('hit','miss'))) /
          COUNT(*) FILTER (WHERE r.result IN ('hit','miss'))
        )
      )), 2) ELSE 0 END
  FROM resolved r
  GROUP BY r.mkt
  ORDER BY r.mkt;
END;
$$;

REVOKE EXECUTE ON FUNCTION backtest_market_baseline_aggregate(DATE, DATE, TEXT[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION backtest_market_baseline_aggregate(DATE, DATE, TEXT[]) TO service_role;
GRANT EXECUTE ON FUNCTION backtest_market_baseline_aggregate(DATE, DATE, TEXT[]) TO authenticated;
