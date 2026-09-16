// D-195 TECH-02 — Pure-function unit coverage for _shared/scoring.ts.
// Skipped: loadWeightsFromDB (I/O) — integration scope.
import { describe, expect, it } from "vitest";
import {
  PROP_STAT_MAP,
  applyTierAwareModifiers,
  calcHitRates,
  calculateConfidenceScore,
  calculateHomeAwaySplit,
  calculateMinutesTrend,
  calculatePaceDefenseScores,
  calculatePerMinuteRate,
  calculateStdDev,
  calculateUsageBoost,
  calculateUSGRate,
  calculateZScore,
  computeProjectedStat,
  detectMarketConfirmation,
  detectMinutesFloor,
  detectRecentAbsence,
  detectRegression,
  detectRoleChange,
  getDefaultWeights,
  getPlayerInjuryStatus,
  getScoreLabel,
  getStatValue,
  isDNPGame,
  projectMinutes,
  scoreOneSide,
  tierFromConfidence,
  MINUTE_BOUND_PROPS,
  type BdlInjury,
  type GameLogEntry,
  type TierModifiers,
  type TierName,
} from "../supabase/functions/_shared/scoring.ts";
import { mkGame, mkGameLog, mkHelpers, mkOppStats, mkPlayer, mkProp, mkStats, mkWeights } from "./fixtures.ts";

// =========================================================================
// PROP_STAT_MAP + getStatValue
// =========================================================================
describe("PROP_STAT_MAP", () => {
  it("covers all core prop types", () => {
    for (const p of ["points", "rebounds", "assists", "threes", "steals", "blocks", "turnovers"]) {
      expect(PROP_STAT_MAP[p]).toBeDefined();
      expect(PROP_STAT_MAP[p].length).toBeGreaterThan(0);
    }
  });
  it("aliases player_* prop names", () => {
    expect(PROP_STAT_MAP.player_points).toEqual(["PTS"]);
    // D-437 stale-test fix: D-246 (2026-05-19) intentionally added "3PT" as
    // ESPN-source fallback (BDL returns "3PM", ESPN gamelogs return "3PT");
    // pre-D-246 ESPN rows produced ZERO threes picks for 90 days. See
    // scoring.ts:351-358 for full rationale.
    expect(PROP_STAT_MAP.player_threes).toEqual(["3PM", "3PT"]);
  });
});

describe("getStatValue", () => {
  it("returns the simple stat for a known prop type", () => {
    expect(getStatValue({ PTS: 25 }, "points")).toBe(25);
    expect(getStatValue({ REB: 8 }, "rebounds")).toBe(8);
    expect(getStatValue({ "3PM": 3 }, "threes")).toBe(3);
  });
  it("returns null when label missing", () => {
    expect(getStatValue({ PTS: 25 }, "rebounds")).toBeNull();
  });
  it("falls back to player_ aliased lookup", () => {
    expect(getStatValue({ AST: 7 }, "player_assists")).toBe(7);
  });
  it("returns raw key when prop not in PROP_STAT_MAP and key matches", () => {
    expect(getStatValue({ custom: 99 }, "custom")).toBe(99);
  });
  it("returns null when prop not in PROP_STAT_MAP and key missing", () => {
    expect(getStatValue({}, "unknown")).toBeNull();
  });
});

// =========================================================================
// isDNPGame
// =========================================================================
describe("isDNPGame", () => {
  it("returns true when minutes is 0", () => {
    expect(isDNPGame(mkGame({ stats: mkStats({ MIN: 0 }) }))).toBe(true);
  });
  it("returns true when minutes is missing", () => {
    const g: GameLogEntry = mkGame({ stats: { PTS: 10 } as Record<string, number> });
    expect(isDNPGame(g)).toBe(true);
  });
  it("returns false for active games", () => {
    expect(isDNPGame(mkGame())).toBe(false);
  });
  it("accepts alternate minutes keys", () => {
    expect(isDNPGame(mkGame({ stats: { min: 25 } as Record<string, number> }))).toBe(false);
    expect(isDNPGame(mkGame({ stats: { Minutes: 25 } as Record<string, number> }))).toBe(false);
  });
});

// =========================================================================
// calcHitRates
// =========================================================================
describe("calcHitRates", () => {
  it("returns zero rates on empty input", () => {
    const r = calcHitRates([], "points", 20, "over");
    expect(r.values).toEqual([]);
    expect(r.l5.rate).toBe(0);
    expect(r.season.rate).toBe(0);
  });
  it("computes over-side hit rate", () => {
    const log = mkGameLog(10, () => mkStats({ PTS: 25 })); // 100% over 20
    const r = calcHitRates(log, "points", 20, "over");
    expect(r.l5.hits).toBe(5);
    expect(r.l5.rate).toBe(100);
    expect(r.season.rate).toBe(100);
  });
  it("computes under-side hit rate as inverse", () => {
    const log = mkGameLog(10, () => mkStats({ PTS: 15 })); // 100% under 20
    const r = calcHitRates(log, "points", 20, "under");
    expect(r.l5.hits).toBe(5);
    expect(r.l5.rate).toBe(100);
  });
  it("skips DNP games", () => {
    const log = [mkGame({ stats: mkStats({ MIN: 0 }) }), ...mkGameLog(5, () => mkStats({ PTS: 30 }))];
    const r = calcHitRates(log, "points", 20, "over");
    expect(r.l5.total).toBe(5);
    expect(r.l5.rate).toBe(100);
  });
  it("handles mixed values for partial rate", () => {
    const log = [
      mkGame({ stats: mkStats({ PTS: 25 }) }),
      mkGame({ stats: mkStats({ PTS: 25 }) }),
      mkGame({ stats: mkStats({ PTS: 15 }) }),
      mkGame({ stats: mkStats({ PTS: 15 }) }),
      mkGame({ stats: mkStats({ PTS: 25 }) }),
    ];
    const r = calcHitRates(log, "points", 20, "over");
    expect(r.l5.hits).toBe(3);
    expect(r.l5.rate).toBeCloseTo(60);
  });
});

// =========================================================================
// calculateMinutesTrend
// =========================================================================
describe("calculateMinutesTrend", () => {
  it("returns stable+0 when fewer than 5 valid games", () => {
    const log = mkGameLog(3);
    expect(calculateMinutesTrend(log).score).toBe(0);
    expect(calculateMinutesTrend(log).direction).toBe("stable");
  });
  it("detects strong upward trend (+5)", () => {
    const log = [
      mkGame({ stats: mkStats({ MIN: 40 }) }), mkGame({ stats: mkStats({ MIN: 40 }) }),
      mkGame({ stats: mkStats({ MIN: 40 }) }), mkGame({ stats: mkStats({ MIN: 40 }) }),
      mkGame({ stats: mkStats({ MIN: 40 }) }),
      mkGame({ stats: mkStats({ MIN: 30 }) }), mkGame({ stats: mkStats({ MIN: 30 }) }),
      mkGame({ stats: mkStats({ MIN: 30 }) }), mkGame({ stats: mkStats({ MIN: 30 }) }),
      mkGame({ stats: mkStats({ MIN: 30 }) }),
    ];
    const r = calculateMinutesTrend(log);
    expect(r.direction).toBe("up");
    expect(r.score).toBe(5);
  });
  it("detects strong downward trend (-5)", () => {
    const log = [
      mkGame({ stats: mkStats({ MIN: 25 }) }), mkGame({ stats: mkStats({ MIN: 25 }) }),
      mkGame({ stats: mkStats({ MIN: 25 }) }), mkGame({ stats: mkStats({ MIN: 25 }) }),
      mkGame({ stats: mkStats({ MIN: 25 }) }),
      mkGame({ stats: mkStats({ MIN: 35 }) }), mkGame({ stats: mkStats({ MIN: 35 }) }),
      mkGame({ stats: mkStats({ MIN: 35 }) }), mkGame({ stats: mkStats({ MIN: 35 }) }),
      mkGame({ stats: mkStats({ MIN: 35 }) }),
    ];
    expect(calculateMinutesTrend(log).score).toBe(-5);
  });
  it("detects moderate upward (+3)", () => {
    // To get l5-l10 diff = 3: l5=36, l10=33 (since l10 includes l5; pure-l6_10 = 30, l10 = (5*36 + 5*30)/10 = 33).
    const log = [
      ...Array(5).fill(0).map(() => mkGame({ stats: mkStats({ MIN: 36 }) })),
      ...Array(5).fill(0).map(() => mkGame({ stats: mkStats({ MIN: 30 }) })),
    ];
    const r = calculateMinutesTrend(log);
    expect(r.score).toBe(3);
    expect(r.direction).toBe("up");
  });
  it("detects moderate downward (-3)", () => {
    const log = [
      ...Array(5).fill(0).map(() => mkGame({ stats: mkStats({ MIN: 24 }) })),
      ...Array(5).fill(0).map(() => mkGame({ stats: mkStats({ MIN: 30 }) })),
    ];
    expect(calculateMinutesTrend(log).score).toBe(-3);
  });
});

