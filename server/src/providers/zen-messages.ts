import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatContentBlock,
  ChatMessage,
  ChatToolCall,
  ChatToolChoice,
  ChatToolDefinition,
} from '@freellmapi/shared/types.js';
import { contentToString } from '../lib/content.js';
import { repairToolArguments, toolSchemaMap } from '../lib/tool-args.js';

type ToolSchemaMap = Map<string, { type?: string; properties?: Record<string, { type?: string }> }>;

export function isZenMessagesModel(modelId: string): boolean {
  return /^union-alpha$/i.test(modelId.trim());
}

interface AnthropicContentBlock {
  type: string;
  text?: string;
  source?: {
    type?: string;
    media_type?: string;
    data?: string;
    url?: string;
  };
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
}

function extractImageUrl(block: unknown): string | undefined {
  const imageUrl = (block as { image_url?: unknown })?.image_url;
  if (typeof imageUrl === 'string') return imageUrl;
  const nested = (imageUrl as { url?: unknown })?.url;
  if (typeof nested === 'string') return nested;
  return undefined;
}

function toAnthropicContent(content: ChatMessage['content']): AnthropicContentBlock[] {
  if (content == null) return [];
  if (typeof content === 'string') {
    return content.length > 0 ? [{ type: 'text', text: content }] : [];
  }
  const blocks: AnthropicContentBlock[] = [];
  for (const block of content) {
    if (typeof block === 'string') {
      if (block.length > 0) blocks.push({ type: 'text', text: block });
      continue;
    }
    const typed = block as Exclude<ChatContentBlock, string> & {
      image_url?: unknown;
      imageUrl?: unknown;
      source?: AnthropicContentBlock['source'];
      text?: string;
    };
    const imageUrl = extractImageUrl(block) ?? (typeof typed.imageUrl === 'string' ? typed.imageUrl : undefined);
    if (typed.type === 'image_url' || typed.type === 'image' || typed.type === 'input_image' || imageUrl) {
      if (typed.source && typeof typed.source === 'object') {
        blocks.push({ type: 'image', source: typed.source });
        continue;
      }
      if (imageUrl) {
        const dataMatch = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(imageUrl);
        if (dataMatch) {
          blocks.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: dataMatch[1] || 'image/jpeg',
              data: dataMatch[3] ?? '',
            },
          });
        } else {
          blocks.push({ type: 'image', source: { type: 'url', url: imageUrl } });
        }
        continue;
      }
    }
    if (typeof typed.text === 'string' && typed.text.length > 0) {
      blocks.push({ type: 'text', text: typed.text });
    }
  }
  return blocks;
}

