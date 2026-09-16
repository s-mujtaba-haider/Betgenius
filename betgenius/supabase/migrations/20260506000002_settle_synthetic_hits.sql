-- settle_synthetic_hits — Phase 4 backfill orchestrator settlement (May 6, 2026).
--
-- Settles hit/miss for synthetic backfill rows by JOINing against original
-- pre-megadeploy pick_history rows (is_synthetic=false) that have already
-- been resolved by resolve-picks. Saves ~6,500 ESPN box-score re-fetches
-- per the Option C scoping (/tmp/backfill_scope_may6.md Task 2).
--
-- Settlement logic per pick:
--   - Match synthetic row to original by (player_name, prop_type, line, game_date)
--   - Original must have non-null actual_value (i.e., resolve-picks already settled)
--   - hit = (pick_side == 'over' AND actual_value > line) OR
--           (pick_side == 'under' AND actual_value < line)
--   - actual_value copied from original
--   - resolved_at = NOW()
--
-- Returns count of synthetic rows updated.
--
-- Idempotent: re-running on the same backfill_run_id is safe — rows already
-- settled (resolved_at IS NOT NULL) are skipped via WHERE clause.
--
-- Security: SECURITY DEFINER so callers via PostgREST RPC (anon or
-- service-role) get consistent privileges. The function only modifies
-- is_synthetic=true rows, so it can never affect production picks.

CREATE OR REPLACE FUNCTION public.settle_synthetic_hits(run_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  updated_count INTEGER;
BEGIN
  WITH settled AS (
    UPDATE public.pick_history syn
    SET
      actual_value = orig.actual_value,
      hit = CASE
        WHEN syn.pick_side = 'over' THEN orig.actual_value > syn.line
        WHEN syn.pick_side = 'under' THEN orig.actual_value < syn.line
        ELSE NULL
      END,
      resolved_at = NOW()
    FROM public.pick_history orig
    WHERE syn.is_synthetic = true
      AND syn.backfill_run_id = run_id
      AND syn.resolved_at IS NULL
      AND orig.is_synthetic = false
      AND orig.player_name = syn.player_name
      AND orig.prop_type = syn.prop_type
      AND orig.line = syn.line
      AND orig.game_date = syn.game_date
      AND orig.actual_value IS NOT NULL
    RETURNING syn.id
  )
  SELECT COUNT(*) INTO updated_count FROM settled;

  RETURN updated_count;
END;
$$;

COMMENT ON FUNCTION public.settle_synthetic_hits(UUID) IS
  'Settles hit/miss on synthetic backfill rows via JOIN against original pick_history.actual_value. Only operates on is_synthetic=true rows. Returns count of rows updated.';

-- Allow the service-role + authenticated caller to invoke. Anon callers
-- cannot read is_synthetic rows by default (RLS), so RPC is safe to expose.
GRANT EXECUTE ON FUNCTION public.settle_synthetic_hits(UUID) TO authenticated, service_role;
