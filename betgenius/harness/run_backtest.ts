#!/usr/bin/env -S deno run --allow-net --allow-env --allow-read --allow-write
// Phase 1 backtest harness — unified CLI for MLB batter + pitcher prop markets.
//
// Warehouse mode (default): full candidate universe from cache_mlb_historical_odds
// with entry/closing snapshots and CLV.
//
// pick_history mode: entry odds from pick_history.odds for runs_scored / pitcher_outs,
// side/line fixed from stored picks, CLV N/A.
//
// Usage:
//   cp harness/.env.example harness/.env   # set HARNESS_DATABASE_URL
//   deno run --no-check --allow-net --allow-env --allow-read --allow-write \
//     betgenius/harness/run_backtest.ts \
//     [--market=batter_hits|...|pitcher_outs|h2h|spreads|totals] \
//     [--source=warehouse|pick_history] \
//     [--start=YYYY-MM-DD] [--end=YYYY-MM-DD] \
//     [--scoring=poisson|isotonic] [--lambda-coeff=0.002] [--shrink=0.4] \
//     [--out=path] [--format=json|csv|both] [--min-completeness=0] [--limit=0]

import { closePool, getDbFromEnv } from "./lib/env.ts";
import {
  buildEventGamePkIndex,
  buildPlayerNameIndex,
  detectCoverageWindow,
  loadCandidateUniverse,
  resolvePlayerId,
  type CandidateGroup,
} from "./lib/candidates.ts";
import {
  BoundedMap,
  buildLeakSafeBatterContext,
  newRouterCaches,
  type BatterContextResult,
} from "./lib/context_batter.ts";
import {
  buildLeakSafePitcherKContext,
  buildLeakSafePitcherOutsContext,
  newPitcherRouterCaches,
} from "./lib/context_pitcher.ts";
import {
  buildEventLookupIndex,
  eventLookupKey,
} from "./lib/event_lookup.ts";
import { fetchPlayerOutcomes, gradePick } from "./lib/grade.ts";
import type { ExcludedCandidate, GradedPick, PickSide } from "./lib/metrics.ts";

/** Optional D-691 / M2 fields from batter scorer results. */
function scorerEvFields(result: {
  winProb?: number;
  edgeVsImplied?: number;
  evPerUnit?: number;
  unbettableOverBreakevenFlag?: boolean;
}): Partial<GradedPick> {
  const out: Partial<GradedPick> = {};
  if (result.winProb !== undefined) out.winProb = result.winProb;
  if (result.edgeVsImplied !== undefined) out.edgeVsImplied = result.edgeVsImplied;
  if (result.evPerUnit !== undefined) out.evPerUnit = result.evPerUnit;
  if (result.unbettableOverBreakevenFlag !== undefined) {
    out.unbettableOverBreakevenFlag = result.unbettableOverBreakevenFlag;
  }
  return out;
}
import {
  clvStatusFor,
  getMarketConfig,
  listCliMarkets,
  projectedStatFromScore,
  resolveDataSource,
  type GameMarketConfig,
  type MarketConfig,
  type PitcherMarketConfig,
} from "./lib/market_config.ts";
import {
  detectPickHistoryCoverage,
  loadPickHistoryUniverse,
  type PickHistoryCandidate,
} from "./lib/pick_history_candidates.ts";
import { buildReport, parseReportFormat, printSummary, writeReportCsv, writeReportJson, writeReportOutputs } from "./lib/report.ts";
import { buildStatcastAsOfIndex } from "./lib/statcast_asof.ts";
import { loadMlbWeightsWithPerMarket } from "./lib/weights_pg.ts";
import { runGameWarehouseBacktest } from "./lib/run_game_backtest.ts";
import {
  setActiveMarket,
  setMlbWeightsWithPerMarket,
  setPoissonTuningOverride,
  type BatterScoringContext,
  type PitcherKScoringContext,
} from "../supabase/functions/_shared/scoring_mlb_v2.ts";

