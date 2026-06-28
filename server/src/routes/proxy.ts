import crypto from 'crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type { ChatMessage, ChatToolCall, ModelListRow, Platform } from '@freellmapi/shared/types.js';
import { routeRequest, resolveRoutingChain, resolveModelGroupCandidates, recordRateLimitHit, recordSuccess, hasEnabledVisionModel, hasEnabledToolsModel, modelRecentHealth, isStrictChainEnabled, type RouteResult, type ResolvedChain, type ChainRow } from '../services/router.js';
import { recordRequest, recordTokens, setCooldown, getCooldownDurationForLimit, PAYMENT_REQUIRED_COOLDOWN_MS, MODEL_FORBIDDEN_COOLDOWN_MS, learnLimitFromError, reserveKeySlot, releaseKeySlot } from '../services/ratelimit.js';
import { runEmbeddings, EmbeddingsError } from '../services/embeddings.js';
import { runImageGeneration, runSpeech, MediaError } from '../services/media.js';
import { getDb, getUnifiedApiKey } from '../db/index.js';
import { contentToString, messageHasImage, normalizeOutboundContent, sanitizeResponse } from '../lib/content.js';
import { repairToolArguments, toolSchemaMap } from '../lib/tool-args.js';
import { sanitizeProviderErrorMessage } from '../lib/error-redaction.js';
import { rescueInlineToolCalls, startsWithDialectMarker, couldBecomeDialectMarker, containsDialectMarker } from '../lib/tool-call-rescue.js';
import { getContextHandoffMode, recordIncomingMessages, maybeInjectContextHandoff, recordSuccessfulModel, hasPriorModel, HANDOFF_MAX_TOKENS } from '../services/context-handoff.js';
import { isFusionModel, runFusion, fusionConfigSchema, FusionError, FUSION_MODEL_ID } from '../services/fusion.js';
import { isRetryableError, isPaymentRequiredError, isModelNotFoundError, isModelAccessForbiddenError, isKeyInvalidatingError } from '../lib/error-classify.js';
import { providerLog } from '../lib/server-logs.js';
import { logRequest, getClientIp } from '../lib/request-log.js';
import { invalidateKey } from '../services/health.js';
import { normalizeUsage, cachedTokens as usageCachedTokens, streamOptionsWithUsage } from '../lib/usage-normalize.js';
import { inferQuotaPoolKey, type QuotaObservationContext } from '../services/provider-quota.js';
import { isUnifyEnabled, getModelGroups, resolveRequestedIdToMembers } from '../services/model-groups.js';
import { buildModelListing } from '../services/model-listing.js';

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

export function timingSafeStringEqual(provided: string, expected: string): boolean {
  const key = crypto.randomBytes(32);
  const a = crypto.createHmac('sha256', key).update(provided).digest();
  const b = crypto.createHmac('sha256', key).update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

export function extractApiToken(req: Request): string | undefined {
  const bearer = req.headers.authorization?.replace(/^Bearer\s+/i, '').trim();
  if (bearer) return bearer;

  const apiKeyHeader = req.headers['x-api-key'];
  const xApiKey = Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader;
  const trimmed = xApiKey?.trim();
  return trimmed || undefined;
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
  stickySessionMap.set(key, { modelDbId, lastUsed: Date.now() });

  if (stickySessionMap.size > 500) {
    const now = Date.now();
    for (const [k, v] of stickySessionMap) {
      if (now - v.lastUsed > STICKY_TTL_MS) stickySessionMap.delete(k);
    }
  }
}

function healthyAutoSticky(messages: ChatMessage[], sessionIdHeader?: string, strategyKey?: string): number | undefined {
  const sticky = getStickyModel(messages, sessionIdHeader, strategyKey);
  if (sticky == null) return undefined;
  return modelRecentHealth(sticky).ok ? sticky : undefined;
}

proxyRouter.get('/models', (req: Request, res: Response) => {
  const token = extractApiToken(req);
  const unifiedKey = getUnifiedApiKey();
  if (!token || !timingSafeStringEqual(token, unifiedKey)) {
    res.status(401).json({ error: { message: 'Invalid API key', type: 'authentication_error' } });
    return;
  }

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
      })),
    ],
  });
});

