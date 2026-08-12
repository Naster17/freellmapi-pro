import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  reserveKeySlot,
  releaseKeySlot,
  inFlightForKey,
  canUseKeyConcurrency,
  resetAllInflight,
} from '../../services/ratelimit.js';

describe('inflight slot TTL after sleep', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetAllInflight();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns 0 for a key that has no slot reserved', () => {
    expect(inFlightForKey('groq', 1)).toBe(0);
    expect(canUseKeyConcurrency('groq', 1)).toBe(true);
  });

  it('increments and decrements correctly within TTL window', () => {
    reserveKeySlot('groq', 1);
    reserveKeySlot('groq', 1);
    expect(inFlightForKey('groq', 1)).toBe(2);
    releaseKeySlot('groq', 1);
    expect(inFlightForKey('groq', 1)).toBe(1);
    releaseKeySlot('groq', 1);
    expect(inFlightForKey('groq', 1)).toBe(0);
  });

  it('treats a stale slot as zero after the lease age bound (simulates post-sleep recovery)', () => {
    reserveKeySlot('groq', 1);
    expect(inFlightForKey('groq', 1)).toBe(1);
    expect(canUseKeyConcurrency('groq', 1)).toBe(false);

    vi.advanceTimersByTime(3 * 60 * 1000);

    expect(inFlightForKey('groq', 1)).toBe(0);
    expect(canUseKeyConcurrency('groq', 1)).toBe(true);
  });

  it('resetAllInflight clears everything immediately', () => {
    reserveKeySlot('groq', 1);
    reserveKeySlot('cerebras', 2);
    resetAllInflight();
    expect(inFlightForKey('groq', 1)).toBe(0);
    expect(inFlightForKey('cerebras', 2)).toBe(0);
  });

  it('respects the per-key concurrency cap and frees it on release', () => {
    const prev = process.env.MAX_CONCURRENT_REQUESTS_PER_KEY_GROQ;
    process.env.MAX_CONCURRENT_REQUESTS_PER_KEY_GROQ = '2';
    try {
      reserveKeySlot('groq', 1);
      reserveKeySlot('groq', 1);
      expect(inFlightForKey('groq', 1)).toBe(2);
      expect(canUseKeyConcurrency('groq', 1)).toBe(false);

      releaseKeySlot('groq', 1);
      expect(canUseKeyConcurrency('groq', 1)).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.MAX_CONCURRENT_REQUESTS_PER_KEY_GROQ;
      else process.env.MAX_CONCURRENT_REQUESTS_PER_KEY_GROQ = prev;
    }
  });
});