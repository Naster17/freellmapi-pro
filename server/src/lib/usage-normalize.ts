import type { TokenUsage } from '@freellmapi/shared/types.js';

function cachedTokensFromUsage(usage: unknown): number {
  if (!usage || typeof usage !== 'object') return 0;
  const u = usage as Record<string, any>;
  const details = u.prompt_tokens_details ?? u.prompt_cache_hit_tokens;
  if (typeof details === 'number') return details;
  if (details && typeof details === 'object' && typeof details.cached_tokens === 'number') return details.cached_tokens;
  if (typeof u.cache_read_input_tokens === 'number') return u.cache_read_input_tokens;
  return 0;
}

export function normalizeUsage(usage: unknown): TokenUsage | undefined {
  if (!usage || typeof usage !== 'object') return usage as TokenUsage | undefined;
  const u = usage as Record<string, any>;

  if (u.prompt_tokens_details == null || u.prompt_tokens_details.cached_tokens == null) {
    const cached = cachedTokensFromUsage(u);
    if (cached > 0) {
      u.prompt_tokens_details = {
        ...(u.prompt_tokens_details ?? {}),
        cached_tokens: cached,
      };
      delete u.prompt_cache_hit_tokens;
      delete u.prompt_cache_miss_tokens;
    }
  }

  if (
    (u.completion_tokens_details == null || u.completion_tokens_details.reasoning_tokens == null) &&
    typeof u.reasoning_tokens === 'number'
  ) {
    u.completion_tokens_details = {
      ...(u.completion_tokens_details ?? {}),
      reasoning_tokens: u.reasoning_tokens,
    };
    delete u.reasoning_tokens;
  }

  const rTokens = u.completion_tokens_details?.reasoning_tokens;
  if (typeof rTokens === 'number' && typeof u.completion_tokens === 'number' && rTokens > u.completion_tokens) {
    u.completion_tokens = rTokens;
    if (typeof u.prompt_tokens === 'number') u.total_tokens = u.prompt_tokens + u.completion_tokens;
  }

  return usage as TokenUsage;
}

export function cachedTokens(usage: unknown): number {
  return cachedTokensFromUsage(usage);
}

export function streamOptionsWithUsage(
  stream: boolean | undefined | null,
  userOpts?: { include_usage?: boolean } | null | undefined,
): { include_usage?: boolean; [k: string]: unknown } | undefined {
  if (!stream) return (userOpts as { include_usage?: boolean; [k: string]: unknown } | undefined) ?? undefined;
  return { include_usage: true, ...(userOpts ?? {}) };
}