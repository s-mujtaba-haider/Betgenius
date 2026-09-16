# scripts/

CLI helpers for build-time gates and UI verification.

## visual_verify.mjs (D-240)

Headless browser checks that the deployed SharpAI surface actually renders
the content a code change was supposed to produce. Required by Cardinal Rule
§1.18 — algorithm/UI fixes are not "done" until visual_verify or an
equivalent rendered-DOM check passes.

### Quick start

Public surface, no auth (works against current prod):

```bash
node scripts/visual_verify.mjs \
  --sport=mlb \
  --assert="Kyle Schwarber" \
  --not="L5: N/A, Season: N/A, L10: N/A" \
  --screenshot=.puppeteer/screenshots/d240_smoke.png
```

Specific tab:

```bash
node scripts/visual_verify.mjs \
  --tab=Performance \
  --assert="Hit Rate" \
  --screenshot=.puppeteer/screenshots/performance.png
```

Authenticated surface (requires `.puppeteer/session.json` — see below):

```bash
node scripts/visual_verify.mjs \
  --auth=yes \
  --tab=Dashboard \
  --assert="70+ Confidence" \
  --screenshot=.puppeteer/screenshots/subscriber_view.png
```

### CLI flags

| flag             | description                                                          | default                              |
|------------------|----------------------------------------------------------------------|--------------------------------------|
| `--url`          | full URL (overrides `--base-url` + tab)                              | —                                    |
| `--base-url`     | site origin                                                          | `https://betgenius-eight.vercel.app` |
| `--sport`        | `nba` or `mlb` — clicks the sport toggle after page load             | none                                 |
| `--tab`          | page tab to click (`Dashboard`, `Evaluator`, …)                      | `Dashboard`                          |
| `--assert <str>` | string that MUST appear in rendered DOM. Repeatable.                 | —                                    |
| `--not <str>`    | string that MUST NOT appear in rendered DOM. Repeatable.             | —                                    |
| `--screenshot`   | full-page PNG output path                                            | —                                    |
| `--dom`          | rendered DOM dump output path (innerText + outerHTML)                | —                                    |
| `--viewport`     | `WIDTHxHEIGHT`                                                       | `1280x900`                           |
| `--wait-for`     | CSS selector to await before assertions                              | —                                    |
| `--wait-ms`      | fixed delay (ms) after navigation                                    | `8000`                               |
| `--auth`         | `no` (default) or `yes` — load `.puppeteer/session.json`             | `no`                                 |
| `--headful`      | show browser window                                                  | hidden                               |
| `--timeout`      | per-step timeout in ms                                               | `30000`                              |

### Exit codes

| code | meaning                                                                        |
|------|--------------------------------------------------------------------------------|
| 0    | all assertions passed                                                          |
| 1    | assertion failure (a required string missing or a forbidden string present)    |
| 2    | navigation / setup error (puppeteer launch failed, network error, timeout)     |
| 3    | `--auth=yes` requested but `.puppeteer/session.json` is missing or unparseable |

### Authenticated runs — seeding `session.json`

The subscriber Dashboard, Evaluator, BetTracker, Performance, and Stats
surfaces require a Supabase auth session. To seed cookies for headless
verification:

1. In a real browser, log in to `https://betgenius-eight.vercel.app` as a
   test subscriber (NOT a personal account).
2. Open DevTools → Application → Cookies → copy the value of
   `sb-gzuzuqxvfjszlfclhcfz-auth-token`.
3. Copy `.puppeteer/session_template.json` to `.puppeteer/session.json` and
   paste the value into the placeholder.
4. `session.json` is gitignored — never commit it.

If a CEO test subscriber has not been seeded yet, public surfaces (Landing,
unauthenticated routes) still verify cleanly with the default `--auth=no`.

### Cardinal Rule §1.18 application

Whenever an algorithm or UI fix is intended to surface in the rendered UI:

1. After deploy, run visual_verify with assertions that pin the expected
   change. Examples:
   - data-format fix → `--assert="L5: 80%"` + `--not="L5: N/A"`
   - new tile           → `--assert="Pitcher K"`
   - regression check   → `--not="undefined"` + `--not="NaN"`
2. Capture the screenshot into the D-record report.
3. If assertions fail, the fix is **NOT** shipped. Self-graded "code looks
   right" does not substitute for rendered-DOM evidence.

## seed_subscriber_session.mjs (D-252 Task A)

One-shot interactive seeder for `.puppeteer/session.json` — unblocks
authenticated visual_verify runs against subscriber-gated surfaces
(Dashboard, Performance, Tracker, Evaluator, Stats, Settings).

### How to run (CEO action)

1. **Use a gmail+alias address** so the test subscriber is isolated from
   your personal account but still receives magic links in your inbox.
   Example: `test@example.com`

2. Run from the project root:

   ```bash
   node scripts/seed_subscriber_session.mjs --email=test@example.com
   ```

3. **A browser window opens** at `https://betgenius-eight.vercel.app/?signin=1`.

