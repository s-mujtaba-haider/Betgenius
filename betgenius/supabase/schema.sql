CREATE TABLE players (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  espn_id TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  team TEXT,
  position TEXT,
  sport TEXT NOT NULL,
  season_stats JSONB,
  floor_stats JSONB,
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE games (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  espn_id TEXT UNIQUE NOT NULL,
  sport TEXT NOT NULL,
  home_team TEXT NOT NULL,
  away_team TEXT NOT NULL,
  start_time TIMESTAMPTZ NOT NULL,
  status TEXT DEFAULT 'scheduled',
  home_score INTEGER,
  away_score INTEGER,
  context JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE player_game_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id UUID REFERENCES players(id),
  game_date DATE NOT NULL,
  opponent TEXT,
  home_away TEXT,
  stats JSONB NOT NULL,
  UNIQUE(player_id, game_date)
);

CREATE TABLE props (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id UUID REFERENCES games(id),
  player_id UUID REFERENCES players(id),
  prop_type TEXT NOT NULL,
  line DECIMAL NOT NULL,
  over_odds INTEGER,
  under_odds INTEGER,
  source TEXT DEFAULT 'odds_api',
  fetched_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE picks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  prop_id UUID REFERENCES props(id),
  player_name TEXT NOT NULL,
  prop_type TEXT NOT NULL,
  line DECIMAL NOT NULL,
  pick_side TEXT NOT NULL,
  confidence_score INTEGER NOT NULL,
  factors JSONB,
  ai_analysis TEXT,
  contextual_flags JSONB,
  recommended BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE bets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pick_id UUID REFERENCES picks(id),
  player_name TEXT NOT NULL,
  prop_type TEXT NOT NULL,
  line DECIMAL NOT NULL,
  pick_side TEXT NOT NULL,
  odds INTEGER NOT NULL,
  stake DECIMAL NOT NULL,
  book TEXT DEFAULT 'hard_rock',
  status TEXT DEFAULT 'pending',
  result_value DECIMAL,
  payout DECIMAL,
  placed_at TIMESTAMPTZ DEFAULT NOW(),
  settled_at TIMESTAMPTZ
);

CREATE TABLE cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cache_key TEXT UNIQUE NOT NULL,
  data JSONB NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE results (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pick_id UUID REFERENCES picks(id),
  actual_value DECIMAL NOT NULL,
  hit BOOLEAN NOT NULL,
  settled_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_players_sport ON players(sport);
CREATE INDEX idx_games_start_time ON games(start_time);
CREATE INDEX idx_games_status ON games(status);
CREATE INDEX idx_picks_recommended ON picks(recommended);
CREATE INDEX idx_picks_created ON picks(created_at);
CREATE INDEX idx_bets_status ON bets(status);
CREATE INDEX idx_cache_key ON cache(cache_key);
CREATE INDEX idx_cache_expires ON cache(expires_at);
