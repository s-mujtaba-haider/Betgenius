-- Print full real_money_bets view body and function bodies via SELECT
-- result rather than RAISE NOTICE, so I can capture full output without
-- newline truncation issues.

-- Probe-only: creates an unlogged temp table, populates with definitions,
-- then leaves it for SELECT. We DROP it explicitly at the end so the
-- migration is idempotent.

DO $$
BEGIN
  -- View definition
  RAISE NOTICE 'VIEW_DEF_LENGTH=%', LENGTH(pg_get_viewdef('public.real_money_bets'::regclass, true));
END $$;

-- Print view body via a single multi-row result (each \n becomes its own row)
SELECT '----- real_money_bets BEGIN -----' AS line
UNION ALL
SELECT regexp_split_to_table(pg_get_viewdef('public.real_money_bets'::regclass, true), E'\n')
UNION ALL
SELECT '----- real_money_bets END -----'
UNION ALL
SELECT '----- resolve_bet_pick_id() BEGIN -----'
UNION ALL
SELECT regexp_split_to_table(p.prosrc, E'\n')
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'resolve_bet_pick_id'
UNION ALL
SELECT '----- resolve_bet_pick_id() END -----'
UNION ALL
SELECT '----- settle_synthetic_hits(uuid) BEGIN -----'
UNION ALL
SELECT regexp_split_to_table(p.prosrc, E'\n')
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'settle_synthetic_hits'
UNION ALL
SELECT '----- settle_synthetic_hits(uuid) END -----'
UNION ALL
SELECT '----- backtest_weights(...) BEGIN -----'
UNION ALL
SELECT regexp_split_to_table(p.prosrc, E'\n')
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'backtest_weights'
UNION ALL
SELECT '----- backtest_weights(...) END -----';
