-- D-506 SHIP 3 — superseded by 20260610000050_d506_ship3_backfill_cron.sql.
-- Original DO-loop hit a 2-minute statement_timeout on the migration
-- connection role. Switched to an every-minute cron approach.
-- No-op intentionally.
SELECT 1;
