import type { TokenUsage } from '@freellmapi/shared/types.js';
import { cachedTokensFromUsage } from '@freellmapi/shared/types.js';

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