// User preferences sync — §15.10 Critical #2 (May 12, 2026).
//
// PROBLEM: kelly_aggressiveness, bankroll, my_books, sport were stored
// per-device in localStorage. Same logged-in user saw different values on
// phone vs laptop. Subscriber-launch blocker.
//
// SOLUTION: this module wraps the Supabase user_preferences table.
// localStorage stays as a cache (anonymous fallback + instant first paint
// before the async server hydration completes). On sign-in the App fires
// hydrateUserPreferences() which fetches the server row and writes it
// into localStorage, so existing sync readers (readBankroll() etc.) pick
// up the synced values on next access.
//
// Settings writes call saveUserPreferences() which writes BOTH the server
// row and localStorage. Anonymous users (no session) get localStorage-only
// behavior automatically because every server call is gated on a session.
//
// Anti-regression notes:
//   - Existing sync readers (readBankroll, readKellyFractionMode,
//     readStoredSport, Settings books loader) are NOT removed. They still
//     work for the anonymous-mode path and as the first-paint cache.
//   - Anonymous mode is the no-session branch — unchanged from before.
//   - Hydration is fire-and-forget on the App; consumers don't block on it.

import type { Session } from "@supabase/supabase-js";
import { SUPABASE_URL } from "./supabase";
import {
  KELLY_FRACTION_KEY,
  BANKROLL_KEY,
  DEFAULT_BANKROLL,
  DEFAULT_KELLY_FRACTION_MODE,
  KELLY_FRACTION_OPTIONS,
  type KellyFractionMode,
} from "./kelly";
import { SPORT_KEY, type Sport } from "./sport";

// localStorage key for "my_books" — defined directly in Settings.tsx
// (line 30) and read in Dashboard / Evaluator. Centralizing here for
// the sync layer; the Settings module continues to reference its own
// local constant for backwards-compat. Both point to the same key string.
const BOOKS_KEY = "betgenius_user_books";

export interface UserPreferences {
  kelly_aggressiveness: KellyFractionMode;
  bankroll: number;
  my_books: string[];
  sport_preference: Sport;
  discretionary_stake: number;
}

export const DEFAULT_BOOKS: string[] = ["hardrockbet"];
export const DEFAULT_SPORT: Sport = "nba";
export const DEFAULT_DISCRETIONARY_STAKE = 5;
// localStorage cache key for discretionary stake — first-paint fallback
// before server hydration.
export const DISCRETIONARY_STAKE_KEY = "sharpai_discretionary_stake";

export function readDiscretionaryStake(): number {
  try {
    const raw = localStorage.getItem(DISCRETIONARY_STAKE_KEY);
    if (raw) {
      const n = parseFloat(raw);
      if (Number.isFinite(n) && n >= 0) return n;
    }
  } catch { /* ignore */ }
  return DEFAULT_DISCRETIONARY_STAKE;
}

const ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string;

// Read the current localStorage state as a UserPreferences object. Used as
// the initial fallback before server hydration completes, and as the source
// for first-time INSERT into the user_preferences table.
export function readPreferencesFromLocalStorage(): UserPreferences {
  let mode: KellyFractionMode = DEFAULT_KELLY_FRACTION_MODE;
  try {
    const stored = localStorage.getItem(KELLY_FRACTION_KEY);
    if (stored && stored in KELLY_FRACTION_OPTIONS) mode = stored as KellyFractionMode;
  } catch { /* private mode */ }

  let bankroll = DEFAULT_BANKROLL;
  try {
    const stored = localStorage.getItem(BANKROLL_KEY);
    if (stored) {
      const n = parseFloat(stored);
      if (Number.isFinite(n) && n > 0) bankroll = n;
    }
  } catch { /* ignore */ }

  let books: string[] = DEFAULT_BOOKS;
  try {
    const raw = localStorage.getItem(BOOKS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.every((b) => typeof b === "string") && parsed.length > 0) {
        books = parsed;
      }
    }
  } catch { /* ignore parse errors */ }

  let sport: Sport = DEFAULT_SPORT;
  try {
    const stored = localStorage.getItem(SPORT_KEY);
    if (stored === "mlb" || stored === "nba") sport = stored;
  } catch { /* ignore */ }

  const discretionary_stake = readDiscretionaryStake();

  return {
    kelly_aggressiveness: mode, bankroll, my_books: books,
    sport_preference: sport, discretionary_stake,
  };
}

