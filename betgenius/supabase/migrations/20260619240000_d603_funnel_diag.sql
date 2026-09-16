-- D-603 — Dashboard funnel diagnostic: 9 games → 195 props → 5 recs.
--
-- READ-ONLY. RAISE NOTICE only. Goal: prove whether 5 is the HONEST result
-- of the D-538 wrong-side gate + D-540 sellable-scoping (most markets
-- correctly scoped OUT) — or whether games / picks silently dropped to
-- bugs.
--
-- The probe computes for TODAY's ET game date (and yesterday's, since the
-- dashboard slate may have rolled at midnight ET):
--   PART A  scheduled games (mlb_scoring_progress) vs scored counts
--   PART B  the funnel: props → picks → D-538 survivors → conf≥70 →
--           sellable → final recs
--   PART C  per-market sellable verdict + dropping stage analysis

DO $$
DECLARE
  r            RECORD;
  v_today_ymd  text := to_char((now() AT TIME ZONE 'America/New_York')::date, 'YYYYMMDD');
  v_today_date date := (now() AT TIME ZONE 'America/New_York')::date;
  v_yest_ymd   text := to_char(((now() AT TIME ZONE 'America/New_York')::date - 1), 'YYYYMMDD');
  v_yest_date  date := (now() AT TIME ZONE 'America/New_York')::date - 1;
  v_target_ymd text;
  v_target_date date;
  v_props_count        bigint;
  v_picks_count        bigint;
  v_over_picks         bigint;
  v_under_picks        bigint;
  v_homeaway_picks     bigint;
  v_picks_c70          bigint;
  v_picks_c70_sellable bigint;
  v_recs_count         bigint;
  v_recs_sellable      bigint;
  v_d538_today         bigint;
  v_d538_yest          bigint;
  v_scheduled_games    bigint;
  v_scored_games       bigint;
