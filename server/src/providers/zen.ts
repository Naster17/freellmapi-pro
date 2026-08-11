import { OpenAICompatProvider } from './openai-compat.js';
import {
  currentZenIp,
  isZenKeylessMode,
  markZenIpExhausted,
  rotateZenIp,
  ZEN_NO_KEY,
} from '../services/zen-keyless.js';
import type { KeyValidationResult } from './base.js';

const ROTATE_ON_STATUSES = new Set([401, 402, 403, 429]);

export class ZenProvider extends OpenAICompatProvider {
  constructor() {
    super({
      platform: 'opencode',
      name: 'OpenCode Zen',
      baseUrl: 'https://opencode.ai/zen/v1',
    });
  }

  protected override authHeader(apiKey: string): Record<string, string> {
    if (isZenKeylessMode()) return {};
    return { 'Authorization': `Bearer ${apiKey}` };
  }

  protected override dynamicHeaders(_apiKey: string): Record<string, string> {
    if (!isZenKeylessMode()) return {};
    const ip = currentZenIp();
    return ip === null ? {} : { 'X-Real-IP': ip };
  }

  protected override onUpstreamError(status: number): void {
    if (!isZenKeylessMode()) return;
    if (status >= 500 || ROTATE_ON_STATUSES.has(status)) {
      markZenIpExhausted();
      rotateZenIp();
    }
  }

  override async validateKey(apiKey: string): Promise<KeyValidationResult> {
    if (isZenKeylessMode() || apiKey === ZEN_NO_KEY) return true;
    return super.validateKey(apiKey);
  }
}
