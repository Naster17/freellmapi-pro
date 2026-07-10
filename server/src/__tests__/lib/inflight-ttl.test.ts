import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  reserveKeySlot,
  releaseKeySlot,
  keyInflightCount,
  canUseKeyConcurrency,
  resetAllInflight,
} from '../../services/ratelimit.js';

describe('inflight TTL after sleep', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetAllInflight();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns 0 for a key that has no slot reserved', () => {
    expect(keyInflightCount('groq', 1)).toBe(0);
    expect(canUseKeyConcurrency('groq', 1)).toBe(true);
  });

  it('increments and decrements correctly within TTL window', () => {
    reserveKeySlot('groq', 1);
    reserveKeySlot('groq', 1);
    expect(keyInflightCount('groq', 1)).toBe(2);
    releaseKeySlot('groq', 1);
    expect(keyInflightCount('groq', 1)).toBe(1);
    releaseKeySlot('groq', 1);
    expect(keyInflightCount('groq', 1)).toBe(0);
  });

  it('treats a stale slot as zero after 60s of wall-clock drift (simulates post-sleep recovery)', () => {
    reserveKeySlot('groq', 1);
    expect(keyInflightCount('groq', 1)).toBe(1);
    expect(canUseKeyConcurrency('groq', 1)).toBe(false);

    vi.advanceTimersByTime(61_000);

    expect(keyInflightCount('groq', 1)).toBe(0);
    expect(canUseKeyConcurrency('groq', 1)).toBe(true);
  });

  it('resetAllInflight clears everything immediately', () => {
    reserveKeySlot('groq', 1);
    reserveKeySlot('cerebras', 2);
    resetAllInflight();
    expect(keyInflightCount('groq', 1)).toBe(0);
    expect(keyInflightCount('cerebras', 2)).toBe(0);
  });

  it('respects maxConcurrentPerKey cap of 0 (disabled)', () => {
    const prev = process.env.MAX_CONCURRENT_REQUESTS_PER_KEY_GROQ;
    process.env.MAX_CONCURRENT_REQUESTS_PER_KEY_GROQ = '0';
    try {
      reserveKeySlot('groq', 1);
      expect(canUseKeyConcurrency('groq', 1)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.MAX_CONCURRENT_REQUESTS_PER_KEY_GROQ;
      else process.env.MAX_CONCURRENT_REQUESTS_PER_KEY_GROQ = prev;
    }
  });
});

