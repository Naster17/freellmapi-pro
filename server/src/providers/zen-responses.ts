import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatMessage,
  ChatToolCall,
  ChatToolChoice,
  ChatToolDefinition,
} from '@freellmapi/shared/types.js';
import type { CompletionOptions } from './base.js';

export function isMuseResponsesModel(modelId: string): boolean {
  return /muse-spark/i.test(modelId);
}

type ResponsesInputItem =
  | { type: 'message'; role: 'system' | 'developer' | 'user' | 'assistant'; content: Array<{ type: string; text?: string; image_url?: string }> }
  | { type: 'function_call'; id?: string; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string };

export function toResponsesInput(messages: ChatMessage[]): { instructions?: string; input: ResponsesInputItem[] } {
  const instructions: string[] = [];
  const input: ResponsesInputItem[] = [];
  for (const message of messages) {
    if (message.role === 'system') {
      const text = contentToText(message.content);
      if (text.length > 0) instructions.push(text);
      continue;
    }
    if (message.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: message.tool_call_id ?? '',
        output: contentToText(message.content),
      });
      continue;
    }
    if (message.role === 'assistant' && message.tool_calls?.length) {
      const text = contentToText(message.content);
      if (text.length > 0) {
        input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
      }
      for (const call of message.tool_calls) {
        input.push({
          type: 'function_call',
          id: call.id,
          call_id: call.id,
          name: call.function.name,
          arguments: typeof call.function.arguments === 'string'
            ? call.function.arguments
            : JSON.stringify(call.function.arguments ?? {}),
        });
      }
      continue;
    }
    const parts = contentToParts(message.content);
    if (parts.length === 0) continue;
    input.push({ type: 'message', role: message.role, content: parts });
  }
  return instructions.length > 0 ? { instructions: instructions.join('\n\n'), input } : { input };
}

function contentToText(content: ChatMessage['content']): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  return content.map((block) => (typeof block === 'string' ? block : (block.text ?? ''))).join('');
}

function contentToParts(content: ChatMessage['content']): Array<{ type: string; text?: string; image_url?: string }> {
  if (content == null) return [];
  if (typeof content === 'string') return content.length > 0 ? [{ type: 'input_text', text: content }] : [];
  const parts: Array<{ type: string; text?: string; image_url?: string }> = [];
  for (const block of content) {
    if (typeof block === 'string') {
      if (block.length > 0) parts.push({ type: 'input_text', text: block });
      continue;
    }
    const type = block.type ?? (block.text !== undefined ? 'text' : undefined);
    if (type === 'input_image' || type === 'image_url' || type === 'image') {
      const url = typeof (block as { image_url?: unknown }).image_url === 'string'
        ? (block as { image_url: string }).image_url
        : (block as { image_url?: { url?: string } }).image_url?.url;
      if (url) parts.push({ type: 'input_image', image_url: url });
      continue;
    }
    if (typeof block.text === 'string' && block.text.length > 0) parts.push({ type: 'input_text', text: block.text });
  }
  return parts;
}

export function toResponsesTools(tools?: ChatToolDefinition[]): Array<Record<string, unknown>> | undefined {
  if (!tools?.length) return undefined;
  const fns = tools.filter((t) => t.type === 'function' && typeof t.function?.name === 'string');
  if (fns.length === 0) return undefined;
  return fns.map((t) => ({
    type: 'function',
    name: t.function.name,
    ...(t.function.description ? { description: t.function.description } : {}),
    ...(t.function.parameters ? { parameters: t.function.parameters } : {}),
    ...(t.function.strict != null ? { strict: t.function.strict } : {}),
  }));
}

export function toResponsesToolChoice(choice?: ChatToolChoice): string | Record<string, unknown> | undefined {
  if (!choice) return undefined;
  if (typeof choice === 'string') return choice;
  return { type: 'function', name: choice.function.name };
}

export function toResponsesEffort(effort: CompletionOptions['reasoning_effort']): string | undefined {
  if (!effort || effort === 'none') return undefined;
  if (effort === 'minimal' || effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'xhigh') return effort;
  return undefined;
}

