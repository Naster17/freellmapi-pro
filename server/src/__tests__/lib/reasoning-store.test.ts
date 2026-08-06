import { describe, it, expect, beforeEach } from 'vitest';
import {
  rememberToolReasoning,
  recallToolReasoning,
  backfillToolCallReasoning,
  resetToolReasoningStore,
} from '../../lib/reasoning-store.js';
import type { ChatMessage } from '@freellmapi/shared/types.js';

const toolTurn = (id: string, reasoning?: string): ChatMessage => ({
  role: 'assistant',
  content: null,
  tool_calls: [{ id, type: 'function' as const, function: { name: 'read', arguments: '{}' } }],
  ...(reasoning ? { reasoning_content: reasoning } : {}),
});

describe('reasoning-store', () => {
  beforeEach(() => {
    resetToolReasoningStore();
  });

  it('recalls reasoning by tool call id', () => {
    rememberToolReasoning(['call_1', 'call_2'], 'thinking hard');
    expect(recallToolReasoning(['nope', 'call_2'])).toBe('thinking hard');
    expect(recallToolReasoning(['unknown'])).toBeUndefined();
  });

  it('ignores empty reasoning', () => {
    rememberToolReasoning(['call_1'], '');
    rememberToolReasoning(['call_2'], null);
    rememberToolReasoning(['call_3'], undefined);
    expect(recallToolReasoning(['call_1', 'call_2', 'call_3'])).toBeUndefined();
  });

  it('backfill returns the same array untouched for platforms without the replay rule', () => {
    const msgs = [toolTurn('call_x')];
    const out = backfillToolCallReasoning(msgs, 'groq');
    expect(out).toBe(msgs);
    expect(out[0].reasoning_content).toBeUndefined();
  });

  it('backfill injects cached reasoning on opencode tool turns', () => {
    rememberToolReasoning(['call_zen'], 'cached chain of thought');
    const out = backfillToolCallReasoning([toolTurn('call_zen')], 'opencode');
    expect(out[0].reasoning_content).toBe('cached chain of thought');
  });

  it('backfill falls back to a placeholder for turns the proxy never saw', () => {
    const out = backfillToolCallReasoning([toolTurn('call_foreign')], 'opencode');
    expect(out[0].reasoning_content).toBe('[reasoning unavailable]');
  });

  it('backfill leaves reasoning-carrying turns alone', () => {
    const out = backfillToolCallReasoning([toolTurn('call_a', 'real reasoning')], 'opencode');
    expect(out[0].reasoning_content).toBe('real reasoning');
  });

  it('backfill skips non-tool assistant turns', () => {
    const plain: ChatMessage = { role: 'assistant', content: 'hello' };
    const msgs = [plain];
    const out = backfillToolCallReasoning(msgs, 'opencode');
    expect(out).toBe(msgs);
    expect(out[0].reasoning_content).toBeUndefined();
  });

  it('does not mutate caller messages', () => {
    const original = toolTurn('call_y');
    backfillToolCallReasoning([original], 'opencode');
    expect(original.reasoning_content).toBeUndefined();
  });
});
