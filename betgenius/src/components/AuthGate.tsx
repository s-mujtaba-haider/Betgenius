import { useState, useEffect, type ReactNode } from "react";
import { useAuthSession, isEmailAllowed, sendMagicLink, ADMIN_EMAILS } from "@/lib/auth";
import Landing from "@/pages/Landing";

// Single CEO email used for the "Request access" mailto fallback. Pulled
// from the admin allowlist so we don't hardcode in two places.
const REQUEST_ACCESS_EMAIL = ADMIN_EMAILS[0];

// D-216 Task 5.2 — current TOS version. Bump on TOS revision; this gets
// persisted to user_preferences.tos_accepted_version at signup so we can
// detect users who agreed to an older TOS version.
const CURRENT_TOS_VERSION = "v1.0-2026-05-18";

type Status = "idle" | "checking" | "not_allowed" | "sending" | "sent" | "error";

// D-216 — capture URL params on first AuthGate mount so they survive
// magic-link round-trip. ?ref=SHARP-XXXX → session storage; consumed by
// App.tsx hydration on first signin to write referrals_made + claim
// promotional_grants slot.
function captureUrlAttribution() {
  if (typeof window === "undefined") return;
  try {
    const params = new URLSearchParams(window.location.search);
    const ref = params.get("ref");
    const invite = params.get("invite");
    if (ref && /^SHARP-[A-Z0-9]{4,8}$/i.test(ref)) {
      window.sessionStorage.setItem("bg_ref_code", ref.toUpperCase());
    }
    if (invite && /^BETA-\d{3}-[A-F0-9]{6}$/i.test(invite)) {
      window.sessionStorage.setItem("bg_invite_code", invite.toUpperCase());
    }
  } catch { /* sessionStorage may be disabled — non-fatal */ }
}

