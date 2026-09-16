-- D-359 SHIP 1.5 — player metadata warehouse.
--
-- The trace in d359_context_field_map.md revealed the boxscore cache (D-335)
-- already covers gameLog needs, and season stats are derivable via boxscore
-- aggregation. The only NEW warehouse needed for prop historical routers is
-- bats/throws metadata (BatterScoringContext.season.bats,
-- PitcherKScoringContext.season.throws).
--
-- Source: MLB Stats API /v1/people/{id} (FREE, no key required).
-- Cardinality: ~650 unique players touched in the D-358 30-day window;
-- ~1,200 expected over a full season.
--
-- Rollback:
--   DROP TABLE IF EXISTS public.cache_mlb_player_metadata CASCADE;

CREATE TABLE IF NOT EXISTS public.cache_mlb_player_metadata (
  player_id          INTEGER PRIMARY KEY,
  full_name          TEXT,
  primary_position   TEXT,
  bats               TEXT,  -- 'L' / 'R' / 'S' (switch)
  throws             TEXT,  -- 'L' / 'R'
  birth_date         DATE,
  mlb_debut_date     DATE,
  height             TEXT,
  weight             INTEGER,
  fetched_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mlb_player_metadata_bats
  ON public.cache_mlb_player_metadata (bats);
CREATE INDEX IF NOT EXISTS idx_mlb_player_metadata_throws
  ON public.cache_mlb_player_metadata (throws);

ALTER TABLE public.cache_mlb_player_metadata ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS player_metadata_service_all ON public.cache_mlb_player_metadata;
CREATE POLICY player_metadata_service_all ON public.cache_mlb_player_metadata
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS player_metadata_auth_read ON public.cache_mlb_player_metadata;
CREATE POLICY player_metadata_auth_read ON public.cache_mlb_player_metadata
  FOR SELECT TO authenticated USING (true);

COMMENT ON TABLE public.cache_mlb_player_metadata IS
  'D-359 SHIP 1.5: static player metadata (bats/throws/position) from MLB '
  'Stats API /v1/people/{id}. Used by the D-359 batter/pitcher historical '
  'context routers to populate `season.bats` and `season.throws` fields '
  'when reconstructing prop scoring contexts AS-OF a past game date.';