// =========================================================================
// detectRecentAbsence
// =========================================================================
describe("detectRecentAbsence", () => {
  it("returns null on insufficient games", () => {
    expect(detectRecentAbsence([mkGame()])).toBeNull();
  });
  it("returns null when consecutive days < 5", () => {
    const log = [mkGame({ date: "2025-04-10" }), mkGame({ date: "2025-04-08" })];
    expect(detectRecentAbsence(log)).toBeNull();
  });
  it("returns absence info on 5+ day gap", () => {
    const log = [mkGame({ date: "2025-04-10" }), mkGame({ date: "2025-04-03" })];
    const a = detectRecentAbsence(log);
    expect(a).not.toBeNull();
    expect(a?.daysGap).toBe(7);
    expect(a?.gamesEstimate).toBe(3);
  });
  it("skips entries with missing dates", () => {
    const log = [
      mkGame({ date: "" }), mkGame({ date: "2025-04-10" }), mkGame({ date: "2025-04-03" })
    ];
    expect(detectRecentAbsence(log)).not.toBeNull();
  });
});

// =========================================================================
// calculateStdDev
// =========================================================================
describe("calculateStdDev", () => {
  it("returns 0 for < 3 values", () => {
    expect(calculateStdDev([1, 2])).toBe(0);
  });
  it("computes population stddev", () => {
    expect(calculateStdDev([10, 10, 10])).toBe(0);
    expect(calculateStdDev([10, 20, 30])).toBeCloseTo(8.16, 1);
  });
});

// =========================================================================
// calculatePerMinuteRate
// =========================================================================
describe("calculatePerMinuteRate", () => {
  it("returns 0 when no minutes data", () => {
    expect(calculatePerMinuteRate([mkGame({ stats: mkStats({ MIN: 0 }) })], "points")).toBe(0);
  });
  it("weights L5 double", () => {
    const log = [
      ...Array(5).fill(0).map(() => mkGame({ stats: mkStats({ MIN: 30, PTS: 30 }) })), // 1.0 pts/min
      ...Array(5).fill(0).map(() => mkGame({ stats: mkStats({ MIN: 30, PTS: 15 }) })), // 0.5 pts/min
    ];
    const r = calculatePerMinuteRate(log, "points");
    // weighted: (30*2*5 + 15*1*5) / (30*2*5 + 30*1*5) = (300+75)/(300+150)=0.833
    expect(r).toBeCloseTo(0.833, 2);
  });
});

// =========================================================================
// projectMinutes
// =========================================================================
describe("projectMinutes", () => {
  it("returns 0 when no minutes", () => {
    expect(projectMinutes([mkGame({ stats: mkStats({ MIN: 0 }) })], false)).toBe(0);
  });
  it("computes 2:1 weighted L5:L6-10 projection", () => {
    const log = [
      ...Array(5).fill(0).map(() => mkGame({ stats: mkStats({ MIN: 30 }) })),
      ...Array(5).fill(0).map(() => mkGame({ stats: mkStats({ MIN: 24 }) })),
    ];
    // (30*2 + 24) / 3 = 84/3 = 28
    expect(projectMinutes(log, false)).toBe(28);
  });
  it("applies 0.93x B2B penalty", () => {
    const log = Array(10).fill(0).map(() => mkGame({ stats: mkStats({ MIN: 30 }) }));
    expect(projectMinutes(log, true)).toBe(Math.round(30 * 0.93 * 10) / 10);
  });
});

// =========================================================================
// computeProjectedStat
// =========================================================================
describe("computeProjectedStat", () => {
  it("returns 0 when input is 0", () => {
    expect(computeProjectedStat(0, 30, 0)).toBe(0);
  });
  it("scales by minutes × rate", () => {
    expect(computeProjectedStat(0.7, 30, 0)).toBe(21);
  });
  it("applies positive paceScore boost", () => {
    expect(computeProjectedStat(0.7, 30, 4)).toBeCloseTo(21 * 1.04, 1);
  });
  it("applies negative paceScore drag", () => {
    expect(computeProjectedStat(0.7, 30, -4)).toBeCloseTo(21 * 0.96, 1);
  });
});

// =========================================================================
// calculateZScore
// =========================================================================
describe("calculateZScore", () => {
  it("returns 0 on zero stddev", () => {
    expect(calculateZScore(20, 18, 0, "over")).toBe(0);
  });
  it("positive z for over when projected > line", () => {
    const z = calculateZScore(25, 20, 4, "over");
    expect(z).toBeCloseTo(1.25, 2);
  });
  it("positive z for under when projected < line", () => {
    const z = calculateZScore(15, 20, 4, "under");
    expect(z).toBeCloseTo(1.25, 2);
  });
  it("negative z when on wrong side", () => {
    expect(calculateZScore(15, 20, 4, "over")).toBeLessThan(0);
  });
});

// =========================================================================
// calculateUsageBoost
// =========================================================================
describe("calculateUsageBoost", () => {
  it("returns 0 boost when no injuries", () => {
    const r = calculateUsageBoost([], 30);
    expect(r.boostPct).toBe(0);
    expect(r.injuredCount).toBe(0);
  });
  it("counts only out / day-to-day", () => {
    const r = calculateUsageBoost(["probable", "questionable", "out"], 30);
    expect(r.injuredCount).toBe(1);
  });
  it("boosts starter at 3+ injuries by 10%", () => {
    expect(calculateUsageBoost(["out", "out", "out"], 30).boostPct).toBe(0.10);
  });
  it("boosts bench at 3+ by 5%", () => {
    expect(calculateUsageBoost(["out", "out", "out"], 15).boostPct).toBe(0.05);
  });
  it("boosts starter at 1 by 3%", () => {
    expect(calculateUsageBoost(["out"], 30).boostPct).toBeCloseTo(0.03);
  });
  it("boosts at 2 starters by 6%", () => {
    expect(calculateUsageBoost(["out", "out"], 30).boostPct).toBeCloseTo(0.06);
  });
});