export default function AuthGate({ children }: { children: ReactNode }) {
  const { session, loading } = useAuthSession();
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [errMsg, setErrMsg] = useState<string | null>(null);
  const [tosAccepted, setTosAccepted] = useState(false);
  const [ageConfirmed, setAgeConfirmed] = useState(false);
  // D-216 — true if URL has ?invite=BETA-... so we render beta-access copy.
  const [isBetaInvite, setIsBetaInvite] = useState(false);
  // D-218 — show Landing.tsx by default; flip to signin form on user CTA
  // or when URL has ?signin=true / ?invite=. Pre-auth-only.
  const [showSignin, setShowSignin] = useState(false);

  useEffect(() => {
    captureUrlAttribution();
    if (typeof window !== "undefined") {
      try {
        const hasInvite = !!window.sessionStorage.getItem("bg_invite_code");
        setIsBetaInvite(hasInvite);
        const params = new URLSearchParams(window.location.search);
        const signinParam = params.get("signin") === "1" || params.get("signin") === "true";
        // Default to Landing unless explicit signin intent OR invite code.
        if (hasInvite || signinParam) setShowSignin(true);
      } catch { /* ignore */ }
    }
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen bg-zinc-950 text-zinc-400 flex items-center justify-center text-sm">
        Loading…
      </div>
    );
  }

  if (session) {
    return <>{children}</>;
  }

  // D-218 Task 5.4 — pre-auth Landing by default. Signin form shows only
  // when the visitor clicks the sign-in CTA, hits a beta-invite link, or
  // explicitly requests it via ?signin=true.
  if (!showSignin) {
    return <Landing onSignInClick={() => setShowSignin(true)} />;
  }

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setErrMsg(null);
    const trimmed = email.trim().toLowerCase();
    if (!trimmed || !trimmed.includes("@")) {
      setErrMsg("Please enter a valid email.");
      setStatus("error");
      return;
    }
    if (!tosAccepted || !ageConfirmed) {
      setErrMsg("Please confirm age and accept the Terms of Service.");
      setStatus("error");
      return;
    }
    setStatus("checking");
    const allowed = await isEmailAllowed(trimmed);
    if (allowed === false) {
      setStatus("not_allowed");
      return;
    }
    if (allowed === null) {
      setErrMsg("Network issue checking access. Try again in a moment.");
      setStatus("error");
      return;
    }
    setStatus("sending");
    const res = await sendMagicLink(trimmed);
    if (!res.ok) {
      setErrMsg(res.error ?? "Failed to send magic link.");
      setStatus("error");
      return;
    }
    // Stash TOS acceptance so post-signin hydration can persist it.
    try {
      window.sessionStorage.setItem("bg_tos_accepted_version", CURRENT_TOS_VERSION);
      window.sessionStorage.setItem("bg_tos_accepted_at", new Date().toISOString());
    } catch { /* ignore */ }
    setStatus("sent");
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-white flex items-center justify-center px-4">
      <div className="w-full max-w-md">
        <div className="flex justify-center mb-6">
          <img src="/logo.png" alt="SharpAI" className="h-32 w-auto object-contain" />
        </div>

        <div className="rounded-xl border border-zinc-800 bg-gradient-to-b from-zinc-900 to-zinc-900/60 p-6">
          {isBetaInvite && (
            <div className="mb-4 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-200">
              🎉 Closed beta invite detected — sign up to lock $49/mo through April 2027 grandfather.
            </div>
          )}
          <h2 className="text-lg font-semibold text-zinc-100">{isBetaInvite ? "Activate your beta invite" : "Sign in"}</h2>
          <p className="text-xs text-zinc-400 mt-1">
            We'll email you a one-time link. No password needed.
          </p>

          {status === "sent" ? (
            <div className="mt-5 rounded-lg border border-emerald-500/40 bg-emerald-500/10 p-4 text-sm text-emerald-200">
              ✓ Check your email. Click the link to sign in.
              <div className="mt-2 text-xs text-emerald-300/80">
                Sent to <span className="font-medium">{email.toLowerCase()}</span>. Check spam if it
                doesn't arrive within a minute.
              </div>
              <button
                onClick={() => { setStatus("idle"); setEmail(""); }}
                className="mt-3 text-xs text-emerald-200 underline hover:text-emerald-100"
              >
                Use a different email
              </button>
            </div>
          ) : status === "not_allowed" ? (
            <div className="mt-5 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-200">
              Sorry, this app is invite-only right now.
              <div className="mt-2 text-xs text-amber-300/80">
                <a
                  className="underline hover:text-amber-200"
                  href={`mailto:${REQUEST_ACCESS_EMAIL}?subject=SharpAI%20access%20request&body=Hi%20%E2%80%94%20I%27d%20like%20access%20to%20SharpAI.`}
                >
                  Request access
                </a>
              </div>
              <button
                onClick={() => { setStatus("idle"); setEmail(""); }}
                className="mt-3 text-xs text-amber-200 underline hover:text-amber-100"
              >
                Try a different email
              </button>
            </div>
          ) : (
            <form onSubmit={onSubmit} className="mt-5 space-y-3">
              <label className="block text-xs font-medium text-zinc-300">
                Email
                <input
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={status === "checking" || status === "sending"}
                  placeholder="you@example.com"
                  className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-950/60 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-emerald-500/60 focus:outline-none focus:ring-1 focus:ring-emerald-500/30"
                />
              </label>
              {/* D-216 Task 5.2 — TOS + age confirmation. Required per arch §9.1
                  + §9.4 disclaimer standard. 21+ for US/Canada launch slate. */}
              <label className="flex items-start gap-2 text-[11px] text-zinc-400">
                <input
                  type="checkbox"
                  checked={ageConfirmed}
                  onChange={(e) => setAgeConfirmed(e.target.checked)}
                  className="mt-0.5"
                />
                <span>I confirm I am 21 or older (or 18+ in jurisdictions where 18 is the legal age for contracts).</span>
              </label>
              <label className="flex items-start gap-2 text-[11px] text-zinc-400">
                <input
                  type="checkbox"
                  checked={tosAccepted}
                  onChange={(e) => setTosAccepted(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  I accept the <a href="/terms" className="text-zinc-300 underline">Terms of Service</a>
                  {" "}and acknowledge SharpAI provides analytics — <strong>not financial or betting advice</strong>.
                </span>
              </label>
              <button
                type="submit"
                disabled={status === "checking" || status === "sending" || !tosAccepted || !ageConfirmed}
                className="w-full rounded-lg bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-zinc-950 hover:bg-emerald-400 disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {status === "checking" ? "Checking access…" : status === "sending" ? "Sending link…" : "Send magic link"}
              </button>
              {errMsg && (
                <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-200">
                  {errMsg}
                </div>
              )}
            </form>
          )}
        </div>

        <div className="mt-4 text-center text-[11px] text-zinc-600">
          {isBetaInvite ? "Closed beta · invitation only" : "Invite-only. Subscriber launch coming soon."}
        </div>
      </div>
    </div>
  );
}
