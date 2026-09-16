// D-463 — Ground-truth Anthropic spend capture.
//
// Best-effort logger: writes Anthropic's `usage` block + computed cost into
// the sonnet_usage_log table after every successful Sonnet call. Any failure
// here is SWALLOWED — analysis generation must never fail because logging
// failed. Mirrors the established elog() / logError() pattern at each site.
//
// Used by:
//   - _shared/anthropic_mlb.ts          → source='mlb_pick'
//   - process-games/index.ts (NBA player) → source='nba_player'
//   - process-games/index.ts (NBA game)   → source='nba_game'
//   - orchestrator-execute/index.ts       → source='orchestrator'
//
// Rates default to current Sonnet 4.6 (June 2026): $3.00/M input, $15.00/M
// output. Rates are stored per-row so historical cost remains interpretable
// if Anthropic changes pricing.

export interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

const DEFAULT_INPUT_RATE_USD_PER_MTOK = 3.00;
const DEFAULT_OUTPUT_RATE_USD_PER_MTOK = 15.00;

export async function logSonnetUsage(
  source: "mlb_pick" | "nba_player" | "nba_game" | "orchestrator",
  model: string,
  usage: AnthropicUsage | undefined,
  context: Record<string, unknown> = {},
  rates: { input?: number; output?: number } = {},
): Promise<void> {
  try {
    const url = Deno.env.get("SUPABASE_URL");
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key) return;
    if (!usage) return;

    const input_tokens = usage.input_tokens ?? 0;
    const output_tokens = usage.output_tokens ?? 0;
    const cache_creation_input_tokens = usage.cache_creation_input_tokens ?? 0;
    const cache_read_input_tokens = usage.cache_read_input_tokens ?? 0;

    const input_rate = rates.input ?? DEFAULT_INPUT_RATE_USD_PER_MTOK;
    const output_rate = rates.output ?? DEFAULT_OUTPUT_RATE_USD_PER_MTOK;

    const computed_cost_usd =
      (input_tokens * input_rate + output_tokens * output_rate) / 1_000_000;

    await fetch(`${url}/rest/v1/sonnet_usage_log`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        source,
        model,
        input_tokens,
        output_tokens,
        cache_creation_input_tokens,
        cache_read_input_tokens,
        input_rate_usd_per_mtok: input_rate,
        output_rate_usd_per_mtok: output_rate,
        computed_cost_usd,
        context,
      }),
    });
  } catch {
    /* swallow — logging must never block analysis */
  }
}
