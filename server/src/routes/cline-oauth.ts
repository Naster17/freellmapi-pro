import { Router } from 'express';
import type { Request, Response } from 'express';
import { randomBytes } from 'crypto';
import { z } from 'zod';
import { getDb } from '../db/index.js';
import { encrypt, maskKey } from '../lib/crypto.js';
import {
  buildAuthorizeUrl,
  exchangeClineCode,
  parseAuthorizationInput,
} from '../lib/cline-oauth.js';

export const clineOAuthRouter = Router();

/**
 * Cline OAuth handshake for the dashboard's Keys page.
 *
 * The Cline gateway has no static API keys — the credential is an account
 * OAuth token pair, so the "add key" flow runs a browser authorize:
 *
 *   1. POST /start  { redirectUri }        → { authUrl, state }
 *      redirectUri is the DASHBOARD's own /keys/cline/callback page (the
 *      client passes window.location.origin). Cline bounces back there with
 *      ?code=…&state=… after WorkOS sign-in, which also works through the
 *      Docker port mapping (no extra published port needed).
 *   2. The callback page POSTs { code, state } to /complete.
 *      Manual fallback: the user pastes the redirect URL (or bare code); the
 *      redirectUri then defaults to the SDK convention
 *      http://localhost:48801/auth, which only matters for the exchange
 *      round-trip, not for receiving it.
 *   3. /complete exchanges the code and inserts the api_keys row; the stored
 *      key value is the credential JSON handled by services/cline-auth.ts.
 */

const STATE_TTL_MS = 10 * 60 * 1000;
const MANUAL_REDIRECT_URI = 'http://localhost:48801/auth';

const pendingStates = new Map<string, { redirectUri: string; createdAt: number }>();

function pruneExpiredStates() {
  const now = Date.now();
  for (const [state, entry] of pendingStates) {
    if (now - entry.createdAt > STATE_TTL_MS) pendingStates.delete(state);
  }
}

const startSchema = z.object({
  // The dashboard origin the browser will come back to. Same-origin only in
  // spirit — we accept any http(s) URL the operator's dashboard can serve,
  // which is exactly what makes the flow work behind the Docker port map.
  redirectUri: z.string().url().refine(u => /^https?:\/\//i.test(u), {
    message: 'redirectUri must be an http(s) URL',
  }),
});

clineOAuthRouter.post('/start', (req: Request, res: Response) => {
  const parsed = startSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: parsed.error.issues[0]?.message ?? 'Invalid request' } });
    return;
  }
  pruneExpiredStates();
  const state = randomBytes(16).toString('hex');
  const redirectUri = `${parsed.data.redirectUri.replace(/\/+$/, '')}/keys/cline/callback`;
  pendingStates.set(state, { redirectUri, createdAt: Date.now() });
  res.json({ authUrl: buildAuthorizeUrl(redirectUri), state });
});

const completeSchema = z.object({
  // Either the bare code or the full redirect URL the browser landed on.
  code: z.string().optional(),
  url: z.string().optional(),
  state: z.string().optional(),
  // Only used for the manual paste path (no pending state matched).
  redirectUri: z.string().optional(),
});

clineOAuthRouter.post('/complete', async (req: Request, res: Response) => {
  const parsed = completeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Provide code or url' } });
    return;
  }
  pruneExpiredStates();

  const code = parseAuthorizationInput(parsed.data.code ?? parsed.data.url ?? '');
  if (!code) {
    res.status(400).json({ error: { message: 'No authorization code found in the input' } });
    return;
  }

  let redirectUri = MANUAL_REDIRECT_URI;
  let consumedState = false;
  if (parsed.data.state && pendingStates.has(parsed.data.state)) {
    redirectUri = pendingStates.get(parsed.data.state)!.redirectUri;
    pendingStates.delete(parsed.data.state);
    consumedState = true;
  } else if (parsed.data.redirectUri) {
    redirectUri = parsed.data.redirectUri;
  }

  try {
    const credentials = await exchangeClineCode(code, redirectUri);
    // Single-use codes: a matched-but-unconsumed state would allow a replay
    // through the manual path.
    if (consumedState) pendingStates.delete(parsed.data.state!);

    const keyToStore = JSON.stringify({
      accessToken: credentials.accessToken,
      refreshToken: credentials.refreshToken,
      expiresAt: credentials.expiresAt,
      email: credentials.email,
    });
    const label = credentials.email ? `Cline (${credentials.email})` : 'Cline (OAuth)';

    const db = getDb();
    const { encrypted, iv, authTag } = encrypt(keyToStore);
    const result = db.prepare(`
      INSERT INTO api_keys (platform, label, encrypted_key, iv, auth_tag, status, enabled)
      VALUES ('cline', ?, ?, ?, ?, 'unknown', 1)
    `).run(label, encrypted, iv, authTag);

    const modelsAvailable = (db.prepare(
      "SELECT COUNT(*) AS c FROM models WHERE platform = 'cline' AND enabled = 1",
    ).get() as { c: number }).c;

    res.status(201).json({
      id: result.lastInsertRowid,
      platform: 'cline',
      label,
      maskedKey: maskKey(credentials.accessToken),
      email: credentials.email ?? null,
      status: 'unknown',
      enabled: true,
      modelsAvailable,
    });
  } catch (err) {
    const message = (err as Error)?.message ?? 'Token exchange failed';
    res.status(400).json({ error: { message: `Cline authorization failed: ${message}` } });
  }
});
