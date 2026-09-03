import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
} from '@freellmapi/shared/types.js';
import { OpenAICompatProvider } from './openai-compat.js';
import { providerHttpError, type CompletionOptions } from './base.js';
import { normalizeUsage } from '../lib/usage-normalize.js';
import { isAbortLikeError } from '../lib/error-classify.js';
import { recordQuotaObservationsFromResponse, type QuotaObservationContext } from '../services/provider-quota.js';
import { streamStallTimeoutMs } from '../lib/provider-timeout.js';
import {
  buildResponsesBody,
  finalizeResponsesStream,
  isMuseResponsesModel,
  newResponsesStreamState,
  pushResponsesEvent,
  responsesErrorText,
  toChatCompletion,
} from './zen-responses.js';
import {
  acquireZenIpLease,
  currentZenIp,
  isZenKeylessMode,
  markZenIpExhausted,
  randomPublicIp,
  rotateZenIp,
  zenIpStorage,
  ZEN_NO_KEY,
} from '../services/zen-keyless.js';
import type { KeyValidationResult } from './base.js';

const ROTATE_ON_STATUSES = new Set([401, 402, 403, 429]);

export class ZenProvider extends OpenAICompatProvider {
  constructor() {
    super({
      platform: 'opencode',
      name: 'OpenCode Zen',
      baseUrl: 'https://opencode.ai/zen/v1',
    });
  }

  protected override authHeader(apiKey: string): Record<string, string> {
    if (isZenKeylessMode()) return {};
    return { 'Authorization': `Bearer ${apiKey}` };
  }

  protected override dynamicHeaders(_apiKey: string): Record<string, string> {
    // zen meters its free tier on CLIENT IDENTITY: requests whose User-Agent
    // identifies as the opencode client draw from the tier the opencode CLI
    // itself uses (verified live: any opencode-prefixed UA + a real zen key
    // returns 200 for deepseek-v4-flash-free, while the relay's default UA
    // lands in the fast-draining per-IP anonymous bucket and 429s with
    // FreeUsageLimitError). Without this every zen free request from the
    // relay exhausts the shared IP budget within hours.
    //
    // A spoofed X-Real-IP rides along on every request (keyed and keyless):
    // zen ignores it for the rate budget — the edge keys on the socket IP —
    // but it costs nothing and keeps the anonymous tier from ever correlating
    // requests to the relay's real address. Keyless mode uses the lease-
    // managed rotating IP; keyed mode mints a fresh random public one.
    const ip = isZenKeylessMode() ? currentZenIp() : randomPublicIp();
    return {
      'user-agent': 'opencode/1.18.15 freellmapi',
      'X-Real-IP': ip ?? randomPublicIp(),
    };
  }

  protected override onUpstreamError(status: number): void {
    if (!isZenKeylessMode()) return;
    if (status >= 500 || ROTATE_ON_STATUSES.has(status)) {
      const lease = zenIpStorage.getStore();
      if (lease !== undefined) {
        lease.dispose();
      } else {
        markZenIpExhausted();
        rotateZenIp();
      }
    }
  }

  protected override upstreamErrorContext(status: number, body: unknown): Record<string, unknown> | undefined {
    // FreeUsageLimitError is the anonymous tier's per-IP DAILY budget being
    // spent (ipRateLimiter.ts on the upstream) — it resets at UTC midnight, so
    // the failover loop benches the anon pool until then instead of re-dispatch-
    // ing the same exhausted key. Any other 429 is transient and gets the short
    // cooldown.
    if (status === 429) {
      const type = (body as { error?: { type?: unknown } })?.error?.type;
      if (type === 'FreeUsageLimitError') return { zenFreeUsageLimit: true };
    }
    return undefined;
  }

