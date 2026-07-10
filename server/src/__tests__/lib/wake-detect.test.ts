import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startWakeDetect, stopWakeDetect, _resetForTests } from '../../lib/wake-detect.js';
import type { WakeEvent } from '../../lib/wake-detect.js';

describe('wake-detect', () => {
  beforeEach(() => {
    _resetForTests();
  });

  afterEach(() => {
    stopWakeDetect();
    _resetForTests();
  });

  it('installs idempotently (no double-registration)', () => {
    const onWake = vi.fn();
    startWakeDetect({ onWake });
    startWakeDetect({ onWake });
    const listeners = process.listenerCount('SIGCONT');
    expect(listeners).toBe(1);
  });

  it('unregisters all signal listeners on stop', () => {
    startWakeDetect({ onWake: vi.fn() });
    expect(process.listenerCount('SIGCONT')).toBe(1);
    expect(process.listenerCount('SIGUSR1')).toBe(1);
    expect(process.listenerCount('SIGUSR2')).toBe(1);
    stopWakeDetect();
    expect(process.listenerCount('SIGCONT')).toBe(0);
    expect(process.listenerCount('SIGUSR1')).toBe(0);
    expect(process.listenerCount('SIGUSR2')).toBe(0);
  });

  it('does not retain a WakeHooks reference after stop', () => {
    const onWake = vi.fn();
    startWakeDetect({ onWake });
    stopWakeDetect();
    process.emit('SIGCONT' as any);
    expect(onWake).not.toHaveBeenCalled();
  });

  it('handles onWake throwing by logging and continuing (does not crash)', () => {
    const onWake = vi.fn(() => { throw new Error('boom'); });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    startWakeDetect({ onWake });
    process.emit('SIGCONT' as any);
    expect(onWake).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
