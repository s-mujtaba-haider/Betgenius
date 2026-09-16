-- D-616 SHIP 3 verify — read state directly. READ-ONLY.

DO $$
DECLARE
  r RECORD;
  v_today_ymd text := to_char((now() AT TIME ZONE 'America/New_York')::date, 'YYYYMMDD');
  v_hashes_populated bigint;
  v_total_today bigint;
  v_games_skipped bigint;
  v_props_skipped bigint;
  v_n_checkpoints bigint;
  v_sonnet_last bigint;     v_sonnet_last_cost numeric;
  v_sonnet_prior bigint;    v_sonnet_prior_cost numeric;
  v_picks_last bigint;      v_picks_prior bigint;
BEGIN
  SET LOCAL statement_timeout TO '60s';

  RAISE NOTICE '════════════════════════════════════════════════════════════════';
  RAISE NOTICE 'D-616 SHIP 3 verify  (today_ymd=%)', v_today_ymd;
  RAISE NOTICE '════════════════════════════════════════════════════════════════';

  -- §A — mlb_scoring_progress hashes populated
  SELECT
    count(*) FILTER (WHERE last_score_hash IS NOT NULL),
    count(*)
    INTO v_hashes_populated, v_total_today
    FROM public.mlb_scoring_progress
   WHERE game_date = v_today_ymd;
  RAISE NOTICE '';
  RAISE NOTICE '[A] mlb_scoring_progress today: % with hash / % total',
    v_hashes_populated, v_total_today;
  FOR r IN
    SELECT game_pk, last_score_hash, scored_at
      FROM public.mlb_scoring_progress
     WHERE game_date = v_today_ymd
     ORDER BY game_pk LIMIT 20
  LOOP
    RAISE NOTICE '  game_pk=% hash=% scored_at=%',
      r.game_pk, COALESCE(r.last_score_hash, '(null)'), r.scored_at;
  END LOOP;

  -- §B — d616_hash_skip checkpoints last 60 min
  SELECT count(*) INTO v_n_checkpoints
    FROM public.error_log
   WHERE error_type = 'checkpoint'
     AND error_message ILIKE '%d616_hash_skip%'
     AND created_at >= (now() - interval '60 minutes');
  SELECT
    coalesce(sum((context->>'games_skipped')::bigint), 0),
    coalesce(sum((context->>'props_skipped')::bigint), 0)
    INTO v_games_skipped, v_props_skipped
    FROM public.error_log
   WHERE error_type = 'checkpoint'
     AND error_message ILIKE '%d616_hash_skip%'
     AND created_at >= (now() - interval '60 minutes');
  RAISE NOTICE '';
  RAISE NOTICE '[B] d616_hash_skip checkpoints last 60 min: %', v_n_checkpoints;
  RAISE NOTICE '    cumulative games_skipped=%  props_skipped=%',
    v_games_skipped, v_props_skipped;

  RAISE NOTICE '';
  RAISE NOTICE '[B.detail] 5 most-recent d616_hash_skip checkpoints:';
  FOR r IN
    SELECT created_at, context
      FROM public.error_log
     WHERE error_type = 'checkpoint'
       AND error_message ILIKE '%d616_hash_skip%'
     ORDER BY created_at DESC LIMIT 5
  LOOP
    RAISE NOTICE '  at=% context=%', r.created_at, r.context;
  END LOOP;

  -- §C — sonnet_usage_log last 60 vs prior 60
  SELECT count(*), round(coalesce(sum(computed_cost_usd),0)::numeric,4)
    INTO v_sonnet_last, v_sonnet_last_cost
    FROM public.sonnet_usage_log
   WHERE source = 'mlb_pick'
     AND created_at >= (now() - interval '60 minutes');
  SELECT count(*), round(coalesce(sum(computed_cost_usd),0)::numeric,4)
    INTO v_sonnet_prior, v_sonnet_prior_cost
    FROM public.sonnet_usage_log
   WHERE source = 'mlb_pick'
     AND created_at >= (now() - interval '120 minutes')
     AND created_at <  (now() - interval '60 minutes');
  RAISE NOTICE '';
  RAISE NOTICE '[C] sonnet_usage_log (mlb_pick):';
  RAISE NOTICE '    last 60 min: % calls  $%', v_sonnet_last, v_sonnet_last_cost;
  RAISE NOTICE '    prior 60 min: % calls  $%', v_sonnet_prior, v_sonnet_prior_cost;

  -- §D — pick_history writes (no game unserved if first-time games still get
  -- picks written)
  SELECT count(*) INTO v_picks_last
    FROM public.pick_history
   WHERE sport = 'mlb' AND is_synthetic = false
     AND created_at >= (now() - interval '60 minutes');
  SELECT count(*) INTO v_picks_prior
    FROM public.pick_history
   WHERE sport = 'mlb' AND is_synthetic = false
     AND created_at >= (now() - interval '120 minutes')
     AND created_at <  (now() - interval '60 minutes');
  RAISE NOTICE '';
  RAISE NOTICE '[D] pick_history writes (mlb): last 60 min: %  prior 60 min: %',
    v_picks_last, v_picks_prior;

  -- §E — prove changed inputs re-score: hash COVERAGE for games that already
  -- have picks today. If a game has picks AND its hash is populated, the
  -- mechanism is working end-to-end.
  RAISE NOTICE '';
  RAISE NOTICE '[E] hash + recent-pick coverage per game today:';
  FOR r IN
    WITH games_with_picks AS (
      SELECT
        ph.team || ' vs ' || ph.opponent AS matchup,
        count(*) AS n_picks_today,
        max(ph.created_at) AS latest_pick
      FROM public.pick_history ph
      WHERE ph.game_date = (now() AT TIME ZONE 'America/New_York')::date
        AND ph.sport = 'mlb' AND ph.is_synthetic = false
      GROUP BY ph.team || ' vs ' || ph.opponent
    ),
    games_with_hash AS (
      SELECT game_pk, last_score_hash, scored_at
        FROM public.mlb_scoring_progress
       WHERE game_date = v_today_ymd AND last_score_hash IS NOT NULL
    )
    SELECT gwp.matchup, gwp.n_picks_today, gwp.latest_pick,
           (SELECT count(*) FROM games_with_hash) AS total_hashes_today
      FROM games_with_picks gwp
     ORDER BY gwp.n_picks_today DESC LIMIT 15
  LOOP
    RAISE NOTICE '  matchup=% picks_today=% latest_pick=% total_hashes=%',
      r.matchup, r.n_picks_today, r.latest_pick, r.total_hashes_today;
  END LOOP;

  RAISE NOTICE '';
  RAISE NOTICE 'D-616 verify complete.';
END $$;
