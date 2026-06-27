import type { TokenUsage } from '@freellmapi/shared/types.js';

/**
 * Extract the cached (cache-read) prompt token count from any usage shape.
 * Returns 0 when none is present.
 */
function cachedTokensFromUsage(usage: unknown): number {
  if (!usage || typeof usage !== 'object') return 0;
  const u = usage as Record<string, any>;
  const details = u.prompt_tokens_details ?? u.prompt_cache_hit_tokens;
  if (typeof details === 'number') return details;
  if (details && typeof details === 'object' && typeof details.cached_tokens === 'number') return details.cached_tokens;
  if (typeof u.cache_read_input_tokens === 'number') return u.cache_read_input_tokens;
  return 0;
}

/**
 * Normalize a usage object from an upstream provider into the OpenAI-standard
 * shape that clients expect. Handles non-standard field names from DeepSeek,
 * Anthropic, and OpenRouter shims.
 *
 * The input object is mutated in place (and returned).
 */
export function normalizeUsage(usage: unknown): TokenUsage | undefined {
  if (!usage || typeof usage !== 'object') return usage as TokenUsage | undefined;
  const u = usage as Record<string, any>;

  // Map non-standard cache aliases into prompt_tokens_details.cached_tokens
  // when the standard field is absent. cachedTokensFromUsage already resolves
  // all three shapes; use it to compute the canonical cached count, then ensure
  // prompt_tokens_details carries it.
  if (u.prompt_tokens_details == null || u.prompt_tokens_details.cached_tokens == null) {
    const cached = cachedTokensFromUsage(u);
    if (cached > 0) {
      u.prompt_tokens_details = {
        ...(u.prompt_tokens_details ?? {}),
        cached_tokens: cached,
      };
      // Don't leave raw DeepSeek aliases lying around to confuse clients that
      // might sum prompt_tokens + prompt_cache_hit_tokens manually.
      // (Keep them for debugging? No — they're redundant once mapped. Drop.)
      delete u.prompt_cache_hit_tokens;
      delete u.prompt_cache_miss_tokens;
    }
  }

  // Map reasoning_tokens when a provider reports completion reasoning under a
  // non-standard flat alias (e.g. `reasoning_tokens` at top level, seen on some
  // OpenRouter shims) into completion_tokens_details.reasoning_tokens.
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

  // Some upstreams (Kilo routing to Nvidia Nemotron with finish_reason
  // "length") report reasoning_tokens GREATER than completion_tokens — which
  // is impossible per the OpenAI spec (reasoning_tokens is a SUBSET of
  // completion_tokens). The model exhausted max_tokens on reasoning alone;
  // the completion count under-reports the real output. Bump completion_tokens
  // up to at least reasoning_tokens and recompute total so downstream metrics
  // and billing see the correct counts.
  const rTokens = u.completion_tokens_details?.reasoning_tokens;
  if (typeof rTokens === 'number' && typeof u.completion_tokens === 'number' && rTokens > u.completion_tokens) {
    u.completion_tokens = rTokens;
    if (typeof u.prompt_tokens === 'number') u.total_tokens = u.prompt_tokens + u.completion_tokens;
  }

  // Anthropic-style cache-create/write isn't part of the OpenAI usage contract;
  // leave cache_creation_input_tokens in place for any Anthropic-route callers
  // but also promote cache_read into the standard field (already done above
  // via cachedTokensFromUsage when cache_read_input_tokens is present).

  return usage as TokenUsage;
}

/** Extract the cached token count from a usage object (any shape). */
export function cachedTokens(usage: unknown): number {
  return cachedTokensFromUsage(usage);
}

/**
 * Build the upstream `stream_options` object so streaming requests always
 * receive the final usage-only frame from the provider (without it providers
 * are free to skip the terminal usage event, leaving the proxy with no real
 * token counts to forward). Client-supplied options win over our default
 * `include_usage: true` — a client that explicitly sets `include_usage: false`
 * to suppress the usage frame gets its wish, matching OpenAI semantics.
 *
 * Used by all three streaming routes (proxy, responses, anthropic) so they
 * share one consistent policy instead of three near-duplicate inline spread
 * patterns that had subtly different override behavior (proxy allowed client
 * override, responses/anthropic silently hard-forced).
 */
export function streamOptionsWithUsage(
  stream: boolean | undefined | null,
  userOpts?: { include_usage?: boolean } | null | undefined,
): { include_usage?: boolean; [k: string]: unknown } | undefined {
  if (!stream) return (userOpts as { include_usage?: boolean; [k: string]: unknown } | undefined) ?? undefined;
  return { include_usage: true, ...(userOpts ?? {}) };
}