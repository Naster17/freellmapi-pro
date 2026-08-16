import type { Platform } from '@freellmapi/shared/types.js';
import type { BaseProvider } from './base.js';
import { GoogleProvider } from './google.js';
import { OpenAICompatProvider } from './openai-compat.js';
import { CohereProvider } from './cohere.js';
import { CloudflareProvider } from './cloudflare.js';
import { AIHordeProvider } from './aihorde.js';
import { G4FProvider } from './g4f.js';
import { ModelScopeProvider } from './modelscope.js';
import { PollinationsProvider } from './pollinations.js';
import { ZenProvider } from './zen.js';
import { ensureV1Suffix } from '../lib/endpoint-scope.js';

const providers = new Map<Platform, BaseProvider>();

function register(provider: BaseProvider) {
  providers.set(provider.platform, provider);
}

register(new GoogleProvider());

register(new OpenAICompatProvider({
  platform: 'groq',
  name: 'Groq',
  baseUrl: 'https://api.groq.com/openai/v1',
}));

register(new OpenAICompatProvider({
  platform: 'cerebras',
  name: 'Cerebras',
  baseUrl: 'https://api.cerebras.ai/v1',
}));

// SambaNova was dropped in V23 (June 2026): the free tier is permanently gone.
// The always-free tier was retired in early 2025 for a one-time $5 trial
// credit (expires in 3 months); once it lapses, every chat call 402s
// "payment method required" with no recurring no-card path back.

// NVIDIA NIM - OpenAI-compatible. Several NIM models reject parallel tool calls
// ("This model only supports single tool-calls at once!"), so pin
// parallel_tool_calls to false when tools are present. See issue #255.
// Reasoning models (deepseek-v4-pro, llama-4-maverick, llama-3.1/3.3-70b) take
// 30-60s on cold start; the default 15s false-flags them as broken. 180s:
// NIM sends SSE headers instantly, then prefills 100k-token prompts for
// minutes before the first byte, and this value doubles as the streaming
// first-byte grace budget (#584). Env-tunable via PROVIDER_TIMEOUT_NVIDIA.
register(new OpenAICompatProvider({
  platform: 'nvidia',
  name: 'NVIDIA NIM',
  baseUrl: 'https://integrate.api.nvidia.com/v1',
  forceSingleToolCall: true,
  reasoningEffortMap: { xhigh: 'max' },
  timeoutMs: 180_000,
}));

register(new OpenAICompatProvider({
  platform: 'mistral',
  name: 'Mistral',
  baseUrl: 'https://api.mistral.ai/v1',
}));

register(new OpenAICompatProvider({
  platform: 'openrouter',
  name: 'OpenRouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  extraHeaders: {
    'HTTP-Referer': 'http://localhost:3001',
    'X-Title': 'FreeLLMAPI',
  },
}));

register(new OpenAICompatProvider({
  platform: 'github',
  name: 'GitHub Models',
  baseUrl: 'https://models.github.ai/inference',
}));

register(new CohereProvider());

register(new CloudflareProvider());

// Zhipu (Z.ai / bigmodel.cn) - OpenAI-compatible
//
// glm-4.7-flash is a hidden-reasoning model: it burns through a long
// reasoning_content before the first answer byte (live-probed 41s TTFB on a
// one-word completion, 2026-07-11), and Zhipu buffers that phase even when
// streaming — so the default 15s timeout aborted every attempt. 60s covers
// the observed worst case with headroom.
register(new OpenAICompatProvider({
  platform: 'zhipu',
  name: 'Zhipu AI',
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  timeoutMs: 60_000,
}));

register(new OpenAICompatProvider({
  platform: 'huggingface',
  name: 'HuggingFace Router',
  baseUrl: 'https://router.huggingface.co/v1',
}));

register(new OpenAICompatProvider({
  platform: 'ollama',
  name: 'Ollama Cloud',
  baseUrl: 'https://ollama.com/v1',
  timeoutMs: 120000,
}));

register(new OpenAICompatProvider({
  platform: 'kilo',
  name: 'Kilo Gateway',
  baseUrl: 'https://api.kilo.ai/api/gateway/v1',
  validateUrl: 'https://api.kilo.ai/api/gateway/models',
  keyless: true,
}));

