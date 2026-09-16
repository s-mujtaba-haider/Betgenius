-- D-282 SHIP 2 (2026-05-21) — unified Baseball Savant framing cache.
--
-- One table, 4 variants distinguished by `entity_type`:
--   Cat — catcher-keyed (default leaderboard)
--   Tm  — team-keyed aggregate
--   Pit — pitcher-keyed (how often the pitcher benefited from framing)
--   Bat — batter-keyed (how often the batter lost to framing)
--
-- Schema mirrors Baseball Savant `/leaderboard/catcher-framing` CSV
-- columns: id, name, pitches, rv_tot, pct_tot + per-zone rv/pct
-- pairs (zones 11-14 + 16-19; zone 15 is the heart of the plate,
-- not a framing call).
--
-- Source URLs (verified D-282 SHIP 2 probe):
--   https://baseballsavant.mlb.com/leaderboard/catcher-framing
--     ?year=YYYY&type={Cat|Tm|Pit|Bat}&csv=true
--
-- Rollback:
--   DROP TABLE public.cache_statcast_framing CASCADE;

CREATE TABLE IF NOT EXISTS public.cache_statcast_framing (
  entity_id      integer NOT NULL,
  entity_type    text NOT NULL CHECK (entity_type IN ('Cat', 'Tm', 'Pit', 'Bat')),
  snapshot_date  date NOT NULL,
  entity_name    text,
  pitches        integer,
  rv_tot         numeric,
  pct_tot        numeric,
  rv_11          numeric, pct_11 numeric,
  rv_12          numeric, pct_12 numeric,
  rv_13          numeric, pct_13 numeric,
  rv_14          numeric, pct_14 numeric,
  rv_16          numeric, pct_16 numeric,
  rv_17          numeric, pct_17 numeric,
  rv_18          numeric, pct_18 numeric,
  rv_19          numeric, pct_19 numeric,
  fetched_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (entity_id, entity_type, snapshot_date)
);

CREATE INDEX IF NOT EXISTS cache_statcast_framing_type_idx
  ON public.cache_statcast_framing(entity_type, snapshot_date DESC);

CREATE INDEX IF NOT EXISTS cache_statcast_framing_entity_idx
  ON public.cache_statcast_framing(entity_id);

ALTER TABLE public.cache_statcast_framing ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS cache_statcast_framing_authed_read
  ON public.cache_statcast_framing;
CREATE POLICY cache_statcast_framing_authed_read
  ON public.cache_statcast_framing FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS cache_statcast_framing_service_all
  ON public.cache_statcast_framing;
CREATE POLICY cache_statcast_framing_service_all
  ON public.cache_statcast_framing FOR ALL TO service_role USING (true) WITH CHECK (true);

GRANT SELECT ON public.cache_statcast_framing TO authenticated;
GRANT ALL ON public.cache_statcast_framing TO service_role;

COMMENT ON TABLE public.cache_statcast_framing IS
  'D-282 SHIP 2: unified Baseball Savant framing leaderboard cache. '
  'Populated weekly by fetch-baseball-savant-weekly cron from 4 variants '
  '(Cat/Tm/Pit/Bat). Replaces D-282 SHIP 2 v1 (manual upload). Powers '
  'the catcher_framing_factor in scorePitcherKMarket.';

-- Deprecate the per-variant catcher framing table from earlier D-282
-- ship (kept in DDL for archive completeness; not used after this).
COMMENT ON TABLE public.cache_statcast_catcher_framing IS
  'D-282 SHIP 2 v1 (DEPRECATED 2026-05-21): superseded by unified '
  'cache_statcast_framing table with entity_type discriminator. Manual '
  'CSV upload workflow no longer needed — Baseball Savant /leaderboard/'
  'catcher-framing?type=X&csv=true endpoints work programmatically.';