proxyRouter.get('/providers', (req: Request, res: Response) => {
  const token = extractApiToken(req);
  const unifiedKey = getUnifiedApiKey();
  if (!token || !timingSafeStringEqual(token, unifiedKey)) {
    res.status(401).json({ error: { message: 'Invalid API key', type: 'authentication_error' } });
    return;
  }

  const providers = (getDb().prepare(`
    SELECT DISTINCT platform
    FROM api_keys
    WHERE enabled = 1
      AND status IN ('healthy', 'unknown')
    ORDER BY platform ASC
  `).all() as { platform: string }[]).map(row => row.platform);

  res.json({ object: 'list', data: providers });
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
  reasoning_effort: reasoningEffortSchema.nullable().optional(),
  reasoning: reasoningSchema.nullable().optional(),
  include_reasoning: z.boolean().nullable().optional(),
  stream_options: z.object({ include_usage: z.boolean().optional() }).passthrough().nullable().optional(),
  fusion: fusionConfigSchema.optional(),
});

export { isRetryableError, isPaymentRequiredError, isModelNotFoundError, isModelAccessForbiddenError, isKeyInvalidatingError };

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
  const token = extractApiToken(req);
  const unifiedKey = getUnifiedApiKey();
  if (!token || !timingSafeStringEqual(token, unifiedKey)) {
    res.status(401).json({ error: { message: 'Invalid API key', type: 'authentication_error' } });
    return;
  }
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
      model: result.family,
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
  if (status === 400) return 'invalid_request_error';
  if (status === 401) return 'authentication_error';
  if (status === 429) return 'rate_limit_error';
  return 'server_error';
}

