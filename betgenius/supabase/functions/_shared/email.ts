// _shared/email.ts — D-217 Task 5.3.
//
// Resend integration + 7 transactional email templates per architecture
// §10.3. Templates render as HTML strings (lightweight; React-renderer
// can swap later). All carry the §9.4 + §10.6 "not financial or betting
// advice" disclaimer.
//
// Templates (arch §10.3):
//   10.3.1 welcome
//   10.3.2 trial_ending
//   10.3.3 payment_succeeded
//   10.3.4 payment_failed
//   10.3.5 refund_processed
//   10.3.6 account_deleted
//   10.3.7 daily_digest (opt-in)
//
// Env: RESEND_API_KEY required. When unset, sendEmail() returns
// {ok:false, error:"resend_not_configured"} and logs to error_log so
// missing-secret state is visible.

const RESEND_API = "https://api.resend.com/emails";
const FROM_ADDRESS = "SharpAI <noreply@sharpai.bet>";   // pending domain verification
const REPLY_TO = "support@sharpai.bet";

export type EmailTemplate =
  | "welcome"
  | "trial_ending"
  | "payment_succeeded"
  | "payment_failed"
  | "refund_processed"
  | "account_deleted"
  | "daily_digest";

export interface EmailVars {
  first_name?: string;
  email?: string;
  trial_end_date?: string;       // ISO YYYY-MM-DD
  payment_amount?: string;       // "$49.00"
  payment_period_end?: string;
  failure_reason?: string;
  refund_amount?: string;
  refund_reason?: string;
  account_deleted_date?: string;
  calibration_pct?: number;      // 0-100
  picks_today?: number;
  top_pick_summary?: string;
}

const DISCLAIMER_HTML = `<p style="margin-top:24px;padding-top:16px;border-top:1px solid #eee;font-size:11px;color:#888;line-height:1.5">
SharpAI provides analytics — <strong>not financial or betting advice</strong>. Past performance is not indicative of future results. Bet responsibly. If gambling is no longer fun, contact 1-800-GAMBLER for support.
</p>`;

function shell(title: string, body: string): string {
  return `<!doctype html><html><body style="font-family:-apple-system,Helvetica,sans-serif;max-width:560px;margin:32px auto;padding:0 16px;color:#222">
<h2 style="color:#111;font-weight:600">${title}</h2>
${body}
${DISCLAIMER_HTML}
</body></html>`;
}

function nameFrom(vars: EmailVars): string {
  return vars.first_name || (vars.email ? vars.email.split("@")[0] : "there");
}

// ============================================================
// Template registry
// ============================================================
function renderTemplate(template: EmailTemplate, vars: EmailVars): { subject: string; html: string } {
  const name = nameFrom(vars);
  switch (template) {
    case "welcome":
      return {
        subject: "Welcome to SharpAI",
        html: shell(`Welcome, ${name}`,
          `<p>Your account is live. SharpAI analyzes NBA and MLB player props with a 26-factor algorithm and surfaces high-confidence picks with calibrated Kelly stake recommendations.</p>
<p>Sign in to your dashboard: <a href="https://sharpai.bet" style="color:#10b981">sharpai.bet</a></p>
<p><strong>What to expect:</strong></p>
<ul>
<li>Daily picks at noon ET (NBA) and 30-min cadence (MLB)</li>
<li>Calibrated confidence tiers — Elite (90+), Strong (80-89), Good (70-79)</li>
<li>Kelly stake recommendations sized to your bankroll preference</li>
</ul>`),
      };
    case "trial_ending":
      return {
        subject: "Your SharpAI trial ends in 2 days",
        html: shell(`Trial reminder, ${name}`,
          `<p>Your free trial ends on <strong>${vars.trial_end_date ?? "soon"}</strong>. To keep your subscription active, no action needed — billing continues automatically at your selected plan.</p>
<p>To cancel before billing: <a href="https://sharpai.bet/settings" style="color:#10b981">Settings → Subscription</a>.</p>
<p>Recent calibration: <strong>${vars.calibration_pct ?? "—"}% WR on 70+ tier picks (rolling 30 days)</strong>.</p>`),
      };
    case "payment_succeeded":
      return {
        subject: "Payment received — SharpAI",
        html: shell(`Payment confirmed, ${name}`,
          `<p>We received your payment of <strong>${vars.payment_amount ?? "$0.00"}</strong>. Your subscription is active through <strong>${vars.payment_period_end ?? "next cycle"}</strong>.</p>
<p>Invoice + history: <a href="https://sharpai.bet/settings" style="color:#10b981">Settings → Billing</a></p>`),
      };
    case "payment_failed":
      return {
        subject: "Payment issue — action required",
        html: shell(`Payment failed, ${name}`,
          `<p>We couldn't charge your card. Reason: <strong>${vars.failure_reason ?? "unknown"}</strong>.</p>
<p>To avoid an interruption to your subscription, please update your payment method: <a href="https://sharpai.bet/settings" style="color:#10b981">Settings → Billing</a></p>
<p>We'll retry the charge in 3 days.</p>`),
      };
    case "refund_processed":
      return {
        subject: "Refund processed — SharpAI",
        html: shell(`Refund confirmed, ${name}`,
          `<p>We've processed a refund of <strong>${vars.refund_amount ?? "$0.00"}</strong> to your original payment method. Funds typically appear within 5-10 business days.</p>
${vars.refund_reason ? `<p>Reason: ${vars.refund_reason}</p>` : ""}`),
      };
    case "account_deleted":
      return {
        subject: "Account deleted — SharpAI",
        html: shell(`Account closed, ${name}`,
          `<p>As requested, your SharpAI account was permanently deleted on <strong>${vars.account_deleted_date ?? "today"}</strong>.</p>
<p>All personal data has been removed per our privacy policy. Pick history aggregate stats are retained for algorithm calibration but are not linked to your identity.</p>
<p>You can sign up again at any time at <a href="https://sharpai.bet" style="color:#10b981">sharpai.bet</a>.</p>`),
      };
    case "daily_digest":
      return {
        subject: `Today's picks · ${vars.picks_today ?? 0} new`,
        html: shell(`Today's slate, ${name}`,
          `<p><strong>${vars.picks_today ?? 0}</strong> new picks at 70+ confidence today.</p>
${vars.top_pick_summary ? `<p>Top pick: <strong>${vars.top_pick_summary}</strong></p>` : ""}
<p>Full slate: <a href="https://sharpai.bet" style="color:#10b981">sharpai.bet</a></p>
<p style="font-size:11px;color:#888">To stop daily emails: Settings → Notifications → toggle off Daily Digest.</p>`),
      };
  }
}