function applyScoringKnobs(
  args: Record<string, string>,
  mlbMarketType: string,
): void {
  const scoring = args.scoring ?? "poisson";
  if (scoring !== "poisson" && scoring !== "isotonic") {
    throw new Error(
      `[harness] Invalid --scoring=${scoring}. Use poisson or isotonic.`,
    );
  }
  const lambdaCoeff = args["lambda-coeff"]
    ? parseFloat(args["lambda-coeff"])
    : undefined;
  const shrinkFactor = args.shrink ? parseFloat(args.shrink) : undefined;
  if (
    lambdaCoeff !== undefined &&
    (!Number.isFinite(lambdaCoeff) || lambdaCoeff <= 0)
  ) {
    throw new Error("[harness] Invalid --lambda-coeff (must be > 0).");
  }
  if (
    shrinkFactor !== undefined &&
    (!Number.isFinite(shrinkFactor) || shrinkFactor <= 0 || shrinkFactor > 1)
  ) {
    throw new Error("[harness] Invalid --shrink (must be in (0, 1]).");
  }
  const disablePoisson = scoring === "isotonic";
  if (disablePoisson || lambdaCoeff !== undefined || shrinkFactor !== undefined) {
    setPoissonTuningOverride({
      market: mlbMarketType,
      disablePoisson: disablePoisson || undefined,
      lambdaCoeff,
      shrinkFactor,
    });
    const parts = [`scoring=${scoring}`];
    if (lambdaCoeff !== undefined) parts.push(`lambda=${lambdaCoeff}`);
    if (shrinkFactor !== undefined) parts.push(`shrink=${shrinkFactor}`);
    console.log(`[harness] Poisson tuning override: ${parts.join(", ")}`);
  } else {
    setPoissonTuningOverride(null);
  }
}

function parseArgs(args: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of args) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const SCORING_PROGRESS_INTERVAL = 50;

function logScoringProgress(processed: number, total: number): void {
  if (processed % SCORING_PROGRESS_INTERVAL === 0 || processed === total) {
    const pct = total > 0 ? ((processed / total) * 100).toFixed(1) : "100.0";
    console.log(`[harness]   scoring ${processed}/${total} (${pct}%)`);
  }
}

function warehouseProviderGapMessage(market: string, config: MarketConfig): string {
  if (config.cliMarket === "pitcher_outs") {
    return (
      `[harness] No ${market} rows in cache_mlb_historical_odds.\n` +
      "  Historical warehouse has 0 pitcher_outs rows (never backfilled pre-D-768).\n" +
      "  Re-run with --source=pick_history to use pick_history.odds (entry price only; CLV N/A)."
    );
  }
  if (config.cliMarket === "batter_runs_scored") {
    return (
      `[harness] No ${market} rows in cache_mlb_historical_odds.\n` +
      "  The Odds API does not expose this market in the historical odds warehouse " +
      "(provider gap — not a missing backfill).\n" +
      "  For batter_runs_scored, re-run with --source=pick_history to use pick_history.odds " +
      "(entry price only; CLV N/A)."
    );
  }
  return (
    `[harness] No ${market} rows in cache_mlb_historical_odds. Nothing to backtest.`
  );
}

async function saveReportOutputs(
  report: Awaited<ReturnType<typeof buildReport>>,
  args: Record<string, string>,
  defaultBase: string,
): Promise<void> {
  const format = parseReportFormat(args.format);
  if (args.out) {
    const out = args.out;
    if (out.endsWith(".csv")) {
      await writeReportCsv(report, out);
      console.log(`[harness] Wrote ${out}`);
      return;
    }
    if (out.endsWith(".json")) {
      await writeReportJson(report, out);
      console.log(`[harness] Wrote ${out}`);
      return;
    }
    const written = await writeReportOutputs(report, { format, outBase: out });
    for (const p of written) console.log(`[harness] Wrote ${p}`);
    return;
  }
  const written = await writeReportOutputs(report, { format, outBase: defaultBase });
  for (const p of written) console.log(`[harness] Wrote ${p}`);
}

