-- D-639 cleanup — drop the throwaway audit RPC.
-- Rollback: re-apply 20260620940000_d639_audit_rpcs.sql.

DROP FUNCTION IF EXISTS public.d639_q2_strings();
