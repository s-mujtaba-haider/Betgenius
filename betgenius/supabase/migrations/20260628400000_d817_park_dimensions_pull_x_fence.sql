-- D-817 — Build park dimensions reference table + add HR pull × fence factor
-- column. The directional park amplifier on D-816 pull_rate.
--
-- PART 1: cache_mlb_park_dimensions — static reference of 30 MLB park fence
-- distances (LF/CF/RF in feet). Sourced from publicly-published park
-- dimensions (MLB.com, baseball-reference, ballpark architectural specs).
-- Parks rarely change dimensions; one-time reference, no daily refresh.
--
-- PART 2: pick_history.score_batter_pull_x_park_fence — the handedness-aware
-- pull × fence interaction. Lefty pulls RF, righty pulls LF, switch hitters
-- handled via opposing pitcher handedness.
--
-- PART 3: algorithm_weights.w_mlb_batter_pull_x_park_fence weight column.
--
-- Companion migration (20260628400100) extends upsert_pick_history RPC.

BEGIN;

CREATE TABLE IF NOT EXISTS public.cache_mlb_park_dimensions (
  venue_name           TEXT PRIMARY KEY,
  team_name            TEXT,
  lf_distance          INTEGER NOT NULL,  -- feet to LF foul pole
  lf_gap_distance      INTEGER,           -- feet to LF gap (alley)
  cf_distance          INTEGER NOT NULL,  -- feet to center field
  rf_gap_distance      INTEGER,           -- feet to RF gap
  rf_distance          INTEGER NOT NULL,  -- feet to RF foul pole
  lf_wall_height       INTEGER,           -- LF wall height in feet (Fenway=37)
  cf_wall_height       INTEGER,
  rf_wall_height       INTEGER,
  is_dome              BOOLEAN DEFAULT FALSE,
  notes                TEXT,
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);
COMMENT ON TABLE public.cache_mlb_park_dimensions IS
  'D-817 — static reference of MLB park fence distances by direction. Powers HR pull × pull-side fence factor (lefty pull hitter at short RF = HR setup).';

-- Insert 30 MLB parks (2026 active venues).
-- Sources: MLB.com official park dimensions, baseball-reference.com,
-- ESPN park factors. Distances are at foul-pole (LF, RF) and dead-CF.
-- A LEFTY pulls to RF (his pull-side = RF). A RIGHTY pulls to LF.
INSERT INTO public.cache_mlb_park_dimensions
  (venue_name, team_name, lf_distance, lf_gap_distance, cf_distance, rf_gap_distance, rf_distance,
   lf_wall_height, cf_wall_height, rf_wall_height, is_dome, notes)