BEGIN
  SET LOCAL statement_timeout TO '60s';

  RAISE NOTICE '════════════════════════════════════════════════════════════════';
  RAISE NOTICE 'D-603 — Dashboard funnel diagnostic';
  RAISE NOTICE 'today_ymd=% today_date=% yest_ymd=% yest_date=%',
    v_today_ymd, v_today_date, v_yest_ymd, v_yest_date;
  RAISE NOTICE '════════════════════════════════════════════════════════════════';

  -- Pick the target date for the funnel: prefer YESTERDAY (where the user
  -- actually observed 9 games / 195 / 5 recs) since today's cron hasn't
  -- run yet. Also report TODAY's counts so the slate-rolled state is visible.
  SELECT count(*) INTO v_props_count FROM public.props_cache
   WHERE game_date = v_today_ymd AND sport = 'mlb';
  RAISE NOTICE '[ctx] TODAY props_cache count: %', v_props_count;

  SELECT count(*) INTO v_props_count FROM public.recommendations_cache
   WHERE game_date = v_today_date AND sport = 'mlb';
  RAISE NOTICE '[ctx] TODAY recommendations_cache count: %', v_props_count;

  SELECT count(*) INTO v_props_count FROM public.recommendations_cache_sellable
   WHERE game_date = v_today_date AND sport = 'mlb';
  RAISE NOTICE '[ctx] TODAY recommendations_cache_sellable count: %', v_props_count;

  SELECT count(*) INTO v_props_count FROM public.recommendations_cache
   WHERE game_date = v_yest_date AND sport = 'mlb';
  RAISE NOTICE '[ctx] YESTERDAY recommendations_cache count: %', v_props_count;

  SELECT count(*) INTO v_props_count FROM public.recommendations_cache_sellable
   WHERE game_date = v_yest_date AND sport = 'mlb';
  RAISE NOTICE '[ctx] YESTERDAY recommendations_cache_sellable count: %  ← look for 5 here', v_props_count;

  v_target_ymd := v_yest_ymd; v_target_date := v_yest_date;
  SELECT count(*) INTO v_props_count FROM public.props_cache
   WHERE game_date = v_target_ymd AND sport = 'mlb';
  RAISE NOTICE '';
  RAISE NOTICE 'Funnel target = YESTERDAY (% props_cache rows)', v_props_count;

  -- ============================================================
  -- PART A — GAMES
  --
  -- mlb_scoring_progress per D-473 schema is a "scored once" register:
  -- one row per (game_date, game_pk) successfully scored. ABSENCE of a
  -- row = NOT yet scored. cache_mlb_game_scoreboard is the SCHEDULE
  -- source (one row per game with status/teams).
  -- ============================================================
  RAISE NOTICE '';
  RAISE NOTICE '── PART A — Games scored vs scheduled (game_date=%) ──', v_target_ymd;

  SELECT count(*) INTO v_scheduled_games
    FROM public.cache_mlb_game_scoreboard WHERE game_date = v_target_date;
  RAISE NOTICE '[A.1] cache_mlb_game_scoreboard scheduled games for %: %',
    v_target_date, v_scheduled_games;

  SELECT count(*) INTO v_scored_games FROM public.mlb_scoring_progress
   WHERE game_date = v_target_ymd;
  RAISE NOTICE '[A.2] mlb_scoring_progress scored count: % / % scheduled',
    v_scored_games, v_scheduled_games;

  RAISE NOTICE '';
  RAISE NOTICE '[A.3] Per-game scoreboard rows + pick counts (game_date=%):', v_target_date;
  FOR r IN
    SELECT
      cb.game_id AS game_pk,
      cb.home_team,
      cb.away_team,
      cb.status,
      EXISTS(SELECT 1 FROM public.mlb_scoring_progress mp
              WHERE mp.game_date = v_target_ymd
                AND mp.game_pk = cb.game_id) AS scored,
      (SELECT count(*) FROM public.pick_history ph
        WHERE ph.game_date = v_target_date
          AND ph.sport = 'mlb'
          AND ph.is_synthetic = false
          AND ((ph.team = cb.home_team AND ph.opponent = cb.away_team)
               OR (ph.team = cb.away_team AND ph.opponent = cb.home_team))) AS picks_via_history,
      (SELECT count(*) FROM public.recommendations_cache rc
        WHERE rc.game_date = v_target_date
          AND rc.sport = 'mlb'
          AND ((rc.team = cb.home_team AND rc.opponent = cb.away_team)
               OR (rc.team = cb.away_team AND rc.opponent = cb.home_team))) AS recs_for_game
    FROM public.cache_mlb_game_scoreboard cb
   WHERE cb.game_date = v_target_date
   ORDER BY cb.game_id
  LOOP
    RAISE NOTICE '  game_pk=% % @ % status=% scored=% picks=% recs=%',
      r.game_pk, r.away_team, r.home_team, r.status, r.scored,
      r.picks_via_history, r.recs_for_game;
  END LOOP;

  -- ============================================================
  -- PART B — THE FUNNEL
  -- ============================================================
  RAISE NOTICE '';
  RAISE NOTICE '── PART B — Funnel (game_date=%) ──', v_target_ymd;

  -- B.1 props analyzed (props_cache rows)
  RAISE NOTICE '';
  RAISE NOTICE '[B.1] props_cache rows by prop_type:';
  FOR r IN
    SELECT prop_type, count(*) AS n
      FROM public.props_cache
     WHERE game_date = v_target_ymd AND sport = 'mlb'
     GROUP BY prop_type ORDER BY count(*) DESC
  LOOP RAISE NOTICE '  %  n=%', r.prop_type, r.n; END LOOP;
  RAISE NOTICE '[B.1 TOTAL] props_cache: %', v_props_count;

  -- B.2 pick_history rows for the same date (over+under written as separate rows)
  SELECT count(*) INTO v_picks_count FROM public.pick_history
   WHERE game_date = v_target_date AND sport = 'mlb' AND is_synthetic = false;
  SELECT count(*) FILTER (WHERE pick_side = 'over') INTO v_over_picks FROM public.pick_history
   WHERE game_date = v_target_date AND sport = 'mlb' AND is_synthetic = false;
  SELECT count(*) FILTER (WHERE pick_side = 'under') INTO v_under_picks FROM public.pick_history
   WHERE game_date = v_target_date AND sport = 'mlb' AND is_synthetic = false;
  SELECT count(*) FILTER (WHERE pick_side IN ('home','away')) INTO v_homeaway_picks FROM public.pick_history
   WHERE game_date = v_target_date AND sport = 'mlb' AND is_synthetic = false;
  RAISE NOTICE '';
  RAISE NOTICE '[B.2] pick_history rows (sport=mlb, is_synthetic=false): %', v_picks_count;
  RAISE NOTICE '       over=% under=% home/away=%',
    v_over_picks, v_under_picks, v_homeaway_picks;

  RAISE NOTICE '';
  RAISE NOTICE '[B.2.detail] pick_history per (mlb_market_type, pick_side):';
  FOR r IN
    SELECT mlb_market_type, pick_side, count(*) AS n
      FROM public.pick_history
     WHERE game_date = v_target_date AND sport = 'mlb' AND is_synthetic = false
     GROUP BY mlb_market_type, pick_side
     ORDER BY mlb_market_type, pick_side
  LOOP RAISE NOTICE '  %  %  n=%', r.mlb_market_type, r.pick_side, r.n; END LOOP;

  -- B.3 D-538 hard-gate rejections for this run (from error_log).
  -- Token: error_type='d538_gate_rejections', context jsonb has totals.
  RAISE NOTICE '';
  RAISE NOTICE '[B.3] D-538 hard-gate rejections logged today (last 24h):';
  v_d538_today := 0;
  FOR r IN
    SELECT context, created_at FROM public.error_log
     WHERE error_type = 'd538_gate_rejections'
       AND created_at >= (now() - interval '24 hours')
     ORDER BY created_at DESC
  LOOP
    RAISE NOTICE '  at=% context=%', r.created_at, r.context;
    v_d538_today := v_d538_today + COALESCE((r.context->>'total_rejected')::int, 0);
  END LOOP;
  RAISE NOTICE '[B.3 total] D-538 last-24h rejections summed: %', v_d538_today;

  -- B.4 confidence >= 70
  SELECT count(*) INTO v_picks_c70 FROM public.pick_history
   WHERE game_date = v_target_date AND sport = 'mlb'
     AND is_synthetic = false AND confidence >= 70;
  RAISE NOTICE '';
  RAISE NOTICE '[B.4] pick_history confidence>=70 picks: %', v_picks_c70;

  RAISE NOTICE '';
  RAISE NOTICE '[B.4.detail] confidence>=70 by market:';
  FOR r IN
    SELECT mlb_market_type, count(*) AS n
      FROM public.pick_history
     WHERE game_date = v_target_date AND sport = 'mlb'
       AND is_synthetic = false AND confidence >= 70
     GROUP BY mlb_market_type ORDER BY count(*) DESC
  LOOP RAISE NOTICE '  %  n=%', r.mlb_market_type, r.n; END LOOP;

  -- B.5 sellable-market scoping (recommendations_cache for target date)
  SELECT count(*) INTO v_recs_count FROM public.recommendations_cache
   WHERE game_date = v_target_date AND sport = 'mlb';
  SELECT count(*) INTO v_recs_sellable FROM public.recommendations_cache_sellable
   WHERE game_date = v_target_date AND sport = 'mlb';
  RAISE NOTICE '';
  RAISE NOTICE '[B.5] recommendations_cache (pre-sellable filter): %', v_recs_count;
  RAISE NOTICE '[B.5] recommendations_cache_sellable (post-D-540 view): %', v_recs_sellable;

  -- B.5.detail per-market
  RAISE NOTICE '';
  RAISE NOTICE '[B.5.detail] rec_cache rows per (prop_type, is_sellable):';
  FOR r IN
    SELECT
      rc.prop_type,
      cfg.is_sellable,
      cfg.reason,
      count(*) AS n
      FROM public.recommendations_cache rc
      LEFT JOIN public.product_market_config cfg
        ON cfg.sport = rc.sport AND cfg.prop_type = rc.prop_type
     WHERE rc.game_date = v_target_date AND rc.sport = 'mlb'
     GROUP BY rc.prop_type, cfg.is_sellable, cfg.reason
     ORDER BY count(*) DESC
  LOOP
    RAISE NOTICE '  prop_type=% sellable=% n=% reason=%',
      r.prop_type, r.is_sellable, r.n, COALESCE(r.reason,'(no config; default=true)');
  END LOOP;

  -- B.5.config — current product_market_config truth
  RAISE NOTICE '';
  RAISE NOTICE '[B.5.config] product_market_config truth (MLB):';
  FOR r IN
    SELECT prop_type, mlb_market_type, is_sellable, reason
      FROM public.product_market_config
     WHERE sport = 'mlb' ORDER BY is_sellable DESC, prop_type
  LOOP
    RAISE NOTICE '  prop_type=% mlb_mkt=% sellable=% reason=%',
      r.prop_type, r.mlb_market_type, r.is_sellable, r.reason;
  END LOOP;

  -- ============================================================
  -- PART C — VERDICT
  -- ============================================================
  RAISE NOTICE '';
  RAISE NOTICE '── PART C — Verdict ──';
  RAISE NOTICE 'Funnel summary (game_date=%):', v_target_ymd;
  RAISE NOTICE '  STAGE 1 props analyzed:           %', v_props_count;
  RAISE NOTICE '  STAGE 2 picks written:            %', v_picks_count;
  RAISE NOTICE '  STAGE 3 D-538 gate rejections:    % (last 24h, may include other dates)', v_d538_today;
  RAISE NOTICE '  STAGE 4 picks conf>=70:           %', v_picks_c70;
  RAISE NOTICE '  STAGE 5 rec_cache pre-sellable:   %', v_recs_count;
  RAISE NOTICE '  STAGE 6 rec_cache_sellable:       %  ← THIS IS WHAT THE DASHBOARD SHOWS', v_recs_sellable;

  RAISE NOTICE '';
  RAISE NOTICE 'Reconciliation hints:';
  RAISE NOTICE '  - If STAGE 2 ~ 2x STAGE 1: over+under both written (expected for over/under markets).';
  RAISE NOTICE '  - STAGE 2 minus STAGE 4 = picks below 70 confidence (LEAN/PASS, not surfaced).';
  RAISE NOTICE '  - STAGE 4 minus STAGE 5 = picks dropped between conf>=70 and rec_cache writeback';
  RAISE NOTICE '    (most often: per-market top-K, dup-suppress, or unfetched rec_cache backfill).';
  RAISE NOTICE '  - STAGE 5 minus STAGE 6 = D-540 sellable-scoping (expected: non-sellable markets hidden).';
  RAISE NOTICE '  - STAGE 6 = what dashboard renders. If STAGE 6 ≈ 5 → HONEST result of scoping.';
  RAISE NOTICE '';
  RAISE NOTICE 'BREAK hints (return to investigate if any fire):';
  RAISE NOTICE '  - A.1 < expected slate size (today usually 8-15 MLB games) → games dropped from cron';
  RAISE NOTICE '  - A.3 game with picks=0 while others have picks → STL@SD-class silent drop (D-537)';
  RAISE NOTICE '  - STAGE 4 = 0 → no picks at confidence threshold (algo/data issue, not scoping)';
  RAISE NOTICE '  - STAGE 5 = 0 but STAGE 4 > 0 → rec_cache writeback failure (separate bug)';
  RAISE NOTICE '';
  RAISE NOTICE 'D-603 diagnostic complete.';
END $$;
