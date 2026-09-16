// Phase 1 backtest harness — leak-safe point-in-time context for
// batter_runs_scored (re-exports the shared batter context module).

export {
  buildLeakSafeBatterContext as buildLeakSafeRunsContext,
  newRouterCaches,
  type BatterContextResult as RunsContextResult,
} from "./context_batter.ts";
