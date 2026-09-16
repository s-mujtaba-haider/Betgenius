-- D-530 SHIP 1 (continued) — fix `stake_units` column name (actual is `stake`)
-- and run §B + §C + §D + extra deep-dives for the surprising §A.4 finding.
DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '180s';

  RAISE NOTICE '======== D-530 §B: bets NULL / range / consistency ========';

  FOR r IN
    SELECT
      count(*) AS total,
      count(*) FILTER (WHERE pick_id IS NULL) AS pick_id_null,
      count(*) FILTER (WHERE pick_id IS NULL AND status IN ('won','lost')) AS settled_no_pick_id,
      count(*) FILTER (WHERE stake IS NULL OR stake <= 0) AS bad_stake,
      count(*) FILTER (WHERE odds IS NULL OR odds = 0) AS bad_odds,
      count(*) FILTER (WHERE placed_at IS NULL) AS no_placed_at,
      count(*) FILTER (WHERE status NOT IN ('pending','won','lost','push','void')) AS unknown_status,
      count(*) FILTER (WHERE status='pending' AND placed_at < now() - interval '30 days') AS pending_30d_plus,
      count(*) FILTER (WHERE status='won' AND payout IS NULL) AS won_no_payout,
      count(*) FILTER (WHERE status='lost' AND payout IS NOT NULL AND payout > 0) AS lost_with_payout
    FROM public.bets
  LOOP RAISE NOTICE '[D-530 §B.1] bets anomalies: total=% pick_id_null=% settled_no_pick_id=% bad_stake=% bad_odds=% no_placed_at=% unknown_status=% pending_30d_plus=% won_no_payout=% lost_with_payout=%',
    r.total, r.pick_id_null, r.settled_no_pick_id, r.bad_stake, r.bad_odds,
    r.no_placed_at, r.unknown_status, r.pending_30d_plus, r.won_no_payout, r.lost_with_payout; END LOOP;

  -- Orphan: bets.pick_id pointing to nothing
  FOR r IN
    SELECT count(*) AS orphan_bets
    FROM public.bets b
    WHERE b.pick_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.pick_history p WHERE p.id = b.pick_id)
  LOOP RAISE NOTICE '[D-530 §B.2] bets with pick_id pointing to nothing: %', r.orphan_bets; END LOOP;

  RAISE NOTICE '======== D-530 §C: recommendations_cache anomalies ========';

  FOR r IN
    SELECT
      count(*) AS total,
      count(*) FILTER (WHERE confidence IS NULL OR confidence < 0 OR confidence > 100) AS conf_bad,
      count(*) FILTER (WHERE odds IS NULL OR odds = 0) AS odds_bad,
      count(*) FILTER (WHERE breakdown IS NULL) AS no_breakdown,
      count(*) FILTER (WHERE prop_type IS NULL) AS prop_type_null,
      count(*) FILTER (WHERE game_date IS NULL) AS no_game_date,
      count(*) FILTER (WHERE sport IS NULL OR sport NOT IN ('nba','mlb')) AS sport_bad
    FROM public.recommendations_cache
  LOOP RAISE NOTICE '[D-530 §C.1] recommendations_cache anomalies: total=% conf_bad=% odds_bad=% no_breakdown=% prop_type_null=% no_game_date=% sport_bad=%',
    r.total, r.conf_bad, r.odds_bad, r.no_breakdown, r.prop_type_null,
    r.no_game_date, r.sport_bad; END LOOP;

  RAISE NOTICE '======== D-530 §D: DUPLICATES within pick_history ========';

  FOR r IN
    SELECT count(*) AS dup_groups, sum(c-1) AS extra_rows
    FROM (
      SELECT player_name, prop_type, line, pick_side, game_date, count(*) AS c
      FROM public.pick_history
      WHERE is_synthetic = false AND voided IS NOT TRUE
      GROUP BY player_name, prop_type, line, pick_side, game_date
      HAVING count(*) > 1
    ) g
  LOOP RAISE NOTICE '[D-530 §D.1] non-synthetic duplicates: dup_groups=% extra_rows=%',
    r.dup_groups, r.extra_rows; END LOOP;

  RAISE NOTICE '======== D-530 §E: Deep-dive on the surprising §A.4 finding ========';

  -- §A.4 said 56,893 MLB picks have NULL mlb_market_type. Decompose by
  -- is_synthetic + age + source to understand whether this is backfill
  -- residue or active drift.
  FOR r IN
    SELECT
      is_synthetic,
      COALESCE(source, '<null>') AS source,
      count(*) AS rows,
      count(*) FILTER (WHERE mlb_market_type IS NULL) AS missing_market_type,
      ROUND(100.0 * count(*) FILTER (WHERE mlb_market_type IS NULL) / NULLIF(count(*),0), 1) AS pct_missing
    FROM public.pick_history
    WHERE sport = 'mlb' AND voided IS NOT TRUE
    GROUP BY is_synthetic, source
    ORDER BY rows DESC
  LOOP RAISE NOTICE '[D-530 §E.1] mlb mlb_market_type coverage by (is_synthetic, source): is_syn=% src=% rows=% missing=% pct_missing=%',
    r.is_synthetic, r.source, r.rows, r.missing_market_type, r.pct_missing; END LOOP;

  -- Now: same breakdown for prop_type unexpected values
  FOR r IN
    SELECT
      prop_type,
      count(*) AS rows,
      count(*) FILTER (WHERE is_synthetic = true) AS synthetic_rows,
      count(*) FILTER (WHERE is_synthetic = false) AS organic_rows
    FROM public.pick_history
    WHERE sport = 'mlb' AND voided IS NOT TRUE
    GROUP BY prop_type
    ORDER BY rows DESC LIMIT 20
  LOOP RAISE NOTICE '[D-530 §E.2] mlb prop_type distribution: prop_type=% rows=% synthetic=% organic=%',
    r.prop_type, r.rows, r.synthetic_rows, r.organic_rows; END LOOP;

  RAISE NOTICE '======== D-530 §F: cross-table reconcile ========';

  -- pick_history rows per (sport, today/last 7d) vs recommendations_cache
  FOR r IN
    SELECT
      'pick_history (nba, last 7d)' AS source,
      count(*) FILTER (WHERE sport='nba' AND created_at > now() - interval '7 days' AND is_synthetic=false AND voided IS NOT TRUE) AS rows
    FROM public.pick_history
  LOOP RAISE NOTICE '[D-530 §F.1] %: %', r.source, r.rows; END LOOP;

  FOR r IN
    SELECT
      'pick_history (mlb, last 7d)' AS source,
      count(*) FILTER (WHERE sport='mlb' AND created_at > now() - interval '7 days' AND is_synthetic=false AND voided IS NOT TRUE) AS rows
    FROM public.pick_history
  LOOP RAISE NOTICE '[D-530 §F.1] %: %', r.source, r.rows; END LOOP;

  FOR r IN
    SELECT
      'recommendations_cache (mlb, last 7d)' AS source,
      count(*) FILTER (WHERE sport='mlb' AND created_at > now() - interval '7 days') AS rows
    FROM public.recommendations_cache
  LOOP RAISE NOTICE '[D-530 §F.1] %: %', r.source, r.rows; END LOOP;

  FOR r IN
    SELECT
      'recommendations_cache (nba, last 7d)' AS source,
      count(*) FILTER (WHERE sport='nba' AND created_at > now() - interval '7 days') AS rows
    FROM public.recommendations_cache
  LOOP RAISE NOTICE '[D-530 §F.1] %: %', r.source, r.rows; END LOOP;

END $$;
