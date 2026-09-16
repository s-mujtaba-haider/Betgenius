CREATE TABLE IF NOT EXISTS pick_history (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at TIMESTAMPTZ DEFAULT NOW(),

  -- Player & Game Context
  player_name TEXT NOT NULL,
  team TEXT,
  opponent TEXT,
  game_time TEXT,
  is_home BOOLEAN,

  -- Prop Details
  prop_type TEXT NOT NULL,
  line NUMERIC NOT NULL,
  pick_side TEXT NOT NULL,
  odds INTEGER,

  -- Player Stats Snapshot
  season_avg NUMERIC,
  recent_avg NUMERIC,
  floor_val NUMERIC,
  ceiling_val NUMERIC,
  l5_hit_count INTEGER,
  l10_hit_count INTEGER,
  season_hit_pct NUMERIC,

  -- Edge Factors
  is_b2b BOOLEAN DEFAULT FALSE,
  rest_days INTEGER,
  minutes_l5_avg NUMERIC,
  minutes_l10_avg NUMERIC,
  minutes_trend TEXT,
  opp_ppg_allowed NUMERIC,
  opp_rpg_allowed NUMERIC,
  opp_fg_pct_allowed NUMERIC,
  opp_3pt_pct_allowed NUMERIC,
  pace_opp_ppg NUMERIC,

  -- Scoring Factors (what the algorithm calculated)
  score_l5 INTEGER,
  score_l10 INTEGER,
  score_season INTEGER,
  score_floor_ceiling INTEGER,
  score_recent_form INTEGER,
  score_home_away INTEGER,
  score_rest INTEGER,
  score_b2b INTEGER,
  score_minutes_trend INTEGER,
  score_pace INTEGER,
  score_opp_defense INTEGER,
  score_odds_value INTEGER,

  -- Final Output
  confidence INTEGER NOT NULL,
  verdict TEXT,
  ai_analysis TEXT,

  -- Outcome (filled in later by auto-result tracker)
  actual_value NUMERIC,
  hit BOOLEAN,
  resolved_at TIMESTAMPTZ,

  -- Source & Dashboard Info
  source TEXT DEFAULT 'evaluator',
  recommendation_shown BOOLEAN DEFAULT FALSE
);

CREATE INDEX idx_pick_history_created ON pick_history(created_at DESC);
CREATE INDEX idx_pick_history_confidence ON pick_history(confidence DESC);
CREATE INDEX idx_pick_history_hit ON pick_history(hit) WHERE hit IS NOT NULL;
CREATE INDEX idx_pick_history_player ON pick_history(player_name);
CREATE INDEX idx_pick_history_source ON pick_history(source);
CREATE INDEX idx_pick_history_recommendation ON pick_history(recommendation_shown) WHERE recommendation_shown = TRUE;
