import { useState } from "react";
import { kellyBreakdown, readBankroll, readKellyFraction, MAX_BET_PCT } from "@/lib/kelly";
import SanityChips, { UnbettableJuiceConfirm, type SanityFlags } from "@/components/SanityChips";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "@/lib/supabase";
import { formatGameTime } from "@/lib/formatGameTime";
import { getLineMovementCaption, getSharpMoneyBadge } from "@/lib/lineMovementDisplay";

interface PickCardProps {
  playerName: string;
  team: string;
  propType: string;
  line: number;
  pickSide: "over" | "under";
  confidenceScore: number;
  hitRates: { l5: string; l10: string; season: string };
  aiAnalysis?: string | null;
  onLogBet: () => void;
  // D-202 (Batch 2 Task 2.4): pass odds + bankroll so card can lead with Kelly.
  // Optional for backwards-compat with existing callers that don't track odds.
  odds?: number;
  evPerUnit?: number | null;
  edgeVsImplied?: number | null;
  winProb?: number | null;
  // Game context
  opponent?: string | null;
  gameTime?: string | null;
  isHome?: boolean | null;
  // D-224 Task 7.1 — sanity flags. All optional for backwards-compat.
  flags?: SanityFlags;
  isAdmin?: boolean;
  // D-631 — UNVALIDATED tag for markets whose -EV verdict was measured on
  // corrupted inputs (pre-D-630 weather/Statcast holes). True = market is
  // shown but tagged "UNVALIDATED" until re-measured on clean post-D-630
  // data (gated on D-630b). False/undefined = confirmed +EV market (clean).
  marketUnvalidated?: boolean;
  // D-635 — optional breakdown JSONB. When present and contains lm_* fields
  // (written by applyLineMovementV2), card renders the line-movement caption.
  // No-op when undefined — backwards-compatible with all existing callers.
  breakdown?: Record<string, unknown> | null;
}