async function runWarehouseBacktest(
  config: MarketConfig,
  args: Record<string, string>,
): Promise<void> {
  if (config.contextKind === "game") {
    await runGameWarehouseBacktest(config as GameMarketConfig, args);
    return;
  }

  const db = getDbFromEnv();
  try {
    console.log(`[harness] Market: ${config.cliMarket} | source: warehouse`);
    console.log(
      "[harness] Loading MLB weights from algorithm_weights (shipped, fixed model — no refitting in Phase 1)...",
    );
    const { global, perMarket } = await loadMlbWeightsWithPerMarket(db);
    setMlbWeightsWithPerMarket(global, perMarket);
    setActiveMarket(config.mlbMarketType);
    applyScoringKnobs(args, config.mlbMarketType);

    console.log(`[harness] Auto-detecting ${config.oddsMarketKey} historical-odds coverage window...`);
    const coverage = await detectCoverageWindow(db, config.oddsMarketKey);
    console.log(
      `[harness] Detected coverage: ${coverage.minCommenceTime ?? "none"} -> ${coverage.maxCommenceTime ?? "none"} (${coverage.rowCount} rows)`,
    );

    if (!coverage.minCommenceTime || !coverage.maxCommenceTime || coverage.rowCount === 0) {
      if (!config.warehouseOddsAvailable) {
        console.error(warehouseProviderGapMessage(config.oddsMarketKey, config));
      } else {
        console.error(
          `[harness] No ${config.oddsMarketKey} rows found in cache_mlb_historical_odds. Nothing to backtest.`,
        );
      }
      Deno.exit(1);
    }

    const windowStartIso = args.start ? new Date(args.start).toISOString() : coverage.minCommenceTime;
    const windowEndBase = args.end ? new Date(args.end) : new Date(coverage.maxCommenceTime);
    const windowEndIso = new Date(windowEndBase.getTime() + 24 * 60 * 60 * 1000).toISOString();

    console.log(`[harness] Running window: ${windowStartIso} -> ${windowEndIso}`);
    const limit = args.limit ? parseInt(args.limit, 10) : 0;
    console.log("[harness] Loading candidate universe from cache_mlb_historical_odds...");
    const universe = await loadCandidateUniverse(
      db,
      config.oddsMarketKey,
      windowStartIso,
      windowEndIso,
      {
        maxGroups: limit > 0 ? limit : undefined,
        pageFromEnd: limit > 0 && !args.start,
      },
    );
    let candidates = universe.groups;
    if (limit > 0) candidates = candidates.slice(0, limit);
    console.log(
      `[harness] Candidate groups: ${candidates.length} (from ${universe.totalOddsRowsFetched} raw odds rows)`,
    );

    const commenceDates = candidates.map((c) => c.commenceTime.slice(0, 10)).sort();
    const startDate = commenceDates[0] ?? windowStartIso.slice(0, 10);
    const endDate = commenceDates[commenceDates.length - 1] ?? windowEndIso.slice(0, 10);
    const minCompleteness = args["min-completeness"] ? parseFloat(args["min-completeness"]) : 0;

    console.log("[harness] Building player-name -> player_id index...");
    const nameIndex = await buildPlayerNameIndex(db, startDate, endDate);
    console.log("[harness] Building event_id -> game_pk index for grading...");
    const gamePkIndex = await buildEventGamePkIndex(db, candidates.map((c) => c.eventId));

    const { picks, excluded, statcastCount } = await scoreWarehouseCandidates(
      db,
      config,
      candidates,
      nameIndex,
      gamePkIndex,
      minCompleteness,
    );

    const playersResolved = candidates.length - excluded.filter((e) => e.reason === "player_unresolved").length;
    const playersUnresolved = excluded.filter((e) => e.reason === "player_unresolved").length;

    const report = buildReport(
      picks,
      excluded,
      universe.totalOddsRowsFetched,
      candidates.length,
      playersResolved,
      playersUnresolved,
      windowStartIso,
      windowEndIso,
      { minCommenceTime: coverage.minCommenceTime, maxCommenceTime: coverage.maxCommenceTime },
      statcastCount,
      {
        market: config.cliMarket,
        dataSource: "warehouse",
        clvStatus: clvStatusFor(config, "warehouse"),
        d784CeilingOver: config.calibrationSanity?.ceilingOver,
        d784CeilingUnder: config.calibrationSanity?.ceilingUnder,
      },
    );

    const outBase = `${config.cliMarket}_${startDate}_to_${endDate}`;
    await saveReportOutputs(report, args, outBase);
    printSummary(report);
  } catch (e) {
    console.error("[harness] FATAL:", e);
    throw e;
  } finally {
    await closePool();
  }
}

