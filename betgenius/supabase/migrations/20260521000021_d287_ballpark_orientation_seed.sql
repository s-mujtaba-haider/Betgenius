-- D-287 SHIP 1 (2026-05-22) — ballpark orientation reference table.
--
-- Static reference data: each MLB park has a fixed compass bearing
-- from home plate looking out to center field. Combined with today's
-- wind direction (Open-Meteo via fetch-weather), this enables the
-- wind_direction_hr factor:
--   - Wind blowing toward CF (within ±90° of CF bearing) = "out" = HR boost
--   - Wind blowing from CF (180° ± 90°) = "in" = HR suppress
--   - Otherwise = crosswind = neutral
--
-- Domed/retractable-roof parks marked is_dome=true (factor=0 when
-- weather_condition='indoor'). For retractable-roof parks the
-- weather fetcher already sets condition='indoor' when roof closed.
--
-- Seed values are approximate compass bearings (degrees, 0=N) sourced
-- from MLB.com park orientation + ESPN park aerials.
--
-- Rollback:
--   DROP TABLE IF EXISTS public.cache_mlb_ballpark_orientation CASCADE;

CREATE TABLE IF NOT EXISTS public.cache_mlb_ballpark_orientation (
  venue_name TEXT PRIMARY KEY,
  team_abbrev TEXT,
  cf_compass_degrees INTEGER NOT NULL,
  is_dome BOOLEAN NOT NULL DEFAULT FALSE,
  notes TEXT
);

ALTER TABLE public.cache_mlb_ballpark_orientation ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS orientation_service_all ON public.cache_mlb_ballpark_orientation;
CREATE POLICY orientation_service_all ON public.cache_mlb_ballpark_orientation
  FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS orientation_authenticated_read ON public.cache_mlb_ballpark_orientation;
CREATE POLICY orientation_authenticated_read ON public.cache_mlb_ballpark_orientation
  FOR SELECT TO authenticated USING (true);

COMMENT ON TABLE public.cache_mlb_ballpark_orientation IS
  'D-287 SHIP 1: static MLB ballpark compass orientation (CF bearing in '
  'degrees from home plate). Used by wind_direction_hr factor.';

-- Seed all 30 parks. Match venue_name format used in cache_mlb_game_scoreboard.
INSERT INTO public.cache_mlb_ballpark_orientation (venue_name, team_abbrev, cf_compass_degrees, is_dome, notes) VALUES
  ('Yankee Stadium',          'NYY',  30, FALSE, 'CF NNE; short porch RF'),
  ('Fenway Park',             'BOS',  53, FALSE, 'CF NE; Green Monster LF'),
  ('Wrigley Field',           'CHC',  35, FALSE, 'CF NE; famous wind-driven park'),
  ('Citi Field',              'NYM',  45, FALSE, 'CF NE'),
  ('Citizens Bank Park',      'PHI',  35, FALSE, 'CF NE'),
  ('Truist Park',             'ATL',  60, FALSE, 'CF NE'),
  ('Nationals Park',          'WSH',   0, FALSE, 'CF N'),
  ('Camden Yards',            'BAL',  35, FALSE, 'CF NE; B&O Warehouse RF'),
  ('Tropicana Field',         'TB',   70, TRUE,  'Dome'),
  ('Rogers Centre',           'TOR',   0, TRUE,  'Retractable roof'),
  ('Comerica Park',           'DET',  30, FALSE, 'CF NE'),
  ('Progressive Field',       'CLE',  65, FALSE, 'CF ENE'),
  ('Kauffman Stadium',        'KC',   55, FALSE, 'CF NE'),
  ('Guaranteed Rate Field',   'CWS',  70, FALSE, 'CF E (now Rate Field)'),
  ('Target Field',            'MIN',  60, FALSE, 'CF NE'),
  ('American Family Field',   'MIL',  60, TRUE,  'Retractable roof'),
  ('Busch Stadium',           'STL',  60, FALSE, 'CF NE'),
  ('Great American Ball Park','CIN',  60, FALSE, 'CF NE'),
  ('PNC Park',                'PIT',  55, FALSE, 'CF NE; Roberto Clemente Bridge'),
  ('Globe Life Field',        'TEX',   0, TRUE,  'Retractable roof'),
  ('Minute Maid Park',        'HOU',  50, TRUE,  'Retractable roof'),
  ('Chase Field',             'ARI',  55, TRUE,  'Retractable roof'),
  ('Coors Field',             'COL',   4, FALSE, 'CF N; mile-high air'),
  ('Dodger Stadium',          'LAD',  23, FALSE, 'CF NNE'),
  ('Angel Stadium',           'LAA',  60, FALSE, 'CF NE'),
  ('Petco Park',              'SD',   10, FALSE, 'CF N'),
  ('Oracle Park',             'SF',   87, FALSE, 'CF E; McCovey Cove RF'),
  ('Oakland Coliseum',        'OAK',  70, FALSE, 'CF E (Athletics legacy venue)'),
  ('T-Mobile Park',           'SEA',  70, TRUE,  'Retractable roof'),
  ('loanDepot park',          'MIA',  50, TRUE,  'Retractable roof')
ON CONFLICT (venue_name) DO UPDATE SET
  team_abbrev = EXCLUDED.team_abbrev,
  cf_compass_degrees = EXCLUDED.cf_compass_degrees,
  is_dome = EXCLUDED.is_dome,
  notes = EXCLUDED.notes;
