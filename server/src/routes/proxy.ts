import crypto from 'crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { ChatMessage, ChatToolCall, ModelListRow, Platform } from '@freellmapi/shared/types.js';
import { routeRequest, resolveRoutingChain, resolveModelGroupCandidates, resolveStickyPreference, recordRateLimitHit, recordSuccess, hasOtherUsableKey, hasEnabledVisionModel, hasEnabledToolsModel, modelRecentHealth, isStrictChainEnabled, routingReserveTokens, type RouteResult, type ResolvedChain, type ChainRow } from '../services/router.js';
import { recordRequest, recordTokens, setCooldown, getCooldownDurationForLimit, PAYMENT_REQUIRED_COOLDOWN_MS, MODEL_FORBIDDEN_COOLDOWN_MS, MODEL_GONE_COOLDOWN_MS, learnLimitFromError, reserveKeySlot, releaseKeySlot } from '../services/ratelimit.js';
import { runEmbeddings, EmbeddingsError } from '../services/embeddings.js';
import { runImageGeneration, runSpeech, runTranscription, MediaError, MAX_TRANSCRIPTION_BYTES } from '../services/media.js';
import multer from 'multer';
import { getDb } from '../db/index.js';
import { resolveAuth, prependSystemPrompt, type ResolvedAuth } from '../lib/system-prompt.js';
import { contentToString, messageHasImage, normalizeOutboundContent, sanitizeResponse } from '../lib/content.js';
import { backfillToolCallReasoning, rememberToolReasoning } from '../lib/reasoning-store.js';
import { repairToolArguments, toolSchemaMap } from '../lib/tool-args.js';
import { sanitizeProviderErrorMessage } from '../lib/error-redaction.js';
import { rescueInlineToolCalls, startsWithDialectMarker, couldBecomeDialectMarker, containsDialectMarker } from '../lib/tool-call-rescue.js';
import { getContextHandoffMode, recordIncomingMessages, maybeInjectContextHandoff, recordSuccessfulModel, hasPriorModel, HANDOFF_MAX_TOKENS } from '../services/context-handoff.js';
import { isFusionModel, runFusion, fusionConfigSchema, FusionError, FUSION_MODEL_ID } from '../services/fusion.js';
import { isRetryableError, isPaymentRequiredError, isModelNotFoundError, isModelAccessForbiddenError, isKeyInvalidatingError, isModelGoneError, isClientAbortError, newClientAbortError, isRateLimitSignal, isProviderBadRequestError } from '../lib/error-classify.js';
import { providerLog } from '../lib/server-logs.js';
import { logRequest, getClientIp } from '../lib/request-log.js';
import { invalidateKey } from '../services/health.js';
import { normalizeUsage, cachedTokens as usageCachedTokens, streamOptionsWithUsage } from '../lib/usage-normalize.js';
import { responseCostFor } from '../lib/response-cost.js';
import { observeServedModel } from '../lib/served-model.js';
import { parseCacheDirective, cacheActive, isCacheableTemperature, computeCacheKey, getCachedResponse, storeCachedResponse } from '../services/cache.js';
import { recordUpstreamSuccess, recordRetryableFailure, cooldownDecisionForError, setFallbackHeaders, exhaustionErrorPayload, setExhaustionHeaders, msUntilNextUtcMidnight, ZEN_ANON_TRANSIENT_COOLDOWN_MS, type AttemptRecord } from '../lib/fallback-loop.js';
import { isZenAnonymousKey, benchZenModelPool } from '../services/zen-keyless.js';
import { routedViaValue, safeHeaderValue } from '../lib/header-value.js';
import { applyTokenBudget, tokenBudgetMessage } from '../lib/guardrails.js';
import { samplingParamSchemaFields, pickSamplingParams, supportedParametersForPlatforms } from '../lib/sampling-params.js';
import { enforceJsonContent } from '../lib/structured-output.js';
import { inferQuotaPoolKey, type QuotaObservationContext } from '../services/provider-quota.js';
import { isUnifyEnabled, getModelGroups, resolveRequestedIdForDispatch } from '../services/model-groups.js';
import { buildModelListing } from '../services/model-listing.js';
import { compressRequest, formatCompressionHeader } from '../services/compression/pipeline.js';

export const proxyRouter = Router();

const AUTO_MODEL_ID = 'auto';

type ModelCatalogRow = ModelListRow & {
  id: number;
  intelligence_rank: number;
  supports_vision: number;
  supports_tools: number;
};

type ReasoningLevel = 'none' | 'low' | 'medium' | 'high';
type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high';

function reasoningLevel(modelId: string, displayName: string): ReasoningLevel {
  const value = `${modelId} ${displayName}`.toLowerCase();

  if ([
    'big-pickle',
    'command-a-reasoning',
    'deepseek-r1',
    'deepseek-v4',
    'gpt-oss-120b',
    'gpt-oss:120b',
    'kimi-k2-thinking',
    'magistral-medium',
    'minimax-m2',
    'nemotron-3-ultra',
    'north-mini-code',
    'qwen3-coder',
    'qwen3-next',
    'qwen3-235',
    'qwen-3-235',
    'qwen-3-coder',
    'qwen/qwen3-coder',
    'qwen/qwen3-next',
    'gemini-2.5-pro',
    'gemini-3',
    'cogito-2.1',
    'glm-5',
  ].some(marker => value.includes(marker)) || /\bo[134]\b/.test(value)) {
    return 'high';
  }

  if ([
    'gpt-oss-20b',
    'gpt-oss:20b',
    'openai-fast',
    'r1-distill',
    'lfm-2.5-1.2b-thinking',
    'nemotron-nano-9b-v2',
  ].some(marker => value.includes(marker))) {
    return 'low';
  }

  if ([
    'reasoning',
    'thinking',
    'gemini-2.5-flash',
    'gemma-4',
    'glm-4.5',
    'glm-4.6',
    'glm-4.7',
    'magistral',
    'mistral-medium',
    'mistral-small',
    'nemotron-3-super',
    'nemotron-3-120b',
    'nemotron-3-nano-30b-a3b',
    'qwen3',
    'qwen-3',
    'kimi-k2',
  ].some(marker => value.includes(marker))) {
    return 'medium';
  }

  return 'none';
}

function supportsReasoning(modelId: string, displayName: string): boolean {
  return reasoningLevel(modelId, displayName) !== 'none';
}

function supportedReasoningEfforts(level: ReasoningLevel): ReasoningEffort[] {
  if (level === 'high') return ['minimal', 'low', 'medium', 'high'];
  if (level === 'medium') return ['minimal', 'low', 'medium'];
  if (level === 'low') return ['minimal', 'low'];
  return [];
}

function modelCapabilities(model: {
  model_id: string;
  display_name: string;
  context_window: number | null;
  supports_vision?: number;
  supports_tools?: number;
  supports_reasoning?: number;
}) {
  const vision = model.supports_vision === 1;
  const tools = model.supports_tools === 1;
  const inferredReasoningLevel = reasoningLevel(model.model_id, model.display_name);
  const reasoning = model.supports_reasoning === undefined ? inferredReasoningLevel !== 'none' : model.supports_reasoning === 1;
  const effectiveReasoningLevel = reasoning ? inferredReasoningLevel === 'none' ? 'medium' : inferredReasoningLevel : 'none';
  const reasoningEfforts = supportedReasoningEfforts(effectiveReasoningLevel);
  const defaultReasoningEffort = reasoning
    ? effectiveReasoningLevel === 'low' ? 'low' : effectiveReasoningLevel === 'high' ? 'medium' : 'medium'
    : null;
  const inputModalities = vision ? ['text', 'image'] : ['text'];
  const supportedParameters = ['temperature', 'top_p', 'max_tokens', 'stream'];

  if (tools) supportedParameters.push('tools', 'tool_choice', 'parallel_tool_calls');
  if (reasoning) supportedParameters.push('reasoning', 'reasoning_effort', 'include_reasoning');

  return {
    supports_vision: vision,
    supports_tools: tools,
    supports_reasoning: reasoning,
    reasoning: reasoning ? {
      mandatory: false,
      default_enabled: true,
      supported_efforts: reasoningEfforts,
      default_effort: defaultReasoningEffort,
    } : null,
    reasoning_level: effectiveReasoningLevel,
    default_reasoning_effort: defaultReasoningEffort,
    supported_reasoning_efforts: reasoningEfforts,
    reasoning_capabilities: {
      level: effectiveReasoningLevel,
      efforts: reasoningEfforts,
      default_effort: defaultReasoningEffort,
    },
    input_modalities: inputModalities,
    output_modalities: ['text'],
    modalities: {
      input: inputModalities,
      output: ['text'],
    },
    capabilities: {
      vision,
      tools,
      reasoning,
      reasoning_level: effectiveReasoningLevel,
      reasoning_efforts: reasoningEfforts,
    },
    supported_parameters: supportedParameters,
    architecture: {
      modality: `${inputModalities.join('+')}->text`,
      input_modalities: inputModalities,
      output_modalities: ['text'],
      tokenizer: 'Other',
      instruct_type: null,
    },
    top_provider: {
      context_length: model.context_window,
      max_completion_tokens: null,
      is_moderated: false,
    },
    pricing: {
      prompt: '0',
      completion: '0',
      image: '0',
      request: '0',
      input_cache_read: '0',
      input_cache_write: '0',
    },
    per_request_limits: null,
  };
}

function isAutoModel(modelId: string | undefined): boolean {
  if (!modelId) return true;
  const lower = modelId.toLowerCase();
  return lower === AUTO_MODEL_ID || lower.startsWith(`${AUTO_MODEL_ID}:`);
}

export { timingSafeStringEqual } from '../lib/system-prompt.js';

function requireInferenceAuth(req: Request, res: Response): ResolvedAuth | null {
  const auth = resolveAuth(extractApiToken(req));
  if (!auth) {
    res.status(401).json({ error: { message: 'Invalid API key', type: 'authentication_error' } });
    return null;
  }
  return auth;
}

export function extractApiToken(req: Request): string | undefined {
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '').trim();
  if (bearer) return bearer;

  const apiKeyHeader = req.headers['x-api-key'];
  const xApiKey = Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader;
  const trimmed = xApiKey?.trim();
  if (trimmed) return trimmed;
  const googleHeader = req.headers['x-goog-api-key'];
  const googleKey = Array.isArray(googleHeader) ? googleHeader[0] : googleHeader;
  return googleKey?.trim() || undefined;
}

function quotaContextForRoute(route: RouteResult, endpoint: string): QuotaObservationContext {
  return {
    platform: route.platform as Platform,
    keyId: route.keyId,
    modelId: route.modelId,
    quotaPoolKey: inferQuotaPoolKey(route.platform as Platform, route.modelId),
    endpoint,
    origin: 'proxy',
  };
}

