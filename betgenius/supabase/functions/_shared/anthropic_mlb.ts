// _shared/anthropic_mlb.ts — D-229 Fix 4 + D-230 Fix 2.
//
// MLB-specific Sonnet 4.6 commentary generator for process-games-mlb.
// 4-persona rotation (D-230 Fix 2) matches NBA pattern at
// process-games/index.ts:1510 ANALYST_PERSONAS:
//   0. Sharp bettor — aggressive edge-finder
//   1. Ex-MLB player — situational baseball IQ
//   2. Quant analyst — projection-first, sample-size aware
//   3. Veteran baseball handicapper — line movement + park/weather aware
// Rotation: deterministic by (event_id + market + player) hash.
//
// Graceful degradation: returns null when ANTHROPIC_API_KEY missing
// OR when API call fails. Caller falls back to the deterministic
// template string already in place.

import { logSonnetUsage } from "./sonnet_usage_log.ts";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") || "";
const MODEL = "claude-sonnet-4-6";

// D-230 Fix 2 — 4 MLB-flavored personas. Mirrors NBA pattern but with
// baseball-specific framing (pitcher tells, ballpark factors, weather,
// lineup K-rate). Each ~1 line system prompt; the prompt body below
// supplies the per-pick data.
// D-273-FOLLOWUP-HALLUCINATION (2026-05-20): persona rewrites to stop
// model from inventing context. Pre-fix personas explicitly primed
// xERA/BABIP/clubhouse references → audit found 28% MLB SUSPECT rate
// when those values weren't in the PICK block. New personas describe
// voice + tone only; specific data categories MUST come from the
// PICK block per RULE 0 (see prompt body below).
const ANALYST_PERSONAS_MLB = [
  "You are a sharp baseball bettor writing for a premium betting Discord. Be direct, opinionated, use conviction language. Cite hit-rate counts not percentages (say 'hit in 7 of 10' not '70%'). No hedging. End with TAKE, LEAN, or FADE.",
  "You are a former MLB player turned analyst. Keep it grounded in baseball reality but stay strictly within the values provided. Reference ONLY the matchup context listed in the PICK block. End with TAKE, LEAN, or FADE.",
  "You are a quantitative baseball analyst. Lead with projection edge and sample size from the PICK block. Use only the metrics explicitly listed — never invent xERA, BABIP, or other stats not provided. Precise but readable. End with TAKE, LEAN, or FADE.",
  "You are a veteran baseball handicapper with 20+ years on the books. Cut through the noise. Reference only the line, projection, and context values in the PICK block. Short, punchy. End with TAKE, LEAN, or FADE.",
];

function getPersonaIndex(seed: string): number {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = ((h << 5) - h) + seed.charCodeAt(i);
  return Math.abs(h) % ANALYST_PERSONAS_MLB.length;
}

export interface MlbPickContext {
  market: "pitcher_k" | "pitcher_outs" | "batter_hits" | "batter_hr" | "batter_total_bases" | "batter_rbis" | "batter_strikeouts" | "batter_runs_scored" | "game_side" | "game_total";
  playerName: string;
  team: string | null;
  opponent: string | null;
  isHome: boolean | null;
  propType: string;
  line: number;
  pickSide: string;
  odds: number;
  confidence: number;
  verdict: string;
  projectedStat: number;
  seasonAvg: number;
  recentAvg: number;
  edge: number;
  breakdown: Record<string, number | string>;
}

function describeMarket(market: MlbPickContext["market"]): string {
  switch (market) {
    case "pitcher_k": return "pitcher strikeouts";
    case "pitcher_outs": return "pitcher outs recorded";  // D-476
    case "batter_hits": return "batter hits";
    case "batter_hr": return "batter home runs";
    case "batter_total_bases": return "batter total bases";
    case "batter_rbis": return "batter RBIs";
    case "batter_strikeouts": return "batter strikeouts";  // D-474
    case "batter_runs_scored": return "batter runs scored";  // D-475
    case "game_side": return "game side";
    case "game_total": return "game total runs";
  }
}

