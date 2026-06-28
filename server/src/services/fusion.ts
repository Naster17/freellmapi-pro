import { z } from 'zod';
import type { ChatMessage, ChatCompletionChoice, ChatCompletionResponse, ChatToolCall, TokenUsage } from '@freellmapi/shared/types.js';
import {
  routePinnedModel, routeRequest, getOrderedFusionChain, resolveFusionCandidate,
  recordRateLimitHit, recordSuccess, type RouteResult, type FusionCandidate,
} from './router.js';
import {
  recordRequest, recordTokens, setCooldown, getCooldownDurationForLimit,
  PAYMENT_REQUIRED_COOLDOWN_MS, MODEL_FORBIDDEN_COOLDOWN_MS,
  reserveKeySlot, releaseKeySlot,
} from './ratelimit.js';
import { logRequest } from '../lib/request-log.js';
import {
  isRetryableError, isPaymentRequiredError,
  isModelNotFoundError, isModelAccessForbiddenError,
} from '../lib/error-classify.js';
import { contentToString } from '../lib/content.js';
import { sanitizeProviderErrorMessage } from '../lib/error-redaction.js';
import { getSetting, setSetting } from '../db/index.js';
import type { CompletionOptions } from '../providers/base.js';

export const FUSION_MODEL_ID = 'fusion';

export function isFusionModel(modelId: string | undefined): boolean {
  if (!modelId) return false;
  const lower = modelId.toLowerCase();
  return lower === FUSION_MODEL_ID || lower.startsWith(`${FUSION_MODEL_ID}:`);
}

const FUSION_TAG = 'fusion';

const DEFAULT_PANEL_K = 4;
const HARD_MAX_PANEL_K = 8;
const SYNTHESIS_QUORUM = 2;
const MAX_SLOT_ATTEMPTS = 4;
const MAX_JUDGE_ATTEMPTS = 6;