// Pollinations — OpenAI-compatible recurring shared-capacity tier. The legacy
// text.pollinations.ai host returned 502 in the July 2026 audit; publishable
// keys now use the unified gen.pollinations.ai endpoint. Free capacity accrues
// at one pollen per IP per hour, so chat requires a real publishable key.
// Dedicated PollinationsProvider (not plain OpenAICompatProvider) because
// GET /v1/models is public — it answers 200 for a revoked key — so validation
// probes the authenticated /account/key instead; see providers/pollinations.ts
// and issue #608.
register(new PollinationsProvider());

register(new OpenAICompatProvider({
  platform: 'llm7',
  name: 'LLM7',
  baseUrl: 'https://api.llm7.io/v1',
}));

register(new ZenProvider());

register(new OpenAICompatProvider({
  platform: 'ovh',
  name: 'OVH AI Endpoints',
  baseUrl: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1',
  keyless: true,
}));

// Agnes AI (Sapiens AI) — OpenAI-compatible, backed by LiteLLM + vLLM. Its
// proprietary Agnes models are currently served at $0/token: live-probed
// 2026-06-15, the LiteLLM cost headers (x-litellm-response-cost-original) come
// back 0.0 with no credit drain, so usage is genuinely free rather than a
// one-time signup-credit grant. The $0 is promotional ("previously $X" /
// "during this period"), and there is a paid Token/Unlimited subscription
// underneath, so watch for reversion to paid. ~30 concurrent requests succeed
// before 429s (no documented RPM/RPD). Free key from platform.agnes-ai.com,
// no card. Catalog rows live in the catalog (premium → age into free); not
// shipped as freeapi model migrations.
// agnes-2.0-flash reasons before answering (live-probed 20s TTFB on a
// one-word completion, 2026-07-11), so the default 15s timeout aborted it;
// 60s matches the other reasoning-hosting platforms.
register(new OpenAICompatProvider({
  platform: 'agnes',
  name: 'Agnes AI',
  baseUrl: 'https://apihub.agnes-ai.com/v1',
  timeoutMs: 60_000,
}));

register(new OpenAICompatProvider({
  platform: 'reka',
  name: 'Reka',
  baseUrl: 'https://api.reka.ai/v1',
}));

register(new OpenAICompatProvider({
  platform: 'siliconflow',
  name: 'SiliconFlow',
  baseUrl: 'https://api.siliconflow.com/v1',
}));

register(new OpenAICompatProvider({
  platform: 'routeway',
  name: 'Routeway',
  baseUrl: 'https://api.routeway.ai/v1',
  extraHeaders: {
    'User-Agent': 'Mozilla/5.0 FreeLLMAPI/1.0',
  },
}));

register(new OpenAICompatProvider({
  platform: 'bazaarlink',
  name: 'BazaarLink',
  baseUrl: 'https://bazaarlink.ai/api/v1',
}));

register(new OpenAICompatProvider({
  platform: 'ainative',
  name: 'AINative Studio',
  baseUrl: 'https://api.ainative.studio/api/v1',
}));

// Aion Labs — OpenAI-compatible aggregator (api.aionlabs.ai/v1). Free key from
// aionlabs.ai (no card); recurring free availability is catalog-managed so
// premium users see rows immediately and free users get them after 30 days.
register(new OpenAICompatProvider({
  platform: 'aion',
  name: 'Aion Labs',
  baseUrl: 'https://api.aionlabs.ai/v1',
}));

// Requesty — OpenAI-compatible router (router.requesty.ai/v1). Free key from
// requesty.ai (no card); free model rows age into the public monthly catalog
// through the standard 30-day gate.
register(new OpenAICompatProvider({
  platform: 'requesty',
  name: 'Requesty',
  baseUrl: 'https://router.requesty.ai/v1',
}));

// NavyAI — OpenAI-compatible unified API (api.navy/v1). Free key from the
// Discord-backed dashboard; the free plan is 150K tokens/day and 20 RPM.
// Live smoke tests required an explicit User-Agent header.
register(new OpenAICompatProvider({
  platform: 'navy',
  name: 'NavyAI',
  baseUrl: 'https://api.navy/v1',
  extraHeaders: {
    'User-Agent': 'FreeLLMAPI/1.0',
  },
}));

// NaraRouter — OpenAI-compatible aggregator (router.bynara.id/v1). Free plan
// requires a no-card API key plus Telegram channel/link verification. Live
// probed 2026-07-09: `mistral-large`, `mistral-medium-3-5`, and `tencent-hy3`
// answered 200 with a zero-balance account; the rest of /v1/models was
// credit- or plan-gated. Catalog rows live in the Oracle catalog (premium now,
// free after the 30-day model-age gate).
register(new OpenAICompatProvider({
  platform: 'nara',
  name: 'NaraRouter',
  baseUrl: 'https://router.bynara.id/v1',
}));

