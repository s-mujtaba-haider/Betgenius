declare const Deno: any;
// Phase 1 — warehouse backtest loop for h2h / spreads / totals.

import { closePool, getDbFromEnv } from "./env.ts";
import {
  detectGameCoverageWindow,
  loadGameCandidateUniverse,
  type GameCandidateGroup,
} from "./game_candidates.ts";
import { buildLeakSafeGameContext, newGameContextCaches } from "./context_game.ts";
import { getCalibratedMarketWinRate } from "../../supabase/functions/_shared/dynamic_scoring_wrapper.ts";
import { fetchGameOutcomes, gradeGameOutcome } from "./grade_game.ts";
import type { ExcludedCandidate, GradedPick, PickSide } from "./metrics.ts";
import type { GameMarketConfig } from "./market_config.ts";
import { projectedStatFromScore } from "./market_config.ts";
import { buildReport, parseReportFormat, printSummary, writeReportCsv, writeReportJson, writeReportOutputs } from "./report.ts";
import { loadMlbWeightsWithPerMarket } from "./weights_pg.ts";
import {
  setActiveMarket,
  setMlbWeightsWithPerMarket,
  type GameScoringContext,
} from "../../supabase/functions/_shared/scoring_mlb_v2.ts";

const SCORING_PROGRESS_INTERVAL = 50;

function logScoringProgress(processed: number, total: number): void {
  if (processed % SCORING_PROGRESS_INTERVAL === 0 || processed === total) {
    const pct = total > 0 ? ((processed / total) * 100).toFixed(1) : "100.0";
    console.log(`[harness]   scoring ${processed}/${total} (${pct}%)`);
  }
}

function agreeingGameSide(
  kind: GameMarketConfig["gameKind"],
  projectedDiffOrTotal: number,
  line: number,
): PickSide | null {
  if (kind === "totals") {
    if (projectedDiffOrTotal > line) return "over";
    if (projectedDiffOrTotal < line) return "under";
    return null;
  }
  if (projectedDiffOrTotal > line) return "home";
  if (projectedDiffOrTotal < line) return "away";
  return null;
}

function entryForSide(g: GameCandidateGroup, side: PickSide): { odds: number; book: string } | null {
  const homeSide = side === "over" || side === "home";
  const odds = homeSide ? g.entryHomeOrOverOdds : g.entryAwayOrUnderOdds;
  const book = homeSide ? g.entryHomeOrOverBook : g.entryAwayOrUnderBook;
  if (odds === null || !book) return null;
  return { odds, book };
}