function intSetting(key: string, fallback: number): number {
  const raw = getSetting(key);
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function panelDefaultK(): number {
  return Math.min(intSetting('fusion_default_k', DEFAULT_PANEL_K), panelMaxK());
}
function panelMaxK(): number {
  return Math.min(intSetting('fusion_max_k', HARD_MAX_PANEL_K), HARD_MAX_PANEL_K);
}

export const fusionConfigSchema = z.object({
  models: z.array(z.string().min(1)).optional(),
  k: z.number().int().positive().optional(),
  judge: z.string().min(1).optional(),
  strategy: z.enum(['synthesize', 'best_of']).optional(),
  expose_panel: z.boolean().optional(),
});

export type FusionConfig = z.infer<typeof fusionConfigSchema>;

export function getFusionMaxK(): number {
  return panelMaxK();
}

const SAVED_FUSION_KEY = 'fusion_config';

export const savedFusionConfigSchema = z.object({
  mode: z.enum(['auto', 'explicit']),
  models: z.array(z.string().min(1)).default([]),
  judge: z.string().min(1).nullable().default(null),
  k: z.number().int().positive(),
  strategy: z.enum(['synthesize', 'best_of']),
  expose_panel: z.boolean(),
});

export type SavedFusionConfig = z.infer<typeof savedFusionConfigSchema>;

function defaultSavedConfig(): SavedFusionConfig {
  return { mode: 'auto', models: [], judge: null, k: panelDefaultK(), strategy: 'synthesize', expose_panel: false };
}

export function getSavedFusionConfig(): SavedFusionConfig {
  const raw = getSetting(SAVED_FUSION_KEY);
  if (raw) {
    try {
      const parsed = savedFusionConfigSchema.safeParse(JSON.parse(raw));
      if (parsed.success) return parsed.data;
    } catch { }
  }
  return defaultSavedConfig();
}

export function setSavedFusionConfig(input: SavedFusionConfig): SavedFusionConfig {
  const maxK = panelMaxK();
  const normalized: SavedFusionConfig = {
    mode: input.mode,
    models: [...new Set(input.models)].slice(0, maxK),
    judge: input.judge && input.judge.trim() ? input.judge.trim() : null,
    k: Math.min(Math.max(input.k, 1), maxK),
    strategy: input.strategy,
    expose_panel: input.expose_panel,
  };
  setSetting(SAVED_FUSION_KEY, JSON.stringify(normalized));
  return normalized;
}

export function resolveEffectiveConfig(req: FusionConfig): FusionConfig {
  const saved = getSavedFusionConfig();
  const models = (req.models && req.models.length > 0)
    ? req.models
    : (saved.mode === 'explicit' && saved.models.length > 0 ? saved.models : undefined);
  return {
    models,
    k: req.k ?? saved.k,
    judge: req.judge ?? saved.judge ?? undefined,
    strategy: req.strategy ?? saved.strategy,
    expose_panel: req.expose_panel ?? saved.expose_panel,
  };
}

interface PanelAnswer {
  modelDbId: number;
  platform: string;
  modelId: string;
  displayName: string;
  status: 'ok' | 'failed';
  content?: string;
  toolCalls?: ChatToolCall[];
  rawChoice?: ChatCompletionChoice;
  error?: string;
  usage?: TokenUsage;
}

interface CallOutcome {
  ok: boolean;
  route?: RouteResult;
  text?: string;
  toolCalls?: ChatToolCall[];
  rawChoice?: ChatCompletionChoice;
  usage?: TokenUsage;
  error?: string;
}

const ZERO_USAGE: TokenUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

function addUsage(a: TokenUsage, b: TokenUsage | undefined): TokenUsage {
  if (!b) return a;
  return {
    prompt_tokens: a.prompt_tokens + (b.prompt_tokens ?? 0),
    completion_tokens: a.completion_tokens + (b.completion_tokens ?? 0),
    total_tokens: a.total_tokens + (b.total_tokens ?? 0),
  };
}

type RouteSelector = (skipKeys: Set<string>, skipModels: Set<number>) => Promise<RouteResult | null> | RouteResult | null;

async function runModelCall(
  getRoute: RouteSelector,
  messages: ChatMessage[],
  options: CompletionOptions,
  estimatedTokens: number,
  maxAttempts: number,
  clientIp: string | null,
): Promise<CallOutcome> {
  const skipKeys = new Set<string>();
  const skipModels = new Set<number>();
  let lastError: string | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let route: RouteResult | null;
    try {
      route = await getRoute(skipKeys, skipModels);
    } catch (err: any) {
      lastError = sanitizeProviderErrorMessage(err?.message);
      break;
    }
    if (!route) break;

    const startedAt = Date.now();
    reserveKeySlot(route.platform, route.keyId);
    try {
      const result = await route.provider.chatCompletion(route.apiKey, messages, route.modelId, options);
      const choice = result.choices?.[0];
      const text = contentToString(choice?.message?.content ?? '');
      const toolCalls = choice?.message?.tool_calls;
      const hasToolCalls = Array.isArray(toolCalls) && toolCalls.length > 0;

      if (!text && !hasToolCalls) {
        logRequest(route.platform, route.modelId, route.keyId, 'error', 0, 0, Date.now() - startedAt, 'empty completion (fusion)', null, FUSION_TAG, clientIp);
        skipKeys.add(`${route.platform}:${route.modelId}:${route.keyId}`);
        setCooldown(route.platform, route.modelId, route.keyId, getCooldownDurationForLimit(route.platform, route.modelId, route.keyId, { rpd: route.rpdLimit, tpd: route.tpdLimit }));
        recordRateLimitHit(route.modelDbId);
        lastError = `empty completion from ${route.displayName}`;
        continue;
      }

      const usage = result.usage ?? ZERO_USAGE;
      recordRequest(route.platform, route.modelId, route.keyId);
      recordTokens(route.platform, route.modelId, route.keyId, usage.total_tokens);
      recordSuccess(route.modelDbId);
      logRequest(route.platform, route.modelId, route.keyId, 'success', usage.prompt_tokens ?? 0, usage.completion_tokens ?? 0, Date.now() - startedAt, null, null, FUSION_TAG, clientIp);
      return {
        ok: true,
        route,
        text,
        toolCalls: hasToolCalls ? toolCalls : undefined,
        rawChoice: hasToolCalls ? choice : undefined,
        usage,
      };
    } catch (err: any) {
      const safe = sanitizeProviderErrorMessage(err?.message);
      logRequest(route.platform, route.modelId, route.keyId, 'error', 0, 0, Date.now() - startedAt, safe, null, FUSION_TAG, clientIp);
      lastError = safe;

      if (isRetryableError(err)) {
        if (isModelNotFoundError(err) || isModelAccessForbiddenError(err)) skipModels.add(route.modelDbId);
        skipKeys.add(`${route.platform}:${route.modelId}:${route.keyId}`);
        setCooldown(
          route.platform, route.modelId, route.keyId,
          isPaymentRequiredError(err)
            ? PAYMENT_REQUIRED_COOLDOWN_MS
            : isModelAccessForbiddenError(err)
            ? MODEL_FORBIDDEN_COOLDOWN_MS
            : getCooldownDurationForLimit(route.platform, route.modelId, route.keyId, { rpd: route.rpdLimit, tpd: route.tpdLimit }, err.retryAfterMs),
        );
        recordRateLimitHit(route.modelDbId);
        continue;
      }
      break;
    } finally {
      releaseKeySlot(route.platform, route.keyId);
    }
  }

  return { ok: false, error: lastError ?? 'no available key for model' };
}

