import { getDb } from '../db/index.js';
import { decrypt, encrypt } from '../lib/crypto.js';
import {
  clineAuthHeaderValue,
  isCredentialExpiring,
  parseStoredClineCredentials,
  refreshClineTokenRequest,
  type ClineStoredCredentials,
} from '../lib/cline-oauth.js';

/**
 * Access-token lifecycle for Cline OAuth keys.
 *
 * The api_keys row stores the full credential JSON (encrypted at rest like any
 * other key). Access tokens are short-lived WorkOS JWTs, so before each
 * upstream call we may need to rotate them with the refresh token — and when
 * Cline rotates the refresh token too, the NEW credential blob is written back
 * to the same row, or the next request would revive a dead token.
 *
 * The row is located by decrypting the (tiny) set of platform='cline' rows and
 * matching on the refresh token we hold. A module-level cache keyed by refresh
 * token keeps the common path synchronous for the provider adapter's
 * authHeader() and avoids a refresh stampede when several models fire at once.
 */

const refreshedTokens = new Map<string, ClineStoredCredentials>();
const refreshInFlight = new Map<string, Promise<ClineStoredCredentials>>();

function cacheKeyFor(creds: ClineStoredCredentials): string {
  return creds.refreshToken ?? creds.accessToken;
}

export function cachedAccessToken(keyValue: string): string | null {
  const creds = parseStoredClineCredentials(keyValue);
  if (!creds) return null;
  const refreshed = refreshedTokens.get(cacheKeyFor(creds));
  return (refreshed ?? creds).accessToken;
}

async function persistRefreshedCredentials(
  previousRefreshToken: string,
  next: ClineStoredCredentials,
): Promise<void> {
  try {
    const db = getDb();
    const rows = db.prepare(
      "SELECT id, encrypted_key, iv, auth_tag FROM api_keys WHERE platform = 'cline'",
    ).all() as { id: number; encrypted_key: string; iv: string; auth_tag: string }[];
    for (const row of rows) {
      let keyValue: string;
      try {
        keyValue = decrypt(row.encrypted_key, row.iv, row.auth_tag);
      } catch {
        continue; // not decryptable in this install (e.g. rotated master key)
      }
      const creds = parseStoredClineCredentials(keyValue);
      if (!creds || creds.refreshToken !== previousRefreshToken) continue;
      const { encrypted, iv, authTag } = encrypt(JSON.stringify(next));
      db.prepare(
        'UPDATE api_keys SET encrypted_key = ?, iv = ?, auth_tag = ? WHERE id = ?',
      ).run(encrypted, iv, authTag, row.id);
      return;
    }
  } catch (err) {
    // Persistence is best-effort: the in-memory cache already holds the fresh
    // token, so routing keeps working this process lifetime.
    console.warn(`[cline] could not persist refreshed token: ${(err as Error)?.message}`);
  }
}

/** Return current credentials for a stored key value, refreshing (and
 *  re-persisting) when the access token is expired or about to expire. */
export async function ensureFreshClineCredentials(keyValue: string): Promise<ClineStoredCredentials> {
  const creds = parseStoredClineCredentials(keyValue);
  if (!creds) throw new Error('Cline key is not an OAuth credential blob');
  if (!creds.refreshToken) return creds; // raw token pasted by hand — ride until 401
  if (!isCredentialExpiring(creds)) {
    return refreshedTokens.get(cacheKeyFor(creds)) ?? creds;
  }

  const cacheKey = cacheKeyFor(creds);
  const inFlight = refreshInFlight.get(cacheKey);
  if (inFlight) return inFlight;

  const task = (async () => {
    try {
      const next = await refreshClineTokenRequest(creds.refreshToken!);
      const merged: ClineStoredCredentials = {
        accessToken: next.accessToken,
        // Cline may or may not rotate the refresh token; keep the old one when
        // the response omits it.
        refreshToken: next.refreshToken ?? creds.refreshToken,
        expiresAt: next.expiresAt,
        email: next.email ?? creds.email,
      };
      refreshedTokens.set(cacheKey, merged);
      if (merged.refreshToken && merged.refreshToken !== cacheKey) {
        refreshedTokens.set(merged.refreshToken, merged);
      }
      await persistRefreshedCredentials(creds.refreshToken!, merged);
      return merged;
    } finally {
      refreshInFlight.delete(cacheKey);
    }
  })();
  refreshInFlight.set(cacheKey, task);
  return task;
}

/** Header value for an upstream call — synchronous fast path via the cache. */
export function clineBearerHeader(keyValue: string): Record<string, string> {
  const token = cachedAccessToken(keyValue);
  if (!token) return {};
  return { Authorization: clineAuthHeaderValue(token) };
}

/** Pre-flight used by the provider adapter before delegating to the shared
 *  OpenAI-compatible request builders (which read authHeader() synchronously). */
export async function warmClineToken(keyValue: string): Promise<void> {
  try {
    await ensureFreshClineCredentials(keyValue);
  } catch (err) {
    console.warn(`[cline] token refresh failed: ${(err as Error)?.message}`);
  }
}
