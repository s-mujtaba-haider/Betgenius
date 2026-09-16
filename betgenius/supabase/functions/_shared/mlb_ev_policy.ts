/** 
 * Production recommendation_shown policy for MLB. Shared by process-games-mlb
 * and the harness shown-slice replay so side/veto rules cannot drift.
 * 
 * V2 ML Policy Engine: Deprecated static vetoes in favor of dynamic EV math.
 */

import { notify } from "./notify.ts";
import { evaluateMarketGate, type MarketGateMetrics } from "./market_gate.ts";

export function mlbRecommendationShown(
  market: string,
  pickSide: string,
  marketWinRate: number,
  decimalOdds: number,
  oddsUpdatedAt: string | null,
  marketGateMetrics: MarketGateMetrics | null
): boolean {
  if (!oddsUpdatedAt) return false;

  // CRITICAL FAIL-SAFE: Stale Odds Threshold
  const ageMs = Date.now() - new Date(oddsUpdatedAt).getTime();
  if (ageMs > 10 * 60 * 1000) { // 10 minutes
    console.warn(`[EV_POLICY] Stale odds detected for ${market} ${pickSide}. Age: ${Math.round(ageMs/1000)}s`);
    
    // Route alert for chronic staleness using market/pickSide via notify()
    notify({ severity: 'warning', title: 'Stale Odds', message: `Stale Odds Alert for ${market} ${pickSide}. Odds age > 10m. EV evaluation blocked.` });

    // Force false on latent lines to prevent phantom value bets and adverse selection
    return false;
  }

  // Explicit dependency: Market Gate MUST pass for this market.
  // We fail safely if metrics are missing.
  if (!marketGateMetrics) {
    console.warn(`[EV_POLICY] Missing market gate metrics for ${market}. Failing safely.`);
    return false;
  }
  
  const gateResult = evaluateMarketGate(marketGateMetrics);
  if (!gateResult.pass) {
    console.warn(`[EV_POLICY] Market gate failed for ${market}: ${gateResult.reasons.join(', ')}`);
    return false;
  }

  // Expected Value = (Probability of Win * Profit if Win) - (Probability of Loss * Stake)
  // Simplified for decimal odds: EV = (P(Win) * Odds) - 1.0
  const expectedValue = (marketWinRate * decimalOdds) - 1.0;
  
  // Flag true ONLY if mathematically positive
  return expectedValue > 0.005; // 0.5% EV buffer margin
}
