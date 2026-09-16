-- D-504 SHIP 1 — backfill stuck bets that resolve-picks can't auto-settle.
-- Two cohorts:
--   A) 5 May 27 game-level bets — set status from real May 27 game finals
--      pulled live from MLB Stats API (see d504_bets_fix.md for the per-game
--      reasoning).
--   B) 7 April NBA bets — linked pick_history is voided=true → set bet
--      status='void'.
--
-- READ-ONLY logic; only writes are surgical UPDATEs to public.bets row
-- by id. No schema changes.
--
-- ROLLBACK (paste to restore prior state — DON'T run unless you really
-- want pending bets back):
--   UPDATE public.bets SET status='pending', result_value=NULL, payout=NULL, settled_at=NULL
--    WHERE id IN (
--      '65e658e3-78f1-4c9a-b997-bd174cf415fb',   -- KCR vs NYY
--      'e24f63a1-d8ba-4a80-a46e-25b5236d5963',   -- SFG vs ARI
--      'c89013bf-628b-49c3-ad71-747256426994',   -- TEX vs HOU
--      '79011dc9-cdbd-42ca-8ede-62f46d7cad91',   -- SDP vs PHI
--      '8bb61fc8-ed08-4f10-97df-8ac53c1864c3',   -- MIL vs STL total
--      '20e53d22-7c7b-48fe-b76e-1352f14bf91d',   -- Tre Johnson (voided pick)
--      '770604ba-2a2e-4df5-9940-10167b9bc0cf',   -- Kawhi Leonard
--      'c0d55ac4-b6ce-40eb-a252-253fb674efe8',   -- Kevin Durant
--      '156036f4-9110-4772-ba71-752824eb5b78',   -- Kevin Durant rebounds
--      '4d8f2fae-b2d3-4831-8fb8-c35e940bc526',   -- Kevin Durant points
--      '41a2918b-4544-4f49-afcc-ccaabaa638e5',   -- Alperen Sengun
--      '2683418b-18af-4235-84e0-446819113184'    -- De'Aaron Fox
--    );

