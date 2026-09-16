-- D-291 SHIP 2 (2026-05-22) — pure-SQL backtest aggregation RPC.
--
-- The Deno-based backtest engine from D-289 hits PostgREST query
-- timeouts on the now-17M-row cache_mlb_historical_odds table.
-- This RPC does the resolution + aggregation in pure SQL, which
-- can use indexes + run inside Postgres without the 30s PostgREST
-- timeout window. ~5-20s typical runtime.
--
-- Returns per-market win-rate aggregates resolving picks against
-- cache_mlb_historical_outcomes. Signal: bet the side with higher
-- implied probability (lower juice) — market-baseline.
--
-- NOTE on faithful algo replay: this is NOT the 14-factor algo
-- replay. That requires recomputing scoreBatterMarket /
-- scorePitcherStrikeouts against historical Statcast / splits /
-- lineup / weather context, which doesn't exist as historical
-- snapshots. D-292+ work to build full faithful replay.
--
-- Rollback:
--   DROP FUNCTION IF EXISTS backtest_market_baseline_aggregate(date, date, text[]);

CREATE OR REPLACE FUNCTION backtest_market_baseline_aggregate(
  window_start DATE,
  window_end DATE,
  bookmaker_filter TEXT[] DEFAULT ARRAY['hardrockbet','draftkings','fanduel']
)
RETURNS TABLE (
  out_market_key TEXT,
  out_n_picks BIGINT,
  out_hits BIGINT,
  out_pushes BIGINT,
  out_no_outcome BIGINT,
  out_wr_pct NUMERIC,
  out_ci_low NUMERIC,
  out_ci_high NUMERIC
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout = '120s'
AS $$
BEGIN
  RETURN QUERY
  WITH closing_snapshots AS (
    -- Most-recent snapshot per (event, bookmaker, market, player, line)
    SELECT DISTINCT ON (event_id, bookmaker_key, market_key, player_name, line)
      event_id, snapshot_timestamp, commence_time, bookmaker_key, market_key,
      player_name, line, over_odds, under_odds
    FROM public.cache_mlb_historical_odds
    WHERE commence_time >= window_start::timestamptz
      AND commence_time <= (window_end + 1)::timestamptz
      AND bookmaker_key = ANY(bookmaker_filter)
    ORDER BY event_id, bookmaker_key, market_key, player_name, line, snapshot_timestamp DESC
  ),
  picks AS (
    -- Pick side = higher implied prob (lower juice)
    SELECT
      cs.event_id, cs.market_key, cs.player_name, cs.line,
      CASE
        WHEN cs.over_odds IS NULL THEN 'under'
        WHEN cs.under_odds IS NULL THEN 'over'
        WHEN
          (CASE WHEN cs.over_odds > 0 THEN 100.0/(cs.over_odds+100) ELSE -cs.over_odds::numeric/(-cs.over_odds+100) END)
          >
          (CASE WHEN cs.under_odds > 0 THEN 100.0/(cs.under_odds+100) ELSE -cs.under_odds::numeric/(-cs.under_odds+100) END)
        THEN 'over' ELSE 'under'
      END AS pick_side,
      o.home_score, o.away_score, o.resolution_data
    FROM closing_snapshots cs
    LEFT JOIN public.cache_mlb_historical_outcomes o ON o.event_id = cs.event_id AND o.game_completed = TRUE
  ),
  resolved AS (
    SELECT
      market_key,
      CASE
        WHEN home_score IS NULL THEN 'no_outcome'
        WHEN market_key = 'h2h__home' THEN
          CASE WHEN (home_score > away_score AND pick_side = 'over') OR (home_score < away_score AND pick_side = 'under') THEN 'hit' ELSE 'miss' END
        WHEN market_key = 'h2h__away' THEN
          CASE WHEN (away_score > home_score AND pick_side = 'over') OR (away_score < home_score AND pick_side = 'under') THEN 'hit' ELSE 'miss' END
        WHEN market_key = 'totals' THEN
          CASE
            WHEN (home_score + away_score) > line AND pick_side = 'over' THEN 'hit'
            WHEN (home_score + away_score) < line AND pick_side = 'under' THEN 'hit'
            WHEN (home_score + away_score) = line THEN 'push'
            ELSE 'miss'
          END
        WHEN market_key IN ('batter_hits','batter_total_bases','batter_home_runs','batter_rbis','pitcher_strikeouts') THEN
          -- Player prop: extract stat from JSONB resolution_data
          CASE
            WHEN resolution_data IS NULL OR resolution_data->>player_name IS NULL THEN 'no_outcome'
            ELSE
              CASE
                WHEN (
                  CASE
                    WHEN market_key = 'batter_hits' THEN (resolution_data->player_name->>'hits')::numeric
                    WHEN market_key = 'batter_total_bases' THEN (resolution_data->player_name->>'total_bases')::numeric
                    WHEN market_key = 'batter_home_runs' THEN (resolution_data->player_name->>'home_runs')::numeric
                    WHEN market_key = 'batter_rbis' THEN (resolution_data->player_name->>'rbi')::numeric
                    WHEN market_key = 'pitcher_strikeouts' THEN (resolution_data->player_name->>'strikeouts')::numeric
                  END
                ) > line AND pick_side = 'over' THEN 'hit'
                WHEN (
                  CASE
                    WHEN market_key = 'batter_hits' THEN (resolution_data->player_name->>'hits')::numeric
                    WHEN market_key = 'batter_total_bases' THEN (resolution_data->player_name->>'total_bases')::numeric
                    WHEN market_key = 'batter_home_runs' THEN (resolution_data->player_name->>'home_runs')::numeric
                    WHEN market_key = 'batter_rbis' THEN (resolution_data->player_name->>'rbi')::numeric
                    WHEN market_key = 'pitcher_strikeouts' THEN (resolution_data->player_name->>'strikeouts')::numeric
                  END
                ) < line AND pick_side = 'under' THEN 'hit'
                WHEN (
                  CASE
                    WHEN market_key = 'batter_hits' THEN (resolution_data->player_name->>'hits')::numeric
                    WHEN market_key = 'batter_total_bases' THEN (resolution_data->player_name->>'total_bases')::numeric
                    WHEN market_key = 'batter_home_runs' THEN (resolution_data->player_name->>'home_runs')::numeric
                    WHEN market_key = 'batter_rbis' THEN (resolution_data->player_name->>'rbi')::numeric
                    WHEN market_key = 'pitcher_strikeouts' THEN (resolution_data->player_name->>'strikeouts')::numeric
                  END
                ) = line THEN 'push'
                ELSE 'miss'
              END
          END
        ELSE 'no_outcome'
      END AS result
    FROM picks
  )
  SELECT
    r.market_key,
    COUNT(*) FILTER (WHERE r.result IN ('hit','miss')) AS n_picks,
    COUNT(*) FILTER (WHERE r.result = 'hit') AS hits,
    COUNT(*) FILTER (WHERE r.result = 'push') AS pushes,
    COUNT(*) FILTER (WHERE r.result = 'no_outcome') AS no_outcome,
    CASE WHEN COUNT(*) FILTER (WHERE r.result IN ('hit','miss')) > 0
      THEN ROUND(100.0 * COUNT(*) FILTER (WHERE r.result = 'hit')::numeric / COUNT(*) FILTER (WHERE r.result IN ('hit','miss')), 2)
      ELSE 0
    END AS wr_pct,
    -- 95% Wilson CI (simplified one-line approximation; for monitoring not paper-publish)
    CASE WHEN COUNT(*) FILTER (WHERE r.result IN ('hit','miss')) > 0 THEN
      ROUND(100.0 * (
        (COUNT(*) FILTER (WHERE r.result = 'hit')::numeric / COUNT(*) FILTER (WHERE r.result IN ('hit','miss'))) -
        1.96 * SQRT(
          (COUNT(*) FILTER (WHERE r.result = 'hit')::numeric / COUNT(*) FILTER (WHERE r.result IN ('hit','miss'))) *
          (1 - COUNT(*) FILTER (WHERE r.result = 'hit')::numeric / COUNT(*) FILTER (WHERE r.result IN ('hit','miss'))) /
          COUNT(*) FILTER (WHERE r.result IN ('hit','miss'))
        )
      ), 2) ELSE 0 END AS ci_low,
    CASE WHEN COUNT(*) FILTER (WHERE r.result IN ('hit','miss')) > 0 THEN
      ROUND(100.0 * (
        (COUNT(*) FILTER (WHERE r.result = 'hit')::numeric / COUNT(*) FILTER (WHERE r.result IN ('hit','miss'))) +
        1.96 * SQRT(
          (COUNT(*) FILTER (WHERE r.result = 'hit')::numeric / COUNT(*) FILTER (WHERE r.result IN ('hit','miss'))) *
          (1 - COUNT(*) FILTER (WHERE r.result = 'hit')::numeric / COUNT(*) FILTER (WHERE r.result IN ('hit','miss'))) /
          COUNT(*) FILTER (WHERE r.result IN ('hit','miss'))
        )
      ), 2) ELSE 0 END AS ci_high
  FROM resolved r
  GROUP BY r.market_key
  ORDER BY r.market_key;
END;
$$;

REVOKE EXECUTE ON FUNCTION backtest_market_baseline_aggregate(DATE, DATE, TEXT[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION backtest_market_baseline_aggregate(DATE, DATE, TEXT[]) TO service_role;
GRANT EXECUTE ON FUNCTION backtest_market_baseline_aggregate(DATE, DATE, TEXT[]) TO authenticated;

COMMENT ON FUNCTION backtest_market_baseline_aggregate(DATE, DATE, TEXT[]) IS
  'D-291 SHIP 2: market-baseline backtest aggregation. Resolves '
  'closing-line picks (signal = higher implied probability) against '
  'historical outcomes. Returns per-market WR + 95% CI. Pure SQL '
  'for speed on large odds tables.';