function closingForSide(g: GameCandidateGroup, side: PickSide): { odds: number; book: string } | null {
  const homeSide = side === "over" || side === "home";
  const odds = homeSide ? g.closingHomeOrOverOdds : g.closingAwayOrUnderOdds;
  const book = homeSide ? g.closingHomeOrOverBook : g.closingAwayOrUnderBook;
  if (odds === null || !book) return null;
  return { odds, book };
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

export async function runGameWarehouseBacktest(
  config: GameMarketConfig,
  args: Record<string, string>,
): Promise<void> {
  const db = getDbFromEnv();
  try {
    console.log(`[harness] Market: ${config.cliMarket} | source: warehouse | gameKind=${config.gameKind}`);
    console.log(
      "[harness] Loading MLB weights from algorithm_weights (shipped, fixed model — no refitting in Phase 1)...",
    );
    const { global, perMarket } = await loadMlbWeightsWithPerMarket(db);
    setMlbWeightsWithPerMarket(global, perMarket);
    setActiveMarket(config.mlbMarketType);

    console.log(`[harness] Auto-detecting ${config.gameKind} historical-odds coverage...`);
    const coverage = await detectGameCoverageWindow(db, config.gameKind);
    console.log(
      `[harness] Detected coverage: ${(coverage.minCommenceTime as string) ?? "none"} -> ${(coverage.maxCommenceTime as string) ?? "none"} (${coverage.rowCount} rows)`,
    );
    if (!(coverage.minCommenceTime as string) || !(coverage.maxCommenceTime as string) || coverage.rowCount === 0) {
      console.error(`[harness] No ${config.gameKind} rows in cache_mlb_historical_odds.`);
      Deno.exit(1);
    }

    const windowStartIso = args.start ? new Date(args.start).toISOString() : (coverage.minCommenceTime as string);
    const windowEndBase = args.end ? new Date(args.end) : new Date((coverage.maxCommenceTime as string));
    const windowEndIso = new Date(windowEndBase.getTime() + 24 * 60 * 60 * 1000).toISOString();
    const limit = args.limit ? parseInt(args.limit, 10) : 0;

    console.log(`[harness] Running full window chunked: ${windowStartIso} -> ${windowEndIso}`);
    
    let currentStart = new Date(windowStartIso);
    const finalEnd = new Date(windowEndIso);

    const allPicks: GradedPick[] = [];
    const allExcluded: ExcludedCandidate[] = [];
    let totalOddsRowsFetched = 0;
    let totalCandidates = 0;

    while (currentStart < finalEnd) {
      let currentEnd = new Date(currentStart);
      currentEnd.setUTCMonth(currentEnd.getUTCMonth() + 1);
      if (currentEnd > finalEnd) {
        currentEnd = finalEnd;
      }

      const chunkStartIso = currentStart.toISOString();
      const chunkEndIso = currentEnd.toISOString();
      const monthLabel = chunkStartIso.slice(0, 7);

      const monthNum = currentStart.getUTCMonth() + 1;
      if (monthNum === 11 || monthNum === 12 || monthNum === 1 || monthNum === 2 || monthNum === 3) {
        currentStart = currentEnd;
        continue;
      }

      console.log(`[harness] [chunk ${monthLabel}] Fetching candidates for ${chunkStartIso} -> ${chunkEndIso}...`);

      const universe = await loadGameCandidateUniverse(
        db,
        config.gameKind,
        chunkStartIso,
        chunkEndIso,
        {
          maxGroups: limit > 0 ? limit : undefined,
          pageFromEnd: limit > 0 && !args.start,
        },
      );

      let candidates = universe.groups;
      if (limit > 0) candidates = candidates.slice(0, limit);
      
      totalOddsRowsFetched += universe.totalOddsRowsFetched;
      totalCandidates += candidates.length;

      if (candidates.length === 0) {
        console.log(`[harness] [chunk ${monthLabel}] 0 candidates found, skipping scoring.`);
        currentStart = currentEnd;
        if (limit > 0 && totalCandidates >= limit) break;
        continue;
      }

      console.log(`[harness] [chunk ${monthLabel}] Loaded ${candidates.length} candidates, scoring...`);

      const minCompleteness = args["min-completeness"] ? parseFloat(args["min-completeness"]) : 0;
      const caches = newGameContextCaches();
      const chunkExcluded: ExcludedCandidate[] = [];
      const chunkPending: GradedPick[] = [];
      let processed = 0;

      for (const g of candidates) {
        processed++;
        logScoringProgress(processed, candidates.length);
        const label = `${g.awayTeam} @ ${g.homeTeam}`;
        let bundle;
        try {
          bundle = await buildLeakSafeGameContext(
            db,
            g.eventId,
            g.commenceTime,
            g.homeTeam,
            g.awayTeam,
            caches,
          );
        } catch (e) {
          chunkExcluded.push({
            eventId: g.eventId,
            playerName: label,
            line: g.line,
            reason: "context_build_failed",
            detail: e instanceof Error ? e.message : String(e),
          });
          continue;
        }
        if (bundle.completeness < minCompleteness) {
          chunkExcluded.push({
            eventId: g.eventId,
            playerName: label,
            line: g.line,
            reason: "context_build_failed",
            detail: `completeness ${bundle.completeness} < min ${minCompleteness}`,
          });
          continue;
        }

        const dummyPickSide: PickSide = config.gameKind === "totals" ? "over" : "home";
        const dummyProp: GameScoringContext["prop"] = {
          propType: config.propType,
          line: g.line,
          odds: -110,
          pickSide: dummyPickSide,
          bookmaker: "dummy",
        };
        const dummyResult = config.score({ ...bundle.ctx, prop: dummyProp });
        const projected = projectedStatFromScore(config, dummyResult);
        const agreeing = agreeingGameSide(config.gameKind, projected, g.line);
        if (!agreeing) {
          chunkExcluded.push({
            eventId: g.eventId,
            playerName: label,
            line: g.line,
            reason: "no_agreeing_side",
            detail: `projected=${projected} equals line`,
          });
          continue;
        }
        const entry = entryForSide(g, agreeing);
        if (!entry) {
          chunkExcluded.push({
            eventId: g.eventId,
            playerName: label,
            line: g.line,
            reason: "no_entry_price_for_agreeing_side",
          });
          continue;
        }
        const other = entryForSide(
          g,
          agreeing === "over" ? "under" : agreeing === "under" ? "over" : agreeing === "home" ? "away" : "home",
        );
        const closing = closingForSide(g, agreeing);
        const realResult = config.score({
          ...bundle.ctx,
          prop: {
            propType: config.propType,
            line: g.line,
            odds: entry.odds,
            pickSide: agreeing,
            bookmaker: entry.book,
          },
        });

        chunkPending.push({
          eventId: g.eventId,
          playerId: 0,
          playerName: label,
          commenceTime: g.commenceTime,
          pickSide: agreeing,
          line: g.line,
          entryOdds: entry.odds,
          entryBookmaker: entry.book,
          otherSideEntryOdds: other?.odds ?? null,
          closingOdds: closing?.odds ?? null,
          closingBookmaker: closing?.book ?? null,
          confidence: realResult.confidence,
          confidencePreCap: realResult.confidence_pre_cap,
          projectedStat: projectedStatFromScore(config, realResult),
          contextCompleteness: bundle.completeness,
          suppressedLeakRiskFactors: bundle.missing,
          actualStat: null,
          hit: null,
          voided: false,
          winProb: (() => {
            try {
              return getCalibratedMarketWinRate(
                config.cliMarket, 
                realResult.confidence, 
                entry.odds, 
                bundle.ctx, 
                null // varianceRaw - would need DB fetch, but this is a backtest placeholder for now
              );
            } catch(e) { return realResult.confidence / 100; }
          })(),
        });
      }

      console.log(`[harness] [chunk ${monthLabel}] Fetching game outcomes for grading (${chunkPending.length} scored)...`);
      const outcomes = await fetchGameOutcomes(db, chunkPending.map((p) => p.eventId));
      const chunkPicks: GradedPick[] = [];
      for (const pick of chunkPending) {
        const oc = outcomes.get(pick.eventId);
        if (!oc || !oc.gameCompleted) {
          pick.voided = true;
          pick.voidReason = oc ? "game_not_completed" : "no_final_score";
          chunkPicks.push(pick);
          continue;
        }
        const grade = gradeGameOutcome(
          config.gameKind,
          pick.pickSide,
          pick.line,
          oc.homeScore,
          oc.awayScore,
        );
        pick.actualStat = grade.actualStat;
        pick.hit = grade.hit;
        pick.voided = grade.voided;
        pick.voidReason = grade.voidReason;
        chunkPicks.push(pick);
      }

      allPicks.push(...chunkPicks);
      allExcluded.push(...chunkExcluded);
      
      console.log(`[harness] [chunk ${monthLabel}] completed (${processed}/${candidates.length})`);

      currentStart = currentEnd;
      if (limit > 0 && totalCandidates >= limit) break;
    }

    const excludedCounts: Record<string, number> = {};
    for (const e of allExcluded) excludedCounts[e.reason] = (excludedCounts[e.reason] ?? 0) + 1;
    console.log(
      `[harness] Pre-grade: scored=${allPicks.length} excluded: ${JSON.stringify(excludedCounts)}`,
    );

    const startDate = windowStartIso.slice(0, 10);
    const endDate = windowEndIso.slice(0, 10);

    const report = buildReport(
      allPicks,
      allExcluded,
      totalOddsRowsFetched,
      totalCandidates,
      totalCandidates,
      0,
      windowStartIso,
      windowEndIso,
      { minCommenceTime: (coverage.minCommenceTime as string), maxCommenceTime: (coverage.maxCommenceTime as string) },
      0,
      {
        market: config.cliMarket,
        dataSource: "warehouse",
        clvStatus: "computed",
        evGateTier: "ev_pass",
      },
    );
    await saveReportOutputs(report, args, `${config.cliMarket}_${startDate}_to_${endDate}`);
    printSummary(report);
  } catch (e) {
    console.error("[harness] FATAL:", e);
    throw e;
  } finally {
    await closePool();
  }
}
