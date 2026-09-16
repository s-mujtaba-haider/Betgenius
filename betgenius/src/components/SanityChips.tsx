// SanityChips — D-224 Task 7.1.
//
// Renders architecture §12.4 sanity flag chips on pick surfaces.
// Priority order (highest → lowest):
//   unbettable_juice_flag → red
//   negative_stacking_flag → orange
//   coin_flip_flag → amber
//   is_secondary_market → gray
//   trivial_line_cap → gray
//   is_d214_quarantined → red (admin only)
//
// Mobile: max 2 chips visible with "+N more" overflow.
// Desktop: all chips inline.

import { useState } from "react";

export interface SanityFlags {
  unbettable_juice_flag?: boolean;
  negative_stacking_flag?: boolean;
  coin_flip_flag?: boolean;
  is_secondary_market?: boolean;
  trivial_line_cap?: number | null;     // score_trivial_line_cap nonzero → flag fires
  is_d214_quarantined?: boolean;
}

const CHIP_DEFS: Array<{
  key: keyof SanityFlags;
  label: string;
  tooltip: string;
  classes: string;
  adminOnly?: boolean;
}> = [
  {
    key: "unbettable_juice_flag",
    label: "Unbettable juice",
    tooltip: "Odds make Kelly stake negative or trivial despite high confidence. The required stake to hit Kelly target is impractical.",
    classes: "bg-red-500/15 text-red-300 border-red-500/40",
  },
  {
    key: "negative_stacking_flag",
    label: "Negative stacking",
    tooltip: "Confidence built on multiple negative factors stacking. Higher variance risk than score implies.",
    classes: "bg-orange-500/15 text-orange-300 border-orange-500/40",
  },
  {
    key: "coin_flip_flag",
    label: "Coin flip",
    tooltip: "Algorithm confidence is high but season hit rate is mid-range (40-60%). Watch for variance.",
    classes: "bg-amber-500/15 text-amber-300 border-amber-500/40",
  },
  {
    key: "is_secondary_market",
    label: "Secondary market",
    tooltip: "Same player has a higher-confidence pick in another market. Consider that pick first.",
    classes: "bg-zinc-700/40 text-zinc-300 border-zinc-600/40",
  },
  {
    key: "trivial_line_cap",
    label: "Trivial line",
    tooltip: "Line is ≤0.5 or odds reflect near-certain outcome. Limited edge despite high confidence score.",
    classes: "bg-zinc-700/40 text-zinc-300 border-zinc-600/40",
  },
  {
    key: "is_d214_quarantined",
    label: "Beta calibration excluded",
    tooltip: "Pick generated during MLB Beta cold-start period before factor caches populated. Excluded from rolling-30d calibration tracking.",
    classes: "bg-red-500/15 text-red-300 border-red-500/40",
    adminOnly: true,
  },
];

function flagFires(flags: SanityFlags, key: keyof SanityFlags): boolean {
  const v = flags[key];
  if (key === "trivial_line_cap") {
    return typeof v === "number" && v !== 0;
  }
  return v === true;
}

export default function SanityChips({
  flags,
  isAdmin = false,
  inline = true,
}: {
  flags: SanityFlags;
  isAdmin?: boolean;
  inline?: boolean;
}) {
  const [showAll, setShowAll] = useState(false);

  const activeChips = CHIP_DEFS.filter((def) => {
    if (def.adminOnly && !isAdmin) return false;
    return flagFires(flags, def.key);
  });

  if (activeChips.length === 0) return null;

  // Mobile cap: 2 chips + "+N more" toggle. Desktop: all inline.
  // Detected via CSS hidden classes — simpler than measuring viewport.
  const visible = showAll ? activeChips : activeChips.slice(0, 2);
  const hidden = activeChips.length - visible.length;

  return (
    <div className={inline ? "flex flex-wrap gap-1.5 items-center" : "flex flex-col gap-1"}>
      {visible.map((def) => (
        <span
          key={def.key}
          title={def.tooltip}
          className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide ${def.classes}`}
        >
          {def.label}
        </span>
      ))}
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="inline-flex items-center rounded-md border border-zinc-700 px-1.5 py-0.5 text-[10px] font-medium text-zinc-400 hover:text-zinc-200"
        >
          +{hidden} more
        </button>
      )}
    </div>
  );
}

// D-224 — log-bet confirmation modal for unbettable_juice_flag picks.
// Renders inline below the Log Bet button when active.
export function UnbettableJuiceConfirm({
  open,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 px-4">
      <div className="w-full max-w-md rounded-xl border border-red-500/40 bg-zinc-900 p-6">
        <h3 className="text-base font-semibold text-red-300 mb-2">Unbettable juice on this pick</h3>
        <p className="text-sm text-zinc-300 leading-relaxed">
          The required stake to hit Kelly target is impractical at these odds. The Kelly model treats this pick as negative-expected-value despite the high confidence score.
        </p>
        <p className="text-xs text-zinc-500 mt-3">
          You may want to skip this pick or reduce your stake significantly. Are you sure you want to log this bet?
        </p>
        <div className="flex justify-end gap-2 mt-5">
          <button
            onClick={onCancel}
            autoFocus
            className="rounded-md border border-zinc-700 bg-zinc-800 px-4 py-2 text-sm font-medium text-zinc-200 hover:bg-zinc-700"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="rounded-md bg-red-500/20 border border-red-500/40 px-4 py-2 text-sm font-medium text-red-200 hover:bg-red-500/30"
          >
            Yes, log anyway
          </button>
        </div>
      </div>
    </div>
  );
}
