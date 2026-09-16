// Landing page — D-218 Task 5.4.
//
// Architecture §1.1 dual-phase landing. Renders for unauthenticated
// visitors. Subscriber-count + calibration banner pulled from
// public-readable tables. Waitlist signup writes to `waitlist`
// (anon-insert per D-219 RLS).
//
// Phase routing:
//   PRE_LAUNCH / CLOSED_BETA_ACTIVE — waitlist signup CTA prominent
//   PUBLIC_LAUNCH — "Sign in" CTA prominent (Aug 1 2026 flip)
//
// Disclaimer prominence per §10.6: fixed-position on mobile, footer
// on desktop. Required string "not financial or betting advice"
// rendered on every code path — CI gate npm run lint:disclaimer
// greps for it.

import { useEffect, useState } from "react";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "@/lib/supabase";

type LaunchPhase = "pre_launch" | "closed_beta" | "public_launch";

// D-218 — launch phase flag. Resolution order:
//   1. URL param ?launch_phase= (for QA testing only)
//   2. VITE_LAUNCH_PHASE env var
//   3. default: pre_launch
function getLaunchPhase(): LaunchPhase {
  if (typeof window !== "undefined") {
    const param = new URLSearchParams(window.location.search).get("launch_phase");
    if (param === "pre_launch" || param === "closed_beta" || param === "public_launch") {
      return param;
    }
  }
  const envPhase = (import.meta as { env?: Record<string, string> }).env?.VITE_LAUNCH_PHASE;
  if (envPhase === "closed_beta" || envPhase === "public_launch") return envPhase;
  return "pre_launch";
}

interface CalibrationSummary {
  rolling30d_pct: number | null;
  rolling30d_n: number | null;
  snapshot_date: string | null;
}

async function fetchCalibrationSummary(): Promise<CalibrationSummary> {
  try {
    // D-248 (2026-05-19): query was selecting non-existent columns (wr_pct,
    // sample_size) and filtering on non-existent metric_type
    // (rolling_30d_70plus_wr). Real columns are hit_rate (0-1 fraction) and
    // bets_resolved; real metric_type values are overall / tier / prop_type /
    // factor_presence. Using metric_type=overall + window_type=rolling_30d
    // for the broadest, most-recently-populated stat (~260 bets / 55% WR).
    const url = `${SUPABASE_URL}/rest/v1/calibration_snapshots?metric_type=eq.overall&window_type=eq.rolling_30d&order=snapshot_date.desc&limit=1&select=snapshot_date,hit_rate,bets_resolved`;
    const res = await fetch(url, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
    });
    if (!res.ok) return { rolling30d_pct: null, rolling30d_n: null, snapshot_date: null };
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) {
      return { rolling30d_pct: null, rolling30d_n: null, snapshot_date: null };
    }
    const r = rows[0];
    return {
      rolling30d_pct: typeof r.hit_rate === "number" ? Math.round(r.hit_rate * 1000) / 10 : null,
      rolling30d_n: r.bets_resolved ?? null,
      snapshot_date: r.snapshot_date ?? null,
    };
  } catch {
    return { rolling30d_pct: null, rolling30d_n: null, snapshot_date: null };
  }
}

async function submitWaitlist(email: string, source: "landing" | "beta_access_invalid_invite"): Promise<{ ok: boolean; error?: string }> {
  try {
    // Capture ref code from URL if present
    let referral_code: string | null = null;
    if (typeof window !== "undefined") {
      const ref = new URLSearchParams(window.location.search).get("ref");
      if (ref && /^SHARP-[A-Z0-9]{4,8}$/i.test(ref)) referral_code = ref.toUpperCase();
    }
    const res = await fetch(`${SUPABASE_URL}/rest/v1/waitlist`, {
      method: "POST",
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        email: email.toLowerCase().trim(),
        referral_code,
        source,
      }),
    });
    if (res.ok) return { ok: true };
    // Duplicate email = unique constraint violation — treat as success (idempotent UX).
    if (res.status === 409) return { ok: true };
    const body = await res.text();
    return { ok: false, error: `status=${res.status}: ${body.slice(0, 200)}` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "network error" };
  }
}

