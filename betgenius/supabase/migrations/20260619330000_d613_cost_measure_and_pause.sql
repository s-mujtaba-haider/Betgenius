-- D-613 — SHIP 1 (measure) + SHIP 2 (pause NBA off-season cron).

DO $$
DECLARE
  r RECORD;
  v_24h_total_cost numeric;
  v_24h_mlb_cost   numeric;
  v_24h_mlb_calls  bigint;
  v_24h_mlb_runs   bigint;
  v_24h_picks_with_ai bigint;
  v_24h_picks_total   bigint;
  v_nba_jobid bigint;
  v_existing_active bool;
  v_24h_nba_cost   numeric;
  v_24h_nba_calls  bigint;
  v_24h_nba_picks  bigint;
BEGIN
  SET LOCAL statement_timeout TO '60s';

  RAISE NOTICE '════════════════════════════════════════════════════════════════';
  RAISE NOTICE 'D-613 — measure cron waste + pause NBA';
  RAISE NOTICE '════════════════════════════════════════════════════════════════';

  -- §A — Sonnet spend last 24h, by source
  RAISE NOTICE '';
  RAISE NOTICE '[A] sonnet_usage_log last 24h, by source:';
  FOR r IN
    SELECT source, count(*) AS n_calls,
           sum(input_tokens) AS in_tok, sum(output_tokens) AS out_tok,
           round(sum(computed_cost_usd)::numeric, 4) AS cost_usd
    FROM public.sonnet_usage_log
    WHERE created_at >= (now() - interval '24 hours')
    GROUP BY source ORDER BY sum(computed_cost_usd) DESC
  LOOP
    RAISE NOTICE '  source=% n_calls=% in_tok=% out_tok=% cost_usd=$%',
      r.source, r.n_calls, r.in_tok, r.out_tok, r.cost_usd;
  END LOOP;

  SELECT round(coalesce(sum(computed_cost_usd),0)::numeric, 4) INTO v_24h_total_cost
    FROM public.sonnet_usage_log WHERE created_at >= (now() - interval '24 hours');
  SELECT round(coalesce(sum(computed_cost_usd),0)::numeric, 4), coalesce(count(*),0)
    INTO v_24h_mlb_cost, v_24h_mlb_calls
    FROM public.sonnet_usage_log
   WHERE created_at >= (now() - interval '24 hours') AND source = 'mlb_pick';
  RAISE NOTICE '[A.totals] last 24h Sonnet total: $%  mlb_pick: $% over % calls',
    v_24h_total_cost, v_24h_mlb_cost, v_24h_mlb_calls;

  -- §B — runs + picks last 24h
  SELECT count(*) INTO v_24h_mlb_runs
    FROM cron.job_run_details d JOIN cron.job j ON j.jobid = d.jobid
   WHERE j.jobname = 'process-games-mlb-30min'
     AND d.start_time >= (now() - interval '24 hours');
  SELECT count(*), count(*) FILTER (WHERE ai_analysis IS NOT NULL AND ai_analysis <> '')
    INTO v_24h_picks_total, v_24h_picks_with_ai
    FROM public.pick_history
   WHERE created_at >= (now() - interval '24 hours') AND sport = 'mlb' AND is_synthetic = false;

  RAISE NOTICE '';
  RAISE NOTICE '[B] runs/picks last 24h:';
  RAISE NOTICE '  process-games-mlb-30min runs: %', v_24h_mlb_runs;
  RAISE NOTICE '  MLB picks written: % (with_ai: %)', v_24h_picks_total, v_24h_picks_with_ai;

  -- §C — per-run write distribution (NO runid; uses start_time as key)
  RAISE NOTICE '';
  RAISE NOTICE '[C] per-run write distribution (last 24h):';
  FOR r IN
    WITH runs AS (
      SELECT d.start_time
        FROM cron.job_run_details d
        JOIN cron.job j ON j.jobid = d.jobid
       WHERE j.jobname = 'process-games-mlb-30min'
         AND d.start_time >= (now() - interval '24 hours')
    ),
    counts AS (
      SELECT runs.start_time,
        (SELECT count(*) FROM public.pick_history p
          WHERE p.created_at >= runs.start_time
            AND p.created_at <  runs.start_time + interval '5 minutes'
            AND p.sport = 'mlb' AND p.is_synthetic = false) AS picks_written
      FROM runs
    ),
    bucketed AS (
      SELECT CASE
          WHEN picks_written = 0   THEN 'A_zero (wasted)'
          WHEN picks_written = 1   THEN 'B_one'
          WHEN picks_written <= 5  THEN 'C_2_to_5'
          WHEN picks_written <= 20 THEN 'D_6_to_20'
          WHEN picks_written <= 50 THEN 'E_21_to_50'
          ELSE                          'F_50_plus'
        END AS bucket, picks_written
      FROM counts
    )
    SELECT bucket, count(*) AS n_runs, sum(picks_written) AS total_picks
      FROM bucketed GROUP BY bucket ORDER BY bucket
  LOOP
    RAISE NOTICE '  %  n_runs=%  total_picks_in_bucket=%',
      r.bucket, r.n_runs, r.total_picks;
  END LOOP;

  -- §D — cost-per-useful-pick + projections
  RAISE NOTICE '';
  RAISE NOTICE '[D] cost approximations:';
  IF v_24h_picks_with_ai > 0 THEN
    RAISE NOTICE '  cost per AI-narrated pick: $%',
      round(v_24h_mlb_cost / v_24h_picks_with_ai, 5);
  ELSE
    RAISE NOTICE '  no AI-narrated picks last 24h';
  END IF;
  RAISE NOTICE '  per-run avg picks: %',
    CASE WHEN v_24h_mlb_runs > 0 THEN round(v_24h_picks_total::numeric / v_24h_mlb_runs, 2) ELSE 0 END;
  RAISE NOTICE '  per-run avg cost: $%',
    CASE WHEN v_24h_mlb_runs > 0 THEN round(v_24h_mlb_cost / v_24h_mlb_runs, 5) ELSE 0 END;
  RAISE NOTICE '  daily MLB Sonnet: $%', v_24h_mlb_cost;
  RAISE NOTICE '  projected monthly: $%', round(v_24h_mlb_cost * 30, 2);
  RAISE NOTICE '  projected annual:  $%', round(v_24h_mlb_cost * 365, 2);

  -- §E — NBA waste
  SELECT round(coalesce(sum(computed_cost_usd),0)::numeric, 4), coalesce(count(*),0)
    INTO v_24h_nba_cost, v_24h_nba_calls
    FROM public.sonnet_usage_log
   WHERE created_at >= (now() - interval '24 hours')
     AND source IN ('nba_player','nba_game');
  SELECT count(*) INTO v_24h_nba_picks
    FROM public.pick_history
   WHERE created_at >= (now() - interval '24 hours') AND sport = 'nba' AND is_synthetic = false;

  RAISE NOTICE '';
  RAISE NOTICE '[E] NBA process-games last 24h:';
  RAISE NOTICE '  nba_player+nba_game calls=% cost=$%', v_24h_nba_calls, v_24h_nba_cost;
  RAISE NOTICE '  NBA pick_history writes: %', v_24h_nba_picks;

  -- §F SHIP 2 pause — DEFERRED to companion migration
  -- 20260619330100_d613_pause_nba.sql which uses cron.alter_job (the
  -- proper API; direct UPDATE on cron.job hits permission denied for
  -- non-superuser roles).
  RAISE NOTICE '';
  RAISE NOTICE 'D-613 SHIP 1 measurement complete. SHIP 2 pause in companion migration.';
END $$;
