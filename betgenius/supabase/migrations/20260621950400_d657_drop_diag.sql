-- D-657 cleanup — drop the throwaway diagnose RPCs.
DROP FUNCTION IF EXISTS public.d657_cron_audit();
DROP FUNCTION IF EXISTS public.d657_jobs();
DROP FUNCTION IF EXISTS public.d657_runs(TEXT, INT);
DROP FUNCTION IF EXISTS public.d657_props_cache_heartbeat();
DROP FUNCTION IF EXISTS public.d657_snapshots_heartbeat();
DROP FUNCTION IF EXISTS public.d657_http_responses(TEXT, INT);
DROP FUNCTION IF EXISTS public.d657_recent_responses(TEXT, INT);
DROP FUNCTION IF EXISTS public.d657_raw_responses(INT);
DROP FUNCTION IF EXISTS public.d657_capture_closing_runs(INT);
