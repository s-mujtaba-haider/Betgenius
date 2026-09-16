# Phase 1 MLB — pack for a new developer

This zip has **source + docs + example env**. It does **not** have live passwords.

## You will NOT find in this zip
- `harness/.env` (real database URL)
- Odds API key
- Supabase service role
- AWS `.pem`
- Client name / contract price

Ask the person who hired you for **read-only** `HARNESS_DATABASE_URL` in a private chat, after they decide you are hired. Put it only in your local `betgenius/harness/.env` (copy from `.env.example`). Never commit it. Never paste it into ChatGPT / Claude / public GitHub.

## First files to read
1. `Phase1-MLB-Developer-Handoff.md` (this folder)
2. `betgenius/CLAUDE.md`
3. `betgenius/harness/PHASE1_SCOPE.md`
4. `betgenius/harness/.env.example`

## Hard rules
- Do not edit `betgenius/supabase/functions/_shared/scoring_mlb_v2.ts` or `algorithm_weights` without written GO.
- Do not invent game EV.
- Do not ingest more Odds API history. Cutoff is **2026-05-24**.
- One Deno backtest at a time.

## Local setup
```
cd betgenius
copy harness\.env.example harness\.env
# then fill HARNESS_DATABASE_URL privately

# public TLS cert (not a secret)
# save as betgenius\prod-ca-2021.crt
# PowerShell: $env:DENO_CERT = "$PWD\prod-ca-2021.crt"

deno run --no-check --allow-env --allow-read --allow-write harness/test/run_smoke_tests.ts
```

Smoke tests do not need the database.
