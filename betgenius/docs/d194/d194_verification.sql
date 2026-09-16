-- D-194 — cache_game_scoreboard backfill verification.
--
-- Run AFTER the orchestration script completes. Confirms:
--   1) row count pre/post (sanity)
--   2) per-date coverage of the historical cohort
--   3) sample date matches expected game count (e.g., 2024-11-15 → 11 games)
--   4) orphan-pick scan: every backfill-historical pick has a scoreboard row
--      for its (game_date, team)
--   5) post-rescore opp_defense signal lift
--
-- Required role: service_role (these tables have RLS).

-- =============================================================================
-- §1.12 Query 1 — pre/post row count
-- =============================================================================
SELECT
  COUNT(*) AS total_rows,
  COUNT(*) FILTER (WHERE game_date BETWEEN '2023-10-24' AND '2024-04-14') AS d191p3_rows,
  COUNT(*) FILTER (WHERE game_date BETWEEN '2024-10-22' AND '2024-12-31') AS d185_rows,
  COUNT(*) FILTER (WHERE game_date BETWEEN '2025-01-01' AND '2025-04-30') AS d191p2_rows,
  COUNT(*) FILTER (WHERE game_date >= '2025-05-01') AS organic_rows,
  MIN(game_date) AS earliest_date,
  MAX(game_date) AS latest_date
FROM public.cache_game_scoreboard
WHERE sport = 'nba';

-- Expected post-D-194: total_rows >> 0; d191p3_rows + d185_rows + d191p2_rows
-- all > 0 with values matching ~10-15 games per played date × ~6 months of
-- season ≈ 1000+ rows for d185 alone, 1000+ for d191p2, 1500+ for d191p3
-- (full season).

-- =============================================================================
-- §1.12 Query 2 — per-date coverage of dates with pick_history rows
-- =============================================================================
SELECT
  ph.game_date,
  COUNT(DISTINCT ph.team) AS distinct_teams_in_picks,
  COUNT(DISTINCT cgs.game_id) AS games_in_scoreboard,
  CASE
    WHEN COUNT(DISTINCT cgs.game_id) = 0 THEN '✗ MISSING'
    WHEN COUNT(DISTINCT cgs.game_id) < COUNT(DISTINCT ph.team) / 2 THEN '⚠ partial'
    ELSE '✓ ok'
  END AS coverage_status
FROM public.pick_history ph
LEFT JOIN public.cache_game_scoreboard cgs
  ON cgs.game_date = ph.game_date AND cgs.sport = 'nba'
WHERE ph.source = 'backfill-historical'
GROUP BY ph.game_date
ORDER BY ph.game_date;

-- Expected post-D-194: every row '✓ ok'. Any '✗ MISSING' is a backfill gap;
-- any '⚠ partial' means BDL returned fewer games than picks reference (worth
-- investigation but not necessarily a bug — some picks may be from games not
-- in BDL's set, e.g., All-Star game).

-- =============================================================================
-- §1.12 Query 3 — sample date verification (2024-11-15 had 11 NBA games)
-- =============================================================================
SELECT
  game_id, game_date, home_team, away_team, status, home_score, away_score
FROM public.cache_game_scoreboard
WHERE game_date = '2024-11-15' AND sport = 'nba'
ORDER BY game_id;

-- Expected post-D-194: 11 rows (NBA schedule had 11 games on 2024-11-15);
-- all rows have status='final' with non-null scores; all home_team/away_team
-- match BDL full_name format (verify a few against ESPN displayName).

-- =============================================================================
-- §1.12 Query 4 — orphan-pick scan
-- =============================================================================
WITH backfill_picks AS (
  SELECT id, player_name, prop_type, game_date, team
  FROM public.pick_history
  WHERE source = 'backfill-historical'
),
scoreboard_team_dates AS (
  SELECT DISTINCT game_date, home_team AS team FROM public.cache_game_scoreboard WHERE sport = 'nba'
  UNION
  SELECT DISTINCT game_date, away_team AS team FROM public.cache_game_scoreboard WHERE sport = 'nba'
)
SELECT
  bp.game_date,
  bp.team,
  COUNT(*) AS orphan_picks
FROM backfill_picks bp
LEFT JOIN scoreboard_team_dates std
  ON std.game_date = bp.game_date AND std.team = bp.team
WHERE std.team IS NULL
GROUP BY bp.game_date, bp.team
ORDER BY bp.game_date, bp.team;

-- Expected post-D-194: 0 rows. Any row indicates a pick whose team+date
-- doesn't resolve to a scoreboard row — almost certainly a team-name format
-- mismatch (e.g. "LA Clippers" in picks vs "Los Angeles Clippers" in BDL,
-- or vice versa). If non-empty, ESCALATE per task spec escalation trigger
-- "Team abbreviation mismatch detected".

-- =============================================================================
-- §1.12 Query 5 — pre-rescore opp_defense signal state (run BEFORE rescore)
-- =============================================================================
SELECT
  COUNT(*) AS total_backfill_picks,
  COUNT(*) FILTER (WHERE score_opp_defense = 0) AS opp_defense_zero,
  COUNT(*) FILTER (WHERE score_opp_defense <> 0) AS opp_defense_nonzero,
  COUNT(*) FILTER (WHERE confidence >= 70) AS at_70plus_tier
FROM public.pick_history
WHERE source = 'backfill-historical';

-- Expected pre-rescore: opp_defense_nonzero very small (D-185 surfaced
-- 0% at 70+ tier with null-helpers). opp_defense_zero ≈ total.

-- =============================================================================
-- §1.12 Query 6 — post-rescore opp_defense signal state
-- (run AFTER invoking rescore-backfill-picks against same cohort)
-- =============================================================================
-- Re-run Query 5 after rescore. Expected delta:
--   • opp_defense_nonzero increases meaningfully (every pick that maps to a
--     team with cache_team_advanced_stats_by_position row + scoreboard row
--     now gets a real opp_defense contribution to confidence)
--   • at_70plus_tier increases by some number — this is the headline metric
--     for D-194 success (closes the opp_defense structural blocker)

-- =============================================================================
-- Bonus — team-name format reconciliation probe
-- =============================================================================
SELECT
  ph.team AS picks_team_name,
  COUNT(*) AS pick_count,
  EXISTS (
    SELECT 1 FROM public.cache_game_scoreboard cgs
    WHERE cgs.sport='nba' AND (cgs.home_team = ph.team OR cgs.away_team = ph.team)
  ) AS scoreboard_has_match
FROM public.pick_history ph
WHERE ph.source = 'backfill-historical'
GROUP BY ph.team
ORDER BY scoreboard_has_match ASC, pick_count DESC;

-- Expected: scoreboard_has_match=true for every team. Any false-team is the
-- name-format mismatch class; document in D-194 escalation if found.
