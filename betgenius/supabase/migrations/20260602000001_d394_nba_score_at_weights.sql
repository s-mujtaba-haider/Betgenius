-- D-394 SHIP 1 — NBA full-corpus score_at_weights RPC.
--
-- MIRRORS d372_score_at_weights structure but with the NBA-specific
-- pre-weight delta math (NOT the MLB rescale formula).
--
-- NBA math per D-367 SHIP 5: pick_history.score_X stores the PRE-weight
-- raw factor value. The delta formula is:
--   new_conf = stored_conf + Σ score_X * (new_w - current_w)
-- Then clamp [0, 100] and apply trivial_line_cap (cap at 65 if flagged).
--
-- This RPC reads pick_history directly (no MV — NBA score_X columns are
-- already on the table) for sport='nba', is_synthetic=false, hit IS NOT NULL,
-- and the 5 NBA optimizer markets (points/rebounds/assists/threes/double_double).
--
-- 70/30 split via hashtextextended(id::text, 12345) % 100 — same seed as
-- d372_score_at_weights, deterministic across runs.
--
-- The 23 NBA weight → score_X mapping mirrors d367-optimize-nba's NBA_WEIGHTS
-- array. score_minutes_stability shares w_minutes_floor with score_minutes_volume
-- (per D-367 SHIP 5; the SQL backtest_weights_v3_synthetic_windowed formula
-- applies w_minutes_floor twice — once to each).
--
-- Rollback:
--   DROP FUNCTION IF EXISTS public.d394_nba_score_at_weights(jsonb, jsonb, int, text);

