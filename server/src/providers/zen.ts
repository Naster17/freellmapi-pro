import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
} from '@freellmapi/shared/types.js';
import { OpenAICompatProvider } from './openai-compat.js';
import type { CompletionOptions } from './base.js';
import type { QuotaObservationContext } from '../services/provider-quota.js';
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

  override async validateKey(apiKey: string): Promise<KeyValidationResult> {
    if (isZenKeylessMode() || apiKey === ZEN_NO_KEY) return true;
    return super.validateKey(apiKey);
  }
}