export function getRequestGroupId(req: Request): string {
  const raw = req.headers['x-request-id'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  const trimmed = value?.trim();
  return trimmed || crypto.randomUUID();
}

function shortRequestId(requestId: string): string {
  return requestId.replace(/-/g, '').slice(0, 6);
}

type TraceEvent = 'start' | 'next' | 'ok' | 'fail';

export function traceRouteEvent(
  scope: 'Proxy' | 'Responses',
  opts: {
    event: TraceEvent;
    requestId: string;
    attempt: number;
    platform: string;
    model: string;
    requestedModel?: string;
    latencyMs?: number;
    inputTokens?: number;
    outputTokens?: number;
    error?: string;
  },
) {
  const parts = [
    `[${scope}]`,
    new Date().toISOString().slice(11, 19),
    opts.event,
    shortRequestId(opts.requestId),
    `a${opts.attempt}`,
    opts.platform,
    '-',
    opts.model,
  ];
  if (opts.requestedModel) parts.push(`req=${opts.requestedModel}`);
  if (opts.latencyMs != null) parts.push(`lat=${opts.latencyMs}ms`);
  if (opts.inputTokens != null) parts.push(`in=${opts.inputTokens}`);
  if (opts.outputTokens != null) parts.push(`out=${opts.outputTokens}`);
  if (opts.error) parts.push(`err=${JSON.stringify(opts.error)}`);
  console.log(parts.join(' '));
}

const stickySessionMap = new Map<string, { modelDbId: number; lastUsed: number }>();
const STICKY_TTL_MS = 30 * 60 * 1000;
const STICKY_MAX_ENTRIES = 5_000;
const STICKY_SWEEP_INTERVAL_MS = 60 * 1000;
let lastStickySweepAt = 0;

function sweepStickySessions(now: number): void {
  if (now - lastStickySweepAt < STICKY_SWEEP_INTERVAL_MS) return;
  lastStickySweepAt = now;
  for (const [k, v] of stickySessionMap) {
    if (now - v.lastUsed > STICKY_TTL_MS) stickySessionMap.delete(k);
  }
}

function getSessionKey(messages: ChatMessage[], sessionIdHeader?: string, strategyKey?: string): string {
  if (sessionIdHeader) {
    return strategyKey ? `hdr:${sessionIdHeader}::${strategyKey}` : `hdr:${sessionIdHeader}`;
  }

  const firstUser = messages.find(m => m.role === 'user');
  if (!firstUser) return '';
  const text = contentToString(firstUser.content ?? '');
  if (!text) return '';
  const payload = strategyKey ? `${text}::${strategyKey}` : text;
  return crypto.createHash('sha1').update(payload).digest('hex');
}

export function getStickyModel(messages: ChatMessage[], sessionIdHeader?: string, strategyKey?: string): number | undefined {
  const hasAssistant = messages.some(m => m.role === 'assistant');
  if (!hasAssistant) return undefined;

  const key = getSessionKey(messages, sessionIdHeader, strategyKey);
  if (!key) return undefined;

  const now = Date.now();
  sweepStickySessions(now);
  const entry = stickySessionMap.get(key);
  if (!entry) return undefined;

  if (Date.now() - entry.lastUsed > STICKY_TTL_MS) {
    stickySessionMap.delete(key);
    return undefined;
  }
  return entry.modelDbId;
}

export function setStickyModel(messages: ChatMessage[], modelDbId: number, sessionIdHeader?: string, strategyKey?: string) {
  const key = getSessionKey(messages, sessionIdHeader, strategyKey);
  if (!key) return;
  const now = Date.now();
  sweepStickySessions(now);
  stickySessionMap.set(key, { modelDbId, lastUsed: now });

  if (stickySessionMap.size > STICKY_MAX_ENTRIES) {
    const cutoff = now - STICKY_TTL_MS;
    for (const [k, v] of stickySessionMap) {
      if (v.lastUsed < cutoff) stickySessionMap.delete(k);
    }
  }
}

function healthyAutoSticky(messages: ChatMessage[], sessionIdHeader?: string, strategyKey?: string, chain?: ChainRow[]): number | undefined {
  const sticky = resolveStickyPreference(getStickyModel(messages, sessionIdHeader, strategyKey), chain);
  if (sticky == null) return undefined;
  return modelRecentHealth(sticky).ok ? sticky : undefined;
}

proxyRouter.get('/models', (req: Request, res: Response) => {
  if (!requireInferenceAuth(req, res)) return;

  const { models: allListed, autoContextWindow } = buildModelListing();

  const availabilityQuery = String(req.query.available ?? req.query.connected ?? '').toLowerCase();
  const allQuery = String(req.query.all ?? req.query.full ?? '').toLowerCase();
  const includeAll =
    availabilityQuery === '0' || availabilityQuery === 'false' || availabilityQuery === 'no' ||
    allQuery === '1' || allQuery === 'true' || allQuery === 'yes';
  const listed = includeAll ? allListed : allListed.filter(m => m.available === 1);

  const availableModels = allListed.filter(m => m.available === 1);
  const autoMetadata = modelCapabilities({
    model_id: AUTO_MODEL_ID,
    display_name: 'Auto',
    context_window: autoContextWindow,
    supports_vision: availableModels.some(m => m.supportsVision === 1) ? 1 : 0,
    supports_tools: availableModels.some(m => m.supportsTools === 1) ? 1 : 0,
    supports_reasoning: availableModels.some(m => m.supportsReasoning === 1) ? 1 : 0,
  });
  res.json({
    object: 'list',
    data: [
      {
        id: AUTO_MODEL_ID,
        object: 'model',
        created: 0,
        owned_by: 'freellmapi',
        name: 'Auto (router picks the best available model)',
        context_window: autoContextWindow,
        context_length: autoContextWindow,
        ...autoMetadata,
        available: true,
        unavailable_reason: null,
      },
      {
        id: FUSION_MODEL_ID,
        object: 'model',
        created: 0,
        owned_by: 'freellmapi',
        name: 'Fusion (runs models in parallel, judge merges results)',
        context_window: autoContextWindow,
        context_length: autoContextWindow,
        ...autoMetadata,
        available: autoContextWindow != null,
        unavailable_reason: autoContextWindow != null ? null : 'no_models',
      },
      ...listed.map(m => ({
        id: m.id,
        object: 'model',
        created: 0,
        owned_by: m.ownedBy,
        name: m.name,
        context_window: m.contextWindow,
        context_length: m.contextWindow,
        ...modelCapabilities({
          model_id: m.id,
          display_name: m.name,
          context_window: m.contextWindow,
          supports_vision: m.supportsVision,
          supports_tools: m.supportsTools,
          supports_reasoning: m.supportsReasoning,
        }),
        available: m.available === 1,
        unavailable_reason: m.available === 1 ? null : (m.enabled === 1 ? 'no_key' : 'disabled'),
        // OpenRouter's field name; agents use it to pick knobs per model. For
        // a unify group this is the intersection over member platforms — a
        // param is only advertised when every platform the router might pick
        // honors it.
        supported_parameters: supportedParametersForPlatforms([m.id.split('/')[0] || ''], { tools: !!m.supportsTools, reasoning: !!m.supportsReasoning }),
      })),
    ],
  });
});

const MAX_RETRIES = 20;

const toolCallSchema = z.object({
  id: z.string().optional(),
  type: z.literal('function').optional(),
  function: z.object({
    name: z.string().min(1),
    arguments: z.union([z.string(), z.record(z.string(), z.unknown())]),
  }),
  thought_signature: z.string().optional(),
});

const toolCallArgsToString = (args: string | Record<string, unknown>): string =>
  typeof args === 'string' ? args : JSON.stringify(args);

const contentBlockSchema = z.union([z.string(), z.record(z.string(), z.unknown())]);
const contentSchema = z.union([z.string(), z.array(contentBlockSchema)]);

const systemMessageSchema = z.object({
  role: z.literal('system'),
  content: contentSchema,
  name: z.string().optional(),
});

const developerMessageSchema = z.object({
  role: z.literal('developer'),
  content: contentSchema,
  name: z.string().optional(),
});

const userMessageSchema = z.object({
  role: z.literal('user'),
  content: contentSchema,
  name: z.string().optional(),
});

const assistantMessageSchema = z.object({
  role: z.literal('assistant'),
  content: z.union([contentSchema, z.null()]).optional(),
  name: z.string().optional(),
  tool_calls: z.array(toolCallSchema).nullable().optional(),
  reasoning_content: z.string().nullable().optional(),
});

const toolMessageSchema = z.object({
  role: z.literal('tool'),
  content: z.union([contentSchema, z.null()]).optional(),
  tool_call_id: z.string().optional(),
  name: z.string().optional(),
});

const functionMessageSchema = z.object({
  role: z.literal('function'),
  name: z.string().min(1),
  content: z.union([contentSchema, z.null()]).optional(),
});

const toolDefinitionSchema = z.object({
  type: z.literal('function').optional(),
  function: z.object({
    name: z.string().min(1),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).optional(),
    strict: z.boolean().optional(),
  }),
});

const toolChoiceSchema = z.union([
  z.enum(['none', 'auto', 'required', 'any']),
  z.object({
    type: z.literal('function'),
    function: z.object({
      name: z.string().min(1),
    }),
  }),
]);

const reasoningEffortSchema = z.preprocess(
  value => value === 'max' ? 'xhigh' : value,
  z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh']),
);
const reasoningSchema = z.union([
  z.boolean(),
  z.object({
    effort: reasoningEffortSchema.optional(),
    summary: z.union([z.enum(['auto', 'concise', 'detailed']), z.null()]).optional(),
  }).passthrough(),
]);
const stopSchema = z.union([z.string(), z.array(z.string()).min(1).max(64)]);

function providerSafeStop(stop: string | string[] | undefined): string | string[] | undefined {
  if (!Array.isArray(stop)) return stop;
  return stop.slice(0, 4);
}

const chatCompletionSchema = z.object({
  messages: z.array(z.union([
    systemMessageSchema,
    developerMessageSchema,
    userMessageSchema,
    assistantMessageSchema,
    toolMessageSchema,
    functionMessageSchema,
  ])).min(1),
  model: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().optional(),
  top_p: z.number().min(0).max(1).optional(),
  stop: stopSchema.optional(),
  stream: z.boolean().optional(),
  tools: z.array(toolDefinitionSchema).nullable().optional(),
  tool_choice: toolChoiceSchema.nullable().optional(),
  parallel_tool_calls: z.boolean().nullable().optional(),
  include_reasoning: z.boolean().nullable().optional(),
  stream_options: z.object({ include_usage: z.boolean().optional() }).passthrough().nullable().optional(),
  fusion: fusionConfigSchema.optional(),
  // Extended sampling + structured-output params (top_k, seed, penalties,
  // logit_bias, logprobs, response_format, max_completion_tokens…), forwarded
  // per the platform policy in lib/sampling-params.ts.
  ...samplingParamSchemaFields,
});

export { isRetryableError, isPaymentRequiredError, isModelNotFoundError, isModelAccessForbiddenError, isKeyInvalidatingError, isModelGoneError };

export function streamChunkText(chunk: any): string {
  return chunk?.choices?.[0]?.delta?.content ?? '';
}

const EmbeddingsBody = z.object({
  model: z.string().optional(),
  input: z.union([z.string(), z.array(z.string())]),
  dimensions: z.number().int().positive().optional(),
});

proxyRouter.post('/embeddings', async (req: Request, res: Response) => {
  const clientIp = getClientIp(req);
  if (!requireInferenceAuth(req, res)) return;
  const parsed = EmbeddingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid request: `input` is required', type: 'invalid_request_error' } });
    return;
  }
  const inputs = Array.isArray(parsed.data.input) ? parsed.data.input : [parsed.data.input];
  try {
    const result = await runEmbeddings(parsed.data.model, inputs, parsed.data.dimensions, clientIp);
    res.json({
      object: 'list',
      data: result.vectors.map((values, i) => ({ object: 'embedding', index: i, embedding: values })),
      model: result.modelId,
      provider: result.platform,
      usage: { prompt_tokens: result.inputTokens, total_tokens: result.inputTokens },
    });
  } catch (err: any) {
    const status = err instanceof EmbeddingsError ? err.status : 502;
    const type = status === 400 ? 'invalid_request_error' : status === 429 ? 'rate_limit_error' : 'server_error';
    res.status(status).json({ error: { message: `embedding error: ${err?.message ?? 'unknown'}`, type } });
  }
});

const ImageBody = z.object({
  model: z.string().optional(),
  prompt: z.string().min(1),
  n: z.number().int().positive().max(4).optional(),
  size: z.string().optional(),
  response_format: z.enum(['url', 'b64_json']).optional(),
});

function mediaErrorType(status: number): string {
  if (status === 400 || status === 413) return 'invalid_request_error';
  if (status === 401) return 'authentication_error';
  if (status === 429) return 'rate_limit_error';
  return 'server_error';
}

proxyRouter.post('/images/generations', async (req: Request, res: Response) => {
  const clientIp = getClientIp(req);
  if (!requireInferenceAuth(req, res)) return;
  const parsed = ImageBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid request: `prompt` is required', type: 'invalid_request_error' } });
    return;
  }
  try {
    const result = await runImageGeneration(parsed.data.model, {
      prompt: parsed.data.prompt, n: parsed.data.n, size: parsed.data.size,
    }, clientIp);
    res.json({
      created: Math.floor(Date.now() / 1000),
      data: result.images,
      model: result.modelId,
      provider: result.platform,
    });
  } catch (err: any) {
    const status = err instanceof MediaError ? err.status : 502;
    const httpStatus = status >= 400 && status < 600 ? status : 502;
    res.status(httpStatus).json({ error: { message: `image generation error: ${err?.message ?? 'unknown'}`, type: mediaErrorType(status) } });
  }
});

const SpeechBody = z.object({
  model: z.string().optional(),
  input: z.string().min(1),
  voice: z.string().optional(),
  response_format: z.string().optional(),
});

proxyRouter.post('/audio/speech', async (req: Request, res: Response) => {
  const clientIp = getClientIp(req);
  if (!requireInferenceAuth(req, res)) return;
  const parsed = SpeechBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid request: `input` is required', type: 'invalid_request_error' } });
    return;
  }
  try {
    const result = await runSpeech(parsed.data.model, {
      input: parsed.data.input, voice: parsed.data.voice, format: parsed.data.response_format,
    }, clientIp);
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('X-Provider', safeHeaderValue(result.platform));
    res.send(result.audio);
  } catch (err: any) {
    const status = err instanceof MediaError ? err.status : 502;
    const httpStatus = status >= 400 && status < 600 ? status : 502;
    res.status(httpStatus).json({ error: { message: `speech error: ${err?.message ?? 'unknown'}`, type: mediaErrorType(status) } });
  }
});

