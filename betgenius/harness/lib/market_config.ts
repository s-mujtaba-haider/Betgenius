// Phase 1 backtest harness — per-market configuration registry.

import type {
  BatterMarketResult,
  BatterScoringContext,
  GameMarketResult,
  GameScoringContext,
  PitcherKScoringContext,
  PitcherKScoringResult,
} from "../../supabase/functions/_shared/scoring_mlb_v2.ts";
import {
  scoreBatterHits,
  scoreBatterHomeRuns,
  scoreBatterRbis,
  scoreBatterRunsScored,
  scoreBatterTotalBases,
  scoreGameSide,
  scoreGameTotal,
  scorePitcherOuts,
  scorePitcherStrikeouts,
} from "../../supabase/functions/_shared/scoring_mlb_v2.ts";
import type { GameKind } from "./game_candidates.ts";

export type DataSource = "warehouse" | "pick_history";
export type ClvStatus = "computed" | "na";
export type ContextKind = "batter" | "pitcher" | "game";
export type PitcherRouter = "k" | "outs";

export type GradeColumn =
  | "hits"
  | "total_bases"
  | "home_runs"
  | "rbi"
  | "runs_scored"
  | "pitcher_strikeouts"
  | "pitcher_outs"
  | "game_outcome";

export interface CalibrationSanity {
  ceilingOver: number;
  ceilingUnder: number;
}

interface MarketConfigBase {
  cliMarket: string;
  oddsMarketKey: string;
  mlbMarketType: string;
  propType: string;
  gradeColumn: GradeColumn;
  allowedSources: readonly DataSource[];
  defaultSource: DataSource;
  clvEnabledForSource: (source: DataSource) => boolean;
  calibrationSanity?: CalibrationSanity;
  warehouseOddsAvailable: boolean;
}

export interface BatterMarketConfig extends MarketConfigBase {
  contextKind: "batter";
  score: (ctx: BatterScoringContext) => BatterMarketResult;
}

export interface PitcherMarketConfig extends MarketConfigBase {
  contextKind: "pitcher";
  pitcherRouter: PitcherRouter;
  score: (ctx: PitcherKScoringContext) => PitcherKScoringResult;
}

export interface GameMarketConfig extends MarketConfigBase {
  contextKind: "game";
  gameKind: GameKind;
  score: (ctx: GameScoringContext) => GameMarketResult;
}

export type MarketConfig = BatterMarketConfig | PitcherMarketConfig | GameMarketConfig;

const WAREHOUSE_ONLY: readonly DataSource[] = ["warehouse"];
const PICK_HISTORY_ONLY: readonly DataSource[] = ["pick_history"];
const BOTH: readonly DataSource[] = ["warehouse", "pick_history"];

