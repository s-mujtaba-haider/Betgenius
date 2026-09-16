import { useEffect, useState, useCallback } from "react";
import type { Session } from "@supabase/supabase-js";
import { supabase, SUPABASE_URL } from "./supabase";

// Single source of truth for who is allowed Admin nav. CEO replaces this list
// before deploy. Each entry must be lowercase to match the allowed_emails PK
// constraint and the magic-link signInWithOtp behavior (Supabase normalizes
// email to lowercase on auth.users insert).
export const ADMIN_EMAILS: ReadonlyArray<string> = ["admin@example.com"];

// Placeholder used pre-auth. Trigger `default_bet_user_id` (Apr 29) populates
// this when bets.user_id is NULL on insert. Kept here so Performance can
// continue reading historical bets while new bets carry the auth UUID.
export const PLACEHOLDER_USER_ID = "00000000-0000-0000-0000-000000000001";

export function useAuthSession() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    supabase.auth.getSession().then(({ data }) => {
      if (cancelled) return;
      setSession(data.session ?? null);
      setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, sess) => {
      setSession(sess);
    });
    return () => {
      cancelled = true;
      sub.subscription.unsubscribe();
    };
  }, []);

  const signOut = useCallback(async () => {
    await supabase.auth.signOut();
    setSession(null);
  }, []);

  const isAdmin = !!session?.user?.email && ADMIN_EMAILS.includes(session.user.email.toLowerCase());

  return { session, loading, signOut, isAdmin };
}

// Resolves the current user_id for bet inserts. Falls back to the placeholder
// UUID so anonymous (legacy) writes still pass the FK trigger guard.
export function currentUserId(session: Session | null): string {
  return session?.user?.id ?? PLACEHOLDER_USER_ID;
}

// Checks if the email is on the allow-list. As of D-500 (2026-06-10) this
// routes through the `check-email-allowed` edge function rather than reading
// the allowed_emails table directly — the table now blocks anon SELECT (RLS
// admin-only) so a public PostgREST read would always return [] regardless
// of allow-list membership. The edge function uses the service-role key
// server-side and returns ONLY a boolean — never the row, never the list.
//
// Return semantics preserved from the pre-D-500 helper:
//   true  → email is on the list (caller should allow sign-in)
//   false → email is not on the list OR malformed
//   null  → network/server error (AuthGate shows the network-error UX)
export async function isEmailAllowed(email: string): Promise<boolean | null> {
  const normalized = email.trim().toLowerCase();
  if (!normalized || !normalized.includes("@")) return false;
  try {
    const r = await fetch(
      `${SUPABASE_URL}/functions/v1/check-email-allowed`,
      {
        method: "POST",
        headers: {
          "apikey": import.meta.env.VITE_SUPABASE_ANON_KEY,
          "Authorization": `Bearer ${import.meta.env.VITE_SUPABASE_ANON_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ email: normalized }),
      }
    );
    if (!r.ok) return null;
    const body = await r.json() as { allowed?: boolean };
    return body.allowed === true;
  } catch {
    return null;
  }
}

// Sends a magic link via Supabase Auth. emailRedirectTo MUST be a URL the
// project's Auth → URL Configuration whitelists, otherwise the link bounces.
export async function sendMagicLink(email: string): Promise<{ ok: boolean; error?: string }> {
  const normalized = email.trim().toLowerCase();
  const { error } = await supabase.auth.signInWithOtp({
    email: normalized,
    options: {
      emailRedirectTo: window.location.origin,
    },
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}
