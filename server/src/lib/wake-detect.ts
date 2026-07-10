export interface WakeHooks {
  onWake: (event: WakeEvent) => void | Promise<void>;
}

export interface WakeEvent {
  reason: 'drift' | 'signal';
  idleMs: number;
  signal?: string;
}

const TICK_MS = 5_000;
const DRIFT_THRESHOLD_MS = 30_000;

let hooks: WakeHooks | null = null;
let timer: NodeJS.Timeout | null = null;
let lastTickAt = 0;
let installed = false;

function tick(): void {
  const now = Date.now();
  if (lastTickAt > 0) {
    const drift = now - lastTickAt - TICK_MS;
    if (drift > DRIFT_THRESHOLD_MS) {
      const event: WakeEvent = { reason: 'drift', idleMs: drift };
      invokeHooks(event);
    }
  }
  lastTickAt = now;
  timer = setTimeout(tick, TICK_MS);
  if (timer.unref) timer.unref();
}

function handleSignal(name: string): void {
  const idleMs = lastTickAt > 0 ? Date.now() - lastTickAt - TICK_MS : 0;
  const event: WakeEvent = { reason: 'signal', idleMs, signal: name };
  invokeHooks(event);
  lastTickAt = Date.now();
}

function invokeHooks(event: WakeEvent): void {
  if (!hooks) return;
  try {
    Promise.resolve(hooks.onWake(event)).catch((err) => {
      console.error(`[wake-detect] onWake handler error: ${err?.message ?? err}`);
    });
  } catch (err: any) {
    console.error(`[wake-detect] onWake handler threw synchronously: ${err?.message ?? err}`);
  }
}

export function startWakeDetect(h: WakeHooks): void {
  if (installed) return;
  installed = true;
  hooks = h;
  lastTickAt = Date.now();
  timer = setTimeout(tick, TICK_MS);
  if (timer.unref) timer.unref();
  process.on('SIGCONT', () => handleSignal('SIGCONT'));
  process.on('SIGUSR1', () => handleSignal('SIGUSR1'));
  process.on('SIGUSR2', () => handleSignal('SIGUSR2'));
}

export function stopWakeDetect(): void {
  if (!installed) return;
  installed = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  process.removeAllListeners('SIGCONT');
  process.removeAllListeners('SIGUSR1');
  process.removeAllListeners('SIGUSR2');
  hooks = null;
  lastTickAt = 0;
}

export function _resetForTests(): void {
  stopWakeDetect();
  installed = false;
}