async function scoreWarehouseCandidates(
  db: ReturnType<typeof getDbFromEnv>,
  config: MarketConfig,
  candidates: CandidateGroup[],
  nameIndex: Awaited<ReturnType<typeof buildPlayerNameIndex>>,
  gamePkIndex: Map<string, number>,
  minCompleteness: number,
): Promise<{ picks: GradedPick[]; excluded: ExcludedCandidate[]; statcastCount: number }> {
  const excluded: ExcludedCandidate[] = [];
  const resolvedCandidates: Array<{ group: CandidateGroup; playerId: number }> = [];

  for (const g of candidates) {
    const pid = resolvePlayerId(g.playerName, nameIndex);
    if (pid === null) {
      excluded.push({ eventId: g.eventId, playerName: g.playerName, line: g.line, reason: "player_unresolved" });
      continue;
    }
    resolvedCandidates.push({ group: g, playerId: pid });
  }

  if (config.contextKind === "batter") {
    console.log("[harness] Building Statcast AS-OF index...");
  } else {
    console.log("[harness] Preparing pitcher context caches...");
  }
  const statcastIndex = config.contextKind === "batter"
    ? await buildStatcastAsOfIndex(db, resolvedCandidates.map((c) => c.playerId))
    : null;

  console.log(
    `[harness] Scoring ${resolvedCandidates.length} candidates through the real scorer (strict leak-safe context)...`,
  );
  const batterCaches = newRouterCaches();
  const batterCtxCache = new BoundedMap<string, BatterContextResult>(4000);
  const pitcherCaches = newPitcherRouterCaches();
  const pendingGrade: Array<{ pick: GradedPick; playerId: number; gamePk: number | null }> = [];
  let statcastReconstructedCount = 0;
  let processed = 0;

  for (const { group, playerId } of resolvedCandidates) {
    processed++;
    logScoringProgress(processed, resolvedCandidates.length);

    const gameDateIso = group.commenceTime.slice(0, 10);
    let ctxResult: {
      ctx: BatterScoringContext | Omit<PitcherKScoringContext, "prop">;
      completeness: number;
      suppressedLeakRiskFactors?: string[];
      statcastReconstructed?: boolean;
    };
    let projectedStat: number;
    let confidence: number;
    let confidencePreCap: number;

    try {
      if (config.contextKind === "pitcher") {
        const pConfig = config as PitcherMarketConfig;
        const pCtx = await buildLeakSafePitcherKContext(db, group.eventId, playerId, pitcherCaches);
        if (pCtx.completeness < minCompleteness) {
          excluded.push({
            eventId: group.eventId,
            playerName: group.playerName,
            line: group.line,
            reason: "context_build_failed",
            detail: `completeness ${pCtx.completeness} < min ${minCompleteness}`,
          });
          continue;
        }
        const dummyProp = {
          propType: pConfig.mlbMarketType,
          line: group.line,
          odds: -110,
          pickSide: "over" as const,
          bookmaker: "dummy",
        };
        const dummyResult = pConfig.score({ ...pCtx.ctx, prop: dummyProp } as PitcherKScoringContext);
        const dummyProjected = projectedStatFromScore(pConfig, dummyResult);
        let agreeingSide: PickSide | null = null;
        if (dummyProjected > group.line) agreeingSide = "over";
        else if (dummyProjected < group.line) agreeingSide = "under";
        if (!agreeingSide) {
          excluded.push({
            eventId: group.eventId,
            playerName: group.playerName,
            line: group.line,
            reason: "no_agreeing_side",
            detail: `projectedStat=${dummyProjected} equals line`,
          });
          continue;
        }

        const entryOdds = agreeingSide === "over" ? group.entryOverOdds : group.entryUnderOdds;
        const entryBook = agreeingSide === "over" ? group.entryOverBook : group.entryUnderBook;
        const otherSideEntryOdds = agreeingSide === "over" ? group.entryUnderOdds : group.entryOverOdds;
        if (entryOdds === null) {
          excluded.push({
            eventId: group.eventId,
            playerName: group.playerName,
            line: group.line,
            reason: "no_entry_price_for_agreeing_side",
          });
          continue;
        }
        const finalProp = {
          propType: pConfig.mlbMarketType,
          line: group.line,
          odds: entryOdds,
          pickSide: agreeingSide,
          bookmaker: entryBook ?? "",
        };
        const result = pConfig.score({ ...pCtx.ctx, prop: finalProp } as PitcherKScoringContext);
        const closingOdds = agreeingSide === "over" ? group.closingOverOdds : group.closingUnderOdds;
        const closingBook = agreeingSide === "over" ? group.closingOverBook : group.closingUnderBook;

        const pick: GradedPick = {
          eventId: group.eventId,
          playerId,
          playerName: group.playerName,
          commenceTime: group.commenceTime,
          pickSide: agreeingSide,
          line: group.line,
          entryOdds,
          entryBookmaker: entryBook ?? "",
          otherSideEntryOdds,
          closingOdds,
          closingBookmaker: closingBook,
          confidence: result.confidence,
          confidencePreCap: result.confidence_pre_cap,
          projectedStat: projectedStatFromScore(pConfig, result),
          contextCompleteness: pCtx.completeness,
          suppressedLeakRiskFactors: [],
          actualStat: null,
          hit: null,
          voided: false,
          ...scorerEvFields(result),
        };
        pendingGrade.push({ pick, playerId, gamePk: gamePkIndex.get(group.eventId) ?? null });
        continue;
      }

      const ctxKey = `${group.eventId}|${playerId}`;
      const cachedBatter = batterCtxCache.get(ctxKey);
      if (cachedBatter) {
        ctxResult = cachedBatter;
      } else {
        ctxResult = await buildLeakSafeBatterContext(
          db,
          group.eventId,
          playerId,
          batterCaches,
          statcastIndex!,
          gameDateIso,
        );
        batterCtxCache.set(ctxKey, ctxResult);
      }
    } catch (e) {
      excluded.push({
        eventId: group.eventId,
        playerName: group.playerName,
        line: group.line,
        reason: "context_build_failed",
        detail: String(e),
      });
      continue;
    }
    if (ctxResult.completeness < minCompleteness) {
      excluded.push({
        eventId: group.eventId,
        playerName: group.playerName,
        line: group.line,
        reason: "context_build_failed",
        detail: `completeness ${ctxResult.completeness} < min ${minCompleteness}`,
      });
      continue;
    }

    const dummyProp = {
      propType: config.mlbMarketType,
      line: group.line,
      odds: -110,
      pickSide: "over" as const,
      bookmaker: "dummy",
    };
    const dummyResult = config.score({ ...ctxResult.ctx, prop: dummyProp } as BatterScoringContext);
    projectedStat = projectedStatFromScore(config, dummyResult);

    let agreeingSide: PickSide | null = null;
    if (projectedStat > group.line) agreeingSide = "over";
    else if (projectedStat < group.line) agreeingSide = "under";
    if (!agreeingSide) {
      excluded.push({
        eventId: group.eventId,
        playerName: group.playerName,
        line: group.line,
        reason: "no_agreeing_side",
        detail: `projectedStat=${projectedStat} equals line`,
      });
      continue;
    }

    const entryOdds = agreeingSide === "over" ? group.entryOverOdds : group.entryUnderOdds;
    const entryBook = agreeingSide === "over" ? group.entryOverBook : group.entryUnderBook;
    const otherSideEntryOdds = agreeingSide === "over" ? group.entryUnderOdds : group.entryOverOdds;
    if (entryOdds === null) {
      excluded.push({
        eventId: group.eventId,
        playerName: group.playerName,
        line: group.line,
        reason: "no_entry_price_for_agreeing_side",
      });
      continue;
    }

    const finalProp = {
      propType: config.mlbMarketType,
      line: group.line,
      odds: entryOdds,
      pickSide: agreeingSide,
      bookmaker: entryBook ?? "",
    };
    const result = config.score({ ...ctxResult.ctx, prop: finalProp } as BatterScoringContext);
    confidence = result.confidence;
    confidencePreCap = result.confidence_pre_cap;
    projectedStat = projectedStatFromScore(config, result);

    const closingOdds = agreeingSide === "over" ? group.closingOverOdds : group.closingUnderOdds;
    const closingBook = agreeingSide === "over" ? group.closingOverBook : group.closingUnderBook;

    const pick: GradedPick = {
      eventId: group.eventId,
      playerId,
      playerName: group.playerName,
      commenceTime: group.commenceTime,
      pickSide: agreeingSide,
      line: group.line,
      entryOdds,
      entryBookmaker: entryBook ?? "",
      otherSideEntryOdds,
      closingOdds,
      closingBookmaker: closingBook,
      confidence,
      confidencePreCap,
      projectedStat,
      contextCompleteness: ctxResult.completeness,
      suppressedLeakRiskFactors: ctxResult.suppressedLeakRiskFactors ?? [],
      actualStat: null,
      hit: null,
      voided: false,
      ...scorerEvFields(result),
    };
    if (ctxResult.statcastReconstructed) statcastReconstructedCount++;
    pendingGrade.push({ pick, playerId, gamePk: gamePkIndex.get(group.eventId) ?? null });
  }

  logExclusionCounts(excluded, pendingGrade.length, statcastReconstructedCount);
  const graded = await gradePendingPicks(db, config, pendingGrade);
  return {
    picks: graded.picks,
    excluded,
    statcastCount: statcastReconstructedCount,
  };
}

