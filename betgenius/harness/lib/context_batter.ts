// Phase 1 backtest harness — leak-safe point-in-time context for all
// batter prop markets, built on top of the harness Postgres context router.
//
// See context_runs.ts header for leak-safe / Statcast AS-OF rationale.

import {
  buildBatterHistoricalContext,
  type RouterCaches,
} from "./context_router_batter.ts";
import type { Db } from "./env.ts";
import { lookupStatcastAsOf, type StatcastAsOfIndex } from "./statcast_asof.ts";

/** Insertion-order cap so a 3-year run does not hold 150k contexts in RAM. */
export class BoundedMap<K, V> {
  private m = new Map<K, V>();
  constructor(private max: number) {}
  has(k: K) {
    return this.m.has(k);
  }
  get(k: K) {
    return this.m.get(k);
  }
  set(k: K, v: V) {
    if (this.m.has(k)) {
      this.m.delete(k);
    } else if (this.m.size >= this.max) {
      const oldest = this.m.keys().next().value;
      if (oldest !== undefined) this.m.delete(oldest);
    }
    this.m.set(k, v);
  }
}

export function newRouterCaches(): RouterCaches {
  return {
    events: new Map(),
    lineups: new Map(),
    oppPitcher: new Map(),
    weather: new Map(),
    ballpark: new Map(),
    playerMeta: new Map(),
    pitcherSeason: new Map(),
    boxscoreGameLog: new BoundedMap(4000),
  };
}

const LEAK_RISK_FIELDS = [
  "splits",
  "opposingBullpen",
  "opposingPitcherSplits",
  "opposingPitcherArsenal",
  "nextHittersBehindOps",
  "batterTeamContext",
  "batterSprintSpeed",
  "batterPullRate",
  "batterContactRate",
  "parkDimensions",
] as const;

type BatterHistoricalContextBundle = Awaited<
  ReturnType<typeof buildBatterHistoricalContext>
>;

export interface BatterContextResult {
  ctx: BatterHistoricalContextBundle["ctx"];
  completeness: number;
  missing: string[];
  suppressedLeakRiskFactors: string[];
  leakedFactors: string[];
  statcastReconstructed: boolean;
}

export async function buildLeakSafeBatterContext(
  db: Db,
  eventId: string,
  playerId: number,
  caches: RouterCaches,
  statcastIndex: StatcastAsOfIndex,
  gameDateIso: string,
): Promise<BatterContextResult> {
  const bundle = await buildBatterHistoricalContext(db, eventId, playerId, caches);
  const ctxRec = bundle.ctx as unknown as Record<string, unknown>;

  const suppressed: string[] = [];
  const leaked: string[] = [];
  for (const field of LEAK_RISK_FIELDS) {
    const val = ctxRec[field];
    const isNullish = val === null || val === undefined;
    if (isNullish) {
      suppressed.push(field);
    } else {
      leaked.push(field);
      ctxRec[field] = null;
    }
  }

  const statcast = lookupStatcastAsOf(statcastIndex, playerId, gameDateIso);
  ctxRec["statcast"] = statcast;

  return {
    ctx: bundle.ctx,
    completeness: bundle.completeness,
    missing: bundle.missing,
    suppressedLeakRiskFactors: suppressed,
    leakedFactors: leaked,
    statcastReconstructed: statcast !== null,
  };
}