function safeToolInput(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw ?? {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function toAnthropicMessagesBody(
  modelId: string,
  messages: ChatMessage[],
  options: {
    max_tokens?: number;
    temperature?: number;
    top_p?: number;
    top_k?: number;
    stop?: string | string[];
    tools?: ChatToolDefinition[];
    tool_choice?: ChatToolChoice;
    stream?: boolean;
  } | undefined,
  stream: boolean,
): Record<string, unknown> {
  const system: Array<{ type: string; text: string }> = [];
  const converted: Array<{ role: 'user' | 'assistant'; content: AnthropicContentBlock[] }> = [];

  for (const message of messages) {
    if (message.role === 'system') {
      const text = contentToString(message.content);
      if (text.length > 0) system.push({ type: 'text', text });
      continue;
    }
    if (message.role === 'tool') {
      const text = contentToString(message.content);
      converted.push({
        role: 'user',
        content: [{
          type: 'tool_result',
          tool_use_id: message.tool_call_id ?? '',
          content: text,
        }],
      });
      continue;
    }
    if (message.role === 'assistant') {
      const content = toAnthropicContent(message.content);
      for (const call of message.tool_calls ?? []) {
        content.push({
          type: 'tool_use',
          id: call.id,
          name: call.function.name,
          input: safeToolInput(call.function.arguments),
        });
      }
      if (content.length === 0) continue;
      converted.push({ role: 'assistant', content });
      continue;
    }
    const content = toAnthropicContent(message.content);
    if (content.length === 0) continue;
    converted.push({ role: 'user', content });
  }

  const tools = options?.tools
    ?.filter((tool) => tool.type === 'function' && typeof tool.function?.name === 'string')
    .map((tool) => ({
      name: tool.function.name,
      ...(tool.function.description ? { description: tool.function.description } : {}),
      input_schema: (tool.function.parameters ?? { type: 'object', properties: {} }) as Record<string, unknown>,
    }));
  const toolChoice = toAnthropicToolChoice(options?.tool_choice);

  return {
    model: modelId,
    ...(system.length > 0 ? { system } : {}),
    messages: converted,
    max_tokens: options?.max_tokens ?? 1024,
    ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
    ...(options?.top_p !== undefined ? { top_p: options.top_p } : {}),
    ...(options?.top_k !== undefined ? { top_k: options.top_k } : {}),
    ...(options?.stop !== undefined ? { stop_sequences: Array.isArray(options.stop) ? options.stop : [options.stop] } : {}),
    ...(tools?.length ? { tools } : {}),
    ...(toolChoice ? { tool_choice: toolChoice } : {}),
    stream,
  };
}

function toAnthropicToolChoice(choice?: ChatToolChoice): Record<string, unknown> | undefined {
  if (!choice) return undefined;
  if (choice === 'auto') return { type: 'auto' };
  if (choice === 'none') return { type: 'none' };
  if (choice === 'required') return { type: 'any' };
  return { type: 'tool', name: choice.function.name };
}

export function anthropicErrorText(body: unknown, statusText: string): string {
  if (body && typeof body === 'object') {
    const nested = (body as { error?: unknown }).error;
    if (typeof nested === 'string' && nested.length > 0) return nested;
    if (nested && typeof nested === 'object' && typeof (nested as { message?: unknown }).message === 'string') {
      return (nested as { message: string }).message;
    }
    if (typeof (body as { message?: unknown }).message === 'string') return (body as { message: string }).message;
  }
  return statusText;
}

export function isOverloadedUpstreamError(status: number, body: unknown): boolean {
  if (status !== 503) return false;
  const text = anthropicErrorText(body, '').toLowerCase();
  return text.includes('upstream request failed') || text.includes('endpoint is unavailable');
}

interface AnthropicMessageEnvelope {
  id?: string;
  model?: string;
  stop_reason?: string | null;
  content?: AnthropicContentBlock[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

function toToolCalls(blocks: AnthropicContentBlock[] | undefined, schemas: ToolSchemaMap): ChatToolCall[] {
  const calls: ChatToolCall[] = [];
  for (const block of blocks ?? []) {
    if (block.type !== 'tool_use' || !block.name) continue;
    const args = typeof block.input === 'string' ? block.input : JSON.stringify(block.input ?? {});
    calls.push({
      id: block.id ?? `call_${calls.length + 1}`,
      type: 'function',
      function: {
        name: block.name,
        arguments: repairToolArguments(args, schemas.get(block.name)),
      },
    });
  }
  return calls;
}

export function toChatCompletionFromAnthropic(
  modelId: string,
  envelope: AnthropicMessageEnvelope,
  schemas?: ToolSchemaMap,
): ChatCompletionResponse {
  const text = (envelope.content ?? [])
    .filter((block) => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text as string)
    .join('');
  const toolCalls = toToolCalls(envelope.content, schemas ?? new Map());
  const promptTokens = envelope.usage?.input_tokens ?? 0;
  const completionTokens = envelope.usage?.output_tokens ?? 0;
  return {
    id: envelope.id ?? `chatcmpl-zen-${Date.now()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: envelope.model ?? modelId,
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: text,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: toolCalls.length > 0 ? 'tool_calls' : envelope.stop_reason === 'max_tokens' ? 'length' : 'stop',
    }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  };
}

export interface ZenMessagesStreamState {
  id: string;
  created: number;
  model: string;
  roleSent: boolean;
  terminal: boolean;
  failure?: string;
  finishReason?: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  toolBlocks: Map<number, { id: string; name: string; input: string }>;
}

export function newZenMessagesStreamState(modelId: string): ZenMessagesStreamState {
  return {
    id: `chatcmpl-zen-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    roleSent: false,
    terminal: false,
    toolBlocks: new Map(),
  };
}

function baseChunk(state: ZenMessagesStreamState): Omit<ChatCompletionChunk, 'choices'> {
  return { id: state.id, object: 'chat.completion.chunk', created: state.created, model: state.model };
}

export function pushZenMessagesEvent(
  state: ZenMessagesStreamState,
  event: { type: string; data: unknown },
): ChatCompletionChunk[] {
  const out: ChatCompletionChunk[] = [];
  const ensureRole = () => {
    if (!state.roleSent) {
      state.roleSent = true;
      out.push({ ...baseChunk(state), choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
    }
  };
  if (event.type === 'ping') return out;
  const data = event.data as Record<string, unknown>;
  if (event.type === 'message_start') {
    const message = (data?.message ?? {}) as AnthropicMessageEnvelope;
    if (typeof message.id === 'string') state.id = message.id;
    if (typeof message.model === 'string') state.model = message.model;
    return out;
  }
  if (event.type === 'content_block_start') {
    const block = (data?.content_block ?? {}) as AnthropicContentBlock & { index?: number };
    const index = typeof data?.index === 'number' ? (data.index as number) : 0;
    if (block.type === 'tool_use' && block.name) {
      state.toolBlocks.set(index, { id: block.id ?? `call_${index}`, name: block.name, input: '' });
    }
    return out;
  }
  if (event.type === 'content_block_delta') {
    const index = typeof data?.index === 'number' ? (data.index as number) : 0;
    const delta = (data?.delta ?? {}) as { type?: string; text?: string; partial_json?: string };
    if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text.length > 0) {
      ensureRole();
      out.push({ ...baseChunk(state), choices: [{ index: 0, delta: { content: delta.text }, finish_reason: null }] });
    } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
      const current = state.toolBlocks.get(index);
      if (current) current.input += delta.partial_json;
    }
    return out;
  }
  if (event.type === 'message_delta') {
    const delta = (data?.delta ?? {}) as { stop_reason?: string };
    const usage = (data?.usage ?? {}) as AnthropicMessageEnvelope['usage'];
    if (usage && (usage.input_tokens !== undefined || usage.output_tokens !== undefined)) {
      const promptTokens = usage.input_tokens ?? 0;
      const completionTokens = usage.output_tokens ?? 0;
      state.usage = { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens };
    }
    state.finishReason = delta.stop_reason === 'max_tokens' ? 'length' : delta.stop_reason === 'tool_use' ? 'tool_calls' : 'stop';
    state.terminal = true;
    return out;
  }
  if (event.type === 'message_stop') {
    state.terminal = true;
    return out;
  }
  if (event.type === 'error') {
    state.failure = anthropicErrorText(data, 'upstream error');
    state.terminal = true;
    return out;
  }
  return out;
}

export function finalizeZenMessagesStream(
  state: ZenMessagesStreamState,
  schemas?: ToolSchemaMap,
): ChatCompletionChunk[] {
  if (state.failure) throw new Error(state.failure);
  if (!state.terminal) {
    throw new Error('OpenCode Zen Messages stream ended without a terminal event (truncated generation)');
  }
  const out: ChatCompletionChunk[] = [];
  const resolvedSchemas = schemas ?? new Map();
  const ordered = [...state.toolBlocks.entries()].sort((a, b) => a[0] - b[0]);
  ordered.forEach(([, block], position) => {
    out.push({
      ...baseChunk(state),
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: position,
            id: block.id,
            type: 'function',
            function: { name: block.name, arguments: repairToolArguments(block.input || '{}', resolvedSchemas.get(block.name)) },
          }] as unknown as ChatToolCall[],
        },
        finish_reason: null,
      }],
    });
  });
  out.push({
    ...baseChunk(state),
    choices: [{ index: 0, delta: {}, finish_reason: state.finishReason ?? 'stop' }],
    ...(state.usage ? { usage: state.usage } : {}),
  });
  state.toolBlocks.clear();
  return out;
}

export function toolSchemasFor(options?: { tools?: ChatToolDefinition[] }): ToolSchemaMap {
  return toolSchemaMap(options?.tools);
}