export function buildResponsesBody(
  modelId: string,
  messages: ChatMessage[],
  options: CompletionOptions | undefined,
  stream: boolean,
): Record<string, unknown> {
  const { instructions, input } = toResponsesInput(messages);
  const effort = toResponsesEffort(options?.reasoning_effort);
  const responseFormat = options?.response_format;
  const body: Record<string, unknown> = {
    model: modelId,
    input,
    temperature: options?.temperature,
    top_p: options?.top_p,
    max_output_tokens: options?.max_tokens,
    tools: toResponsesTools(options?.tools),
    tool_choice: toResponsesToolChoice(options?.tool_choice),
    parallel_tool_calls: options?.parallel_tool_calls,
    ...(effort ? { reasoning: { effort } } : {}),
    ...(responseFormat ? { text: { format: responseFormat } } : {}),
    stream,
  };
  if (instructions !== undefined) body.instructions = instructions;
  return body;
}

export function responsesErrorText(body: unknown, statusText: string): string {
  if (body && typeof body === 'object') {
    const err = (body as { error?: unknown }).error;
    if (typeof err === 'string' && err.length > 0) return err;
    if (err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') {
      return (err as { message: string }).message;
    }
    if (typeof (body as { message?: unknown }).message === 'string') return (body as { message: string }).message;
  }
  return statusText;
}

interface ResponsesOutputItem {
  type?: string;
  role?: string;
  content?: Array<{ type?: string; text?: string }>;
  id?: string;
  call_id?: string;
  name?: string;
  arguments?: unknown;
}

interface ResponsesEnvelope {
  id?: string;
  model?: string;
  status?: string;
  output?: ResponsesOutputItem[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    output_tokens_details?: { reasoning_tokens?: number };
  };
  error?: { code?: string; message?: string };
  incomplete_details?: { reason?: string };
}

function extractOutput(envelope: ResponsesEnvelope): { text: string; toolCalls: ChatToolCall[] } {
  const texts: string[] = [];
  const toolCalls: ChatToolCall[] = [];
  for (const item of envelope.output ?? []) {
    if (item.type === 'function_call' && item.name) {
      toolCalls.push({
        id: item.call_id ?? item.id ?? `call_${toolCalls.length}`,
        type: 'function',
        function: {
          name: item.name,
          arguments: typeof item.arguments === 'string' ? item.arguments : JSON.stringify(item.arguments ?? {}),
        },
      });
    } else if (item.type === 'message') {
      for (const part of item.content ?? []) {
        if ((part.type === 'output_text' || part.type === 'text') && typeof part.text === 'string') texts.push(part.text);
      }
    }
  }
  return { text: texts.join(''), toolCalls };
}

function incompleteFinishReason(reason?: string): string {
  if (reason === 'max_output_tokens') return 'length';
  if (reason === 'content_filter') return 'content_filter';
  return 'stop';
}

export function toChatCompletion(modelId: string, envelope: ResponsesEnvelope): ChatCompletionResponse {
  if (envelope.status && envelope.status !== 'completed' && envelope.status !== 'incomplete') {
    throw new Error(envelope.error?.message ?? `OpenCode Zen Responses API returned status '${envelope.status}'`);
  }
  const { text, toolCalls } = extractOutput(envelope);
  const usage = envelope.usage;
  const promptTokens = usage?.input_tokens ?? 0;
  const completionTokens = usage?.output_tokens ?? 0;
  return {
    id: envelope.id ?? `resp_${Date.now()}`,
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
      finish_reason: toolCalls.length > 0 ? 'tool_calls' : envelope.status === 'incomplete' ? incompleteFinishReason(envelope.incomplete_details?.reason) : 'stop',
    }],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: usage?.total_tokens ?? promptTokens + completionTokens,
    },
  };
}

export interface ResponsesStreamState {
  id: string;
  created: number;
  model: string;
  roleSent: boolean;
  terminal: boolean;
  failure?: string;
  finishReason?: string;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  argBuffers: Map<number, string>;
  pendingToolCalls: ChatToolCall[];
}

