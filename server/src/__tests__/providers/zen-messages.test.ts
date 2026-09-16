import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { ZenProvider, isOverloadedRetryableZenError, overloadedRetryDelayMs } from '../../providers/zen.js';
import { _resetZenKeylessState } from '../../services/zen-keyless.js';
import {
  anthropicErrorText,
  finalizeZenMessagesStream,
  isOverloadedUpstreamError,
  isZenMessagesModel,
  newZenMessagesStreamState,
  pushZenMessagesEvent,
  toAnthropicMessagesBody,
  toChatCompletionFromAnthropic,
} from '../../providers/zen-messages.js';
import type { ChatCompletionChunk, ChatMessage } from '@freellmapi/shared/types.js';

const MESSAGES: ChatMessage[] = [{ role: 'user', content: 'hi' }];

const COMPLETED_BODY = {
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'union-alpha',
  stop_reason: 'end_turn',
  content: [{ type: 'text', text: 'PONG' }],
  usage: { input_tokens: 10, output_tokens: 5 },
};

function jsonResponse(status: number, ok: boolean, body: unknown, capture?: { url?: string; body?: unknown; headers?: Record<string, string> }) {
  return vi.spyOn(global, 'fetch').mockImplementation(async (input: any, init?: any) => {
    if (capture) {
      capture.url = String(input);
      capture.headers = (init?.headers ?? {}) as Record<string, string>;
      try {
        capture.body = JSON.parse((init as { body?: string })?.body ?? '{}');
      } catch {
        capture.body = undefined;
      }
    }
    return { ok, status, statusText: 'Err', json: () => Promise.resolve(body), headers: { get: () => null } } as unknown as Response;
  });
}

function sseResponse(frames: string[]): any {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return { ok: true, status: 200, body: stream, headers: new Headers() };
}

async function collect(gen: AsyncGenerator<ChatCompletionChunk>): Promise<ChatCompletionChunk[]> {
  const out: ChatCompletionChunk[] = [];
  for await (const chunk of gen) out.push(chunk);
  return out;
}

beforeAll(() => {
  process.env.ENCRYPTION_KEY = '0'.repeat(64);
  initDb(':memory:');
});

beforeEach(() => {
  getDb().prepare('DELETE FROM api_keys').run();
  getDb().prepare('DELETE FROM settings').run();
  _resetZenKeylessState();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isZenMessagesModel', () => {
  it('matches union-alpha only', () => {
    expect(isZenMessagesModel('union-alpha')).toBe(true);
    expect(isZenMessagesModel('Union-Alpha')).toBe(true);
    expect(isZenMessagesModel('mimo-v2.5-free')).toBe(false);
    expect(isZenMessagesModel('muse-spark-1.3-contributor-free')).toBe(false);
  });
});

