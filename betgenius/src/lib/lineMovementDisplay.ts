// D-635 — Line movement display helper.
// Reads the lm_* breakdown fields written by applyLineMovementV2 in
// `_shared/line_movement.ts`. Source-agnostic — the data comes from
// cache_odds_snapshots (D-634), which is whatever provider's normalized
// output is active at scoring time.

export interface LineMovementCaption {
  // Whether to render the caption at all. False on no_data / no_movement.
  show: boolean;
  // Formatted opening / current odds for the caption text.
  openedOdds: string;
  currentOdds: string;
  // Whether the line moved toward the pick's side.
  towardPick: boolean;
  // Magnitude bucket from the factor: "strong" | "moderate" | "mild" |
  // "neutral" | "no_movement" | "no_data".
  magnitude: string;
  // Compact caption like "Opened -110 → now -120 (toward your side)".
  caption: string;
}

function fmtOdds(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(Number(n))) return "—";
  const v = Math.round(Number(n));
  return v > 0 ? `+${v}` : `${v}`;
}

// D-636 — Sharp money badge (RLM proxy + steam). Weight 0; descriptive only.
// Reads rlm_* + steam_* breakdown fields written by applySharpMoneyV2.
export interface SharpMoneyBadge {
  show: boolean;
  // "rlm_toward" | "rlm_away" | "steam_toward" | "steam_away" | "neutral"
  kind: string;
  label: string;
  tooltip: string;
  // True = signal favors the pick; false = signal against the pick.
  favorsPick: boolean;
}

export function getSharpMoneyBadge(
  breakdown: Record<string, unknown> | null | undefined,
): SharpMoneyBadge {
  const empty: SharpMoneyBadge = {
    show: false, kind: "no_data", label: "", tooltip: "", favorsPick: false,
  };
  if (!breakdown) return empty;
  const status = String(breakdown.rlm_status ?? "");
  const steam = breakdown.steam_detected === true;
  const steamDir = String(breakdown.steam_direction ?? "");
  const nToward = Number(breakdown.rlm_n_books_toward ?? 0);
  const nAway = Number(breakdown.rlm_n_books_away ?? 0);
  const nBooks = Number(breakdown.rlm_n_books ?? 0);
  const avgDelta = breakdown.rlm_avg_odds_delta;
  // D-783-rlm — Cross-check direction with the visible line caption.
  //
  // rlm_status + steam_direction are computed from a multi-book average
  // (sharp_money.ts). lm_toward_pick is from the single anchor book the
  // line caption displays. They can disagree — sweep on 2026-06-26 found
  // 58 cards where multi-book RLM said TOWARD but the visible line moved
  // AWAY (e.g., Keider Montero pitcher_strikeouts under, multi-book avg
  // -18.9¢ but Hard Rock -115→-110 = away). User sees a green SHARP badge
  // contradicting a red "away from your side" caption — confusing and
  // misleading.
  //
  // Rule: the visible line movement is the authoritative truth for the
  // displayed pick. Only show the SHARP/Steam badge when the multi-book
  // signal AGREES with the visible direction. Disagreement → suppress.
  const lmHasDirection = breakdown.lm_toward_pick === true || breakdown.lm_toward_pick === false;
  const lmTowardPick = breakdown.lm_toward_pick === true;
  function agrees(favorsPick: boolean): boolean {
    if (!lmHasDirection) return true; // no visible movement to cross-check; trust multi-book
    return favorsPick === lmTowardPick;
  }
  // Prefer steam over plain RLM when both fire — steam is the higher-conviction signal.
  if (steam && steamDir === "toward") {
    if (!agrees(true)) return empty;
    return {
      show: true, kind: "steam_toward", favorsPick: true,
      label: `Steam (${nToward}/${nBooks})`,
      tooltip: `${nToward} of ${nBooks} books moved 5¢+ toward this side. (Weight 0 — measure-only.)`,
    };
  }
  if (steam && steamDir === "away") {
    if (!agrees(false)) return empty;
    return {
      show: true, kind: "steam_away", favorsPick: false,
      label: `Steam against (${nAway}/${nBooks})`,
      tooltip: `${nAway} of ${nBooks} books moved 5¢+ away from this side. (Weight 0 — measure-only.)`,
    };
  }
  if (status === "rlm_toward_pick") {
    if (!agrees(true)) return empty;
    return {
      show: true, kind: "rlm_toward", favorsPick: true,
      label: `Sharp (RLM ${avgDelta ?? "?"}¢)`,
      tooltip: `Reverse line movement: market lengthened the favorite while this side tightened. Avg delta ${avgDelta ?? "?"}¢ over ${nBooks} books. (Weight 0 — measure-only.)`,
    };
  }
  if (status === "rlm_away_from_pick") {
    if (!agrees(false)) return empty;
    return {
      show: true, kind: "rlm_away", favorsPick: false,
      label: `Sharp against`,
      tooltip: `Reverse line movement points away from this side. (Weight 0 — measure-only.)`,
    };
  }
  return empty;
}

export function getLineMovementCaption(
  breakdown: Record<string, unknown> | null | undefined,
  headerOdds?: number | null,
): LineMovementCaption {
  const empty: LineMovementCaption = {
    show: false, openedOdds: "—", currentOdds: "—",
    towardPick: false, magnitude: "no_data", caption: "",
  };
  if (!breakdown) return empty;
  const mag = String(breakdown.lm_magnitude ?? "");
  if (mag === "" || mag === "no_data" || mag === "no_movement") return empty;
  const opened = breakdown.lm_opened_odds as number | null | undefined;
  const current = breakdown.lm_current_odds as number | null | undefined;
  if (opened === null || opened === undefined || current === null || current === undefined) return empty;
  // D-783-rlm — Suppress caption when lm_current_odds disagrees with the
  // header odds by >10¢. Different books feed each (header = the selected
  // pick bookmaker; lm = the line_movement anchor book). Sweep on
  // 2026-06-26 found 531/1279 cards with >10¢ mismatch — showing a "line"
  // that doesn't match the actual bettable odds is misleading. When they
  // disagree, hide the caption rather than display two contradicting
  // numbers (e.g., Montero U3.5 header=+110, caption -115→-110).
  if (headerOdds !== null && headerOdds !== undefined && Number.isFinite(Number(headerOdds))) {
    const diff = Math.abs(Number(current) - Number(headerOdds));
    if (diff > 10) return empty;
  }
  const toward = !!breakdown.lm_toward_pick;
  // Don't show the caption for "neutral" (delta < 5¢) — visual noise.
  if (mag === "neutral") return { ...empty, openedOdds: fmtOdds(opened), currentOdds: fmtOdds(current), towardPick: toward, magnitude: mag };

  const towardLabel = toward ? "toward your side" : "away from your side";
  return {
    show: true,
    openedOdds: fmtOdds(opened),
    currentOdds: fmtOdds(current),
    towardPick: toward,
    magnitude: mag,
    caption: `Line: ${fmtOdds(opened)} → ${fmtOdds(current)} (${mag} — ${towardLabel})`,
  };
}
