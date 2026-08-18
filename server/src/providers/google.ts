import type {
  ChatMessage,
  ChatCompletionResponse,
  ChatCompletionChunk,
  ChatToolCall,
  ChatToolChoice,
  ChatToolDefinition,
  TokenUsage,
} from '@freellmapi/shared/types.js';
import { BaseProvider, providerHttpError, type CompletionOptions, type KeyValidationResult } from './base.js';
import { contentToString } from '../lib/content.js';
import { proxyFetch } from '../lib/proxy.js';
import { recordQuotaObservationsFromResponse, type QuotaObservationContext } from '../services/provider-quota.js';
import { providerTimeoutMs, streamStallTimeoutMs } from '../lib/provider-timeout.js';

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

// Gemini 3 REQUIRES the `thoughtSignature` that accompanied a function call to
// be echoed back whenever that call appears in conversation history, or it
// rejects the request with 400 "Function call is missing a thought_sig". But
// OpenAI-format clients (the API surface we expose) have no field to carry a
// provider-specific signature, so it's dropped on the round-trip and every
// multi-turn tool conversation through Gemini fails. To bridge this without a
// schema change, cache each signature we emit keyed by tool-call id and
// re-attach it when the same call comes back without one. Strictly additive: a
// cache miss yields exactly the previous behavior (the request may 400 and fail
// over, as before). Bounded with a TTL so it can't grow unbounded.
const THOUGHT_SIG_TTL_MS = 30 * 60 * 1000; // 30 min — longer than any single tool loop
const THOUGHT_SIG_MAX = 5000;
const thoughtSigCache = new Map<string, { sig: string; exp: number; name?: string; argsKey?: string }>();

function canonicalArgsKey(args: unknown): string | undefined {
  if (args === undefined || args === null) return undefined;
  if (typeof args !== 'object') return String(args);
  try {
    return JSON.stringify(args, (_key, value: unknown) => {
      if (value === null || value === undefined || typeof value !== 'object') return value;
      if (Array.isArray(value)) return value;
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1)),
      );
    });
  } catch {
    return undefined;
  }
}

function rememberThoughtSig(callId: string | undefined, sig: string | undefined, name?: string, args?: unknown): void {
  if (!callId || !sig) return;
  if (thoughtSigCache.size >= THOUGHT_SIG_MAX) {
    const oldest = thoughtSigCache.keys().next().value;
    if (oldest !== undefined) thoughtSigCache.delete(oldest);
  }
  thoughtSigCache.set(callId, { sig, exp: Date.now() + THOUGHT_SIG_TTL_MS, name, argsKey: canonicalArgsKey(args) });
}

function recallThoughtSig(callId: string | undefined, name?: string, argsKey?: string): string | undefined {
  if (!callId) return undefined;
  const hit = thoughtSigCache.get(callId);
  if (hit) {
    if (hit.exp < Date.now()) {
      thoughtSigCache.delete(callId);
    } else {
      return hit.sig;
    }
  }
  if (!name) return undefined;
  const now = Date.now();
  let best: string | undefined;
  for (const [id, entry] of thoughtSigCache) {
    if (entry.exp < now) {
      thoughtSigCache.delete(id);
      continue;
    }
    if (entry.name === name && entry.argsKey !== undefined && entry.argsKey === argsKey) {
      best = entry.sig;
    }
  }
  return best;
}

interface GeminiPart {
  text?: string;
  thought?: boolean;
  inlineData?: {
    mimeType: string;
    data: string;
  };
  thoughtSignature?: string;
  functionCall?: {
    id?: string;
    name?: string;
    args?: unknown;
  };
  functionResponse?: {
    id?: string;
    name?: string;
    response?: unknown;
  };
}

interface GeminiCandidate {
  content?: { parts?: GeminiPart[] };
  finishReason?: string;
}

interface GeminiResponse {
  candidates?: GeminiCandidate[];
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
}

type GeminiContent = { role: 'user' | 'model'; parts: GeminiPart[] };