// Write a UserPreferences object back to localStorage. Used after server
// hydration so existing sync readers (readBankroll() etc.) see the synced
// values. Fires a `storage` event manually so in-tab listeners (Dashboard
// books listener) re-render — browsers only fire `storage` for cross-tab
// writes, not same-tab.
function writePreferencesToLocalStorage(p: UserPreferences): void {
  try { localStorage.setItem(KELLY_FRACTION_KEY, p.kelly_aggressiveness); } catch { /* */ }
  try { localStorage.setItem(BANKROLL_KEY, String(p.bankroll)); } catch { /* */ }
  try { localStorage.setItem(BOOKS_KEY, JSON.stringify(p.my_books)); } catch { /* */ }
  try { localStorage.setItem(DISCRETIONARY_STAKE_KEY, String(p.discretionary_stake)); } catch { /* */ }
  // sport_preference: writeStoredSport is currently a no-op per D-049,
  // so don't write to localStorage here. The field is stored server-side
  // for future re-enable when MLB scoring ships.

  // Notify same-tab listeners — Dashboard line ~135 listens for `storage`
  // events on `betgenius_user_books`. The native `storage` event doesn't
  // fire in the writing tab; this manual dispatch makes the cross-device
  // hydration trigger the same UI refresh path that cross-tab writes do.
  try {
    window.dispatchEvent(new StorageEvent("storage", {
      key: BOOKS_KEY,
      newValue: JSON.stringify(p.my_books),
    }));
  } catch { /* StorageEvent constructor unsupported in old browsers */ }
}

function authHeaders(session: Session | null): Record<string, string> {
  const token = session?.access_token ?? ANON_KEY;
  return {
    apikey: ANON_KEY,
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
}

// Fetches the user_preferences row for the signed-in user, or null if no
// row yet exists. Returns null on any error (caller treats as "not found").
async function fetchUserPreferences(session: Session): Promise<UserPreferences | null> {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/user_preferences?user_id=eq.${session.user.id}` +
        `&select=kelly_aggressiveness,bankroll,my_books,sport_preference,discretionary_stake`,
      { headers: authHeaders(session) },
    );
    if (!res.ok) return null;
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) return null;
    const r = rows[0];
    // Defensive parsing: server values should match the constraints, but
    // coerce just in case schema drifts later.
    const mode: KellyFractionMode = (r.kelly_aggressiveness in KELLY_FRACTION_OPTIONS)
      ? r.kelly_aggressiveness
      : DEFAULT_KELLY_FRACTION_MODE;
    const bankroll = Number.isFinite(Number(r.bankroll)) && Number(r.bankroll) > 0
      ? Number(r.bankroll)
      : DEFAULT_BANKROLL;
    const books = Array.isArray(r.my_books) && r.my_books.length > 0
      ? (r.my_books as string[])
      : DEFAULT_BOOKS;
    const sport: Sport = (r.sport_preference === "mlb" || r.sport_preference === "nba")
      ? r.sport_preference
      : DEFAULT_SPORT;
    const discretionary_stake = Number.isFinite(Number(r.discretionary_stake)) && Number(r.discretionary_stake) >= 0
      ? Number(r.discretionary_stake)
      : DEFAULT_DISCRETIONARY_STAKE;
    return {
      kelly_aggressiveness: mode, bankroll, my_books: books,
      sport_preference: sport, discretionary_stake,
    };
  } catch {
    return null;
  }
}

// Inserts a row for a brand-new user, using current localStorage values
// (or defaults if localStorage is empty). Returns the inserted row on
// success, or null on failure.
async function insertUserPreferences(
  session: Session,
  prefs: UserPreferences,
): Promise<UserPreferences | null> {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/user_preferences`,
      {
        method: "POST",
        headers: { ...authHeaders(session), Prefer: "return=representation" },
        body: JSON.stringify({
          user_id: session.user.id,
          kelly_aggressiveness: prefs.kelly_aggressiveness,
          bankroll: prefs.bankroll,
          my_books: prefs.my_books,
          sport_preference: prefs.sport_preference,
          discretionary_stake: prefs.discretionary_stake,
        }),
      },
    );
    if (!res.ok) return null;
    const rows = await res.json();
    if (!Array.isArray(rows) || rows.length === 0) return null;
    return prefs;
  } catch {
    return null;
  }
}