// OpenAI-compatible speech-to-text (/v1/audio/transcriptions). Multipart form
// upload, held in memory only (multer memoryStorage — audio bytes never touch
// disk), routed through the STT provider chain in services/media.ts with the
// same key/failover/cooldown machinery as the other media endpoints. The STT
// registry (media_models, modality='transcription') is maintained by the
// published catalog's `transcriptionModels` array via catalog-sync; on an
// install that has never synced one, the endpoint answers 503 with code
// 'no_transcription_models' until the first sync lands.
//
// response_format: 'json' (default, {"text": ...}), 'text' (plain string),
// 'verbose_json' (OpenAI verbose shape when the provider returns segments,
// graceful fallback to the plain json shape otherwise), 'vtt' (only from
// providers that produce it natively — Cloudflare whisper). 'srt' is not
// produced natively by any configured provider and is refused with 400
// unsupported_format rather than synthesized.
const transcriptionUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_TRANSCRIPTION_BYTES, files: 1 },
});

const TRANSCRIPTION_FORMATS = new Set(['json', 'text', 'verbose_json', 'srt', 'vtt']);

function transcriptionBadRequest(res: Response, message: string, code?: string): void {
  res.status(400).json({ error: { message, type: 'invalid_request_error', ...(code ? { code } : {}) } });
}

proxyRouter.post('/audio/transcriptions', (req: Request, res: Response, next) => {
  // Auth before the multipart body is parsed: an unauthenticated caller's
  // upload is never buffered.
  if (!requireInferenceAuth(req, res)) return;
  transcriptionUpload.single('file')(req, res, (err: unknown) => {
    if (err) {
      if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
        res.status(413).json({
          error: {
            message: `Audio file too large: the maximum upload size is ${MAX_TRANSCRIPTION_BYTES / (1024 * 1024)} MB.`,
            type: 'invalid_request_error',
            code: 'file_too_large',
          },
        });
        return;
      }
      transcriptionBadRequest(res, 'Malformed multipart/form-data upload.');
      return;
    }
    next();
  });
}, async (req: Request, res: Response) => {
  const file = req.file;
  if (!file || !file.buffer?.length) {
    transcriptionBadRequest(res, 'Invalid request: `file` is required (multipart/form-data audio upload).');
    return;
  }
  const model = typeof req.body?.model === 'string' ? req.body.model.trim() : '';
  if (!model) {
    transcriptionBadRequest(res, "Invalid request: `model` is required (use 'whisper-1' or 'auto' to let the router decide).");
    return;
  }
  const rawFormat = typeof req.body?.response_format === 'string' ? req.body.response_format.trim() : '';
  const responseFormat = rawFormat || 'json';
  if (!TRANSCRIPTION_FORMATS.has(responseFormat)) {
    transcriptionBadRequest(res, `Invalid response_format '${responseFormat}'. Supported: json, text, verbose_json, vtt.`);
    return;
  }
  if (responseFormat === 'srt') {
    transcriptionBadRequest(
      res,
      "response_format 'srt' is not supported: no configured provider produces srt natively. Use json, text, verbose_json, or vtt.",
      'unsupported_format',
    );
    return;
  }
  let temperature: number | undefined;
  if (req.body?.temperature !== undefined && req.body.temperature !== '') {
    temperature = Number(req.body.temperature);
    if (!Number.isFinite(temperature) || temperature < 0 || temperature > 1) {
      transcriptionBadRequest(res, 'Invalid temperature: must be a number between 0 and 1.');
      return;
    }
  }
  const language = typeof req.body?.language === 'string' && req.body.language.trim() ? req.body.language.trim() : undefined;
  const prompt = typeof req.body?.prompt === 'string' && req.body.prompt ? req.body.prompt : undefined;

  try {
    const result = await runTranscription(model, {
      file: file.buffer,
      filename: file.originalname || 'audio',
      mimeType: file.mimetype,
      language,
      prompt,
      temperature,
      responseFormat,
    });
    res.setHeader('X-Provider', safeHeaderValue(result.platform));
    res.setHeader('X-Model', safeHeaderValue(result.modelId));
    if (responseFormat === 'text') {
      res.type('text/plain').send(result.text);
      return;
    }
    if (responseFormat === 'vtt') {
      res.type('text/vtt').send(result.vtt ?? '');
      return;
    }
    if (responseFormat === 'verbose_json' && Array.isArray(result.segments) && result.segments.length > 0) {
      res.json({
        task: 'transcribe',
        language: result.language ?? null,
        duration: result.duration ?? null,
        text: result.text,
        segments: result.segments,
      });
      return;
    }
    res.json({ text: result.text });
  } catch (err: any) {
    const status = err instanceof MediaError ? err.status : 502;
    const httpStatus = status >= 400 && status < 600 ? status : 502;
    const code = err instanceof MediaError && err.code ? { code: err.code } : {};
    res.status(httpStatus).json({ error: { message: `transcription error: ${err?.message ?? 'unknown'}`, type: mediaErrorType(status), ...code } });
  }
});

const CompletionBody = z.object({
  model: z.string().optional(),
  prompt: z.string(),
  suffix: z.string().optional(),
  temperature: z.number().min(0).max(2).optional(),
  max_tokens: z.number().int().optional(),
  top_p: z.number().min(0).max(1).optional(),
  stop: stopSchema.optional(),
  stream: z.boolean().optional(),
});

function completionPromptToMessages(prompt: string, suffix?: string): ChatMessage[] {
  const hasSuffix = suffix !== undefined && suffix.length > 0;
  return [
    {
      role: 'system',
      content: [
        'You are a code autocomplete engine.',
        'Complete at the cursor and return only the text to insert.',
        'Do not include markdown fences, explanations, or repeat surrounding code.',
      ].join(' '),
    },
    {
      role: 'user',
      content: hasSuffix
        ? `Prefix before cursor:\n${prompt}\n\nSuffix after cursor:\n${suffix}\n\nCompletion to insert:`
        : `Prefix before cursor:\n${prompt}\n\nCompletion to insert:`,
    },
  ];
}

function completionTextFromChat(result: any): string {
  return contentToString(result?.choices?.[0]?.message?.content ?? '');
}

function completionIdFromChat(id: string | undefined): string {
  if (!id) return `cmpl-${Date.now()}`;
  return id.startsWith('cmpl-') ? id : `cmpl-${id}`;
}

function legacyCompletionChunk(route: RouteResult, chunk: any, text: string) {
  return {
    id: completionIdFromChat(chunk?.id),
    object: 'text_completion',
    created: chunk?.created ?? Math.floor(Date.now() / 1000),
    model: route.modelId,
    choices: [{
      text,
      index: chunk?.choices?.[0]?.index ?? 0,
      logprobs: null,
      finish_reason: chunk?.choices?.[0]?.finish_reason ?? null,
    }],
  };
}

