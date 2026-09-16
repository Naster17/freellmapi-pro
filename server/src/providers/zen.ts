import { randomBytes } from 'node:crypto';
import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
} from '@freellmapi/shared/types.js';
import { OpenAICompatProvider } from './openai-compat.js';
import { providerHttpError, type CompletionOptions, type ProviderHttpError } from './base.js';
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
  anthropicErrorText,
  finalizeZenMessagesStream,
  isOverloadedUpstreamError,
  isZenMessagesModel,
  newZenMessagesStreamState,
  pushZenMessagesEvent,
  toAnthropicMessagesBody,
  toChatCompletionFromAnthropic,
  toolSchemasFor,
} from './zen-messages.js';
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

export const ZEN_SPOOF_USER_AGENT_DEFAULT = 'opencode/1.18.25';
export const ZEN_SPOOF_CLIENT_DEFAULT = 'cli';

export function zenSpoofUserAgent(): string {
  return process.env.ZEN_USER_AGENT?.trim() || ZEN_SPOOF_USER_AGENT_DEFAULT;
}

export function zenSpoofClient(): string {
  return process.env.ZEN_CLIENT?.trim() || ZEN_SPOOF_CLIENT_DEFAULT;
}

export function zenSpoofProject(): string | undefined {
  return process.env.ZEN_PROJECT_ID?.trim() || undefined;
}

export function newZenSessionId(): string {
  return `ses_${randomBytes(16).toString('hex')}`;
}

export function newZenRequestId(): string {
  return `msg_${randomBytes(16).toString('hex')}`;
}

const ZEN_PACED_RETRY_DELAYS_MS = [2000, 5000];
const ZEN_PACED_RETRY_MAX_HINT_MS = 10000;
const ZEN_OVERLOADED_RETRY_DELAYS_MS = [3000, 8000, 15000];

export function isPacedRetryableZenError(err: unknown): boolean {
  const coded = err as ProviderHttpError;
  if (coded?.status !== 429) return false;
  if (coded.upstreamCtx?.['zenFreeUsageLimit'] === true) return false;
  const hinted = coded.retryAfterMs;
  return hinted === undefined || hinted <= ZEN_PACED_RETRY_MAX_HINT_MS;
}

export function isOverloadedRetryableZenError(err: unknown): boolean {
  const coded = err as ProviderHttpError;
  if (coded?.status !== 503) return false;
  return coded.upstreamCtx?.['zenOverloadedUpstream'] === true;
}

export function overloadedRetryDelayMs(attempt: number): number {
  return ZEN_OVERLOADED_RETRY_DELAYS_MS[Math.min(attempt, ZEN_OVERLOADED_RETRY_DELAYS_MS.length - 1)] ?? 15000;
}

export function pacedRetryDelayMs(err: unknown, attempt: number): number {
  const hinted = (err as ProviderHttpError)?.retryAfterMs;
  const fallback = ZEN_PACED_RETRY_DELAYS_MS[Math.min(attempt, ZEN_PACED_RETRY_DELAYS_MS.length - 1)] ?? 2000;
  return Math.min(hinted ?? fallback, ZEN_PACED_RETRY_MAX_HINT_MS);
}