// ============================================================
// Send via Resend
// ============================================================
export async function sendEmail(
  to: string,
  template: EmailTemplate,
  vars: EmailVars = {},
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const apiKey = Deno.env.get("RESEND_API_KEY");
  if (!apiKey) {
    // D-272-INF-5 #5: do NOT write error_log here. Pre-fix every send
    // attempt at every cron tick wrote a "resend_not_configured" row,
    // polluting error-rate dashboards while RESEND_API_KEY remained
    // unseeded by the CEO. Console.log keeps the signal in
    // `supabase functions logs` so the missing-secret state is still
    // visible without spamming error_log.
    console.log(`[_shared/email] resend_not_configured template=${template} to=${to}`);
    return { ok: false, error: "resend_not_configured" };
  }

  const { subject, html } = renderTemplate(template, vars);

  try {
    const res = await fetch(RESEND_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: FROM_ADDRESS,
        to: [to],
        reply_to: REPLY_TO,
        subject,
        html,
      }),
    });
    const body = await res.text();
    if (!res.ok) {
      await logEmailError("resend_api_error", `Resend POST ${res.status}: ${body.slice(0, 300)}`, { to, template });
      return { ok: false, error: `resend_status_${res.status}` };
    }
    try {
      const j = JSON.parse(body);
      await logEmailSent(to, template, j.id);
      return { ok: true, id: j.id };
    } catch {
      return { ok: true };
    }
  } catch (e) {
    await logEmailError("resend_network_error", e instanceof Error ? e.message : String(e), { to, template });
    return { ok: false, error: "network" };
  }
}

// ============================================================
// Observability — log every send + every error
// ============================================================
async function logEmailError(errorType: string, message: string, context: Record<string, unknown>) {
  try {
    const url = Deno.env.get("SUPABASE_URL");
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key) return;
    await fetch(`${url}/rest/v1/error_log`, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({
        function_name: "_shared/email",
        phase: "send",
        error_type: errorType,
        error_message: message,
        context,
      }),
    });
  } catch { /* swallow */ }
}

async function logEmailSent(to: string, template: EmailTemplate, resendId: string | undefined) {
  try {
    const url = Deno.env.get("SUPABASE_URL");
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key) return;
    await fetch(`${url}/rest/v1/notifications_log`, {
      method: "POST",
      headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({
        severity: "info",
        metadata: { template, to_email_domain: to.split("@")[1], resend_id: resendId },
        sent_to: "email",
        delivered_at: new Date().toISOString(),
      }),
    });
  } catch { /* swallow */ }
}
