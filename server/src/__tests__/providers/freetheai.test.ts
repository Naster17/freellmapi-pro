import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getProvider } from '../../providers/index.js';

describe('FreeTheAi provider', () => {
  function mockProxy(response: { ok: boolean; status?: number; body: unknown; headers?: Record<string, string> }) {
    return vi.spyOn(global, 'fetch').mockImplementationOnce(async () => {
      const status = response.status ?? 200;
      const headers = new Headers();
      for (const [k, v] of Object.entries(response.headers ?? {})) headers.set(k, v);
      return {
        ok: response.ok,
        status,
        json: () => Promise.resolve(response.body),
        headers,
      } as any;
    });
  }

  it('is registered under the freetheai platform with the correct name + baseUrl', () => {
    const provider = getProvider('freetheai');
    expect(provider).toBeDefined();
    expect(provider!.platform).toBe('freetheai');
    expect(provider!.name).toBe('FreeTheAi');
  });

  it('posts to the FreeTheAi v1 chat/completions endpoint with the upstream model id as-is', async () => {
    const provider = getProvider('freetheai')!;
    const cap = mockProxy({
      ok: true,
      body: {
        id: 'x', object: 'chat.completion', created: 0, model: 'm',
        choices: [{ index: 0, message: { role: 'assistant', content: 'hi' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    });
    await provider.chatCompletion('sta_abc', [{ role: 'user', content: 'hi' }], 'vova/gpt-5.5');
    const sentUrl = cap.mock.calls[0][0] as string;
    const sent = JSON.parse((cap.mock.calls[0][1] as any).body);
    expect(sentUrl).toBe('https://api.freetheai.xyz/v1/chat/completions');
    expect(sent.model).toBe('vova/gpt-5.5');
  });

  it('sends Authorization: Bearer <key> for the sta_... key format', async () => {
    const provider = getProvider('freetheai')!;
    const cap = mockProxy({
      ok: true,
      body: {
        id: 'x', object: 'chat.completion', created: 0, model: 'm',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    });
    await provider.chatCompletion('sta_27cb824d', [{ role: 'user', content: 'hi' }], 'min/minimax-m3');
    const headers = (cap.mock.calls[0][1] as any).headers;
    expect(headers.Authorization).toBe('Bearer sta_27cb824d');
  });

  it('tags the response with the platform/model it was routed via', async () => {
    const provider = getProvider('freetheai')!;
    mockProxy({
      ok: true,
      body: {
        id: 'x', object: 'chat.completion', created: 0, model: 'm',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    });
    const res = await provider.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'mim/mimo-v2.5-pro');
    expect(res._routed_via).toEqual({ platform: 'freetheai', model: 'mim/mimo-v2.5-pro' });
  });

  it('surfaces the upstream 429 + per-minute limit error verbatim', async () => {
    const provider = getProvider('freetheai')!;
    mockProxy({
      ok: false,
      status: 429,
      body: { error: { message: 'per-minute limit exceeded', type: 'rate_limit_error' } },
    });
    await expect(
      provider.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'vova/gpt-5.5')
    ).rejects.toThrow(/per-minute limit exceeded/);
  });

  it('surfaces the upstream 502 provider capacity error verbatim', async () => {
    const provider = getProvider('freetheai')!;
    mockProxy({
      ok: false,
      status: 502,
      body: { error: { message: 'provider capacity temporarily unavailable, please retry shortly. Error id: vova-abc123', type: 'provider_error' } },
    });
    await expect(
      provider.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'vova/claude-opus-4-8')
    ).rejects.toThrow(/provider capacity temporarily unavailable/);
  });

  it('surfaces the 403 daily_checkin_required error verbatim', async () => {
    const provider = getProvider('freetheai')!;
    mockProxy({
      ok: false,
      status: 403,
      body: { error: { message: 'daily_checkin_required', type: 'daily_checkin_required' } },
    });
    await expect(
      provider.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'vova/gpt-5.5')
    ).rejects.toThrow(/daily_checkin_required/);
  });

  it('validateKey returns true on 200 from /v1/models', async () => {
    const provider = getProvider('freetheai')!;
    mockProxy({ ok: true, status: 200, body: { data: [] } });
    expect(await provider.validateKey('sta_ok')).toBe(true);
  });

  it('validateKey returns false on 401', async () => {
    const provider = getProvider('freetheai')!;
    mockProxy({ ok: false, status: 401, body: { error: { message: 'invalid_api_key', type: 'invalid_api_key' } } });
    expect(await provider.validateKey('sta_bad')).toBe(false);
  });

  it('validateKey returns false on 403 invalid key', async () => {
    const provider = getProvider('freetheai')!;
    mockProxy({ ok: false, status: 403, body: { error: { message: 'user_paused', type: 'user_paused' } } });
    expect(await provider.validateKey('sta_paused')).toBe(false);
  });
});

describe('FreeTheAi glm-5.1 + glm-5.2 (reasoning-model shape)', () => {
  // glm/glm-5.1 and glm/glm-5.2 emit their primary output in `reasoning_content`
  // with `content` often empty (or just a one-word self-id). The OpenAICompatProvider
  // has a normalizeChoices() that folds `reasoning_content` into `content` when
  // `content` is empty AND no tool_calls are present — so the proxy output
  // becomes non-empty for downstream OpenAI-compatible clients.

  function mockProxy(response: { ok: boolean; status?: number; body: unknown; headers?: Record<string, string> }) {
    return vi.spyOn(global, 'fetch').mockImplementationOnce(async () => {
      const status = response.status ?? 200;
      const headers = new Headers();
      for (const [k, v] of Object.entries(response.headers ?? {})) headers.set(k, v);
      return {
        ok: response.ok,
        status,
        json: () => Promise.resolve(response.body),
        headers,
      } as any;
    });
  }

  it('glm/glm-5.1 folds reasoning_content into content when content is empty', async () => {
    const provider = getProvider('freetheai')!;
    mockProxy({
      ok: true,
      body: {
        id: 'x', object: 'chat.completion', created: 0, model: 'glm/glm-5.1',
        choices: [{
          index: 0, finish_reason: 'stop',
          message: { role: 'assistant', content: '', reasoning_content: 'GLM-4' },
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    });
    const res = await provider.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'glm/glm-5.1');
    expect(res.choices[0].message.content).toBe('GLM-4');
  });

  it('glm/glm-5.2 folds reasoning_content into content when content is empty', async () => {
    const provider = getProvider('freetheai')!;
    mockProxy({
      ok: true,
      body: {
        id: 'x', object: 'chat.completion', created: 0, model: 'glm/glm-5.2',
        choices: [{
          index: 0, finish_reason: 'stop',
          message: { role: 'assistant', content: '', reasoning_content: 'I am GLM-5.2' },
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    });
    const res = await provider.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'glm/glm-5.2');
    expect(res.choices[0].message.content).toBe('I am GLM-5.2');
  });

  it('glm/glm-5.1 with image_url returns 400 (vision NOT supported)', async () => {
    const provider = getProvider('freetheai')!;
    mockProxy({
      ok: false,
      status: 400,
      body: { error: { message: 'provider rejected the request payload. Error id: glm-741c57e68659', type: 'invalid_request_error' } },
    });
    await expect(
      provider.chatCompletion('k', [{
        role: 'user',
        content: [
          { type: 'text', text: 'What?' },
          { type: 'image_url', image_url: { url: 'https://example.com/img.png' } },
        ],
      }], 'glm/glm-5.1')
    ).rejects.toThrow(/provider rejected the request payload/);
  });

  it('glm/glm-5.2 with image_url returns 400 (vision NOT supported)', async () => {
    const provider = getProvider('freetheai')!;
    mockProxy({
      ok: false,
      status: 400,
      body: { error: { message: 'provider rejected the request payload. Error id: glm-90364dc6d06a', type: 'invalid_request_error' } },
    });
    await expect(
      provider.chatCompletion('k', [{
        role: 'user',
        content: [
          { type: 'text', text: 'What?' },
          { type: 'image_url', image_url: { url: 'https://example.com/img.png' } },
        ],
      }], 'glm/glm-5.2')
    ).rejects.toThrow(/provider rejected the request payload/);
  });

  it('glm/glm-5.1 returns proper structured tool_calls', async () => {
    const provider = getProvider('freetheai')!;
    mockProxy({
      ok: true,
      body: {
        id: 'x', object: 'chat.completion', created: 0, model: 'glm/glm-5.1',
        choices: [{
          index: 0, finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: 'call_-7474613017808727969',
              type: 'function',
              index: 0,
              function: { name: 'get_weather', arguments: '{"city":"Paris"}' },
            }],
          },
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    });
    const res = await provider.chatCompletion('k', [{ role: 'user', content: 'Weather in Paris?' }], 'glm/glm-5.1', {
      tools: [{ type: 'function', function: { name: 'get_weather', description: 'd', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
    });
    expect(res.choices[0].finish_reason).toBe('tool_calls');
    expect(res.choices[0].message.tool_calls?.[0].function.name).toBe('get_weather');
  });

  it('glm/glm-5.2 returns proper structured tool_calls', async () => {
    const provider = getProvider('freetheai')!;
    mockProxy({
      ok: true,
      body: {
        id: 'x', object: 'chat.completion', created: 0, model: 'glm/glm-5.2',
        choices: [{
          index: 0, finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: '',
            tool_calls: [{
              id: 'call_-7474670982687351588',
              type: 'function',
              index: 0,
              function: { name: 'get_weather', arguments: '{"city":"Tokyo"}' },
            }],
          },
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    });
    const res = await provider.chatCompletion('k', [{ role: 'user', content: 'Weather in Tokyo?' }], 'glm/glm-5.2', {
      tools: [{ type: 'function', function: { name: 'get_weather', description: 'd', parameters: { type: 'object', properties: { city: { type: 'string' } } } } }],
    });
    expect(res.choices[0].finish_reason).toBe('tool_calls');
    expect(res.choices[0].message.tool_calls?.[0].function.name).toBe('get_weather');
  });

  it('glm/glm-5.1 preserves content when it is non-empty (does not fold reasoning)', async () => {
    // When content is set (even to "GLM-4") we should NOT fold reasoning into it —
    // the user-visible answer IS the content. This matches the live API behavior.
    const provider = getProvider('freetheai')!;
    mockProxy({
      ok: true,
      body: {
        id: 'x', object: 'chat.completion', created: 0, model: 'glm/glm-5.1',
        choices: [{
          index: 0, finish_reason: 'stop',
          message: { role: 'assistant', content: 'GLM-4', reasoning_content: 'I am a GLM' },
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      },
    });
    const res = await provider.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'glm/glm-5.1');
    expect(res.choices[0].message.content).toBe('GLM-4');
  });
});
