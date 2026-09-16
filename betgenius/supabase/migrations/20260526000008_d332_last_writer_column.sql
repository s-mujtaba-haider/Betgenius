-- D-332 Phase D Day 1 — add last_writer column to recommendations_cache for parallel-run diff.
--
-- Both mega-cron and per-game path write to recommendations_cache via UPSERT-merge.
-- last_writer tags which path wrote the row most recently, enabling per-day
-- comparison via get_phase_d_diff RPC.
--
-- Rollback: ALTER TABLE recommendations_cache DROP COLUMN last_writer;

ALTER TABLE public.recommendations_cache
  ADD COLUMN IF NOT EXISTS last_writer TEXT;

COMMENT ON COLUMN public.recommendations_cache.last_writer IS
  'D-332 Phase D Day 1. Identifies the code path that last UPSERTed this row: ''mega-cron'' (jobid=21 process-games-mlb with empty body) or ''per-game'' (process-single-game-mlb via dispatcher). NULL on pre-D-332 rows.';

-- ============================================================
-- get_phase_d_diff(target_date) — compare picks between paths.
--
-- For each pick row written today, return the writer + key scoring fields
-- so external observation can compute confidence-deltas. Same-row collisions
-- (both paths wrote) show whichever wrote LAST per last_writer.
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_phase_d_diff(p_game_date DATE)
RETURNS TABLE (
  game_date    DATE,
  player_name  TEXT,
  prop_type    TEXT,
  pick_side    TEXT,
  last_writer  TEXT,
  confidence   INT,
  verdict      TEXT,
  ai_analysis_chars INT,
  created_at   TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    rc.game_date,
    rc.player_name,
    rc.prop_type,
    rc.pick_side,
    rc.last_writer,
    rc.confidence,
    rc.verdict,
    COALESCE(length(rc.ai_analysis), 0) AS ai_analysis_chars,
    rc.created_at
  FROM public.recommendations_cache rc
  WHERE rc.sport = 'mlb'
    AND rc.game_date = p_game_date
  ORDER BY rc.last_writer NULLS LAST, rc.confidence DESC;
$$;

REVOKE EXECUTE ON FUNCTION public.get_phase_d_diff(DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_phase_d_diff(DATE) TO service_role;

COMMENT ON FUNCTION public.get_phase_d_diff(DATE) IS
  'D-332 Phase D observability. Returns recommendations_cache rows for a game_date with last_writer + confidence + ai_analysis size, ordered by writer + confidence DESC.';

-- ============================================================
-- get_phase_d_summary(target_date) — counts by writer for quick diff.
-- ============================================================
CREATE OR REPLACE FUNCTION public.get_phase_d_summary(p_game_date DATE)
RETURNS TABLE (
  last_writer        TEXT,
  pick_count         BIGINT,
  high_conf_count    BIGINT,   -- confidence >= 70
  elite_count        BIGINT,   -- confidence >= 90
  avg_confidence     NUMERIC(5,2),
  avg_ai_chars       NUMERIC(8,1),
  oldest_created_at  TIMESTAMPTZ,
  newest_created_at  TIMESTAMPTZ
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    COALESCE(rc.last_writer, '(null)') AS last_writer,
    COUNT(*)::BIGINT AS pick_count,
    COUNT(*) FILTER (WHERE rc.confidence >= 70)::BIGINT AS high_conf_count,
    COUNT(*) FILTER (WHERE rc.confidence >= 90)::BIGINT AS elite_count,
    ROUND(AVG(rc.confidence)::NUMERIC, 2) AS avg_confidence,
    ROUND(AVG(COALESCE(length(rc.ai_analysis), 0))::NUMERIC, 1) AS avg_ai_chars,
    MIN(rc.created_at) AS oldest_created_at,
    MAX(rc.created_at) AS newest_created_at
  FROM public.recommendations_cache rc
  WHERE rc.sport = 'mlb'
    AND rc.game_date = p_game_date
  GROUP BY COALESCE(rc.last_writer, '(null)')
  ORDER BY last_writer;
$$;

REVOKE EXECUTE ON FUNCTION public.get_phase_d_summary(DATE) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_phase_d_summary(DATE) TO service_role;

COMMENT ON FUNCTION public.get_phase_d_summary(DATE) IS
  'D-332 Phase D observability. Aggregate counts per writer for a game_date: pick_count, high_conf_count, elite_count, avg_confidence, avg_ai_chars.';