function logExclusionCounts(
  excluded: ExcludedCandidate[],
  scoredN: number,
  statcastN: number,
): void {
  const byReason = new Map<string, number>();
  for (const e of excluded) {
    byReason.set(e.reason, (byReason.get(e.reason) ?? 0) + 1);
  }
  const parts = [...byReason.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([r, n]) => `${r}=${n}`);
  console.log(
    `[harness] Pre-grade: scored=${scoredN} statcastAsOf=${statcastN} excluded: ${parts.join(" ") || "none"}`,
  );
}

async function runPickHistoryBacktest(
  config: MarketConfig,
  args: Record<string, string>,
): Promise<void> {
  const db = getDbFromEnv();
  try {
    console.log(`[harness] Market: ${config.cliMarket} | source: pick_history (CLV N/A)`);
    console.log(
      "[harness] Loading MLB weights from algorithm_weights (shipped, fixed model — no refitting in Phase 1)...",
    );
    const { global, perMarket } = await loadMlbWeightsWithPerMarket(db);
    setMlbWeightsWithPerMarket(global, perMarket);
    setActiveMarket(config.mlbMarketType);
    applyScoringKnobs(args, config.mlbMarketType);

    console.log(`[harness] Detecting pick_history coverage for ${config.mlbMarketType}...`);
    const phCoverage = await detectPickHistoryCoverage(db, config.mlbMarketType);
    console.log(
      `[harness] pick_history coverage: ${phCoverage.minGameDate ?? "none"} -> ${phCoverage.maxGameDate ?? "none"} (${phCoverage.rowCount} rows)`,
    );
    if (!phCoverage.minGameDate || !phCoverage.maxGameDate || phCoverage.rowCount === 0) {
      console.error(
        `[harness] No pick_history rows for mlb_market_type=${config.mlbMarketType}. ` +
          "Ensure harness_readonly has SELECT on pick_history.",
      );
      Deno.exit(1);
    }

    const startDate = args.start ?? phCoverage.minGameDate;
    const endDate = args.end ?? phCoverage.maxGameDate;
    const windowStartIso = new Date(startDate).toISOString();
    const windowEndIso = new Date(new Date(endDate).getTime() + 24 * 60 * 60 * 1000).toISOString();

    console.log(`[harness] Running window: ${startDate} -> ${endDate}`);
    const universe = await loadPickHistoryUniverse(db, config.mlbMarketType, startDate, endDate);
    let candidates = universe.candidates;
    const limit = args.limit ? parseInt(args.limit, 10) : 0;
    if (limit > 0) candidates = candidates.slice(0, limit);
    console.log(
      `[harness] pick_history candidates: ${candidates.length} (from ${universe.totalRowsFetched} raw rows)`,
    );

    const minCompleteness = args["min-completeness"] ? parseFloat(args["min-completeness"]) : 0;

    console.log("[harness] Resolving events from cache_mlb_historical_events...");
    const eventIndex = await buildEventLookupIndex(
      db,
      candidates.map((c) => ({
        gameDate: c.gameDate,
        team: c.team,
        opponent: c.opponent,
        isHome: c.isHome,
      })),
    );

    for (const c of candidates) {
      const ev = eventIndex.get(eventLookupKey(c.gameDate, c.team, c.opponent, c.isHome));
      if (ev) {
        c.eventId = ev.eventId;
        c.commenceTime = ev.commenceTime;
        c.homeTeam = ev.homeTeam;
        c.awayTeam = ev.awayTeam;
        c.gamePk = ev.gamePk;
      }
    }

    console.log("[harness] Building player-name -> player_id index...");
    const nameIndex = await buildPlayerNameIndex(db, startDate, endDate);

    const { picks, excluded, statcastCount } = await scorePickHistoryCandidates(
      db,
      config,
      candidates,
      nameIndex,
      minCompleteness,
    );

    const playersResolved = candidates.length -
      excluded.filter((e) => e.reason === "player_unresolved").length;
    const playersUnresolved = excluded.filter((e) => e.reason === "player_unresolved").length;

    const report = buildReport(
      picks,
      excluded,
      universe.totalRowsFetched,
      candidates.length,
      playersResolved,
      playersUnresolved,
      windowStartIso,
      windowEndIso,
      { minCommenceTime: windowStartIso, maxCommenceTime: windowEndIso },
      statcastCount,
      {
        market: config.cliMarket,
        dataSource: "pick_history",
        clvStatus: "na",
        d784CeilingOver: config.calibrationSanity?.ceilingOver,
        d784CeilingUnder: config.calibrationSanity?.ceilingUnder,
      },
    );

    const outBase = `${config.cliMarket}_pick_history_${startDate}_to_${endDate}`;
    await saveReportOutputs(report, args, outBase);
    printSummary(report);
  } catch (e) {
    console.error("[harness] FATAL:", e);
    throw e;
  } finally {
    await closePool();
  }
}

