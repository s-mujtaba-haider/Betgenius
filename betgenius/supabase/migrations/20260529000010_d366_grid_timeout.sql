-- D-366 SHIP 3 — extend statement_timeout for d366_search_weight_grid.
-- The CROSS JOIN of |grid|=9 × 13,671 MV rows with COALESCE/JSON math exceeds the
-- default PostgREST 8s timeout. 60s is safe — full optimizer needs ~99 calls
-- (33 weights × 3 passes) and each call at ~1-2s stays under the edge function
-- 150s budget.
--
-- Rollback: ALTER FUNCTION ... RESET statement_timeout;

ALTER FUNCTION public.d366_search_weight_grid(text, jsonb, jsonb, numeric[], int)
  SET statement_timeout = '60s';
