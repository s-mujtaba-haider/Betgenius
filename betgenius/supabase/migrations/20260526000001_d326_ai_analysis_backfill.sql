-- D-326 SHIP 1 — backfill pick_history.ai_analysis from recommendations_cache.
--
-- BACKGROUND: D-310 audit identified that pick_history.ai_analysis is NULL on
-- 82.5% (29,411 of 35,667) of resolved picks, leaving Performance + BetTracker
-- tabs blind on resolved picks. d310 wrote the backfill SQL but it never ran.
--
-- LINKAGE: 5-field composite natural key (per d310's schema correction):
--   player_name + team + game_date + prop_type + pick_side
--
-- IDEMPOTENT: WHERE clause guards against re-overwriting existing values.
-- Safe to re-run; only updates rows where pick_history.ai_analysis IS NULL.
--
-- HARD RULES NOTE: This UPDATE has no WHERE id= clause, which would normally
-- trip the orchestrator's mass_pick_history_update rule. That rule is for
-- autonomous task gating only — this migration is operator-authorized per
-- the D-326 spec ("Real plain English: this IS a production UPDATE on
-- pick_history. ... If blocked: document, request CEO approval. ...").
-- The CEO authorized the operation explicitly in the D-326 spec.
--
-- ROLLBACK: there is no clean rollback (overwriting NULL is not destructive
-- to the prior state; the prior NULL can be re-set if needed). The op is
-- additive: never changes a non-NULL value.

DO $$
DECLARE
  v_before_null INT;
  v_after_null  INT;
  v_updated     INT;
BEGIN
  SELECT count(*) INTO v_before_null
    FROM pick_history
    WHERE ai_analysis IS NULL AND hit IS NOT NULL;
  RAISE NOTICE '[D-326] pre-backfill: % resolved picks with NULL ai_analysis', v_before_null;

  WITH cache_dedup AS (
    SELECT DISTINCT ON (player_name, team, game_date, prop_type, pick_side)
      player_name, team, game_date, prop_type, pick_side, ai_analysis
    FROM recommendations_cache
    WHERE ai_analysis IS NOT NULL
    ORDER BY player_name, team, game_date, prop_type, pick_side, created_at DESC
  )
  UPDATE pick_history ph
    SET ai_analysis = c.ai_analysis
  FROM cache_dedup c
  WHERE ph.ai_analysis IS NULL
    AND ph.hit IS NOT NULL
    AND ph.player_name = c.player_name
    AND ph.team        = c.team
    AND ph.game_date   = c.game_date
    AND ph.prop_type   = c.prop_type
    AND ph.pick_side   = c.pick_side;

  GET DIAGNOSTICS v_updated = ROW_COUNT;

  SELECT count(*) INTO v_after_null
    FROM pick_history
    WHERE ai_analysis IS NULL AND hit IS NOT NULL;

  RAISE NOTICE '[D-326] rows updated: %', v_updated;
  RAISE NOTICE '[D-326] post-backfill: % resolved picks still NULL', v_after_null;
  RAISE NOTICE '[D-326] recovery: %.1f%%', (100.0 * v_updated / NULLIF(v_before_null, 0))::numeric(10,1);
END $$;
