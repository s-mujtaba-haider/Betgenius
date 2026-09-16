-- D-562 verify — confirm column exists + show current backfill state.
DO $$
DECLARE r RECORD;
BEGIN
  RAISE NOTICE '======== D-562 verify §A: schema check ========';
  FOR r IN
    SELECT column_name, data_type, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='cache_team_batting_stats'
      AND column_name IN ('runs_per_game','runs_allowed_per_game','games_played')
    ORDER BY column_name
  LOOP RAISE NOTICE '[D-562 §A.1] col=% type=% nullable=% default=%',
    r.column_name, r.data_type, r.is_nullable, r.column_default; END LOOP;

  RAISE NOTICE '======== D-562 verify §B: cache_team_batting_stats current rows ========';
  FOR r IN
    SELECT
      count(*) AS total_rows,
      count(*) FILTER (WHERE runs_allowed_per_game IS NOT NULL) AS w_ra,
      ROUND(avg(runs_per_game)::numeric, 2) AS avg_rpg,
      ROUND(avg(runs_allowed_per_game)::numeric, 2) AS avg_rapg,
      max(snapshot_date) AS most_recent_snapshot
    FROM public.cache_team_batting_stats
    WHERE sport='mlb' AND snapshot_date >= (now() - interval '7 days')::date
  LOOP RAISE NOTICE '[D-562 §B.1] total=% w_ra=% avg_rpg=% avg_rapg=% latest=%',
    r.total_rows, r.w_ra, r.avg_rpg, r.avg_rapg, r.most_recent_snapshot; END LOOP;

  RAISE NOTICE '======== D-562 verify §C: count of historical home_rapg=4.5 in breakdown (the bug signature) ========';
  FOR r IN
    SELECT
      count(*) AS total,
      count(*) FILTER (WHERE (breakdown->>'home_rapg')::numeric = 4.5) AS n_constant_45,
      ROUND(100.0 * count(*) FILTER (WHERE (breakdown->>'home_rapg')::numeric = 4.5)
        / NULLIF(count(*),0)::numeric, 1) AS pct_constant
    FROM public.pick_history
    WHERE sport='mlb' AND mlb_market_type='game_total'
      AND breakdown ? 'home_rapg' AND game_date >= (now() - interval '30 days')::date
  LOOP RAISE NOTICE '[D-562 §C.1] last 30d game_total picks: n=% n_with_home_rapg=4.5: % pct=%',
    r.total, r.n_constant_45, r.pct_constant; END LOOP;
END $$;