// D-224 — fire-and-forget telemetry on unbettable_juice override.
async function logUnbettableJuiceOverride(playerName: string, line: number, pickSide: string) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/analytics_events`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        event: "unbettable_juice_override",
        metadata: { player_name: playerName, line, pick_side: pickSide },
      }),
    });
  } catch { /* non-fatal */ }
}

export default function PickCard({
  playerName,
  team,
  propType,
  line,
  pickSide,
  confidenceScore,
  hitRates,
  aiAnalysis,
  onLogBet,
  odds,
  opponent,
  gameTime,
  isHome,
  flags,
  isAdmin = false,
  marketUnvalidated = false,
  breakdown,
  evPerUnit,
  edgeVsImplied,
}: PickCardProps) {
  // D-635 — line movement caption derived from breakdown.lm_* fields.
  // D-783-rlm — pass header `odds` so the caption can self-suppress when
  // its anchor book disagrees with the bettable header odds by >10¢.
  const lineMovementCaption = getLineMovementCaption(breakdown, odds ?? null);
  // D-636 — sharp money badge (RLM proxy + steam). Weight 0; descriptive.
  const sharpMoneyBadge = getSharpMoneyBadge(breakdown);
  // D-224 — guard log-bet with confirmation when unbettable_juice_flag fires.
  const [confirmOpen, setConfirmOpen] = useState(false);
  function handleLogBetClick() {
    if (flags?.unbettable_juice_flag) {
      setConfirmOpen(true);
      return;
    }
    onLogBet();
  }
  function confirmLogBet() {
    logUnbettableJuiceOverride(playerName, line, pickSide);
    setConfirmOpen(false);
    onLogBet();
  }
  // D-202 Kelly-first framing. Per Batch 1 Task 1.1 finding:
  //   - Kelly fraction predicts WR better than algorithm tier alone
  //   - 40%+ Kelly bucket → 87.1% WR (n=31)
  //   - 20-40% Kelly → 70.6% WR (n=85)
  //   - 0-5% Kelly → 41.6% WR (n=113, losing badly)
  // Lead the card with Kelly stake recommendation. Demote tier badge to secondary.
  const kelly = odds !== undefined
    ? kellyBreakdown({ confidence: confidenceScore, odds, bankroll: readBankroll(), fraction: readKellyFraction() })
    : null;

  // Same D-101 tier mapping. Demoted to secondary line.
  const label =
    confidenceScore >= 90 ? "Elite Pick"
      : confidenceScore >= 80 ? "Strong Pick"
        : confidenceScore >= 70 ? "Good Pick"
          : confidenceScore >= 60 ? "Lean"
            : "Pass";

  const scoreBgSmall =
    confidenceScore >= 90 ? "bg-amber-500/15 text-amber-300"
      : confidenceScore >= 80 ? "bg-emerald-500/15 text-emerald-400"
        : confidenceScore >= 70 ? "bg-yellow-500/15 text-yellow-400"
          : "bg-zinc-700/30 text-zinc-400";

  // Headline Kelly recommendation strip. Color encodes edge magnitude.
  const kellyColor = !kelly || kelly.finalStake === 0
    ? "bg-zinc-700/30 text-zinc-400 border-zinc-700/40"
    : kelly.rawStakePct >= 40 ? "bg-amber-500/20 text-amber-300 border-amber-500/40"
      : kelly.rawStakePct >= 20 ? "bg-emerald-500/20 text-emerald-400 border-emerald-500/40"
        : kelly.rawStakePct >= 10 ? "bg-blue-500/15 text-blue-300 border-blue-500/30"
          : "bg-zinc-700/30 text-zinc-300 border-zinc-700/40";

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 space-y-4">
      {/* D-202 Kelly-lead header */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-white font-medium truncate">{playerName}</p>
          <p className="text-xs text-zinc-500">{team}</p>
          {opponent && (
            <p className="text-xs text-zinc-400 mt-1">
              {isHome ? "vs" : "@"} {opponent}
              {gameTime && <span className="text-zinc-500 ml-2">{formatGameTime(gameTime)}</span>}
            </p>
          )}
        </div>
        {/* Tier badge is now SMALL + secondary; Kelly is the lead metric below */}
        <div className={`shrink-0 rounded-md px-2 py-1 text-center text-[10px] font-medium uppercase tracking-wide ${scoreBgSmall}`}>
          <span>{label}</span>
          <span className="ml-1.5 text-zinc-500">{confidenceScore}</span>
        </div>
      </div>

      {/* D-202 Kelly stake — THE lead metric per Task 1.1 */}
      {evPerUnit != null && evPerUnit > 0 && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-2 text-sm text-emerald-300">
          Model EV +{evPerUnit.toFixed(2)}u
          {edgeVsImplied != null && (
            <span className="ml-2 text-emerald-200/80">
              ({(edgeVsImplied * 100).toFixed(1)}pp vs implied)
            </span>
          )}
        </div>
      )}
      {kelly && (
        <div className={`rounded-lg border px-4 py-3 ${kellyColor}`}>
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-[10px] uppercase tracking-wide opacity-80">Recommended stake</p>
              <p className="text-2xl font-bold leading-tight">
                {kelly.finalStake > 0 ? `$${kelly.finalStake}` : "$0"}
                <span className="ml-2 text-xs font-normal opacity-70">
                  {kelly.finalStake > 0 ? `(${kelly.fractionMode} Kelly)` : "no edge"}
                </span>
              </p>
            </div>
            {kelly.finalStake > 0 && (
              <div className="text-right text-xs opacity-80" title={`Calibrated win prob ${(kelly.probability*100).toFixed(1)}% vs market break-even ${(kelly.breakEvenProb*100).toFixed(1)}%`}>
                <p>Edge {kelly.edgePct >= 0 ? "+" : ""}{kelly.edgePct.toFixed(1)}pp</p>
                <p>Kelly {kelly.rawStakePct.toFixed(1)}%</p>
                {kelly.capApplied && <p className="text-amber-400">capped @ {(MAX_BET_PCT*100).toFixed(0)}%</p>}
              </div>
            )}
          </div>
          {kelly.finalStake === 0 && (
            <p className="mt-1 text-xs opacity-70">
              Kelly says skip — implied break-even ({(kelly.breakEvenProb*100).toFixed(0)}%) exceeds calibrated WR ({(kelly.probability*100).toFixed(0)}%).
            </p>
          )}
        </div>
      )}

      {/* Prop Info */}
      <div className="flex items-center gap-2">
        <span className="rounded-md bg-zinc-800 px-2.5 py-1 text-xs font-medium text-zinc-300">
          {propType}
        </span>
        {/* D-631 — UNVALIDATED tag for markets that were hidden by the
            old is_sellable filter (verdicts based on broken pre-D-630
            input data: weather 48% / Statcast 28% missing). Surfaced now;
            tag removed per-market as each re-validates +EV on clean
            post-D-630 data (D-630b re-measure). */}
        {marketUnvalidated && (
          <span
            className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-300"
            title="Unvalidated — this market's -EV verdict was measured on broken inputs (D-630 fixed weather/Statcast holes). Awaiting re-measurement on clean data."
          >
            Unvalidated
          </span>
        )}
        <span className="text-sm text-zinc-400">
          {pickSide === "over" ? "Over" : "Under"} {line}
        </span>
        <span
          className={`ml-auto text-xs font-medium ${
            pickSide === "over" ? "text-emerald-400" : "text-red-400"
          }`}
        >
          {pickSide.toUpperCase()}
        </span>
      </div>

      {/* D-635 — line-movement caption. Source-agnostic: reads breakdown.lm_*
          fields written by applyLineMovementV2 from cache_odds_snapshots. */}
      {lineMovementCaption.show && (
        <div
          className={`-mt-1 text-[11px] font-medium ${
            lineMovementCaption.towardPick ? "text-emerald-400/90" : "text-red-400/90"
          }`}
          title="Line movement from earliest snapshot to latest. Source-agnostic — reads normalized cache_odds_snapshots."
        >
          {lineMovementCaption.caption}
        </div>
      )}

      {/* D-636 — sharp money badge (RLM proxy + steam). Weight 0 (measure-only). */}
      {sharpMoneyBadge.show && (
        <div className="-mt-1">
          <span
            className={`inline-block rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
              sharpMoneyBadge.favorsPick
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                : "border-red-500/40 bg-red-500/10 text-red-300"
            }`}
            title={sharpMoneyBadge.tooltip}
          >
            {sharpMoneyBadge.label}
          </span>
        </div>
      )}

      {/* D-266: hide L5/L10/Season for game-level markets (spread, game_total,
          h2h, spreads, totals) — these are team-level outcomes with no
          player hit-rate semantic. Pre-D-266 these rows rendered as
          "L5: N/A · L10: N/A · Season: N/A" which subscriber misread as
          data quality issue. */}
      {!["spread","game_total","h2h","spreads","totals"].includes(propType) && (
        <div className="grid grid-cols-3 gap-3">
          <HitRate label="L5" value={hitRates.l5} />
          <HitRate label="L10" value={hitRates.l10} />
          <HitRate label="Season" value={hitRates.season} />
        </div>
      )}

      {/* AI Analysis */}
      {aiAnalysis && (
        <div className="rounded-lg bg-zinc-800/30 border border-zinc-700/50 p-3">
          <div className="flex items-center gap-1.5 mb-2">
            <svg className="w-4 h-4 text-purple-400" fill="currentColor" viewBox="0 0 20 20" aria-hidden="true">
              <path d="M10 2a1 1 0 011 1v1.323l3.954 1.582 1.599-.8a1 1 0 01.894 1.79l-1.233.616 1.738 5.42a1 1 0 01-.285 1.05A3.989 3.989 0 0115 15a3.989 3.989 0 01-2.667-1.019 1 1 0 01-.285-1.05l1.715-5.349L10 6.477l-3.763 1.105 1.715 5.349a1 1 0 01-.285 1.05A3.989 3.989 0 015 15a3.989 3.989 0 01-2.667-1.019 1 1 0 01-.285-1.05l1.738-5.42-1.233-.617a1 1 0 01.894-1.788l1.599.799L9 4.323V3a1 1 0 011-1z" />
            </svg>
            <span className="text-xs font-medium text-purple-400">AI Analysis</span>
          </div>
          <p className="text-sm text-zinc-400 leading-relaxed">{aiAnalysis}</p>
        </div>
      )}

      {/* D-224 — sanity flag chips */}
      {flags && <SanityChips flags={flags} isAdmin={isAdmin} />}

      {/* Action */}
      <button
        onClick={handleLogBetClick}
        className="w-full rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-700 hover:text-white"
      >
        Log Bet
      </button>

      {/* D-224 — unbettable_juice_flag confirmation modal */}
      <UnbettableJuiceConfirm
        open={confirmOpen}
        onConfirm={confirmLogBet}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}

function HitRate({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-zinc-800/50 px-3 py-2 text-center">
      <p className="text-[10px] text-zinc-500 uppercase tracking-wide">{label}</p>
      <p className="text-sm font-semibold text-zinc-200">{value}</p>
    </div>
  );
}