4. **In the browser**:
   - Enter the same email address you passed via `--email`
   - Check TOS + 21+ checkboxes
   - Click "Send magic link"

5. **In Gmail** (any tab/window):
   - Find the magic-link email
   - Click the magic link — it will open in a new tab; that's fine

6. **Script auto-detects** the Supabase auth cookie within ~3 seconds of
   the magic link landing. It captures all cookies, writes
   `.puppeteer/session.json` (chmod 0600), and auto-closes the browser
   after a 5-second grace period.

7. **Verify**: a quick smoke confirms the seed worked:

   ```bash
   node scripts/visual_verify.mjs --auth=yes --assert="Dashboard"
   ```

### CLI flags

| Flag | Description | Default |
|------|-------------|---------|
| `--email` | gmail+alias address (required) | — |
| `--timeout-mins` | minutes to wait for auth | 15 |
| `--ci` | headless mode (overrides default headful) | off |

### Output

`.puppeteer/session.json` — gitignored, chmod 0600. Contains every cookie
captured for `betgenius-eight.vercel.app`. Format matches what
`visual_verify.mjs --auth=yes` expects.

### Troubleshooting

- **Timeout after N minutes / no auth cookie**: magic link wasn't clicked
  OR Resend isn't configured OR email landed in spam. Check email
  delivery first. Re-run seeder.
- **Auth cookie name changed**: update `AUTH_COOKIE_NAME` constant in the
  script. Current value: `sb-gzuzuqxvfjszlfclhcfz-auth-token`.

---

## lint_disclaimer.mjs (D-218)

CI gate that ensures every subscriber-facing rendered surface carries the
§10.6 disclaimer string ("not financial or betting advice"). Run via
`npm run lint:disclaimer` (auto-runs as part of `npm run build`).

---

## Edge-function dry-run mode (D-253f)

Four critical edge functions accept `body.dry_run: true` to exercise the
full read + scoring path without any production-table writes. Used for safe
post-deploy smoke testing and CEO/operator validation.

### Functions gated

| function           | tables WRITES suppressed                                         |
|--------------------|------------------------------------------------------------------|
| `fetch-odds`       | props_cache, cache_game_lines, api_usage, error_log              |
| `process-games`    | pick_history, recommendations_cache, cron_progress, cache_*, run_log, error_log, notifications_log |
| `process-games-mlb`| recommendations_cache, pick_history, error_log, notifications_log |
| `resolve-picks`    | pick_history (PATCH actual_value/hit/voided), bets (PATCH), notifications_log |

### Auth

All four require a service-role bearer (matches `SUPABASE_SERVICE_ROLE_KEY`,
any `SUPABASE_SECRET_KEYS` value, or `BACKFILL_AUTH_TOKEN`).

### Quick invocation

```bash
KEY=$(grep "^SUPABASE_SERVICE_ROLE_KEY" .env.local | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")

# fetch-odds dry-run (no quota burn beyond reads; no DB writes)
curl -s -X POST https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/fetch-odds \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"dry_run": true}'

# process-games dry-run (NBA; bypasses time gate too)
curl -s -X POST https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/process-games \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"dry_run": true}'

# process-games-mlb dry-run (combine with bypass_cache_gate for off-hours)
curl -s -X POST https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/process-games-mlb \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"dry_run": true, "bypass_cache_gate": true}'

# resolve-picks dry-run (skips updatePickResult, voidPick, bets PATCH)
curl -s -X POST https://gzuzuqxvfjszlfclhcfz.supabase.co/functions/v1/resolve-picks \
  -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -d '{"dry_run": true}'
```

### Response shape (dry-run)

All four functions return a JSON object with at least:

```json
{
  "dry_run": true,
  "would_write": { "<table_name>": <count>, ... },
  "sample_pick": { /* first scored row, when applicable */ },
  "elapsed_ms": 12345
}
```

The non-dry-run shape is COMPLETELY UNCHANGED — the gate sits at the
function's entry handler and only branches on `body.dry_run === true`.

### Known caveat

`process-games-mlb` dry-run still writes ~5-50 rows to `error_log` via the
shared `_shared/anthropic_mlb.ts` helper's `sonnet_gated_below_70` observability
log. This is intentionally NOT gated in the current pass per the D-253f scope
("do not modify shared `_shared/` files"). Track via D-253f follow-up.

### Verification

Before/after row counts for the target tables are the canonical proof.
Pattern:

```bash
URL="https://gzuzuqxvfjszlfclhcfz.supabase.co/rest/v1"
KEY=$(grep "^SUPABASE_SERVICE_ROLE_KEY" .env.local | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'")
curl -s -H "apikey: $KEY" -H "Authorization: Bearer $KEY" \
  -H "Prefer: count=exact" -H "Range: 0-0" \
  "$URL/pick_history?select=*" -I 2>&1 | grep -i content-range
# → content-range: 0-9999/<TOTAL_ROW_COUNT>
```

Run the count BEFORE the dry-run + AFTER; deltas across these tables must be
zero (modulo the `_shared/anthropic_mlb` caveat above).
