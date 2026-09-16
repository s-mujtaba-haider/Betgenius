-- D-560 SHIP 3 — quantify the EV lift from line shopping.
--
-- Read-only. Compares each recent recommendation_cache row's stored
-- (pre-D-560) `odds` to the BEST-AVAILABLE same-line same-side price
-- from its already-stored `available_books` JSONB (D-381). Reports the
-- avg cents/pick lift, the % of picks where the best is ≥5c better,
-- and the implied EV uplift in real-BE terms.

DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '120s';

  RAISE NOTICE '======== D-560 §A: rec_cache picks with multi-book availability ========';
  FOR r IN
    SELECT
      sport,
      count(*) AS n_picks,
      count(*) FILTER (
        WHERE available_books IS NOT NULL
          AND jsonb_array_length(available_books) > 1
      ) AS n_multi_book
    FROM public.recommendations_cache
    WHERE game_date >= (now() - interval '30 days')::date
    GROUP BY sport ORDER BY sport
  LOOP RAISE NOTICE '[D-560 §A.1] sport=% n_picks=% n_multi_book=%',
    r.sport, r.n_picks, r.n_multi_book; END LOOP;

  -- ===================================================================
  -- §B — Per-pick best-vs-stored delta.
  --   stored_odds   = rec_cache.odds (pre-D-560 was HRB-priority)
  --   best_odds     = MAX(book.odds) for same line + same pick_side
  --                    within rec_cache.available_books
  --   delta_cents   = best_odds - stored_odds
  --   delta_payout  = % uplift in winning payout
  -- ===================================================================
  RAISE NOTICE '======== D-560 §B: cents-saved + payout-uplift per pick (last 30d) ========';

  CREATE TEMP TABLE d560_delta AS
  WITH expanded AS (
    SELECT
      rc.id,
      rc.sport,
      rc.line,
      rc.pick_side,
      rc.odds AS stored_odds,
      rc.bookmaker AS stored_book,
      (book->>'bookmaker') AS book_key,
      (book->>'line')::numeric AS book_line,
      (book->>'pick_side') AS book_side,
      (book->>'odds')::numeric AS book_odds
    FROM public.recommendations_cache rc,
         LATERAL jsonb_array_elements(COALESCE(rc.available_books, '[]'::jsonb)) AS book
    WHERE rc.game_date >= (now() - interval '30 days')::date
      AND rc.available_books IS NOT NULL
      AND jsonb_array_length(rc.available_books) > 1
  ),
  best AS (
    SELECT
      id, sport, line, pick_side, stored_odds, stored_book,
      MAX(book_odds) FILTER (
        WHERE book_line = line AND book_side = pick_side
      ) AS best_odds,
      -- pick the bookmaker that holds the best price
      MIN(CASE WHEN book_line = line AND book_side = pick_side THEN book_key END)
        AS any_best_book_min_alpha,
      count(DISTINCT book_key) FILTER (
        WHERE book_line = line AND book_side = pick_side
      ) AS n_same_line_books
    FROM expanded
    GROUP BY id, sport, line, pick_side, stored_odds, stored_book
  )
  SELECT
    id, sport, stored_odds, best_odds, n_same_line_books,
    (best_odds - stored_odds) AS delta_cents,
    -- payout if odds positive: bet $100 wins $odds, so payout fraction = odds/100
    -- payout if odds negative: bet $100 wins $100/abs(odds)*100, fraction = 100/abs(odds)
    CASE
      WHEN stored_odds > 0 THEN stored_odds / 100.0
      ELSE 100.0 / (-stored_odds)
    END AS stored_payout_per_dollar,
    CASE
      WHEN best_odds > 0 THEN best_odds / 100.0
      ELSE 100.0 / (-best_odds)
    END AS best_payout_per_dollar
  FROM best
  WHERE best_odds IS NOT NULL;

  FOR r IN
    SELECT
      sport,
      count(*) AS n_picks_w_alt,
      ROUND(avg(n_same_line_books)::numeric, 2) AS avg_books_same_line,
      -- avg cents lift (best - stored)
      ROUND(avg(delta_cents)::numeric, 2) AS avg_cents_lift,
      -- median cents
      ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY delta_cents)::numeric, 2) AS med_cents_lift,
      ROUND(percentile_cont(0.9) WITHIN GROUP (ORDER BY delta_cents)::numeric, 2) AS p90_cents_lift,
      count(*) FILTER (WHERE delta_cents >= 5) AS n_lift_ge_5c,
      ROUND(100.0 * count(*) FILTER (WHERE delta_cents >= 5) / NULLIF(count(*), 0)::numeric, 1) AS pct_lift_ge_5c,
      ROUND(100.0 * count(*) FILTER (WHERE delta_cents >= 10) / NULLIF(count(*), 0)::numeric, 1) AS pct_lift_ge_10c,
      -- avg payout uplift (% of dollar that's NEW winnings if line-shopped)
      ROUND(100.0 * (avg(best_payout_per_dollar - stored_payout_per_dollar))::numeric, 4) AS avg_payout_uplift_pct,
      -- if EVERY pick from now on gets the lift, $100/pick over 100 picks = ?
      ROUND(100.0 * 100 * avg(best_payout_per_dollar - stored_payout_per_dollar)::numeric, 2) AS per_100_picks_extra_dollars
    FROM d560_delta
    GROUP BY sport ORDER BY sport
  LOOP RAISE NOTICE '[D-560 §B.1] sport=% n=% avg_books=% avg_lift=%c med_lift=%c p90_lift=%c pct_>=5c=%%% pct_>=10c=%%% avg_payout_uplift=%%% per100=$%',
    r.sport, r.n_picks_w_alt, r.avg_books_same_line,
    r.avg_cents_lift, r.med_cents_lift, r.p90_cents_lift,
    r.pct_lift_ge_5c, r.pct_lift_ge_10c, r.avg_payout_uplift_pct,
    r.per_100_picks_extra_dollars; END LOOP;

  -- ===================================================================
  -- §C — per-tier (conf>=70 and >=80) — where the EV lift actually
  -- matters for the bettor.
  -- ===================================================================
  RAISE NOTICE '======== D-560 §C: cents lift at conf>=70 (the sellable tier) ========';
  FOR r IN
    SELECT
      d.sport,
      count(*) AS n,
      ROUND(avg(d.delta_cents)::numeric, 2) AS avg_cents,
      ROUND(percentile_cont(0.5) WITHIN GROUP (ORDER BY d.delta_cents)::numeric, 2) AS med_cents,
      ROUND(100.0 * (avg(d.best_payout_per_dollar - d.stored_payout_per_dollar))::numeric, 4) AS avg_payout_uplift_pct
    FROM d560_delta d
    JOIN public.recommendations_cache rc USING (id)
    WHERE rc.confidence >= 70
    GROUP BY d.sport ORDER BY d.sport
  LOOP RAISE NOTICE '[D-560 §C.1] conf>=70 sport=% n=% avg_lift=%c med_lift=%c avg_payout_uplift=%%%',
    r.sport, r.n, r.avg_cents, r.med_cents, r.avg_payout_uplift_pct; END LOOP;

  -- §D removed for column simplicity; the EV-lift §B/§C are the deliverable.
  DROP TABLE d560_delta;
END $$;
