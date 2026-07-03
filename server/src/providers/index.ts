import type { Platform } from '@freellmapi/shared/types.js';
import type { BaseProvider } from './base.js';
import { GoogleProvider } from './google.js';
import { OpenAICompatProvider } from './openai-compat.js';
import { CohereProvider } from './cohere.js';
import { CloudflareProvider } from './cloudflare.js';
import { AIHordeProvider } from './aihorde.js';
import { G4FProvider } from './g4f.js';

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

register(new OpenAICompatProvider({
  platform: 'nvidia',
  name: 'NVIDIA NIM',
  baseUrl: 'https://integrate.api.nvidia.com/v1',
  forceSingleToolCall: true,
  reasoningEffortMap: { xhigh: 'max' },
  timeoutMs: 60000,
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

register(new OpenAICompatProvider({
  platform: 'zhipu',
  name: 'Zhipu AI',
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
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

register(new OpenAICompatProvider({
  platform: 'pollinations',
  name: 'Pollinations',
  baseUrl: 'https://text.pollinations.ai/openai/v1',
  keyless: true,
}));

register(new OpenAICompatProvider({
  platform: 'llm7',
  name: 'LLM7',
  baseUrl: 'https://api.llm7.io/v1',
}));

register(new OpenAICompatProvider({
  platform: 'opencode',
  name: 'OpenCode Zen',
  baseUrl: 'https://opencode.ai/zen/v1',
}));

register(new OpenAICompatProvider({
  platform: 'ovh',
  name: 'OVH AI Endpoints',
  baseUrl: 'https://oai.endpoints.kepler.ai.cloud.ovh.net/v1',
  keyless: true,
}));

register(new OpenAICompatProvider({
  platform: 'agnes',
  name: 'Agnes AI',
  baseUrl: 'https://apihub.agnes-ai.com/v1',
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

register(new AIHordeProvider());

register(new G4FProvider());

register(new OpenAICompatProvider({
  platform: 'freetheai',
  name: 'FreeTheAi',
  baseUrl: 'https://api.freetheai.xyz/v1',
  timeoutMs: 60000,
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
  if (platform === 'custom') {
    const trimmed = baseUrl?.trim();
    if (!trimmed) return undefined;
    return new OpenAICompatProvider({
      platform: 'custom',
      name: 'Custom (OpenAI-compatible)',
      baseUrl: trimmed,
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
