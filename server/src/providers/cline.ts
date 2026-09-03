import type { ChatMessage, ChatCompletionResponse, ChatCompletionChunk, Platform } from '@freellmapi/shared/types.js';
import type { QuotaObservationContext } from '../services/provider-quota.js';
import { OpenAICompatProvider } from './openai-compat.js';
import type { KeyValidationResult } from './base.js';
import { parseStoredClineCredentials } from '../lib/cline-oauth.js';
import {
  clineBearerHeader,
  warmClineToken,
} from '../services/cline-auth.js';

/**
 * Cline (usage-billing) — api.cline.bot/api/v1.
 *
 * OpenAI-compatible gateway, but the credential is an OAuth token pair, not an
 * API key: the stored key value is `{accessToken, refreshToken, expiresAt}`
 * JSON (see lib/cline-oauth.ts for the protocol). Short-lived access tokens
 * are kept fresh by services/cline-auth.ts, which also re-persists the row
 * when Cline rotates the refresh token.
 *
 * validateKey intentionally does NOT use the parent's /models probe: the
 * gateway answers GET /models 200 for ANY (even garbage) token because the
 * catalog is public — only /users/me actually authenticates.
 *
 * Free-promo models (z-ai/glm-5.3-flash, deepseek/deepseek-v4-flash,
 * cline-free/*, *:free) bill $0 against a per-account quota; paid models draw
 * on the account's usage-billing credits. Quota exhaustion arrives as 402/429
 * with the same shapes the shared classifier already understands.
 */
export class ClineProvider extends OpenAICompatProvider {
  constructor() {
    super({
      platform: 'cline',
      name: 'Cline',
      baseUrl: 'https://api.cline.bot/api/v1',
      // Reasoning models on the gateway (DeepSeek/GLM) can prefill long
      // reasoning phases before the first SSE byte; 90s TTFB budget like the
      // other aggregator adapters.
      timeoutMs: 90_000,
      extraHeaders: {
        'X-Title': 'FreeLLMAPI',
      },
    });
  }

  /** Inject the live access token. chatCompletion/streamChatCompletion warm
   *  the token cache first, so this stays synchronous. */
  protected override authHeader(apiKey: string): Record<string, string> {
    const header = clineBearerHeader(apiKey);
    if (header.Authorization) return header;
    // Fallback for a raw/pasted token with no cached refresh state: send the
    // value itself (works for bare JWTs; wrong for JSON blobs, but those are
    // warmed above before any request leaves).
    return { Authorization: `Bearer ${apiKey.replace(/^workos:/, '')}` };
  }

  override async chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: Parameters<OpenAICompatProvider['chatCompletion']>[3],
    quotaContext?: QuotaObservationContext,
  ): Promise<ChatCompletionResponse> {
    await warmClineToken(apiKey);
    return super.chatCompletion(apiKey, messages, modelId, options, quotaContext);
  }

  override async *streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: Parameters<OpenAICompatProvider['streamChatCompletion']>[3],
    quotaContext?: QuotaObservationContext,
  ): AsyncGenerator<ChatCompletionChunk> {
    await warmClineToken(apiKey);
    yield* super.streamChatCompletion(apiKey, messages, modelId, options, quotaContext);
  }

  override async validateKey(apiKey: string, quotaContext?: QuotaObservationContext): Promise<KeyValidationResult> {
    const creds = parseStoredClineCredentials(apiKey);
    if (!creds) {
      return { valid: false, error: 'Not a Cline OAuth credential (reconnect the account)' };
    }
    await warmClineToken(apiKey);
    const res = await this.fetchCatalogEndpoint(
      'https://api.cline.bot/api/v1/users/me',
      apiKey,
      quotaContext,
    );
    if (res.status === 401 || res.status === 403) {
      return this.validationResult(res);
    }
    if (!res.ok) {
      return { valid: false, error: `Cline key validation failed (HTTP ${res.status})` };
    }
    return true;
  }
}
