import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
  Platform,
} from '@freellmapi/shared/types.js';
import { BaseProvider, providerHttpError, type CompletionOptions } from './base.js';
import { normalizeUsage } from '../lib/usage-normalize.js';
import { recordQuotaObservationsFromResponse, type QuotaObservationContext } from '../services/provider-quota.js';

// g4f.space exposes ~220 models behind a thin OpenAI-compatible gateway. The
// upstream model id is `<server_shard>:<model_name>` (e.g. `srv_mp2i8r...:
// deepseek-v4-pro`) — the gateway uses the shard to pick an upstream and the
// rest of the string to identify the model. Catalog rows store only the clean
// model name; this map translates it to the full upstream id and exists to
// avoid leaking the rotating server prefixes to clients. The catalog sync will
// overwrite this in future migrations as the gateway rotates shards.
const SERVER_PREFIXES: Record<string, string> = {
  'deepseek-v4-pro': 'srv_mp2i8rco3148dd85bec1',
  'glm-5.1': 'srv_mp2i8rco3148dd85bec1',
  'kimi-k2.7-code': 'srv_mp2i8rco3148dd85bec1',
  'kimi-k2.6': 'srv_mp2i8rco3148dd85bec1',
  'gpt-oss-120b': 'srv_mlj8gd8y789d112ec50d',
  'openai/gpt-5': 'srv_mqrlxup3fd91a47d98e6',
  'gpt-5.4': 'srv_mqrlxup3fd91a47d98e6',
  'gpt-5.5': 'srv_mp5miql908c8738d71be',
  'qwen3.7-max': 'srv_mpq6idkk49907f3c4a5b',
  'qwen3.6-plus': 'srv_mpq6idkk49907f3c4a5b',
  'qwen-coder': 'srv_mkoloq41e34074b6133e',
  'gpt-4o-mini': 'srv_mp3lmkuad07322459f47',
  'minimaxai/minimax-m3': 'srv_mkombumpae45db46dcb8',
  'zai-org/GLM-5.1': 'srv_mqcs3lw9218274130973',
  'gemini-3.1-flash-lite': 'srv_mkol5tgcd33cc358ddbc',
  'zai-org/GLM-5.2': 'srv_mqcs3lw9218274130973',
  'claude-opus-4-6-thinking': 'srv_mlv668eaa6d92f50ff10',
  'claude-sonnet-4-6': 'srv_mlv668eaa6d92f50ff10',
};

const DEFAULT_TIMEOUT_MS = 30000;

function resolveUpstreamModelId(modelId: string): string {
  const trimmed = modelId.trim();
  if (trimmed.includes(':')) return trimmed;
  const prefix = SERVER_PREFIXES[trimmed];
  if (!prefix) return trimmed;
  return `${prefix}:${trimmed}`;
}

function parseErrorBody(body: unknown): string {
  if (!body) return '';
  if (typeof body === 'string') return body;
  const obj = body as { error?: { message?: unknown; detail?: unknown } | string };
  if (typeof obj.error === 'string') return obj.error;
  if (obj.error && typeof obj.error === 'object') {
    const msg = (obj.error as { message?: unknown }).message;
    if (typeof msg === 'string' && msg.length > 0) return msg;
  }
  if (Array.isArray((obj as { detail?: unknown }).detail)) {
    const first = (obj as { detail: Array<{ msg?: unknown }> }).detail[0]?.msg;
    if (typeof first === 'string') return first;
  }
  return '';
}

export class G4FProvider extends BaseProvider {
  readonly platform: Platform = 'g4f';
  readonly name = 'g4f.space';
  private readonly baseUrl = 'https://g4f.space/v1';

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
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: resolveUpstreamModelId(modelId),
        messages,
        temperature: options?.temperature,
        max_tokens: options?.max_tokens,
        top_p: options?.top_p,
        stop: options?.stop,
        tools: options?.tools,
        tool_choice: options?.tool_choice,
        stream: false,
        stream_options: options?.stream_options,
      }),
    }, options?.timeoutMs ?? DEFAULT_TIMEOUT_MS);

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
      const message = parseErrorBody(err) || res.statusText;
      throw providerHttpError(res, `${this.name} API error ${res.status}: ${message}`);
    }

    let data: ChatCompletionResponse;
    try {
      data = await res.json() as ChatCompletionResponse;
    } catch {
      throw new Error(`${this.name} returned 200 with a non-JSON body — the endpoint is not OpenAI-compatible.`);
    }
    if (data.usage) normalizeUsage(data.usage);
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
    const res = await this.fetchWithTimeout(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: resolveUpstreamModelId(modelId),
        messages,
        temperature: options?.temperature,
        max_tokens: options?.max_tokens,
        top_p: options?.top_p,
        stop: options?.stop,
        tools: options?.tools,
        tool_choice: options?.tool_choice,
        stream: true,
        stream_options: options?.stream_options,
      }),
    }, options?.timeoutMs ?? DEFAULT_TIMEOUT_MS);

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
      const message = parseErrorBody(err) || res.statusText;
      throw providerHttpError(res, `${this.name} API error ${res.status}: ${message}`);
    }

    yield* this.readSseStream(res);
  }

  async validateKey(apiKey: string, quotaContext?: QuotaObservationContext): Promise<boolean> {
    const res = await this.fetchWithTimeout(`${this.baseUrl}/models`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${apiKey}` },
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
