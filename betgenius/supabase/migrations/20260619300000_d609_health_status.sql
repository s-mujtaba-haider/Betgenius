-- D-609 SHIP 1a — reuse existing D-459 health_status table; add a view
-- exposing the LATEST row per check_name so the Admin banner reads
-- in O(N_checks) instead of scanning all history.
--
-- D-459 schema (created 2026-06-06):
--   id, created_at, check_name, status (ok|warn|fail|info), detail, metadata
--
-- D-609 reuses that schema. Status mapping in the edge function + banner:
--   ok   ↔ green
--   fail ↔ red
--   info ↔ unknown
--   warn ↔ amber  (not used by D-609 checks today, but supported)
--
-- D-609 check names are prefixed `d609_*` so they coexist with D-459's
-- `sonnet_*` / `mlb_*` checks in the same table.

CREATE OR REPLACE VIEW public.health_status_current AS
SELECT DISTINCT ON (check_name)
  check_name, status, detail, metadata, created_at AS run_at
FROM public.health_status
ORDER BY check_name, created_at DESC;

GRANT SELECT ON public.health_status_current TO anon, authenticated;

COMMENT ON VIEW public.health_status_current IS
  'D-609 (2026-06-19). Latest row per check_name from health_status, for the '
  'Admin red/green banner. Surfaces both D-459 (sonnet/cron) and D-609 '
  '(page-fetch / NaN / resolution / coverage / flatline) check rows.';
