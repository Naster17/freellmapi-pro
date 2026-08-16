import { afterEach, describe, it, expect, vi } from 'vitest';
import { resolveProvider } from '../../providers/index.js';

const ENDPOINT = 'https://naster17--ep-kimi-k3.us-west.modal.direct/v1';
const ENDPOINT_NO_V1 = 'https://naster17--ep-kimi-k3.us-west.modal.direct';
const realFetch = globalThis.fetch;

describe('Modal provider', () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  function mockFetch(body: unknown, ok = true, status = 200) {
    return vi.spyOn(globalThis, 'fetch').mockImplementationOnce(async () => ({
      ok,
      status,
      json: () => Promise.resolve(body),
      headers: { get: () => null },
    } as any));
  }

  it('resolves a per-key provider from the endpoint URL and requires it', () => {
    expect(resolveProvider('modal')).toBeUndefined();
    const provider = resolveProvider('modal', ENDPOINT);
    expect(provider?.platform).toBe('modal');
    expect(provider?.name).toBe('Modal');
  });

  it('posts chat completions to the endpoint URL with the proxy token as bearer', async () => {
    const provider = resolveProvider('modal', ENDPOINT)!;
    const cap = mockFetch({
      id: 'chatcmpl-x',
      object: 'chat.completion',
      created: 0,
      model: 'moonshotai/Kimi-K3',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });

    const res = await provider.chatCompletion('wk-x.ws-y', [{ role: 'user', content: 'hi' }], 'moonshotai/Kimi-K3');

    expect(cap.mock.calls[0]![0]).toBe(`${ENDPOINT}/chat/completions`);
    expect((cap.mock.calls[0]![1] as any).headers.Authorization).toBe('Bearer wk-x.ws-y');
    expect(res._routed_via).toEqual({ platform: 'modal', model: 'moonshotai/Kimi-K3' });
  });

  it('appends /v1 when the pasted endpoint URL omits it', async () => {
    const provider = resolveProvider('modal', ENDPOINT_NO_V1)!;
    const chat = mockFetch({
      id: 'chatcmpl-x',
      object: 'chat.completion',
      created: 0,
      model: 'moonshotai/Kimi-K3',
      choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });

    const res = await provider.chatCompletion('wk-x.ws-y', [{ role: 'user', content: 'hi' }], 'moonshotai/Kimi-K3');

    expect(chat.mock.calls[0]![0]).toBe(`${ENDPOINT_NO_V1}/v1/chat/completions`);
    expect(res._routed_via).toEqual({ platform: 'modal', model: 'moonshotai/Kimi-K3' });

    const models = mockFetch({ object: 'list', data: [{ id: 'moonshotai/Kimi-K3' }] });
    expect(await provider.validateKey('wk-x.ws-y')).toBe(true);
    expect(models.mock.calls[0]![0]).toBe(`${ENDPOINT_NO_V1}/v1/models`);
  });

  it('validates the key against the endpoint /models route', async () => {
    const provider = resolveProvider('modal', ENDPOINT)!;
    const cap = mockFetch({ object: 'list', data: [{ id: 'moonshotai/Kimi-K3' }] });

    expect(await provider.validateKey('wk-x.ws-y')).toBe(true);
    expect(cap.mock.calls[0]![0]).toBe(`${ENDPOINT}/models`);
  });

  it('rejects an invalid key on 401', async () => {
    const provider = resolveProvider('modal', ENDPOINT)!;
    mockFetch({ error: { message: 'invalid token' } }, false, 401);

    expect(await provider.validateKey('wk-x.ws-y')).toMatchObject({ valid: false });
  });
});