async function scorePickHistoryCandidates(
  db: ReturnType<typeof getDbFromEnv>,
  config: MarketConfig,
  candidates: PickHistoryCandidate[],
  nameIndex: Awaited<ReturnType<typeof buildPlayerNameIndex>>,
  minCompleteness: number,
): Promise<{ picks: GradedPick[]; excluded: ExcludedCandidate[]; statcastCount: number }> {
  const excluded: ExcludedCandidate[] = [];
  const resolved: Array<{ c: PickHistoryCandidate; playerId: number }> = [];

  for (const c of candidates) {
    if (!c.eventId || !c.commenceTime) {
      excluded.push({
        eventId: c.pickId,
        playerName: c.playerName,
        line: c.line,
        reason: "event_not_found",
        detail: `${c.gameDate} ${c.team} vs ${c.opponent}`,
      });
      continue;
    }
    const pid = resolvePlayerId(c.playerName, nameIndex);
    if (pid === null) {
      excluded.push({ eventId: c.eventId, playerName: c.playerName, line: c.line, reason: "player_unresolved" });
      continue;
    }
    resolved.push({ c, playerId: pid });
  }

  console.log(
    config.contextKind === "batter"
      ? "[harness] Building Statcast AS-OF index..."
      : "[harness] Preparing pitcher context caches...",
  );
  const statcastIndex = config.contextKind === "batter"
    ? await buildStatcastAsOfIndex(db, resolved.map((r) => r.playerId))
    : null;

  console.log(
    `[harness] Scoring ${resolved.length} candidates through the real scorer (strict leak-safe context)...`,
  );
  const batterCaches = newRouterCaches();
  const pitcherCaches = newPitcherRouterCaches();
  const pendingGrade: Array<{ pick: GradedPick; playerId: number; gamePk: number | null }> = [];
  let statcastReconstructedCount = 0;
  let processed = 0;

  for (const { c, playerId } of resolved) {
    processed++;
    logScoringProgress(processed, resolved.length);
    let ctxResult: {
      completeness: number;
      suppressedLeakRiskFactors?: string[];
      statcastReconstructed?: boolean;
      ctx: BatterScoringContext | Omit<PitcherKScoringContext, "prop">;
    } | null = null;
    try {
      if (config.contextKind === "pitcher") {
        const pConfig = config as PitcherMarketConfig;
        if (pConfig.pitcherRouter === "outs") {
          const pCtx = await buildLeakSafePitcherOutsContext(
            db,
            c.eventId!,
            playerId,
            c.playerName,
            c.gameDate,
            c.isHome,
            c.gamePk,
            pitcherCaches,
          );
          if (!pCtx) {
            excluded.push({
              eventId: c.eventId!,
              playerName: c.playerName,
              line: c.line,
              reason: "context_build_failed",
              detail: "pitcher_outs context unavailable",
            });
            continue;
          }
          ctxResult = { ...pCtx, ctx: pCtx.ctx };
        } else {
          const pCtx = await buildLeakSafePitcherKContext(db, c.eventId!, playerId, pitcherCaches);
          ctxResult = { ...pCtx, ctx: pCtx.ctx };
        }
      } else {
        const bCtx = await buildLeakSafeBatterContext(
          db,
          c.eventId!,
          playerId,
          batterCaches,
          statcastIndex!,
          c.gameDate,
        );
        ctxResult = { ...bCtx, ctx: bCtx.ctx };
      }
    } catch (e) {
      excluded.push({
        eventId: c.eventId!,
        playerName: c.playerName,
        line: c.line,
        reason: "context_build_failed",
        detail: String(e),
      });
      continue;
    }
    if (ctxResult.completeness < minCompleteness) {
      excluded.push({
        eventId: c.eventId!,
        playerName: c.playerName,
        line: c.line,
        reason: "context_build_failed",
        detail: `completeness ${ctxResult.completeness} < min ${minCompleteness}`,
      });
      continue;
    }

    const prop = {
      propType: config.mlbMarketType,
      line: c.line,
      odds: c.entryOdds,
      pickSide: c.pickSide,
      bookmaker: "",
    };
    const result = config.contextKind === "pitcher"
      ? (config as PitcherMarketConfig).score({ ...ctxResult.ctx, prop } as PitcherKScoringContext)
      : config.score({ ...ctxResult.ctx, prop } as BatterScoringContext);

    const pick: GradedPick = {
      eventId: c.eventId!,
      playerId,
      playerName: c.playerName,
      commenceTime: c.commenceTime!,
      pickSide: c.pickSide,
      line: c.line,
      entryOdds: c.entryOdds,
      entryBookmaker: "",
      otherSideEntryOdds: null,
      closingOdds: null,
      closingBookmaker: null,
      confidence: result.confidence,
      confidencePreCap: result.confidence_pre_cap,
      projectedStat: projectedStatFromScore(config, result),
      contextCompleteness: ctxResult.completeness,
      suppressedLeakRiskFactors: ctxResult.suppressedLeakRiskFactors ?? [],
      actualStat: null,
      hit: null,
      voided: false,
      ...scorerEvFields(result),
    };
    if (ctxResult.statcastReconstructed) statcastReconstructedCount++;
    pendingGrade.push({ pick, playerId, gamePk: c.gamePk });
  }

  logExclusionCounts(excluded, pendingGrade.length, statcastReconstructedCount);
  const graded = await gradePendingPicks(db, config, pendingGrade);
  return {
    picks: graded.picks,
    excluded,
    statcastCount: statcastReconstructedCount,
  };
}

