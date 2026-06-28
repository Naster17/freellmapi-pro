import type {
  ChatMessage,
  ChatContent,
  ChatCompletionResponse,
  ChatCompletionChunk,
  Platform,
} from '@freellmapi/shared/types.js';
import { BaseProvider, providerHttpError, type CompletionOptions } from './base.js';
import { recordQuotaObservationsFromResponse, type QuotaObservationContext } from '../services/provider-quota.js';

const ANON_KEY = '0000000000';
const MIN_MAX_TOKENS = 16;
const DEFAULT_MAX_TOKENS = 512;
const HORDE_TIMEOUT_MS = 120000;

function estimateTokens(content: ChatContent | undefined): number {
  if (content == null) return 0;
  let text: string;
  if (typeof content === 'string') {
    text = content;
  } else {
    text = content
      .map(block => (typeof block === 'string' ? block : (block?.text ?? '')))
      .join(' ');
  }
  return Math.ceil(text.length / 4);
}

export class AIHordeProvider extends BaseProvider {
  readonly platform: Platform = 'aihorde';
  readonly name = 'AI Horde';
  keyless = true;
  private readonly baseUrl = 'https://oai.aihorde.net/v1';

  private resolveBearer(apiKey: string): string {
    const k = apiKey?.trim();
    if (!k || k === 'no-key' || k === ANON_KEY) return ANON_KEY;
    return k;
  }

  private buildBody(messages: ChatMessage[], modelId: string, options?: CompletionOptions): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: modelId,
      messages,
      max_tokens: Math.max(MIN_MAX_TOKENS, options?.max_tokens ?? DEFAULT_MAX_TOKENS),
    };
    if (options?.temperature != null) body.temperature = options.temperature;
    if (options?.top_p != null) body.top_p = options.top_p;
    if (options?.stop != null) {
      body.stop = Array.isArray(options.stop) ? options.stop : [options.stop];
    }
    return body;
  }

  private synthesizeUsage(messages: ChatMessage[], data: ChatCompletionResponse): void {
    const prompt = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
    const completion = (data.choices ?? []).reduce(
      (sum, c) => sum + estimateTokens(c.message?.content),
      0,
    );
    data.usage = {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: prompt + completion,
    };
  }

  private parseError(err: unknown, status: number, statusText: string): string {
    const detail = (err as { detail?: unknown })?.detail;
    if (typeof detail === 'string' && detail.length > 0) return detail;
    const msg = (err as { error?: { message?: unknown } })?.error?.message;
    if (typeof msg === 'string' && msg.length > 0) return msg;
    return statusText || `HTTP ${status}`;
  }

  async chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
    quotaContext?: QuotaObservationContext,
  ): Promise<ChatCompletionResponse> {
    const res = await this.fetchWithTimeout(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.resolveBearer(apiKey)}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(this.buildBody(messages, modelId, options)),
    }, options?.timeoutMs ?? HORDE_TIMEOUT_MS);

    recordQuotaObservationsFromResponse(res, {
      platform: this.platform,
      keyId: quotaContext?.keyId,
      providerAccountId: quotaContext?.providerAccountId,
      modelId,
      quotaPoolKey: quotaContext?.quotaPoolKey,
      endpoint: 'chat/completions',
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw providerHttpError(res, `${this.name} API error ${res.status}: ${this.parseError(err, res.status, res.statusText)}`);
    }

    const data = await res.json() as ChatCompletionResponse;
    this.synthesizeUsage(messages, data);
    data._routed_via = { platform: this.platform, model: modelId };
    return data;
  }

  async *streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
    quotaContext?: QuotaObservationContext,
  ): AsyncGenerator<ChatCompletionChunk> {
    const data = await this.chatCompletion(apiKey, messages, modelId, options, quotaContext);
    const choice = data.choices?.[0];
    const content = typeof choice?.message?.content === 'string' ? choice.message.content : '';
    const base = {
      id: data.id ?? this.makeId(),
      object: 'chat.completion.chunk' as const,
      created: data.created ?? Math.floor(Date.now() / 1000),
      model: modelId,
    };
    yield { ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] };
    if (content) {
      yield { ...base, choices: [{ index: 0, delta: { content }, finish_reason: null }] };
    }
    yield { ...base, choices: [{ index: 0, delta: {}, finish_reason: choice?.finish_reason ?? 'stop' }] };
  }

  async validateKey(apiKey: string, quotaContext?: QuotaObservationContext): Promise<boolean> {
    const res = await this.fetchWithTimeout(`${this.baseUrl}/models`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${this.resolveBearer(apiKey)}` },
    }, 30000);
    recordQuotaObservationsFromResponse(res, {
      platform: this.platform,
      keyId: quotaContext?.keyId,
      providerAccountId: quotaContext?.providerAccountId,
      quotaPoolKey: quotaContext?.quotaPoolKey,
      endpoint: 'models',
    });
    return res.status !== 401 && res.status !== 403;
  }
}