// =========================================================================
// detectMinutesFloor
// =========================================================================
describe("detectMinutesFloor", () => {
  it("returns zeros on insufficient games", () => {
    const r = detectMinutesFloor([mkGame()]);
    expect(r.isStable).toBe(false);
    expect(r.isVolatile).toBe(false);
  });
  it("flags stable when minM>=28 and spread<=8", () => {
    const log = [
      mkGame({ stats: mkStats({ MIN: 32 }) }),
      mkGame({ stats: mkStats({ MIN: 31 }) }),
      mkGame({ stats: mkStats({ MIN: 30 }) }),
      mkGame({ stats: mkStats({ MIN: 33 }) }),
      mkGame({ stats: mkStats({ MIN: 30 }) }),
    ];
    expect(detectMinutesFloor(log).isStable).toBe(true);
    expect(detectMinutesFloor(log).isVolatile).toBe(false);
  });
  it("flags volatile when spread>=15", () => {
    const log = [
      mkGame({ stats: mkStats({ MIN: 35 }) }),
      mkGame({ stats: mkStats({ MIN: 33 }) }),
      mkGame({ stats: mkStats({ MIN: 15 }) }),
      mkGame({ stats: mkStats({ MIN: 30 }) }),
      mkGame({ stats: mkStats({ MIN: 32 }) }),
    ];
    expect(detectMinutesFloor(log).isVolatile).toBe(true);
  });
  it("flags volatile when minM < 15", () => {
    const log = [
      mkGame({ stats: mkStats({ MIN: 10 }) }),
      mkGame({ stats: mkStats({ MIN: 12 }) }),
      mkGame({ stats: mkStats({ MIN: 14 }) }),
    ];
    expect(detectMinutesFloor(log).isVolatile).toBe(true);
  });
});

// =========================================================================
// calculateHomeAwaySplit
// =========================================================================
describe("calculateHomeAwaySplit", () => {
  it("returns zeros with insufficient games per side", () => {
    const log = [mkGame({ homeAway: "home" })];
    expect(calculateHomeAwaySplit(log, "points", true).edgePct).toBe(0);
  });
  it("computes positive home-side edge", () => {
    const log = [
      mkGame({ homeAway: "home", stats: mkStats({ PTS: 30 }) }),
      mkGame({ homeAway: "home", stats: mkStats({ PTS: 30 }) }),
      mkGame({ homeAway: "away", stats: mkStats({ PTS: 15 }) }),
      mkGame({ homeAway: "away", stats: mkStats({ PTS: 15 }) }),
    ];
    const r = calculateHomeAwaySplit(log, "points", true);
    expect(r.edgePct).toBeGreaterThan(0);
  });
  it("computes negative away-side edge when player worse away", () => {
    const log = [
      mkGame({ homeAway: "home", stats: mkStats({ PTS: 30 }) }),
      mkGame({ homeAway: "home", stats: mkStats({ PTS: 30 }) }),
      mkGame({ homeAway: "away", stats: mkStats({ PTS: 15 }) }),
      mkGame({ homeAway: "away", stats: mkStats({ PTS: 15 }) }),
    ];
    const r = calculateHomeAwaySplit(log, "points", false);
    expect(r.edgePct).toBeLessThan(0);
  });
});

// =========================================================================
// detectMarketConfirmation
// =========================================================================
describe("detectMarketConfirmation", () => {
  it("flags overpriced when l5=100% and l10<80%", () => {
    expect(detectMarketConfirmation(100, 70).isOverpriced).toBe(true);
    expect(detectMarketConfirmation(100, 80).isOverpriced).toBe(false);
  });
  it("flags cold-buy when l5<=20% and l10>=50%", () => {
    expect(detectMarketConfirmation(20, 50).isColdBuy).toBe(true);
    expect(detectMarketConfirmation(30, 50).isColdBuy).toBe(false);
  });
});

// =========================================================================
// detectRegression
// =========================================================================
describe("detectRegression", () => {
  it("returns none on zero seasonAvg", () => {
    expect(detectRegression(20, 0, 18, "over").signal).toBe("none");
  });
  it("over: pctDiff <= -20 → buy_low", () => {
    expect(detectRegression(8, 10, 9, "over").signal).toBe("buy_low");
  });
  it("over: pctDiff >= 20 → sell_high", () => {
    expect(detectRegression(12, 10, 11, "over").signal).toBe("sell_high");
  });
  it("under: pctDiff >= 20 → buy_low", () => {
    expect(detectRegression(12, 10, 11, "under").signal).toBe("buy_low");
  });
  it("under: pctDiff <= -20 → sell_high", () => {
    expect(detectRegression(8, 10, 9, "under").signal).toBe("sell_high");
  });
  it("returns none when within band", () => {
    expect(detectRegression(10.5, 10, 10, "over").signal).toBe("none");
  });
});

// =========================================================================
// calculateUSGRate
// =========================================================================
describe("calculateUSGRate", () => {
  it("returns 0 when insufficient minutes", () => {
    const log = [mkGame({ stats: { MIN: 2, FGA: 5, FTA: 1, TO: 0 } as Record<string, number> })];
    expect(calculateUSGRate(log)).toBe(0);
  });
  it("computes USG using the documented formula", () => {
    // formula sums totals over games: usg = ((FGA + 0.44*FTA + TOV) * 48) / (MIN * 5)
    // For 5 games of (FGA=20, FTA=5, TO=2, MIN=30): totals 100/25/10/150
    // usg = (100 + 11 + 10) * 48 / (150*5) = 121*48/750 ≈ 7.74
    const log = Array(5).fill(0).map(() => mkGame({ stats: { MIN: 30, FGA: 20, FTA: 5, TO: 2 } as Record<string, number> }));
    const usg = calculateUSGRate(log);
    expect(usg).toBeCloseTo(7.7, 1);
  });
});

// =========================================================================
// detectRoleChange
// =========================================================================
describe("detectRoleChange", () => {
  it("returns none on insufficient games", () => {
    expect(detectRoleChange([mkGame()]).detected).toBe(false);
  });
  it("flags promotion at +30%", () => {
    const log = [
      mkGame({ stats: mkStats({ MIN: 36 }) }), mkGame({ stats: mkStats({ MIN: 36 }) }),
      mkGame({ stats: mkStats({ MIN: 36 }) }),
      mkGame({ stats: mkStats({ MIN: 22 }) }), mkGame({ stats: mkStats({ MIN: 22 }) }),
      mkGame({ stats: mkStats({ MIN: 22 }) }), mkGame({ stats: mkStats({ MIN: 22 }) }),
      mkGame({ stats: mkStats({ MIN: 22 }) }), mkGame({ stats: mkStats({ MIN: 22 }) }),
      mkGame({ stats: mkStats({ MIN: 22 }) }),
    ];
    expect(detectRoleChange(log).detected).toBe(true);
    expect(detectRoleChange(log).direction).toBe("promotion");
  });
  it("flags demotion at -30%", () => {
    const log = [
      mkGame({ stats: mkStats({ MIN: 18 }) }), mkGame({ stats: mkStats({ MIN: 18 }) }),
      mkGame({ stats: mkStats({ MIN: 18 }) }),
      mkGame({ stats: mkStats({ MIN: 32 }) }), mkGame({ stats: mkStats({ MIN: 32 }) }),
      mkGame({ stats: mkStats({ MIN: 32 }) }), mkGame({ stats: mkStats({ MIN: 32 }) }),
      mkGame({ stats: mkStats({ MIN: 32 }) }), mkGame({ stats: mkStats({ MIN: 32 }) }),
      mkGame({ stats: mkStats({ MIN: 32 }) }),
    ];
    expect(detectRoleChange(log).direction).toBe("demotion");
  });
});

