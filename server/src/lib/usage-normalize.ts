import type { TokenUsage } from '@freellmapi/shared/types.js';

/**
 * Extract the cached (cache-read) prompt token count from any usage shape:
 * the OpenAI-standard prompt_tokens_details.cached_tokens, or non-standard
 * aliases some providers emit (DeepSeek prompt_cache_hit_tokens, Anthropic
 * cache_read_input_tokens). Returns 0 when none is present.
 *
 * Inlined here (also exported from shared/types.ts for TS consumers) because
 * the shared workspace package can't be resolved at runtime inside Docker —
 * its package.json "main" points to a .ts file which Node can't load.
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
 * Normalize a usage object returned by an upstream OpenAI-compatible provider
 * into the OpenAI-standard shape that clients (OpenCode's AI SDK) expect.
 *
 * Handles non-standard field names observed in the wild:
 *  - DeepSeek native API emits `prompt_cache_hit_tokens` / `prompt_cache_miss_tokens`
 *    (a flat top-level number) instead of the OpenAI-standard
 *    `prompt_tokens_details.cached_tokens`. OpenCode reads only the standard
 *    shape, so without remapping the "cached" metric stays 0 even when the
 *    provider is genuinely serving cached prefixes.
 *  - Some OpenRouter-style shims surface cache info under `cache_read_input_tokens`
 *    / `cache_creation_input_tokens` (Anthropic naming) — folded in too.
 *
 * Mirrors normalizeChoices() for content: the input object is mutated in place
 * (and returned) so callers can keep passing the same chunk reference downstream.
 * Unknown/missing fields are left untouched; only the standard aliases are added
 * so existing clients that already read the standard shape keep working.
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