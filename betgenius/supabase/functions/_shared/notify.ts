// notify() — Twilio SMS alerts on critical production failures.
//
// Refactored May 6, 2026 evening per CEO spec — two engineering improvements
// over the previous same-day version (migration 20260506000006):
//   1. INSERT-first pattern: audit row created BEFORE Twilio call, then
//      UPDATEd with the outcome. Guarantees audit exists even if Twilio
//      call hangs/crashes mid-flight (a single-INSERT-after-decision
//      pattern would lose the audit row in that case).
//   2. Severity-specific rate limits: 15min critical / 60min warning.
//      Warnings naturally fire less burstily; uniform 15min was too tight
//      for legitimate periodic warnings.
//
// Design invariants (unchanged):
//   - NEVER crash calling function. Every codepath catches; SMS is
//     observability, not control flow.
//   - Severity tiering: info=log only, warning=daytime SMS only
//     (8am-11pm ET), critical=24/7 SMS.
//   - Persistent state via notifications_log table — edge functions are
//     stateless across invocations.
//   - Twilio creds optional. When missing, system marks delivered_via='log'
//     and continues. CEO wires Twilio later without code changes.
//   - No PII in SMS body. Caller responsible for not passing emails/cards/IPs.
//
// Usage:
//   import { notify } from "../_shared/notify.ts";
//   await notify({ severity: 'critical', title: 'X', message: 'Y' });

interface NotifyArgs {
  severity: "critical" | "warning" | "info";
  title: string;
  message: string;
  metadata?: Record<string, unknown>;
}

const SEVERITY_EMOJI: Record<string, string> = {
  critical: "🔴",
  warning: "🟡",
  info: "🔵",
};

// Severity-specific rate-limit windows (minutes). Critical alerts can fire
// 4x/hour for the same title; warnings 1x/hour. Info alerts have no SMS so
// rate limit is moot for them but we still suppress duplicate audit rows.
const RATE_LIMIT_MIN: Record<string, number> = {
  critical: 15,
  warning: 60,
  info: 60,
};

// Waking hours in Eastern Time (using -4h DST offset; close enough for
// alert routing — not safety-critical to be exact)
const WAKING_HOURS_START_ET = 8;   // 8am ET
const WAKING_HOURS_END_ET = 23;    // 11pm ET
const EDT_OFFSET_HOURS = 4;

function getServiceKey(): string {
  return Deno.env.get("BACKFILL_AUTH_TOKEN")
    || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")
    || "";
}

function isWithinWakingHoursET(): boolean {
  const now = new Date(Date.now() - EDT_OFFSET_HOURS * 60 * 60 * 1000);
  const hour = now.getUTCHours();
  return hour >= WAKING_HOURS_START_ET && hour < WAKING_HOURS_END_ET;
}

// Step 1 of every notify call: insert a row immediately. Returns the row's
// UUID (so we can UPDATE it later with the outcome) or null if the insert
// itself failed.
async function insertAuditRow(
  url: string, key: string, args: NotifyArgs,
): Promise<string | null> {
  if (!url || !key) return null;
  try {
    const res = await fetch(`${url}/rest/v1/notifications_log`, {
      method: "POST",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "return=representation",
      },
      body: JSON.stringify({
        severity: args.severity,
        title: String(args.title).slice(0, 200),
        message: String(args.message).slice(0, 1000),
        metadata: args.metadata ?? null,
        delivered_via: "log", // default; will UPDATE to 'both' if SMS succeeds
      }),
    });
    if (!res.ok) return null;
    const rows = await res.json();
    return Array.isArray(rows) && rows.length > 0 ? String(rows[0].id) : null;
  } catch (_e) {
    return null;
  }
}

// Step 4 of notify (success path): mark the row delivered_via='both' and
// store the Twilio response.
async function patchAuditRow(
  url: string, key: string, rowId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  if (!url || !key || !rowId) return;
  try {
    await fetch(`${url}/rest/v1/notifications_log?id=eq.${rowId}`, {
      method: "PATCH",
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(patch),
    });
  } catch (_e) {
    // silent — never crash caller
  }
}

