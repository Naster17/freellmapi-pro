import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { initDb, getDb } from '../../db/index.js';
import { ZenProvider } from '../../providers/zen.js';
import { _resetZenKeylessState } from '../../services/zen-keyless.js';
import {
  buildResponsesBody,
  finalizeResponsesStream,
  isMuseResponsesModel,
  newResponsesStreamState,
  pushResponsesEvent,
  responsesErrorText,
  toChatCompletion,
  toResponsesEffort,
  toResponsesInput,
  toResponsesToolChoice,
  toResponsesTools,
} from '../../providers/zen-responses.js';
import type { ChatCompletionChunk, ChatMessage } from '@freellmapi/shared/types.js';

const MESSAGES: ChatMessage[] = [{ role: 'user', content: 'hi' }];

const COMPLETED_BODY = {
  id: 'resp_1',
  object: 'response',
  status: 'completed',
  model: 'muse-spark-1.3-contributor-free',
  output: [
    { type: 'reasoning', id: 'rs_1', status: 'completed' },
    { type: 'message', id: 'msg_1', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: 'PONG' }] },
  ],
  usage: { input_tokens: 13, output_tokens: 252, total_tokens: 265 },
};

function jsonResponse(status: number, ok: boolean, body: unknown, capture?: { url?: string; body?: unknown }) {
  return vi.spyOn(global, 'fetch').mockImplementation(async (input: any, init?: any) => {
    if (capture) {
      capture.url = String(input);
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

describe('isMuseResponsesModel', () => {
  it('matches muse-spark ids only', () => {
    expect(isMuseResponsesModel('muse-spark-1.3-contributor-free')).toBe(true);
    expect(isMuseResponsesModel('muse-spark-1.2')).toBe(true);
    expect(isMuseResponsesModel('mimo-v2.5-free')).toBe(false);
    expect(isMuseResponsesModel('nemotron-3-ultra-free')).toBe(false);
  });
});

describe('toResponsesInput', () => {
  it('folds system messages into instructions', () => {
    const { instructions, input } = toResponsesInput([
      { role: 'system', content: 'be nice' },
      { role: 'user', content: 'hi' },
    ]);
    expect(instructions).toBe('be nice');
    expect(input).toHaveLength(1);
    expect(input[0]).toMatchObject({ type: 'message', role: 'user' });
  });

  it('maps image_url parts to input_image', () => {
    const { input } = toResponsesInput([{
      role: 'user',
      content: [{ type: 'text', text: 'see?' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,x' } }],
    }]);
    expect(input[0]).toMatchObject({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'see?' }, { type: 'input_image', image_url: 'data:image/png;base64,x' }],
    });
  });

  it('maps assistant tool calls and tool outputs to function items', () => {
    const { input } = toResponsesInput([
      { role: 'user', content: 'run it' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'sh', arguments: '{"cmd":"ls"}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'ok' },
    ]);
    expect(input[1]).toMatchObject({ type: 'function_call', call_id: 'c1', name: 'sh' });
    expect(input[2]).toMatchObject({ type: 'function_call_output', call_id: 'c1', output: 'ok' });
  });
});

describe('request building', () => {
  it('maps sampling, tools and xhigh effort', () => {
    const body = buildResponsesBody('muse-spark-1.3-contributor-free', MESSAGES, {
      temperature: 0.5,
      max_tokens: 100,
      reasoning_effort: 'xhigh',
      tools: [{ type: 'function', function: { name: 'sh', description: 'run', parameters: { type: 'object' } } }],
      tool_choice: 'auto',
    }, false);
    expect(body).toMatchObject({
      model: 'muse-spark-1.3-contributor-free',
      temperature: 0.5,
      max_output_tokens: 100,
      reasoning: { effort: 'xhigh' },
      tool_choice: 'auto',
      stream: false,
    });
    expect(body.tools).toHaveLength(1);
  });

  it('drops reasoning none and maps function tool choice', () => {
    const body = buildResponsesBody('m', MESSAGES, {
      reasoning_effort: 'none',
      tool_choice: { type: 'function', function: { name: 'sh' } },
    }, true);
    expect(body).not.toHaveProperty('reasoning');
    expect(body.tool_choice).toEqual({ type: 'function', name: 'sh' });
  });

  it('toResponsesEffort passes the scale through and drops none', () => {
    expect(toResponsesEffort('xhigh')).toBe('xhigh');
    expect(toResponsesEffort('high')).toBe('high');
    expect(toResponsesEffort('none')).toBeUndefined();
    expect(toResponsesEffort(undefined)).toBeUndefined();
  });

  it('toResponsesTools drops non-function tools', () => {
    expect(toResponsesTools([])).toBeUndefined();
    const tools = toResponsesTools([
      { type: 'function', function: { name: 'sh' } },
      { type: 'web_search' as unknown as 'function', function: { name: 'x' } },
    ]);
    expect(tools).toHaveLength(1);
  });

  it('toResponsesToolChoice passes strings through', () => {
    expect(toResponsesToolChoice('required')).toBe('required');
    expect(toResponsesToolChoice(undefined)).toBeUndefined();
  });
});

describe('responsesErrorText', () => {
  it('reads nested and flat error shapes', () => {
    expect(responsesErrorText({ error: { message: 'boom' } }, 'ST')).toBe('boom');
    expect(responsesErrorText({ model: 'm', error: { type: 'ModelError', message: 'nope' } }, 'ST')).toBe('nope');
    expect(responsesErrorText({ message: 'flat' }, 'ST')).toBe('flat');
    expect(responsesErrorText({}, 'ST')).toBe('ST');
  });
});

describe('toChatCompletion', () => {
  it('extracts text, skips reasoning items and maps usage', () => {
    const out = toChatCompletion('muse-spark-1.3-contributor-free', COMPLETED_BODY);
    expect(out.choices[0].message.content).toBe('PONG');
    expect(out.choices[0].finish_reason).toBe('stop');
    expect(out.usage).toMatchObject({ prompt_tokens: 13, completion_tokens: 252, total_tokens: 265 });
    expect(out._routed_via).toBeUndefined();
  });

  it('maps function_call items to tool calls', () => {
    const out = toChatCompletion('m', {
      status: 'completed',
      model: 'm',
      output: [{ type: 'function_call', id: 'f1', call_id: 'c9', name: 'sh', arguments: '{"cmd":"ls"}' }],
      usage: { input_tokens: 5, output_tokens: 6, total_tokens: 11 },
    });
    expect(out.choices[0].finish_reason).toBe('tool_calls');
    expect(out.choices[0].message.tool_calls).toHaveLength(1);
    expect(out.choices[0].message.tool_calls?.[0]).toMatchObject({ id: 'c9', function: { name: 'sh' } });
  });

  it('maps incomplete to length and throws on failed', () => {
    const out = toChatCompletion('m', { status: 'incomplete', output: [], incomplete_details: { reason: 'max_output_tokens' } });
    expect(out.choices[0].finish_reason).toBe('length');
    expect(() => toChatCompletion('m', { status: 'failed', error: { message: 'bad' } })).toThrow('bad');
  });
});

describe('responses stream translator', () => {
  const delta = (text: string) => ({ type: 'response.output_text.delta', delta: text });
  const completed = (extra?: Record<string, unknown>) => ({
    type: 'response.completed',
    response: { id: 'resp_9', model: 'muse-spark-1.3-contributor-free', status: 'completed', output: [], usage: { input_tokens: 1, output_tokens: 2, total_tokens: 3 }, ...(extra ?? {}) },
  });

  it('streams text deltas then a stop finish with usage', () => {
    const state = newResponsesStreamState('m');
    const chunks = [
      ...pushResponsesEvent(state, delta('PO')),
      ...pushResponsesEvent(state, delta('NG')),
      ...pushResponsesEvent(state, completed()),
      ...finalizeResponsesStream(state),
    ];
    expect(chunks[0].choices[0].delta).toMatchObject({ role: 'assistant' });
    expect(chunks.map((c) => c.choices[0].delta.content ?? '').join('')).toBe('PONG');
    const last = chunks[chunks.length - 1];
    expect(last.choices[0].finish_reason).toBe('stop');
    expect(last.usage?.total_tokens).toBe(3);
  });

  it('emits tool calls from the completed response', () => {
    const state = newResponsesStreamState('m');
    pushResponsesEvent(state, delta(''));
    pushResponsesEvent(state, completed({
      output: [{ type: 'function_call', id: 'f1', call_id: 'c7', name: 'sh', arguments: '{"cmd":"ls"}' }],
    }));
    const tail = finalizeResponsesStream(state);
    const toolChunk = tail.find((c) => c.choices[0].delta.tool_calls?.length);
    expect(toolChunk?.choices[0].delta.tool_calls?.[0]).toMatchObject({ id: 'c7' });
    expect(tail[tail.length - 1].choices[0].finish_reason).toBe('tool_calls');
  });

  it('throws on failed and on truncated streams', () => {
    const failed = newResponsesStreamState('m');
    pushResponsesEvent(failed, { type: 'response.failed', response: { error: { message: 'gone' } } });
    expect(() => finalizeResponsesStream(failed)).toThrow('gone');
    expect(() => finalizeResponsesStream(newResponsesStreamState('m'))).toThrow('without a terminal event');
  });
});

describe('ZenProvider muse routing', () => {
  it('sends muse models to /responses with the translated body', async () => {
    const capture: { url?: string; body?: unknown } = {};
    jsonResponse(200, true, COMPLETED_BODY, capture);
    const out = await new ZenProvider().chatCompletion('k', MESSAGES, 'muse-spark-1.3-contributor-free', { max_tokens: 40 });
    expect(capture.url).toBe('https://opencode.ai/zen/v1/responses');
    expect(capture.body).toMatchObject({ model: 'muse-spark-1.3-contributor-free', stream: false, max_output_tokens: 40 });
    expect(out.choices[0].message.content).toBe('PONG');
    expect(out._routed_via).toEqual({ platform: 'opencode', model: 'muse-spark-1.3-contributor-free' });
  });

  it('keeps other models on chat/completions', async () => {
    const capture: { url?: string; body?: unknown } = {};
    jsonResponse(200, true, {
      id: 'x', object: 'chat.completion', created: 0, model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }, capture);
    await new ZenProvider().chatCompletion('k', MESSAGES, 'mimo-v2.5-free');
    expect(capture.url).toBe('https://opencode.ai/zen/v1/chat/completions');
  });

  it('surfaces responses endpoint errors as provider errors', async () => {
    jsonResponse(500, false, { type: 'error', error: { type: 'error', message: 'Internal server error' } });
    await expect(new ZenProvider().chatCompletion('k', MESSAGES, 'muse-spark-1.2-contributor-free'))
      .rejects.toThrow('OpenCode Zen API error 500: Internal server error');
  });

  it('streams muse deltas from response events', async () => {
    const frames = [
      'data: {"type":"response.output_text.delta","delta":"PO"}\n\n',
      'data: {"type":"response.output_text.delta","delta":"NG"}\n\n',
      'data: {"type":"response.completed","response":{"id":"resp_9","model":"muse-spark-1.3-contributor-free","status":"completed","output":[],"usage":{"input_tokens":1,"output_tokens":2,"total_tokens":3}}}\n\n',
    ];
    vi.spyOn(global, 'fetch').mockResolvedValue(sseResponse(frames));
    const chunks = await collect(new ZenProvider().streamChatCompletion('k', MESSAGES, 'muse-spark-1.3-contributor-free'));
    expect(chunks.map((c) => c.choices[0].delta.content ?? '').join('')).toBe('PONG');
    expect(chunks[chunks.length - 1].choices[0].finish_reason).toBe('stop');
  });
});
