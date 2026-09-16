-- D-538 (D-537 fold-in) — RPC: any scored gamePk on today's MLB slate
-- with ZERO rec_cache rows?
--
-- Column types (per inspection):
--   mlb_scoring_progress.game_date          TEXT (mixed format)
--   cache_mlb_game_scoreboard.game_date     DATE
--   recommendations_cache.game_date         DATE
--   pick_history.game_date                  DATE
CREATE OR REPLACE FUNCTION public.d538_zero_pick_games()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_catalog
AS $$
DECLARE
  v_game_date_text text;
  v_game_date date;
  v_scored int;
  v_surfaced int;
  v_missing int;
  v_missing_gamepks int[];
BEGIN
  SELECT MAX(sp.game_date) INTO v_game_date_text
  FROM public.mlb_scoring_progress sp
  WHERE sp.scored_at > now() - interval '36 hours';

  IF v_game_date_text IS NULL THEN
    RETURN jsonb_build_object(
      'game_date', NULL, 'scored', 0, 'surfaced', 0, 'missing', 0,
      'missing_gamepks', '[]'::jsonb, 'note', 'no scoring events in last 36h'
    );
  END IF;

  v_game_date := CASE
    WHEN v_game_date_text ~ '^\d{8}$' THEN to_date(v_game_date_text, 'YYYYMMDD')
    WHEN v_game_date_text ~ '^\d{4}-\d{2}-\d{2}$' THEN v_game_date_text::date
    ELSE NULL
  END;

  WITH scored AS (
    SELECT DISTINCT sp.game_pk
    FROM public.mlb_scoring_progress sp
    WHERE sp.game_date = v_game_date_text
  ),
  sched AS (
    SELECT s.game_pk, sb.home_team, sb.away_team
    FROM scored s
    JOIN public.cache_mlb_game_scoreboard sb
      ON sb.game_id = s.game_pk AND sb.game_date = v_game_date
  ),
  per_game AS (
    SELECT sched.game_pk,
           EXISTS (
             SELECT 1 FROM public.recommendations_cache rc
             WHERE rc.sport='mlb'
               AND rc.game_date = v_game_date  -- DATE = DATE
               AND (rc.team = sched.home_team OR rc.team = sched.away_team)
           ) AS has_recs
    FROM sched
  )
  SELECT count(*),
         count(*) FILTER (WHERE has_recs),
         count(*) FILTER (WHERE NOT has_recs),
         COALESCE(array_agg(game_pk) FILTER (WHERE NOT has_recs), '{}'::int[])
  INTO v_scored, v_surfaced, v_missing, v_missing_gamepks
  FROM per_game;

  RETURN jsonb_build_object(
    'game_date', to_char(v_game_date, 'YYYY-MM-DD'),
    'scored', v_scored,
    'surfaced', v_surfaced,
    'missing', v_missing,
    'missing_gamepks', to_jsonb(v_missing_gamepks)
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION public.d538_zero_pick_games() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.d538_zero_pick_games() TO authenticated;
GRANT  EXECUTE ON FUNCTION public.d538_zero_pick_games() TO service_role;

DO $$ DECLARE r jsonb;
BEGIN
  r := public.d538_zero_pick_games();
  RAISE NOTICE '[D-538 zero-pick-games RPC smoke] %', r;
END $$;