const MARKETS: Record<string, MarketConfig> = {
  batter_hits: {
    cliMarket: "batter_hits",
    oddsMarketKey: "batter_hits",
    mlbMarketType: "batter_hits",
    propType: "hits",
    gradeColumn: "hits",
    contextKind: "batter",
    score: scoreBatterHits,
    allowedSources: WAREHOUSE_ONLY,
    defaultSource: "warehouse",
    clvEnabledForSource: () => true,
    warehouseOddsAvailable: true,
  },
  batter_total_bases: {
    cliMarket: "batter_total_bases",
    oddsMarketKey: "batter_total_bases",
    mlbMarketType: "batter_total_bases",
    propType: "total_bases",
    gradeColumn: "total_bases",
    contextKind: "batter",
    score: scoreBatterTotalBases,
    allowedSources: WAREHOUSE_ONLY,
    defaultSource: "warehouse",
    clvEnabledForSource: () => true,
    warehouseOddsAvailable: true,
  },
  batter_home_runs: {
    cliMarket: "batter_home_runs",
    oddsMarketKey: "batter_home_runs",
    mlbMarketType: "batter_hr",
    propType: "home_runs",
    gradeColumn: "home_runs",
    contextKind: "batter",
    score: scoreBatterHomeRuns,
    allowedSources: WAREHOUSE_ONLY,
    defaultSource: "warehouse",
    clvEnabledForSource: () => true,
    warehouseOddsAvailable: true,
  },
  batter_rbis: {
    cliMarket: "batter_rbis",
    oddsMarketKey: "batter_rbis",
    mlbMarketType: "batter_rbis",
    propType: "rbis",
    gradeColumn: "rbi",
    contextKind: "batter",
    score: scoreBatterRbis,
    allowedSources: WAREHOUSE_ONLY,
    defaultSource: "warehouse",
    clvEnabledForSource: () => true,
    warehouseOddsAvailable: true,
  },
  batter_runs_scored: {
    cliMarket: "batter_runs_scored",
    oddsMarketKey: "batter_runs_scored",
    mlbMarketType: "batter_runs_scored",
    propType: "runs_scored",
    gradeColumn: "runs_scored",
    contextKind: "batter",
    score: scoreBatterRunsScored,
    allowedSources: BOTH,
    defaultSource: "warehouse",
    clvEnabledForSource: (source) => source === "warehouse",
    calibrationSanity: { ceilingOver: 57, ceilingUnder: 66 },
    warehouseOddsAvailable: false,
  },
  pitcher_strikeouts: {
    cliMarket: "pitcher_strikeouts",
    oddsMarketKey: "pitcher_strikeouts",
    mlbMarketType: "pitcher_k",
    propType: "pitcher_strikeouts",
    gradeColumn: "pitcher_strikeouts",
    contextKind: "pitcher",
    pitcherRouter: "k",
    score: scorePitcherStrikeouts,
    allowedSources: WAREHOUSE_ONLY,
    defaultSource: "warehouse",
    clvEnabledForSource: () => true,
    warehouseOddsAvailable: true,
  },
  pitcher_outs: {
    cliMarket: "pitcher_outs",
    oddsMarketKey: "pitcher_outs",
    mlbMarketType: "pitcher_outs",
    propType: "pitcher_outs",
    gradeColumn: "pitcher_outs",
    contextKind: "pitcher",
    pitcherRouter: "outs",
    score: scorePitcherOuts,
    allowedSources: PICK_HISTORY_ONLY,
    defaultSource: "pick_history",
    clvEnabledForSource: () => false,
    warehouseOddsAvailable: false,
  },
  h2h: {
    cliMarket: "h2h",
    oddsMarketKey: "h2h__home",
    mlbMarketType: "game_side",
    propType: "h2h",
    gradeColumn: "game_outcome",
    contextKind: "game",
    gameKind: "h2h",
    score: scoreGameSide,
    allowedSources: WAREHOUSE_ONLY,
    defaultSource: "warehouse",
    clvEnabledForSource: () => true,
    warehouseOddsAvailable: true,
  },
  spreads: {
    cliMarket: "spreads",
    oddsMarketKey: "spreads__home",
    mlbMarketType: "game_side",
    propType: "spreads",
    gradeColumn: "game_outcome",
    contextKind: "game",
    gameKind: "spreads",
    score: scoreGameSide,
    allowedSources: WAREHOUSE_ONLY,
    defaultSource: "warehouse",
    clvEnabledForSource: () => true,
    warehouseOddsAvailable: true,
  },
  totals: {
    cliMarket: "totals",
    oddsMarketKey: "totals",
    mlbMarketType: "game_total",
    propType: "totals",
    gradeColumn: "game_outcome",
    contextKind: "game",
    gameKind: "totals",
    score: scoreGameTotal,
    allowedSources: WAREHOUSE_ONLY,
    defaultSource: "warehouse",
    clvEnabledForSource: () => true,
    warehouseOddsAvailable: true,
  },
};

export function listCliMarkets(): string[] {
  return Object.keys(MARKETS);
}

export function getMarketConfig(cliMarket: string): MarketConfig {
  const cfg = MARKETS[cliMarket];
  if (!cfg) {
    throw new Error(
      `[harness] Unknown --market=${cliMarket}. Valid: ${listCliMarkets().join(", ")}`,
    );
  }
  return cfg;
}

export function resolveDataSource(
  config: MarketConfig,
  sourceArg?: string,
): DataSource {
  if (!sourceArg) return config.defaultSource;
  if (sourceArg !== "warehouse" && sourceArg !== "pick_history") {
    throw new Error(
      `[harness] Unknown --source=${sourceArg}. Valid: warehouse, pick_history`,
    );
  }
  if (!config.allowedSources.includes(sourceArg)) {
    throw new Error(
      `[harness] --source=${sourceArg} is not supported for --market=${config.cliMarket}. ` +
        `Allowed: ${config.allowedSources.join(", ")}`,
    );
  }
  return sourceArg;
}

export function clvStatusFor(config: MarketConfig, source: DataSource): ClvStatus {
  return config.clvEnabledForSource(source) ? "computed" : "na";
}

export function projectedStatFromScore(
  config: MarketConfig,
  result: BatterMarketResult | PitcherKScoringResult | GameMarketResult,
): number {
  if (config.contextKind === "game") {
    const g = result as GameMarketResult;
    return config.gameKind === "totals" ? g.projectedTotal : (g.projectedHomeRuns - g.projectedAwayRuns);
  }
  if (config.contextKind === "batter") {
    return (result as BatterMarketResult).projectedStat;
  }
  return (result as PitcherKScoringResult).projectedK;
}