  override async chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
    quotaContext?: QuotaObservationContext,
  ): Promise<ChatCompletionResponse> {
    if (isMuseResponsesModel(modelId)) {
      if (!isZenKeylessMode()) {
        return this.museResponsesChat(apiKey, messages, modelId, options, quotaContext);
      }
      const lease = acquireZenIpLease();
      if (lease === null) {
        return this.museResponsesChat(apiKey, messages, modelId, options, quotaContext);
      }
      try {
        return await zenIpStorage.run(lease, () =>
          this.museResponsesChat(apiKey, messages, modelId, options, quotaContext),
        );
      } finally {
        lease.release();
      }
    }
    if (!isZenKeylessMode()) {
      return super.chatCompletion(apiKey, messages, modelId, options, quotaContext);
    }
    const lease = acquireZenIpLease();
    if (lease === null) {
      return super.chatCompletion(apiKey, messages, modelId, options, quotaContext);
    }
    try {
      return await zenIpStorage.run(lease, () =>
        super.chatCompletion(apiKey, messages, modelId, options, quotaContext),
      );
    } finally {
      lease.release();
    }
  }

  override async *streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
    quotaContext?: QuotaObservationContext,
  ): AsyncGenerator<ChatCompletionChunk> {
    if (isMuseResponsesModel(modelId)) {
      if (!isZenKeylessMode()) {
        yield* this.museResponsesStream(apiKey, messages, modelId, options, quotaContext);
        return;
      }
      const lease = acquireZenIpLease();
      if (lease === null) {
        yield* this.museResponsesStream(apiKey, messages, modelId, options, quotaContext);
        return;
      }
      try {
        yield* zenIpStorage.run(lease, () =>
          this.museResponsesStream(apiKey, messages, modelId, options, quotaContext),
        );
      } finally {
        lease.release();
      }
      return;
    }
    if (!isZenKeylessMode()) {
      yield* super.streamChatCompletion(apiKey, messages, modelId, options, quotaContext);
      return;
    }
    const lease = acquireZenIpLease();
    if (lease === null) {
      yield* super.streamChatCompletion(apiKey, messages, modelId, options, quotaContext);
      return;
    }
    try {
      yield* zenIpStorage.run(lease, () =>
        super.streamChatCompletion(apiKey, messages, modelId, options, quotaContext),
      );
    } finally {
      lease.release();
    }
  }

  private responsesHeaders(apiKey: string): Record<string, string> {
    return {
      ...this.authHeader(apiKey),
      ...this.dynamicHeaders(apiKey),
      'Content-Type': 'application/json',
    };
  }

  private async museResponsesChat(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
    quotaContext?: QuotaObservationContext,
  ): Promise<ChatCompletionResponse> {
    const res = await this.fetchWithTimeout(this.upstreamUrl('/responses'), {
      method: 'POST',
      headers: this.responsesHeaders(apiKey),
      body: JSON.stringify(buildResponsesBody(modelId, messages, options, false)),
    }, options?.timeoutMs ?? this.upstreamTimeoutMs(), { signal: options?.signal, timeoutBounds: 'request' });

    recordQuotaObservationsFromResponse(res, {
      platform: this.platform,
      keyId: quotaContext?.keyId,
      providerAccountId: quotaContext?.providerAccountId,
      modelId,
      quotaPoolKey: quotaContext?.quotaPoolKey,
      endpoint: 'responses',
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      this.onUpstreamError(res.status);
      const httpError = providerHttpError(res, `${this.name} API error ${res.status}: ${responsesErrorText(err, res.statusText)}`);
      const ctx = this.upstreamErrorContext(res.status, err);
      if (ctx) httpError.upstreamCtx = ctx;
      throw httpError;
    }

    let data: unknown;
    try {
      data = await res.json();
    } catch (err) {
      if (isAbortLikeError(err)) throw err;
      throw new Error(`${this.name} returned 200 with a non-JSON body on the Responses endpoint.`);
    }
    const out = toChatCompletion(modelId, data as Parameters<typeof toChatCompletion>[1]);
    if (out.usage) normalizeUsage(out.usage);
    out._routed_via = { platform: this.platform, model: modelId };
    return out;
  }

  private async *museResponsesStream(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
    quotaContext?: QuotaObservationContext,
  ): AsyncGenerator<ChatCompletionChunk> {
    const res = await this.fetchWithTimeout(this.upstreamUrl('/responses'), {
      method: 'POST',
      headers: this.responsesHeaders(apiKey),
      body: JSON.stringify(buildResponsesBody(modelId, messages, options, true)),
    }, options?.timeoutMs ?? this.upstreamTimeoutMs(), { signal: options?.signal });

    recordQuotaObservationsFromResponse(res, {
      platform: this.platform,
      keyId: quotaContext?.keyId,
      providerAccountId: quotaContext?.providerAccountId,
      modelId,
      quotaPoolKey: quotaContext?.quotaPoolKey,
      endpoint: 'responses',
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      this.onUpstreamError(res.status);
      const httpError = providerHttpError(res, `${this.name} API error ${res.status}: ${responsesErrorText(err, res.statusText)}`);
      const ctx = this.upstreamErrorContext(res.status, err);
      if (ctx) httpError.upstreamCtx = ctx;
      throw httpError;
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');

    const inactivityTimeoutMs = streamStallTimeoutMs(this.platform);
    const firstByteMs = this.firstByteBudgetMs(options?.timeoutMs ?? this.upstreamTimeoutMs(), inactivityTimeoutMs);
    let awaitingFirstByte = true;
    const decoder = new TextDecoder();
    const state = newResponsesStreamState(modelId);
    let buffer = '';

    try {
      while (true) {
        const { done, value } = awaitingFirstByte
          ? await this.readWithStallTimeout(() => reader.read(), firstByteMs, this.firstByteTimeoutMessage(firstByteMs))
          : await this.readWithStallTimeout(() => reader.read(), inactivityTimeoutMs);
        awaitingFirstByte = false;
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;
          const raw = trimmed.slice(6);
          if (raw === '[DONE]') {
            yield* finalizeResponsesStream(state);
            return;
          }
          let event: unknown;
          try {
            event = JSON.parse(raw);
          } catch {
            continue;
          }
          yield* pushResponsesEvent(state, event);
        }
      }
    } finally {
      reader.releaseLock();
    }
    yield* finalizeResponsesStream(state);
  }

  override async validateKey(apiKey: string): Promise<KeyValidationResult> {
    if (isZenKeylessMode() || apiKey === ZEN_NO_KEY) return true;
    return super.validateKey(apiKey);
  }
}
