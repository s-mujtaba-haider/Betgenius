-- D-593 SHIP 1 inventory — what's REALLY available among the D-556 free items.
DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '60s';

  RAISE NOTICE '======== D-593 §A: cache_mlb_bullpen_stats coverage ========';
  FOR r IN
    SELECT
      count(*) AS n_rows,
      count(DISTINCT team_name) AS n_teams,
      min(snapshot_date) AS earliest,
      max(snapshot_date) AS latest
    FROM public.cache_mlb_bullpen_stats
  LOOP RAISE NOTICE '[D-593 §A.1] rows=% teams=% (% .. %)',
    r.n_rows, r.n_teams, r.earliest, r.latest; END LOOP;

  -- For the pitcher_k corpus dates, do we have historical bullpen snapshots?
  RAISE NOTICE '======== D-593 §B: per-pick bullpen-cache match potential ========';
  FOR r IN
    WITH pk_picks AS (
      SELECT id, opponent, game_date
      FROM public.pick_history
      WHERE sport='mlb' AND mlb_market_type='pitcher_k'
        AND is_synthetic=false AND voided IS NOT TRUE AND hit IS NOT NULL
        AND breakdown ? 'projected_k' AND actual_value IS NOT NULL
    )
    SELECT
      count(*) AS n_picks,
      count(*) FILTER (WHERE EXISTS (
        SELECT 1 FROM public.cache_mlb_bullpen_stats bp
        WHERE bp.team_name = p.opponent
          AND bp.snapshot_date <= p.game_date
          AND bp.snapshot_date >= p.game_date - 7
      )) AS n_with_bp_snapshot_within_7d
    FROM pk_picks p
  LOOP RAISE NOTICE '[D-593 §B.1] n_pitcher_k_picks=% n_w_recent_bp=%',
    r.n_picks, r.n_with_bp_snapshot_within_7d; END LOOP;

  -- ===================================================================
  -- §C — Existing inputs ALREADY in batter scorer breakdown that are
  -- NOT yet wired into pitcher_k breakdown. From D-556 §H.2 cheap wins.
  -- ===================================================================
  RAISE NOTICE '======== D-593 §C: batter market opposing_bullpen_era signal (n + r vs strikeouts not applicable) ========';
  FOR r IN
    SELECT
      count(*) AS n_with_bp_era,
      count(DISTINCT (breakdown->>'opposing_bullpen_era')) AS distinct_bp_era,
      ROUND(avg((breakdown->>'opposing_bullpen_era')::numeric)::numeric, 2) AS avg_bp_era,
      ROUND(stddev((breakdown->>'opposing_bullpen_era')::numeric)::numeric, 3) AS sd_bp_era
    FROM public.pick_history
    WHERE sport='mlb' AND mlb_market_type='batter_total_bases'
      AND breakdown ? 'opposing_bullpen_era'
      AND (breakdown->>'opposing_bullpen_era') ~ '^-?[0-9.]+$'
      AND game_date >= (now() - interval '60 days')::date
  LOOP RAISE NOTICE '[D-593 §C.1] batter_TB opp_bullpen_era: n=% distinct=% avg=% sd=%',
    r.n_with_bp_era, r.distinct_bp_era, r.avg_bp_era, r.sd_bp_era; END LOOP;

  -- ===================================================================
  -- §D — Retroactive signal check candidate: join pitcher_k picks to
  -- nearest bullpen snapshot. The CORE QUESTION: does opposing-team
  -- bullpen ERA predict pitcher K count?
  -- ===================================================================
  RAISE NOTICE '======== D-593 §D: corr(opposing_bullpen_era, actual_K) retroactive ========';
  FOR r IN
    WITH joined AS (
      SELECT
        p.id, p.actual_value AS k, p.line,
        bp.bullpen_era,
        bp.bullpen_ip
      FROM public.pick_history p
      JOIN LATERAL (
        SELECT bullpen_era, bullpen_ip
        FROM public.cache_mlb_bullpen_stats bp
        WHERE bp.team_name = p.opponent
          AND bp.snapshot_date <= p.game_date
          AND bp.snapshot_date >= p.game_date - 7
        ORDER BY bp.snapshot_date DESC LIMIT 1
      ) bp ON TRUE
      WHERE p.sport='mlb' AND p.mlb_market_type='pitcher_k'
        AND p.is_synthetic=false AND p.voided IS NOT TRUE AND p.hit IS NOT NULL
        AND p.actual_value IS NOT NULL AND p.breakdown ? 'projected_k'
        AND bp.bullpen_era IS NOT NULL
    )
    SELECT
      count(*) AS n,
      ROUND(corr(bullpen_era, k)::numeric, 4) AS r_bp_vs_k,
      ROUND(corr(bullpen_era, k - line)::numeric, 4) AS r_bp_vs_residual_at_line
    FROM joined
  LOOP RAISE NOTICE '[D-593 §D.1] joined n=% corr(bp_era, k)=% corr(bp_era, k-line)=%',
    r.n, r.r_bp_vs_k, r.r_bp_vs_residual_at_line; END LOOP;
END $$;