proxyRouter.post('/completions', async (req: Request, res: Response) => {
  const start = Date.now();
  const requestGroupId = getRequestGroupId(req);
  res.setHeader('X-Request-ID', requestGroupId);

  const auth = requireInferenceAuth(req, res);
  if (!auth) return;

  const parsed = CompletionBody.safeParse(req.body);
  if (!parsed.success) {
    const detail = parsed.error.errors
      .map(e => (e.path.length ? `${e.path.join('.')}: ${e.message}` : e.message))
      .slice(0, 5)
      .join(', ');
    res.status(400).json({
      error: { message: `Invalid request: ${detail}`, type: 'invalid_request_error' },
    });
    return;
  }

  const { model: requestedModel, prompt, suffix, temperature, top_p, stream } = parsed.data;
  const requestedModelLabel = requestedModel ?? 'auto';
  const max_tokens = parsed.data.max_tokens != null && parsed.data.max_tokens > 0
    ? parsed.data.max_tokens : 128;
  const stop = providerSafeStop(parsed.data.stop);
  // A profile's enforced prompt goes ahead of the autocomplete system message.
  const messages = prependSystemPrompt(completionPromptToMessages(prompt, suffix), auth.systemPrompt);
  const estimatedInputTokens = messages.reduce((sum, m) => sum + Math.ceil(contentToString(m.content).length / 4), 0);
  const estimatedTotal = estimatedInputTokens + max_tokens;

  // Guardrail: per-request token budget (request_max_tokens_budget, default
  // off). max_tokens always has a value on this surface (default 128), so a
  // violation can only reject — no capping branch.
  const budgetCheck = applyTokenBudget(estimatedInputTokens, max_tokens);
  if (budgetCheck.rejection) {
    res.status(413).json({
      error: { message: tokenBudgetMessage(budgetCheck.rejection), type: 'invalid_request_error', code: 'request_token_budget' },
    });
    return;
  }

  let resolvedChain: ResolvedChain | undefined;
  if (isAutoModel(requestedModel)) {
    resolvedChain = resolveRoutingChain(requestedModel);
  }

  let preferredModel: number | undefined;
  let groupChain: ChainRow[] | undefined;

  if (!isAutoModel(requestedModel) && requestedModel) {
    const db = getDb();
    const resolved = isUnifyEnabled() ? resolveRequestedIdForDispatch(requestedModel, getModelGroups()) : null;
    const members = resolved?.memberDbIds ?? null;
    if (members && members.length > 0) {
      groupChain = resolveModelGroupCandidates(members, resolved!.demotedDbIds);
      if (groupChain.length === 0) {
        const placeholders = members.map(() => '?').join(',');
        const anyEnabled = db.prepare(`SELECT 1 FROM models WHERE id IN (${placeholders}) AND enabled = 1 LIMIT 1`).get(...members);
        // Honest statuses: a model whose providers exist but have no usable key
        // is a server-side configuration gap (503), not a client mistake; a
        // disabled/unknown model is a 404 model_not_found (OpenAI semantics).
        if (anyEnabled) {
          res.status(503).json({
            error: {
              message: `Model '${requestedModel}' has no providers with an enabled key. Add a provider API key for it, use 'auto' (or omit the 'model' field) to auto-route, or call /v1/models for the available list.`,
              type: 'service_unavailable',
              code: 'no_providers_configured',
            },
          });
        } else {
          res.status(404).json({
            error: {
              message: `Model '${requestedModel}' is disabled. Use 'auto' (or omit the 'model' field) to auto-route, or call /v1/models for the available list.`,
              type: 'invalid_request_error',
              code: 'model_not_found',
            },
          });
        }
        return;
      }
    } else {
      const enabled = db.prepare('SELECT id FROM models WHERE model_id = ? AND enabled = 1').get(requestedModel) as { id: number } | undefined;
      if (enabled) {
        preferredModel = enabled.id;
      } else {
        const disabled = db.prepare('SELECT id FROM models WHERE model_id = ?').get(requestedModel) as { id: number } | undefined;
        const reason = disabled ? 'is disabled' : 'is not in the catalog';
        res.status(404).json({
          error: {
            message: `Model '${requestedModel}' ${reason}. Use 'auto' (or omit the 'model' field) to auto-route, or call /v1/models for the available list.`,
            type: 'invalid_request_error',
            code: 'model_not_found',
          },
        });
        return;
      }
    }
  }

  const pinnedModelId = requestedModel && !isAutoModel(requestedModel) ? requestedModel : null;
  const isExplicitPin = !!pinnedModelId;
  const skipKeys = new Set<string>();
  const skipModels = new Set<number>();
  let lastError: any = null;
  let modelGoneEntry: { platform: string; modelId: string; displayName: string; providerMessage: string } | null = null;
  const attemptLog: AttemptRecord[] = [];
  let clientGone = false;
  const clientAbort = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) {
      clientGone = true;
      clientAbort.abort(newClientAbortError());
    }
  });

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let route: RouteResult;
    try {
      route = await routeRequest(
        estimatedTotal,
        skipKeys.size > 0 ? skipKeys : undefined,
        preferredModel,
        false,
        false,
        skipModels.size > 0 ? skipModels : undefined,
        groupChain ?? resolvedChain?.chain,
        isStrictChainEnabled(),
        isExplicitPin,
      );
    } catch (err: any) {
      const disposition: string[] = Array.isArray(err.diagnostics) ? err.diagnostics : [];
      const hasRichFields = (Array.isArray(err.cooldown) && err.cooldown.length > 0)
        || err.unavailableModel
        || (Array.isArray(err.unavailableModels) && err.unavailableModels.length > 0);

      if (modelGoneEntry !== null) {
        const gone: { platform: string; modelId: string; displayName: string; providerMessage: string } = modelGoneEntry;
        res.status(410).json({
          error: {
            message: `Model '${gone.displayName}' on ${gone.platform} is no longer available. ${gone.providerMessage} Choose a different model or call /v1/models for the available list.`,
            type: 'model_gone',
            code: 'model_no_longer_available',
            model: { platform: gone.platform, id: gone.modelId, display_name: gone.displayName },
          },
        });
        return;
      }

      if (lastError && isProviderBadRequestError(lastError)) {
        res.status(400).json({
          error: {
            message: `All routed providers rejected the request as invalid. Last error: ${sanitizeProviderErrorMessage(lastError.message)}`,
            type: 'invalid_request_error',
          },
        });
        return;
      }

      if (lastError && !hasRichFields) {
        res.status(429).json({
          error: {
            message: `All models rate-limited. Last error: ${sanitizeProviderErrorMessage(lastError.message)}`,
            type: 'rate_limit_error',
          },
        });
        return;
      }

      const cooldownField = Array.isArray(err.cooldown) && err.cooldown.length > 0
        ? {
            cooldown: err.cooldown.map((c: any) => ({
              platform: c.platform,
              modelId: c.modelId,
              keyId: c.keyId,
              expiresAtMs: c.expiresAtMs,
              remainingSeconds: c.remainingSeconds,
              reason: c.reason,
            })),
            unavailableModel: err.unavailableModel,
          }
        : null;
      console.warn(
        `[Proxy] legacy completions routing exhausted (no upstream tried) req=${shortRequestId(requestGroupId)} ` +
        `requested=${requestedModelLabel} candidates=${disposition.length}` +
        (disposition.length ? `:\n  ${disposition.join('\n  ')}` : ''),
      );
      const errorBody: Record<string, unknown> = {
        message: err.message,
        type: (err.unavailableModel || (Array.isArray(err.unavailableModels) && err.unavailableModels.length > 0)) ? 'rate_limit_error' : 'routing_error',
      };
      if (cooldownField) {
        errorBody.cooldown = cooldownField.cooldown;
        if (cooldownField.unavailableModel) errorBody.unavailableModel = cooldownField.unavailableModel;
      }
      if (Array.isArray(err.unavailableModels) && err.unavailableModels.length > 0) {
        errorBody.unavailableModels = err.unavailableModels;
      }
      res.status(err.status ?? 503).json({ error: errorBody });
      return;
    }

    reserveKeySlot(route.platform, route.keyId);

    traceRouteEvent('Proxy', {
      event: attempt === 0 ? 'start' : 'next',
      requestId: requestGroupId,
      attempt,
      platform: route.platform,
      model: route.modelId,
      requestedModel: attempt === 0 ? requestedModelLabel : undefined,
    });

    try {
      if (stream) {
        let totalOutputTokens = 0;
        let headerSent = false;
        let ttfbMs: number | null = null;
        let sawText = false;
        let clientGone = false;
        req.on('close', () => { clientGone = true; });
        const buffered: unknown[] = [];

        const flushHeaders = () => {
          if (headerSent) return;
          ttfbMs = Date.now() - start;
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          res.setHeader('X-Routed-Via', routedViaValue(route.platform, route.modelId));
          setFallbackHeaders(res, attempt, attemptLog);
          headerSent = true;
          for (const frame of buffered) res.write(`data: ${JSON.stringify(frame)}\n\n`);
          buffered.length = 0;
        };

        try {
          const gen = route.provider.streamChatCompletion(
            route.apiKey,
            messages,
            route.modelId,
            { temperature, max_tokens, top_p, stop, signal: clientAbort.signal },
            quotaContextForRoute(route, 'chat/completions'),
          );

          for await (const chunk of gen) {
            if (clientGone) break; // client hung up: stop pulling; reader.cancel() aborts upstream
            const text = streamChunkText(chunk);
            if (text.length > 0) sawText = true;
            totalOutputTokens += Math.ceil(text.length / 4);
            const frame = legacyCompletionChunk(route, chunk, text);
            if (!headerSent && !sawText) {
              buffered.push(frame);
              continue;
            }
            flushHeaders();
            res.write(`data: ${JSON.stringify(frame)}\n\n`);
          }

          // Disconnect before the commit point: the break above fired with no
          // text seen, which is indistinguishable from an empty completion
          // below — but it is CLIENT behavior, not a provider failure. Without
          // this check every Ctrl-C during a reasoning model's TTFB window
          // benched the healthy model+key for 90s and logged a provider error.
          if (clientGone && !headerSent && !sawText) {
            console.log(`[Proxy] client disconnected before first token from ${route.displayName} — dropping attempt without benching`);
            return 'committed';
          }

          if (!sawText) {
            throw new Error(`empty completion from ${route.displayName} (legacy stream produced no text)`);
          }

          flushHeaders();
          res.write('data: [DONE]\n\n');
          res.end();

          recordRequest(route.platform, route.modelId, route.keyId);
          recordTokens(route.platform, route.modelId, route.keyId, estimatedInputTokens + totalOutputTokens);
          recordSuccess(route.modelDbId);
          traceRouteEvent('Proxy', {
            event: 'ok',
            requestId: requestGroupId,
            attempt,
            platform: route.platform,
            model: route.modelId,
            latencyMs: Date.now() - start,
            inputTokens: estimatedInputTokens,
            outputTokens: totalOutputTokens,
          });
          logRequest(route.platform, route.modelId, route.keyId, 'success', estimatedInputTokens, totalOutputTokens, Date.now() - start, null, ttfbMs, pinnedModelId);
          return;
        } catch (streamErr: any) {
          // Client abort mid-stream: the pump's own `if (clientGone) break`
          // can lose the race against the fetch-signal rejection, so the
          // abort may surface here instead. Rethrow — the shared loop's
          // client-abort branch stops the ladder without benching or an
          // error log row (the socket is gone; nothing to render).
          if (isClientAbortError(streamErr)) throw streamErr;
          if (headerSent) {
            console.error(`[Proxy] Mid-stream legacy completion error from ${route.displayName}:`, streamErr.message);
            const payload = { error: { message: `Provider error (${route.displayName}): stream interrupted`, type: 'stream_error' } };
            try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch { /* socket gone */ }
            try { res.write('data: [DONE]\n\n'); res.end(); } catch { /* socket gone */ }
            traceRouteEvent('Proxy', {
              event: 'fail',
              requestId: requestGroupId,
              attempt,
              platform: route.platform,
              model: route.modelId,
              latencyMs: Date.now() - start,
              error: sanitizeProviderErrorMessage(streamErr.message),
            });
            logRequest(route.platform, route.modelId, route.keyId, 'error', estimatedInputTokens, totalOutputTokens, Date.now() - start, sanitizeProviderErrorMessage(streamErr.message), ttfbMs, pinnedModelId);
            return;
          }
          throw streamErr;
        }
      } else {
        const result = await route.provider.chatCompletion(
          route.apiKey,
          messages,
          route.modelId,
          { temperature, max_tokens, top_p, stop, signal: clientAbort.signal },
          quotaContextForRoute(route, 'chat/completions'),
        );

        const text = completionTextFromChat(result);
        if (!text) {
          throw Object.assign(
            new Error(`empty completion from ${route.displayName}`),
            result.choices?.[0]?.finish_reason === 'length' ? { skipBench: true } : {},
          );
        }

        const promptTokens = result.usage?.prompt_tokens ?? estimatedInputTokens;
        const completionTokens = result.usage?.completion_tokens ?? Math.ceil(text.length / 4);
        const totalTokens = result.usage?.total_tokens ?? (promptTokens + completionTokens);
        recordRequest(route.platform, route.modelId, route.keyId);
        recordTokens(route.platform, route.modelId, route.keyId, totalTokens);
        recordSuccess(route.modelDbId);

        const legacySpent = result.usage ? responseCostFor(route.platform, route.modelId, {
          prompt: result.usage.prompt_tokens ?? 0,
          completion: result.usage.completion_tokens ?? 0,
          cached: usageCachedTokens(result.usage),
        }) : undefined;
        if (legacySpent !== undefined && result.usage) result.usage.cost = legacySpent;

        res.setHeader('X-Routed-Via', routedViaValue(route.platform, route.modelId));
        setFallbackHeaders(res, attempt, attemptLog);
        res.json({
          id: completionIdFromChat(result.id),
          object: 'text_completion',
          created: result.created ?? Math.floor(Date.now() / 1000),
          model: route.modelId,
          choices: [{
            text,
            index: result.choices?.[0]?.index ?? 0,
            logprobs: null,
            finish_reason: result.choices?.[0]?.finish_reason ?? 'stop',
          }],
          usage: result.usage,
          ...(legacySpent !== undefined ? { spent: legacySpent } : {}),
        });

        traceRouteEvent('Proxy', {
          event: 'ok',
          requestId: requestGroupId,
          attempt,
          platform: route.platform,
          model: route.modelId,
          latencyMs: Date.now() - start,
          inputTokens: result.usage?.prompt_tokens ?? 0,
          outputTokens: result.usage?.completion_tokens ?? 0,
        });
        logRequest(route.platform, route.modelId, route.keyId, 'success', promptTokens, completionTokens, Date.now() - start, null, null, pinnedModelId, null, usageCachedTokens(result.usage));
        return;
      }
    } catch (err: any) {
      const latency = Date.now() - start;
      const safeError = sanitizeProviderErrorMessage(err.message);
      traceRouteEvent('Proxy', {
        event: 'fail',
        requestId: requestGroupId,
        attempt,
        platform: route.platform,
        model: route.modelId,
        latencyMs: latency,
        error: safeError,
      });
      logRequest(route.platform, route.modelId, route.keyId, 'error', estimatedInputTokens, 0, latency, safeError, null, pinnedModelId);

      if (isRetryableError(err)) {
        if (isModelNotFoundError(err) || isModelAccessForbiddenError(err)) skipModels.add(route.modelDbId);
        const modelGone = isModelGoneError(err);
        if (!isZenAnonymousKey(route.platform, route.keyId)) {
          skipKeys.add(`${route.platform}:${route.modelId}:${route.keyId}`);
          setCooldown(
            route.platform,
            route.modelId,
            route.keyId,
            modelGone
              ? MODEL_GONE_COOLDOWN_MS
              : isPaymentRequiredError(err)
              ? PAYMENT_REQUIRED_COOLDOWN_MS
              : isModelAccessForbiddenError(err)
              ? MODEL_FORBIDDEN_COOLDOWN_MS
              : getCooldownDurationForLimit(route.platform, route.modelId, route.keyId, {
                  rpd: route.rpdLimit,
                  tpd: route.tpdLimit,
                }, err.retryAfterMs, { quotaSignal: isRateLimitSignal(err) }),
            'heuristic',
            modelGone ? 'model_eol' : undefined,
          );
          if (!hasOtherUsableKey(route.modelDbId, route.keyId, skipKeys)) {
            recordRateLimitHit(route.modelDbId);
          }
          learnLimitFromError(route.modelDbId, err);
        }
        if (modelGone && !modelGoneEntry) {
          modelGoneEntry = {
            platform: route.platform,
            modelId: route.modelId,
            displayName: route.displayName,
            providerMessage: safeError,
          };
        }
        lastError = err;
        continue;
      }

      res.status(502).json({
        error: {
          message: `Provider error (${route.displayName}): ${safeError}`,
          type: 'provider_error',
        },
      });
      return;
    } finally {
      route.release?.();
      releaseKeySlot(route.platform, route.keyId);
    }
  }

  if (modelGoneEntry !== null) {
    const gone: { platform: string; modelId: string; displayName: string; providerMessage: string } = modelGoneEntry;
    res.status(410).json({
      error: {
        message: `Model '${gone.displayName}' on ${gone.platform} is no longer available. ${gone.providerMessage} Choose a different model or call /v1/models for the available list.`,
        type: 'model_gone',
        code: 'model_no_longer_available',
        model: { platform: gone.platform, id: gone.modelId, display_name: gone.displayName },
      },
    });
    return;
  }

  res.status(429).json({
    error: {
      message: `All models rate-limited after ${MAX_RETRIES} attempts. Last: ${sanitizeProviderErrorMessage(lastError?.message)}`,
      type: 'rate_limit_error',
    },
  });
});

