-- D-506 SHIP 3c — 5 spot-checks of backfilled outcomes vs MLB Stats API truth.
DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '[D-506 SHIP 3c] 5 spot-check rows (random, resolved during backfill):';
  FOR r IN
    SELECT id, player_name, team, opponent, sport, mlb_market_type, prop_type,
           line, pick_side, odds, actual_value, hit, voided, game_date,
           resolved_at::TIMESTAMPTZ AS resolved_at_ts
    FROM public.pick_history
    WHERE is_synthetic = false
      AND resolved_at >= '2026-06-11 02:11:00+00'
      AND resolved_at IS NOT NULL
    ORDER BY random() LIMIT 5
  LOOP
    RAISE NOTICE '----- spot %:', r.id;
    RAISE NOTICE '  player=% team=% vs opp=% gd=%',
      r.player_name, r.team, r.opponent, r.game_date;
    RAISE NOTICE '  market=% line=% side=% odds=%',
      r.mlb_market_type, r.line, r.pick_side, r.odds;
    RAISE NOTICE '  actual_value=% hit=% voided=% resolved_at=%',
      r.actual_value, r.hit, r.voided, r.resolved_at_ts;
  END LOOP;

  RAISE NOTICE '[D-506 SHIP 3c] backfill outcome breakdown:';
  FOR r IN
    SELECT
      sport,
      count(*) FILTER (WHERE hit IS TRUE)  AS won,
      count(*) FILTER (WHERE hit IS FALSE) AS lost,
      count(*) FILTER (WHERE hit IS NULL AND resolved_at IS NOT NULL AND voided <> true) AS push,
      count(*) FILTER (WHERE voided = true) AS voided_n,
      count(*) AS total
    FROM public.pick_history
    WHERE is_synthetic = false
      AND resolved_at >= '2026-06-11 02:11:00+00'
    GROUP BY sport ORDER BY sport
  LOOP
    RAISE NOTICE '  sport=% won=% lost=% push=% voided=% total=%',
      r.sport, r.won, r.lost, r.push, r.voided_n, r.total;
  END LOOP;
END $$;