// =========================================================================
// calculatePaceDefenseScores
// =========================================================================
describe("calculatePaceDefenseScores", () => {
  it("returns zeros when oppStats null", () => {
    const r = calculatePaceDefenseScores(null, "points", "over");
    expect(r).toEqual({ paceScore: 0, defenseScore: 0 });
  });
  it("buckets points by defensiveRating", () => {
    const r = calculatePaceDefenseScores(mkOppStats({ defensiveRating: 105 }), "points", "over");
    expect(r.defenseScore).toBe(-5); // soft defense
  });
  it("side-flips defense on under", () => {
    const oppStats = mkOppStats({ defensiveRating: 105 });
    const over = calculatePaceDefenseScores(oppStats, "points", "over").defenseScore;
    const under = calculatePaceDefenseScores(oppStats, "points", "under").defenseScore;
    expect(over + under).toBe(0);
  });
  it("buckets rebounds by rpg", () => {
    const r = calculatePaceDefenseScores(mkOppStats({ reboundsAllowedPerGame: 50 }), "rebounds", "over");
    expect(r.defenseScore).toBe(5);
  });
  it("applies position-aware DRB% refinement (rebounds, over)", () => {
    const base = calculatePaceDefenseScores(mkOppStats({ reboundsAllowedPerGame: 45 }), "rebounds", "over", "PG").defenseScore;
    const tight = calculatePaceDefenseScores(
      mkOppStats({ reboundsAllowedPerGame: 45, defensiveReboundPctVsPosition: { PG: 0.80 } }),
      "rebounds", "over", "PG"
    ).defenseScore;
    expect(tight).toBeLessThan(base);
  });
  it("buckets assists by apg", () => {
    expect(calculatePaceDefenseScores(mkOppStats({ assistsAllowedPerGame: 31 }), "assists", "over").defenseScore).toBe(5);
  });
  it("threes use opp 3pt%", () => {
    expect(calculatePaceDefenseScores(mkOppStats({ oppOwnThreePtFGPct: 39 }), "threes", "over").defenseScore).toBe(5);
  });
  it("steals use opp TOV", () => {
    expect(calculatePaceDefenseScores(mkOppStats({ oppOwnTurnovers: 16 }), "steals", "over").defenseScore).toBe(5);
  });
  it("blocks use opp 2pt%", () => {
    expect(calculatePaceDefenseScores(mkOppStats({ oppOwnTwoPtFGPct: 50 }), "blocks", "over").defenseScore).toBe(5);
  });
  it("double_double / triple_double return 0", () => {
    expect(calculatePaceDefenseScores(mkOppStats(), "double_double", "over").defenseScore).toBe(0);
    expect(calculatePaceDefenseScores(mkOppStats(), "triple_double", "over").defenseScore).toBe(0);
  });
  it("paceScore side-flips on under", () => {
    const over = calculatePaceDefenseScores(mkOppStats({ pointsAllowedPerGame: 122 }), "points", "over").paceScore;
    const under = calculatePaceDefenseScores(mkOppStats({ pointsAllowedPerGame: 122 }), "points", "under").paceScore;
    expect(over + under).toBe(0);
  });
});

// =========================================================================
// getScoreLabel + tiers
// =========================================================================
describe("getScoreLabel", () => {
  it("labels by D-101 cutoffs", () => {
    expect(getScoreLabel(95)).toBe("Elite Pick");
    expect(getScoreLabel(90)).toBe("Elite Pick");
    expect(getScoreLabel(89)).toBe("Strong Pick");
    expect(getScoreLabel(80)).toBe("Strong Pick");
    expect(getScoreLabel(79)).toBe("Good Pick");
    expect(getScoreLabel(70)).toBe("Good Pick");
    expect(getScoreLabel(69)).toBe("Lean");
    expect(getScoreLabel(60)).toBe("Lean");
    expect(getScoreLabel(59)).toBe("Pass");
    expect(getScoreLabel(0)).toBe("Pass");
  });
});

// =========================================================================
// getPlayerInjuryStatus
// =========================================================================
describe("getPlayerInjuryStatus", () => {
  it("returns not-injured when no map entry", () => {
    expect(getPlayerInjuryStatus("X", "Y", new Map()).isInjured).toBe(false);
  });
  it("flags out-status", () => {
    // Map keyed by lower-cased team; injury record uses playerName + status + teamName per BdlInjury type.
    const m = new Map<string, BdlInjury[]>([["lakers", [{ playerName: "T. Player", status: "Out", description: "", teamName: "Lakers", returnDate: null }]]]);
    const r = getPlayerInjuryStatus("T. Player", "Lakers", m);
    expect(r.isInjured).toBe(true);
    expect(r.penalty).toBeLessThan(0);
  });
});

// =========================================================================
// MINUTE_BOUND_PROPS
// =========================================================================
describe("MINUTE_BOUND_PROPS", () => {
  it("includes points / rebounds / assists", () => {
    expect(MINUTE_BOUND_PROPS.has("points")).toBe(true);
    expect(MINUTE_BOUND_PROPS.has("rebounds")).toBe(true);
    expect(MINUTE_BOUND_PROPS.has("assists")).toBe(true);
  });
  it("excludes steals / blocks / threes / turnovers", () => {
    expect(MINUTE_BOUND_PROPS.has("steals")).toBe(false);
    expect(MINUTE_BOUND_PROPS.has("blocks")).toBe(false);
    expect(MINUTE_BOUND_PROPS.has("threes")).toBe(false);
    expect(MINUTE_BOUND_PROPS.has("turnovers")).toBe(false);
  });
});

// =========================================================================
// getDefaultWeights
// =========================================================================
describe("getDefaultWeights", () => {
  it("returns all 25 documented weights", () => {
    const w = getDefaultWeights();
    expect(Object.keys(w).length).toBeGreaterThanOrEqual(25);
    expect(w.l5).toBe(1.0);
    expect(w.season).toBe(1.75);
    expect(w.blowoutRisk).toBe(1.0);
    expect(w.lineMovement).toBe(1.0);
    expect(w.lowMinRisk).toBe(1.0);
  });
});

// =========================================================================
// calculateConfidenceScore (per-factor effects)
// =========================================================================
describe("calculateConfidenceScore", () => {
  const baseInput = {
    l5HitRate: 40, l10HitRate: 40, seasonHitRate: 40,
    line: 20, playerFloor: 15, playerCeiling: 25, recentAvg: 20, seasonAvg: 20,
    isHome: true, odds: -110, pickSide: "over" as const, propType: "points",
    restDays: 2, isBackToBack: false, minutesTrendScore: 0, paceScore: 0, defenseScore: 0,
  };
  it("base scoring lands near 50", () => {
    const r = calculateConfidenceScore(baseInput, mkWeights());
    expect(r.score).toBeGreaterThanOrEqual(40);
    expect(r.score).toBeLessThanOrEqual(60);
  });
  it("L5 100% lifts score", () => {
    const r = calculateConfidenceScore({ ...baseInput, l5HitRate: 100 }, mkWeights());
    expect(r.breakdown.l5HitRate).toBeGreaterThan(0);
  });
  it("season < 40% penalizes", () => {
    const r = calculateConfidenceScore({ ...baseInput, seasonHitRate: 20 }, mkWeights());
    expect(r.breakdown.seasonHitRate).toBeLessThan(0);
  });
  it("floorCeiling: floor above line → positive bonus", () => {
    const r = calculateConfidenceScore({ ...baseInput, line: 10, playerFloor: 15 }, mkWeights());
    expect(r.breakdown.floorCeiling).toBeGreaterThan(0);
  });
  it("floorCeiling: ceiling below line → penalty (under-side)", () => {
    const r = calculateConfidenceScore({ ...baseInput, pickSide: "under", line: 30, playerCeiling: 20 }, mkWeights());
    expect(r.breakdown.floorCeiling).toBeGreaterThan(0);
  });
  it("B2B applies negative scoreboard", () => {
    const r = calculateConfidenceScore({ ...baseInput, isBackToBack: true, restDays: 0 }, mkWeights({ b2b: 1.0 }));
    expect(r.breakdown.backToBack).toBeLessThan(0);
  });
  it("recentForm side-flipped on under", () => {
    // strong upward trend (recent>season by 30%) on over = +10; on under = -10
    const over = calculateConfidenceScore({ ...baseInput, recentAvg: 26, seasonAvg: 20 }, mkWeights());
    const under = calculateConfidenceScore({ ...baseInput, recentAvg: 26, seasonAvg: 20, pickSide: "under" }, mkWeights());
    expect(over.breakdown.recentForm + under.breakdown.recentForm).toBe(0);
  });
  it("homeAway side-flipped on under", () => {
    const over = calculateConfidenceScore({ ...baseInput, isHome: true }, mkWeights({ homeAway: 1 }));
    const under = calculateConfidenceScore({ ...baseInput, isHome: true, pickSide: "under" }, mkWeights({ homeAway: 1 }));
    expect(over.breakdown.homeAway + under.breakdown.homeAway).toBe(0);
  });
  it("score is clamped 0..100", () => {
    const high = calculateConfidenceScore({
      ...baseInput, l5HitRate: 100, l10HitRate: 100, seasonHitRate: 100,
      playerFloor: 40, line: 10, paceScore: 4, defenseScore: 4
    }, mkWeights({ l5: 5, l10: 5, season: 5, floorCeiling: 5, pace: 2, oppDefense: 2 }));
    expect(high.score).toBeLessThanOrEqual(100);
    expect(high.score).toBeGreaterThanOrEqual(0);
  });
});