async function runJudgeStreaming(
  getRoute: (skipKeys: Set<string>, skipModels: Set<number>) => Promise<RouteResult | null> | RouteResult | null,
  messages: ChatMessage[],
  options: CompletionOptions,
  estimatedTokens: number,
  maxAttempts: number,
  cb: { onStart?: (r: { platform: string; model: string }) => void; onDelta?: (t: string) => void },
  clientIp: string | null,
): Promise<CallOutcome> {
  const skipKeys = new Set<string>();
  const skipModels = new Set<number>();
  let lastError: string | undefined;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    let route: RouteResult | null;
    try { route = await getRoute(skipKeys, skipModels); } catch (err: any) { lastError = sanitizeProviderErrorMessage(err?.message); break; }
    if (!route) break;

    const startedAt = Date.now();
    let text = '';
    let started = false;
    reserveKeySlot(route.platform, route.keyId);
    try {
      for await (const chunk of route.provider.streamChatCompletion(route.apiKey, messages, route.modelId, options)) {
        const delta = (chunk as any)?.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta.length > 0) {
          if (!started) { started = true; cb.onStart?.({ platform: route.platform, model: route.modelId }); }
          text += delta;
          cb.onDelta?.(delta);
        }
      }
      if (!text) {
        logRequest(route.platform, route.modelId, route.keyId, 'error', 0, 0, Date.now() - startedAt, 'empty completion (fusion judge)', null, FUSION_TAG, clientIp);
        skipKeys.add(`${route.platform}:${route.modelId}:${route.keyId}`);
        setCooldown(route.platform, route.modelId, route.keyId, getCooldownDurationForLimit(route.platform, route.modelId, route.keyId, { rpd: route.rpdLimit, tpd: route.tpdLimit }));
        recordRateLimitHit(route.modelDbId);
        lastError = `empty judge completion from ${route.displayName}`;
        continue;
      }
      const out = Math.ceil(text.length / 4);
      const usage: TokenUsage = { prompt_tokens: estimatedTokens, completion_tokens: out, total_tokens: estimatedTokens + out };
      recordRequest(route.platform, route.modelId, route.keyId);
      recordTokens(route.platform, route.modelId, route.keyId, usage.total_tokens);
      recordSuccess(route.modelDbId);
      logRequest(route.platform, route.modelId, route.keyId, 'success', estimatedTokens, out, Date.now() - startedAt, null, null, FUSION_TAG, clientIp);
      return { ok: true, route, text, usage };
    } catch (err: any) {
      const safe = sanitizeProviderErrorMessage(err?.message);
      logRequest(route.platform, route.modelId, route.keyId, 'error', 0, 0, Date.now() - startedAt, safe, null, FUSION_TAG, clientIp);
      lastError = safe;
      if (started) {
        if (text) {
          const out = Math.ceil(text.length / 4);
          return { ok: true, route, text, usage: { prompt_tokens: estimatedTokens, completion_tokens: out, total_tokens: estimatedTokens + out } };
        }
        break;
      }
      if (isRetryableError(err)) {
        if (isModelNotFoundError(err) || isModelAccessForbiddenError(err)) skipModels.add(route.modelDbId);
        skipKeys.add(`${route.platform}:${route.modelId}:${route.keyId}`);
        setCooldown(
          route.platform, route.modelId, route.keyId,
          isPaymentRequiredError(err) ? PAYMENT_REQUIRED_COOLDOWN_MS
            : isModelAccessForbiddenError(err) ? MODEL_FORBIDDEN_COOLDOWN_MS
            : getCooldownDurationForLimit(route.platform, route.modelId, route.keyId, { rpd: route.rpdLimit, tpd: route.tpdLimit }, err.retryAfterMs),
        );
        recordRateLimitHit(route.modelDbId);
        continue;
      }
      break;
    } finally {
      releaseKeySlot(route.platform, route.keyId);
    }
  }
  return { ok: false, error: lastError ?? 'no available key for judge' };
}