describe('toAnthropicMessagesBody', () => {
  it('builds system, text, tools and tool results', () => {
    const body = toAnthropicMessagesBody('union-alpha', [
      { role: 'system', content: 'be nice' },
      { role: 'user', content: 'run it' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'sh', arguments: '{"cmd":"ls"}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'ok' },
    ], {
      max_tokens: 100,
      temperature: 0.5,
      tools: [{ type: 'function', function: { name: 'sh', description: 'run', parameters: { type: 'object' } } }],
      tool_choice: 'auto',
    }, false);
    expect(body).toMatchObject({
      model: 'union-alpha',
      system: [{ type: 'text', text: 'be nice' }],
      max_tokens: 100,
      temperature: 0.5,
      stream: false,
      tool_choice: { type: 'auto' },
    });
    const messages = body.messages as Array<{ role: string; content: unknown[] }>;
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
    expect(messages[1].content).toEqual([{ type: 'tool_use', id: 'c1', name: 'sh', input: { cmd: 'ls' } }]);
    expect(messages[2].content).toEqual([{ type: 'tool_result', tool_use_id: 'c1', content: 'ok' }]);
  });

  it('converts base64 image blocks to Anthropic image sources', () => {
    const body = toAnthropicMessagesBody('union-alpha', [{
      role: 'user',
      content: [
        { type: 'text', text: 'see?' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,eA==' } },
      ],
    }], undefined, false);
    const messages = body.messages as Array<{ role: string; content: Array<{ type: string; source?: { type: string } }> }>;
    expect(messages[0].content[1]).toMatchObject({ type: 'image', source: { type: 'base64' } });
  });
});

describe('toChatCompletionFromAnthropic', () => {
  it('extracts text and usage', () => {
    const out = toChatCompletionFromAnthropic('union-alpha', COMPLETED_BODY);
    expect(out.choices[0].message.content).toBe('PONG');
    expect(out.choices[0].finish_reason).toBe('stop');
    expect(out.usage).toMatchObject({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  });

  it('maps tool_use blocks and length stops', () => {
    const out = toChatCompletionFromAnthropic('union-alpha', {
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 't1', name: 'sh', input: { cmd: 'ls' } }],
      usage: { input_tokens: 3, output_tokens: 4 },
    });
    expect(out.choices[0].finish_reason).toBe('tool_calls');
    expect(out.choices[0].message.tool_calls?.[0]).toMatchObject({ id: 't1', function: { name: 'sh' } });
    const length = toChatCompletionFromAnthropic('union-alpha', { stop_reason: 'max_tokens', content: [], usage: { input_tokens: 1, output_tokens: 1 } });
    expect(length.choices[0].finish_reason).toBe('length');
  });
});

describe('overloaded upstream classification', () => {
  it('detects the endpoint-unavailable 503', () => {
    const body = { error: { type: 'api_error', message: 'Error from provider (Console): Upstream request failed: Endpoint is unavailable.' } };
    expect(isOverloadedUpstreamError(503, body)).toBe(true);
    expect(isOverloadedUpstreamError(500, body)).toBe(false);
    expect(anthropicErrorText(body, 'ST')).toContain('Upstream request failed');
  });

  it('marks retryable overload delays with backoff', () => {
    const err = Object.assign(new Error('OpenCode Zen API error 503: Endpoint is unavailable.'), {
      status: 503,
      upstreamCtx: { zenOverloadedUpstream: true },
    });
    expect(isOverloadedRetryableZenError(err)).toBe(true);
    expect(overloadedRetryDelayMs(0)).toBe(3000);
    expect(overloadedRetryDelayMs(9)).toBe(15000);
  });
});

describe('ZenProvider union-alpha routing', () => {
  it('sends union-alpha to /messages with Anthropic version and body', async () => {
    const capture: { url?: string; body?: unknown; headers?: Record<string, string> } = {};
    jsonResponse(200, true, COMPLETED_BODY, capture);
    const out = await new ZenProvider().chatCompletion('k', MESSAGES, 'union-alpha', { max_tokens: 40 });
    expect(capture.url).toBe('https://opencode.ai/zen/v1/messages');
    expect(capture.headers?.['anthropic-version']).toBe('2023-06-01');
    expect(capture.body).toMatchObject({ model: 'union-alpha', stream: false, max_tokens: 40 });
    expect(out.choices[0].message.content).toBe('PONG');
    expect(out._routed_via).toEqual({ platform: 'opencode', model: 'union-alpha' });
  });

  it('retries overloaded 503s before succeeding', async () => {
    const overloaded = { type: 'error', error: { type: 'api_error', message: 'Upstream request failed: Endpoint is unavailable.' } };
    let calls = 0;
    vi.spyOn(global, 'fetch').mockImplementation(async () => {
      calls++;
      if (calls < 3) {
        return { ok: false, status: 503, json: () => Promise.resolve(overloaded), headers: { get: () => null } } as unknown as Response;
      }
      return { ok: true, status: 200, json: () => Promise.resolve(COMPLETED_BODY), headers: { get: () => null } } as unknown as Response;
    });
    const out = await new ZenProvider().chatCompletion('k', MESSAGES, 'union-alpha');
    expect(out.choices[0].message.content).toBe('PONG');
    expect(calls).toBe(3);
  }, 30000);

  it('streams Anthropic SSE events into OpenAI chunks', async () => {
    const frames = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_9","model":"union-alpha"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"PO"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"NG"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":1,"output_tokens":2}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    vi.spyOn(global, 'fetch').mockResolvedValue(sseResponse(frames));
    const chunks = await collect(new ZenProvider().streamChatCompletion('k', MESSAGES, 'union-alpha'));
    expect(chunks.map((chunk) => chunk.choices[0].delta.content ?? '').join('')).toBe('PONG');
    expect(chunks[chunks.length - 1].choices[0].finish_reason).toBe('stop');
    expect(chunks[chunks.length - 1].usage?.total_tokens).toBe(3);
  });

  it('throws on truncated Messages streams', () => {
    const state = newZenMessagesStreamState('union-alpha');
    pushZenMessagesEvent(state, { type: 'content_block_delta', data: { delta: { type: 'text_delta', text: 'hi' } } });
    expect(() => finalizeZenMessagesStream(state)).toThrow('without a terminal event');
  });
});
