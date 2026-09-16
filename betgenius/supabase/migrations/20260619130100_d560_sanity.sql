-- D-560 sanity — pick 3 recent rec_cache rows with the BIGGEST cents lift
-- and show: stored_odds + book vs best_odds + book, side-by-side. Hand-verify.
DO $$
DECLARE r RECORD;
BEGIN
  SET LOCAL statement_timeout TO '60s';
  RAISE NOTICE '======== D-560 sanity: top 3 cents-lift picks (full available_books dump) ========';
  FOR r IN
    WITH expanded AS (
      SELECT
        rc.id, rc.sport, rc.player_name, rc.prop_type, rc.line, rc.pick_side,
        rc.odds AS stored_odds, rc.bookmaker AS stored_book, rc.confidence,
        (book->>'bookmaker') AS book_key,
        (book->>'odds')::numeric AS book_odds
      FROM public.recommendations_cache rc,
           LATERAL jsonb_array_elements(COALESCE(rc.available_books, '[]'::jsonb)) AS book
      WHERE rc.game_date >= (now() - interval '30 days')::date
        AND rc.available_books IS NOT NULL
        AND jsonb_array_length(rc.available_books) > 1
        AND (book->>'line')::numeric = rc.line
        AND (book->>'pick_side') = rc.pick_side
    ),
    ranked AS (
      SELECT
        id, sport, player_name, prop_type, line, pick_side,
        stored_odds, stored_book, confidence,
        MAX(book_odds) AS best_odds,
        (ARRAY_AGG(book_key ORDER BY book_odds DESC))[1] AS best_book,
        MAX(book_odds) - stored_odds AS delta_cents
      FROM expanded
      GROUP BY id, sport, player_name, prop_type, line, pick_side,
               stored_odds, stored_book, confidence
    )
    SELECT * FROM ranked
    WHERE delta_cents > 0
    ORDER BY delta_cents DESC LIMIT 5
  LOOP RAISE NOTICE '[D-560 sanity] sport=% player=% prop=% line=% side=% conf=% | STORED: % @ % | BEST: % @ % | LIFT: %c',
    r.sport, r.player_name, r.prop_type, r.line, r.pick_side, r.confidence,
    r.stored_odds, r.stored_book, r.best_odds, r.best_book, r.delta_cents; END LOOP;
END $$;