export default function Landing({ onSignInClick }: { onSignInClick: () => void }) {
  const phase = getLaunchPhase();
  const [calibration, setCalibration] = useState<CalibrationSummary>({ rolling30d_pct: null, rolling30d_n: null, snapshot_date: null });
  const [waitlistEmail, setWaitlistEmail] = useState("");
  const [waitlistStatus, setWaitlistStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [waitlistErr, setWaitlistErr] = useState<string | null>(null);
  const [hasInvalidInvite, setHasInvalidInvite] = useState(false);

  useEffect(() => {
    fetchCalibrationSummary().then(setCalibration);
    // Check URL: was there an ?invite= that turned out invalid? AuthGate
    // captured it but if the user lands HERE post-invalid-invite, we
    // route them to waitlist with source='beta_access_invalid_invite'.
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      if (params.get("invite_failed") === "1") setHasInvalidInvite(true);
    }
  }, []);

  async function onWaitlistSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setWaitlistErr(null);
    if (!waitlistEmail.includes("@")) {
      setWaitlistErr("Please enter a valid email.");
      setWaitlistStatus("error");
      return;
    }
    setWaitlistStatus("sending");
    const source = hasInvalidInvite ? "beta_access_invalid_invite" : "landing";
    const res = await submitWaitlist(waitlistEmail, source);
    if (!res.ok) {
      setWaitlistErr(res.error ?? "Failed to add to waitlist.");
      setWaitlistStatus("error");
      return;
    }
    setWaitlistStatus("sent");
  }

  const ctaText = phase === "public_launch" ? "Sign in" : "Join the waitlist";
  const phaseLabel = phase === "public_launch"
    ? "Live · subscriber signups open"
    : phase === "closed_beta"
      ? "Closed beta · 50 spots · invitation only"
      : "Public launch October 2026 — closed beta access by invitation";

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col">
      <main className="flex-1 max-w-5xl mx-auto px-4 sm:px-8 py-12 sm:py-20 w-full">
        {/* Hero */}
        <div className="flex flex-col items-center text-center">
          <img src="/logo.png" alt="SharpAI" className="h-24 w-auto sm:h-32 mb-8" />
          <div className="text-[11px] uppercase tracking-widest text-amber-400 mb-3">{phaseLabel}</div>
          <h1 className="text-3xl sm:text-5xl font-bold tracking-tight mb-4">
            Sharp sports analytics · calibrated picks · Kelly-sized stakes
          </h1>
          <p className="text-zinc-400 max-w-2xl text-sm sm:text-base mb-8">
            A 26-factor algorithm for NBA + MLB player props. Confidence-calibrated tiers. Kelly stake recommendations sized to your bankroll. Real performance tracked on every pick.
          </p>

          {/* Calibration banner — real data from calibration_snapshots */}
          {calibration.rolling30d_pct != null ? (
            <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/5 px-5 py-3 mb-8">
              <div className="text-[11px] uppercase tracking-wide text-emerald-300/80">Recent calibration</div>
              <div className="text-2xl font-bold text-emerald-400 mt-1">
                {calibration.rolling30d_pct}% WR
                <span className="ml-2 text-sm font-normal text-emerald-300/70">
                  on all picks · n={calibration.rolling30d_n} · rolling 30d
                </span>
              </div>
              {calibration.snapshot_date && (
                <div className="text-[10px] text-emerald-300/50 mt-1">
                  as of {calibration.snapshot_date}
                </div>
              )}
            </div>
          ) : (
            <div className="rounded-lg border border-zinc-700/50 bg-zinc-900/40 px-5 py-3 mb-8 text-sm text-zinc-500">
              Live calibration loading…
            </div>
          )}

          {/* CTA — phase-dependent */}
          {phase === "public_launch" ? (
            <button
              onClick={onSignInClick}
              className="rounded-lg bg-emerald-500 px-8 py-3 text-base font-semibold text-zinc-950 hover:bg-emerald-400"
            >
              {ctaText} →
            </button>
          ) : (
            <>
              {hasInvalidInvite && (
                <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-4 py-2 text-xs text-amber-200 mb-4">
                  Invite code not found or already redeemed. Join the waitlist for public launch.
                </div>
              )}
              {waitlistStatus === "sent" ? (
                <div className="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-5 py-3 text-sm text-emerald-200">
                  ✓ You're on the list. We'll email you at public launch.
                </div>
              ) : (
                <form onSubmit={onWaitlistSubmit} className="flex gap-2 w-full max-w-md">
                  <input
                    type="email"
                    required
                    placeholder="you@example.com"
                    value={waitlistEmail}
                    onChange={(e) => setWaitlistEmail(e.target.value)}
                    disabled={waitlistStatus === "sending"}
                    className="flex-1 rounded-lg border border-zinc-700 bg-zinc-900/60 px-4 py-2.5 text-sm placeholder:text-zinc-600 focus:border-emerald-500/60 focus:outline-none"
                  />
                  <button
                    type="submit"
                    disabled={waitlistStatus === "sending"}
                    className="rounded-lg bg-emerald-500 px-5 py-2.5 text-sm font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-60"
                  >
                    {waitlistStatus === "sending" ? "…" : "Join waitlist"}
                  </button>
                </form>
              )}
              {waitlistErr && (
                <div className="mt-2 text-xs text-red-300">{waitlistErr}</div>
              )}
              <button
                onClick={onSignInClick}
                className="mt-6 text-xs text-zinc-500 hover:text-zinc-300 underline"
              >
                Already invited? Sign in →
              </button>
            </>
          )}
        </div>

        {/* How it works */}
        <div className="mt-20 grid grid-cols-1 sm:grid-cols-3 gap-6">
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
            <div className="text-emerald-400 font-bold text-2xl mb-2">1</div>
            <div className="font-semibold mb-1">Algorithm scores props</div>
            <div className="text-sm text-zinc-400">26 factors per pick. Recent form, opp defense, pace, ballpark, weather, umpire, handedness matchup — all weighted.</div>
          </div>
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
            <div className="text-emerald-400 font-bold text-2xl mb-2">2</div>
            <div className="font-semibold mb-1">Confidence tiers</div>
            <div className="text-sm text-zinc-400">Elite (90+), Strong (80-89), Good (70-79). Tier is calibrated against real win-rate — Performance page tracks it daily.</div>
          </div>
          <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-5">
            <div className="text-emerald-400 font-bold text-2xl mb-2">3</div>
            <div className="font-semibold mb-1">Kelly stake sizing</div>
            <div className="text-sm text-zinc-400">Every pick comes with a Kelly-calibrated stake recommendation for your bankroll. Fractional Kelly (quarter / half / full) configurable in Settings.</div>
          </div>
        </div>
      </main>

      {/* §10.6 disclaimer — fixed bottom on mobile, footer on desktop.
          Required string "not financial or betting advice" rendered
          unconditionally on every render path. CI gate
          npm run lint:disclaimer enforces. */}
      <div className="fixed bottom-0 inset-x-0 sm:relative sm:bottom-auto bg-zinc-900 border-t border-zinc-800 text-[11px] text-zinc-500 px-4 py-2 sm:py-4 text-center z-50">
        SharpAI provides analytics — <strong className="text-zinc-300">not financial or betting advice</strong>. Past performance not indicative of future results. Bet responsibly. 1-800-GAMBLER.
      </div>
    </div>
  );
}