// Rate-limit check: return true if a SUCCESSFULLY-DELIVERED alert with the
// same title was sent within the severity-specific window. delivered_via
// IN ('sms', 'both') means SMS actually went out; we don't count log-only
// rows toward rate limit (those mean Twilio was missing, not actual sends).
async function shouldRateLimit(
  url: string, key: string, severity: string, title: string,
): Promise<boolean> {
  if (!url || !key) return false;
  try {
    const windowMin = RATE_LIMIT_MIN[severity] ?? 15;
    const cutoff = new Date(Date.now() - windowMin * 60 * 1000).toISOString();
    const res = await fetch(
      `${url}/rest/v1/notifications_log` +
        `?title=eq.${encodeURIComponent(title)}` +
        `&created_at=gte.${encodeURIComponent(cutoff)}` +
        `&delivered_via=in.(sms,both)` +
        `&select=id&limit=1`,
      {
        headers: { apikey: key, Authorization: `Bearer ${key}` },
      },
    );
    if (!res.ok) return false;
    const rows = await res.json();
    return Array.isArray(rows) && rows.length > 0;
  } catch (_e) {
    return false;
  }
}

export async function notify(args: NotifyArgs): Promise<void> {
  try {
    const supaUrl = Deno.env.get("SUPABASE_URL") || "";
    const supaKey = getServiceKey();

    // Step 1: ALWAYS insert audit row first (CEO spec). delivered_via
    // starts as 'log'; we'll UPDATE to 'both' if SMS succeeds.
    const rowId = await insertAuditRow(supaUrl, supaKey, args);

    // Step 2: rate-limit check (severity-specific window)
    if (await shouldRateLimit(supaUrl, supaKey, args.severity, args.title)) {
      console.log(`[notify] rate-limited (${RATE_LIMIT_MIN[args.severity]}min): ${args.title}`);
      // Audit row already inserted with delivered_via='log'; nothing more to do.
      // Caller can distinguish rate-limited vs no-twilio by checking whether
      // a more recent sibling row has delivered_via in (sms, both).
      return;
    }

    // Step 3: severity routing
    if (args.severity === "info") {
      console.log(`[notify-info] ${args.title}: ${args.message}`);
      return; // info-tier never SMS
    }
    if (args.severity === "warning" && !isWithinWakingHoursET()) {
      console.log(`[notify-warning] outside waking hours, no SMS: ${args.title}`);
      return; // log row already in place; just no SMS
    }

    // Step 4: Twilio env check
    const sid = Deno.env.get("TWILIO_ACCOUNT_SID") || "";
    const token = Deno.env.get("TWILIO_AUTH_TOKEN") || "";
    const fromNumber = Deno.env.get("TWILIO_FROM_NUMBER") || "";
    const toNumber = Deno.env.get("TWILIO_TO_NUMBER") || "";
    if (!sid || !token || !fromNumber || !toNumber) {
      console.log(`[notify] Twilio env missing — would have sent: ${args.severity} ${args.title}`);
      // Audit row stays delivered_via='log'; CEO sees these in the table
      // and can grep them after enabling Twilio to know what they missed.
      return;
    }

    // Step 5: Send via Twilio
    const emoji = SEVERITY_EMOJI[args.severity] || "⚠️";
    const body = `${emoji} SharpAI: ${args.title} — ${args.message}`.slice(0, 1500);
    const auth = btoa(`${sid}:${token}`);
    const formData = new URLSearchParams({
      From: fromNumber,
      To: toNumber,
      Body: body,
    });

    let twilioResponse: unknown = null;
    let twilioError: string | null = null;
    try {
      const res = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
        {
          method: "POST",
          headers: {
            Authorization: `Basic ${auth}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: formData.toString(),
        },
      );
      const responseText = await res.text();
      try { twilioResponse = JSON.parse(responseText); }
      catch (_e) { twilioResponse = { raw: responseText.slice(0, 500) }; }
      if (!res.ok) {
        twilioError = `twilio ${res.status}: ${responseText.slice(0, 200)}`;
      }
    } catch (e) {
      twilioError = `twilio fetch threw: ${e instanceof Error ? e.message : String(e)}`;
    }

    // Step 6: UPDATE audit row with outcome
    if (rowId) {
      if (twilioError) {
        await patchAuditRow(supaUrl, supaKey, rowId, {
          delivered_via: "log", // SMS attempt failed; row remains log-only
          twilio_response: twilioResponse,
          twilio_error: twilioError.slice(0, 500),
        });
        console.error(`[notify] Twilio failure: ${twilioError}`);
      } else {
        await patchAuditRow(supaUrl, supaKey, rowId, {
          delivered_via: "both",
          twilio_response: twilioResponse,
        });
        const sid_out = (twilioResponse as { sid?: string } | null)?.sid;
        console.log(`[notify] SMS sent: ${args.title} (twilio_sid=${sid_out})`);
      }
    }
  } catch (err) {
    // OUTERMOST catch: never propagate. SMS is observability; if it
    // crashes, the calling function should still complete.
    try {
      console.error(`[notify] caught (suppressed): ${err instanceof Error ? err.message : String(err)}`);
    } catch (_e) { /* truly the end of the line */ }
  }
}