// SEA-LION (AI Singapore) — OpenAI-compatible first-party API (api.sea-lion.ai/v1).
// Free key from sea-lion.ai (Google sign-in, no card, no region wall); recurring
// free tier at 10 RPM. Catalog rows live in the Oracle catalog (premium now, free
// after the 30-day model-age gate).
register(new OpenAICompatProvider({
  platform: 'sealion',
  name: 'SEA-LION',
  baseUrl: 'https://api.sea-lion.ai/v1',
}));

// ModelScope (魔搭社区, Alibaba) — OpenAI-compatible inference API
// (api-inference.modelscope.cn/v1, Bearer auth). Free tier: 2000 requests/day
// account-wide. Token from modelscope.cn/my/myaccesstoken, BUT calls only work
// after binding the ModelScope account to an Alibaba Cloud CHINA-site (cn)
// account with Chinese real-name verification — unbound tokens 401 on every
// call ("please bind your alibaba cloud account before use"). Dedicated
// ModelScopeProvider (not plain OpenAICompatProvider) because GET /v1/models
// answers 200 even for garbage tokens, so key validation needs a 1-token chat
// probe instead — see providers/modelscope.ts.
//
// RETIRED-model gotcha (#581): ModelScope answers requests for retired models
// with `429 insufficient balance (1008)`. isPaymentRequiredError
// (lib/error-classify.ts) reads "insufficient balance" as out-of-credits and
// benches the key ~24h — intentionally NOT special-cased in the shared
// classifier (the string is a genuine payment marker everywhere else). Keep
// retired ids out of the catalog instead; the quota-header path in
// provider-quota.ts keys on response headers, never on that message text.
register(new ModelScopeProvider());

// AI Horde — free, community-powered inference (volunteer workers) via an
// OpenAI-compatible proxy. Dedicated AIHordeProvider (not OpenAICompatProvider)
// because the proxy is queue-based and diverges from the OpenAI contract:
// max_tokens must be >=16, stop must be an array, no tool calling, usage is
// reported as kudos (synthesized into token counts), and calls can take tens of
// seconds (120s timeout, no upstream streaming). Registered keyless so it
// auto-configures and works anonymously (key 0000000000, lowest queue
// priority); a registered aihorde.net key raises priority. See issue #345.
register(new AIHordeProvider());

register(new G4FProvider());

register(new OpenAICompatProvider({
  platform: 'freetheai',
  name: 'FreeTheAi',
  baseUrl: 'https://api.freetheai.xyz/v1',
  timeoutMs: 60000,
}));

// Modal — OpenAI-compatible shared endpoints (https://modal.com). Each key is
// bound to ONE endpoint, so the endpoint URL lives on the api_keys row's
// base_url and resolveProvider builds a per-key adapter exactly like 'custom'.
// Auth is a workspace proxy token (wk-<id>.ws-<secret>) sent as the bearer.
// Usage is dollar-metered (model-pricing + /api/usage-limits), not RPM/RPD.
// The registered instance only exists so the keys checklist and hasProvider()
// see the platform; real requests go through resolveProvider('modal', base_url).
register(new OpenAICompatProvider({
  platform: 'modal',
  name: 'Modal',
  baseUrl: '',
}));

register(new OpenAICompatProvider({
  platform: 'custom',
  name: 'Custom (OpenAI-compatible)',
  baseUrl: '',
}));

const CUSTOM_PROVIDER_TIMEOUT_MS = 120000;

export function getProvider(platform: Platform): BaseProvider | undefined {
  return providers.get(platform);
}

export function resolveProvider(platform: Platform, baseUrl?: string | null): BaseProvider | undefined {
  if (platform === 'custom' || platform === 'modal') {
    const trimmed = baseUrl?.trim();
    if (!trimmed) return undefined;
    const name = platform === 'modal' ? 'Modal' : 'Custom (OpenAI-compatible)';
    return new OpenAICompatProvider({
      platform,
      name,
      baseUrl: platform === 'modal' ? ensureV1Suffix(trimmed) : trimmed,
      timeoutMs: CUSTOM_PROVIDER_TIMEOUT_MS,
    });
  }
  return providers.get(platform);
}

export function getAllProviders(): BaseProvider[] {
  return Array.from(providers.values());
}

export function hasProvider(platform: Platform): boolean {
  return providers.has(platform);
}
