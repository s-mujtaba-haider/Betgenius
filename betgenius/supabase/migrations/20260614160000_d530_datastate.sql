-- D-530 SHIP 1 (v1 superseded by 20260614160100_d530_datastate_part2.sql)
-- v1 errored on `stake_units` column reference for bets (actual is `stake`).
-- v2 (part2) fixes that + adds the deep-dives on §A.4 finding. This file
-- is left as a no-op so migration history stays linear. The §A queries
-- already ran successfully in v1 — captured in the NOTICE output:
--   §A.1 total=119,253 non-voided pick_history rows; 0 NOT-NULL violations
--   §A.2 1,020 conf=0; 263 conf=100; 1,060 odds_extreme; 1,162 line_neg; 115 line_huge
--   §A.3 647 resolved_no_hit; 652 actual_no_hit; 0 voided_but_has_hit
--   §A.4 56,893 mlb_without_market_type; 55,207 mlb_unexpected_prop_type
DO $$ BEGIN
  RAISE NOTICE '[D-530 16000] no-op — superseded by 16100_part2.';
END $$;
