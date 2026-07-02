import { describe, it, expect, vi, beforeEach } from 'vitest';
import { G4FProvider } from '../../providers/g4f.js';

describe('G4FProvider', () => {
  let provider: G4FProvider;

  beforeEach(() => {
    provider = new G4FProvider();
  });

  function mockProxy(response: { ok: boolean; status?: number; body: unknown }) {
    return vi.spyOn(global, 'fetch').mockImplementationOnce(async () => {
      const status = response.status ?? 200;
      return {
        ok: response.ok,
        status,
        json: () => Promise.resolve(response.body),
        headers: { get: () => null },
      } as any;
    });
  }

  it('exposes the g4f platform', () => {
    expect(provider.platform).toBe('g4f');
    expect(provider.name).toBe('g4f.space');
  });

  it('prefixes a clean model id with the known server shard', async () => {
    const cap = mockProxy({
      ok: true,
      body: { id: 'x', object: 'chat.completion', created: 0, model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    });
    await provider.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'deepseek-v4-pro');
    const sent = JSON.parse((cap.mock.calls[0][1] as any).body);
    expect(sent.model).toBe('srv_mp2i8rco3148dd85bec1:deepseek-v4-pro');
  });

  it('passes an already-prefixed model id through untouched', async () => {
    const cap = mockProxy({
      ok: true,
      body: { id: 'x', object: 'chat.completion', created: 0, model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    });
    await provider.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'srv_unknown:foo');
    const sent = JSON.parse((cap.mock.calls[0][1] as any).body);
    expect(sent.model).toBe('srv_unknown:foo');
  });

  it('tags the response with the platform/model it was routed via', async () => {
    mockProxy({
      ok: true,
      body: { id: 'x', object: 'chat.completion', created: 0, model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    });
    const res = await provider.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'kimi-k2.6');
    expect(res._routed_via).toEqual({ platform: 'g4f', model: 'kimi-k2.6' });
  });

  it('sends Authorization: Bearer <key>', async () => {
    const cap = mockProxy({
      ok: true,
      body: { id: 'x', object: 'chat.completion', created: 0, model: 'm', choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } },
    });
    await provider.chatCompletion('g4f_u_abc', [{ role: 'user', content: 'hi' }], 'kimi-k2.6');
    const headers = (cap.mock.calls[0][1] as any).headers;
    expect(headers.Authorization).toBe('Bearer g4f_u_abc');
  });

  it('surfaces upstream error messages from non-2xx responses', async () => {
    mockProxy({ ok: false, status: 429, body: { error: { message: 'Request limit exceeded' } } });
    await expect(
      provider.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'kimi-k2.6')
    ).rejects.toThrow(/Request limit exceeded/);
  });

  it('validateKey returns true on 200', async () => {
    mockProxy({ ok: true, status: 200, body: { data: [] } });
    expect(await provider.validateKey('k')).toBe(true);
  });

  it('validateKey returns false on 401', async () => {
    mockProxy({ ok: false, status: 401, body: {} });
    expect(await provider.validateKey('k')).toBe(false);
  });
});