function isGemmaModel(modelId: string): boolean {
  const normalized = modelId.toLowerCase().replace(/^models\//, '');
  return /(?:^|[/.:])gemma[-_]/.test(normalized);
}

function systemInstructionText(systemInstruction: { parts?: Array<{ text?: string }> } | undefined): string | null {
  const text = systemInstruction?.parts
    ?.map(part => part.text ?? '')
    .join('\n\n')
    .trim();
  return text ? text : null;
}

// Gemma models on the Gemini API historically 400 with "Developer instruction
// is not enabled", so system prompts fold into the first user turn instead of
// riding systemInstruction (#500). Older Gemma 3.x still rejects system
// instructions and users can register those ids, so the fold stays. Tools and
// functionCall/functionResponse history are deliberately NOT touched here
// anymore: Gemma 4 supports native function calling, and stripping them made
// the dashboard supports_tools toggle a no-op (#582).
function contentsForModel(
  modelId: string,
  contents: GeminiContent[],
  systemInstruction: { parts: Array<{ text: string }> } | undefined,
): { contents: GeminiContent[]; systemInstruction?: { parts: Array<{ text: string }> } } {
  if (!isGemmaModel(modelId)) return { contents, systemInstruction };

  const systemText = systemInstructionText(systemInstruction);
  if (!systemText) return { contents };

  return {
    contents: [
      { role: 'user', parts: [{ text: systemText }] },
      ...contents,
    ],
  };
}

function safeParseObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return { value: raw };
  }
}

function normalizeGeminiArgs(args: unknown): string {
  if (typeof args === 'string') return args;
  return JSON.stringify(args ?? {});
}

function toGeminiFinishReason(finishReason?: string): string {
  const r = (finishReason ?? '').toUpperCase();
  if (!r) return 'stop';
  if (r === 'MAX_TOKENS') return 'length';
  if (r === 'SAFETY' || r === 'RECITATION' || r === 'BLOCKLIST' || r === 'PROHIBITED_CONTENT' || r === 'SPII') {
    return 'content_filter';
  }
  return 'stop';
}

// Google Gemini accepts only a subset of JSON Schema (~OpenAPI 3.0).
// Strip fields that opencode / other strict-JSON-Schema clients send but
// Google rejects with 400 "Unknown name '<field>'".
const GEMINI_UNSUPPORTED_SCHEMA_KEYS = new Set([
  '$schema', '$id', '$ref', 'ref', '$defs', '$comment',
  'definitions',
  'exclusiveMinimum', 'exclusiveMaximum',
  'patternProperties', 'unevaluatedProperties', 'unevaluatedItems',
  'if', 'then', 'else',
  'contentEncoding', 'contentMediaType', 'contentSchema',
  'dependentRequired', 'dependentSchemas', 'dependencies',
  'additionalProperties',
  'examples', 'const', 'readOnly', 'writeOnly',
  'uniqueItems',
  'not', 'allOf', 'oneOf',
  'prefixItems',
  'contains', 'minContains', 'maxContains',
  'propertyNames',
  'multipleOf',
  'deprecated',
]);

function sanitizeForGeminiSchema(schema: unknown, inPropertiesMap = false): unknown {
  if (Array.isArray(schema)) {
    return schema.map(item => sanitizeForGeminiSchema(item));
  }
  if (schema && typeof schema === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
      if (inPropertiesMap) {
        out[k] = sanitizeForGeminiSchema(v);
        continue;
      }
      if (k.startsWith('x-')) continue;
      if (GEMINI_UNSUPPORTED_SCHEMA_KEYS.has(k)) continue;
      out[k] = sanitizeForGeminiSchema(v, k === 'properties');
    }
    return out;
  }
  return schema;
}

export function sanitizeForGemini(schema: unknown): unknown {
  return sanitizeForGeminiSchema(schema);
}

// OpenAI clients can't express Gemini's native Google Search grounding, so we
// treat a tool named `google_search` (a few spellings) as the signal to enable
// it. It maps to Gemini's `{ google_search: {} }` tool rather than a function
// declaration, and can ride alongside real function tools in the same array. (#59)
const GROUNDING_TOOL_NAMES = new Set(['google_search', 'googlesearch', 'google_search_retrieval']);

// reasoning_effort → Gemini thinkingBudget (tokens). The low/medium/high
// budgets follow the common gateway convention (OpenRouter's effort mapping);
// 'none'/'minimal' disable thinking outright. Models that can't run at the
// requested budget 400 and fail over like any provider-invalid request.
const EFFORT_THINKING_BUDGET: Record<'low' | 'medium' | 'high' | 'xhigh', number> = {
  low: 1024,
  medium: 8192,
  high: 24576,
  xhigh: 32768,
};

