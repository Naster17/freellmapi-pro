import { describe, it, expect, afterEach, vi } from 'vitest';
import { OpenAICompatProvider } from '../../providers/openai-compat.js';
import type { ChatMessage } from '@freellmapi/shared/types.js';
import type { ChatCompletionChunk } from '@freellmapi/shared/types.js';

const MESSAGES: ChatMessage[] = [{ role: 'user', content: 'hi' }];

function sseResponse(frames: string[]): any {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return { ok: true, body: stream, headers: new Headers() };
}

async function collect(gen: AsyncGenerator<ChatCompletionChunk>): Promise<ChatCompletionChunk[]> {
  const out: ChatCompletionChunk[] = [];
  for await (const chunk of gen) out.push(chunk);
  return out;
}

function makeProvider(): OpenAICompatProvider {
  return new OpenAICompatProvider({
    platform: 'opencode',
    name: 'TestZen',
    baseUrl: 'https://opencode.ai/zen/v1',
  });
}

const textFrame = 'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":null}]}\n\n';
const usageFrame = 'data: {"id":"","object":"chat.completion.chunk","created":1,"model":"m","choices":[],"usage":{"prompt_tokens":9,"completion_tokens":176,"total_tokens":185}}\n\n';

describe('terminal usage frame ends streams without [DONE] or finish_reason', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('completes a muse-style stream that closes with a bare usage frame', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(sseResponse([textFrame, usageFrame]));
    const chunks = await collect(makeProvider().streamChatCompletion('k', MESSAGES, 'm'));
    expect(chunks.some(c => c.choices?.[0]?.delta?.content === 'OK')).toBe(true);
    expect(chunks[chunks.length - 1].usage?.total_tokens).toBe(185);
  });

  it('still rejects a truncated stream with no [DONE], no finish_reason, no usage', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue(sseResponse([textFrame]));
    const err = await collect(makeProvider().streamChatCompletion('k', MESSAGES, 'm')).then(
      () => null,
      e => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain('no [DONE]');
  });

  it('does not treat a usage-bearing delta frame as terminal', async () => {
    const usageWithContent = 'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"m","choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}],"usage":{"prompt_tokens":9,"completion_tokens":5,"total_tokens":14}}\n\n';
    vi.spyOn(global, 'fetch').mockResolvedValue(sseResponse([usageWithContent]));
    const err = await collect(makeProvider().streamChatCompletion('k', MESSAGES, 'm')).then(
      () => null,
      e => e as Error,
    );
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain('no [DONE]');
  });
});
