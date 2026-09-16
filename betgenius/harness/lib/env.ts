// Phase 1 backtest harness — read-only Postgres access.
//
// Standalone Deno CLI (not an edge function). Credentials come from
// harness/.env (preferred) or process env — never committed. Every DB call
// is a SELECT; nothing here writes to the database.
//
// Setup: copy harness/.env.example -> harness/.env and fill in
// HARNESS_DATABASE_URL.

import { Client } from "https://deno.land/x/postgres@v0.19.3/mod.ts";

type SqlClient = Client;

let client: SqlClient | null = null;
let clientConnected = false;
let dotEnvLoaded = false;

export interface Db {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
}

/** Load harness/.env into Deno.env (does not override vars already set). */
export function loadHarnessEnv(): void {
  if (dotEnvLoaded) return;
  dotEnvLoaded = true;

  const envFile = new URL("../.env", import.meta.url);
  let text: string;
  try {
    text = Deno.readTextFileSync(envFile);
  } catch {
    return; // no .env — rely on exported env vars
  }

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (Deno.env.get(key) === undefined) Deno.env.set(key, val);
  }
}

function getConnectionString(): string {
  loadHarnessEnv();
  const url = Deno.env.get("HARNESS_DATABASE_URL") ?? Deno.env.get("DATABASE_URL");
  if (!url) {
    throw new Error(
      "[harness] Missing HARNESS_DATABASE_URL.\n" +
        "  Copy harness/.env.example -> harness/.env and set HARNESS_DATABASE_URL,\n" +
        "  or export HARNESS_DATABASE_URL='postgresql://user:pass@host:5432/postgres?sslmode=require'",
    );
  }
  return url;
}

function isTransientDbError(e: unknown): boolean {
  const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  const lower = msg.toLowerCase();
  return (
    msg.includes("UnexpectedEof") ||
    lower.includes("close_notify") ||
    lower.includes("brokenpipe") ||
    lower.includes("connection reset") ||
    lower.includes("connection refused") ||
    lower.includes("too many connections") ||
    lower.includes("server closed the connection") ||
    lower.includes("db_termination") ||
    (lower.includes("tls") && lower.includes("closed")) ||
    lower.includes("no such host") ||
    lower.includes("getaddrinfo") ||
    lower.includes("name or service not known") ||
    (lower.includes("enoent") && lower.includes("host"))
  );
}

async function ensureClient(): Promise<SqlClient> {
  if (!client) {
    client = new Client(getConnectionString());
  }
  if (!clientConnected) {
    await client.connect();
    clientConnected = true;
  }
  return client;
}

function normalizePgRow<T>(row: T): T {
  if (row === null || typeof row !== "object") return row;
  const out = { ...row } as Record<string, unknown>;
  for (const [key, value] of Object.entries(out)) {
    if (typeof value === "bigint") {
      // Deno postgres returns bigint columns as BigInt. Map keys must be
      // number or Statcast AS-OF (and any other player_id join) silently misses.
      out[key] = Number(value);
    } else if (
      key === "line" &&
      typeof value === "string" &&
      Number.isFinite(Number(value))
    ) {
      // `numeric` line comes through as a string. gradeGameOutcome home path
      // does `margin + line`; a string concatenates and never covers -1.5.
      out[key] = Number(value);
    } else if (value instanceof Date) {
      // date columns arrive at UTC midnight; timestamptz keeps full ISO.
      const iso = value.toISOString();
      out[key] = iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : iso;
    }
  }
  return out as T;
}

/** Build a Db handle from env / harness/.env. Call closePool() when done. */
export function getDbFromEnv(): Db {
  return {
    async query<T>(querySql: string, params: unknown[] = []): Promise<T[]> {
      const maxAttempts = 4;
      let lastErr: unknown;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const pg = await ensureClient();
          const result = await pg.queryObject<T>(querySql, params);
          return result.rows.map((row) => normalizePgRow(row));
        } catch (e) {
          lastErr = e;
          if (!isTransientDbError(e) || attempt === maxAttempts) throw e;
          const detail = e instanceof Error ? e.message : String(e);
          console.warn(
            `[harness] DB connection dropped (${attempt}/${maxAttempts}): ${detail}. Reconnecting...`,
          );
          await closePool();
          await new Promise((r) => setTimeout(r, 1000 * attempt));
        }
      }
      throw lastErr;
    },
  };
}

/** Close the DB connection. Safe to call multiple times. */
export async function closePool(): Promise<void> {
  const pg = client;
  const wasConnected = clientConnected;
  client = null;
  clientConnected = false;
  if (!pg || !wasConnected) return;
  try {
    await pg.end();
  } catch (e) {
    console.warn("[harness] DB close warning:", e);
  }
}

/** Chunk an array into batches (long IN lists, bulk player-id fetches). */
export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
