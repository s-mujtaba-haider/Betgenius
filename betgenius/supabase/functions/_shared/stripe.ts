// _shared/stripe.ts — D-220 Task 6.1.
//
// Stripe SDK initialization + price catalog. Imported by
// create-checkout-session, stripe-webhook, customer-portal-session.
// API version pinned to a known-stable date for reproducible builds.

import Stripe from "https://esm.sh/stripe@14.25.0?target=deno&deno-std=0.224.0&no-check";

const stripeKey =
  Deno.env.get("STRIPE_SECRET_KEY") ??
  Deno.env.get("STRIPE_SECRET_KEY_TEST") ??
  "";

export const STRIPE_CONFIGURED = !!stripeKey;

export const stripe = stripeKey
  ? new Stripe(stripeKey, {
      // @ts-ignore — Deno-compatible httpClient via SubtleCryptoProvider
      httpClient: Stripe.createFetchHttpClient(),
      apiVersion: "2024-06-20",
    })
  : null;

// Price catalog per architecture §6.2.1 (D-196 Path C launch). The Stripe
// price IDs themselves get inserted by CEO via Stripe Dashboard; we
// reference them by canonical name and look up the actual price_id from
// Supabase secrets (STRIPE_PRICE_ID_<NAME>). Until secrets are populated,
// PRICE_IDS values are `null` and create-checkout-session will surface a
// clear error.
export const PLAN_NAMES = [
  "pro_beta_49",
  "pro_monthly_99",
  "pro_monthly_129",
  "pro_monthly_149",
] as const;

export type PlanName = (typeof PLAN_NAMES)[number];

export function resolvePriceId(plan: PlanName): string | null {
  const envName = `STRIPE_PRICE_ID_${plan.toUpperCase()}`;
  return Deno.env.get(envName) ?? null;
}

export function isValidPlan(p: string): p is PlanName {
  return (PLAN_NAMES as readonly string[]).includes(p);
}

// Trial logic per §6.2.1: closed beta bypasses 7-day trial via
// promotional_grants; public-launch plans get 7-day trial.
export function trialDaysForPlan(plan: PlanName): number {
  if (plan === "pro_beta_49") return 0;
  return 7;
}