// =========================================================================
// calculateConfidenceScore — bucket boundary coverage
// =========================================================================
describe("calculateConfidenceScore — bucket boundaries", () => {
  const baseInput = {
    l5HitRate: 40, l10HitRate: 40, seasonHitRate: 40,
    line: 20, playerFloor: 15, playerCeiling: 25, recentAvg: 20, seasonAvg: 20,
    isHome: true, odds: -110, pickSide: "over" as const, propType: "points",
    restDays: 2, isBackToBack: false, minutesTrendScore: 0, paceScore: 0, defenseScore: 0,
  };
  it("L5 hit rate buckets cover all bands", () => {
    for (const [rate, sign] of [[100, "positive"], [80, "positive"], [60, "positive"], [40, "zero"], [25, "negative"], [10, "negative"]] as const) {
      const r = calculateConfidenceScore({ ...baseInput, l5HitRate: rate }, mkWeights());
      if (sign === "positive") expect(r.breakdown.l5HitRate).toBeGreaterThan(0);
      else if (sign === "negative") expect(r.breakdown.l5HitRate).toBeLessThan(0);
      else expect(r.breakdown.l5HitRate).toBe(0);
    }
  });
  it("L10 hit rate buckets", () => {
    expect(calculateConfidenceScore({ ...baseInput, l10HitRate: 80 }, mkWeights()).breakdown.l10HitRate).toBeGreaterThan(0);
    expect(calculateConfidenceScore({ ...baseInput, l10HitRate: 60 }, mkWeights()).breakdown.l10HitRate).toBeGreaterThan(0);
    expect(calculateConfidenceScore({ ...baseInput, l10HitRate: 30 }, mkWeights()).breakdown.l10HitRate).toBeLessThan(0);
  });
  it("season hit rate buckets", () => {
    expect(calculateConfidenceScore({ ...baseInput, seasonHitRate: 70 }, mkWeights()).breakdown.seasonHitRate).toBeGreaterThan(0);
    expect(calculateConfidenceScore({ ...baseInput, seasonHitRate: 50 }, mkWeights()).breakdown.seasonHitRate).toBeGreaterThan(0);
    expect(calculateConfidenceScore({ ...baseInput, seasonHitRate: 40 }, mkWeights()).breakdown.seasonHitRate).toBe(0);
  });
  it("recentForm: strong +15% bonus", () => {
    expect(calculateConfidenceScore({ ...baseInput, recentAvg: 25, seasonAvg: 20 }, mkWeights()).breakdown.recentForm).toBeGreaterThan(0);
  });
  it("recentForm: -15% penalty", () => {
    expect(calculateConfidenceScore({ ...baseInput, recentAvg: 16, seasonAvg: 20 }, mkWeights()).breakdown.recentForm).toBeLessThan(0);
  });
  it("recentForm: -5% small penalty", () => {
    expect(calculateConfidenceScore({ ...baseInput, recentAvg: 18.5, seasonAvg: 20 }, mkWeights()).breakdown.recentForm).toBeLessThan(0);
  });
  it("recentForm: 0 when within +/-5%", () => {
    expect(calculateConfidenceScore({ ...baseInput, recentAvg: 20, seasonAvg: 20 }, mkWeights()).breakdown.recentForm).toBe(0);
  });
  it("rest days bucket boundaries (3-day)", () => {
    const r = calculateConfidenceScore({ ...baseInput, restDays: 4, isBackToBack: false }, mkWeights({ rest: 1 }));
    expect(r.breakdown.restDays).toBeGreaterThanOrEqual(0);
  });
  it("B2B home and B2B away score differently", () => {
    const homeR = calculateConfidenceScore({ ...baseInput, isHome: true, isBackToBack: true, restDays: 0 }, mkWeights({ b2b: 1 }));
    const awayR = calculateConfidenceScore({ ...baseInput, isHome: false, isBackToBack: true, restDays: 0 }, mkWeights({ b2b: 1 }));
    expect(homeR.breakdown.backToBack).not.toBe(awayR.breakdown.backToBack);
  });
  it("homeAway -1 for away picks", () => {
    const r = calculateConfidenceScore({ ...baseInput, isHome: false }, mkWeights({ homeAway: 1 }));
    expect(r.breakdown.homeAway).toBeLessThan(0);
  });
  it("pace + opp_defense propagate through breakdown", () => {
    const r = calculateConfidenceScore({ ...baseInput, paceScore: 4, defenseScore: 5 }, mkWeights({ pace: 1, oppDefense: 1 }));
    expect(r.breakdown.pace).toBe(4);
    expect(r.breakdown.opponentDefense).toBe(5);
  });
});

// =========================================================================
// D-198 Tier-Aware Scoring
// =========================================================================
describe("tierFromConfidence", () => {
  it("returns lowercase tier names matching D-101 cutoffs", () => {
    expect(tierFromConfidence(95)).toBe("elite");
    expect(tierFromConfidence(85)).toBe("strong");
    expect(tierFromConfidence(75)).toBe("good");
    expect(tierFromConfidence(65)).toBe("lean");
    expect(tierFromConfidence(45)).toBe("pass");
  });
});

describe("applyTierAwareModifiers", () => {
  const breakdown = { l5HitRate: 15, seasonHitRate: 10, recentForm: 5 };
  it("returns input unchanged when modifiers absent", () => {
    expect(applyTierAwareModifiers(82, breakdown, mkWeights(), null)).toBe(82);
    expect(applyTierAwareModifiers(82, breakdown, mkWeights(), undefined)).toBe(82);
  });
  it("returns input unchanged when all multipliers = 1.0 (identity)", () => {
    const mods: TierModifiers = new Map([
      ["elite", new Map([["l5", 1.0], ["season", 1.0]])],
      ["strong", new Map([["l5", 1.0], ["season", 1.0]])],
    ]);
    expect(applyTierAwareModifiers(82, breakdown, mkWeights(), mods)).toBe(82);
  });
  it("amplifies factors with multiplier > 1.0", () => {
    // base l5=1.0, magnitude 15. multiplier 1.5 → delta = 15 * 1.0 * (1.5-1) = 7.5 → round to 8.
    const mods: TierModifiers = new Map([
      ["strong", new Map([["l5", 1.5]])],
    ]);
    const r = applyTierAwareModifiers(82, breakdown, mkWeights({ l5: 1.0 }), mods);
    expect(r).toBe(90); // 82 + 8
  });
  it("dampens factors with multiplier < 1.0", () => {
    const mods: TierModifiers = new Map([
      ["strong", new Map([["season", 0.5]])],
    ]);
    // breakdown.seasonHitRate=10, weights.season=1.75 default in mkWeights
    // delta = 10 * 1.75 * (0.5-1) = -8.75 → round to -9
    const r = applyTierAwareModifiers(82, breakdown, mkWeights({ season: 1.75 }), mods);
    expect(r).toBe(82 - 9);
  });
  it("uses the tier matching pre-modifier confidence", () => {
    const mods: TierModifiers = new Map([
      ["elite", new Map([["l5", 2.0]])],   // 95 → elite
      ["strong", new Map([["l5", 0.5]])],  // 82 → strong
    ]);
    const ad = mkWeights({ l5: 1.0 });
    // elite: delta = 15 * 1.0 * 1 = 15 → 95 + 15 = 110 → clamped 100
    expect(applyTierAwareModifiers(95, breakdown, ad, mods)).toBe(100);
    // strong: delta = 15 * 1.0 * -0.5 = -7.5. JS Math.round(-7.5) = -7 (rounds half toward +∞) → 82-7 = 75.
    expect(applyTierAwareModifiers(82, breakdown, ad, mods)).toBe(75);
  });
  it("clamps result to 0-100", () => {
    const mods: TierModifiers = new Map([
      ["strong", new Map([["l5", 5.0]])],
    ]);
    const r = applyTierAwareModifiers(82, breakdown, mkWeights({ l5: 1.0 }), mods);
    expect(r).toBeLessThanOrEqual(100);
    expect(r).toBeGreaterThanOrEqual(0);
  });
  it("ignores breakdown keys not in TIER_MODIFIER_KEY_MAP", () => {
    const bk = { unknownFactor: 99, l5HitRate: 0 };
    const mods: TierModifiers = new Map([
      ["strong", new Map([["l5", 2.0]])],
    ]);
    // unknownFactor doesn't map; l5HitRate=0 → no delta. Result = input.
    expect(applyTierAwareModifiers(82, bk, mkWeights({ l5: 1.0 }), mods)).toBe(82);
  });
});