/**
 * Extended generationConfig knobs translated from the OpenAI wire: topK,
 * seed, penalties, and structured output. JSON output conflicts with function
 * calling on Gemini ("Function calling with a response mime type:
 * 'application/json' is unsupported"), so response_format is only applied on
 * tool-free requests. Params Gemini has no equivalent for (min_p, logit_bias,
 * logprobs…) are dropped by the platform policy in lib/sampling-params.ts and
 * are ignored here. Exported for tests.
 */
export function toGeminiExtendedConfig(options?: CompletionOptions): Record<string, unknown> {
  const out: Record<string, unknown> = {
    topK: options?.top_k,
    seed: options?.seed,
    presencePenalty: options?.presence_penalty,
    frequencyPenalty: options?.frequency_penalty,
  };
  const rf = options?.response_format;
  // Count only real function declarations, mirroring hasFunctionDeclarations:
  // grounding pseudo-tools (google_search etc.) are converted to a grounding
  // block by toGeminiTools and never conflict with responseMimeType — raw
  // tools.length was silently dropping structured output for grounding-only
  // requests.
  const hasTools = (options?.tools ?? []).some(t => !GROUNDING_TOOL_NAMES.has(t.function.name.toLowerCase()));
  if (rf && !hasTools) {
    out.responseMimeType = 'application/json';
    const schema = rf.type === 'json_schema' ? rf.json_schema?.schema : undefined;
    if (schema) out.responseSchema = sanitizeForGemini(schema);
  }
  // Request-side reasoning control: reasoning_effort → thinkingConfig. Only
  // set when the client asked — a request without the knob keeps Gemini's
  // model-default thinking behavior unchanged. includeThoughts surfaces
  // thought summaries so reasoning_content flows back out (see
  // extractReasoningContent).
  const effort = options?.reasoning_effort;
  if (effort) {
    out.thinkingConfig = (effort === 'none' || effort === 'minimal')
      ? { thinkingBudget: 0 }
      : { thinkingBudget: EFFORT_THINKING_BUDGET[effort], includeThoughts: true };
  }
  return out;
}

function toGeminiTools(tools?: ChatToolDefinition[]): Array<Record<string, unknown>> | undefined {
  if (!tools || tools.length === 0) return undefined;

  const functionDeclarations: Array<Record<string, unknown>> = [];
  let grounding = false;
  for (const t of tools) {
    if (GROUNDING_TOOL_NAMES.has(t.function.name.toLowerCase())) {
      grounding = true;
      continue;
    }
    functionDeclarations.push({
      name: t.function.name,
      description: t.function.description,
      parameters: sanitizeForGemini(t.function.parameters),
    });
  }

  const out: Array<Record<string, unknown>> = [];
  if (grounding) out.push({ google_search: {} });
  if (functionDeclarations.length > 0) out.push({ functionDeclarations });
  return out.length > 0 ? out : undefined;
}

function hasFunctionDeclarations(tools?: Array<Record<string, unknown>>): boolean {
  return tools?.some(t => 'functionDeclarations' in t) ?? false;
}

function toGeminiToolConfig(toolChoice?: ChatToolChoice): { functionCallingConfig: Record<string, unknown> } | undefined {
  if (!toolChoice) return undefined;

  if (typeof toolChoice === 'string') {
    const mode =
      toolChoice === 'none'
        ? 'NONE'
        : toolChoice === 'required'
          ? 'ANY'
          : 'AUTO';
    return { functionCallingConfig: { mode } };
  }

  return {
    functionCallingConfig: {
      mode: 'ANY',
      allowedFunctionNames: [toolChoice.function.name],
    },
  };
}

const MAX_IMAGE_BYTES = 8 * 1024 * 1024; // 8 MB cap on fetched/inlined images

// Pull the URL out of an OpenAI image content block. Accepts both the object
// form `{ image_url: { url } }` and the shorthand `{ image_url: '...' }`.
function extractImageUrl(block: unknown): string | undefined {
  const iu = (block as { image_url?: unknown })?.image_url;
  if (typeof iu === 'string') return iu;
  if (iu && typeof (iu as { url?: unknown }).url === 'string') return (iu as { url: string }).url;
  return undefined;
}

