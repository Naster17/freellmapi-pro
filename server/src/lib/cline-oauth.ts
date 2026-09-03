import { proxyFetch } from './proxy.js';

/**
 * Cline (usage-billing) OAuth — api.cline.bot account tokens.
 *
 * Flow (reverse-engineered from the official Cline SDK,
 * sdk/packages/core/src/auth/cline.ts in cline/cline):
 *
 *  1. Browser opens  GET {API}/api/v1/auth/authorize
 *       ?client_type=extension&callback_url=<cb>&redirect_uri=<cb>
 *     which 302s to WorkOS AuthKit; after sign-in Cline's
 *     /api/v1/auth/callback bounces back to <cb> with ?code=<auth code>.
 *  2. The code is exchanged at POST {API}/api/v1/auth/token with
 *     { grant_type: 'authorization_code', code, client_type: 'extension',
 *       redirect_uri }  →  { success, data: { accessToken, refreshToken,
 *       tokenType, expiresAt, userInfo } }.
 *  3. Access tokens are short-lived; refresh via POST {API}/api/v1/auth/refresh
 *     with { refreshToken, grantType: 'refresh_token' }.
 *  4. Inference calls the OpenAI-compatible /api/v1/chat/completions with
 *     `Authorization: Bearer workos:<accessToken>` (the gateway rejects
 *     missing/invalid tokens with 401 BEFORE resolving the model, so even the
 *     free-promo models require an account).
 */

export const CLINE_API_BASE_URL = 'https://api.cline.bot';

const AUTHORIZE_PATH = '/api/v1/auth/authorize';
const TOKEN_PATH = '/api/v1/auth/token';
const REFRESH_PATH = '/api/v1/auth/refresh';

/** Bearer prefix the Cline gateway expects in front of the WorkOS JWT. */
export const WORKOS_TOKEN_PREFIX = 'workos:';

/** Refresh when the access token is within 5 minutes of expiring. */
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

export interface ClineTokenResponseData {
  accessToken: string;
  refreshToken?: string;
  tokenType?: string;
  expiresAt?: string;
  userInfo?: {
    subject?: string | null;
    email?: string;
    name?: string;
    clineUserId?: string | null;
    accounts?: string[] | null;
  };
}

/** Credentials stored (encrypted) as the api_keys key value for the platform. */
export interface ClineStoredCredentials {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms. Optional — treated as "unknown, ride until 401" when absent. */
  expiresAt?: number;
  email?: string;
}

export function buildAuthorizeUrl(callbackUrl: string): string {
  const url = new URL(CLINE_API_BASE_URL + AUTHORIZE_PATH);
  url.searchParams.set('client_type', 'extension');
  url.searchParams.set('callback_url', callbackUrl);
  url.searchParams.set('redirect_uri', callbackUrl);
  return url.toString();
}

/** Extract an authorization code from a pasted redirect URL or bare code. */
export function parseAuthorizationInput(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) return trimmed;
  try {
    const url = new URL(trimmed);
    return url.searchParams.get('code');
  } catch {
    return null;
  }
}

function extractTokenPayload(body: unknown): ClineTokenResponseData {
  const payload = body as { success?: boolean; data?: ClineTokenResponseData; error?: unknown };
  if (payload?.success && payload.data?.accessToken) return payload.data;
  const message = typeof payload?.error === 'string' ? payload.error : 'Invalid token response';
  throw new Error(`Cline token exchange failed: ${message}`);
}

async function readError(body: unknown, status: number): Promise<string> {
  const payload = body as { error?: unknown };
  const message = typeof payload?.error === 'string' ? payload.error : '';
  return `${status}${message ? ` - ${message}` : ''}`;
}

function credentialsFromResponse(data: ClineTokenResponseData): ClineStoredCredentials {
  return {
    accessToken: data.accessToken,
    refreshToken: data.refreshToken,
    expiresAt: data.expiresAt ? Date.parse(data.expiresAt) : undefined,
    email: data.userInfo?.email || undefined,
  };
}

/** Exchange an authorization code for account tokens (step 2 of the flow). */
export async function exchangeClineCode(code: string, redirectUri: string): Promise<ClineStoredCredentials> {
  const res = await proxyFetch(
    CLINE_API_BASE_URL + TOKEN_PATH,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code,
        client_type: 'extension',
        redirect_uri: redirectUri,
      }),
    },
    'cline',
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(await readError(body, res.status));
  return credentialsFromResponse(extractTokenPayload(body));
}

/** Refresh an access token. An invalid_grant failure means the stored key was
 *  revoked/expired — the key must be re-authenticated, not retried. */
export async function refreshClineTokenRequest(refreshToken: string): Promise<ClineStoredCredentials> {
  const res = await proxyFetch(
    CLINE_API_BASE_URL + REFRESH_PATH,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken, grantType: 'refresh_token' }),
    },
    'cline',
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(await readError(body, res.status));
  return credentialsFromResponse(extractTokenPayload(body));
}

/** Parse the stored key value. Legacy/raw tokens (a bare or `workos:`-prefixed
 *  JWT) are accepted so a manually pasted access token still works. */
export function parseStoredClineCredentials(keyValue: string): ClineStoredCredentials | null {
  const trimmed = keyValue.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as ClineStoredCredentials;
      if (parsed.accessToken) {
        return { ...parsed, accessToken: parsed.accessToken.replace(/^workos:/, '') };
      }
      return null;
    } catch {
      return null;
    }
  }
  return { accessToken: trimmed.replace(/^workos:/, '') };
}

/** The Authorization header value for stored credentials' access token. */
export function clineAuthHeaderValue(accessToken: string): string {
  const bare = accessToken.replace(/^workos:/, '');
  return `Bearer ${WORKOS_TOKEN_PREFIX}${bare}`;
}

export function isCredentialExpiring(creds: ClineStoredCredentials, now = Date.now()): boolean {
  if (!creds.expiresAt) return false;
  return now + REFRESH_BUFFER_MS >= creds.expiresAt;
}