export function familyKey(modelId: string): string {
  return modelId.toLowerCase().replace(/^.*\//, '').replace(/:.*$/, '');
}

export function diversifyChain(ordered: FusionCandidate[]): FusionCandidate[] {
  const seenPlatform = new Set<string>();
  const platformFirst: FusionCandidate[] = [];
  const platformRest: FusionCandidate[] = [];
  for (const c of ordered) {
    if (seenPlatform.has(c.platform)) platformRest.push(c);
    else { seenPlatform.add(c.platform); platformFirst.push(c); }
  }
  const seenFamily = new Set<string>();
  const fresh: FusionCandidate[] = [];
  const dupFamily: FusionCandidate[] = [];
  for (const c of [...platformFirst, ...platformRest]) {
    const fam = familyKey(c.modelId);
    if (seenFamily.has(fam)) dupFamily.push(c);
    else { seenFamily.add(fam); fresh.push(c); }
  }
  return [...fresh, ...dupFamily];
}

function selectPanel(config: FusionConfig, requirements: { requireTools?: boolean } = {}): { panel: FusionCandidate[]; overflow: FusionCandidate[]; dropped: string[] } {
  const maxK = panelMaxK();

  if (config.models && config.models.length > 0) {
    const panel: FusionCandidate[] = [];
    const dropped: string[] = [];
    const seen = new Set<number>();
    for (const id of config.models) {
      if (panel.length >= maxK) { dropped.push(`${id} (over cap of ${maxK})`); continue; }
      const cand = resolveFusionCandidate(id);
      if (!cand) { dropped.push(`${id} (unknown or disabled)`); continue; }
      if (requirements.requireTools && !cand.supportsTools) { dropped.push(`${id} (no tool-calling support)`); continue; }
      if (seen.has(cand.modelDbId)) continue;
      seen.add(cand.modelDbId);
      panel.push(cand);
    }
    return { panel, overflow: [], dropped };
  }

  const k = Math.min(Math.max(config.k ?? panelDefaultK(), 1), maxK);
  const ordered = getOrderedFusionChain().filter(c => !requirements.requireTools || c.supportsTools);

  const full = diversifyChain(ordered);

  const panel = full.slice(0, k);
  const overflow = full.slice(k, k * 2);
  return { panel, overflow, dropped: [] };
}

const JUDGE_SYSTEM_PROMPT =
  'You are the final author of a single answer. Several AI assistants each independently answered the user\'s most recent message; their answers are provided below, anonymized as "Response 1", "Response 2", etc. ' +
  'IMPORTANT: the user will NEVER see any of those individual responses — they only ever see what you write — so your answer must be COMPLETE and fully STAND-ALONE on its own. ' +
  'Take the best parts of every response, combine the correct and most useful ideas into one coherent whole, resolve any contradictions by reasoning about which is actually right (do not just average or list options), and fill in anything they all missed. ' +
  'Then REWRITE it all from scratch, in your own words, as one clear, well-structured, self-contained answer that makes complete sense by itself. ' +
  'Do not mention that other answers exist, do not refer to "Response 1/2/3", do not compare the responses, and do not describe your process — just deliver the final, authoritative answer directly to the user.';

function buildJudgeMessages(original: ChatMessage[], answers: PanelAnswer[]): ChatMessage[] {
  const ok = answers.filter(a => a.status === 'ok' && a.content);
  const panelBlock = ok
    .map((a, i) => `--- Response ${i + 1} ---\n${a.content}`)
    .join('\n\n');

  return [
    { role: 'system', content: JUDGE_SYSTEM_PROMPT },
    ...original,
    {
      role: 'user',
      content:
        `Here are ${ok.length} independent answers to my most recent message:\n\n${panelBlock}\n\n` +
        'Take the best parts of these, then rewrite one complete, self-contained answer to my most recent message in your own words. ' +
        'I will only see your answer — not these — so do not reference them.',
    },
  ];
}

export interface FusionResult {
  response: ChatCompletionResponse & { x_fusion?: unknown };
  routedVia: string;
}

export class FusionError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export interface FusionHooks {
  onPanel?: (a: { platform: string; model: string; status: 'ok' | 'failed'; content?: string; tool_calls?: ChatToolCall[]; error?: string }) => void;
  onJudge?: (j: { platform: string; model: string }) => void;
  onJudgeDelta?: (text: string) => void;
}

export async function runFusion(params: {
  messages: ChatMessage[];
  config: FusionConfig;
  options: CompletionOptions;
  estimatedTokens: number;
  clientIp?: string | null;
  hooks?: FusionHooks;
}): Promise<FusionResult> {
  const { messages, options, estimatedTokens, hooks } = params;
  const clientIp = params.clientIp ?? null;
  const config = resolveEffectiveConfig(params.config);
  const strategy = config.strategy ?? 'synthesize';

  const requireTools = (options.tools?.length ?? 0) > 0;
  const { panel, overflow, dropped } = selectPanel(config, { requireTools });
  if (panel.length === 0) {
    throw new FusionError(
      'fusion: no usable models for the panel. Provide `fusion.models` with enabled model ids, or enable models in the Fallback Chain.',
      400,
    );
  }

  const runSlot = (cand: FusionCandidate): Promise<PanelAnswer> =>
    runModelCall(
      (skipKeys, _skipModels) => routePinnedModel(cand.modelDbId, estimatedTokens, skipKeys),
      messages, options, estimatedTokens, MAX_SLOT_ATTEMPTS, clientIp,
    ).then((outcome): PanelAnswer => {
      const answer: PanelAnswer = outcome.ok
        ? {
            modelDbId: cand.modelDbId,
            platform: cand.platform,
            modelId: cand.modelId,
            displayName: cand.displayName,
            status: 'ok',
            content: outcome.text,
            toolCalls: outcome.toolCalls,
            rawChoice: outcome.rawChoice,
            usage: outcome.usage,
          }
        : { modelDbId: cand.modelDbId, platform: cand.platform, modelId: cand.modelId, displayName: cand.displayName, status: 'failed', error: outcome.error };
      hooks?.onPanel?.({ platform: answer.platform, model: answer.modelId, status: answer.status, content: answer.content, tool_calls: answer.toolCalls, error: answer.error });
      return answer;
    });

  const target = panel.length;
  const candidates = [...panel, ...overflow];
  const answers: PanelAnswer[] = [];
  let okCount = 0;
  let cursor = 0;
  while (okCount < target && cursor < candidates.length) {
    const wave = candidates.slice(cursor, cursor + (target - okCount));
    cursor += wave.length;
    const settled = await Promise.allSettled(wave.map(runSlot));
    settled.forEach((s, i) => {
      const a: PanelAnswer = s.status === 'fulfilled'
        ? s.value
        : { modelDbId: wave[i].modelDbId, platform: wave[i].platform, modelId: wave[i].modelId, displayName: wave[i].displayName, status: 'failed', error: sanitizeProviderErrorMessage((s as PromiseRejectedResult).reason?.message) };
      answers.push(a);
      if (a.status === 'ok' && (a.content || (a.toolCalls?.length ?? 0) > 0)) okCount++;
    });
  }

  const survivors = answers.filter(a => a.status === 'ok' && (a.content || (a.toolCalls?.length ?? 0) > 0));
  let totalUsage: TokenUsage = { ...ZERO_USAGE };
  for (const a of survivors) totalUsage = addUsage(totalUsage, a.usage);

  if (survivors.length === 0) {
    throw new FusionError(
      'fusion: every panel model failed or was rate-limited. Try again shortly or pick different `fusion.models`.',
      429,
    );
  }

  const toolCallWinner = survivors.find(a => (a.toolCalls?.length ?? 0) > 0 && a.rawChoice);
  if (toolCallWinner) {
    const choice: ChatCompletionChoice = {
      index: 0,
      message: toolCallWinner.rawChoice!.message,
      finish_reason: 'tool_calls',
    };
    const response: ChatCompletionResponse & { x_fusion?: unknown; _fusion?: unknown } = {
      id: `fusion-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: FUSION_MODEL_ID,
      choices: [choice],
      usage: totalUsage,
    };
    const winner = { platform: toolCallWinner.platform, model: toolCallWinner.modelId };
    response._fusion = {
      panel: survivors.map(a => ({ platform: a.platform, model: a.modelId })),
      judge: null,
      synthesized: false,
      tool_call_winner: winner,
    };

    if (config.expose_panel) {
      response.x_fusion = {
        strategy,
        synthesized: false,
        judge: null,
        panel_requested: panel.map(p => p.modelId),
        dropped,
        tool_call_winner: winner,
        panel: answers.map(a => ({
          model: a.modelId,
          platform: a.platform,
          status: a.status,
          ...(a.status === 'ok'
            ? { content: a.content, tool_calls: a.toolCalls }
            : { error: a.error }),
        })),
      };
    }

    return {
      response,
      routedVia: `fusion(${survivors.map(a => a.modelId).join('+')} -> tool_call:${toolCallWinner.modelId})`,
    };
  }

  const textSurvivors = survivors.filter(a => a.content);

  let finalText: string;
  let judgeModelLabel: string | null = null;
  let judgeRoute: { platform: string; model: string } | null = null;
  let synthesized = false;

  if (textSurvivors.length < SYNTHESIS_QUORUM || strategy === 'best_of') {
    finalText = textSurvivors.slice().sort((a, b) => (b.content!.length - a.content!.length))[0].content!;
  } else {
    const judgeMessages = buildJudgeMessages(messages, textSurvivors);
    const judgeEstimate = estimatedTokens + textSurvivors.reduce((n, a) => n + Math.ceil((a.content?.length ?? 0) / 4), 0);
    const judgeOptions: CompletionOptions = requireTools
      ? { ...options, tools: undefined, tool_choice: undefined, parallel_tool_calls: undefined }
      : options;

    const getJudgeRoute = config.judge
      ? async (skipKeys: Set<string>, _skipModels: Set<number>) => {
          const cand = resolveFusionCandidate(config.judge!);
          return cand ? routePinnedModel(cand.modelDbId, judgeEstimate, skipKeys) : null;
        }
      : async (skipKeys: Set<string>, skipModels: Set<number>) => routeRequest(judgeEstimate, skipKeys.size ? skipKeys : undefined, undefined, false, false, skipModels.size ? skipModels : undefined);

    const judge = hooks?.onJudgeDelta
      ? await runJudgeStreaming(getJudgeRoute, judgeMessages, judgeOptions, judgeEstimate, MAX_JUDGE_ATTEMPTS, {
          onStart: (r) => { judgeRoute = r; judgeModelLabel = `${r.platform}/${r.model}`; hooks.onJudge?.(r); },
          onDelta: hooks.onJudgeDelta,
        }, clientIp)
      : await runModelCall(getJudgeRoute, judgeMessages, judgeOptions, judgeEstimate, MAX_JUDGE_ATTEMPTS, clientIp);

    if (judge.ok && judge.text) {
      finalText = judge.text;
      synthesized = true;
      if (!judgeRoute && judge.route) judgeRoute = { platform: judge.route.platform, model: judge.route.modelId };
      judgeModelLabel = judgeRoute ? `${judgeRoute.platform}/${judgeRoute.model}` : null;
      if (!hooks?.onJudgeDelta && judgeRoute) hooks?.onJudge?.(judgeRoute);
      totalUsage = addUsage(totalUsage, judge.usage);
    } else {
      finalText = textSurvivors.slice().sort((a, b) => (b.content!.length - a.content!.length))[0].content!;
    }
  }

  const routedModels = textSurvivors.map(a => a.modelId);
  const routedVia = `fusion(${routedModels.join('+')}${synthesized && judgeModelLabel ? ` -> ${judgeModelLabel}` : ''})`;

  const response: ChatCompletionResponse & { x_fusion?: unknown; _fusion?: unknown } = {
    id: `fusion-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: FUSION_MODEL_ID,
    choices: [{ index: 0, message: { role: 'assistant', content: finalText }, finish_reason: 'stop' }],
    usage: totalUsage,
  };

  response._fusion = {
    panel: survivors.map(a => ({ platform: a.platform, model: a.modelId })),
    judge: synthesized ? judgeRoute : null,
    synthesized,
  };

  if (config.expose_panel) {
    response.x_fusion = {
      strategy,
      synthesized,
      judge: judgeModelLabel,
      panel_requested: panel.map(p => p.modelId),
      dropped,
      panel: answers.map(a => ({
        model: a.modelId,
        platform: a.platform,
        status: a.status,
        ...(a.status === 'ok' ? { content: a.content } : { error: a.error }),
      })),
    };
  }

  return { response, routedVia };
}
