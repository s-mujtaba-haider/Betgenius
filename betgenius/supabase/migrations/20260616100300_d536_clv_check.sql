-- D-536 SHIP 2-3 — Confirm D-467 edge floor coverage + CLV check.
DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '60s';

  -- §K — Confidence distribution among disagree-with-projection picks.
  -- D-467 caps these at 69; if it's working, no disagree pick should
  -- reach conf>=70.
  RAISE NOTICE '======== D-536 §K: D-467 edge-floor coverage check ========';
  FOR r IN
    SELECT
      mlb_market_type AS market,
      count(*) AS n_disagree,
      count(*) FILTER (WHERE confidence >= 70) AS n_disagree_at_70,
      count(*) FILTER (WHERE confidence >= 80) AS n_disagree_at_80,
      ROUND(avg(confidence)::numeric, 1) AS avg_conf,
      max(confidence) AS max_conf
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND projected_stat IS NOT NULL
      AND pick_side IN ('over','under')
      AND ((pick_side = 'over' AND projected_stat < line)
           OR (pick_side = 'under' AND projected_stat > line))
    GROUP BY mlb_market_type
    ORDER BY count(*) DESC
  LOOP RAISE NOTICE '[D-536 §K.1] disagree mkt=% n=% at_>=70=% at_>=80=% avg_conf=% max_conf=%',
    r.market, r.n_disagree, r.n_disagree_at_70, r.n_disagree_at_80,
    r.avg_conf, r.max_conf; END LOOP;

  -- §L — Now the symmetric check: how many AGREE picks are at high conf?
  -- If D-467 is the only thing pushing disagree to low conf, AGREE picks
  -- should be the bulk of high-conf picks.
  RAISE NOTICE '======== D-536 §L: AGREE picks at high conf (the well-tuned set) ========';
  FOR r IN
    SELECT
      mlb_market_type AS market,
      count(*) AS n_agree,
      count(*) FILTER (WHERE confidence >= 70) AS n_agree_at_70,
      ROUND(100.0 * count(*) FILTER (WHERE confidence >= 70 AND hit) / NULLIF(count(*) FILTER (WHERE confidence >= 70),0), 1) AS agree_wr_at_70,
      count(*) FILTER (WHERE confidence >= 80) AS n_agree_at_80,
      ROUND(100.0 * count(*) FILTER (WHERE confidence >= 80 AND hit) / NULLIF(count(*) FILTER (WHERE confidence >= 80),0), 1) AS agree_wr_at_80
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND projected_stat IS NOT NULL
      AND pick_side IN ('over','under')
      AND ((pick_side = 'over' AND projected_stat > line)
           OR (pick_side = 'under' AND projected_stat < line))
    GROUP BY mlb_market_type
    ORDER BY count(*) DESC
  LOOP RAISE NOTICE '[D-536 §L.1] AGREE mkt=% n=% at_>=70(n=%, WR=%) at_>=80(n=%, WR=%)',
    r.market, r.n_agree, r.n_agree_at_70, r.agree_wr_at_70, r.n_agree_at_80, r.agree_wr_at_80; END LOOP;

  -- §M — CLV check. Among picks with closing_captured_at, do we beat the close?
  -- clv_pct > 0 = our bet at better odds than close (line moved toward us = sharp)
  -- clv_pct < 0 = we got worse odds than close
  RAISE NOTICE '======== D-536 §M: CLV cross-check ========';
  FOR r IN
    SELECT
      count(*) AS n_with_clv,
      ROUND(avg(clv_pct)::numeric, 2) AS avg_clv_pct,
      count(*) FILTER (WHERE clv_pct > 0) AS n_beat_close,
      ROUND(100.0 * count(*) FILTER (WHERE clv_pct > 0) / NULLIF(count(*),0), 1) AS pct_beat_close,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*),0), 1) AS wr_when_clv_captured
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND clv_pct IS NOT NULL
  LOOP RAISE NOTICE '[D-536 §M.1] n_with_clv=% avg_clv_pct=% n_beat_close=% pct_beat_close=% wr=%',
    r.n_with_clv, r.avg_clv_pct, r.n_beat_close, r.pct_beat_close, r.wr_when_clv_captured; END LOOP;

  -- §M.2 — CLV per market
  RAISE NOTICE '======== D-536 §M.2: CLV per market ========';
  FOR r IN
    SELECT mlb_market_type AS market,
      count(*) AS n,
      ROUND(avg(clv_pct)::numeric, 2) AS avg_clv,
      ROUND(100.0 * count(*) FILTER (WHERE clv_pct > 0) / NULLIF(count(*),0), 1) AS pct_beat_close,
      ROUND(100.0 * count(*) FILTER (WHERE hit) / NULLIF(count(*),0), 1) AS wr
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND clv_pct IS NOT NULL AND mlb_market_type IS NOT NULL
    GROUP BY mlb_market_type
    HAVING count(*) >= 30
    ORDER BY count(*) DESC
  LOOP RAISE NOTICE '[D-536 §M.2] mkt=% n=% avg_clv=% pct_beat_close=% wr=%',
    r.market, r.n, r.avg_clv, r.pct_beat_close, r.wr; END LOOP;

  -- §N — Hand-verify edge calc on a sample pick
  -- For each, compute implied probability from odds and stored vs hand math
  RAISE NOTICE '======== D-536 §N: edge calc hand-verify ========';
  FOR r IN
    SELECT
      id, mlb_market_type, line, pick_side, odds, confidence, hit,
      projected_stat,
      ROUND(((projected_stat - line) *
        CASE WHEN pick_side = 'over' THEN 1 ELSE -1 END)::numeric, 3) AS hand_edge,
      (breakdown->>'raw_edge')::numeric AS stored_edge,
      CASE WHEN odds > 0 THEN ROUND(100.0/(odds+100), 3)
           ELSE ROUND((-odds)*1.0/((-odds)+100), 3) END AS implied_prob
    FROM public.pick_history
    WHERE sport='mlb' AND is_synthetic=false AND voided IS NOT TRUE
      AND hit IS NOT NULL AND breakdown IS NOT NULL
      AND breakdown ? 'raw_edge' AND projected_stat IS NOT NULL
      AND pick_side IN ('over','under')
    ORDER BY random() LIMIT 5
  LOOP RAISE NOTICE '[D-536 §N.1] id=% mkt=% L=% side=% odds=% proj=% hit=% hand_edge=% stored_edge=% implied_prob=%',
    r.id, r.mlb_market_type, r.line, r.pick_side, r.odds, r.projected_stat,
    r.hit, r.hand_edge, r.stored_edge, r.implied_prob; END LOOP;
END $$;
