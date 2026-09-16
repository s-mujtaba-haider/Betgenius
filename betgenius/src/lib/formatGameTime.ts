// D-229 Fix 5 — subscriber-local game-time formatting.
//
// Renders an ISO timestamp as "10:40 PM ET" using the browser's
// detected timezone. Falls back to America/New_York if Intl can't
// resolve the timezone. Returns null for unparseable input.

const FALLBACK_TZ = "America/New_York";

function detectTz(): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz) return tz;
  } catch { /* ignore */ }
  return FALLBACK_TZ;
}

export function formatGameTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    // Not a parseable ISO — return raw input so existing display
    // doesn't blank out unexpectedly. Most cron-written game_time
    // is full ISO so this is the fallback path.
    return iso;
  }
  try {
    return d.toLocaleString("en-US", {
      timeZone: detectTz(),
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
      timeZoneName: "short",
    });
  } catch {
    return iso;
  }
}