// Hydration entrypoint — called from App.tsx after session loads. Reconciles
// localStorage with the server row:
//   - If server row exists: server wins. localStorage overwritten so sync
//     readers (readBankroll, etc.) reflect the synced values.
//   - If no server row: first authenticated visit. INSERT current
//     localStorage values as the initial server row. This preserves any
//     legacy settings the user already configured.
//   - If session is null (anonymous): no-op. Anonymous users continue
//     using localStorage directly.
//
// Returns the reconciled preferences, or null on hard failure (caller
// should fall back to localStorage).
export async function hydrateUserPreferences(
  session: Session | null,
): Promise<UserPreferences | null> {
  if (!session) return null;

  const server = await fetchUserPreferences(session);
  if (server) {
    writePreferencesToLocalStorage(server);
    return server;
  }

  // No server row: INSERT from current localStorage so settings persist
  // across the first cross-device sign-in.
  const local = readPreferencesFromLocalStorage();
  const inserted = await insertUserPreferences(session, local);
  if (inserted) {
    writePreferencesToLocalStorage(inserted);
    return inserted;
  }

  // INSERT failed (e.g., race condition, RLS error). Return local; the
  // server stays empty until the next save attempt.
  return local;
}

// Save endpoint — Settings page calls this when the user changes any
// preference. Writes to both server (if signed in) and localStorage.
// Anonymous mode: localStorage only.
export async function saveUserPreferences(
  session: Session | null,
  updates: Partial<UserPreferences>,
): Promise<void> {
  // Always update localStorage cache first for instant in-tab feedback.
  // This means existing sync readers see the new values immediately, and
  // any failure on the server write doesn't block the UI.
  const current = readPreferencesFromLocalStorage();
  const next: UserPreferences = { ...current, ...updates };
  writePreferencesToLocalStorage(next);

  if (!session) return; // anonymous — localStorage only

  // Try UPDATE first; if 0 rows affected (no row exists yet), fall back to
  // INSERT. PostgREST returns the affected rows when Prefer:
  // return=representation is set.
  try {
    const patchRes = await fetch(
      `${SUPABASE_URL}/rest/v1/user_preferences?user_id=eq.${session.user.id}`,
      {
        method: "PATCH",
        headers: { ...authHeaders(session), Prefer: "return=representation" },
        body: JSON.stringify({
          kelly_aggressiveness: next.kelly_aggressiveness,
          bankroll: next.bankroll,
          my_books: next.my_books,
          sport_preference: next.sport_preference,
          discretionary_stake: next.discretionary_stake,
        }),
      },
    );
    if (patchRes.ok) {
      const rows = await patchRes.json();
      if (Array.isArray(rows) && rows.length > 0) return; // updated existing row
    }
    // PATCH affected 0 rows or errored — try INSERT.
    await insertUserPreferences(session, next);
  } catch {
    // Server write failed — localStorage already updated above, so the UI
    // reflects the user's intent. Next sign-in re-attempts via hydration.
  }
}
