-- D-282 SHIP 2 (2026-05-21) — cache_statcast_catcher_framing table.
--
-- Manual weekly CSV upload workflow. CEO downloads Baseball Savant
-- catcher framing leaderboard CSV manually, then runs
-- scripts/upload_catcher_framing.sh to ingest. Replaces automated
-- daily cron approach since Baseball Savant CSV endpoint isn't
-- publicly accessible via URL.
--
-- Rollback: DROP TABLE public.cache_statcast_catcher_framing CASCADE;

CREATE TABLE IF NOT EXISTS public.cache_statcast_catcher_framing (
  player_id            integer NOT NULL,
  snapshot_date        date NOT NULL,
  player_name          text,
  team                 text,
  framing_runs         numeric,
  runs_extra_strikes   numeric,
  strike_rate          numeric,
  shadow_zone_pct      numeric,
  shadow_strike_pct    numeric,
  raw_csv_row          jsonb,
  uploaded_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, snapshot_date)
);

CREATE INDEX IF NOT EXISTS cache_statcast_catcher_framing_player_idx
  ON public.cache_statcast_catcher_framing(player_id);

ALTER TABLE public.cache_statcast_catcher_framing ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cache_statcast_catcher_framing_authed_read
  ON public.cache_statcast_catcher_framing;
CREATE POLICY cache_statcast_catcher_framing_authed_read
  ON public.cache_statcast_catcher_framing
  FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS cache_statcast_catcher_framing_service_all
  ON public.cache_statcast_catcher_framing;
CREATE POLICY cache_statcast_catcher_framing_service_all
  ON public.cache_statcast_catcher_framing
  FOR ALL TO service_role USING (true) WITH CHECK (true);

GRANT SELECT ON public.cache_statcast_catcher_framing TO authenticated;
GRANT ALL ON public.cache_statcast_catcher_framing TO service_role;

COMMENT ON TABLE public.cache_statcast_catcher_framing IS
  'D-282 SHIP 2: manual weekly catcher framing snapshots. CEO '
  'downloads Baseball Savant CSV + runs scripts/upload_catcher_framing.sh. '
  'See docs/loop/playbooks/catcher_framing_weekly.md.';