// Convert an image URL to a Gemini inlineData part. Handles base64 `data:` URLs
// directly; for `http(s)` URLs we fetch and inline because the Gemini API does
// not fetch external URLs itself. Fetching a user-supplied URL is a minor SSRF
// surface, acceptable for a single-user self-hosted proxy; we still restrict to
// http/https and cap the size. Returns null (part skipped) on any failure.
async function imageUrlToInlineData(url: string): Promise<{ mimeType: string; data: string } | null> {
  const dataMatch = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
  if (dataMatch) {
    const mimeType = dataMatch[1] || 'application/octet-stream';
    const isBase64 = Boolean(dataMatch[2]);
    const payload = dataMatch[3] ?? '';
    const data = isBase64
      ? payload
      : Buffer.from(decodeURIComponent(payload)).toString('base64');
    return { mimeType, data };
  }
  if (/^https?:\/\//i.test(url)) {
    try {
      const res = await proxyFetch(url, undefined, 'google');
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length === 0 || buf.length > MAX_IMAGE_BYTES) return null;
      const mimeType = res.headers.get('content-type')?.split(';')[0]?.trim() || 'image/jpeg';
      return { mimeType, data: buf.toString('base64') };
    } catch {
      return null;
    }
  }
  return null;
}

// Build Gemini parts for a user message: joined text first, then any images as
// inlineData. Non-array content (string/null) collapses to a single text part.
async function userContentToParts(content: ChatMessage['content']): Promise<GeminiPart[]> {
  const parts: GeminiPart[] = [];
  const text = contentToString(content);
  if (text.length > 0) parts.push({ text });

  if (Array.isArray(content)) {
    for (const block of content) {
      const type = (block as { type?: string })?.type;
      if (type !== 'image_url' && type !== 'image') continue;
      const url = extractImageUrl(block);
      if (!url) continue;
      const inlineData = await imageUrlToInlineData(url);
      if (inlineData) parts.push({ inlineData });
    }
  }

  // Gemini rejects empty `parts`; keep at least one (possibly empty) text part.
  if (parts.length === 0) parts.push({ text: '' });
  return parts;
}

// Translate OpenAI messages to Gemini format. Content may arrive as a string,
// null, or the OpenAI multimodal array envelope. System/assistant/tool messages
// flatten to text; user messages additionally carry images as inlineData parts.
async function toGeminiContents(messages: ChatMessage[]): Promise<{
  contents: GeminiContent[];
  systemInstruction?: { parts: Array<{ text: string }> };
}> {
  const systemMessages = messages
    .filter(m => m.role === 'system')
    .map(m => contentToString(m.content))
    .filter(s => s.length > 0);

  const toolNameByCallId = new Map<string, string>();
  for (const m of messages) {
    for (const tc of m.tool_calls ?? []) {
      toolNameByCallId.set(tc.id, tc.function.name);
    }
  }

  const contents = (await Promise.all(messages
    .filter(m => m.role !== 'system')
    .map(async (m): Promise<{ role: 'user' | 'model'; parts: GeminiPart[] } | null> => {
      if (m.role === 'assistant') {
        const parts: GeminiPart[] = [];

        const assistantText = contentToString(m.content);
        if (assistantText.length > 0) {
          parts.push({ text: assistantText });
        }

        for (const call of m.tool_calls ?? []) {
          // Prefer a signature the client preserved; otherwise recover the one
          // we cached when this call was first produced (OpenAI-format clients
          // drop the field, so this is the common path for Gemini multi-turn).
          const sig = call.thought_signature ?? recallThoughtSig(call.id, call.function.name, canonicalArgsKey(safeParseObject(call.function.arguments)));
          parts.push({
            thoughtSignature: sig,
            functionCall: {
              id: call.id,
              name: call.function.name,
              args: safeParseObject(call.function.arguments),
            },
          });
        }

        if (parts.length === 0) return null;
        return {
          role: 'model',
          parts,
        };
      }

      if (m.role === 'tool') {
        const toolCallId = m.tool_call_id;
        if (!toolCallId) return null;

        const toolName = m.name ?? toolNameByCallId.get(toolCallId) ?? 'tool';
        const response = safeParseObject(contentToString(m.content));

        return {
          role: 'user',
          parts: [{
            functionResponse: {
              id: toolCallId,
              name: toolName,
              response,
            },
          }],
        };
      }

      return {
        role: 'user',
        parts: await userContentToParts(m.content),
      };
    })))
    .filter((entry): entry is { role: 'user' | 'model'; parts: GeminiPart[] } => entry !== null);

  return {
    contents,
    systemInstruction: systemMessages.length > 0
      ? { parts: [{ text: systemMessages.join('\n\n') }] }
      : undefined,
  };
}

