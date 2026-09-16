-- D-638b cleanup — drop the throwaway audit RPCs.
-- ────────────────────────────────────────────────────────────────────
-- The 4 d638_q*() functions were one-off audit helpers used to
-- materialize the Q1-Q4 result tables documented in
-- docs/loop/architecture/d638b_six_market_audit_results.md.
-- They are not part of the production data path; dropping them keeps
-- the public namespace clean.
--
-- Rollback: re-apply 20260620931000_d638b_audit_rpcs_v3.sql.

DROP FUNCTION IF EXISTS public.d638_q1();
DROP FUNCTION IF EXISTS public.d638_q2();
DROP FUNCTION IF EXISTS public.d638_q3();
DROP FUNCTION IF EXISTS public.d638_q4();
