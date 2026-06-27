import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenAICompatProvider } from '../../providers/openai-compat.js';
import { normalizeUsage } from '../../lib/usage-normalize.js';

const REASONING_TEXT =
  'We need to decide if phrase is Good, Acceptable, or Bad according to rules.\n\n' +
  'The phrase: "Max: Will he fly back to Seattle the day after tomorrow?" ' +
  'It\'s a quoted sentence with a colon after Max, then a question. It\'s a ' +
  'natural English sentence: a dialogue line. It\'s normal prose. It\'s a ' +
  'sentence with a colon after a name, which is typical for dialogue.';

describe('OpenAICompatProvider — reasoning/content duplication (Nvidia/Kilo)', () => {
  let provider: OpenAICompatProvider;

  beforeEach(() => {
    provider = new OpenAICompatProvider({
      platform: 'kilo',
      name: 'Kilo Gateway',
      baseUrl: 'https://api.kilo.ai/api/gateway/v1',
      keyless: true,
    });
  });

  function mockResponse(body: any) {
    vi.spyOn(global, 'fetch').mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(body),
    } as any);
  }

  it('nulls out content when it is identical to reasoning (Nvidia Kilo leak)', async () => {
    mockResponse({
      id: 'gen-1782578721',
      object: 'chat.completion',
      created: 1782578721,
      model: 'nvidia/nemotron-3-super-120b-a12b-20230311:free',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: REASONING_TEXT,
          reasoning: REASONING_TEXT,
          reasoning_details: [{ type: 'reasoning.text', text: REASONING_TEXT, format: 'unknown', index: 0 }],
        },
        finish_reason: 'length',
      }],
      usage: {
        prompt_tokens: 494,
        completion_tokens: 200,
        total_tokens: 694,
        completion_tokens_details: { reasoning_tokens: 220 },
      },
    });

    const result = await provider.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'm');
    expect(result.choices[0].message.content).toBeNull();
    expect((result.choices[0].message as any).reasoning).toBe(REASONING_TEXT);
  });

  it('nulls out content when it is identical to reasoning_content', async () => {
    mockResponse({
      id: 'gen-x',
      object: 'chat.completion',
      created: 1,
      model: 'm',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: REASONING_TEXT,
          reasoning_content: REASONING_TEXT,
        },
        finish_reason: 'length',
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });

    const result = await provider.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'm');
    expect(result.choices[0].message.content).toBeNull();
    expect((result.choices[0].message as any).reasoning_content).toBe(REASONING_TEXT);
  });

  it('does NOT dedup when content differs from reasoning (real answer preserved)', async () => {
    mockResponse({
      id: 'ok',
      object: 'chat.completion',
      created: 1,
      model: 'm',
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: 'Good',
          reasoning_content: REASONING_TEXT,
        },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });

    const result = await provider.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'm');
    expect(result.choices[0].message.content).toBe('Good');
  });

  it('does NOT dedup short content that coincidentally matches (64-char guard)', async () => {
    const short = 'Yes.';
    mockResponse({
      id: 's',
      object: 'chat.completion',
      created: 1,
      model: 'm',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: short, reasoning: short },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });

    const result = await provider.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'm');
    expect(result.choices[0].message.content).toBe(short);
  });

  it('still folds reasoning into content when content is empty (Z.ai case)', async () => {
    mockResponse({
      id: 'z',
      object: 'chat.completion',
      created: 1,
      model: 'm',
      choices: [{
        index: 0,
        message: { role: 'assistant', content: '', reasoning_content: 'actual answer' },
        finish_reason: 'stop',
      }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });

    const result = await provider.chatCompletion('k', [{ role: 'user', content: 'hi' }], 'm');
    expect(result.choices[0].message.content).toBe('actual answer');
  });
});

describe('normalizeUsage — reasoning_tokens > completion_tokens anomaly', () => {
  it('bumps completion_tokens to reasoning_tokens when reasoning exceeds completion', () => {
    const usage = {
      prompt_tokens: 494,
      completion_tokens: 200,
      total_tokens: 694,
      completion_tokens_details: { reasoning_tokens: 220 },
    };
    normalizeUsage(usage);
    expect(usage.completion_tokens).toBe(220);
    expect(usage.total_tokens).toBe(494 + 220);
  });

  it('does not change completion_tokens when reasoning_tokens <= completion_tokens', () => {
    const usage = {
      prompt_tokens: 100,
      completion_tokens: 300,
      total_tokens: 400,
      completion_tokens_details: { reasoning_tokens: 150 },
    };
    normalizeUsage(usage);
    expect(usage.completion_tokens).toBe(300);
    expect(usage.total_tokens).toBe(400);
  });

  it('maps top-level reasoning_tokens alias before the anomaly check', () => {
    const usage: any = {
      prompt_tokens: 50,
      completion_tokens: 10,
      total_tokens: 60,
      reasoning_tokens: 80,
    };
    normalizeUsage(usage);
    expect(usage.completion_tokens_details.reasoning_tokens).toBe(80);
    expect(usage.reasoning_tokens).toBeUndefined();
    expect(usage.completion_tokens).toBe(80);
    expect(usage.total_tokens).toBe(50 + 80);
  });

  it('leaves usage without reasoning_tokens untouched', () => {
    const usage = { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 };
    normalizeUsage(usage);
    expect(usage).toEqual({ prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 });
  });
});