CREATE OR REPLACE FUNCTION public.d394_nba_score_at_weights(
  p_weights JSONB,
  p_current_weights JSONB,
  p_min_conf INT DEFAULT 60,
  p_split_mode TEXT DEFAULT 'all'
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
SET statement_timeout = '90s'
AS $$
DECLARE v_result JSONB;
BEGIN
  WITH base AS (
    SELECT
      id, prop_type, confidence, hit, score_trivial_line_cap,
      COALESCE(score_l5, 0)              AS s_l5,
      COALESCE(score_l10, 0)             AS s_l10,
      COALESCE(score_season, 0)          AS s_season,
      COALESCE(score_floor_ceiling, 0)   AS s_floor_ceiling,
      COALESCE(score_recent_form, 0)     AS s_recent_form,
      COALESCE(score_home_away, 0)       AS s_home_away,
      COALESCE(score_rest, 0)            AS s_rest,
      COALESCE(score_b2b, 0)             AS s_b2b,
      COALESCE(score_minutes_trend, 0)   AS s_minutes_trend,
      COALESCE(score_pace, 0)            AS s_pace,
      COALESCE(score_opp_defense, 0)     AS s_opp_defense,
      COALESCE(score_prop_type_penalty, 0) AS s_prop_type,
      COALESCE(score_z_score, 0)         AS s_z_score,
      COALESCE(score_role_change, 0)     AS s_role_change,
      COALESCE(score_vig_filter, 0)      AS s_vig_filter,
      COALESCE(score_usg_rate, 0)        AS s_usg_rate,
      COALESCE(score_regression, 0)      AS s_regression,
      COALESCE(score_market_conf, 0)     AS s_market_conf,
      COALESCE(score_home_away_split, 0) AS s_ha_split,
      COALESCE(score_minutes_volume, 0)    AS s_minutes_volume,
      COALESCE(score_minutes_stability, 0) AS s_minutes_stability,
      COALESCE(score_consistency, 0)     AS s_consistency,
      COALESCE(score_stale_data, 0)      AS s_stale_data,
      COALESCE(score_player_injury, 0)   AS s_player_injury
    FROM public.pick_history
    WHERE sport = 'nba'
      AND is_synthetic = false
      AND hit IS NOT NULL
      AND prop_type IN ('points', 'rebounds', 'assists', 'threes', 'double_double')
      AND CASE p_split_mode
        WHEN 'train'    THEN (abs(hashtextextended(id::text, 12345)) % 100) <  70
        WHEN 'validate' THEN (abs(hashtextextended(id::text, 12345)) % 100) >= 70
        ELSE TRUE
      END
  ),
  recomputed AS (
    SELECT
      hit, prop_type, score_trivial_line_cap,
      GREATEST(0, LEAST(100, ROUND(
        confidence +
          s_l5             * (((p_weights ->> 'w_l5')::numeric)             - ((p_current_weights ->> 'w_l5')::numeric))
        + s_l10            * (((p_weights ->> 'w_l10')::numeric)            - ((p_current_weights ->> 'w_l10')::numeric))
        + s_season         * (((p_weights ->> 'w_season')::numeric)         - ((p_current_weights ->> 'w_season')::numeric))
        + s_floor_ceiling  * (((p_weights ->> 'w_floor_ceiling')::numeric)  - ((p_current_weights ->> 'w_floor_ceiling')::numeric))
        + s_recent_form    * (((p_weights ->> 'w_recent_form')::numeric)    - ((p_current_weights ->> 'w_recent_form')::numeric))
        + s_home_away      * (((p_weights ->> 'w_home_away')::numeric)      - ((p_current_weights ->> 'w_home_away')::numeric))
        + s_rest           * (((p_weights ->> 'w_rest')::numeric)           - ((p_current_weights ->> 'w_rest')::numeric))
        + s_b2b            * (((p_weights ->> 'w_b2b')::numeric)            - ((p_current_weights ->> 'w_b2b')::numeric))
        + s_minutes_trend  * (((p_weights ->> 'w_minutes_trend')::numeric)  - ((p_current_weights ->> 'w_minutes_trend')::numeric))
        + s_pace           * (((p_weights ->> 'w_pace')::numeric)           - ((p_current_weights ->> 'w_pace')::numeric))
        + s_opp_defense    * (((p_weights ->> 'w_opp_defense')::numeric)    - ((p_current_weights ->> 'w_opp_defense')::numeric))
        + s_prop_type      * (((p_weights ->> 'w_prop_type')::numeric)      - ((p_current_weights ->> 'w_prop_type')::numeric))
        + s_z_score        * (((p_weights ->> 'w_z_score')::numeric)        - ((p_current_weights ->> 'w_z_score')::numeric))
        + s_role_change    * (((p_weights ->> 'w_role_change')::numeric)    - ((p_current_weights ->> 'w_role_change')::numeric))
        + s_vig_filter     * (((p_weights ->> 'w_vig_filter')::numeric)     - ((p_current_weights ->> 'w_vig_filter')::numeric))
        + s_usg_rate       * (((p_weights ->> 'w_usg_rate')::numeric)       - ((p_current_weights ->> 'w_usg_rate')::numeric))
        + s_regression     * (((p_weights ->> 'w_regression')::numeric)     - ((p_current_weights ->> 'w_regression')::numeric))
        + s_market_conf    * (((p_weights ->> 'w_market_conf')::numeric)    - ((p_current_weights ->> 'w_market_conf')::numeric))
        + s_ha_split       * (((p_weights ->> 'w_ha_split')::numeric)       - ((p_current_weights ->> 'w_ha_split')::numeric))
        -- score_minutes_volume + score_minutes_stability both share w_minutes_floor (D-367 SHIP 5)
        + (s_minutes_volume + s_minutes_stability) * (((p_weights ->> 'w_minutes_floor')::numeric) - ((p_current_weights ->> 'w_minutes_floor')::numeric))
        + s_consistency    * (((p_weights ->> 'w_consistency')::numeric)    - ((p_current_weights ->> 'w_consistency')::numeric))
        + s_stale_data     * (((p_weights ->> 'w_stale_data')::numeric)     - ((p_current_weights ->> 'w_stale_data')::numeric))
        + s_player_injury  * (((p_weights ->> 'w_player_injury')::numeric)  - ((p_current_weights ->> 'w_player_injury')::numeric))
      )))::integer AS new_conf_clamped
    FROM base
  ),
  capped AS (
    SELECT
      hit, prop_type,
      CASE
        WHEN score_trivial_line_cap = true AND new_conf_clamped > 65 THEN 65
        ELSE new_conf_clamped
      END AS new_conf
    FROM recomputed
  ),
  agg AS (
    SELECT
      COUNT(*)::int AS n_total,
      COUNT(*) FILTER (WHERE new_conf >= p_min_conf)::int AS n,
      COUNT(*) FILTER (WHERE new_conf >= p_min_conf AND hit IS TRUE)::int AS hits,
      COUNT(*) FILTER (WHERE new_conf >= 60 AND new_conf < 70 AND hit IS TRUE)::int AS lean_hits,
      COUNT(*) FILTER (WHERE new_conf >= 60 AND new_conf < 70)::int AS lean_n,
      COUNT(*) FILTER (WHERE new_conf >= 70 AND new_conf < 80 AND hit IS TRUE)::int AS good_hits,
      COUNT(*) FILTER (WHERE new_conf >= 70 AND new_conf < 80)::int AS good_n,
      COUNT(*) FILTER (WHERE new_conf >= 80 AND new_conf < 90 AND hit IS TRUE)::int AS strong_hits,
      COUNT(*) FILTER (WHERE new_conf >= 80 AND new_conf < 90)::int AS strong_n,
      COUNT(*) FILTER (WHERE new_conf >= 90 AND hit IS TRUE)::int AS elite_hits,
      COUNT(*) FILTER (WHERE new_conf >= 90)::int AS elite_n
    FROM capped
  ),
  per_market AS (
    SELECT
      prop_type,
      COUNT(*) FILTER (WHERE new_conf >= p_min_conf)::int AS n,
      COUNT(*) FILTER (WHERE new_conf >= p_min_conf AND hit IS TRUE)::int AS hits
    FROM capped
    GROUP BY prop_type
  ),
  per_market_json AS (
    SELECT jsonb_object_agg(prop_type, jsonb_build_object(
      'n', n, 'hits', hits,
      'hr', CASE WHEN n > 0 THEN hits::numeric / n ELSE 0 END
    )) AS j
    FROM per_market
    WHERE n > 0
  )
  SELECT jsonb_build_object(
    'split_mode', p_split_mode,
    'n_total', a.n_total,
    'objective_n', a.n, 'objective_hits', a.hits,
    'objective_hit_rate', CASE WHEN a.n > 0 THEN a.hits::numeric / a.n ELSE 0 END,
    'lean_n', a.lean_n, 'lean_hits', a.lean_hits, 'lean_hr', CASE WHEN a.lean_n > 0 THEN a.lean_hits::numeric / a.lean_n ELSE 0 END,
    'good_n', a.good_n, 'good_hits', a.good_hits, 'good_hr', CASE WHEN a.good_n > 0 THEN a.good_hits::numeric / a.good_n ELSE 0 END,
    'strong_n', a.strong_n, 'strong_hits', a.strong_hits, 'strong_hr', CASE WHEN a.strong_n > 0 THEN a.strong_hits::numeric / a.strong_n ELSE 0 END,
    'elite_n', a.elite_n, 'elite_hits', a.elite_hits, 'elite_hr', CASE WHEN a.elite_n > 0 THEN a.elite_hits::numeric / a.elite_n ELSE 0 END,
    'per_market', COALESCE(pmj.j, '{}'::jsonb)
  ) INTO v_result
  FROM agg a LEFT JOIN per_market_json pmj ON TRUE;

  RETURN v_result;
END $$;

REVOKE EXECUTE ON FUNCTION public.d394_nba_score_at_weights(jsonb, jsonb, int, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.d394_nba_score_at_weights(jsonb, jsonb, int, text) TO service_role, authenticated;

COMMENT ON FUNCTION public.d394_nba_score_at_weights(jsonb, jsonb, int, text) IS
  'D-394 SHIP 1: NBA full-corpus score_at_weights with pre-weight delta math '
  '(NOT the MLB rescale formula). Reads pick_history sport=nba is_synthetic=false '
  'hit IS NOT NULL; applies the formula new_conf = stored_conf + Σ score_X * '
  '(new_w - current_w); clamps [0,100]; applies trivial_line_cap. Split via '
  'hashtextextended(id::text, 12345) % 100 (same seed as d372). '
  'Rollback: DROP FUNCTION public.d394_nba_score_at_weights(jsonb, jsonb, int, text).';