function describeKeyFactors(breakdown: Record<string, number | string>): string {
  const numeric = Object.entries(breakdown).filter(([_, v]) => typeof v === "number" && Math.abs(v as number) >= 3);
  return numeric.length > 0
    ? numeric.map(([k, v]) => `${k}=${v}`).join(", ")
    : "no dominant factors";
}

// D-636 — Descriptive line-movement + sharp-money context for the
// Sonnet write-up. Both signals are SCORING WEIGHT 0 (measure-only)
// but inform the narrative when populated. Returns null when no
// usable signal exists; the caller then omits the whole line.
function describeMarketSignals(breakdown: Record<string, unknown>): string | null {
  const parts: string[] = [];
  const mag = String(breakdown.lm_magnitude ?? "");
  const opened = breakdown.lm_opened_odds;
  const current = breakdown.lm_current_odds;
  const toward = breakdown.lm_toward_pick;
  if ((mag === "mild" || mag === "moderate" || mag === "strong")
    && opened !== null && opened !== undefined
    && current !== null && current !== undefined) {
    const dir = toward === true ? "toward this side"
              : toward === false ? "away from this side"
              : "unclear direction";
    parts.push(`line ${opened} → ${current} (${mag} ${dir})`);
  }
  const rlmStatus = String(breakdown.rlm_status ?? "");
  if (rlmStatus === "rlm_toward_pick") {
    parts.push(`reverse line movement points to this side (${breakdown.rlm_n_books_toward ?? 0}/${breakdown.rlm_n_books ?? 0} books tightened, avg ${breakdown.rlm_avg_odds_delta ?? 0}¢)`);
  } else if (rlmStatus === "rlm_away_from_pick") {
    parts.push(`reverse line movement points away from this side (${breakdown.rlm_n_books_away ?? 0}/${breakdown.rlm_n_books ?? 0} books lengthened, avg ${breakdown.rlm_avg_odds_delta ?? 0}¢)`);
  }
  if (breakdown.steam_detected === true) {
    const dir = String(breakdown.steam_direction ?? "");
    if (dir === "toward") parts.push(`STEAM detected: ${breakdown.rlm_n_books_toward ?? 0} books moved 5¢+ toward this side`);
    else if (dir === "away") parts.push(`STEAM detected: ${breakdown.rlm_n_books_away ?? 0} books moved 5¢+ away`);
  }
  return parts.length > 0 ? parts.join("; ") : null;
}

// D-233 — confidence threshold below which Sonnet is gated. Picks at
// Lean (60-69) or Pass (<60) tiers fall back to the v1 template
// immediately, no API call. ~70% of picks per slate are sub-70 tier
// → previously consumed >70% of the 150s per-cron budget on Sonnet
// calls that the subscriber doesn't act on anyway. Gate moves player-
// prop buckets (pitcher_k + 4 batter markets) inside budget so all
// 7 markets land picks every cron tick (D-232 disclosed gap).
const SONNET_CONFIDENCE_GATE = 70;