export function sleepAbortable(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener('abort', done);
      resolve();
    }
    signal?.addEventListener('abort', done, { once: true });
  });
}

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
    const ip = isZenKeylessMode() ? currentZenIp() : randomPublicIp();
    const headers: Record<string, string> = {
      'user-agent': zenSpoofUserAgent(),
      'X-Real-IP': ip ?? randomPublicIp(),
      'x-opencode-session': newZenSessionId(),
      'x-opencode-request': newZenRequestId(),
      'x-opencode-client': zenSpoofClient(),
    };
    const project = zenSpoofProject();
    if (project !== undefined) headers['x-opencode-project'] = project;
    return headers;
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
    let pacedAttempt = 0;
    let overloadedAttempt = 0;
    for (;;) {
      try {
        return await this.dispatchChatCompletion(apiKey, messages, modelId, options, quotaContext);
      } catch (err) {
        if (isZenMessagesModel(modelId) && isOverloadedRetryableZenError(err) && overloadedAttempt < ZEN_OVERLOADED_RETRY_DELAYS_MS.length) {
          await sleepAbortable(overloadedRetryDelayMs(overloadedAttempt), options?.signal);
          overloadedAttempt++;
          continue;
        }
        if (pacedAttempt >= ZEN_PACED_RETRY_DELAYS_MS.length || !isPacedRetryableZenError(err)) throw err;
        await sleepAbortable(pacedRetryDelayMs(err, pacedAttempt), options?.signal);
        pacedAttempt++;
      }
    }
  }

  private async dispatchChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
    quotaContext?: QuotaObservationContext,
  ): Promise<ChatCompletionResponse> {
    if (isZenMessagesModel(modelId)) {
      if (!isZenKeylessMode()) {
        return this.zenMessagesChat(apiKey, messages, modelId, options, quotaContext);
      }
      const lease = acquireZenIpLease();
      if (lease === null) {
        return this.zenMessagesChat(apiKey, messages, modelId, options, quotaContext);
      }
      try {
        return await zenIpStorage.run(lease, () =>
          this.zenMessagesChat(apiKey, messages, modelId, options, quotaContext),
        );
      } finally {
        lease.release();
      }
    }
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
    let pacedAttempt = 0;
    let overloadedAttempt = 0;
    for (;;) {
      let yielded = false;
      try {
        for await (const chunk of this.dispatchStream(apiKey, messages, modelId, options, quotaContext)) {
          yielded = true;
          yield chunk;
        }
        return;
      } catch (err) {
        if (!yielded && isZenMessagesModel(modelId) && isOverloadedRetryableZenError(err) && overloadedAttempt < ZEN_OVERLOADED_RETRY_DELAYS_MS.length) {
          await sleepAbortable(overloadedRetryDelayMs(overloadedAttempt), options?.signal);
          overloadedAttempt++;
          continue;
        }
        if (yielded || pacedAttempt >= ZEN_PACED_RETRY_DELAYS_MS.length || !isPacedRetryableZenError(err)) throw err;
        await sleepAbortable(pacedRetryDelayMs(err, pacedAttempt), options?.signal);
        pacedAttempt++;
      }
    }
  }

  private async *dispatchStream(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
    quotaContext?: QuotaObservationContext,
  ): AsyncGenerator<ChatCompletionChunk> {
    if (isZenMessagesModel(modelId)) {
      if (!isZenKeylessMode()) {
        yield* this.zenMessagesStream(apiKey, messages, modelId, options, quotaContext);
        return;
      }
      const lease = acquireZenIpLease();
      if (lease === null) {
        yield* this.zenMessagesStream(apiKey, messages, modelId, options, quotaContext);
        return;
      }
      try {
        yield* zenIpStorage.run(lease, () =>
          this.zenMessagesStream(apiKey, messages, modelId, options, quotaContext),
        );
      } finally {
        lease.release();
      }
      return;
    }
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

  private messagesHeaders(apiKey: string): Record<string, string> {
    return {
      ...this.responsesHeaders(apiKey),
      'anthropic-version': '2023-06-01',
    };
  }

  private markOverloadedUpstream(status: number, body: unknown): Record<string, unknown> | undefined {
    if (isOverloadedUpstreamError(status, body)) return { zenOverloadedUpstream: true };
    return undefined;
  }

  private async zenMessagesChat(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
    quotaContext?: QuotaObservationContext,
  ): Promise<ChatCompletionResponse> {
    const res = await this.fetchWithTimeout(this.upstreamUrl('/messages'), {
      method: 'POST',
      headers: this.messagesHeaders(apiKey),
      body: JSON.stringify(toAnthropicMessagesBody(modelId, messages, {
        max_tokens: options?.max_tokens,
        temperature: options?.temperature,
        top_p: options?.top_p,
        top_k: options?.top_k,
        stop: options?.stop,
        tools: options?.tools,
        tool_choice: options?.tool_choice,
      }, false)),
    }, options?.timeoutMs ?? this.upstreamTimeoutMs(), { signal: options?.signal, timeoutBounds: 'request' });

    recordQuotaObservationsFromResponse(res, {
      platform: this.platform,
      keyId: quotaContext?.keyId,
      providerAccountId: quotaContext?.providerAccountId,
      modelId,
      quotaPoolKey: quotaContext?.quotaPoolKey,
      endpoint: 'messages',
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      this.onUpstreamError(res.status);
      const httpError = providerHttpError(res, `${this.name} API error ${res.status}: ${anthropicErrorText(err, res.statusText)}`);
      const ctx = this.markOverloadedUpstream(res.status, err) ?? this.upstreamErrorContext(res.status, err);
      if (ctx) httpError.upstreamCtx = ctx;
      throw httpError;
    }

    let data: unknown;
    try {
      data = await res.json();
    } catch (err) {
      if (isAbortLikeError(err)) throw err;
      throw new Error(`${this.name} returned 200 with a non-JSON body on the Messages endpoint.`);
    }
    const out = toChatCompletionFromAnthropic(modelId, data as Parameters<typeof toChatCompletionFromAnthropic>[1], toolSchemasFor(options));
    if (out.usage) normalizeUsage(out.usage);
    out._routed_via = { platform: this.platform, model: modelId };
    return out;
  }

  private async *zenMessagesStream(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
    quotaContext?: QuotaObservationContext,
  ): AsyncGenerator<ChatCompletionChunk> {
    const res = await this.fetchWithTimeout(this.upstreamUrl('/messages'), {
      method: 'POST',
      headers: this.messagesHeaders(apiKey),
      body: JSON.stringify(toAnthropicMessagesBody(modelId, messages, {
        max_tokens: options?.max_tokens,
        temperature: options?.temperature,
        top_p: options?.top_p,
        top_k: options?.top_k,
        stop: options?.stop,
        tools: options?.tools,
        tool_choice: options?.tool_choice,
      }, true)),
    }, options?.timeoutMs ?? this.upstreamTimeoutMs(), { signal: options?.signal });

    recordQuotaObservationsFromResponse(res, {
      platform: this.platform,
      keyId: quotaContext?.keyId,
      providerAccountId: quotaContext?.providerAccountId,
      modelId,
      quotaPoolKey: quotaContext?.quotaPoolKey,
      endpoint: 'messages',
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      this.onUpstreamError(res.status);
      const httpError = providerHttpError(res, `${this.name} API error ${res.status}: ${anthropicErrorText(err, res.statusText)}`);
      const ctx = this.markOverloadedUpstream(res.status, err) ?? this.upstreamErrorContext(res.status, err);
      if (ctx) httpError.upstreamCtx = ctx;
      throw httpError;
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');

    const inactivityTimeoutMs = streamStallTimeoutMs(this.platform);
    const firstByteMs = this.firstByteBudgetMs(options?.timeoutMs ?? this.upstreamTimeoutMs(), inactivityTimeoutMs);
    let awaitingFirstByte = true;
    const decoder = new TextDecoder();
    const state = newZenMessagesStreamState(modelId);
    const schemas = toolSchemasFor(options);
    let buffer = '';
    let pendingEvent: string | null = null;

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
          if (!trimmed) continue;
          if (trimmed.startsWith('event: ')) {
            pendingEvent = trimmed.slice(7).trim();
            continue;
          }
          if (!trimmed.startsWith('data: ')) continue;
          const raw = trimmed.slice(6);
          if (raw === '[DONE]') {
            yield* finalizeZenMessagesStream(state, schemas);
            return;
          }
          let payload: unknown;
          try {
            payload = JSON.parse(raw);
          } catch {
            pendingEvent = null;
            continue;
          }
          const type = pendingEvent ?? (payload as { type?: unknown }).type;
          pendingEvent = null;
          if (typeof type !== 'string') continue;
          yield* pushZenMessagesEvent(state, { type, data: payload });
        }
      }
    } finally {
      reader.releaseLock();
    }
    yield* finalizeZenMessagesStream(state, schemas);
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