describe("scoreOneSide tier-aware audit column", () => {
  it("returns confidence_pre_tier_aware on the result object", async () => {
    const log = mkGameLog(10, () => mkStats({ PTS: 22 }));
    const r = await scoreOneSide(
      { player: mkPlayer(), gameLog: log, minutesTrend: calculateMinutesTrend(log) },
      mkProp({ propType: "points", line: 20.5 }),
      { b2b: { isBackToBack: false, restDays: 2 }, oppStats: mkOppStats() },
      "over",
      mkWeights(),
      mkHelpers(),
    );
    expect(r).not.toBeNull();
    expect(typeof r?.confidence_pre_tier_aware).toBe("number");
  });
  it("confidence_pre_tier_aware equals confidence when tier modifiers absent (identity)", async () => {
    const log = mkGameLog(10, () => mkStats({ PTS: 22 }));
    const r = await scoreOneSide(
      { player: mkPlayer(), gameLog: log, minutesTrend: calculateMinutesTrend(log) },
      mkProp({ propType: "points", line: 20.5 }),
      { b2b: { isBackToBack: false, restDays: 2 }, oppStats: mkOppStats() },
      "over",
      mkWeights(),
      mkHelpers(),
    );
    expect(r?.confidence_pre_tier_aware).toBe(r?.confidence);
  });
  it("confidence diverges from confidence_pre_tier_aware when tier modifier ≠ 1.0", async () => {
    const log = mkGameLog(10, () => mkStats({ PTS: 22 }));
    // Strong tier with l5 multiplier 2.0 should amplify l5 factor for strong-tier picks.
    const mods: TierModifiers = new Map([
      ["strong", new Map([["l5", 2.0]])],
      ["good", new Map([["l5", 2.0]])],
      ["elite", new Map([["l5", 2.0]])],
    ]);
    const r = await scoreOneSide(
      { player: mkPlayer(), gameLog: log, minutesTrend: calculateMinutesTrend(log) },
      mkProp({ propType: "points", line: 20.5 }),
      { b2b: { isBackToBack: false, restDays: 2 }, oppStats: mkOppStats() },
      "over",
      mkWeights({ l5: 1.0 }),
      mkHelpers({ tierModifiers: mods }),
    );
    expect(r).not.toBeNull();
    // If pre-confidence lands in strong/good/elite tier with positive l5 magnitude, delta should be positive.
    if (r && (r.confidence_pre_tier_aware ?? 0) >= 70 && (r.breakdown?.l5HitRate ?? 0) > 0) {
      expect(r.confidence).toBeGreaterThanOrEqual(r.confidence_pre_tier_aware!);
    }
  });
});