proxyRouter.post('/images/generations', async (req: Request, res: Response) => {
  const clientIp = getClientIp(req);
  const token = extractApiToken(req);
  const unifiedKey = getUnifiedApiKey();
  if (!token || !timingSafeStringEqual(token, unifiedKey)) {
    res.status(401).json({ error: { message: 'Invalid API key', type: 'authentication_error' } });
    return;
  }
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
  const token = extractApiToken(req);
  const unifiedKey = getUnifiedApiKey();
  if (!token || !timingSafeStringEqual(token, unifiedKey)) {
    res.status(401).json({ error: { message: 'Invalid API key', type: 'authentication_error' } });
    return;
  }
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
    res.setHeader('X-Provider', result.platform);
    res.send(result.audio);
  } catch (err: any) {
    const status = err instanceof MediaError ? err.status : 502;
    const httpStatus = status >= 400 && status < 600 ? status : 502;
    res.status(httpStatus).json({ error: { message: `speech error: ${err?.message ?? 'unknown'}`, type: mediaErrorType(status) } });
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

  const token = extractApiToken(req);
  const unifiedKey = getUnifiedApiKey();
  if (!token || !timingSafeStringEqual(token, unifiedKey)) {
    res.status(401).json({
      error: { message: 'Invalid API key', type: 'authentication_error' },
    });
    return;
  }

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
  const messages = completionPromptToMessages(prompt, suffix);
  const estimatedInputTokens = messages.reduce((sum, m) => sum + Math.ceil(contentToString(m.content).length / 4), 0);
  const estimatedTotal = estimatedInputTokens + max_tokens;

  let resolvedChain: ResolvedChain | undefined;
  if (isAutoModel(requestedModel)) {
    resolvedChain = resolveRoutingChain(requestedModel);
  }

  let preferredModel: number | undefined;
  let groupChain: ChainRow[] | undefined;

  if (!isAutoModel(requestedModel) && requestedModel) {
    const db = getDb();
    const members = isUnifyEnabled() ? resolveRequestedIdToMembers(requestedModel, getModelGroups()) : null;
    if (members && members.length > 0) {
      groupChain = resolveModelGroupCandidates(members);
      if (groupChain.length === 0) {
        const placeholders = members.map(() => '?').join(',');
        const anyEnabled = db.prepare(`SELECT 1 FROM models WHERE id IN (${placeholders}) AND enabled = 1 LIMIT 1`).get(...members);
        const reason = anyEnabled ? 'has no providers with an enabled key' : 'is disabled';
        res.status(400).json({
          error: {
            message: `Model '${requestedModel}' ${reason}. Use 'auto' (or omit the 'model' field) to auto-route, or call /v1/models for the available list.`,
            type: 'invalid_request_error',
            code: 'model_not_found',
          },
        });
        return;
      }
    } else {
      const enabled = db.prepare('SELECT id FROM models WHERE model_id = ? AND enabled = 1').get(requestedModel) as { id: number } | undefined;
      if (enabled) {
        preferredModel = enabled.id;
      } else {
        const disabled = db.prepare('SELECT id FROM models WHERE model_id = ?').get(requestedModel) as { id: number } | undefined;
        const reason = disabled ? 'is disabled' : 'is not in the catalog';
        res.status(400).json({
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
      if (lastError) {
        res.status(429).json({
          error: {
            message: `All models rate-limited. Last error: ${sanitizeProviderErrorMessage(lastError.message)}`,
            type: 'rate_limit_error',
          },
        });
      } else {
        const disposition: string[] = Array.isArray(err.diagnostics) ? err.diagnostics : [];
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
      }
      return;
    }

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
        const buffered: unknown[] = [];

        const flushHeaders = () => {
          if (headerSent) return;
          ttfbMs = Date.now() - start;
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
          if (attempt > 0) res.setHeader('X-Fallback-Attempts', String(attempt));
          headerSent = true;
          for (const frame of buffered) res.write(`data: ${JSON.stringify(frame)}\n\n`);
          buffered.length = 0;
        };

        try {
          const gen = route.provider.streamChatCompletion(
            route.apiKey,
            messages,
            route.modelId,
            { temperature, max_tokens, top_p, stop },
            quotaContextForRoute(route, 'chat/completions'),
          );

          for await (const chunk of gen) {
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
          { temperature, max_tokens, top_p, stop },
          quotaContextForRoute(route, 'chat/completions'),
        );

        const text = completionTextFromChat(result);
        if (!text) {
          throw new Error(`empty completion from ${route.displayName}`);
        }

        const totalTokens = result.usage?.total_tokens ?? 0;
        recordRequest(route.platform, route.modelId, route.keyId);
        recordTokens(route.platform, route.modelId, route.keyId, totalTokens);
        recordSuccess(route.modelDbId);

        res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
        if (attempt > 0) res.setHeader('X-Fallback-Attempts', String(attempt));
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
        logRequest(route.platform, route.modelId, route.keyId, 'success', result.usage?.prompt_tokens ?? 0, result.usage?.completion_tokens ?? 0, Date.now() - start, null, null, pinnedModelId);
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
        skipKeys.add(`${route.platform}:${route.modelId}:${route.keyId}`);
        setCooldown(
          route.platform,
          route.modelId,
          route.keyId,
          isPaymentRequiredError(err)
            ? PAYMENT_REQUIRED_COOLDOWN_MS
            : isModelAccessForbiddenError(err)
            ? MODEL_FORBIDDEN_COOLDOWN_MS
            : getCooldownDurationForLimit(route.platform, route.modelId, route.keyId, {
                rpd: route.rpdLimit,
                tpd: route.tpdLimit,
              }, err.retryAfterMs),
        );
        recordRateLimitHit(route.modelDbId);
        learnLimitFromError(route.modelDbId, err);
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
    }
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

  const token = extractApiToken(req);
  const unifiedKey = getUnifiedApiKey();
  if (!token || !timingSafeStringEqual(token, unifiedKey)) {
    res.status(401).json({
      error: { message: 'Invalid API key', type: 'authentication_error' },
    });
    return;
  }

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
  const max_tokens = parsed.data.max_tokens != null && parsed.data.max_tokens > 0
    ? parsed.data.max_tokens : undefined;
  const stop = providerSafeStop(parsed.data.stop);
  const tool_choice = parsed.data.tool_choice === 'any' ? 'required' as const : parsed.data.tool_choice ?? undefined;
  const tools = parsed.data.tools?.map(t => ({ ...t, type: 'function' as const }));
  const parallel_tool_calls = parsed.data.parallel_tool_calls ?? undefined;
  const reasoning_effort = parsed.data.reasoning_effort ?? undefined;
  const reasoning = parsed.data.reasoning ?? undefined;
  const include_reasoning = parsed.data.include_reasoning ?? undefined;
  const stream_options = streamOptionsWithUsage(stream, parsed.data.stream_options);
  const completionOptions = { temperature, max_tokens, top_p, stop, tools, tool_choice, parallel_tool_calls, reasoning_effort, reasoning, include_reasoning, stream_options };

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

  const messages: ChatMessage[] = parsed.data.messages.map((m): ChatMessage => {
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
  const estimatedTotal = estimatedInputTokens + imageCount * IMAGE_TOKEN_ESTIMATE + (max_tokens ?? 1000);

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

  if (isFusionModel(requestedModel)) {
    if (hasImage) {
      res.status(422).json({ error: { message: 'Fusion does not support image input yet. Use a vision model directly.', type: 'invalid_request_error', code: 'fusion_no_vision' } });
      return;
    }
    const fusionOptions = { temperature, max_tokens, top_p, stop, tools, tool_choice, parallel_tool_calls };
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
      res.setHeader('X-Routed-Via', routedVia);
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
    preferredModel = healthyAutoSticky(messages, sessionIdHeader, strategyKey);
  } else if (requestedModel) {
    const db = getDb();
    const providerScoped = requestedModel.match(/^([^:]+):(.+)$/);
    if (providerScoped) {
      const [, platform, modelId] = providerScoped;
      const enabled = db.prepare('SELECT id FROM models WHERE platform = ? AND model_id = ? AND enabled = 1').get(platform, modelId) as { id: number } | undefined;
      if (enabled) {
        groupChain = resolveModelGroupCandidates([enabled.id]);
        if (groupChain.length === 0) {
          res.status(400).json({
            error: {
              message: `Model '${requestedModel}' has no providers with an enabled key. Use 'auto' (or omit the 'model' field) to auto-route, or call /v1/models for the available list.`,
              type: 'invalid_request_error',
              code: 'model_not_found',
            },
          });
          return;
        }
        stickyStrategyKey = requestedModel;
        const sticky = getStickyModel(messages, sessionIdHeader, stickyStrategyKey);
        preferredModel = (sticky != null && groupChain.some(r => r.model_db_id === sticky)) ? sticky : undefined;
      } else {
        const disabled = db.prepare('SELECT id FROM models WHERE platform = ? AND model_id = ?').get(platform, modelId) as { id: number } | undefined;
        if (disabled) {
          res.status(400).json({
            error: {
              message: `Model '${requestedModel}' is disabled. Use 'auto' (or omit the 'model' field) to auto-route, or call /v1/models for the available list.`,
              type: 'invalid_request_error',
              code: 'model_not_found',
            },
          });
          return;
        }
      }
    }

    if (!groupChain) {
    const members = isUnifyEnabled() ? resolveRequestedIdToMembers(requestedModel, getModelGroups()) : null;
    if (members && members.length > 0) {
      groupChain = resolveModelGroupCandidates(members);
      if (groupChain.length === 0) {
        const placeholders = members.map(() => '?').join(',');
        const anyEnabled = db.prepare(`SELECT 1 FROM models WHERE id IN (${placeholders}) AND enabled = 1 LIMIT 1`).get(...members);
        const reason = anyEnabled ? 'has no providers with an enabled key' : 'is disabled';
        res.status(400).json({
          error: {
            message: `Model '${requestedModel}' ${reason}. Use 'auto' (or omit the 'model' field) to auto-route, or call /v1/models for the available list.`,
            type: 'invalid_request_error',
            code: 'model_not_found',
          },
        });
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
        res.status(400).json({
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
  } else {
    preferredModel = healthyAutoSticky(messages, sessionIdHeader, strategyKey);
  }

  const pinnedModelId = requestedModel && !isAutoModel(requestedModel) ? requestedModel : null;
  const isExplicitPin = !!pinnedModelId;

  const skipKeys = new Set<string>();
  const skipModels = new Set<number>();
  let lastError: any = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let route: RouteResult;
    try {
      const routingEstimate = handoffPossible ? estimatedTotal + HANDOFF_MAX_TOKENS : estimatedTotal;
      route = await routeRequest(routingEstimate, skipKeys.size > 0 ? skipKeys : undefined, preferredModel, hasImage, wantsTools, skipModels.size > 0 ? skipModels : undefined, groupChain ?? resolvedChain?.chain, isStrictChainEnabled(), isExplicitPin);
    } catch (err: any) {
      if (lastError) {
        const safeLastError = sanitizeProviderErrorMessage(lastError.message);
        res.status(429).json({
          error: {
            message: `All models rate-limited. Last error: ${safeLastError}`,
            type: 'rate_limit_error',
          },
        });
      } else {
        const disposition: string[] = Array.isArray(err.diagnostics) ? err.diagnostics : [];
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
      }
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

    try {
      if (stream) {
        let totalOutputTokens = 0;
        let headerSent = false;
        let ttfbMs: number | null = null;

        let mode: 'undecided' | 'passthrough' | 'dialect' = 'undecided';
        let heldText = '';
        const preamble: unknown[] = [];
        const toolCallAcc = new Map<number, { id?: string; name: string; args: string }>();
        let upstreamFinish: string | null = null;
        let usageChunk: unknown = null;
        let cachedFromStream = 0;
        let lastMeta: { id?: string; model?: string; created?: number } = {};

        const flushHeaders = () => {
          if (headerSent) return;
          ttfbMs = Date.now() - start;
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache, no-transform');
          res.setHeader('Connection', 'keep-alive');
          res.setHeader('X-Accel-Buffering', 'no');
          res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
          if (attempt > 0) res.setHeader('X-Fallback-Attempts', String(attempt));
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
            completionOptions,
            quotaContextForRoute(route, 'chat/completions'),
          );

          for await (const chunk of gen) {
            const anyChunk = chunk as Record<string, any>;

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
              logRequest(route.platform, route.modelId, route.keyId, 'error', estimatedInputTokens, totalOutputTokens, Date.now() - start, `in-band error frame: ${sanitizeProviderErrorMessage(String(msg))}`, ttfbMs, pinnedModelId, clientIp);
              return;
            }

            if (anyChunk.id) lastMeta = { id: anyChunk.id, model: anyChunk.model, created: anyChunk.created };

            if (anyChunk.usage) {
              normalizeUsage(anyChunk.usage);
              cachedFromStream = usageCachedTokens(anyChunk.usage);
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

            normalizeOutboundContent(chunk);
            sanitizeResponse(chunk);
            const text = typeof choice.delta?.content === 'string' ? choice.delta.content : '';

            const reasoningText =
              typeof choice.delta?.reasoning_content === 'string' ? choice.delta.reasoning_content
              : typeof (choice.delta as Record<string, unknown> | undefined)?.reasoning === 'string'
                ? (choice.delta as Record<string, unknown>).reasoning as string
                : '';
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

          const hasText = headerSent || heldText.trim().length > 0;
          if (!hasText && completedCalls.length === 0) {
            throw new Error(`empty completion from ${route.displayName} (stream produced no content and no tool calls)`);
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
          if (usageChunk) {
            writeChunk(usageChunk);
          } else if (clientWantsUsage) {
            writeChunk({
              id: lastMeta.id ?? `chatcmpl-${Date.now()}`,
              object: 'chat.completion.chunk',
              created: lastMeta.created ?? Math.floor(Date.now() / 1000),
              model: lastMeta.model ?? route.modelId,
              choices: [],
              usage: {
                prompt_tokens: finalInputTokens,
                completion_tokens: finalOutputTokens,
                total_tokens: finalInputTokens + finalOutputTokens,
              },
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
          logRequest(route.platform, route.modelId, route.keyId, 'success', finalInputTokens, finalOutputTokens, Date.now() - start, null, ttfbMs, pinnedModelId, clientIp, cachedFromStream);
          return;
        } catch (streamErr: any) {
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
            logRequest(route.platform, route.modelId, route.keyId, 'error', estimatedInputTokens, totalOutputTokens, Date.now() - start, sanitizeProviderErrorMessage(streamErr.message), ttfbMs, pinnedModelId, clientIp);
            return;
          }
          throw streamErr;
        }
      } else {
        const result = await route.provider.chatCompletion(
          route.apiKey, outboundMessages, route.modelId,
          completionOptions,
          quotaContextForRoute(route, 'chat/completions'),
        );

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
          skipKeys.add(`${route.platform}:${route.modelId}:${route.keyId}`);
          setCooldown(route.platform, route.modelId, route.keyId, getCooldownDurationForLimit(route.platform, route.modelId, route.keyId, { rpd: route.rpdLimit, tpd: route.tpdLimit }));
          recordRateLimitHit(route.modelDbId);
          lastError = new Error(`empty completion from ${route.displayName}`);
          continue;
        }

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

        const totalTokens = result.usage?.total_tokens ?? 0;
        recordRequest(route.platform, route.modelId, route.keyId);
        recordTokens(route.platform, route.modelId, route.keyId, totalTokens);
        recordSuccess(route.modelDbId);
        setStickyModel(messages, route.modelDbId, sessionIdHeader, stickyStrategyKey);
        if (handoffMode !== 'off' && sessionKey) recordSuccessfulModel({ sessionKey, modelKey });

        res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
        if (attempt > 0) res.setHeader('X-Fallback-Attempts', String(attempt));
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
        res.json(sanitizeResponse(normalizeOutboundContent(result)));

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
        logRequest(route.platform, route.modelId, route.keyId, 'success', result.usage?.prompt_tokens ?? 0, result.usage?.completion_tokens ?? 0, Date.now() - start, null, null, pinnedModelId, clientIp, cachedNonStream);
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
        invalidateKey(route.keyId, safeError);
        skipKeys.add(`${route.platform}:${route.modelId}:${route.keyId}`);
        lastError = err;
        providerLog(`Disabled invalid ${route.platform} key ${route.keyId}, falling back (attempt ${attempt + 1}/${MAX_RETRIES})`, { level: 'warn', provider: route.platform, model: route.modelId, event: 'key_invalidated', requestId: requestGroupId });
        continue;
      }

      if (isRetryableError(err)) {
        if (isModelNotFoundError(err) || isModelAccessForbiddenError(err)) skipModels.add(route.modelDbId);

        const skipId = `${route.platform}:${route.modelId}:${route.keyId}`;
        skipKeys.add(skipId);
        const cooldownReason = isPaymentRequiredError(err)
          ? 'payment_required'
          : isModelAccessForbiddenError(err)
          ? 'model_forbidden'
          : 'rate_limited';
        setCooldown(
          route.platform,
          route.modelId,
          route.keyId,
          isPaymentRequiredError(err)
            ? PAYMENT_REQUIRED_COOLDOWN_MS
            : isModelAccessForbiddenError(err)
            ? MODEL_FORBIDDEN_COOLDOWN_MS
            : getCooldownDurationForLimit(route.platform, route.modelId, route.keyId, {
                rpd: route.rpdLimit,
                tpd: route.tpdLimit,
              }, err.retryAfterMs),
          cooldownReason,
        );
        recordRateLimitHit(route.modelDbId);
        learnLimitFromError(route.modelDbId, err);
        providerLog(`Retryable error from ${route.displayName}: ${safeError} (attempt ${attempt + 1}/${MAX_RETRIES})`, { level: 'warn', provider: route.platform, model: route.modelId, event: 'retryable_error', requestId: requestGroupId });
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
      releaseKeySlot(route.platform, route.keyId);
    }
  }

  res.status(429).json({
    error: {
      message: `All models rate-limited after ${MAX_RETRIES} attempts. Last: ${sanitizeProviderErrorMessage(lastError?.message)}`,
      type: 'rate_limit_error',
    },
  });
});

export { logRequest, getClientIp };
