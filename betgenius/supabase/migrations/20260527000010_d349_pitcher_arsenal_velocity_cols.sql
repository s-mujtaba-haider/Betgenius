-- D-349 — extend cache_statcast_pitcher_arsenal with per-pitch-type avg velocity columns.
--
-- Existing D-286 table has pitch MIX % (ff_pct, sl_pct, etc.). D-349 adds the
-- corresponding avg-velocity columns from Baseball Savant /leaderboard/pitch-arsenals
-- endpoint (CSV columns ff_avg_speed, si_avg_speed, sl_avg_speed, ch_avg_speed,
-- cu_avg_speed, fc_avg_speed, fs_avg_speed, st_avg_speed, sv_avg_speed, kn_avg_speed).
--
-- ETL extension lives in fetch-baseball-savant-weekly (D-282/D-286).
--
-- Rollback: ALTER TABLE cache_statcast_pitcher_arsenal DROP COLUMN ff_avg_speed (per col).

ALTER TABLE public.cache_statcast_pitcher_arsenal
  ADD COLUMN IF NOT EXISTS ff_avg_speed NUMERIC(4,1),
  ADD COLUMN IF NOT EXISTS si_avg_speed NUMERIC(4,1),
  ADD COLUMN IF NOT EXISTS sl_avg_speed NUMERIC(4,1),
  ADD COLUMN IF NOT EXISTS ch_avg_speed NUMERIC(4,1),
  ADD COLUMN IF NOT EXISTS cu_avg_speed NUMERIC(4,1),
  ADD COLUMN IF NOT EXISTS fc_avg_speed NUMERIC(4,1),
  ADD COLUMN IF NOT EXISTS fs_avg_speed NUMERIC(4,1),
  ADD COLUMN IF NOT EXISTS st_avg_speed NUMERIC(4,1),
  ADD COLUMN IF NOT EXISTS sv_avg_speed NUMERIC(4,1),
  ADD COLUMN IF NOT EXISTS kn_avg_speed NUMERIC(4,1);