function extractToolCalls(parts: GeminiPart[] | undefined): ChatToolCall[] {
  const calls: ChatToolCall[] = [];
  if (!parts) return calls;

  let fallbackIndex = 0;
  for (const part of parts) {
    if (!part.functionCall?.name) continue;

    const id = part.functionCall.id ?? `call_${Date.now()}_${fallbackIndex++}`;
    // Cache the signature keyed by the id we hand the client, so when the client
    // echoes this call back (without the signature, as OpenAI format requires)
    // we can re-attach it and Gemini accepts the history.
    rememberThoughtSig(id, part.thoughtSignature, part.functionCall.name, part.functionCall.args);
    calls.push({
      id,
      type: 'function',
      function: {
        name: part.functionCall.name,
        arguments: normalizeGeminiArgs(part.functionCall.args),
      },
      thought_signature: part.thoughtSignature,
    });
  }

  return calls;
}

function extractText(parts: GeminiPart[] | undefined): string | null {
  if (!parts) return null;
  const text = parts
    .filter(p => p.thought !== true)
    .map(p => p.text ?? '')
    .join('');
  return text.length > 0 ? text : null;
}

function extractReasoningContent(parts: GeminiPart[] | undefined): string | null {
  if (!parts) return null;
  const text = parts
    .filter(p => p.thought === true)
    .map(p => p.text ?? '')
    .join('');
  return text.length > 0 ? text : null;
}

function toGeminiStopSequences(stop: CompletionOptions['stop']): string[] | undefined {
  if (!stop) return undefined;
  return Array.isArray(stop) ? stop : [stop];
}

interface GoogleProviderOptions {
  timeoutMs?: number;
}

export class GoogleProvider extends BaseProvider {
  readonly platform = 'google' as const;
  readonly name = 'Google AI Studio';
  private readonly timeoutMs: number;

  constructor(opts: GoogleProviderOptions = {}) {
    super();
    // PROVIDER_TIMEOUT_GOOGLE wins over the registration default (#547).
    this.timeoutMs = providerTimeoutMs('google', opts.timeoutMs ?? 15000);
  }