VALUES
  ('Chase Field', 'Arizona Diamondbacks', 330, 374, 407, 374, 334, 9, 25, 8, TRUE, 'retractable roof'),
  ('Truist Park', 'Atlanta Braves', 335, 375, 400, 375, 325, 16, 8, 16, FALSE, NULL),
  ('Oriole Park at Camden Yards', 'Baltimore Orioles', 333, 364, 410, 373, 318, 7, 7, 25, FALSE, NULL),
  ('Camden Yards', 'Baltimore Orioles', 333, 364, 410, 373, 318, 7, 7, 25, FALSE, 'alias'),
  ('Fenway Park', 'Boston Red Sox', 310, 379, 390, 380, 302, 37, 17, 5, FALSE, 'Green Monster LF; short RF (Pesky pole)'),
  ('Wrigley Field', 'Chicago Cubs', 355, 368, 400, 368, 353, 11, 11, 11, FALSE, 'ivy walls'),
  ('Rate Field', 'Chicago White Sox', 330, 377, 400, 372, 335, 8, 8, 8, FALSE, NULL),
  ('Guaranteed Rate Field', 'Chicago White Sox', 330, 377, 400, 372, 335, 8, 8, 8, FALSE, 'alias'),
  ('Great American Ball Park', 'Cincinnati Reds', 328, 379, 404, 370, 325, 8, 8, 8, FALSE, NULL),
  ('Progressive Field', 'Cleveland Guardians', 325, 370, 405, 375, 325, 19, 9, 9, FALSE, NULL),
  ('Coors Field', 'Colorado Rockies', 347, 390, 415, 375, 350, 8, 8, 14, FALSE, 'altitude → HR-friendly'),
  ('Comerica Park', 'Detroit Tigers', 345, 370, 420, 365, 330, 8, 8, 8, FALSE, NULL),
  ('Daikin Park', 'Houston Astros', 315, 362, 409, 373, 326, 19, 9, 7, TRUE, 'retractable; Crawford Boxes LF'),
  ('Minute Maid Park', 'Houston Astros', 315, 362, 409, 373, 326, 19, 9, 7, TRUE, 'alias'),
  ('Kauffman Stadium', 'Kansas City Royals', 330, 387, 410, 387, 330, 8, 8, 8, FALSE, NULL),
  ('Angel Stadium', 'Los Angeles Angels', 330, 387, 396, 376, 330, 8, 8, 8, FALSE, NULL),
  ('Dodger Stadium', 'Los Angeles Dodgers', 330, 385, 395, 385, 330, 8, 8, 8, FALSE, NULL),
  ('UNIQLO Field at Dodger Stadium', 'Los Angeles Dodgers', 330, 385, 395, 385, 330, 8, 8, 8, FALSE, 'D-630 renamed venue'),
  ('LoanDepot park', 'Miami Marlins', 344, 386, 407, 392, 335, 11, 11, 11, TRUE, 'retractable'),
  ('American Family Field', 'Milwaukee Brewers', 344, 374, 400, 374, 345, 8, 8, 8, TRUE, 'retractable'),
  ('Target Field', 'Minnesota Twins', 339, 377, 411, 374, 328, 8, 8, 23, FALSE, NULL),
  ('Citi Field', 'New York Mets', 335, 384, 408, 375, 330, 8, 8, 8, FALSE, NULL),
  ('Yankee Stadium', 'New York Yankees', 318, 399, 408, 385, 314, 8, 8, 8, FALSE, 'famous short RF porch (314ft) — lefty HR factory'),
  ('Sutter Health Park', 'Athletics', 325, 388, 403, 388, 325, 12, 8, 12, FALSE, 'D-630 Athletics moved 2025'),
  ('Citizens Bank Park', 'Philadelphia Phillies', 329, 374, 401, 369, 330, 12, 6, 6, FALSE, NULL),
  ('PNC Park', 'Pittsburgh Pirates', 325, 389, 399, 375, 320, 6, 10, 21, FALSE, 'tall RF wall'),
  ('Petco Park', 'San Diego Padres', 336, 390, 396, 391, 322, 8, 8, 8, FALSE, NULL),
  ('Oracle Park', 'San Francisco Giants', 339, 364, 399, 421, 309, 8, 8, 24, FALSE, 'RF short but tall wall + cold marine air'),
  ('T-Mobile Park', 'Seattle Mariners', 331, 378, 405, 381, 326, 8, 8, 8, TRUE, 'retractable'),
  ('Busch Stadium', 'St. Louis Cardinals', 336, 379, 400, 375, 335, 8, 8, 8, FALSE, NULL),
  ('Tropicana Field', 'Tampa Bay Rays', 315, 370, 404, 370, 322, 11, 9, 11, TRUE, 'dome'),
  ('Globe Life Field', 'Texas Rangers', 329, 372, 407, 374, 326, 14, 8, 14, TRUE, 'retractable'),
  ('Rogers Centre', 'Toronto Blue Jays', 328, 375, 400, 375, 328, 10, 10, 10, TRUE, 'retractable'),
  ('Nationals Park', 'Washington Nationals', 336, 377, 402, 370, 335, 8, 14, 14, FALSE, NULL)
ON CONFLICT (venue_name) DO NOTHING;

-- D-817 — pull × pull-side fence interaction column on pick_history
ALTER TABLE public.pick_history
  ADD COLUMN IF NOT EXISTS score_batter_pull_x_park_fence NUMERIC;
COMMENT ON COLUMN public.pick_history.score_batter_pull_x_park_fence IS
  'D-817 — HR-only factor. Combines D-816 pull_air_rate with pull-side fence distance. Lefty pulls RF, righty pulls LF, switch hitters via opposing pitcher hand. Short fence (≤320) + high pull (≥0.22) → strong OVER. Deep fence (≥345) suppresses HR potential of pull-heavy hitters.';

ALTER TABLE public.algorithm_weights
  ADD COLUMN IF NOT EXISTS w_mlb_batter_pull_x_park_fence NUMERIC DEFAULT 1.0;
COMMENT ON COLUMN public.algorithm_weights.w_mlb_batter_pull_x_park_fence IS
  'D-817 — pull × pull-side fence factor weight. Default 1.0 provisional pending D-820 OOS retune. Amplifier on D-816 pullRate.';

COMMIT;