async function gradePendingPicks(
  db: ReturnType<typeof getDbFromEnv>,
  config: MarketConfig,
  pendingGrade: Array<{ pick: GradedPick; playerId: number; gamePk: number | null }>,
): Promise<{ picks: GradedPick[]; excluded: ExcludedCandidate[] }> {
  console.log(`[harness] Fetching outcomes for grading (${pendingGrade.length} scored picks)...`);
  const pairs = pendingGrade
    .filter((p) => p.gamePk !== null)
    .map((p) => ({ playerId: p.playerId, gamePk: p.gamePk as number }));
  const outcomes = await fetchPlayerOutcomes(db, pairs, config.gradeColumn);

  const picks: GradedPick[] = [];
  for (const { pick, playerId, gamePk } of pendingGrade) {
    if (gamePk === null) {
      pick.voided = true;
      pick.voidReason = "event_missing_game_pk";
      picks.push(pick);
      continue;
    }
    const actualStat = outcomes.get(`${playerId}|${gamePk}`) ?? null;
    pick.actualStat = actualStat;
    const grade = gradePick(actualStat, pick.line, pick.pickSide);
    pick.hit = grade.hit;
    pick.voided = grade.voided;
    pick.voidReason = grade.voidReason;
    picks.push(pick);
  }
  return { picks, excluded: [] };
}

async function main() {
  const args = parseArgs(Deno.args);
  const marketArg = args.market ?? "batter_hits";
  let config: MarketConfig;
  try {
    config = getMarketConfig(marketArg);
  } catch (e) {
    console.error(String(e));
    console.error(`Valid markets: ${listCliMarkets().join(", ")}`);
    Deno.exit(1);
  }

  let source;
  try {
    source = resolveDataSource(config, args.source);
  } catch (e) {
    console.error(String(e));
    Deno.exit(1);
  }

  if (source === "pick_history") {
    await runPickHistoryBacktest(config, args);
  } else {
    await runWarehouseBacktest(config, args);
  }
}

if (import.meta.main) {
  main().catch((e) => {
    console.error("[harness] FATAL:", e);
    Deno.exit(1);
  });
}

export { main, parseArgs, runWarehouseBacktest, runPickHistoryBacktest };