export function newResponsesStreamState(modelId: string): ResponsesStreamState {
  return {
    id: `chatcmpl-zen-${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    created: Math.floor(Date.now() / 1000),
    model: modelId,
    roleSent: false,
    terminal: false,
    argBuffers: new Map(),
    pendingToolCalls: [],
  };
}

function baseChunk(state: ResponsesStreamState): Omit<ChatCompletionChunk, 'choices'> {
  return { id: state.id, object: 'chat.completion.chunk', created: state.created, model: state.model };
}

export function pushResponsesEvent(state: ResponsesStreamState, event: unknown): ChatCompletionChunk[] {
  if (!event || typeof event !== 'object' || typeof (event as { type?: unknown }).type !== 'string') return [];
  const type = (event as { type: string }).type;
  const out: ChatCompletionChunk[] = [];
  const ensureRole = () => {
    if (!state.roleSent) {
      state.roleSent = true;
      out.push({ ...baseChunk(state), choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
    }
  };
  if (type === 'response.output_text.delta' && typeof (event as { delta?: unknown }).delta === 'string') {
    ensureRole();
    out.push({ ...baseChunk(state), choices: [{ index: 0, delta: { content: (event as { delta: string }).delta }, finish_reason: null }] });
    return out;
  }
  if (type === 'response.function_call_arguments.delta') {
    const index = typeof (event as { output_index?: unknown }).output_index === 'number'
      ? (event as { output_index: number }).output_index
      : 0;
    const delta = (event as { delta?: unknown }).delta;
    if (typeof delta === 'string') state.argBuffers.set(index, (state.argBuffers.get(index) ?? '') + delta);
    return out;
  }
  if (type === 'error') {
    state.failure = responsesErrorText(event, 'upstream error');
    state.terminal = true;
    return out;
  }
  if (type === 'response.failed') {
    const response = (event as { response?: ResponsesEnvelope }).response;
    state.failure = response?.error?.message ?? 'OpenCode Zen Responses API returned status failed';
    state.terminal = true;
    return out;
  }
  if (type === 'response.completed' || type === 'response.incomplete') {
    const response = (event as { response?: ResponsesEnvelope }).response;
    if (!response) {
      state.failure = 'OpenCode Zen Responses stream ended without a response object';
      state.terminal = true;
      return out;
    }
    ensureRole();
    const { toolCalls } = extractOutput(response);
    const withArgs = toolCalls.map((call, i) => {
      const buffered = state.argBuffers.get(i);
      if ((!call.function.arguments || call.function.arguments === '{}') && buffered) {
        return { ...call, function: { ...call.function, arguments: buffered } };
      }
      return call;
    });
    state.pendingToolCalls = withArgs;
    state.finishReason = type === 'response.incomplete'
      ? incompleteFinishReason(response.incomplete_details?.reason)
      : withArgs.length > 0 ? 'tool_calls' : 'stop';
    const usage = response.usage;
    if (usage && (usage.input_tokens !== undefined || usage.output_tokens !== undefined)) {
      const promptTokens = usage.input_tokens ?? 0;
      const completionTokens = usage.output_tokens ?? 0;
      state.usage = { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: usage.total_tokens ?? promptTokens + completionTokens };
    }
    if (response.model) state.model = response.model;
    if (response.id) state.id = response.id;
    state.terminal = true;
    return out;
  }
  return out;
}

export function finalizeResponsesStream(state: ResponsesStreamState): ChatCompletionChunk[] {
  if (state.failure) throw new Error(state.failure);
  if (!state.terminal) {
    throw new Error('OpenCode Zen Responses stream ended without a terminal event (truncated generation)');
  }
  const out: ChatCompletionChunk[] = [];
  state.pendingToolCalls.forEach((call, index) => {
    out.push({
      ...baseChunk(state),
      choices: [{ index: 0, delta: { tool_calls: [{ index, ...call }] as unknown as ChatToolCall[] }, finish_reason: null }],
    });
  });
  out.push({
    ...baseChunk(state),
    choices: [{ index: 0, delta: {}, finish_reason: state.finishReason ?? 'stop' }],
    ...(state.usage ? { usage: state.usage } : {}),
  });
  state.pendingToolCalls = [];
  return out;
}
