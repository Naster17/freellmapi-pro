import type { ChatMessage } from '@freellmapi/shared/types.js';

const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 10000;
const REASONING_UNAVAILABLE = '[reasoning unavailable]';
const REPLAY_REQUIRED_PLATFORMS = new Set(['opencode']);

type Entry = { reasoning: string; seenAt: number };

const store = new Map<string, Entry>();

function prune(now: number): void {
  for (const [id, entry] of store) {
    if (now - entry.seenAt > TTL_MS) store.delete(id);
  }
  if (store.size > MAX_ENTRIES) {
    const overflow = store.size - MAX_ENTRIES;
    let dropped = 0;
    for (const id of store.keys()) {
      store.delete(id);
      if (++dropped >= overflow) break;
    }
  }
}

export function rememberToolReasoning(ids: Array<string | undefined>, reasoning: string | null | undefined): void {
  if (typeof reasoning !== 'string' || reasoning.length === 0) return;
  const now = Date.now();
  for (const id of ids) {
    if (id) store.set(id, { reasoning, seenAt: now });
  }
  prune(now);
}

export function recallToolReasoning(ids: Array<string | undefined>): string | undefined {
  for (const id of ids) {
    if (!id) continue;
    const entry = store.get(id);
    if (!entry) continue;
    if (Date.now() - entry.seenAt > TTL_MS) {
      store.delete(id);
      continue;
    }
    return entry.reasoning;
  }
  return undefined;
}

export function backfillToolCallReasoning(messages: ChatMessage[], platform: string): ChatMessage[] {
  if (!REPLAY_REQUIRED_PLATFORMS.has(platform)) return messages;
  let patched: ChatMessage[] | null = null;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'assistant') continue;
    if (typeof m.reasoning_content === 'string' && m.reasoning_content.length > 0) continue;
    if (!Array.isArray(m.tool_calls) || m.tool_calls.length === 0) continue;
    const ids = m.tool_calls.map(tc => tc?.id);
    const reasoning = recallToolReasoning(ids) ?? REASONING_UNAVAILABLE;
    if (!patched) patched = messages.slice();
    patched[i] = { ...m, reasoning_content: reasoning };
  }
  return patched ?? messages;
}

export function resetToolReasoningStore(): void {
  store.clear();
}
