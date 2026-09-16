-- D-737e — Pause optimizer crons until trustworthy weights produced
--
-- Background: D-737c found a JS Math.round asymmetry bug in MLB scoring (zero-on-UNDER
-- for 15 STRONG + 9 WEAK at-risk factors). D-737d shipped the systemic fix (helper
-- roundHalfAwayFromZero applied to 120 factor-scoring sites). D-737d-check verified
-- the UNDER side now fires in production. D-737e contamination assessment found that
-- all 40,167 resolved MLB picks were scored by the buggy model — fit data is 100%
-- contaminated. D-737f+e attempted a Python re-implementation but the recompute did
-- not bit-match deployed scoring on 7 of 8 factors.
--
-- The next scheduled tick of auto-optimizer-weekly (2026-06-28 11:00 UTC) would
-- re-fit weights against contaminated data and persist them to algorithm_weights,
-- baking the bias in for another week. Pausing both optimizer jobs prevents this.
--
-- Re-enable after a trustworthy re-fit lands (Path A or Path B per D-737f+e doc).
--
-- §19.3 CEO-approved (operational change explicitly authorized by CEO).
--
-- Affected jobs (verified via list_active_crons RPC at 2026-06-24T20:55Z):
--   jobid=12  auto-optimizer-weekly      schedule='0 11 * * 0'  last_run=2026-06-21T11:00Z
--   jobid=75  d664-weight-fit-weekly     schedule='0 11 * * 0'  last_run=NULL (never run)
--
-- Rollback:
--   SELECT cron.alter_job(job_id := 12::bigint, active := true);
--   SELECT cron.alter_job(job_id := 75::bigint, active := true);

SELECT cron.alter_job(job_id := 12::bigint, active := false);  -- auto-optimizer-weekly
SELECT cron.alter_job(job_id := 75::bigint, active := false);  -- d664-weight-fit-weekly