proxyRouter.post('/chat/completions', async (req: Request, res: Response) => {
  const start = Date.now();
  const clientIp = getClientIp(req);
  const requestGroupId = getRequestGroupId(req);
  res.setHeader('X-Request-ID', requestGroupId);

const auth = requireInferenceAuth(req, res);
  if (!auth) return;

  const parsed = chatCompletionSchema.safeParse(req.body);
  if (!parsed.success) {
    const detail = parsed.error.errors
      .map(e => (e.path.length ? `${e.path.join('.')}: ${e.message}` : e.message))
      .slice(0, 5)
      .join(', ');
    console.warn(`[proxy] 400 invalid /chat/completions request: ${detail}`);
    res.status(400).json({
      error: {
        message: `Invalid request: ${detail}`,
        type: 'invalid_request_error',
      },
    });
    return;
  }

  const { model: requestedModel, temperature, top_p, stream } = parsed.data;
  const requestedModelLabel = requestedModel ?? 'auto';
  // Agent-tolerant knob normalization (#200): max_tokens <= 0 means "no
  // limit" in several clients → unset; tool_choice 'any' is OpenAI's
  // 'required'; tool definitions get their 'function' type re-defaulted.
  // `max_completion_tokens` is OpenAI's newer alias — honored when max_tokens
  // itself is absent. `let`: the token-budget guardrail below may cap an
  // absent max_tokens to the budget remainder before the options objects are
  // built from it.
  const requestedMaxTokens = parsed.data.max_tokens ?? parsed.data.max_completion_tokens;
  let max_tokens = requestedMaxTokens != null && requestedMaxTokens > 0
    ? requestedMaxTokens : undefined;
  // Extended sampling/output params (seed, penalties, response_format…),
  // spread into every options object below — including fusion fan-out.
  const samplingParams = pickSamplingParams(parsed.data);
  const stop = providerSafeStop(parsed.data.stop);
  const tool_choice = parsed.data.tool_choice === 'any' ? 'required' as const : parsed.data.tool_choice ?? undefined;
  const tools = parsed.data.tools?.map(t => ({ ...t, type: 'function' as const }));
  const parallel_tool_calls = parsed.data.parallel_tool_calls ?? undefined;
  const reasoning_effort = parsed.data.reasoning_effort ?? undefined;
  const reasoning = parsed.data.reasoning ?? undefined;
  const include_reasoning = parsed.data.include_reasoning ?? undefined;
  const stream_options = streamOptionsWithUsage(stream, parsed.data.stream_options);
  const completionOptions = { temperature, max_tokens, top_p, stop, tools, tool_choice, parallel_tool_calls, reasoning_effort, reasoning, include_reasoning, stream_options, ...samplingParams };

  const pendingToolCallIds: string[] = [];
  let syntheticIdCounter = 0;
  const takeToolCallId = (given: string | undefined): string => {
    if (given && given.length > 0) {
      const qi = pendingToolCallIds.indexOf(given);
      if (qi !== -1) pendingToolCallIds.splice(qi, 1);
      return given;
    }
    return pendingToolCallIds.shift() ?? `call_auto_${++syntheticIdCounter}`;
  };

  let messages: ChatMessage[] = parsed.data.messages.map((m): ChatMessage => {
    if (m.role === 'assistant') {
      const hasToolCalls = (m.tool_calls?.length ?? 0) > 0;
      const isEmptyContent = m.content == null
        || (typeof m.content === 'string' && m.content.length === 0)
        || (Array.isArray(m.content) && m.content.length === 0);
      const assistantContent: ChatMessage['content'] = hasToolCalls
        ? (m.content ?? null)
        : (isEmptyContent ? '' : m.content!);
      return {
        role: 'assistant',
        content: assistantContent,
        ...(m.name ? { name: m.name } : {}),
        ...(typeof m.reasoning_content === 'string' && m.reasoning_content.length > 0
          ? { reasoning_content: m.reasoning_content }
          : {}),
        ...(hasToolCalls ? { tool_calls: m.tool_calls!.map(tc => {
          const id = tc.id && tc.id.length > 0 ? tc.id : `call_auto_${++syntheticIdCounter}`;
          pendingToolCallIds.push(id);
          return {
            id,
            type: 'function' as const,
            function: { name: tc.function.name, arguments: toolCallArgsToString(tc.function.arguments) },
            thought_signature: tc.thought_signature,
          };
        }) } : {}),
      };
    }

    if (m.role === 'tool') {
      return {
        role: 'tool',
        content: m.content ?? '',
        tool_call_id: takeToolCallId(m.tool_call_id),
        ...(m.name ? { name: m.name } : {}),
      };
    }

    if (m.role === 'function') {
      return {
        role: 'tool',
        content: m.content ?? '',
        tool_call_id: takeToolCallId(undefined),
        name: m.name,
      };
    }

    return {
      role: m.role === 'developer' ? 'system' : m.role,
      content: m.content,
      ...(m.name ? { name: m.name } : {}),
    };
  });

  let cacheControlPrefixLength = 0;
  parsed.data.messages.forEach((message, index) => {
    const content = message.content;
    if (
      Array.isArray(content)
      && content.some(block => block && typeof block === 'object' && 'cache_control' in block)
    ) {
      cacheControlPrefixLength = index + 1;
    }
  });
  const compressionResult = compressRequest(messages, {
    header: req.headers['x-freellm-compress'],
    tools,
    cacheControlPrefixLength,
  });
  messages = compressionResult.messages;
  res.setHeader('X-FreeLLM-Compress', formatCompressionHeader(compressionResult));

messages = prependSystemPrompt(messages, auth.systemPrompt);

  const estimatedInputTokens = messages.reduce((sum, m) => {
    const text = contentToString(m.content);
    return sum + Math.ceil(text.length / 4);
  }, 0);

  const hasImage = messageHasImage(messages);
  if (hasImage && !hasEnabledVisionModel()) {
    res.status(422).json({
      error: {
        message: 'This request includes an image, but no vision-capable model is enabled. Enable a vision model (e.g. Gemini 2.5 Flash, Llama 4 Scout) in the Fallback Chain.',
        type: 'invalid_request_error',
        code: 'no_vision_model',
      },
    });
    return;
  }
  const IMAGE_TOKEN_ESTIMATE = 1000;
  const imageCount = messages.reduce((n, m) =>
    n + (Array.isArray(m.content) ? m.content.filter(b => (b as { type?: string })?.type === 'image_url' || (b as { type?: string })?.type === 'image').length : 0), 0);
  const estimatedTotal = estimatedInputTokens + imageCount * IMAGE_TOKEN_ESTIMATE + routingReserveTokens(max_tokens);

  const wantsTools = (tools?.length ?? 0) > 0;
  if (wantsTools && !hasEnabledToolsModel()) {
    res.status(422).json({
      error: {
        message: 'This request includes tools, but no tool-capable model is enabled. Enable a tool-calling model (e.g. GPT-OSS 120B, Gemini 3.5 Flash, GLM-4.7) in the Fallback Chain.',
        type: 'invalid_request_error',
        code: 'no_tools_model',
      },
    });
    return;
  }

  // Guardrail: per-request token budget (request_max_tokens_budget, default
  // off). Estimated input (incl. images) + requested output must fit the
  // ceiling; a request with no max_tokens gets its output capped to the
  // remainder instead. Sits before the Fusion branch so fan-out inherits the
  // capped max_tokens too.
  const budgetCheck = applyTokenBudget(estimatedInputTokens + imageCount * IMAGE_TOKEN_ESTIMATE, max_tokens);
  if (budgetCheck.rejection) {
    res.status(413).json({
      error: { message: tokenBudgetMessage(budgetCheck.rejection), type: 'invalid_request_error', code: 'request_token_budget' },
    });
    return;
  }
  max_tokens = budgetCheck.maxTokens;

  // ── Fusion: multi-model synthesis ──────────────────────────────────────────
  // The virtual "fusion" model fans the prompt out to a panel of diverse models
  // in parallel, then a judge synthesizes one answer. It routes each panel/judge
  // sub-call through the normal path (cooldowns, quotas, analytics), so it
  // behaves like a normal model from the client's side — just K+1x the tokens.
  // Vision is still rejected up front; tool requests run on tool-capable panel
  // members and return the first structured tool call directly.
  if (isFusionModel(requestedModel)) {
    if (hasImage) {
      res.status(422).json({ error: { message: 'Fusion does not support image input yet. Use a vision model directly.', type: 'invalid_request_error', code: 'fusion_no_vision' } });
      return;
    }
    const fusionOptions = { temperature, max_tokens, top_p, stop, tools, tool_choice, parallel_tool_calls, ...samplingParams };
    const fusionConfig = parsed.data.fusion ?? {};

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      const writeFrame = (o: unknown) => { try { res.write(`data: ${JSON.stringify(o)}\n\n`); } catch { /* socket gone */ } };
      const streamId = `fusion-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
      const base = { id: streamId, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: FUSION_MODEL_ID };
      let answerStarted = false;
      try {
        const { response } = await runFusion({
          messages,
          config: fusionConfig,
          options: fusionOptions,
          estimatedTokens: estimatedTotal,
          clientIp,
          hooks: {
            onPanel: (a) => writeFrame({
              ...base,
              choices: [{ index: 0, delta: {}, finish_reason: null }],
              _fusion: { event: 'panel', ...a },
            }),
            onJudge: (j) => writeFrame({
              ...base,
              choices: [{ index: 0, delta: {}, finish_reason: null }],
              _fusion: { event: 'judge', ...j },
            }),
            onJudgeDelta: (delta) => {
              if (!answerStarted) { writeFrame({ ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] }); answerStarted = true; }
              writeFrame({ ...base, choices: [{ index: 0, delta: { content: delta }, finish_reason: null }] });
            },
          },
        });
        const finalMsg = response.choices[0]?.message;
        const finalToolCalls = (finalMsg as { tool_calls?: ChatToolCall[] } | undefined)?.tool_calls;
        const hasFinalToolCalls = Array.isArray(finalToolCalls) && finalToolCalls.length > 0;
        if (hasFinalToolCalls) {
          writeFrame({ ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
          writeFrame({ ...base, choices: [{ index: 0, delta: { tool_calls: finalToolCalls }, finish_reason: null }] });
          writeFrame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: response.usage });
        } else {
          if (!answerStarted) {
            const finalText = contentToString(finalMsg?.content ?? '');
            writeFrame({ ...base, choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] });
            writeFrame({ ...base, choices: [{ index: 0, delta: { content: finalText }, finish_reason: null }] });
          }
          writeFrame({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: response.usage });
        }
      } catch (err: any) {
        const message = err instanceof FusionError ? err.message : `fusion error: ${sanitizeProviderErrorMessage(err?.message)}`;
        const type = err instanceof FusionError && err.status === 429 ? 'rate_limit_error' : 'server_error';
        writeFrame({ error: { message, type } });
      }
      try { res.write('data: [DONE]\n\n'); res.end(); } catch { /* socket gone */ }
      return;
    }

    try {
      const { response, routedVia } = await runFusion({
        messages,
        config: fusionConfig,
        options: fusionOptions,
        estimatedTokens: estimatedTotal,
        clientIp,
      });
      // Structured-output enforcement for fusion (#516 scope gap): the panel/
      // judge output got no format check, so model:"fusion" could hand back
      // prose as a "success" for a json_schema request. Fusion has no failover
      // machinery to hand this to — heal what's healable, otherwise answer
      // honestly instead of pretending. (Streaming fusion stays unenforced,
      // same boundary as every other streamed response.)
      const fusionMsg = (response as any)?.choices?.[0]?.message;
      if (samplingParams.response_format && fusionMsg && !fusionMsg.tool_calls?.length) {
        const fusionText = contentToString(fusionMsg.content ?? '');
        if (fusionText) {
          const enforced = enforceJsonContent(fusionText);
          if (!enforced.ok) {
            res.status(502).json({ error: { message: `fusion produced non-JSON output despite response_format=${samplingParams.response_format.type} — retry, or pin a structured-output-capable model instead of "fusion"`, type: 'server_error' } });
            return;
          }
          if (enforced.healed) fusionMsg.content = enforced.content;
        }
      }
      res.setHeader('X-Routed-Via', safeHeaderValue(routedVia));
      res.json(response);
    } catch (err: any) {
      if (err instanceof FusionError) {
        res.status(err.status).json({ error: { message: err.message, type: err.status === 429 ? 'rate_limit_error' : 'invalid_request_error' } });
      } else {
        res.status(502).json({ error: { message: `fusion error: ${sanitizeProviderErrorMessage(err?.message)}`, type: 'server_error' } });
      }
    }
    return;
  }

  // ── Response cache (services/cache.ts) ──
  // Opt-in exact-match cache. An identical earlier request is replayed from an
  // in-memory LRU without spending any provider quota. Computed here, after
  // message + sampling-param normalization but before any routing/session work,
  // so a hit short-circuits the whole pipeline. Only NON-streaming requests at a
  // cacheable temperature are eligible (v1 scope: streaming always bypasses); a
  // per-request `X-FreeLLM-Cache` header can force or bypass. Off unless enabled
  // via the RESPONSE_CACHE env var or the response_cache_enabled setting.
  const cacheDirective = parseCacheDirective(req.headers['x-freellm-cache'], req.headers['cache-control']);
  const cacheKey = (!stream && cacheActive(cacheDirective) && isCacheableTemperature(temperature))
    ? computeCacheKey({
        model: requestedModel, messages, temperature, top_p, max_tokens, tools, tool_choice,
        stop,
        response_format: req.body?.response_format ?? undefined,
        n: req.body?.n ?? undefined,
        seed: req.body?.seed ?? undefined,
        presence_penalty: req.body?.presence_penalty ?? undefined,
        frequency_penalty: req.body?.frequency_penalty ?? undefined,
        logit_bias: req.body?.logit_bias ?? undefined,
        logprobs: req.body?.logprobs ?? undefined,
        top_logprobs: req.body?.top_logprobs ?? undefined,
        reasoning_effort: samplingParams.reasoning_effort ?? undefined,
        compression: compressionResult.cacheKey,
      })
    : null;
  if (cacheKey) {
    const hit = getCachedResponse(cacheKey);
    if (hit) {
      res.setHeader('X-Routed-Via', 'cache');
      res.setHeader('X-FreeLLM-Cache', 'HIT');
      res.json(hit.body);
      return;
    }
  }

  const rawSessionId = req.headers['x-session-id'];
  const sessionIdHeader = Array.isArray(rawSessionId) ? rawSessionId[0] : rawSessionId;

  let resolvedChain: ResolvedChain | undefined;
  let strategyKey: string | undefined;

  if (isAutoModel(requestedModel)) {
    resolvedChain = resolveRoutingChain(requestedModel);
    strategyKey = resolvedChain.strategyKey;
  }

  const isAutoRouted = !requestedModel || isAutoModel(requestedModel);
  const handoffMode = isAutoRouted ? getContextHandoffMode() : ('off' as const);
  const sessionKey = handoffMode !== 'off' ? getSessionKey(messages, sessionIdHeader, strategyKey) : '';
  if (handoffMode !== 'off' && sessionKey) {
    recordIncomingMessages(sessionKey, messages);
  }
  const handoffPossible = handoffMode !== 'off' && !!sessionKey && hasPriorModel(sessionKey);

  let preferredModel: number | undefined;
  let groupChain: ChainRow[] | undefined;
  let stickyStrategyKey: string | undefined = strategyKey;

  if (isAutoModel(requestedModel)) {
    preferredModel = healthyAutoSticky(messages, sessionIdHeader, strategyKey, resolvedChain?.chain);
  } else if (requestedModel) {
    const db = getDb();
    // Unify ON: a requested id (canonical slug OR any provider's model_id) maps
    // to the whole logical-model group, and we route STRICTLY across only its
    // providers — failing over between them, never to a different model (#335).
    const resolved = isUnifyEnabled() ? resolveRequestedIdForDispatch(requestedModel, getModelGroups()) : null;
    const members = resolved?.memberDbIds ?? null;
    if (members && members.length > 0) {
      groupChain = resolveModelGroupCandidates(members, resolved!.demotedDbIds);
      if (groupChain.length === 0) {
        const placeholders = members.map(() => '?').join(',');
        const anyEnabled = db.prepare(`SELECT 1 FROM models WHERE id IN (${placeholders}) AND enabled = 1 LIMIT 1`).get(...members);
        if (anyEnabled) {
          res.status(503).json({
            error: {
              message: `Model '${requestedModel}' has no providers with an enabled key. Add a provider API key for it, use 'auto' (or omit the 'model' field) to auto-route, or call /v1/models for the available list.`,
              type: 'service_unavailable',
              code: 'no_providers_configured',
            },
          });
        } else {
          res.status(404).json({
            error: {
              message: `Model '${requestedModel}' is disabled. Use 'auto' (or omit the 'model' field) to auto-route, or call /v1/models for the available list.`,
              type: 'invalid_request_error',
              code: 'model_not_found',
            },
          });
        }
        return;
      }
      stickyStrategyKey = requestedModel;
      const sticky = getStickyModel(messages, sessionIdHeader, stickyStrategyKey);
      preferredModel = (sticky != null && groupChain.some(r => r.model_db_id === sticky)) ? sticky : undefined;
    } else {
      const enabled = db.prepare('SELECT id FROM models WHERE model_id = ? AND enabled = 1').get(requestedModel) as { id: number } | undefined;
      if (enabled) {
        preferredModel = enabled.id;
      } else {
        const disabled = db.prepare('SELECT id FROM models WHERE model_id = ?').get(requestedModel) as { id: number } | undefined;
        const reason = disabled ? 'is disabled' : 'is not in the catalog';
        res.status(404).json({
          error: {
            message: `Model '${requestedModel}' ${reason}. Use 'auto' (or omit the 'model' field) to auto-route, or call /v1/models for the available list.`,
            type: 'invalid_request_error',
            code: 'model_not_found',
          },
        });
        return;
      }
    }
  } else {
    preferredModel = healthyAutoSticky(messages, sessionIdHeader, strategyKey, resolvedChain?.chain);
  }

  const pinnedModelId = requestedModel && !isAutoModel(requestedModel) ? requestedModel : null;
  const isExplicitPin = !!pinnedModelId;

  const skipKeys = new Set<string>();
  const skipModels = new Set<number>();
  let lastError: any = null;
  let modelGoneEntry: { platform: string; modelId: string; displayName: string; providerMessage: string } | null = null;
  const attemptLog: AttemptRecord[] = [];
  let clientGone = false;
  const clientAbort = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) {
      clientGone = true;
      clientAbort.abort(newClientAbortError());
    }
  });

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let route: RouteResult;
    try {
      const routingEstimate = handoffPossible ? estimatedTotal + HANDOFF_MAX_TOKENS : estimatedTotal;
      route = await routeRequest(routingEstimate, skipKeys.size > 0 ? skipKeys : undefined, preferredModel, hasImage, wantsTools, skipModels.size > 0 ? skipModels : undefined, groupChain ?? resolvedChain?.chain, isStrictChainEnabled(), isExplicitPin);
    } catch (err: any) {
      const disposition: string[] = Array.isArray(err.diagnostics) ? err.diagnostics : [];
      const hasRichFields = (Array.isArray(err.cooldown) && err.cooldown.length > 0)
        || err.unavailableModel
        || (Array.isArray(err.unavailableModels) && err.unavailableModels.length > 0);

      if (disposition.length > 0 && disposition.every(d => d.includes('< estimated'))) {
        res.status(413).json({
          error: {
            message: `The request is too large for every available candidate's context or token window. Reduce the prompt/history size or enable a model with a larger context window. ${err.message}`,
            type: 'invalid_request_error',
            code: 'context_length_exceeded',
          },
        });
        return;
      }

      if (modelGoneEntry !== null) {
        const gone: { platform: string; modelId: string; displayName: string; providerMessage: string } = modelGoneEntry;
        res.status(410).json({
          error: {
            message: `Model '${gone.displayName}' on ${gone.platform} is no longer available. ${gone.providerMessage} Choose a different model or call /v1/models for the available list.`,
            type: 'model_gone',
            code: 'model_no_longer_available',
            model: { platform: gone.platform, id: gone.modelId, display_name: gone.displayName },
          },
        });
        return;
      }

      if (lastError && isProviderBadRequestError(lastError)) {
        res.status(400).json({
          error: {
            message: `All routed providers rejected the request as invalid. Last error: ${sanitizeProviderErrorMessage(lastError.message)}`,
            type: 'invalid_request_error',
          },
        });
        return;
      }

      if (lastError && !hasRichFields) {
        const safeLastError = sanitizeProviderErrorMessage(lastError.message);
        res.status(429).json({
          error: {
            message: `All models rate-limited. Last error: ${safeLastError}`,
            type: 'rate_limit_error',
          },
        });
        return;
      }

      const cooldownField = Array.isArray(err.cooldown) && err.cooldown.length > 0
        ? {
            cooldown: err.cooldown.map((c: any) => ({
              platform: c.platform,
              modelId: c.modelId,
              keyId: c.keyId,
              expiresAtMs: c.expiresAtMs,
              remainingSeconds: c.remainingSeconds,
              reason: c.reason,
            })),
            unavailableModel: err.unavailableModel,
          }
        : null;
      console.warn(
        `[Proxy] routing exhausted (no upstream tried) req=${shortRequestId(requestGroupId)} ` +
        `requested=${requestedModelLabel} candidates=${disposition.length}` +
        (disposition.length ? `:\n  ${disposition.join('\n  ')}` : ''),
      );
      const errorBody: Record<string, unknown> = {
        message: err.message,
        type: (err.unavailableModel || (Array.isArray(err.unavailableModels) && err.unavailableModels.length > 0)) ? 'rate_limit_error' : 'routing_error',
      };
      if (cooldownField) {
        errorBody.cooldown = cooldownField.cooldown;
        if (cooldownField.unavailableModel) errorBody.unavailableModel = cooldownField.unavailableModel;
      }
      if (Array.isArray(err.unavailableModels) && err.unavailableModels.length > 0) {
        errorBody.unavailableModels = err.unavailableModels;
      }
      res.status(err.status ?? 503).json({ error: errorBody });
      return;
    }

    reserveKeySlot(route.platform, route.keyId);

    const modelKey = `${route.platform}:${route.modelId}`;
    traceRouteEvent('Proxy', {
      event: attempt === 0 ? 'start' : 'next',
      requestId: requestGroupId,
      attempt,
      platform: route.platform,
      model: route.modelId,
      requestedModel: attempt === 0 ? requestedModelLabel : undefined,
    });
    let outboundMessages = messages;
    let injectedHandoffTokens = 0;
    if (handoffMode !== 'off' && sessionKey) {
      const handoff = maybeInjectContextHandoff({ mode: handoffMode, sessionKey, messages, selectedModelKey: modelKey });
      if (handoff.injected) providerLog(`Context handoff injected (session ${sessionKey.slice(0, 8)}…, model switch detected)`, { level: 'info', provider: route.platform, model: route.modelId, event: 'context_handoff', requestId: requestGroupId });
      outboundMessages = handoff.messages;
      injectedHandoffTokens = handoff.injectedTokens;
    }
    outboundMessages = backfillToolCallReasoning(outboundMessages, route.platform);

    try {
      if (stream) {
        let totalOutputTokens = 0;
        let headerSent = false;
        let ttfbMs: number | null = null;
        let clientGone = false;
        req.on('close', () => { clientGone = true; });

        let mode: 'undecided' | 'passthrough' | 'dialect' = 'undecided';
        let heldText = '';
        let heldReasoning = '';
        const preamble: unknown[] = [];
        const toolCallAcc = new Map<number, { id?: string; name: string; args: string }>();
        let upstreamFinish: string | null = null;
        let usageChunk: unknown = null;
        let cachedFromStream = 0;
        let streamInputTokens = estimatedInputTokens + injectedHandoffTokens;
        let lastMeta: { id?: string; model?: string; created?: number } = {};
        // Raw upstream-reported model, captured off the first frame that
        // carries one — BEFORE the per-frame overwrite below destroys it.
        // Only evidence when a provider serves a different model than routed
        // (#534); compared/persisted on success via observeServedModel.
        let upstreamModel: string | null = null;

        const flushHeaders = () => {
          if (headerSent) return;
          ttfbMs = Date.now() - start;
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache, no-transform');
          res.setHeader('Connection', 'keep-alive');
          res.setHeader('X-Accel-Buffering', 'no');
          res.setHeader('X-Routed-Via', routedViaValue(route.platform, route.modelId));
          setFallbackHeaders(res, attempt, attemptLog);
          headerSent = true;
          for (const p of preamble) res.write(`data: ${JSON.stringify(p)}\n\n`);
          preamble.length = 0;
        };
        const mkChunk = (delta: Record<string, unknown>, finish: string | null) => ({
          id: lastMeta.id ?? `chatcmpl-${Date.now()}`,
          object: 'chat.completion.chunk',
          created: lastMeta.created ?? Math.floor(Date.now() / 1000),
          model: lastMeta.model ?? route.modelId,
          choices: [{ index: 0, delta, finish_reason: finish }],
        });
        const writeChunk = (c: unknown) => res.write(`data: ${JSON.stringify(c)}\n\n`);

        try {
          const gen = route.provider.streamChatCompletion(
            route.apiKey, outboundMessages, route.modelId,
            { temperature, max_tokens, top_p, stop, tools, tool_choice, parallel_tool_calls, stream_options, ...samplingParams, signal: clientAbort.signal },
            quotaContextForRoute(route, 'chat/completions'),
          );

          for await (const chunk of gen) {
            if (clientGone) break; // client hung up: stop pulling; reader.cancel() aborts upstream
            // Provider metadata is not authoritative for the public gateway
            // response. Some OpenAI-compatible providers (notably Reka) return
            // the literal model name "default" even when a concrete model was
            // requested. Normalize every streamed frame at the proxy boundary
            // so clients consistently see the model that was actually routed.
            const rawChunkModel = (chunk as Record<string, any>).model;
            if (upstreamModel == null && typeof rawChunkModel === 'string' && rawChunkModel.length > 0) {
              upstreamModel = rawChunkModel;
            }
            const anyChunk: Record<string, any> = { ...(chunk as Record<string, any>), model: route.modelId };

            if (anyChunk.error && !anyChunk.choices) {
              const msg = anyChunk.error.message ?? JSON.stringify(anyChunk.error).slice(0, 200);
              if (!headerSent) throw new Error(`in-band provider error from ${route.displayName}: ${msg}`);
              providerLog(`In-band error frame from ${route.displayName} mid-stream: ${msg}`, { level: 'error', provider: route.platform, model: route.modelId, event: 'stream_error', requestId: requestGroupId });
              writeChunk({ error: { message: `Provider error (${route.displayName}): ${sanitizeProviderErrorMessage(String(msg))}`, type: 'stream_error' } });
              try { res.write('data: [DONE]\n\n'); res.end(); } catch { /* socket gone */ }
              traceRouteEvent('Proxy', {
                event: 'fail',
                requestId: requestGroupId,
                attempt,
                platform: route.platform,
                model: route.modelId,
                latencyMs: Date.now() - start,
                error: sanitizeProviderErrorMessage(String(msg)),
              });
              logRequest(route.platform, route.modelId, route.keyId, 'error', streamInputTokens, totalOutputTokens, Date.now() - start, `in-band error frame: ${sanitizeProviderErrorMessage(String(msg))}`, ttfbMs, pinnedModelId, clientIp, cachedFromStream);
              return;
            }

            if (anyChunk.id) lastMeta = { id: anyChunk.id, model: anyChunk.model, created: anyChunk.created };

            if (anyChunk.usage) {
              normalizeUsage(anyChunk.usage);
              cachedFromStream = usageCachedTokens(anyChunk.usage);
              if (typeof anyChunk.usage.prompt_tokens === 'number') streamInputTokens = anyChunk.usage.prompt_tokens;
              usageChunk = {
                id: anyChunk.id ?? lastMeta.id ?? `chatcmpl-${Date.now()}`,
                object: 'chat.completion.chunk',
                created: anyChunk.created ?? lastMeta.created ?? Math.floor(Date.now() / 1000),
                model: anyChunk.model ?? lastMeta.model ?? route.modelId,
                choices: [],
                usage: anyChunk.usage,
              };
            }

            const choice = anyChunk.choices?.[0];
            if (!choice) {
              continue;
            }

            if (choice.finish_reason) upstreamFinish = choice.finish_reason;

            for (const tc of choice.delta?.tool_calls ?? []) {
              const idx = tc.index ?? 0;
              if (!toolCallAcc.has(idx)) toolCallAcc.set(idx, { id: undefined, name: '', args: '' });
              const acc = toolCallAcc.get(idx)!;
              if (tc.id && !acc.id) acc.id = tc.id;
              if (tc.function?.name) acc.name += tc.function.name;
              if (tc.function?.arguments) acc.args += tc.function.arguments;
            }

            normalizeOutboundContent(anyChunk);
            sanitizeResponse(anyChunk);
            const text = typeof choice.delta?.content === 'string' ? choice.delta.content : '';

            const reasoningText =
              typeof choice.delta?.reasoning_content === 'string' ? choice.delta.reasoning_content
              : typeof (choice.delta as Record<string, unknown> | undefined)?.reasoning === 'string'
                ? (choice.delta as Record<string, unknown>).reasoning as string
                : '';
            heldReasoning += reasoningText;
            if (reasoningText.length > 0 && text.length === 0) {
              flushHeaders();
              totalOutputTokens += Math.ceil(reasoningText.length / 4);
              writeChunk({ ...anyChunk, choices: [{ ...choice, delta: { ...choice.delta, tool_calls: undefined }, finish_reason: null }] });
              continue;
            }

            if (text.length === 0) {
              if (choice.delta && Object.keys(choice.delta).some(k => k !== 'content' && k !== 'tool_calls' && choice.delta[k] != null)) {
                const cleaned = { ...anyChunk, choices: [{ ...choice, delta: { ...choice.delta, tool_calls: undefined }, finish_reason: null }] };
                if (headerSent) writeChunk(cleaned); else preamble.push(cleaned);
              }
              continue;
            }

            totalOutputTokens += Math.ceil(text.length / 4);

            if (mode === 'passthrough') {
              writeChunk({ ...anyChunk, choices: [{ ...choice, delta: { ...choice.delta, tool_calls: undefined }, finish_reason: null }] });
              continue;
            }

            heldText += text;
            if (mode === 'dialect') continue;

            const probe = heldText.trimStart();
            if (startsWithDialectMarker(probe)) {
              mode = 'dialect';
            } else if (!couldBecomeDialectMarker(probe) || probe.length > 64) {
              mode = 'passthrough';
              flushHeaders();
              writeChunk(mkChunk({ content: heldText }, null));
              heldText = '';
            }
          }

          const schemas = toolSchemaMap(tools);
          let syntheticStreamIds = 0;
          const completedCalls = [...toolCallAcc.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([, acc]) => ({
              id: acc.id && acc.id.length > 0 ? acc.id : `call_stream_${++syntheticStreamIds}`,
              type: 'function' as const,
              function: { name: acc.name, arguments: repairToolArguments(acc.args || '{}', schemas.get(acc.name)) },
            }))
            .filter(c => { try { JSON.parse(c.function.arguments); return c.function.name.length > 0; } catch { return false; } });

          rememberToolReasoning(completedCalls.map(c => c.id), heldReasoning);

          if (mode === 'dialect' || (mode === 'undecided' && heldText.length > 0 && containsDialectMarker(heldText))) {
            const rescue = rescueInlineToolCalls(heldText, new Set((tools ?? []).map(t => t.function.name)));
            if (rescue.detected) {
              if (!rescue.calls) throw new Error(`unparseable inline tool-call dialect from ${route.displayName}: ${heldText.slice(0, 120)}`);
              let rescuedIds = 0;
              for (const c of rescue.calls) {
                completedCalls.push({ id: `call_rescued_${++rescuedIds}`, type: 'function', function: { name: c.name, arguments: repairToolArguments(c.arguments, schemas.get(c.name)) } });
              }
              heldText = rescue.cleanText;
              providerLog(`Rescued ${rescuedIds} inline tool call(s) from ${route.displayName} into structured tool_calls`, { level: 'info', provider: route.platform, model: route.modelId, event: 'tool_rescue', requestId: requestGroupId });
            }
          }

          // Disconnect before the commit point: nothing usable was (or will
          // be) delivered, and that is CLIENT behavior, not a provider
          // failure — do not let it fall through to the empty-completion
          // throw below, which would bench a healthy model+key for 90s and
          // log a provider error for every Ctrl-C during a reasoning model's
          // TTFB window.
          if (clientGone && !headerSent && heldText.trim().length === 0 && completedCalls.length === 0) {
            console.log(`[Proxy] client disconnected before first token from ${route.displayName} — dropping attempt without benching`);
            return 'committed';
          }

          const hasText = headerSent || heldText.trim().length > 0;
          if (!hasText && completedCalls.length === 0) {
            throw Object.assign(
              new Error(`empty completion from ${route.displayName} (stream produced no content and no tool calls)`),
              upstreamFinish === 'length' ? { skipBench: true } : {},
            );
          }

          flushHeaders();
          if (heldText.length > 0) {
            writeChunk(mkChunk({ content: heldText }, null));
          }
          if (completedCalls.length > 0) {
            writeChunk(mkChunk({ tool_calls: completedCalls.map((c, i) => ({ index: i, ...c })) }, null));
            totalOutputTokens += Math.ceil(completedCalls.reduce((n, c) => n + c.function.arguments.length, 0) / 4);
          }
          const usageObj = usageChunk as Record<string, any> | null;
          const finalOutputTokens = usageObj?.usage && typeof usageObj.usage.completion_tokens === 'number'
            ? usageObj.usage.completion_tokens
            : totalOutputTokens;
          const finalInputTokens = usageObj?.usage && typeof usageObj.usage.prompt_tokens === 'number'
            ? usageObj.usage.prompt_tokens
            : estimatedInputTokens + injectedHandoffTokens;
          const finish = completedCalls.length > 0
            ? 'tool_calls'
            : (upstreamFinish && upstreamFinish !== 'tool_calls' ? upstreamFinish : 'stop');
          writeChunk(mkChunk({}, finish));
          const clientWantsUsage = parsed.data.stream_options?.include_usage === true;
          const streamCachedTokens = usageObj?.usage ? usageCachedTokens(usageObj.usage) : 0;
          const streamCost = responseCostFor(route.platform, route.modelId, {
            prompt: finalInputTokens,
            completion: finalOutputTokens,
            cached: streamCachedTokens,
          });
          if (usageChunk) {
            if (streamCost !== undefined) (usageChunk as Record<string, any>).usage.cost = streamCost;
            writeChunk(usageChunk);
          } else if (clientWantsUsage) {
            const usageFrame: Record<string, unknown> = {
              prompt_tokens: finalInputTokens,
              completion_tokens: finalOutputTokens,
              total_tokens: finalInputTokens + finalOutputTokens,
            };
            if (streamCost !== undefined) usageFrame.cost = streamCost;
            writeChunk({
              id: lastMeta.id ?? `chatcmpl-${Date.now()}`,
              object: 'chat.completion.chunk',
              created: lastMeta.created ?? Math.floor(Date.now() / 1000),
              model: lastMeta.model ?? route.modelId,
              choices: [],
              usage: usageFrame,
            });
          }
          res.write('data: [DONE]\n\n');
          res.end();

          recordRequest(route.platform, route.modelId, route.keyId);
          recordTokens(route.platform, route.modelId, route.keyId, estimatedInputTokens + injectedHandoffTokens + totalOutputTokens);
          recordSuccess(route.modelDbId);
          setStickyModel(messages, route.modelDbId, sessionIdHeader, stickyStrategyKey);
          if (handoffMode !== 'off' && sessionKey) recordSuccessfulModel({ sessionKey, modelKey });
          traceRouteEvent('Proxy', {
            event: 'ok',
            requestId: requestGroupId,
            attempt,
            platform: route.platform,
            model: route.modelId,
            latencyMs: Date.now() - start,
            inputTokens: finalInputTokens,
            outputTokens: finalOutputTokens,
          });
          logRequest(route.platform, route.modelId, route.keyId, 'success', streamInputTokens, totalOutputTokens, Date.now() - start, null, ttfbMs, pinnedModelId,
            observeServedModel({ platform: route.platform, requestedModel: route.modelId, servedModel: upstreamModel }), cachedFromStream);
          return;
        } catch (streamErr: any) {
          // Client abort mid-stream: the pump's own `if (clientGone) break`
          // can lose the race against the fetch-signal rejection, so the
          // abort may surface here instead. Rethrow — the shared loop's
          // client-abort branch stops the ladder without benching or an
          // error log row (the socket is gone; nothing to render).
          if (isClientAbortError(streamErr)) throw streamErr;
          if (headerSent) {
            providerLog(`Mid-stream error from ${route.displayName}: ${streamErr.message}`, { level: 'error', provider: route.platform, model: route.modelId, event: 'mid_stream_error', requestId: requestGroupId });
            const payload = { error: { message: `Provider error (${route.displayName}): stream interrupted`, type: 'stream_error' } };
            try { res.write(`data: ${JSON.stringify(payload)}\n\n`); } catch { /* socket gone */ }
            try { res.write('data: [DONE]\n\n'); res.end(); } catch { /* socket gone */ }
            traceRouteEvent('Proxy', {
              event: 'fail',
              requestId: requestGroupId,
              attempt,
              platform: route.platform,
              model: route.modelId,
              latencyMs: Date.now() - start,
              error: sanitizeProviderErrorMessage(streamErr.message),
            });
            logRequest(route.platform, route.modelId, route.keyId, 'error', streamInputTokens, totalOutputTokens, Date.now() - start, sanitizeProviderErrorMessage(streamErr.message), ttfbMs, pinnedModelId, clientIp, cachedFromStream);
            return;
          }
          throw streamErr;
        }
      } else {
        const result = await route.provider.chatCompletion(
          route.apiKey, outboundMessages, route.modelId,
          { temperature, max_tokens, top_p, stop, tools, tool_choice, parallel_tool_calls, ...samplingParams, signal: clientAbort.signal },
          quotaContextForRoute(route, 'chat/completions'),
        );

        const upstreamModel = typeof result.model === 'string' ? result.model : null;
        result.model = route.modelId;

        const respMsg = result.choices?.[0]?.message;
        const respText = contentToString(respMsg?.content ?? '');
        if (!respText && (respMsg?.tool_calls?.length ?? 0) === 0) {
          traceRouteEvent('Proxy', {
            event: 'fail',
            requestId: requestGroupId,
            attempt,
            platform: route.platform,
            model: route.modelId,
            latencyMs: Date.now() - start,
            error: 'empty completion',
          });
          logRequest(route.platform, route.modelId, route.keyId, 'error', estimatedInputTokens, 0, Date.now() - start, 'empty completion (no content, no tool_calls)', null, pinnedModelId, clientIp);
          providerLog(`Empty completion from ${route.displayName} (no content, no tool_calls)`, { level: 'warn', provider: route.platform, model: route.modelId, event: 'empty_completion', requestId: requestGroupId });
          if (!isZenAnonymousKey(route.platform, route.keyId)) {
            const emptyErr = new Error(`empty completion from ${route.displayName}`);
            (emptyErr as Error & { skipBench?: boolean }).skipBench = result.choices?.[0]?.finish_reason === 'length';
            recordRetryableFailure(route, emptyErr, { skipKeys, skipModels } as any);
          }
          lastError = new Error(`empty completion from ${route.displayName}`);
          continue;
        }

        // Inline tool-call dialect rescue (#231 audit): a tool-bearing
        // request answered with the call serialized as TEXT (a mid-
        // conversation model switch makes the new model imitate the previous
        // model's private syntax). Re-parse it into structured tool_calls so
        // the client's agent loop keeps working; a detected-but-unparseable
        // dialect is a dead turn and fails over like an empty completion.
        if (wantsTools && respMsg && (respMsg.tool_calls?.length ?? 0) === 0 && respText) {
          const rescue = rescueInlineToolCalls(respText, new Set((tools ?? []).map(t => t.function.name)));
          if (rescue.detected) {
            if (!rescue.calls) {
              throw new Error(`unparseable inline tool-call dialect from ${route.displayName}: ${respText.slice(0, 120)}`);
            }
            const schemas = toolSchemaMap(tools);
            respMsg.tool_calls = rescue.calls.map((c, i) => ({
              id: `call_rescued_${i + 1}`,
              type: 'function' as const,
              function: { name: c.name, arguments: repairToolArguments(c.arguments, schemas.get(c.name)) },
            }));
            respMsg.content = rescue.cleanText.length > 0 ? rescue.cleanText : null;
            if (result.choices?.[0]) result.choices[0].finish_reason = 'tool_calls';
            providerLog(`Rescued ${rescue.calls.length} inline tool call(s) from ${route.displayName} into structured tool_calls`, { level: 'info', provider: route.platform, model: route.modelId, event: 'tool_rescue', requestId: requestGroupId });
          }
        }

        if (samplingParams.response_format && respText && (respMsg?.tool_calls?.length ?? 0) === 0) {
          const enforced = enforceJsonContent(respText);
          if (!enforced.ok) {
            const truncated = result.choices?.[0]?.finish_reason === 'length';
            throw Object.assign(
              new Error(truncated
                ? `truncated JSON from ${route.displayName} (finish_reason=length — raise max_tokens for this ${samplingParams.response_format.type} request)`
                : `${route.displayName} ignored response_format (returned non-JSON despite ${samplingParams.response_format.type})`),
              { skipBench: true, skipModelForRequest: true },
            );
          }
          if (enforced.healed && respMsg) {
            respMsg.content = enforced.content;
          }
        }

        const respToolArgChars = (respMsg?.tool_calls ?? []).reduce((n, tc) => n + (tc?.function?.arguments?.length ?? 0), 0);
        const promptTokens = result.usage?.prompt_tokens ?? estimatedInputTokens;
        const completionTokens = result.usage?.completion_tokens
          ?? Math.ceil((contentToString(respMsg?.content ?? '').length + respToolArgChars) / 4);
        const totalTokens = result.usage?.total_tokens ?? (promptTokens + completionTokens);
        recordUpstreamSuccess(route, totalTokens);
        setStickyModel(messages, route.modelDbId, sessionIdHeader, stickyStrategyKey);
        if (handoffMode !== 'off' && sessionKey) recordSuccessfulModel({ sessionKey, modelKey });

        res.setHeader('X-Routed-Via', routedViaValue(route.platform, route.modelId));
        setFallbackHeaders(res, attempt, attemptLog);
        // Repair double-encoded tool arguments against the request's tool
        // schemas (e.g. GLM emitting an array parameter as a JSON string),
        // so strict clients don't reject the call. Schema-gated — a true
        // string parameter is never touched. See lib/tool-args.ts.
        if (respMsg?.tool_calls?.length) {
          const schemas = toolSchemaMap(tools);
          for (const tc of respMsg.tool_calls) {
            if (tc?.function?.arguments != null) {
              tc.function.arguments = repairToolArguments(tc.function.arguments, schemas.get(tc.function.name));
            }
          }
        }
        const cachedNonStream = result.usage ? usageCachedTokens(result.usage) : 0;
        if (result.usage) normalizeUsage(result.usage);
        const spent = result.usage ? responseCostFor(route.platform, route.modelId, {
          prompt: result.usage.prompt_tokens ?? 0,
          completion: result.usage.completion_tokens ?? 0,
          cached: usageCachedTokens(result.usage),
        }) : undefined;
        if (spent !== undefined) {
          result.usage.cost = spent;
          result.spent = spent;
        }
        if (respMsg?.tool_calls?.length) {
          rememberToolReasoning(respMsg.tool_calls.map(tc => tc?.id), respMsg.reasoning_content);
        }
        const outboundBody = sanitizeResponse(normalizeOutboundContent(result));
        if (cacheKey) {
          res.setHeader('X-FreeLLM-Cache', 'MISS');
          storeCachedResponse(cacheKey, {
            body: outboundBody,
            platform: route.platform,
            modelId: route.modelId,
            keyId: route.keyId ?? null,
            promptTokens,
            completionTokens,
          });
        }
        res.json(outboundBody);

        traceRouteEvent('Proxy', {
          event: 'ok',
          requestId: requestGroupId,
          attempt,
          platform: route.platform,
          model: route.modelId,
          latencyMs: Date.now() - start,
          inputTokens: promptTokens,
          outputTokens: completionTokens,
        });
        logRequest(route.platform, route.modelId, route.keyId, 'success', promptTokens, completionTokens, Date.now() - start, null, null, pinnedModelId,
          observeServedModel({ platform: route.platform, requestedModel: route.modelId, servedModel: upstreamModel }), cachedNonStream);
        return;
      }
    } catch (err: any) {
      const latency = Date.now() - start;
      const safeError = sanitizeProviderErrorMessage(err.message);
      traceRouteEvent('Proxy', {
        event: 'fail',
        requestId: requestGroupId,
        attempt,
        platform: route.platform,
        model: route.modelId,
        latencyMs: latency,
        error: safeError,
      });
      logRequest(route.platform, route.modelId, route.keyId, 'error', estimatedInputTokens, 0, latency, safeError, null, pinnedModelId, clientIp);

      if (isKeyInvalidatingError(err, route.platform)) {
        if (!isZenAnonymousKey(route.platform, route.keyId)) {
          invalidateKey(route.keyId, safeError);
          skipKeys.add(`${route.platform}:${route.modelId}:${route.keyId}`);
        }
        lastError = err;
        providerLog(`Disabled invalid ${route.platform} key ${route.keyId}, falling back (attempt ${attempt + 1}/${MAX_RETRIES})`, { level: 'warn', provider: route.platform, model: route.modelId, event: 'key_invalidated', requestId: requestGroupId });
        continue;
      }

      if (isRetryableError(err)) {
        if (isModelNotFoundError(err) || isModelAccessForbiddenError(err)) skipModels.add(route.modelDbId);

        if (err.skipBench && !isZenAnonymousKey(route.platform, route.keyId)) {
          recordRetryableFailure(route, err, { skipKeys, skipModels } as any);
          providerLog(`Retryable error from ${route.displayName}: ${safeError} (attempt ${attempt + 1}/${MAX_RETRIES})`, { level: 'warn', provider: route.platform, model: route.modelId, event: 'retryable_error', requestId: requestGroupId });
          lastError = err;
          continue;
        }

        const modelGone = isModelGoneError(err);
        skipKeys.add(`${route.platform}:${route.modelId}:${route.keyId}`);
        if (route.platform === 'opencode' && err?.upstreamCtx?.zenFreeUsageLimit === true) {
          benchZenModelPool(route.modelId, msUntilNextUtcMidnight(), 'heuristic', 'zen_daily_limit');
        } else if (isZenAnonymousKey(route.platform, route.keyId)) {
          setCooldown(route.platform, route.modelId, route.keyId, ZEN_ANON_TRANSIENT_COOLDOWN_MS, 'heuristic', 'rate_limited');
        } else {
          const cooldownReason = modelGone
            ? 'model_eol'
            : isPaymentRequiredError(err)
            ? 'payment_required'
            : isModelAccessForbiddenError(err)
            ? 'model_forbidden'
            : 'rate_limited';
          const cooldownOverrideMs = modelGone
            ? MODEL_GONE_COOLDOWN_MS
            : isPaymentRequiredError(err)
            ? PAYMENT_REQUIRED_COOLDOWN_MS
            : isModelAccessForbiddenError(err)
            ? MODEL_FORBIDDEN_COOLDOWN_MS
            : null;
          const cooldownDecision = cooldownDecisionForError(route, err);
          setCooldown(
            route.platform,
            route.modelId,
            route.keyId,
            cooldownOverrideMs ?? cooldownDecision.durationMs,
            cooldownOverrideMs != null ? 'heuristic' : cooldownDecision.source,
            cooldownReason,
          );
          if (!hasOtherUsableKey(route.modelDbId, route.keyId, skipKeys)) {
            recordRateLimitHit(route.modelDbId);
          }
          learnLimitFromError(route.modelDbId, err);
        }
        providerLog(`Retryable error from ${route.displayName}: ${safeError} (attempt ${attempt + 1}/${MAX_RETRIES})`, { level: 'warn', provider: route.platform, model: route.modelId, event: 'retryable_error', requestId: requestGroupId });
        if (modelGone && !modelGoneEntry) {
          modelGoneEntry = {
            platform: route.platform,
            modelId: route.modelId,
            displayName: route.displayName,
            providerMessage: safeError,
          };
        }
        lastError = err;
        continue;
      }

      providerLog(`Non-retryable error from ${route.displayName}: ${safeError}`, { level: 'error', provider: route.platform, model: route.modelId, event: 'provider_error', requestId: requestGroupId });
      res.status(502).json({
        error: {
          message: `Provider error (${route.displayName}): ${safeError}`,
          type: 'provider_error',
        },
      });
      return;
    } finally {
      route.release?.();
      releaseKeySlot(route.platform, route.keyId);
    }
  }

  if (modelGoneEntry !== null) {
    const gone: { platform: string; modelId: string; displayName: string; providerMessage: string } = modelGoneEntry;
    res.status(410).json({
      error: {
        message: `Model '${gone.displayName}' on ${gone.platform} is no longer available. ${gone.providerMessage} Choose a different model or call /v1/models for the available list.`,
        type: 'model_gone',
        code: 'model_no_longer_available',
        model: { platform: gone.platform, id: gone.modelId, display_name: gone.displayName },
      },
    });
    return;
  }

  if (isProviderBadRequestError(lastError)) {
    res.status(400).json({
      error: {
        message: `All routed providers rejected the request as invalid after ${MAX_RETRIES} attempts. Last error: ${sanitizeProviderErrorMessage(lastError?.message)}`,
        type: 'invalid_request_error',
      },
    });
    return;
  }

  res.status(429).json({
    error: {
      message: `All models rate-limited after ${MAX_RETRIES} attempts. Last: ${sanitizeProviderErrorMessage(lastError?.message)}`,
      type: 'rate_limit_error',
    },
  });
});

export { logRequest, getClientIp };
