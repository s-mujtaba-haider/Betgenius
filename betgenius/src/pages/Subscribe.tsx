// Subscribe page — D-221 Task 6.2.
//
// Shown to authenticated users without an active subscription. Picks
// plan based on launch_phase + invite-code presence, then calls
// create-checkout-session edge function (D-220) to mint a Stripe
// Checkout URL.

import { useState, useEffect } from "react";
import { SUPABASE_URL } from "@/lib/supabase";
import { useAuthSession } from "@/lib/auth";

type LaunchPhase = "pre_launch" | "closed_beta" | "public_launch";

function getLaunchPhase(): LaunchPhase {
  if (typeof window !== "undefined") {
    const p = new URLSearchParams(window.location.search).get("launch_phase");
    if (p === "pre_launch" || p === "closed_beta" || p === "public_launch") return p;
  }
  const env = (import.meta as { env?: Record<string, string> }).env?.VITE_LAUNCH_PHASE;
  if (env === "closed_beta" || env === "public_launch") return env;
  return "pre_launch";
}

function readAttribution(): { invite_code: string | null; ref_code: string | null } {
  if (typeof window === "undefined") return { invite_code: null, ref_code: null };
  try {
    const intent = window.localStorage.getItem("bg_signup_attribution_pending");
    if (intent) {
      const parsed = JSON.parse(intent);
      return { invite_code: parsed.invite ?? null, ref_code: parsed.ref ?? null };
    }
  } catch { /* ignore */ }
  // Fallback: read directly from URL on subscribe-page mount.
  try {
    const params = new URLSearchParams(window.location.search);
    return {
      invite_code: params.get("invite"),
      ref_code: params.get("ref"),
    };
  } catch { return { invite_code: null, ref_code: null }; }
}

export default function Subscribe() {
  const { session } = useAuthSession();
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  const phase = getLaunchPhase();
  const attr = readAttribution();

  // Default plan: beta if invite captured; else public-launch price.
  const defaultPlan = attr.invite_code
    ? "pro_beta_49"
    : phase === "public_launch"
      ? "pro_monthly_99"
      : "pro_beta_49";

  const [selectedPlan, setSelectedPlan] = useState<string>(defaultPlan);

  useEffect(() => { setSelectedPlan(defaultPlan); }, [defaultPlan]);

  async function startCheckout() {
    if (!session?.access_token) { setError("Please sign in first."); return; }
    setStatus("loading");
    setError(null);
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/create-checkout-session`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          plan: selectedPlan,
          attribution: {
            invite_code: attr.invite_code,
            ref_code: attr.ref_code,
            referrer_source: attr.ref_code ? "referral" : "direct",
          },
        }),
      });
      const body = await res.json();
      if (!res.ok || !body.url) {
        setError(body.code === "STRIPE_NOT_CONFIGURED"
          ? "Stripe is not yet configured — please try again shortly."
          : body.code === "PRICE_ID_MISSING"
            ? "Pricing not yet set up — please try again shortly."
            : (body.error ?? `Checkout failed (${res.status})`));
        setStatus("error");
        return;
      }
      window.location.href = body.url;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
      setStatus("error");
    }
  }

  const planCopy: Record<string, { title: string; price: string; subtitle: string }> = {
    pro_beta_49: {
      title: "Closed Beta — $49/mo",
      price: "$49",
      subtitle: "Locked through April 2027 grandfather migration",
    },
    pro_monthly_99: {
      title: "SharpAI Pro — $99/mo",
      price: "$99",
      subtitle: "7-day free trial · cancel anytime",
    },
    pro_monthly_129: {
      title: "SharpAI Pro — $129/mo",
      price: "$129",
      subtitle: "Phase 4 launch · 7-day free trial",
    },
  };

  const card = planCopy[selectedPlan] ?? planCopy.pro_monthly_99;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col">
      <main className="flex-1 max-w-3xl mx-auto px-4 sm:px-8 py-12 sm:py-20 w-full">
        <div className="text-center mb-10">
          <img src="/logo.png" alt="SharpAI" className="h-16 mx-auto mb-6" />
          {attr.invite_code && (
            <div className="inline-block rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-200 mb-4">
              🎉 Closed beta invite active — $49/mo locked through April 2027
            </div>
          )}
          <h1 className="text-3xl sm:text-4xl font-bold mb-3">{attr.invite_code ? "Activate your beta invite" : "Start your 7-day free trial"}</h1>
          <p className="text-zinc-400 text-sm sm:text-base max-w-xl mx-auto">
            Cancel anytime. No charges during trial.
          </p>
        </div>

        <div className="rounded-2xl border border-zinc-800 bg-gradient-to-b from-zinc-900 to-zinc-900/40 p-8">
          <div className="flex items-center justify-between mb-6">
            <div>
              <div className="text-sm text-zinc-400 mb-1">{card.title}</div>
              <div className="text-4xl font-bold">{card.price}<span className="text-base font-normal text-zinc-500"> / month</span></div>
              <div className="text-xs text-zinc-500 mt-1">{card.subtitle}</div>
            </div>
            <div className="text-right">
              <div className="text-[11px] uppercase tracking-wide text-emerald-300/80">Includes</div>
              <div className="text-sm text-zinc-300">NBA + MLB · 7 markets · Kelly stakes</div>
            </div>
          </div>

          <ul className="space-y-2 mb-8 text-sm text-zinc-300">
            <li>✓ Daily algorithm picks across NBA + MLB</li>
            <li>✓ Kelly-calibrated stake recommendations</li>
            <li>✓ Performance + calibration tracking</li>
            <li>✓ Cancel anytime via Stripe portal</li>
          </ul>

          <button
            onClick={startCheckout}
            disabled={status === "loading"}
            className="w-full rounded-lg bg-emerald-500 px-6 py-3 text-base font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-60"
          >
            {status === "loading" ? "Redirecting to Stripe…" : attr.invite_code ? "Activate invite →" : "Start free trial →"}
          </button>

          {error && (
            <div className="mt-3 rounded-md border border-red-500/40 bg-red-500/10 px-3 py-2 text-xs text-red-200">
              {error}
            </div>
          )}

          <p className="mt-4 text-[11px] text-zinc-500 text-center">
            Powered by Stripe. Your card is charged after the 7-day trial unless you cancel. SharpAI provides analytics — <strong className="text-zinc-300">not financial or betting advice</strong>.
          </p>
        </div>
      </main>

      <div className="border-t border-zinc-800 text-[11px] text-zinc-500 px-4 py-3 text-center">
        SharpAI provides analytics — <strong className="text-zinc-300">not financial or betting advice</strong>. Bet responsibly. 1-800-GAMBLER.
      </div>
    </div>
  );
}