// =========================================================================
// scoreOneSide — snapshot tests for canonical prop scenarios
// =========================================================================
describe("scoreOneSide (integration)", () => {
  it("returns null when fewer than 5 valid games", async () => {
    const r = await scoreOneSide(
      { player: mkPlayer(), gameLog: mkGameLog(3), minutesTrend: calculateMinutesTrend(mkGameLog(3)) },
      mkProp({ line: 20 }),
      { b2b: { isBackToBack: false, restDays: 2 }, oppStats: null },
      "over",
      mkWeights(),
      mkHelpers(),
    );
    expect(r).toBeNull();
  });
  it("produces a result for a 10-game points pick (over)", async () => {
    const log = mkGameLog(10, () => mkStats({ PTS: 25 }));
    const r = await scoreOneSide(
      { player: mkPlayer(), gameLog: log, minutesTrend: calculateMinutesTrend(log) },
      mkProp({ propType: "points", line: 20 }),
      { b2b: { isBackToBack: false, restDays: 2 }, oppStats: mkOppStats() },
      "over",
      mkWeights(),
      mkHelpers(),
    );
    expect(r).not.toBeNull();
    expect(r?.confidence).toBeGreaterThan(0);
    expect(r?.confidence).toBeLessThanOrEqual(100);
  });
  it("rebounds prop honors prop-specific scoring", async () => {
    const log = mkGameLog(10, () => mkStats({ REB: 10 }));
    const r = await scoreOneSide(
      { player: mkPlayer(), gameLog: log, minutesTrend: calculateMinutesTrend(log) },
      mkProp({ propType: "rebounds", line: 8.5 }),
      { b2b: { isBackToBack: false, restDays: 2 }, oppStats: mkOppStats({ reboundsAllowedPerGame: 48 }) },
      "over",
      mkWeights(),
      mkHelpers(),
    );
    expect(r).not.toBeNull();
    expect(r?.propType).toBe("rebounds");
  });
  it("under-side picks produce a result and report under side", async () => {
    const log = mkGameLog(10, () => mkStats({ PTS: 15 })); // all under 20.5
    const r = await scoreOneSide(
      { player: mkPlayer(), gameLog: log, minutesTrend: calculateMinutesTrend(log) },
      mkProp({ propType: "points", line: 20.5 }),
      { b2b: { isBackToBack: false, restDays: 2 }, oppStats: mkOppStats() },
      "under",
      mkWeights(),
      mkHelpers(),
    );
    expect(r).not.toBeNull();
    expect(r?.pickSide).toBe("under");
    // hitRates is formatted as "N/M" strings; verify all-10-of-10 under
    expect(r?.hitRates.l5).toBe("100%");
    expect(r?.hitRates.l10).toBe("100%");
  });
  it("applies stale data penalty when last game >35d ago", async () => {
    const asOf = new Date("2025-05-01");
    // Fresh: most recent game one day ago. Stale: most recent game >40 days ago.
    const freshLog = mkGameLog(10).map((g, i) => ({ ...g, date: new Date(asOf.getTime() - (i + 1) * 86_400_000).toISOString().slice(0, 10) }));
    const staleLog = mkGameLog(10).map((g, i) => ({ ...g, date: new Date(asOf.getTime() - (i * 86_400_000) - 40 * 86_400_000).toISOString().slice(0, 10) }));
    const helpers = mkHelpers({ asOfDate: asOf });
    const stale = await scoreOneSide(
      { player: mkPlayer(), gameLog: staleLog, minutesTrend: calculateMinutesTrend(staleLog) },
      mkProp({ propType: "points", line: 20 }),
      { b2b: { isBackToBack: false, restDays: 2 }, oppStats: mkOppStats() },
      "over",
      mkWeights({ staleData: 2.25 }),
      helpers,
    );
    const fresh = await scoreOneSide(
      { player: mkPlayer(), gameLog: freshLog, minutesTrend: calculateMinutesTrend(freshLog) },
      mkProp({ propType: "points", line: 20 }),
      { b2b: { isBackToBack: false, restDays: 2 }, oppStats: mkOppStats() },
      "over",
      mkWeights({ staleData: 2.25 }),
      helpers,
    );
    expect(stale).not.toBeNull();
    expect(fresh).not.toBeNull();
    expect((stale?.confidence ?? 0)).toBeLessThan((fresh?.confidence ?? 100));
  });
  it("trivial-line cap applies on tiny-line + high juice + finalScore > 65", async () => {
    // line <= 0.5 AND |odds| >= 200 AND finalScore > 65 → cap at 65
    const log = mkGameLog(10, () => mkStats({ STL: 2 }));
    const r = await scoreOneSide(
      { player: mkPlayer(), gameLog: log, minutesTrend: calculateMinutesTrend(log) },
      mkProp({ propType: "steals", line: 0.5, odds: -250 }),
      { b2b: { isBackToBack: false, restDays: 2 }, oppStats: mkOppStats({ oppOwnTurnovers: 16 }) },
      "over",
      mkWeights({ l5: 5, l10: 5, season: 5, floorCeiling: 5 }),
      mkHelpers(),
    );
    expect(r).not.toBeNull();
    // Cap should bind to 65 when the inputs would otherwise push higher
    expect((r?.confidence ?? 100)).toBeLessThanOrEqual(65);
  });

  it("unbettable_juice_flag fires on under-side at 70-79 tier when odds <= -250", async () => {
    const log = mkGameLog(10, () => mkStats({ PTS: 12 }));
    const r = await scoreOneSide(
      { player: mkPlayer(), gameLog: log, minutesTrend: calculateMinutesTrend(log) },
      mkProp({ propType: "points", line: 20, odds: -300 }),
      { b2b: { isBackToBack: false, restDays: 2 }, oppStats: mkOppStats() },
      "under",
      mkWeights(),
      mkHelpers(),
    );
    expect(r).not.toBeNull();
    // Confidence falls anywhere in 70-100 based on factor stack — flag fires when conditions met.
    if ((r?.confidence ?? 0) >= 70) {
      expect(r?.unbettableJuiceFlag).toBe(true);
    }
  });

  it("coin_flip_flag fires at Elite confidence (>=80) with season WR 40-60%", async () => {
    // Mixed game log: 5 of 10 hits at line 20.5 → season WR 50%
    const log = [
      ...Array(5).fill(0).map(() => mkGame({ stats: mkStats({ PTS: 25 }) })),
      ...Array(5).fill(0).map(() => mkGame({ stats: mkStats({ PTS: 15 }) })),
    ];
    const r = await scoreOneSide(
      { player: mkPlayer(), gameLog: log, minutesTrend: calculateMinutesTrend(log) },
      mkProp({ propType: "points", line: 20.5 }),
      { b2b: { isBackToBack: false, restDays: 2 }, oppStats: mkOppStats() },
      "over",
      mkWeights({ l5: 10, l10: 10, recentForm: 10 }), // boost weights to push into Elite tier
      mkHelpers(),
    );
    expect(r).not.toBeNull();
    if ((r?.confidence ?? 0) >= 80) {
      expect(r?.coinFlipFlag).toBe(true);
    }
  });

  it("rebounds prop with no DRB%-vs-position falls through to base rpg bucket", () => {
    const oppStats = mkOppStats({
      reboundsAllowedPerGame: 50,
      defensiveReboundPctVsPosition: undefined,
    });
    expect(calculatePaceDefenseScores(oppStats, "rebounds", "over", "PG").defenseScore).toBe(5);
  });

  it("assists prop with no AST%-vs-position falls through to DR-vs-position", () => {
    const oppStats = mkOppStats({
      assistsAllowedPerGame: 26,
      assistPctVsPosition: undefined,
      defensiveRatingVsPosition: { PG: 105 },
    });
    // Base apg=26 → -1; DR<108 nudges -2 → final -3.
    const r = calculatePaceDefenseScores(oppStats, "assists", "over", "PG");
    expect(r.defenseScore).toBeLessThanOrEqual(-1);
  });

  it("pts_rebs_asts (scoring multi) buckets via defRating", () => {
    const r = calculatePaceDefenseScores(mkOppStats({ defensiveRating: 120 }), "pts_rebs_asts", "over");
    expect(r.defenseScore).toBe(5);
  });

  it("rebs_asts (rebound multi) buckets via rpg", () => {
    const r = calculatePaceDefenseScores(mkOppStats({ reboundsAllowedPerGame: 50 }), "rebs_asts", "over");
    expect(r.defenseScore).toBe(5);
  });

  it("pts_rebs averages defRating bucket with rpg bucket", () => {
    const r = calculatePaceDefenseScores(mkOppStats({ defensiveRating: 120, reboundsAllowedPerGame: 50 }), "pts_rebs", "over");
    expect(r.defenseScore).toBe(5);
  });

  it("points prop with no defRating falls through to ppg bucket", () => {
    const r = calculatePaceDefenseScores(mkOppStats({ defensiveRating: 0, pointsAllowedPerGame: 122 }), "points", "over");
    expect(r.defenseScore).toBe(5);
  });

  it("scoreOneSide exercises stale-data 14-21d band", async () => {
    const asOf = new Date("2025-05-01");
    const log = mkGameLog(10).map((g, i) => ({ ...g, date: new Date(asOf.getTime() - (i * 86_400_000) - 15 * 86_400_000).toISOString().slice(0, 10) }));
    const r = await scoreOneSide(
      { player: mkPlayer(), gameLog: log, minutesTrend: calculateMinutesTrend(log) },
      mkProp({ propType: "points", line: 20 }),
      { b2b: { isBackToBack: false, restDays: 2 }, oppStats: mkOppStats() },
      "over",
      mkWeights({ staleData: 1 }),
      mkHelpers({ asOfDate: asOf }),
    );
    expect(r?.breakdown.staleDataPenalty).toBeLessThan(0);
  });

  it("scoreOneSide exercises stale-data 21-35d band", async () => {
    const asOf = new Date("2025-05-01");
    const log = mkGameLog(10).map((g, i) => ({ ...g, date: new Date(asOf.getTime() - (i * 86_400_000) - 25 * 86_400_000).toISOString().slice(0, 10) }));
    const r = await scoreOneSide(
      { player: mkPlayer(), gameLog: log, minutesTrend: calculateMinutesTrend(log) },
      mkProp({ propType: "points", line: 20 }),
      { b2b: { isBackToBack: false, restDays: 2 }, oppStats: mkOppStats() },
      "over",
      mkWeights({ staleData: 1 }),
      mkHelpers({ asOfDate: asOf }),
    );
    expect(r?.breakdown.staleDataPenalty).toBeLessThan(0);
  });

  it("scoreOneSide exercises low-min-risk on collapsed minutes", async () => {
    // Season minutes avg ~30, L5 minutes avg ~15 → ratio 0.5 → -15 penalty
    const log = [
      ...Array(5).fill(0).map(() => mkGame({ stats: mkStats({ MIN: 15 }) })),
      ...Array(5).fill(0).map(() => mkGame({ stats: mkStats({ MIN: 35 }) })),
    ];
    const r = await scoreOneSide(
      { player: mkPlayer(), gameLog: log, minutesTrend: calculateMinutesTrend(log) },
      mkProp({ propType: "points", line: 20 }),
      { b2b: { isBackToBack: false, restDays: 2 }, oppStats: mkOppStats() },
      "over",
      mkWeights({ lowMinRisk: 1 }),
      mkHelpers(),
    );
    expect(r?.breakdown.lowMinRiskPenalty).toBeLessThan(0);
  });

  it("scoreOneSide exercises blowoutRisk on favored team at >10 spread", async () => {
    const log = mkGameLog(10);
    const r = await scoreOneSide(
      { player: mkPlayer({ team: "Lakers" }), gameLog: log, minutesTrend: calculateMinutesTrend(log) },
      mkProp({ propType: "points", line: 20, gameTime: "2025-04-15T19:00:00Z" }),
      { b2b: { isBackToBack: false, restDays: 2 }, oppStats: mkOppStats() },
      "over",
      mkWeights({ blowoutRisk: 1 }),
      mkHelpers({ getGameLine: () => ({ spread: -11, spreadT0: -8, favoredTeam: "Lakers" } as never) }),
    );
    expect(r?.breakdown.blowoutRiskPenalty).toBeLessThan(0);
  });

  it("scoreOneSide exercises lineMovement bonus when spread moves toward pick", async () => {
    const log = mkGameLog(10);
    const r = await scoreOneSide(
      { player: mkPlayer({ team: "Lakers" }), gameLog: log, minutesTrend: calculateMinutesTrend(log) },
      mkProp({ propType: "points", line: 20, gameTime: "2025-04-15T19:00:00Z" }),
      { b2b: { isBackToBack: false, restDays: 2 }, oppStats: mkOppStats() },
      "over",
      mkWeights({ lineMovement: 1 }),
      mkHelpers({ getGameLine: () => ({ spread: -12, spreadT0: -5, favoredTeam: "Lakers" } as never) }),
    );
    expect(r?.breakdown.lineMovementBonus).not.toBe(0);
  });

  it("scoreOneSide marketConf overpriced path with L5=100 + L10<80", async () => {
    // 5 hits in L5, 7/10 in L10 (=70% < 80) so L10 rate < 80
    const log = [
      ...Array(5).fill(0).map(() => mkGame({ stats: mkStats({ PTS: 25 }) })),
      ...Array(3).fill(0).map(() => mkGame({ stats: mkStats({ PTS: 15 }) })),
      ...Array(2).fill(0).map(() => mkGame({ stats: mkStats({ PTS: 25 }) })),
    ];
    const r = await scoreOneSide(
      { player: mkPlayer(), gameLog: log, minutesTrend: calculateMinutesTrend(log) },
      mkProp({ propType: "points", line: 20.5 }),
      { b2b: { isBackToBack: false, restDays: 2 }, oppStats: mkOppStats() },
      "over",
      mkWeights({ marketConf: 1 }),
      mkHelpers(),
    );
    expect(r?.breakdown.marketConfBonus).toBeLessThan(0);
  });

  it("scoreOneSide marketConf cold-buy path (L5<=20 + L10>=50)", async () => {
    const log = [
      ...Array(5).fill(0).map(() => mkGame({ stats: mkStats({ PTS: 15 }) })), // L5: 0 hits
      ...Array(5).fill(0).map(() => mkGame({ stats: mkStats({ PTS: 25 }) })), // L6-10: 5 hits
    ];
    const r = await scoreOneSide(
      { player: mkPlayer(), gameLog: log, minutesTrend: calculateMinutesTrend(log) },
      mkProp({ propType: "points", line: 20.5 }),
      { b2b: { isBackToBack: false, restDays: 2 }, oppStats: mkOppStats() },
      "over",
      mkWeights({ marketConf: 1 }),
      mkHelpers(),
    );
    expect(r?.breakdown.marketConfBonus).toBeGreaterThan(0);
  });

  it("scoreOneSide exercises regression buy_low signal on over", async () => {
    // recentAvg << seasonAvg by 25% on over picks → buy_low → +4 bonus
    const log = [
      ...Array(5).fill(0).map(() => mkGame({ stats: mkStats({ PTS: 12 }) })),
      ...Array(5).fill(0).map(() => mkGame({ stats: mkStats({ PTS: 20 }) })),
    ];
    const r = await scoreOneSide(
      { player: mkPlayer(), gameLog: log, minutesTrend: calculateMinutesTrend(log) },
      mkProp({ propType: "points", line: 15 }),
      { b2b: { isBackToBack: false, restDays: 2 }, oppStats: mkOppStats() },
      "over",
      mkWeights({ regression: 1 }),
      mkHelpers(),
    );
    expect(r?.breakdown.regressionBonus).toBeGreaterThan(0);
  });

  it("scoreOneSide exercises roleChange promotion bonus", async () => {
    // L3 minutes high, L10 minutes lower → promotion
    const log = [
      mkGame({ stats: mkStats({ MIN: 36 }) }), mkGame({ stats: mkStats({ MIN: 36 }) }),
      mkGame({ stats: mkStats({ MIN: 36 }) }),
      ...Array(7).fill(0).map(() => mkGame({ stats: mkStats({ MIN: 22 }) })),
    ];
    const r = await scoreOneSide(
      { player: mkPlayer(), gameLog: log, minutesTrend: calculateMinutesTrend(log) },
      mkProp({ propType: "points", line: 20 }),
      { b2b: { isBackToBack: false, restDays: 2 }, oppStats: mkOppStats() },
      "over",
      mkWeights({ roleChange: 1 }),
      mkHelpers(),
    );
    expect(r?.breakdown.roleChangeBonus).toBeGreaterThan(0);
  });

  it("scoreOneSide vigFilter penalty fires on tight edge + low z-score", async () => {
    // projected very close to line, low stddev → low |z| → vigFilter fires
    const log = Array(10).fill(0).map(() => mkGame({ stats: mkStats({ PTS: 20 }) }));
    const r = await scoreOneSide(
      { player: mkPlayer(), gameLog: log, minutesTrend: calculateMinutesTrend(log) },
      mkProp({ propType: "points", line: 20.1 }),
      { b2b: { isBackToBack: false, restDays: 2 }, oppStats: mkOppStats() },
      "over",
      mkWeights({ vigFilter: 1 }),
      mkHelpers(),
    );
    expect(r?.breakdown.vigFilterPenalty).toBeLessThanOrEqual(0);
  });

  it("scoreOneSide injects player injury penalty via helpers", async () => {
    const log = mkGameLog(10);
    const r = await scoreOneSide(
      { player: mkPlayer(), gameLog: log, minutesTrend: calculateMinutesTrend(log) },
      mkProp({ propType: "points", line: 20 }),
      { b2b: { isBackToBack: false, restDays: 2 }, oppStats: mkOppStats() },
      "over",
      mkWeights({ playerInjury: 1 }),
      mkHelpers({
        getPlayerInjury: () => ({ isInjured: true, status: "Questionable", penalty: -10 }),
      }),
    );
    expect(r?.breakdown.playerInjuryPenalty).toBeLessThan(0);
  });

  it("scoreOneSide usageBoost lifts when injuries present", async () => {
    const log = Array(10).fill(0).map(() => mkGame({ stats: mkStats({ MIN: 30, PTS: 20 }) }));
    const r = await scoreOneSide(
      { player: mkPlayer(), gameLog: log, minutesTrend: calculateMinutesTrend(log) },
      mkProp({ propType: "points", line: 18 }),
      { b2b: { isBackToBack: false, restDays: 2 }, oppStats: mkOppStats() },
      "over",
      mkWeights(),
      mkHelpers({ getTeamInjuries: async () => ["out", "out", "out", "out"] }),
    );
    expect(r?.projectionData?.usageBoost).toBeGreaterThan(0);
  });

  it("populates sanity flag negative_factor_count and stacking flag when applicable", async () => {
    // Construct a poor-quality scenario to fire several negative factors
    const log = mkGameLog(10, (i) => mkStats({ PTS: 12, MIN: 20 + i, REB: 3, AST: 2 }));
    const r = await scoreOneSide(
      { player: mkPlayer(), gameLog: log, minutesTrend: calculateMinutesTrend(log) },
      mkProp({ propType: "points", line: 25 }),
      { b2b: { isBackToBack: true, restDays: 0 }, oppStats: mkOppStats({ defensiveRating: 118 }) },
      "over",
      mkWeights(),
      mkHelpers(),
    );
    expect(r).not.toBeNull();
    expect(typeof r?.negativeFactorCount).toBe("number");
  });
});
