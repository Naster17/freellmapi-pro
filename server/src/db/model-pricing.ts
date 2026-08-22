import type { Db } from './types.js';

/**
 * Paid-equivalent pricing per model: what the SAME model (or its nearest
 * equivalent) costs per million tokens on paid APIs. Used by the analytics
 * "Est. savings" stat so it reflects realistic savings rather than pricing
 * every token like a frontier model.
 *
 * Source: OpenRouter public pricing API (paid, non-:free variants) and
 * official provider rate cards, snapshot 2026-08-13; closed models use their
 * official API prices. `null` = no paid equivalent exists (stealth/preview or
 * free-only models) — analytics falls back to a modest default.
 *
 * Format: [platform, model_id, $/M input, $/M output, $/M cached input].
 * Cached = the provider's cache-read price where published; `null` rows fall
 * back to the global CACHE_READ_PRICE_FACTOR applied to the input price.
 */
type PricingRow = [string, string, number | null, number | null, number | null];

export const MODEL_PRICING: PricingRow[] = [
  // Aion Labs (OpenRouter paid listings)
  ['aion', 'aion-labs/aion-2.0', 0.80, 1.60, null],
  ['aion', 'aion-labs/aion-2.5', null, null, null],
  ['aion', 'aion-labs/aion-3.0', 3.00, 6.00, null],
  ['aion', 'aion-labs/aion-3.0-mini', 0.70, 1.40, null],
  ['aion', 'aion-labs/aion-rp-llama-3.1-8b', 0.80, 1.60, null],

  // Agnes AI (proprietary, no paid API)
  ['agnes', 'agnes-1.5-flash', null, null, null],
  ['agnes', 'agnes-2.0-flash', null, null, null],

  // AI Horde (crowdsourced compute, no paid equivalent)
  ['aihorde', 'aphrodite/TheDrummer/Cydonia-24B-v4.3', null, null, null],

  // AINative Studio
  ['ainative', 'llama-4-maverick', 0.20, 0.696, null],
  ['ainative', 'qwen3-14b', 0.12, 0.24, null],
  ['ainative', 'qwen3-32b', 0.08, 0.28, null],
  ['ainative', 'qwen3-8b', 0.117, 0.455, null],

  // BazaarLink (aggregator, no paid equivalent)
  ['bazaarlink', 'auto:free', null, null, null],

  // Cerebras
  ['cerebras', 'gpt-oss-120b', 0.03, 0.17, null],
  ['cerebras', 'gemma-4-31b', 0.10, 0.34, null],
  ['cerebras', 'zai-glm-4.7', 0.40, 1.75, 0.11],
  // legacy ids (older DBs)
  ['cerebras', 'llama3.1-8b', 0.05, 0.08, null],
  ['cerebras', 'qwen-3-235b-a22b-instruct-2507', 0.071, 0.10, null],
  ['cerebras', 'qwen-3-coder-480b', 0.22, 1.80, null],
  ['cerebras', 'llama-4-maverick-17b-128e-instruct', 0.15, 0.60, null],
  ['cerebras', 'qwen3-235b', 0.455, 1.82, null],

  // Cloudflare Workers AI
  ['cloudflare', '@cf/google/gemma-4-26b-a4b-it', 0.12, 0.40, null],
  ['cloudflare', '@cf/ibm-granite/granite-4.0-h-micro', 0.017, 0.112, null],
  ['cloudflare', '@cf/meta/llama-3.3-70b-instruct-fp8-fast', 0.10, 0.32, null],
  ['cloudflare', '@cf/meta/llama-4-scout-17b-16e-instruct', 0.10, 0.30, null],
  ['cloudflare', '@cf/moonshotai/kimi-k2.6', 0.95, 4.00, 0.16],
  ['cloudflare', '@cf/nvidia/nemotron-3-120b-a12b', 0.085, 0.40, null],
  ['cloudflare', '@cf/openai/gpt-oss-120b', 0.03, 0.17, null],
  ['cloudflare', '@cf/openai/gpt-oss-20b', 0.03, 0.13, null],
  ['cloudflare', '@cf/qwen/qwen3-30b-a3b-fp8', 0.09, 0.45, null],
  ['cloudflare', '@cf/zai-org/glm-4.7-flash', 0.06, 0.40, 0.11],
  // legacy ids (older DBs)
  ['cloudflare', '@cf/deepseek-ai/deepseek-r1-distill-qwen-32b', 0.29, 0.29, null],
  ['cloudflare', '@cf/meta/llama-3.1-70b-instruct', 0.40, 0.40, null],

  // Cohere (official API prices; Reasoning shares Command A pricing)
  ['cohere', 'command-a-03-2025', 2.50, 10.00, null],
  ['cohere', 'command-a-reasoning-08-2025', 2.50, 10.00, null],
  ['cohere', 'command-r-08-2024', 0.15, 0.60, null],
  ['cohere', 'command-r-plus-08-2024', 2.50, 10.00, null],
  ['cohere', 'command-a-plus-05-2026', 2.50, 10.00, null],
  ['cohere', 'command-a-vision-07-2025', 2.50, 10.00, null],
  ['cohere', 'command-r7b-12-2024', 0.0375, 0.15, null],
  ['cohere', 'c4ai-aya-expanse-32b', 0.50, 1.50, null],
  ['cohere', 'c4ai-aya-vision-32b', 0.50, 1.50, null],
  // free-only on Cohere hosted endpoints
  ['cohere', 'north-mini-code-1-0', null, null, null],

  // FreeTheAi relays (priced at the underlying model's paid rate)
  ['freetheai', 'bbl/gemini-2.5-flash-lite', 0.10, 0.40, 0.025],
  ['freetheai', 'bbl/gemini-3.0-flash', 0.50, 3.00, null],
  ['freetheai', 'bbl/gemini-3.1-flash-lite', 0.25, 1.50, 0.0625],
  ['freetheai', 'bbl/gemini-3.5-flash', 1.50, 9.00, 0.375],
  ['freetheai', 'bbl/gpt-5.5-mini', 0.90, 5.50, 0.225],
  ['freetheai', 'bbl/grok-4.1-fast-non-reasoning', 0.20, 0.50, 0.05],
  ['freetheai', 'glm/glm-4.5', 0.60, 2.20, 0.11],
  ['freetheai', 'glm/glm-4.5-air', 0.13, 0.85, 0.03],
  ['freetheai', 'glm/glm-4.6', 0.60, 2.20, 0.11],
  ['freetheai', 'glm/glm-4.7', 0.40, 1.75, 0.11],
  ['freetheai', 'glm/glm-5.1', 1.40, 4.40, 0.26],
  ['freetheai', 'glm/glm-5.2', 0.50, 3.15, 0.26],
  ['freetheai', 'kai/nvidia/nemotron-3-super-120b-a12b:free', 0.085, 0.40, null],
  ['freetheai', 'kai/openrouter/free', null, null, null],
  ['freetheai', 'kai/poolside/laguna-xs-2.1:free', null, null, null],
  ['freetheai', 'kai/stepfun/step-3.7-flash:free', 0.20, 1.15, 0.04],
  ['freetheai', 'mim/mimo-v2.5', 0.14, 0.28, null],
  ['freetheai', 'mim/mimo-v2.5-pro', 0.435, 0.87, null],
  ['freetheai', 'min/minimax-m3', 0.30, 1.20, 0.06],
  ['freetheai', 'olm/deepseek-v4-pro', 0.435, 0.87, 0.0036],
  ['freetheai', 'opc/deepseek-v4-flash-free', 0.14, 0.28, 0.0028],
  ['freetheai', 'opc/mimo-v2.5-free', 0.14, 0.28, null],
  ['freetheai', 'opc/north-mini-code-free', null, null, null],
  ['freetheai', 'vova/gpt-5.5', 5.00, 30.00, 1.25],
  ['freetheai', 'vova/kimi-k2.5', 0.60, 3.00, 0.1],
  ['freetheai', 'vova/kimi-k2.7-code', 0.95, 4.00, 0.19],
  ['freetheai', 'vova/mimo-v2.5', 0.14, 0.28, null],
  ['freetheai', 'vova/mimo-v2.5-pro', 0.435, 0.87, null],
  ['freetheai', 'vova/mimo-v2.5-pro-ultraspeed', 0.435, 0.87, null],
  ['freetheai', 'vova/minimax-m2.7', 0.30, 1.20, 0.06],

  // g4f.space relays (priced at the underlying model's paid rate)
  ['g4f', 'claude-opus-4-6-thinking', 5.00, 25.00, 0.5],
  ['g4f', 'claude-sonnet-4-6', 3.00, 15.00, 0.3],
  ['g4f', 'deepseek-v4-pro', 0.435, 0.87, 0.0036],
  ['g4f', 'gemini-3.1-flash-lite', 0.25, 1.50, 0.0625],
  ['g4f', 'glm-5.1', 1.40, 4.40, 0.26],
  ['g4f', 'gpt-4o-mini', 0.15, 0.60, 0.0375],
  ['g4f', 'gpt-5.4', 2.50, 15.00, 0.625],
  ['g4f', 'gpt-5.5', 5.00, 30.00, 1.25],
  ['g4f', 'gpt-oss-120b', 0.03, 0.17, null],
  ['g4f', 'kimi-k2.6', 0.95, 4.00, 0.16],
  ['g4f', 'kimi-k2.7-code', 0.95, 4.00, 0.19],
  ['g4f', 'minimaxai/minimax-m3', 0.30, 1.20, 0.06],
  ['g4f', 'openai/gpt-5', 1.25, 10.00, 0.3125],
  ['g4f', 'qwen-coder', 0.22, 1.80, null],
  ['g4f', 'qwen3.6-plus', 0.325, 1.95, null],
  ['g4f', 'qwen3.7-max', 1.475, 4.425, null],
  ['g4f', 'zai-org/GLM-5.1', 1.40, 4.40, 0.26],
  ['g4f', 'zai-org/GLM-5.2', 0.50, 3.15, 0.26],

  // GitHub Models (OpenAI official prices)
  ['github', 'gpt-4o', 2.50, 10.00, 0.625],
  ['github', 'openai/gpt-4.1', 2.00, 8.00, 0.5],
  ['github', 'openai/gpt-5', 1.25, 10.00, 0.3125], // legacy

  // Google AI Studio (official prices)
  ['google', 'gemini-2.5-flash', 0.30, 2.50, 0.075],
  ['google', 'gemini-2.5-flash-lite', 0.10, 0.40, 0.025],
  ['google', 'gemini-2.5-pro', 1.25, 10.00, 0.3125], // legacy
  ['google', 'gemini-3-flash-preview', 0.50, 3.00, 0.125],
  ['google', 'gemini-3.1-flash-lite', 0.25, 1.50, 0.0625],
  ['google', 'gemini-3.1-flash-lite-preview', 0.25, 1.50, 0.0625], // legacy (GA sibling priced identically)
  ['google', 'gemini-3.1-pro-preview', 2.00, 12.00, 0.5], // legacy
  ['google', 'gemini-3.5-flash', 1.50, 9.00, 0.375],
  ['google', 'gemma-4-26b-a4b-it', 0.12, 0.40, null],
  ['google', 'gemma-4-31b-it', 0.10, 0.34, null],
  // audio modality, no text token rate card
  ['google', 'gemini-2.5-flash-preview-tts', null, null, null],

  // Groq (compound is an agentic pipeline — estimated at its underlying
  // gpt-oss models' prices)
  ['groq', 'groq/compound', 0.03, 0.17, null],
  ['groq', 'groq/compound-mini', 0.03, 0.13, null],
  ['groq', 'allam-2-7b', 0.05, 0.15, null],
  ['groq', 'llama-3.3-70b-versatile', 0.10, 0.32, null],
  ['groq', 'meta-llama/llama-4-scout-17b-16e-instruct', 0.10, 0.30, null],
  ['groq', 'openai/gpt-oss-120b', 0.03, 0.17, null],
  ['groq', 'openai/gpt-oss-20b', 0.03, 0.13, null],
  ['groq', 'openai/gpt-oss-safeguard-20b', 0.075, 0.30, null],
  ['groq', 'qwen/qwen3-32b', 0.08, 0.28, null],
  ['groq', 'qwen/qwen3.6-27b', 0.60, 3.00, null], // Groq list price
  // legacy ids (older DBs)
  ['groq', 'llama-3.1-8b-instant', 0.05, 0.08, null],
  ['groq', 'llama-4-scout-17b-16e-instruct', 0.10, 0.30, null],

  // Hugging Face Inference
  ['huggingface', 'Qwen/Qwen3-Coder-Next', 0.12, 0.80, null],
  ['huggingface', 'deepseek-ai/DeepSeek-V4-Flash', 0.14, 0.28, 0.0028],
  ['huggingface', 'moonshotai/Kimi-K2.6', 0.95, 4.00, 0.16],
  ['huggingface', 'accounts/fireworks/models/llama-v3p3-70b-instruct', 0.10, 0.32, null], // legacy

  // Kilo (Poolside Laguna is stealth — no paid equivalent)
  ['kilo', 'cohere/north-mini-code:free', null, null, null],
  ['kilo', 'kilo-auto/free', null, null, null],
  ['kilo', 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', 0.05, 0.20, null],
  ['kilo', 'nvidia/nemotron-3-super-120b-a12b:free', 0.085, 0.40, null],
  ['kilo', 'nvidia/nemotron-3-ultra-550b-a55b:free', 0.60, 3.60, null],
  ['kilo', 'nvidia/nemotron-3.5-content-safety:free', null, null, null],
  ['kilo', 'openrouter/free', null, null, null],
  ['kilo', 'poolside/laguna-m.1:free', null, null, null],
  ['kilo', 'poolside/laguna-xs.2:free', null, null, null],
  ['kilo', 'poolside/laguna-xs-2.1:free', null, null, null],
  ['kilo', 'stepfun/step-3.7-flash:free', 0.20, 1.15, 0.04],

  // LLM7
  ['llm7', 'codestral-latest', 0.30, 0.90, 0.03],

  // Modal shared endpoints (official $/MTok: prompt, completion, cached prompt).
  // Kimi K3: $3.00 / $15.00 / $0.30; Qwen3.8-2.4T-A95B: $2.00 / $6.00 / $0.25.
  // These are the REAL metered prices — the /usage dollar meter reads them from
  // the models table to compute per-key spend against the $30/30d budget.
  ['modal', 'moonshotai/Kimi-K3', 3.00, 15.00, 0.30],
  ['modal', 'Qwen/Qwen3.8-2.4T-A95B', 2.00, 6.00, 0.25],

  // Mistral (official La Plateforme prices; Magistral per official page)
  ['mistral', 'codestral-latest', 0.30, 0.90, 0.03],
  ['mistral', 'devstral-latest', 0.40, 2.00, 0.04],
  ['mistral', 'magistral-medium-latest', 2.00, 5.00, 0.2],
  ['mistral', 'ministral-8b-latest', 0.15, 0.15, 0.015],
  ['mistral', 'mistral-large-latest', 0.50, 1.50, 0.05],
  ['mistral', 'mistral-medium-latest', 1.50, 7.50, 0.15],
  ['mistral', 'mistral-small-latest', 0.15, 0.60, 0.015],
  ['mistral', 'devstral-medium-latest', 0.40, 2.00, 0.04],
  // alias resolves to Mistral Small 4 after Magistral Small retirement
  ['mistral', 'magistral-small-latest', 0.15, 0.60, 0.015],
  ['mistral', 'ministral-14b-latest', 0.20, 0.20, 0.02],
  // aliases resolve to Devstral 2 and Codestral respectively
  ['mistral', 'mistral-code-agent-latest', 0.40, 2.00, 0.04],
  ['mistral', 'mistral-code-latest', 0.30, 0.90, 0.03],
  // subscription product, no per-token rate
  ['mistral', 'mistral-vibe-cli-fast', null, null, null],

  // Moonshot / MiniMax (legacy platforms, may exist in older DBs)
  ['moonshot', 'kimi-latest', 3.00, 15.00, 0.3],
  ['minimax', 'MiniMax-M1', 0.55, 2.20, null],

  // NaraRouter relays
  ['nara', 'mistral-large', 0.50, 1.50, 0.05],
  ['nara', 'mistral-medium-3-5', 1.50, 7.50, 0.15],

  // NVIDIA NIM
  ['nvidia', 'deepseek-ai/deepseek-v4-flash', 0.14, 0.28, 0.0028],
  ['nvidia', 'deepseek-ai/deepseek-v4-pro', 0.435, 0.87, 0.0036],
  ['nvidia', 'google/gemma-4-31b-it', 0.10, 0.34, null],
  ['nvidia', 'meta/llama-3.1-70b-instruct', 0.40, 0.40, null],
  ['nvidia', 'meta/llama-3.3-70b-instruct', 0.10, 0.32, null],
  ['nvidia', 'meta/llama-4-maverick-17b-128e-instruct', 0.20, 0.696, null],
  ['nvidia', 'minimaxai/minimax-m2.7', 0.30, 1.20, 0.06],
  ['nvidia', 'minimaxai/minimax-m3', 0.30, 1.20, 0.06],
  ['nvidia', 'mistralai/mistral-large-3-675b-instruct-2512', 0.50, 1.50, 0.05],
  ['nvidia', 'moonshotai/kimi-k2.6', 0.95, 4.00, 0.16],
  ['nvidia', 'nvidia/nemotron-3-nano-30b-a3b', 0.05, 0.20, null],
  ['nvidia', 'nvidia/nemotron-3-super-120b-a12b', 0.085, 0.40, null],
  ['nvidia', 'nvidia/nemotron-3-ultra-550b-a55b', 0.60, 3.60, null],
  ['nvidia', 'qwen/qwen3-coder-480b-a35b-instruct', 0.22, 1.80, null],
  ['nvidia', 'stepfun-ai/step-3.7-flash', 0.20, 1.15, 0.04],
  ['nvidia', 'z-ai/glm-5.1', 1.40, 4.40, 0.26],
  ['nvidia', 'z-ai/glm-5.2', 0.50, 3.15, 0.26],
  // free-tier-only on NIM, no paid variant
  ['nvidia', 'nvidia/llama-3.3-nemotron-super-49b-v1.5', null, null, null],
  ['nvidia', 'nvidia/nemotron-nano-12b-v2-vl', null, null, null],

  // Ollama (local models priced at their cloud-API equivalents — that's
  // what running them elsewhere would cost)
  ['ollama', 'cogito-2.1:671b', 1.25, 1.25, null],
  ['ollama', 'deepseek-v3.2', 0.229, 0.343, null], // legacy
  ['ollama', 'devstral-2:123b', 0.40, 2.00, 0.04],
  ['ollama', 'gemma4:31b', 0.10, 0.34, null],
  ['ollama', 'glm-4.7', 0.40, 1.75, 0.11],
  ['ollama', 'gpt-oss:120b', 0.03, 0.17, null],
  ['ollama', 'gpt-oss:20b', 0.03, 0.13, null],
  ['ollama', 'kimi-k2-thinking', 0.60, 2.50, 0.15],
  ['ollama', 'mistral-large-3:675b', 0.50, 1.50, 0.05],
  ['ollama', 'qwen3-coder-next', 0.12, 0.80, null],
  ['ollama', 'qwen3-coder:480b', 0.22, 1.80, null],

  // OpenCode Zen (big-pickle, laguna and hy3 are stealth — no equivalent)
  ['opencode', 'big-pickle', null, null, null],
  ['opencode', 'deepseek-v4-flash-free', 0.14, 0.28, 0.0028],
  ['opencode', 'hy3-free', null, null, null],
  ['opencode', 'laguna-s-2.1-free', null, null, null],
  ['opencode', 'ling-3.0-flash-free', 0.021, 0.063, null],
  ['opencode', 'mimo-v2.5-free', 0.14, 0.28, null],
  ['opencode', 'minimax-m3-free', 0.30, 1.20, 0.06],
  ['opencode', 'nemotron-3-super-free', 0.085, 0.40, null],
  ['opencode', 'nemotron-3-ultra-free', 0.60, 3.60, null],
  ['opencode', 'north-mini-code-free', null, null, null],
  ['opencode', 'x-preview-f-free', null, null, null],

  // OpenRouter :free pools (priced at the same model's paid variant)
  // Snapshot of the OpenRouter pricing API on 2026-08-13.
  ['openrouter', 'cognitivecomputations/dolphin-mistral-24b-venice-edition:free', 0.20, 0.90, null],
  ['openrouter', 'google/gemma-4-26b-a4b-it:free', 0.12, 0.40, null],
  ['openrouter', 'google/gemma-4-31b-it:free', 0.10, 0.34, null],
  ['openrouter', 'meta-llama/llama-3.2-3b-instruct:free', 0.05, 0.33, null],
  ['openrouter', 'moonshotai/kimi-k2.6:free', 0.95, 4.00, 0.16],
  ['openrouter', 'nvidia/nemotron-3-ultra-550b-a55b:free', 0.60, 3.60, null],
  ['openrouter', 'nvidia/nemotron-nano-12b-v2-vl:free', null, null, null], // no paid variant listed
  // LFM 2.5 1.2B has no paid listing; tiny-model estimate
  ['openrouter', 'liquid/lfm-2.5-1.2b-instruct:free', 0.01, 0.04, null],
  ['openrouter', 'liquid/lfm-2.5-1.2b-thinking:free', 0.01, 0.04, null],
  ['openrouter', 'meta-llama/llama-3.3-70b-instruct:free', 0.10, 0.32, null],
  ['openrouter', 'nousresearch/hermes-3-llama-3.1-405b:free', 1.00, 1.00, null],
  ['openrouter', 'nvidia/nemotron-3-nano-30b-a3b:free', 0.05, 0.20, null],
  ['openrouter', 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', 0.05, 0.20, null],
  ['openrouter', 'nvidia/nemotron-3-super-120b-a12b:free', 0.085, 0.40, null],
  ['openrouter', 'nvidia/nemotron-nano-9b-v2:free', 0.04, 0.16, null],
  ['openrouter', 'openai/gpt-oss-120b:free', 0.03, 0.17, null],
  ['openrouter', 'openai/gpt-oss-20b:free', 0.03, 0.13, null],
  ['openrouter', 'qwen/qwen3-coder:free', 0.22, 1.80, null],
  ['openrouter', 'qwen/qwen3-next-80b-a3b-instruct:free', 0.09, 1.10, null],
  ['openrouter', 'z-ai/glm-4.5-air:free', 0.13, 0.85, 0.03],
  // stealth or free-only routes
  ['openrouter', 'openrouter/owl-alpha', null, null, null],
  ['openrouter', 'poolside/laguna-m.1:free', null, null, null],
  ['openrouter', 'poolside/laguna-xs.2:free', null, null, null],
  ['openrouter', 'poolside/laguna-xs-2.1:free', null, null, null],
  ['openrouter', 'cohere/north-mini-code:free', null, null, null],
  ['openrouter', 'nvidia/nemotron-3.5-content-safety:free', null, null, null],
  // legacy ids
  ['openrouter', 'deepseek/deepseek-v3.1:free', 0.21, 0.79, null],
  ['openrouter', 'moonshotai/kimi-k2:free', 0.60, 2.50, 0.15],

  // OVH AI Endpoints (open-weight models, priced at the same model's
  // mainstream paid hosting)
  ['ovh', 'Meta-Llama-3_3-70B-Instruct', 0.10, 0.32, null],
  ['ovh', 'Mistral-7B-Instruct-v0.3', 0.06, 0.20, null],
  ['ovh', 'Mistral-Nemo-Instruct-2407', 0.019, 0.03, null],
  ['ovh', 'Mistral-Small-3.2-24B-Instruct-2506', 0.0938, 0.25, 0.015],
  ['ovh', 'Qwen2.5-VL-72B-Instruct', 0.25, 0.75, null],
  ['ovh', 'Qwen3-32B', 0.08, 0.28, null],
  ['ovh', 'Qwen3-Coder-30B-A3B-Instruct', 0.07, 0.28, null],
  ['ovh', 'Qwen3.5-397B-A17B', 0.45, 3.00, null],
  ['ovh', 'Qwen3.6-27B', 0.60, 3.00, null],
  ['ovh', 'gpt-oss-120b', 0.03, 0.17, null],
  ['ovh', 'gpt-oss-20b', 0.03, 0.13, null],
  // guard models, no mainstream paid equivalent
  ['ovh', 'Qwen3Guard-Gen-0.6B', null, null, null],
  ['ovh', 'Qwen3Guard-Gen-8B', null, null, null],

  // Pollinations (serves gpt-oss-20b)
  ['pollinations', 'openai-fast', 0.03, 0.13, null],

  // Reka (official API pricing)
  ['reka', 'reka-flash-3', 0.10, 0.20, null],
  ['reka', 'reka-edge-2603', 0.10, 0.10, null],
  ['reka', 'reka-flash', 0.80, 2.00, null],

  // Requesty relays
  ['requesty', 'google/gemma-4-31b-it', 0.10, 0.34, null],
  ['requesty', 'nvidia/nemotron-3-nano-30b-a3b', 0.05, 0.20, null],
  ['requesty', 'nvidia/nemotron-3-super-120b-a12b', 0.085, 0.40, null],
  ['requesty', 'nvidia/nemotron-3-ultra-550b-a55b', 0.60, 3.60, null],
  // free-only on Mistral; stealth models
  ['requesty', 'mistral/leanstral-1-5', null, null, null],
  ['requesty', 'nvidia/nemotron-3.5-content-safety', null, null, null],
  ['requesty', 'poolside/laguna-m.1', null, null, null],

  // Routeway :free relays (priced at the same model's paid variant)
  ['routeway', 'gemma-4-31b-it:free', 0.10, 0.34, null],
  ['routeway', 'gpt-oss-120b:free', 0.03, 0.17, null],
  ['routeway', 'ling-2.6-flash:free', 0.01, 0.03, null],
  ['routeway', 'llama-3.1-8b-instruct:free', 0.05, 0.08, null],
  ['routeway', 'llama-3.2-1b-instruct:free', 0.027, 0.201, null],
  ['routeway', 'llama-3.2-3b-instruct:free', 0.05, 0.33, null],
  ['routeway', 'llama-3.3-70b-instruct:free', 0.10, 0.32, null],
  ['routeway', 'nemotron-3-nano-30b-a3b:free', 0.05, 0.20, null],
  ['routeway', 'nemotron-nano-9b-v2:free', 0.04, 0.16, null],
  ['routeway', 'step-3.5-flash:free', 0.10, 0.30, 0.02],
  ['routeway', 'step-3.7-flash:free', 0.20, 1.15, 0.04],
  // stealth models
  ['routeway', 'laguna-m.1:free', null, null, null],
  ['routeway', 'laguna-xs.2:free', null, null, null],

  // Zhipu (4.5-flash estimated at the 4.7-flash rate — no paid 4.5-flash;
  // 4.6v-flash priced at GLM-4.6V official)
  ['zhipu', 'glm-4.5-flash', 0.06, 0.40, 0.11],
  ['zhipu', 'glm-4.6v-flash', 0.30, 0.90, 0.05],
  ['zhipu', 'glm-4.7-flash', 0.06, 0.40, 0.11],
];

/** Fallback $/M for models with no mapping (custom endpoints, stealth). */
export const FALLBACK_INPUT_PER_M = 0.20;
export const FALLBACK_OUTPUT_PER_M = 0.80;

export const CACHE_READ_PRICE_FACTOR = 0.25;

/**
 * Adds the pricing columns (idempotent) and refreshes prices for every
 * known model. Runs on boot and after every catalog apply — it's ~250 UPDATEs
 * in one transaction and keeps prices current when this map is updated.
 */
export function applyModelPricing(db: Db): void {
  const columns = db.prepare('PRAGMA table_info(models)').all() as { name: string }[];
  if (!columns.some(c => c.name === 'paid_input_per_m')) {
    db.prepare('ALTER TABLE models ADD COLUMN paid_input_per_m REAL').run();
  }
  if (!columns.some(c => c.name === 'paid_output_per_m')) {
    db.prepare('ALTER TABLE models ADD COLUMN paid_output_per_m REAL').run();
  }
  if (!columns.some(c => c.name === 'paid_cached_per_m')) {
    db.prepare('ALTER TABLE models ADD COLUMN paid_cached_per_m REAL').run();
  }

  const update = db.prepare(`
    UPDATE models SET paid_input_per_m = ?, paid_output_per_m = ?, paid_cached_per_m = ?
    WHERE platform = ? AND model_id = ?
  `);
  const applyAll = db.transaction(() => {
    for (const [platform, modelId, input, output, cached] of MODEL_PRICING) {
      update.run(input, output, cached, platform, modelId);
    }
  });
  applyAll();
}
