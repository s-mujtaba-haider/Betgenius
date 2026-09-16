import { type Sport, writeStoredSport } from "@/lib/sport";

// Compact two-button segmented control. Visual matches Games' date toggle
// pattern (rounded-lg border + emerald-tinted bg-zinc-700 active state).
// Self-handles localStorage write so parent only needs to track current
// value via onChange. Parent's storage event listener handles cross-tab
// sync as before.
export function SportSelector({
  value,
  onChange,
}: {
  value: Sport;
  onChange: (s: Sport) => void;
}) {
  function pick(s: Sport) {
    if (s === value) return;
    writeStoredSport(s);
    onChange(s);
  }
  return (
    <div className="flex gap-1 rounded-lg border border-zinc-800 bg-zinc-900/60 p-1">
      {(["nba", "mlb"] as Sport[]).map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => pick(s)}
          className={`px-3 py-1.5 text-xs font-semibold rounded-md transition tabular-nums ${
            value === s
              ? "bg-zinc-700 text-zinc-100"
              : "text-zinc-400 hover:text-zinc-200"
          }`}
          title={s === "mlb" ? "MLB — Early Beta · 7 markets · algorithm calibrating" : "NBA"}
        >
          {s.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