export async function getMlbPickCommentary(ctx: MlbPickContext): Promise<string | null> {
  if (!ANTHROPIC_API_KEY) return null;

  // D-233 — gate. Below-threshold picks → null → caller's v1 template.
  // D-261 — was previously written to error_log as "sonnet_gated_below_70".
  // 14,819 of 14,820 (99.99%) anthropic_mlb error_log rows over 7 days
  // were this INFO-level telemetry polluting error-rate metrics. Gate
  // ratio is still observable from the recommendations table (any pick
  // with confidence<70 was gated by definition — no separate write
  // needed). Kept as console.log for ephemeral runtime visibility in
  // `supabase functions logs`, removed from error_log.
  if (ctx.confidence < SONNET_CONFIDENCE_GATE) {
    console.log(
      `[anthropic_mlb] sonnet_gated_below_70 market=${ctx.market} player=${ctx.playerName} conf=${ctx.confidence}`,
    );
    return null;
  }

  // D-326 SHIP 2 — pre-flight dedup. Closes d310 GAP-2 (~80-120 wasted
  // Sonnet calls/day from same canonical pick being regenerated within
  // a slate run). Match recommendations_cache on
  // (player_name, prop_type, line, pick_side) AND created_at within
  // last 30 minutes AND ai_analysis not null. Same-day uniqueness
  // already implicit because process-games-mlb runs against today's
  // slate only. If a match exists, reuse instead of calling Sonnet.
  // Best-effort: any failure here falls through to the live API call
  // so we don't regress availability.
  const cached = await fetchCachedAiAnalysis(ctx);
  if (cached) {
    console.log(
      `[anthropic_mlb] sonnet_dedup_hit market=${ctx.market} player=${ctx.playerName} line=${ctx.line} side=${ctx.pickSide}`,
    );
    return cached;
  }

  const marketLabel = describeMarket(ctx.market);
  const sideUpper = ctx.pickSide.toUpperCase();
  const oppLabel = ctx.opponent ?? "the opponent";
  const venueLabel = ctx.isHome === true ? "vs" : ctx.isHome === false ? "@" : "";

  // D-230 Fix 2 — rotate persona by (player + market + line) hash.
  // Deterministic so the same pick always gets the same persona across
  // re-runs (audit consistency). Across the slate, the 4 personas
  // distribute uniformly because the hash space is large.
  const personaSeed = `${ctx.playerName}|${ctx.market}|${ctx.line}`;
  const persona = ANALYST_PERSONAS_MLB[getPersonaIndex(personaSeed)];

  // D-270-C2 — game-level markets (game_side / game_total) take a
  // different prompt shape: there's no "player line / hit rate" — we
  // pass team scoring context (RPG, RAPG, bullpen ERA, projected runs,
  // park / weather). Player-prop prompt unchanged.
  const isGameMarket = ctx.market === "game_side" || ctx.market === "game_total";
  let prompt: string;
  if (isGameMarket) {
    const homeRpg = ctx.breakdown?.home_rpg ?? "?";
    const awayRpg = ctx.breakdown?.away_rpg ?? "?";
    const homeRapg = ctx.breakdown?.home_rapg ?? "?";
    const awayRapg = ctx.breakdown?.away_rapg ?? "?";
    const homeSpEra = ctx.breakdown?.home_pitcher_era ?? "?";
    const awaySpEra = ctx.breakdown?.away_pitcher_era ?? "?";
    const homeBpEra = ctx.breakdown?.home_bullpen_era ?? "?";
    const awayBpEra = ctx.breakdown?.away_bullpen_era ?? "?";
    const parkRunsFactor = ctx.breakdown?.park_runs_factor ?? 1.0;
    const projHomeRuns = ctx.breakdown?.proj_home_runs ?? "?";
    const projAwayRuns = ctx.breakdown?.proj_away_runs ?? "?";
    const projTotal = ctx.breakdown?.proj_total ?? "?";
    const projDiff = ctx.breakdown?.proj_diff ?? "?";
    const tempF = ctx.breakdown?.weather_temp_f ?? "?";
    const windMph = ctx.breakdown?.weather_wind_mph ?? "?";
    // D-649 — team-level offense quality. Persisted unconditionally by
    // scoring_mlb_v2.ts so Sonnet sees the underlying offense even when
    // v2-promote flag is OFF. League OPS ≈ 0.720, league team K-rate ≈ 0.230.
    const homeOps = ctx.breakdown?.home_ops_season ?? "?";
    const awayOps = ctx.breakdown?.away_ops_season ?? "?";
    const homeKRate = ctx.breakdown?.home_k_rate ?? "?";
    const awayKRate = ctx.breakdown?.away_k_rate ?? "?";

    // D-375 SHIP 3 — anchor home/away by ACTUAL team name in every line so
    // Sonnet cannot mis-resolve which team is home. Previously the prompt used
    // generic "home X / away X" labels and a matchup string that listed the
    // PICKED team first; for away-side picks that put the away team in the
    // "home" slot of the natural English reading, and Sonnet inverted the
    // team-to-stat mapping (the D-273 narrative-class bug surfaced again on
    // 2026-05-30 in ATL@CIN and MIN@PIT cards).
    const homeTeamName = ctx.isHome === true ? (ctx.team ?? "home") : (ctx.opponent ?? "home");
    const awayTeamName = ctx.isHome === true ? (ctx.opponent ?? "away") : (ctx.team ?? "away");
    const pickedTeamName = ctx.market === "game_side"
      ? (ctx.pickSide === "home" ? homeTeamName : awayTeamName)
      : null;  // game_total picks are over/under, not a team
    const pickLine = ctx.market === "game_side"
      ? `${pickedTeamName} ${ctx.line >= 0 ? "+" : ""}${ctx.line}`
      : `${sideUpper} ${ctx.line}`;

    prompt = `${persona}

PICK:
- Market: ${marketLabel} (${ctx.market})
- Matchup: ${awayTeamName} (away) @ ${homeTeamName} (home)
- Pick: ${pickLine} at ${ctx.odds > 0 ? "+" : ""}${ctx.odds}
- Algorithm confidence: ${ctx.confidence}/100 (${ctx.verdict})
- Projection: ${homeTeamName} ${projHomeRuns} runs, ${awayTeamName} ${projAwayRuns} runs (total ${projTotal}, diff ${projDiff}); edge ${ctx.edge >= 0 ? "+" : ""}${ctx.edge.toFixed(2)}
- Team offense (RPG): ${homeTeamName} ${homeRpg} · ${awayTeamName} ${awayRpg}
- Team OPS (season): ${homeTeamName} ${homeOps} · ${awayTeamName} ${awayOps} (league ~0.720)
- Team K-rate (season): ${homeTeamName} ${homeKRate} · ${awayTeamName} ${awayKRate} (league ~0.230)
- Team pitching (RAPG): ${homeTeamName} ${homeRapg} · ${awayTeamName} ${awayRapg}
- Starters ERA: ${homeTeamName} ${homeSpEra} · ${awayTeamName} ${awaySpEra}
- Bullpens ERA: ${homeTeamName} ${homeBpEra} · ${awayTeamName} ${awayBpEra}
- Park runs factor: ${parkRunsFactor} (1.0 = neutral; >1 favors offense)
- Weather: ${tempF}F, wind ${windMph} mph${(() => {
  const sigs = describeMarketSignals(ctx.breakdown as unknown as Record<string, unknown>);
  return sigs ? `\n- Market signals (informational, NOT in confidence math): ${sigs}` : "";
})()}

RULES:
0. Cite ONLY values provided in the PICK block above. Do not invent or estimate any statistic, player attribute, weather detail, injury status, or context not listed. Specifically: do not reference xERA, BABIP, FIP, exit velo, batting stance, recent slump/streak, clubhouse dynamics, or any pitcher-rest detail unless those exact values appear in the PICK block.
1. Argue for or against the pick "${pickLine}".
2. When citing a stat, attach it to the team named in the PICK block — never swap the home/away labels.
3. SELF-CHECK before writing: which team has the better starter ERA, the better bullpen ERA, the higher RPG? The algorithm sees the same numbers you do. If you would conclude a different team is favored on the stats, do not invent reasons to disagree — the algorithm already weighted these. You may FADE on PRICE/JUICE/VALUE alone (e.g. "the projected edge does not justify -350 juice") but DO NOT contradict the stat-favored team. Narrative must be consistent with the stats; verdict may differ on price.
4. Never invent stats — use only the values above.
5. If a "Market signals" line is present, mention the line movement or RLM/steam direction briefly as ancillary context (e.g. "line ticked toward this side" or "sharp action away"). Do NOT let it override the stat-based view; it is informational, not in the confidence math.
6. End with TAKE, LEAN, or FADE.
7. 3-4 sentences max. No markdown, no asterisks, no disclaimers.
8. Vary openings — do not start with the team name verbatim.`;
  } else {
    const last5Pct = ctx.breakdown?.last5_hit_rate_pct ?? null;
    const last10Pct = ctx.breakdown?.last10_hit_rate_pct ?? null;
    const seasonPct = ctx.breakdown?.season_hit_rate_pct ?? null;

    prompt = `${persona}

PICK:
- Market: ${marketLabel}
- Pick: ${ctx.playerName} ${venueLabel} ${oppLabel}, ${sideUpper} ${ctx.line} at ${ctx.odds > 0 ? "+" : ""}${ctx.odds}
- Algorithm confidence: ${ctx.confidence}/100 (${ctx.verdict})
- Projection: ${ctx.projectedStat} (edge ${ctx.edge >= 0 ? "+" : ""}${ctx.edge.toFixed(2)})
- Season-to-date: ${ctx.seasonAvg} per game · last-N: ${ctx.recentAvg}
- Hit rate on this line: L5 ${last5Pct ?? "?"}%, L10 ${last10Pct ?? "?"}%, season ${seasonPct ?? "?"}%
- Key factors: ${describeKeyFactors(ctx.breakdown)}${(() => {
  const sigs = describeMarketSignals(ctx.breakdown as unknown as Record<string, unknown>);
  return sigs ? `\n- Market signals (informational, NOT in confidence math): ${sigs}` : "";
})()}

RULES:
0. Cite ONLY values provided in the PICK block above. Do not invent or estimate any statistic, player attribute, weather detail, injury status, pitcher-rest detail, or context not listed. Specifically: do not reference xERA, BABIP, FIP, exit velo, batting stance, recent slump/streak, clubhouse dynamics, or career milestones unless those exact values appear in the PICK block.
1. Argue for or against the ${sideUpper} at ${ctx.line}.
2. Reference ${oppLabel} by name and cite ONLY the data listed (projection, season/recent averages, hit rates if non-? values were passed, edge).
3. Cite exact hit rates with the windows above — never invent denominators.
4. SELF-CHECK before writing: do the L5/L10/season hit rates, projection edge, season-to-date average, and key factors support the ${sideUpper} side at ${ctx.line}? The algorithm sees the same numbers you do. If you would conclude the other side is favored on the stats, do not invent reasons to disagree — the algorithm already weighted these. You may FADE on PRICE/JUICE/VALUE alone (e.g. "the projected edge does not justify -350 juice") but DO NOT contradict the stat-favored side. Narrative must be consistent with the stats; verdict may differ on price.
5. If a "Market signals" line is present, mention the line movement or RLM/steam direction briefly as ancillary context (e.g. "line ticked toward this side" or "sharp action away"). Do NOT let it override the stat-based view; it is informational, not in the confidence math.
6. End with TAKE, LEAN, or FADE.
7. 3-4 sentences max. No markdown, no asterisks, no disclaimers.
8. Never start with the player's full name — vary openings.`;
  }

  // D-232 Fix 1 — bound every Sonnet call to 12s max. Pre-D-232 the
  // fetch had no timeout; if Anthropic API was slow from the Supabase
  // Edge environment, each per-pick call could hang indefinitely.
  // With ~600 batter picks per MLB slate × hung-call duration, the
  // function blew past the 150s IDLE_TIMEOUT before writing anything
  // (D-231 root cause). Timeout fires AbortError → catch → null →
  // caller falls back to the v1 template string.
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 12_000);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        // D-465: bump 220 -> 350 for sentence-rule parity with NBA (D-453).
        // NBA bumped 250 -> 350 in D-453 paired with "3-4 sentences max";
        // D-464 found MLB still at 220 / "2-3 sentences" — this aligns both.
        max_tokens: 350,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!res.ok) {
      // D-458: capture Anthropic's response body (typically JSON with
      // error.type + error.message explaining WHY the call was rejected).
      // First 500 chars suffices for typical Anthropic error envelopes.
      let bodyText = "";
      try { bodyText = (await res.text()).substring(0, 500); } catch { /* swallow */ }
      await elog("sonnet_http_error", {
        severity: "error",
        status: res.status,
        body: bodyText,
        market: ctx.market,
        player: ctx.playerName,
      });
      return null;
    }
    const data = await res.json();
    // D-463 — best-effort capture of Anthropic usage block for ground-truth
    // spend accounting. Swallowed on failure (helper handles its own catch).
    await logSonnetUsage("mlb_pick", MODEL, data.usage, {
      market: ctx.market,
      player: ctx.playerName,
      confidence: ctx.confidence,
    });
    const text = data.content?.[0]?.text;
    if (!text) return null;
    return text.replace(/\*\*/g, "").replace(/\*/g, "").replace(/##/g, "").replace(/#/g, "").trim();
  } catch (err) {
    clearTimeout(timeoutId);
    const isAbort = err instanceof Error && err.name === "AbortError";
    await elog(isAbort ? "sonnet_timeout" : "sonnet_error", {
      severity: "error",
      error: err instanceof Error ? err.message : String(err),
      market: ctx.market,
      player: ctx.playerName,
      prop_type: ctx.propType,
      line: ctx.line,
    });
    return null;
  }
}

