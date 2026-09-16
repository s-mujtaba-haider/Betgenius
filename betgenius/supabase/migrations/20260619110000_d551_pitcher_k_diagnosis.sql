-- D-551 SHIP 1 — pitcher_k WRONG-DIRECTION root cause diagnostic.
--
-- Read-only. The puzzle: projected_k has r=0.397 vs actual but
-- sign-accuracy 50.94% (chance). Why does a well-ranking projection
-- call direction at coin-flip? Three candidate causes tested:
--
--   §A — Mean mismatch: avg(proj) vs avg(line) vs avg(actual)
--   §B — Edge magnitude vs sign-acc (is the projection only noisy
--          near the line?)
--   §C — Variance comparison: (proj-line) vs (actual-line) — does
--          the projection diff carry any signal at all about which
--          side hits?
--   §D — Per-input edge: if we replaced projected_k with each
--          signal-bearing INPUT alone, what sign-acc do we get?
--          This isolates whether the recipe (blend × adj × park)
--          dilutes signal vs each raw input.

DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '120s';

  -- ===================================================================
  -- §A — Mean centering check
  -- ===================================================================
  RAISE NOTICE '======== D-551 §A: mean / centering check (the bias test) ========';
  FOR r IN
    SELECT
      count(*) AS n,
      ROUND(avg((breakdown->>'projected_k')::numeric)::numeric, 3) AS avg_proj,
      ROUND(avg(line)::numeric, 3) AS avg_line,
      ROUND(avg(actual_value)::numeric, 3) AS avg_actual,
      ROUND(avg((breakdown->>'projected_k')::numeric - line)::numeric, 3) AS avg_edge_proj_minus_line,
      ROUND(avg(actual_value - line)::numeric, 3) AS avg_residual_actual_minus_line,
      ROUND(stddev((breakdown->>'projected_k')::numeric - line)::numeric, 3) AS sd_proj_edge,
      ROUND(stddev(actual_value - line)::numeric, 3) AS sd_actual_residual
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND mlb_market_type='pitcher_k'
      AND breakdown ? 'projected_k' AND actual_value IS NOT NULL
  LOOP RAISE NOTICE '[D-551 §A.1] n=% avg_proj=% avg_line=% avg_actual=% avg_proj_edge=% avg_actual_resid=% sd_proj_edge=% sd_actual_resid=%',
    r.n, r.avg_proj, r.avg_line, r.avg_actual,
    r.avg_edge_proj_minus_line, r.avg_residual_actual_minus_line,
    r.sd_proj_edge, r.sd_actual_residual; END LOOP;

  -- ===================================================================
  -- §B — Sign-acc by edge magnitude bucket.
  -- Hypothesis: if projection is right when confident (|edge|>1) but
  -- coin-flip near line (|edge|<0.5), recipe is OK — just needs
  -- a confidence floor. If sign-acc is 50% even at |edge|>1.5, the
  -- recipe is fundamentally broken.
  -- ===================================================================
  RAISE NOTICE '======== D-551 §B: sign-acc by |edge| bucket ========';
  FOR r IN
    WITH t AS (
      SELECT actual_value, line, (breakdown->>'projected_k')::numeric AS proj
      FROM public.pick_history
      WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
        AND hit IS NOT NULL AND mlb_market_type='pitcher_k'
        AND breakdown ? 'projected_k' AND actual_value IS NOT NULL
    )
    SELECT
      CASE
        WHEN abs(proj - line) < 0.25 THEN '0.0-0.25'
        WHEN abs(proj - line) < 0.5  THEN '0.25-0.5'
        WHEN abs(proj - line) < 1.0  THEN '0.5-1.0'
        WHEN abs(proj - line) < 1.5  THEN '1.0-1.5'
        ELSE                              '1.5+'
      END AS edge_bucket,
      count(*) AS n,
      ROUND(100.0 * count(*) FILTER (WHERE
        (proj > line AND actual_value > line) OR
        (proj < line AND actual_value < line)
      ) / NULLIF(count(*) FILTER (WHERE proj <> line AND actual_value <> line), 0)::numeric, 2) AS sign_acc_pct
    FROM t WHERE proj <> line AND actual_value <> line
    GROUP BY 1 ORDER BY 1
  LOOP RAISE NOTICE '[D-551 §B.1] |edge|=%: n=% sign_acc=%',
    r.edge_bucket, r.n, r.sign_acc_pct; END LOOP;

  -- ===================================================================
  -- §C — Variance comparison: does (proj - line) carry direction signal at all?
  -- If proj_edge is correlated with actual_residual_signed, the proj
  -- *direction call* is meaningful. If they're independent (corr near 0),
  -- the proj diff is noise relative to the line.
  -- ===================================================================
  RAISE NOTICE '======== D-551 §C: corr( proj-line, actual-line ) — direction-call meaningfulness ========';
  FOR r IN
    WITH t AS (
      SELECT
        actual_value - line AS actual_resid,
        (breakdown->>'projected_k')::numeric - line AS proj_edge
      FROM public.pick_history
      WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
        AND hit IS NOT NULL AND mlb_market_type='pitcher_k'
        AND breakdown ? 'projected_k' AND actual_value IS NOT NULL
    )
    SELECT
      count(*) AS n,
      ROUND(corr(proj_edge, actual_resid)::numeric, 4) AS r_signed,
      ROUND(corr(abs(proj_edge), abs(actual_resid))::numeric, 4) AS r_magnitude
    FROM t
  LOOP RAISE NOTICE '[D-551 §C.1] n=% corr(proj_edge, actual_resid)=% corr_abs=%',
    r.n, r.r_signed, r.r_magnitude; END LOOP;

  -- ===================================================================
  -- §D — Per-input candidate projections: which single input, used as
  -- a NEW projection, gives the best sign-acc? (Mean-centered to line
  -- on the train slice so each is a fair test.)
  -- Reports the *replacement projection* sign-accuracy for several
  -- candidates: season_k_per_start, last5_k_avg, blended_projection.
  -- ===================================================================
  RAISE NOTICE '======== D-551 §D: per-candidate raw projections sign-acc ========';
  FOR r IN
    WITH t AS (
      SELECT actual_value, line,
        (breakdown->>'projected_k')::numeric          AS curr_proj,
        (breakdown->>'season_k_per_start')::numeric   AS season,
        (breakdown->>'last5_k_avg')::numeric          AS last5,
        (breakdown->>'blended_projection')::numeric   AS blended
      FROM public.pick_history
      WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
        AND hit IS NOT NULL AND mlb_market_type='pitcher_k'
        AND breakdown ? 'projected_k' AND actual_value IS NOT NULL
        AND breakdown ? 'season_k_per_start'
        AND breakdown ? 'last5_k_avg'
        AND breakdown ? 'blended_projection'
    )
    SELECT
      count(*) AS n,
      ROUND(100.0 * count(*) FILTER (WHERE
        (curr_proj > line AND actual_value > line) OR (curr_proj < line AND actual_value < line)
      ) / NULLIF(count(*) FILTER (WHERE curr_proj <> line AND actual_value <> line), 0)::numeric, 2) AS sa_curr,
      ROUND(100.0 * count(*) FILTER (WHERE
        (season > line AND actual_value > line) OR (season < line AND actual_value < line)
      ) / NULLIF(count(*) FILTER (WHERE season <> line AND actual_value <> line), 0)::numeric, 2) AS sa_season,
      ROUND(100.0 * count(*) FILTER (WHERE
        (last5 > line AND actual_value > line) OR (last5 < line AND actual_value < line)
      ) / NULLIF(count(*) FILTER (WHERE last5 <> line AND actual_value <> line), 0)::numeric, 2) AS sa_last5,
      ROUND(100.0 * count(*) FILTER (WHERE
        (blended > line AND actual_value > line) OR (blended < line AND actual_value < line)
      ) / NULLIF(count(*) FILTER (WHERE blended <> line AND actual_value <> line), 0)::numeric, 2) AS sa_blended
    FROM t
  LOOP RAISE NOTICE '[D-551 §D.1] n=% sa_current=% sa_season=% sa_last5=% sa_blended=%',
    r.n, r.sa_curr, r.sa_season, r.sa_last5, r.sa_blended; END LOOP;

  -- ===================================================================
  -- §E — Test recentered candidate: actual centering.
  -- If avg_actual - avg_line shifts the projection by a constant,
  -- does the recentered projection get sign-acc > 50%?
  --   recentered = current_proj + (avg_actual - avg_proj) on the full set
  -- ===================================================================
  RAISE NOTICE '======== D-551 §E: recentered projection sign-acc ========';
  FOR r IN
    WITH stats AS (
      SELECT
        avg((breakdown->>'projected_k')::numeric) AS avg_proj,
        avg(actual_value::numeric) AS avg_actual,
        avg(line::numeric) AS avg_line
      FROM public.pick_history
      WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
        AND hit IS NOT NULL AND mlb_market_type='pitcher_k'
        AND breakdown ? 'projected_k' AND actual_value IS NOT NULL
    ), t AS (
      SELECT ph.actual_value, ph.line,
        (ph.breakdown->>'projected_k')::numeric AS curr_proj,
        (ph.breakdown->>'projected_k')::numeric + (s.avg_actual - s.avg_proj) AS recentered_proj_actual,
        (ph.breakdown->>'projected_k')::numeric + (s.avg_line   - s.avg_proj) AS recentered_proj_line
      FROM public.pick_history ph CROSS JOIN stats s
      WHERE ph.sport='mlb' AND ph.is_synthetic=false AND ph.voided IS NOT TRUE
        AND ph.hit IS NOT NULL AND ph.mlb_market_type='pitcher_k'
        AND ph.breakdown ? 'projected_k' AND ph.actual_value IS NOT NULL
    )
    SELECT
      count(*) AS n,
      ROUND(100.0 * count(*) FILTER (WHERE
        (curr_proj > line AND actual_value > line) OR (curr_proj < line AND actual_value < line)
      ) / NULLIF(count(*) FILTER (WHERE curr_proj <> line AND actual_value <> line), 0)::numeric, 2) AS sa_curr,
      ROUND(100.0 * count(*) FILTER (WHERE
        (recentered_proj_actual > line AND actual_value > line) OR (recentered_proj_actual < line AND actual_value < line)
      ) / NULLIF(count(*) FILTER (WHERE recentered_proj_actual <> line AND actual_value <> line), 0)::numeric, 2) AS sa_recenter_actual,
      ROUND(100.0 * count(*) FILTER (WHERE
        (recentered_proj_line > line AND actual_value > line) OR (recentered_proj_line < line AND actual_value < line)
      ) / NULLIF(count(*) FILTER (WHERE recentered_proj_line <> line AND actual_value <> line), 0)::numeric, 2) AS sa_recenter_line
    FROM t
  LOOP RAISE NOTICE '[D-551 §E.1] n=% sa_current=% sa_recentered_to_avg_actual=% sa_recentered_to_avg_line=%',
    r.n, r.sa_curr, r.sa_recenter_actual, r.sa_recenter_line; END LOOP;

END $$;