  async chatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
    quotaContext?: QuotaObservationContext,
  ): Promise<ChatCompletionResponse> {
    const translated = await toGeminiContents(messages);
    const request = contentsForModel(modelId, translated.contents, translated.systemInstruction);

    const tools = toGeminiTools(options?.tools);
    const body: Record<string, unknown> = {
      contents: request.contents,
      generationConfig: {
        temperature: options?.temperature,
        maxOutputTokens: options?.max_tokens,
        topP: options?.top_p,
        stopSequences: toGeminiStopSequences(options?.stop),
        ...toGeminiExtendedConfig(options),
      },
      tools,
      // functionCallingConfig is only valid when real function tools are present;
      // a grounding-only request (just google_search) must omit it. (#59)
      toolConfig: hasFunctionDeclarations(tools) ? toGeminiToolConfig(options?.tool_choice) : undefined,
    };
    if (request.systemInstruction) body.systemInstruction = request.systemInstruction;

    const url = `${API_BASE}/models/${modelId}:generateContent`;
    const res = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      // 'request' bounds: the deadline covers the body read too, so a 200
      // whose body hangs aborts instead of stalling res.json() forever.
    }, options?.timeoutMs ?? this.timeoutMs, { signal: options?.signal, timeoutBounds: 'request' });

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
      throw providerHttpError(res, `Google API error ${res.status}: ${(err as any).error?.message ?? res.statusText}`);
    }

    const data = await res.json() as GeminiResponse;
    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts;
    const toolCalls = extractToolCalls(parts);
    const text = extractText(parts);
    const reasoningContent = extractReasoningContent(parts);

    const usage: TokenUsage = {
      prompt_tokens: data.usageMetadata?.promptTokenCount ?? 0,
      completion_tokens: data.usageMetadata?.candidatesTokenCount ?? 0,
      total_tokens: data.usageMetadata?.totalTokenCount ?? 0,
    };

    return {
      id: this.makeId(),
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: modelId,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: text,
          ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
          ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: toolCalls.length > 0 ? 'tool_calls' : toGeminiFinishReason(candidate?.finishReason),
      }],
      usage,
      _routed_via: { platform: 'google', model: modelId },
    };
  }

  async *streamChatCompletion(
    apiKey: string,
    messages: ChatMessage[],
    modelId: string,
    options?: CompletionOptions,
    quotaContext?: QuotaObservationContext,
  ): AsyncGenerator<ChatCompletionChunk> {
    const translated = await toGeminiContents(messages);
    const request = contentsForModel(modelId, translated.contents, translated.systemInstruction);

    const tools = toGeminiTools(options?.tools);
    const body: Record<string, unknown> = {
      contents: request.contents,
      generationConfig: {
        temperature: options?.temperature,
        maxOutputTokens: options?.max_tokens,
        topP: options?.top_p,
        stopSequences: toGeminiStopSequences(options?.stop),
        ...toGeminiExtendedConfig(options),
      },
      tools,
      toolConfig: hasFunctionDeclarations(tools) ? toGeminiToolConfig(options?.tool_choice) : undefined,
    };
    if (request.systemInstruction) body.systemInstruction = request.systemInstruction;

    const url = `${API_BASE}/models/${modelId}:streamGenerateContent?alt=sse`;
    const res = await this.fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      // Default 'headers' bounds: the deadline dies at response headers, and
      // the client signal + stall watchdog own the stream from there.
    }, options?.timeoutMs ?? this.timeoutMs, { signal: options?.signal });

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
      throw providerHttpError(res, `Google API error ${res.status}: ${(err as any).error?.message ?? res.statusText}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error('No response body');

    const decoder = new TextDecoder();
    const id = this.makeId();
    let buffer = '';
    let emittedFinish = false;
    let sawToolCalls = false;

    const seenToolCallKeys = new Set<string>();

    // Same mid-stream inactivity watchdog as readSseStream (#553): this adapter
    // parses Gemini's own frame format, so it reads the body itself and used to
    // have no bound at all on a stalled read. Same first-byte grace as
    // readSseStream too (#584): the chat timeout that bounded the headers also
    // budgets the first read, floored at the stall budget.
    const inactivityTimeoutMs = streamStallTimeoutMs(this.platform);
    const firstByteMs = this.firstByteBudgetMs(options?.timeoutMs ?? this.timeoutMs, inactivityTimeoutMs);
    let awaitingFirstByte = true;

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
            if (!emittedFinish) {
              emittedFinish = true;
              yield {
                id,
                object: 'chat.completion.chunk',
                created: Math.floor(Date.now() / 1000),
                model: modelId,
                choices: [{
                  index: 0,
                  delta: {},
                  finish_reason: sawToolCalls ? 'tool_calls' : 'stop',
                }],
              };
            }
            return;
          }

          // Skip malformed SSE frames instead of aborting the whole stream.
          // Matches the defensive parse in openai-compat / cohere / cloudflare:
          // a single corrupt chunk shouldn't take down the rest of the response.
          let chunk: GeminiResponse;
          try {
            chunk = JSON.parse(raw) as GeminiResponse;
          } catch {
            continue;
          }
          const candidate = chunk.candidates?.[0];
          const parts = candidate?.content?.parts ?? [];

          const text = extractText(parts);
          const reasoningContent = extractReasoningContent(parts);
          const toolCalls = extractToolCalls(parts).filter(call => {
            const key = `${call.id}:${call.function.name}:${call.function.arguments}`;
            if (seenToolCallKeys.has(key)) return false;
            seenToolCallKeys.add(key);
            return true;
          });

          if ((text && text.length > 0) || (reasoningContent && reasoningContent.length > 0) || toolCalls.length > 0) {
            sawToolCalls = sawToolCalls || toolCalls.length > 0;
            yield {
              id,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: modelId,
              choices: [{
                index: 0,
                delta: {
                  ...(text ? { content: text } : {}),
                  ...(reasoningContent ? { reasoning_content: reasoningContent } : {}),
                  ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
                },
                finish_reason: null,
              }],
            };
          }

          if (candidate?.finishReason && !emittedFinish) {
            emittedFinish = true;
            yield {
              id,
              object: 'chat.completion.chunk',
              created: Math.floor(Date.now() / 1000),
              model: modelId,
              choices: [{
                index: 0,
                delta: {},
                finish_reason: sawToolCalls ? 'tool_calls' : toGeminiFinishReason(candidate.finishReason),
              }],
            };
            return;
          }
        }
      }
    } finally {
      // Runs on normal completion, on the early returns above, AND when the
      // consumer abandons the generator mid-stream (a client disconnect breaks
      // the route pump's for-await, which calls gen.return() at the yield
      // point). Without it the Gemini generation kept running upstream —
      // quota burning with nobody reading — because this adapter reads the
      // body itself instead of going through readSseStream's shared cleanup.
      reader.cancel().catch(() => { /* upstream already gone */ });
    }

    if (!emittedFinish) {
      yield {
        id,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: modelId,
        choices: [{
          index: 0,
          delta: {},
          finish_reason: sawToolCalls ? 'tool_calls' : 'stop',
        }],
      };
    }
  }

  async validateKey(apiKey: string, quotaContext?: QuotaObservationContext): Promise<KeyValidationResult> {
    // Transport errors propagate — health.ts marks status='error' without
    // counting toward auto-disable.
    const res = await this.fetchWithTimeout(
      `${API_BASE}/models`,
      { method: 'GET', headers: { 'x-goog-api-key': apiKey } },
      10000,
      { timeoutBounds: 'request' },
    );
    recordQuotaObservationsFromResponse(res, {
      platform: this.platform,
      keyId: quotaContext?.keyId,
      providerAccountId: quotaContext?.providerAccountId,
      modelId: quotaContext?.modelId,
      quotaPoolKey: quotaContext?.quotaPoolKey,
      endpoint: 'models',
    });
    if (res.ok) return true;

    // Google's error taxonomy is NOT the usual 401/403-means-bad-key (#268):
    //   - bad/expired key            → HTTP 400 INVALID_ARGUMENT / reason API_KEY_INVALID
    //   - API not enabled on project → HTTP 403 PERMISSION_DENIED / reason SERVICE_DISABLED
    //   - IP / referrer / API-key restriction, or empty key → HTTP 403 PERMISSION_DENIED
    //   - unsupported region         → HTTP 400 FAILED_PRECONDITION ("User location is not supported")
    // The old check (`status !== 401 && status !== 403`) had this exactly
    // backwards: it marked a genuinely-bad 400 key as HEALTHY, and auto-disabled
    // a perfectly good key that merely hit a permission/region/restriction 403 on
    // the host running the proxy (the key still works for generateContent from
    // another network). So only a CONFIRMED bad credential returns false (which
    // counts toward auto-disable); every other non-2xx is inconclusive and throws
    // so health.ts records status='error' WITHOUT disabling a usable key.
    type GoogleErrorBody = { error?: { message?: unknown; status?: unknown; details?: unknown } };
    let body: GoogleErrorBody | null = null;
    try { body = (await res.json()) as GoogleErrorBody; } catch { /* non-JSON error body */ }
    const err = body?.error;
    const details = Array.isArray(err?.details) ? err!.details as Array<{ reason?: unknown }> : [];
    const reason = details.find(d => typeof d?.reason === 'string')?.reason as string | undefined;
    const message = typeof err?.message === 'string' ? err.message : '';
    const gStatus = typeof err?.status === 'string' ? err.status : undefined;

    const badCredentials =
      res.status === 401 ||
      reason === 'API_KEY_INVALID' ||
      /API key not valid|API key expired|API_KEY_INVALID/i.test(message);
    if (badCredentials) {
      console.warn(`[Google] validateKey: key rejected as invalid (HTTP ${res.status}${reason ? ` ${reason}` : ''})`);
      return {
        valid: false,
        error: `Google key validation failed (HTTP ${res.status}${reason ? ` ${reason}` : ''})${message ? `: ${message}` : ''}`,
      };
    }

    console.warn(
      `[Google] validateKey: inconclusive HTTP ${res.status} (${gStatus ?? 'UNKNOWN'}${reason ? `/${reason}` : ''}): ${message.slice(0, 200)} ` +
      `— treating as 'error', not auto-disabling (the key may be valid but blocked by region/permission/restriction on this host).`,
    );
    throw new Error(
      `Google key validation inconclusive (HTTP ${res.status}${gStatus ? ` ${gStatus}` : ''}${reason ? ` ${reason}` : ''})` +
      `${message ? `: ${message}` : ''}`,
    );
  }
}