DO $$
DECLARE r RECORD;
BEGIN
  -- =====================================================================
  -- A) The 5 May 27 game-level bets — real-result-driven settlement
  -- =====================================================================
  -- Real May 27 2026 final scores (from MLB Stats API):
  --   NYY 7 @ KCR 0  (Yankees AWAY, won by 7)
  --   ARI 3 @ SFG 2  (Diamondbacks AWAY, won by exactly 1)
  --   PHI 3 @ SDP 0  (Phillies AWAY, won by 3)
  --   HOU 4 @ TEX 3  (Astros AWAY, won by 1 → Rangers HOME lost by 1)
  --   STL 1 @ MIL 2  (total runs = 3)

  -- Bet 1: "Kansas City Royals vs New York Yankees (side away)"
  --        spread, line=-1.5, side=away, odds=+105, stake=25
  --        Yankees (away) won by 7 → covered -1.5 → WON
  --        Payout = 25 × (105/100) = 26.25
  UPDATE public.bets SET
    status = 'won',
    result_value = 7,            -- actual margin from bet side (away)
    payout = 26.25,
    settled_at = NOW()
  WHERE id = '65e658e3-78f1-4c9a-b997-bd174cf415fb' AND status = 'pending';

  -- Bet 2: "San Francisco Giants vs Arizona Diamondbacks (side away)"
  --        spread, line=-1, side=away, odds=+111, stake=25
  --        Diamondbacks (away) won by EXACTLY 1 → spread of -1 = PUSH
  --        Payout = 0 (stake returned)
  UPDATE public.bets SET
    status = 'push',
    result_value = 1,
    payout = 0,
    settled_at = NOW()
  WHERE id = 'e24f63a1-d8ba-4a80-a46e-25b5236d5963' AND status = 'pending';

  -- Bet 3: "Texas Rangers vs Houston Astros (side home)"
  --        spread, line=-1.5, side=home, odds=+155, stake=25
  --        Rangers (home) LOST by 1 → did NOT cover -1.5 → LOST
  --        Payout = -25
  UPDATE public.bets SET
    status = 'lost',
    result_value = -1,
    payout = -25,
    settled_at = NOW()
  WHERE id = 'c89013bf-628b-49c3-ad71-747256426994' AND status = 'pending';

  -- Bet 4: "San Diego Padres vs Philadelphia Phillies (side away)"
  --        spread, line=-1, side=away, odds=-115, stake=25
  --        Phillies (away) won by 3 → covered -1 → WON
  --        Payout = 25 × (100/115) ≈ 21.74
  UPDATE public.bets SET
    status = 'won',
    result_value = 3,
    payout = 21.74,
    settled_at = NOW()
  WHERE id = '79011dc9-cdbd-42ca-8ede-62f46d7cad91' AND status = 'pending';

  -- Bet 5: "Milwaukee Brewers vs St. Louis Cardinals (total over)"
  --        game_total, line=5.5, side=over, odds=-130, stake=10
  --        Total runs = 3 → UNDER 5.5 → LOST
  --        Payout = -10
  UPDATE public.bets SET
    status = 'lost',
    result_value = 3,
    payout = -10,
    settled_at = NOW()
  WHERE id = '8bb61fc8-ed08-4f10-97df-8ac53c1864c3' AND status = 'pending';

  -- =====================================================================
  -- B) The 7 April NBA bets — linked pick_history is voided=true → void
  -- =====================================================================
  UPDATE public.bets b SET
    status = 'void',
    payout = 0,
    settled_at = NOW()
  WHERE b.status = 'pending'
    AND b.id IN (
      '20e53d22-7c7b-48fe-b76e-1352f14bf91d',
      '770604ba-2a2e-4df5-9940-10167b9bc0cf',
      'c0d55ac4-b6ce-40eb-a252-253fb674efe8',
      '156036f4-9110-4772-ba71-752824eb5b78',
      '4d8f2fae-b2d3-4831-8fb8-c35e940bc526',
      '41a2918b-4544-4f49-afcc-ccaabaa638e5',
      '2683418b-18af-4235-84e0-446819113184'
    )
    -- Safety: only void if the linked pick_history really is voided
    AND b.pick_id IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM public.pick_history ph
       WHERE ph.id = b.pick_id AND ph.voided = true
    );

  -- =====================================================================
  -- Post-backfill verification
  -- =====================================================================
  RAISE NOTICE '[D-504 BACKFILL] post-state — stuck pending bets (>3 days old):';
  FOR r IN
    SELECT id, status, settled_at, payout, result_value, player_name, prop_type
    FROM public.bets
    WHERE status = 'pending' AND placed_at < NOW() - INTERVAL '3 days'
    ORDER BY placed_at
  LOOP
    RAISE NOTICE '  STILL PENDING: id=% player=% prop=% status=%',
      r.id, r.player_name, r.prop_type, r.status;
  END LOOP;

  RAISE NOTICE '[D-504 BACKFILL] the 5 May 27 bets — settled status + payout:';
  FOR r IN
    SELECT id, status, payout, result_value, player_name
    FROM public.bets
    WHERE id IN (
      '65e658e3-78f1-4c9a-b997-bd174cf415fb',
      'e24f63a1-d8ba-4a80-a46e-25b5236d5963',
      'c89013bf-628b-49c3-ad71-747256426994',
      '79011dc9-cdbd-42ca-8ede-62f46d7cad91',
      '8bb61fc8-ed08-4f10-97df-8ac53c1864c3'
    )
    ORDER BY id
  LOOP
    RAISE NOTICE '  id=% status=% payout=% result=% player=%',
      r.id, r.status, r.payout, r.result_value, r.player_name;
  END LOOP;
END $$;
