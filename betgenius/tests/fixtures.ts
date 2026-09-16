// D-195 — Shared fixtures for scoring.test.ts. Realistic shapes from
// production pick_history. Builders keep tests terse.
import type {
  GameLogEntry,
  OpponentStats,
  ScoringWeights,
  ExtractedProp,
  ScoreOneSideHelpers,
  PlayerResult,
} from "../supabase/functions/_shared/scoring.ts";

export const mkStats = (over: Record<string, number> = {}): Record<string, number> => ({
  MIN: 30, PTS: 22, REB: 6, AST: 5, "3PM": 2, STL: 1, BLK: 1, TO: 2, FGA: 15, FTA: 4,
  ...over,
});

export const mkGame = (over: Partial<GameLogEntry> = {}): GameLogEntry => ({
  date: "2025-04-01",
  opponent: "OPP",
  homeAway: "home",
  stats: mkStats(),
  ...over,
});

// Returns a 10-game log with descending dates, all valid (non-DNP).
export const mkGameLog = (count = 10, statsOverride: (i: number) => Record<string, number> = () => mkStats()): GameLogEntry[] => {
  const out: GameLogEntry[] = [];
  for (let i = 0; i < count; i++) {
    const d = new Date("2025-04-15");
    d.setDate(d.getDate() - i * 2);
    out.push(mkGame({ date: d.toISOString().slice(0, 10), stats: statsOverride(i), homeAway: i % 2 === 0 ? "home" : "away" }));
  }
  return out;
};

export const mkOppStats = (over: Partial<OpponentStats> = {}): OpponentStats => ({
  pointsAllowedPerGame: 115,
  reboundsAllowedPerGame: 43,
  assistsAllowedPerGame: 26,
  oppFieldGoalPct: 47,
  oppThreePointPct: 36,
  pace: 100,
  netRating: 0,
  defensiveRating: 113,
  oppOwnTurnovers: 13,
  oppOwnSteals: 8,
  oppOwnTwoPtFGPct: 56,
  oppOwnThreePtFGPct: 36,
  oppOwnFGPct: 47,
  defensiveRatingVsPosition: { PG: 113, SG: 113, SF: 113, PF: 113, C: 113 },
  defensiveReboundPctVsPosition: { PG: 0.73, SG: 0.73, SF: 0.73, PF: 0.73, C: 0.73 },
  assistPctVsPosition: { PG: 0.62, SG: 0.62, SF: 0.62, PF: 0.62, C: 0.62 },
  ...over,
});

export const mkWeights = (over: Partial<ScoringWeights> = {}): ScoringWeights => ({
  l5: 1.0, l10: 0.75, season: 1.75, floorCeiling: 1.5,
  recentForm: 1.5, homeAway: 1.0, rest: 1.0, b2b: 0.0,
  minutesTrend: 0.5, pace: 0.5, oppDefense: 1.0,
  propType: 0.25, zScore: 0.25, roleChange: 2.0, vigFilter: 0.5,
  usgRate: 1.0, regression: 1.0, marketConf: 2.0, haSplit: 0.0,
  minutesFloor: 2.5, consistency: 1.0, staleData: 1.75, playerInjury: 1.5,
  lowMinRisk: 1.0, blowoutRisk: 1.0, lineMovement: 1.0,
  ...over,
});

export const mkPlayer = (over: Partial<PlayerResult> = {}): PlayerResult => ({
  id: "1234",
  fullName: "Test Player",
  displayName: "T. Player",
  team: "Lakers",
  position: "PG",
  ...over,
});

export const mkProp = (over: Partial<ExtractedProp> = {}): ExtractedProp => ({
  playerName: "T. Player",
  team: "Lakers",
  propType: "points",
  line: 20.5,
  odds: -110,
  bookmaker: "hardrockbet",
  homeTeam: "Lakers",
  awayTeam: "Celtics",
  gameTime: "2025-04-15T19:00:00Z",
  availableBooks: [],
  ...over,
} as ExtractedProp);

export const mkHelpers = (over: Partial<ScoreOneSideHelpers> = {}): ScoreOneSideHelpers => ({
  getTeamInjuries: async () => [],
  getGameLine: () => null,
  getPlayerInjury: () => ({ isInjured: false, status: "active", penalty: 0 }),
  ...over,
});
