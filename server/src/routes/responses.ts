import crypto from 'crypto';
import { Router } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import type {
  ChatMessage,
  ChatToolCall,
  ChatToolDefinition,
  ChatToolChoice,
  Platform,
} from '@freellmapi/shared/types.js';
import { routeRequest, recordRateLimitHit, recordSuccess, hasEnabledToolsModel, isStrictChainEnabled, resolveModelGroupCandidates, type RouteResult, type ChainRow } from '../services/router.js';
import { getDb } from '../db/index.js';
import { recordRequest, recordTokens, setCooldown, getCooldownDurationForLimit, PAYMENT_REQUIRED_COOLDOWN_MS, MODEL_GONE_COOLDOWN_MS, learnLimitFromError, reserveKeySlot, releaseKeySlot } from '../services/ratelimit.js';
import { getUnifiedApiKey } from '../db/index.js';
import { contentToString } from '../lib/content.js';
import { repairToolArguments, toolSchemaMap } from '../lib/tool-args.js';
import { rescueInlineToolCalls, startsWithDialectMarker, couldBecomeDialectMarker, containsDialectMarker } from '../lib/tool-call-rescue.js';
import {
  isRetryableError,
  isPaymentRequiredError,
  isModelNotFoundError,
  isModelAccessForbiddenError,
  isKeyInvalidatingError,
  isModelGoneError,
  timingSafeStringEqual,
  extractApiToken,
  getRequestGroupId,
  getStickyModel,
  setStickyModel,
  traceRouteEvent,
  logRequest,
  getClientIp,
} from './proxy.js';
import { sanitizeProviderErrorMessage } from '../lib/error-redaction.js';
import { providerLog } from '../lib/server-logs.js';
import { invalidateKey } from '../services/health.js';
import { normalizeUsage, cachedTokens as usageCachedTokens, streamOptionsWithUsage } from '../lib/usage-normalize.js';
import { inferQuotaPoolKey, type QuotaObservationContext } from '../services/provider-quota.js';

export const responsesRouter = Router();

const MAX_RETRIES = 20;