// D-326 SHIP 2 — dedup pre-flight. Look up recommendations_cache for a
// recent matching pick with non-null ai_analysis. 30-min window. Same-day
// uniqueness implicit because the slate runner only processes today's
// games. Returns the cached ai_analysis string or null.
//
// D-336 — skip cached templates. Pre-D-336 bug: when a previous cron tick
// produced the deterministic "Algorithm projection" template (because Sonnet
// was gated below conf=70 OR timed out OR errored), the next tick's dedup
// would return that template even when current conf was ≥70 and Sonnet
// would have succeeded. With 30-min cron cadence and a 30-min dedup window,
// the rolling boundary perpetuated templates. ~35% of MLB conf≥70 picks
// were getting ~151-char templates because of this. Fix: treat any cached
// ai_analysis < 200 chars OR containing "Algorithm projection" as cache-miss
// and fall through to a live Sonnet call.
function isTemplateOutput(s: string | null | undefined): boolean {
  if (!s) return true;
  if (s.length < 200) return true;
  if (s.indexOf("Algorithm projection") >= 0) return true;
  return false;
}

async function fetchCachedAiAnalysis(ctx: MlbPickContext): Promise<string | null> {
  try {
    const url = Deno.env.get("SUPABASE_URL");
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key) return null;
    const since = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const q = new URLSearchParams({
      player_name: `eq.${ctx.playerName}`,
      prop_type: `eq.${ctx.propType}`,
      line: `eq.${ctx.line}`,
      pick_side: `eq.${ctx.pickSide}`,
      created_at: `gte.${since}`,
      ai_analysis: "not.is.null",
      order: "created_at.desc",
      limit: "1",
      select: "ai_analysis",
    });
    const r = await fetch(`${url}/rest/v1/recommendations_cache?${q.toString()}`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` },
    });
    if (!r.ok) return null;
    const rows = await r.json() as Array<{ ai_analysis?: string | null }>;
    const cached = rows?.[0]?.ai_analysis ?? null;
    // D-336 — only honor non-template Sonnet narratives.
    if (isTemplateOutput(cached)) return null;
    return cached;
  } catch {
    return null;
  }
}

// D-232 Fix 1 — minimal error_log writer scoped to _shared/anthropic_mlb.
// Best-effort; swallows its own errors so a logging failure can't crash
// the caller's scoring loop.
//
// D-261 — convention: every call MUST include context.severity of
// "error" | "warning" | "info". Downstream error-rate dashboards can
// filter by severity to exclude non-error telemetry from rate metrics.
// INFO-level telemetry should prefer console.log over elog to keep the
// error_log table reserved for actionable errors.
async function elog(errorType: string, context: Record<string, unknown>): Promise<void> {
  try {
    const url = Deno.env.get("SUPABASE_URL");
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key) return;
    await fetch(`${url}/rest/v1/error_log`, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({
        function_name: "_shared/anthropic_mlb",
        phase: "getMlbPickCommentary",
        error_type: errorType,
        error_message: `${errorType}: ${context.market}/${context.player}`,
        context,
      }),
    });
  } catch { /* swallow */ }
}
