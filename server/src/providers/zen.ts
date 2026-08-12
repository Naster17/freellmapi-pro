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
    if (!isZenKeylessMode()) return {};
    const ip = currentZenIp();
    return ip === null ? {} : { 'X-Real-IP': ip };
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