function newId(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(18).toString('hex')}`;
}

function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

const contentPartSchema = z.object({ type: z.string() }).passthrough();

const messageItemSchema = z.object({
  type: z.literal('message').optional(),
  role: z.enum(['system', 'developer', 'user', 'assistant']),
  content: z.union([z.string(), z.array(contentPartSchema)]),
});

const functionCallItemSchema = z.object({
  type: z.literal('function_call'),
  call_id: z.string(),
  name: z.string(),
  arguments: z.string(),
  id: z.string().optional(),
});

const functionCallOutputItemSchema = z.object({
  type: z.literal('function_call_output'),
  call_id: z.string(),
  output: z.union([z.string(), z.array(contentPartSchema), z.record(z.string(), z.unknown())]),
});

const inputItemSchema = z.union([
  functionCallItemSchema,
  functionCallOutputItemSchema,
  messageItemSchema,
]);

const responsesToolSchema = z.object({
  type: z.string(),
  name: z.string().optional(),
  description: z.string().nullable().optional(),
  parameters: z.record(z.string(), z.unknown()).nullable().optional(),
  strict: z.boolean().nullable().optional(),
}).passthrough();

const responsesRequestSchema = z.object({
  model: z.string().optional(),
  instructions: z.string().nullable().optional(),
  input: z.union([z.string(), z.array(inputItemSchema)]),
  stream: z.boolean().optional(),
  temperature: z.number().min(0).max(2).nullable().optional(),
  top_p: z.number().min(0).max(1).nullable().optional(),
  max_output_tokens: z.number().int().positive().nullable().optional(),
  tools: z.array(responsesToolSchema).optional(),
  tool_choice: z.union([
    z.enum(['none', 'auto', 'required']),
    z.object({ type: z.literal('function'), name: z.string() }).passthrough(),
  ]).optional(),
  parallel_tool_calls: z.boolean().nullable().optional(),
}).passthrough();

type ResponsesRequest = z.infer<typeof responsesRequestSchema>;

function partsToString(content: string | Array<{ type: string; text?: unknown }>): string {
  if (typeof content === 'string') return content;
  return content
    .map((p) => (typeof p.text === 'string' ? p.text : ''))
    .join('');
}

export function responsesInputHasImage(req: ResponsesRequest): boolean {
  if (typeof req.input === 'string') return false;
  for (const item of req.input) {
    const content = (item as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    if (content.some((p) => {
      const type = (p as { type?: string })?.type;
      return type === 'input_image' || type === 'image_url' || type === 'image';
    })) return true;
  }
  return false;
}

export function toChatMessages(req: ResponsesRequest): ChatMessage[] {
  const messages: ChatMessage[] = [];

  if (req.instructions) {
    messages.push({ role: 'system', content: req.instructions });
  }

  if (typeof req.input === 'string') {
    messages.push({ role: 'user', content: req.input });
    return messages;
  }

  for (const item of req.input) {
    if ('type' in item && item.type === 'function_call') {
      messages.push({
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: item.call_id,
          type: 'function',
          function: { name: item.name, arguments: item.arguments },
        }],
      });
    } else if ('type' in item && item.type === 'function_call_output') {
      const output = typeof item.output === 'string'
        ? item.output
        : Array.isArray(item.output)
          ? partsToString(item.output as any)
          : JSON.stringify(item.output);
      messages.push({ role: 'tool', tool_call_id: item.call_id, content: output });
    } else {
      const m = item as z.infer<typeof messageItemSchema>;
      const role = m.role === 'developer' ? 'system' : m.role;
      messages.push({ role, content: partsToString(m.content) });
    }
  }

  return messages;
}

export function toChatTools(tools?: ResponsesRequest['tools']): ChatToolDefinition[] | undefined {
  if (!tools?.length) return undefined;
  const fns = tools.filter((t): t is typeof t & { name: string } => t.type === 'function' && typeof t.name === 'string');
  if (!fns.length) return undefined;
  return fns.map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      ...(t.parameters ? { parameters: t.parameters } : {}),
      ...(t.strict != null ? { strict: t.strict } : {}),
    },
  }));
}

export function toChatToolChoice(tc?: ResponsesRequest['tool_choice']): ChatToolChoice | undefined {
  if (!tc) return undefined;
  if (typeof tc === 'string') return tc;
  return { type: 'function', function: { name: tc.name } };
}

function requestDeclaresToolUse(req: ResponsesRequest): boolean {
  return (req.tools?.length ?? 0) > 0 && req.tool_choice !== 'none';
}

export function buildResponseObject(opts: {
  id: string;
  model: string;
  text: string;
  toolCalls: ChatToolCall[];
  promptTokens: number;
  completionTokens: number;
  cachedTokens?: number;
  reasoningTokens?: number;
}) {
  const output: any[] = [];
  if (opts.text.length > 0) {
    output.push({
      type: 'message',
      id: newId('msg'),
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: opts.text, annotations: [] }],
    });
  }
  for (const tc of opts.toolCalls) {
    output.push({
      type: 'function_call',
      id: newId('fc'),
      call_id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments,
      status: 'completed',
    });
  }

  return {
    id: opts.id,
    object: 'response',
    created_at: nowUnix(),
    status: 'completed',
    model: opts.model,
    output,
    output_text: opts.text,
    usage: {
      input_tokens: opts.promptTokens,
      input_tokens_details: { cached_tokens: opts.cachedTokens ?? 0 },
      output_tokens: opts.completionTokens,
      output_tokens_details: { reasoning_tokens: opts.reasoningTokens ?? 0 },
      total_tokens: opts.promptTokens + opts.completionTokens,
    },
  };
}

function quotaContextForRoute(route: RouteResult, endpoint: string): QuotaObservationContext {
  return {
    platform: route.platform as Platform,
    keyId: route.keyId,
    modelId: route.modelId,
    quotaPoolKey: inferQuotaPoolKey(route.platform as Platform, route.modelId),
    endpoint,
    origin: 'responses',
  };
}

responsesRouter.post('/responses', async (req: Request, res: Response) => {
  const start = Date.now();
  const clientIp = getClientIp(req);
  const requestGroupId = getRequestGroupId(req);
  res.setHeader('X-Request-ID', requestGroupId);

  const token = extractApiToken(req);
  const unifiedKey = getUnifiedApiKey();
  if (!token || !timingSafeStringEqual(token, unifiedKey)) {
    res.status(401).json({ error: { message: 'Invalid API key', type: 'authentication_error' } });
    return;
  }

  const parsed = responsesRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        message: `Invalid request: ${parsed.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join(', ')}`,
        type: 'invalid_request_error',
      },
    });
    return;
  }

  const reqData = parsed.data;

  if (responsesInputHasImage(reqData)) {
    res.status(422).json({
      error: {
        message: 'Image input is not yet supported on /v1/responses. Use /v1/chat/completions with an image_url content part instead.',
        type: 'invalid_request_error',
        code: 'no_vision_model',
      },
    });
    return;
  }

  const stream = reqData.stream ?? false;
  const messages = toChatMessages(reqData);
  const tools = toChatTools(reqData.tools);
  const toolSchemas = toolSchemaMap(tools);
  const tool_choice = tools?.length ? toChatToolChoice(reqData.tool_choice) : undefined;
  const completionOpts = {
    temperature: reqData.temperature ?? undefined,
    max_tokens: reqData.max_output_tokens ?? undefined,
    top_p: reqData.top_p ?? undefined,
    tools,
    tool_choice,
    parallel_tool_calls: reqData.parallel_tool_calls ?? undefined,
    stream_options: streamOptionsWithUsage(stream),
  };

  const estimatedInputTokens = messages.reduce(
    (sum, m) => sum + Math.ceil(contentToString(m.content).length / 4),
    0,
  );
  const estimatedTotal = estimatedInputTokens + (reqData.max_output_tokens ?? 1000);
  const rawSessionId = req.headers['x-session-id'];
  const sessionIdHeader = Array.isArray(rawSessionId) ? rawSessionId[0] : rawSessionId;
  const requestedModel = reqData.model;
  const isRequestedAuto = !requestedModel || requestedModel.toLowerCase() === 'auto' || requestedModel.toLowerCase().startsWith('auto:');
  let preferredModel: number | undefined;
  let groupChain: ChainRow[] | undefined;
  let stickyStrategyKey: string | undefined;

  if (isRequestedAuto) {
    preferredModel = getStickyModel(messages, sessionIdHeader);
  } else {
    const db = getDb();
    const providerScoped = requestedModel.match(/^([^:]+):(.+)$/);
    if (providerScoped) {
      const [, platform, modelId] = providerScoped;
      const enabled = db.prepare('SELECT id FROM models WHERE platform = ? AND model_id = ? AND enabled = 1').get(platform, modelId) as { id: number } | undefined;
      if (enabled) {
        groupChain = resolveModelGroupCandidates([enabled.id]);
        if (groupChain.length > 0) {
          stickyStrategyKey = requestedModel;
          const sticky = getStickyModel(messages, sessionIdHeader, stickyStrategyKey);
          preferredModel = (sticky != null && groupChain.some(r => r.model_db_id === sticky)) ? sticky : undefined;
        }
      }
    }
    if (!groupChain) {
      const enabled = db.prepare('SELECT id FROM models WHERE model_id = ? AND enabled = 1').get(requestedModel) as { id: number } | undefined;
      if (enabled) {
        preferredModel = enabled.id;
      }
    }
  }
  const isExplicitPin = !!requestedModel && !isRequestedAuto;
  const requestedModelLabel = requestedModel ?? 'auto';

  const wantsTools = requestDeclaresToolUse(reqData);
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

  const responseId = newId('resp');
  const skipKeys = new Set<string>();
  const skipModels = new Set<number>();
  let lastError: any = null;
  let modelGoneEntry: { platform: string; modelId: string; displayName: string; providerMessage: string } | null = null;

  let seq = 0;
  let streamStarted = false;
  const sse = (event: string, payload: Record<string, unknown>) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify({ type: event, sequence_number: seq++, ...payload })}\n\n`);
  };

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    let route: RouteResult;
    try {
      route = await routeRequest(estimatedTotal, skipKeys.size > 0 ? skipKeys : undefined, preferredModel, false, wantsTools, skipModels.size > 0 ? skipModels : undefined, groupChain, isStrictChainEnabled(), isExplicitPin);
    } catch (err: any) {
      const hasRichFields = (Array.isArray(err.cooldown) && err.cooldown.length > 0)
        || err.unavailableModel
        || (Array.isArray(err.unavailableModels) && err.unavailableModels.length > 0);
      const useBarebones = !!lastError && !hasRichFields;
      const status = useBarebones ? 429 : (err.status ?? 503);
      const message = useBarebones
        ? `All models rate-limited. Last error: ${sanitizeProviderErrorMessage(lastError.message)}`
        : err.message;
      const type = (useBarebones || err.unavailableModel || (Array.isArray(err.unavailableModels) && err.unavailableModels.length > 0)) ? 'rate_limit_error' : 'routing_error';
      const errorBody: Record<string, unknown> = { message, type };
      if (Array.isArray(err.cooldown) && err.cooldown.length > 0) {
        errorBody.cooldown = err.cooldown;
        if (err.unavailableModel) errorBody.unavailableModel = err.unavailableModel;
      }
      if (Array.isArray(err.unavailableModels) && err.unavailableModels.length > 0) {
        errorBody.unavailableModels = err.unavailableModels;
      }
      if (streamStarted) {
        sse('response.failed', { response: { id: responseId, object: 'response', status: 'failed', error: errorBody } });
        res.end();
      } else {
        res.status(status).json({ error: errorBody });
      }
      return;
    }

    reserveKeySlot(route.platform, route.keyId);

    try {
      traceRouteEvent('Responses', {
        event: attempt === 0 ? 'start' : 'next',
        requestId: requestGroupId,
        attempt,
        platform: route.platform,
        model: route.modelId,
        requestedModel: attempt === 0 ? requestedModelLabel : undefined,
      });
      if (stream) {
        let outputIndex = 0;
        let msgItemId: string | null = null;
        let msgText = '';
        const toolAcc = new Map<number, { outputIndex: number; itemId: string; callId: string; name: string; args: string }>();
        let totalOutputTokens = 0;
        let usageChunk: unknown = null;
        let cachedFromStream = 0;

        let dialectMode: 'undecided' | 'passthrough' | 'dialect' = 'undecided';
        let heldText = '';

        const openTextItem = (text: string) => {
          msgItemId = newId('msg');
          sse('response.output_item.added', {
            output_index: outputIndex,
            item: { id: msgItemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] },
          });
          sse('response.content_part.added', {
            item_id: msgItemId, output_index: outputIndex, content_index: 0,
            part: { type: 'output_text', text: '', annotations: [] },
          });
          if (text) {
            sse('response.output_text.delta', { item_id: msgItemId, output_index: outputIndex, content_index: 0, delta: text });
            msgText += text;
          }
        };

        const gen = route.provider.streamChatCompletion(
          route.apiKey,
          messages,
          route.modelId,
          completionOpts,
          quotaContextForRoute(route, 'responses'),
        );

        for await (const chunk of gen) {
          const anyChunk = chunk as Record<string, any>;
          if (anyChunk.error && !anyChunk.choices) {
            throw new Error(`in-band provider error from ${route.displayName}: ${anyChunk.error.message ?? 'provider error'}`);
          }
          if (!streamStarted) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache, no-transform');
            res.setHeader('Connection', 'keep-alive');
            res.setHeader('X-Accel-Buffering', 'no');
            res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
            if (attempt > 0) res.setHeader('X-Fallback-Attempts', String(attempt));
            const skeleton = {
              id: responseId, object: 'response', created_at: nowUnix(),
              status: 'in_progress', model: route.modelId, output: [], output_text: '',
            };
            sse('response.created', { response: skeleton });
            sse('response.in_progress', { response: skeleton });
            streamStarted = true;
          }

          if (anyChunk.usage) {
            normalizeUsage(anyChunk.usage);
            cachedFromStream = usageCachedTokens(anyChunk.usage);
            usageChunk = anyChunk;
          }

          const delta = chunk.choices?.[0]?.delta;
          if (!delta) {
            continue;
          }

          const text = delta.content ?? '';
          if (text) {
            totalOutputTokens += Math.ceil(text.length / 4);
            if (dialectMode === 'passthrough') {
              if (msgItemId === null) openTextItem('');
              sse('response.output_text.delta', {
                item_id: msgItemId, output_index: 0, content_index: 0, delta: text,
              });
              msgText += text;
            } else {
              heldText += text;
              if (dialectMode === 'undecided') {
                const probe = heldText.trimStart();
                if (startsWithDialectMarker(probe)) {
                  dialectMode = 'dialect';
                } else if (!couldBecomeDialectMarker(probe) || heldText.length > 256) {
                  dialectMode = 'passthrough';
                  openTextItem(heldText);
                  heldText = '';
                }
              }
            }
          }

          for (const tc of delta.tool_calls ?? []) {
            const idx = (tc as any).index ?? 0;
            let acc = toolAcc.get(idx);
            if (!acc) {
              if (msgItemId !== null && msgText.length > 0) {
                sse('response.output_text.done', { item_id: msgItemId, output_index: 0, content_index: 0, text: msgText });
                sse('response.content_part.done', { item_id: msgItemId, output_index: 0, content_index: 0, part: { type: 'output_text', text: msgText, annotations: [] } });
                sse('response.output_item.done', { output_index: 0, item: { id: msgItemId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: msgText, annotations: [] }] } });
                msgItemId = null;
              }
              outputIndex = toolAcc.size + (msgText.length > 0 ? 1 : 0);
              acc = { outputIndex, itemId: newId('fc'), callId: tc.id || newId('call'), name: tc.function?.name ?? '', args: '' };
              toolAcc.set(idx, acc);
              sse('response.output_item.added', {
                output_index: acc.outputIndex,
                item: { id: acc.itemId, type: 'function_call', status: 'in_progress', call_id: acc.callId, name: acc.name, arguments: '' },
              });
            }
            const argFrag = tc.function?.arguments ?? '';
            if (tc.function?.name && !acc.name) acc.name = tc.function.name;
            if (argFrag) {
              acc.args += argFrag;
              sse('response.function_call_arguments.delta', { item_id: acc.itemId, output_index: acc.outputIndex, delta: argFrag });
            }
          }
        }

        if (heldText.length > 0) {
          const rescue = (dialectMode === 'dialect' || containsDialectMarker(heldText))
            ? rescueInlineToolCalls(heldText, new Set((tools ?? []).map(t => t.function.name)))
            : { detected: false as const, calls: null, cleanText: heldText };
          if (rescue.detected && !rescue.calls) {
            traceRouteEvent('Responses', {
              event: 'fail',
              requestId: requestGroupId,
              attempt,
              platform: route.platform,
              model: route.modelId,
              latencyMs: Date.now() - start,
              error: 'unparseable inline tool-call dialect',
            });
            logRequest(route.platform, route.modelId, route.keyId, 'error', estimatedInputTokens, 0, Date.now() - start, `unparseable inline tool-call dialect: ${heldText.slice(0, 120)}`, null, null, clientIp);
            skipKeys.add(`${route.platform}:${route.modelId}:${route.keyId}`);
            setCooldown(route.platform, route.modelId, route.keyId, getCooldownDurationForLimit(route.platform, route.modelId, route.keyId, { rpd: route.rpdLimit, tpd: route.tpdLimit }));
            recordRateLimitHit(route.modelDbId);
            lastError = new Error(`unparseable inline tool-call dialect from ${route.displayName}`);
            continue;
          }
          if (rescue.detected && rescue.calls) {
            providerLog(`Rescued ${rescue.calls.length} inline tool call(s) from ${route.displayName}`, { level: 'info', provider: route.platform, model: route.modelId, event: 'tool_rescue', requestId: requestGroupId });
            if (rescue.cleanText.length > 0 && msgItemId === null) openTextItem(rescue.cleanText);
            let rescuedIdx = 0;
            for (const c of rescue.calls) {
              const idx = 1000 + rescuedIdx++;
              const acc = {
                outputIndex: toolAcc.size + (msgText.length > 0 ? 1 : 0),
                itemId: newId('fc'), callId: newId('call'), name: c.name, args: c.arguments,
              };
              toolAcc.set(idx, acc);
              sse('response.output_item.added', {
                output_index: acc.outputIndex,
                item: { id: acc.itemId, type: 'function_call', status: 'in_progress', call_id: acc.callId, name: acc.name, arguments: '' },
              });
            }
          } else if (msgItemId === null) {
            openTextItem(heldText);
          }
          heldText = '';
        }

        if (msgText.length === 0 && toolAcc.size === 0) {
          traceRouteEvent('Responses', {
            event: 'fail',
            requestId: requestGroupId,
            attempt,
            platform: route.platform,
            model: route.modelId,
            latencyMs: Date.now() - start,
            error: 'empty completion',
          });
          logRequest(route.platform, route.modelId, route.keyId, 'error', estimatedInputTokens, 0, Date.now() - start, 'empty completion (no content, no tool_calls)', null, null, clientIp);
          providerLog(`Empty completion from ${route.displayName} (stream produced no content and no tool calls)`, { level: 'warn', provider: route.platform, model: route.modelId, event: 'empty_completion', requestId: requestGroupId });
          skipKeys.add(`${route.platform}:${route.modelId}:${route.keyId}`);
          setCooldown(route.platform, route.modelId, route.keyId, getCooldownDurationForLimit(route.platform, route.modelId, route.keyId, { rpd: route.rpdLimit, tpd: route.tpdLimit }));
          recordRateLimitHit(route.modelDbId);
          lastError = new Error(`empty completion from ${route.displayName}`);
          continue;
        }

        if (msgItemId !== null) {
          sse('response.output_text.done', { item_id: msgItemId, output_index: 0, content_index: 0, text: msgText });
          sse('response.content_part.done', { item_id: msgItemId, output_index: 0, content_index: 0, part: { type: 'output_text', text: msgText, annotations: [] } });
          sse('response.output_item.done', { output_index: 0, item: { id: msgItemId, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: msgText, annotations: [] }] } });
        }
        const finalToolCalls: ChatToolCall[] = [];
        for (const acc of toolAcc.values()) {
          const repairedArgs = repairToolArguments(acc.args, toolSchemas.get(acc.name));
          sse('response.function_call_arguments.done', { item_id: acc.itemId, output_index: acc.outputIndex, arguments: repairedArgs });
          sse('response.output_item.done', { output_index: acc.outputIndex, item: { id: acc.itemId, type: 'function_call', status: 'completed', call_id: acc.callId, name: acc.name, arguments: repairedArgs } });
          finalToolCalls.push({ id: acc.callId, type: 'function', function: { name: acc.name, arguments: repairedArgs } });
        }

        const usageObj = usageChunk as Record<string, any> | null;
        const finalPromptTokens = usageObj?.usage && typeof usageObj.usage.prompt_tokens === 'number'
          ? usageObj.usage.prompt_tokens
          : estimatedInputTokens;
        const finalCompletionTokens = usageObj?.usage && typeof usageObj.usage.completion_tokens === 'number'
          ? usageObj.usage.completion_tokens
          : totalOutputTokens;
        const finalResponse = buildResponseObject({
          id: responseId, model: route.modelId, text: msgText,
          toolCalls: finalToolCalls, promptTokens: finalPromptTokens, completionTokens: finalCompletionTokens,
          cachedTokens: cachedFromStream,
        });
        sse('response.completed', { response: finalResponse });
        res.end();

        recordRequest(route.platform, route.modelId, route.keyId);
        recordTokens(route.platform, route.modelId, route.keyId, finalPromptTokens + finalCompletionTokens);
        recordSuccess(route.modelDbId);
        setStickyModel(messages, route.modelDbId, sessionIdHeader);
        traceRouteEvent('Responses', {
          event: 'ok',
          requestId: requestGroupId,
          attempt,
          platform: route.platform,
          model: route.modelId,
          latencyMs: Date.now() - start,
          inputTokens: finalPromptTokens,
          outputTokens: finalCompletionTokens,
        });
        logRequest(route.platform, route.modelId, route.keyId, 'success', finalPromptTokens, finalCompletionTokens, Date.now() - start, null, null, null, clientIp, cachedFromStream);
        return;
      } else {
        const result = await route.provider.chatCompletion(
          route.apiKey,
          messages,
          route.modelId,
          completionOpts,
          quotaContextForRoute(route, 'responses'),
        );

        const msg = result.choices[0]?.message;
        let text = contentToString(msg?.content ?? '');
        let toolCalls = (msg?.tool_calls ?? []).map((tc) => ({
          ...tc,
          function: { ...tc.function, arguments: repairToolArguments(tc.function.arguments, toolSchemas.get(tc.function.name)) },
        }));

        if (wantsTools && toolCalls.length === 0 && text) {
          const rescue = rescueInlineToolCalls(text, new Set((tools ?? []).map(t => t.function.name)));
          if (rescue.detected) {
            if (!rescue.calls) {
              throw new Error(`unparseable inline tool-call dialect from ${route.displayName}: ${text.slice(0, 120)}`);
            }
            providerLog(`Rescued ${rescue.calls.length} inline tool call(s) from ${route.displayName}`, { level: 'info', provider: route.platform, model: route.modelId, event: 'tool_rescue', requestId: requestGroupId });
            toolCalls = rescue.calls.map((c, i) => ({
              id: `call_rescued_${i + 1}`,
              type: 'function' as const,
              function: { name: c.name, arguments: repairToolArguments(c.arguments, toolSchemas.get(c.name)) },
            }));
            text = rescue.cleanText;
          }
        }
        const promptTokens = result.usage?.prompt_tokens ?? estimatedInputTokens;
        const completionTokens = result.usage?.completion_tokens ?? Math.ceil(text.length / 4);
        const cachedNonStream = result.usage ? usageCachedTokens(result.usage) : 0;

        if (!text && toolCalls.length === 0) {
          traceRouteEvent('Responses', {
            event: 'fail',
            requestId: requestGroupId,
            attempt,
            platform: route.platform,
            model: route.modelId,
            latencyMs: Date.now() - start,
            error: 'empty completion',
          });
          logRequest(route.platform, route.modelId, route.keyId, 'error', promptTokens, 0, Date.now() - start, 'empty completion (no content, no tool_calls)', null, null, clientIp);
          providerLog(`Empty completion from ${route.displayName} (no content, no tool_calls)`, { level: 'warn', provider: route.platform, model: route.modelId, event: 'empty_completion', requestId: requestGroupId });
          skipKeys.add(`${route.platform}:${route.modelId}:${route.keyId}`);
          setCooldown(route.platform, route.modelId, route.keyId, getCooldownDurationForLimit(route.platform, route.modelId, route.keyId, { rpd: route.rpdLimit, tpd: route.tpdLimit }));
          recordRateLimitHit(route.modelDbId);
          lastError = new Error(`empty completion from ${route.displayName}`);
          continue;
        }

        recordRequest(route.platform, route.modelId, route.keyId);
        recordTokens(route.platform, route.modelId, route.keyId, result.usage?.total_tokens ?? 0);
        recordSuccess(route.modelDbId);
        setStickyModel(messages, route.modelDbId, sessionIdHeader);

        res.setHeader('X-Routed-Via', `${route.platform}/${route.modelId}`);
        if (attempt > 0) res.setHeader('X-Fallback-Attempts', String(attempt));
        res.json(buildResponseObject({
          id: responseId, model: route.modelId, text, toolCalls,
          promptTokens, completionTokens, cachedTokens: cachedNonStream,
        }));

        traceRouteEvent('Responses', {
          event: 'ok',
          requestId: requestGroupId,
          attempt,
          platform: route.platform,
          model: route.modelId,
          latencyMs: Date.now() - start,
          inputTokens: promptTokens,
          outputTokens: completionTokens,
        });
        logRequest(route.platform, route.modelId, route.keyId, 'success', promptTokens, completionTokens, Date.now() - start, null, null, null, clientIp, cachedNonStream);
        return;
      }
    } catch (err: any) {
      const latency = Date.now() - start;
      const safeError = sanitizeProviderErrorMessage(err.message);
      traceRouteEvent('Responses', {
        event: 'fail',
        requestId: requestGroupId,
        attempt,
        platform: route.platform,
        model: route.modelId,
        latencyMs: latency,
        error: safeError,
      });
      logRequest(route.platform, route.modelId, route.keyId, 'error', estimatedInputTokens, 0, latency, safeError, null, null, clientIp);

      if (stream && streamStarted) {
        providerLog(`Mid-stream error from ${route.displayName}: stream interrupted`, { level: 'error', provider: route.platform, model: route.modelId, event: 'mid_stream_error', requestId: requestGroupId });
        sse('response.failed', { response: { id: responseId, object: 'response', status: 'failed', error: { message: `Provider error (${route.displayName}): stream interrupted`, type: 'stream_error' } } });
        res.end();
        return;
      }

      if (isKeyInvalidatingError(err, route.platform)) {
        invalidateKey(route.keyId, safeError);
        skipKeys.add(`${route.platform}:${route.modelId}:${route.keyId}`);
        providerLog(`Disabled invalid ${route.platform} key ${route.keyId}: ${safeError} (attempt ${attempt + 1}/${MAX_RETRIES})`, { level: 'warn', provider: route.platform, model: route.modelId, event: 'key_invalidated', requestId: requestGroupId });
        lastError = err;
        continue;
      }

      if (isRetryableError(err)) {
        if (isModelNotFoundError(err) || isModelAccessForbiddenError(err)) skipModels.add(route.modelDbId);
        skipKeys.add(`${route.platform}:${route.modelId}:${route.keyId}`);
        const modelGone = isModelGoneError(err);
        setCooldown(route.platform, route.modelId, route.keyId, modelGone
          ? MODEL_GONE_COOLDOWN_MS
          : isPaymentRequiredError(err)
          ? PAYMENT_REQUIRED_COOLDOWN_MS
          : getCooldownDurationForLimit(route.platform, route.modelId, route.keyId, { rpd: route.rpdLimit, tpd: route.tpdLimit }),
          modelGone ? 'model_eol' : undefined);
        recordRateLimitHit(route.modelDbId);
        learnLimitFromError(route.modelDbId, err);
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
      res.status(502).json({ error: { message: `Provider error (${route.displayName}): ${safeError}`, type: 'provider_error' } });
      return;
    } finally {
      releaseKeySlot(route.platform, route.keyId);
    }
  }

  if (modelGoneEntry !== null) {
    const gone: { platform: string; modelId: string; displayName: string; providerMessage: string } = modelGoneEntry;
    const goneMsg = `Model '${gone.displayName}' on ${gone.platform} is no longer available. ${gone.providerMessage} Choose a different model or call /v1/models for the available list.`;
    if (streamStarted) {
      sse('response.failed', { response: { id: responseId, object: 'response', status: 'failed', error: { message: goneMsg, type: 'model_gone', code: 'model_no_longer_available' } } });
      res.end();
      return;
    }
    res.status(410).json({
      error: { message: goneMsg, type: 'model_gone', code: 'model_no_longer_available' },
    });
    return;
  }

  const exhaustedMsg = `All models rate-limited after ${MAX_RETRIES} attempts. Last: ${lastError?.message}`;
  if (streamStarted) {
    sse('response.failed', { response: { id: responseId, object: 'response', status: 'failed', error: { message: exhaustedMsg, type: 'rate_limit_error' } } });
    res.end();
    return;
  }
  res.status(429).json({
    error: { message: exhaustedMsg, type: 'rate_limit_error' },
  });
});
