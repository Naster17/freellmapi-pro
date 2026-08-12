import { Router } from 'express';
import type { Request, Response } from 'express';
import { getUnifiedApiKey, regenerateUnifiedKey, getSetting, setSetting } from '../db/index.js';
import { applyProxyUrl, applyProxyEnabled, applyProxyBypass, isProxyActive, getProxyUrl, isProxyEnabled, getProxyBypassPlatforms, PROXY_SCHEMES } from '../lib/proxy.js';
import { getSavedFusionConfig, setSavedFusionConfig, savedFusionConfigSchema, getFusionMaxK } from '../services/fusion.js';
import { isUnifyEnabled, setUnifyEnabled, getUnifyOverrides, setUnifyOverrides, unifyOverridesSchema } from '../services/model-groups.js';
import { getClaudeModelMap, setClaudeModelMap } from '../services/anthropic-map.js';
import { getProbeOnCooldown, setProbeOnCooldown, getStrictChain, setStrictChain } from '../services/router.js';
import { getSoftLimitsEnabled, setSoftLimitsEnabled } from '../services/ratelimit.js';
import { getRequestAnalyticsRetentionConfig } from '../services/request-retention.js';
import { getGeminiModelMap, setGeminiModelMap } from '../services/gemini-map.js';
import { getOllamaEmulationMode } from './ollama.js';
import { listUrlTokens, mintUrlToken, revokeUrlToken } from '../services/url-tokens.js';
import {
  getRequestMaxTokensBudget,
  getMaxConsecutiveUpstreamFails,
  REQUEST_MAX_TOKENS_BUDGET_SETTING,
  MAX_CONSECUTIVE_UPSTREAM_FAILS_SETTING,
} from '../lib/guardrails.js';
import {
  compressionUpdateSchema,
  getCompressionConfig,
  setCompressionConfig,
} from '../services/compression/config.js';
import { z } from 'zod';
import { getAppVersion } from '../lib/app-version.js';
import { getZenKeylessState, setZenKeylessMode } from '../services/zen-keyless.js';

export const settingsRouter = Router();

// Which RELEASE this install is, for the dashboard's version row (#703).
// Deliberately NOT /api/version: the Ollama emulation already owns that path
// and answers it for real Ollama clients, so mounting here would have shadowed
// it. `null` means the version could not be established honestly, and the
// dashboard then shows nothing rather than a number that isn't the release.
settingsRouter.get('/version', (_req: Request, res: Response) => {
  res.json({ version: getAppVersion() });
});

settingsRouter.get('/compression', (_req: Request, res: Response) => {
  res.json(getCompressionConfig());
});

settingsRouter.put('/compression', (req: Request, res: Response) => {
  const parsed = compressionUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    const detail = parsed.error.errors
      .map(e => (e.path.length ? `${e.path.join('.')}: ${e.message}` : e.message))
      .slice(0, 5)
      .join(', ');
    res.status(400).json({
      error: { message: `Invalid compression settings: ${detail}`, type: 'invalid_request_error' },
    });
    return;
  }
  res.json(setCompressionConfig(parsed.data));
});

// Get the model-unification setting: the global toggle (default ON) plus any
// merge/split overrides. Governs the dashboard grouping, /v1/models grouping,
// and cross-provider pin failover.
settingsRouter.get('/unify', (_req: Request, res: Response) => {
  res.json({ enabled: isUnifyEnabled(), overrides: getUnifyOverrides() });
});

const unifyPutSchema = z.object({
  enabled: z.boolean().optional(),
  overrides: unifyOverridesSchema.optional(),
});

// Update the unify toggle and/or overrides. Partial: send just `enabled` to
// flip the switch, or `overrides` to adjust grouping, or both.
settingsRouter.put('/unify', (req: Request, res: Response) => {
  const parsed = unifyPutSchema.safeParse(req.body);
  if (!parsed.success) {
    const detail = parsed.error.errors.map(e => (e.path.length ? `${e.path.join('.')}: ${e.message}` : e.message)).slice(0, 5).join(', ');
    res.status(400).json({ error: { message: `Invalid unify settings: ${detail}`, type: 'invalid_request_error' } });
    return;
  }
  if (parsed.data.enabled !== undefined) setUnifyEnabled(parsed.data.enabled);
  if (parsed.data.overrides) setUnifyOverrides(parsed.data.overrides);
  res.json({ enabled: isUnifyEnabled(), overrides: getUnifyOverrides() });
});

// Get the saved fusion default config (panel mode, models, judge, k, strategy).
settingsRouter.get('/fusion', (_req: Request, res: Response) => {
  res.json({ config: getSavedFusionConfig(), maxK: getFusionMaxK() });
});

// Save the fusion default config. A request's inline `fusion` field still
// overrides this per call (see services/fusion.ts resolveEffectiveConfig).
settingsRouter.put('/fusion', (req: Request, res: Response) => {
  const parsed = savedFusionConfigSchema.safeParse(req.body);
  if (!parsed.success) {
    const detail = parsed.error.errors.map(e => (e.path.length ? `${e.path.join('.')}: ${e.message}` : e.message)).slice(0, 5).join(', ');
    res.status(400).json({ error: { message: `Invalid fusion config: ${detail}`, type: 'invalid_request_error' } });
    return;
  }
  const saved = setSavedFusionConfig(parsed.data);
  res.json({ config: saved, maxK: getFusionMaxK() });
});

// Get the Claude Code model map (opus/sonnet/haiku/default → 'auto' | model_id).
// Drives how the Anthropic /v1/messages route resolves Claude Code's built-in
// model names against the free pool.
settingsRouter.get('/anthropic-map', (_req: Request, res: Response) => {
  res.json({ map: getClaudeModelMap() });
});

// Update the Claude Code model map. Partial: send just the families you want to
// change; each value is 'auto' or a catalog model_id.
settingsRouter.put('/anthropic-map', (req: Request, res: Response) => {
  try {
    res.json({ map: setClaudeModelMap(req.body) });
  } catch (err: any) {
    const detail = err?.errors
      ? err.errors.map((e: any) => (e.path?.length ? `${e.path.join('.')}: ${e.message}` : e.message)).slice(0, 5).join(', ')
      : (err?.message ?? 'invalid');
    res.status(400).json({ error: { message: `Invalid anthropic model map: ${detail}`, type: 'invalid_request_error' } });
  }
});

settingsRouter.get('/gemini-map', (_req: Request, res: Response) => {
  res.json({ map: getGeminiModelMap() });
});

settingsRouter.put('/gemini-map', (req: Request, res: Response) => {
  try {
    res.json({ map: setGeminiModelMap(req.body) });
  } catch (err: any) {
    const detail = err?.errors
      ? err.errors.map((e: any) => (e.path?.length ? `${e.path.join('.')}: ${e.message}` : e.message)).slice(0, 5).join(', ')
      : (err?.message ?? 'invalid');
    res.status(400).json({ error: { message: `Invalid Gemini model map: ${detail}`, type: 'invalid_request_error' } });
  }
});

const compatibilitySchema = z.object({
  ollamaEmulation: z.enum(['off', 'open-loopback', 'key-required']).optional(),
  exposeClaudeDiscoveryAliases: z.boolean().optional(),
}).strict();

settingsRouter.get('/agent-compatibility', (_req: Request, res: Response) => {
  res.json({
    ollamaEmulation: getOllamaEmulationMode(),
    exposeClaudeDiscoveryAliases: getSetting('expose_cc_discovery_aliases') === '1',
  });
});

settingsRouter.put('/agent-compatibility', (req: Request, res: Response) => {
  const parsed = compatibilitySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: {
        message: `Invalid agent compatibility settings: ${parsed.error.errors.map(error => error.message).join(', ')}`,
        type: 'invalid_request_error',
      },
    });
    return;
  }
  if (parsed.data.ollamaEmulation) setSetting('ollama_emulation', parsed.data.ollamaEmulation);
  if (parsed.data.exposeClaudeDiscoveryAliases !== undefined) {
    setSetting('expose_cc_discovery_aliases', parsed.data.exposeClaudeDiscoveryAliases ? '1' : '0');
  }
  res.json({
    ollamaEmulation: getOllamaEmulationMode(),
    exposeClaudeDiscoveryAliases: getSetting('expose_cc_discovery_aliases') === '1',
  });
});

settingsRouter.get('/url-tokens', (_req: Request, res: Response) => {
  res.json({ tokens: listUrlTokens() });
});

settingsRouter.post('/url-tokens', (req: Request, res: Response) => {
  const parsed = z.object({ label: z.string().max(120).optional() }).safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid URL token label', type: 'invalid_request_error' } });
    return;
  }
  res.status(201).json(mintUrlToken(parsed.data.label ?? ''));
});

settingsRouter.delete('/url-tokens/:id', (req: Request, res: Response) => {
  const id = Number.parseInt(String(req.params.id), 10);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: { message: 'Invalid URL token id', type: 'invalid_request_error' } });
    return;
  }
  if (!revokeUrlToken(id)) {
    res.status(404).json({ error: { message: 'Active URL token not found', type: 'not_found_error' } });
    return;
  }
  res.status(204).end();
});

// Get the request guardrails (per-request token budget + failover circuit
// breaker). Both default to 0 = disabled; see lib/guardrails.ts.
settingsRouter.get('/guardrails', (_req: Request, res: Response) => {
  res.json({
    requestMaxTokensBudget: getRequestMaxTokensBudget(),
    maxConsecutiveUpstreamFails: getMaxConsecutiveUpstreamFails(),
  });
});

const guardrailsPutSchema = z.object({
  requestMaxTokensBudget: z.number().int().min(0).optional(),
  maxConsecutiveUpstreamFails: z.number().int().min(0).optional(),
});

// Update the guardrails. Partial: send just the knob you want to change.
// Takes effect on the next request — no restart needed. 0 disables a knob.
settingsRouter.put('/guardrails', (req: Request, res: Response) => {
  const parsed = guardrailsPutSchema.safeParse(req.body);
  if (!parsed.success) {
    const detail = parsed.error.errors.map(e => (e.path.length ? `${e.path.join('.')}: ${e.message}` : e.message)).slice(0, 5).join(', ');
    res.status(400).json({ error: { message: `Invalid guardrail settings: ${detail}`, type: 'invalid_request_error' } });
    return;
  }
  if (parsed.data.requestMaxTokensBudget !== undefined) {
    setSetting(REQUEST_MAX_TOKENS_BUDGET_SETTING, String(parsed.data.requestMaxTokensBudget));
  }
  if (parsed.data.maxConsecutiveUpstreamFails !== undefined) {
    setSetting(MAX_CONSECUTIVE_UPSTREAM_FAILS_SETTING, String(parsed.data.maxConsecutiveUpstreamFails));
  }
  res.json({
    requestMaxTokensBudget: getRequestMaxTokensBudget(),
    maxConsecutiveUpstreamFails: getMaxConsecutiveUpstreamFails(),
  });
});

// Get the unified API key
settingsRouter.get('/api-key', (_req: Request, res: Response) => {
  res.json({ apiKey: getUnifiedApiKey() });
});

// Regenerate the unified API key
settingsRouter.post('/api-key/regenerate', (_req: Request, res: Response) => {
  const newKey = regenerateUnifiedKey();
  res.json({ apiKey: newKey });
});

// Get the proxy settings
settingsRouter.get('/proxy', (_req: Request, res: Response) => {
  res.json({
    proxyUrl: getProxyUrl(),
    enabled: isProxyEnabled(),
    bypassPlatforms: getProxyBypassPlatforms(),
    active: isProxyActive(),
  });
});

// Set the proxy settings. Accepts partial updates: proxyUrl, enabled, bypassPlatforms.
settingsRouter.put('/proxy', (req: Request, res: Response) => {
  const { proxyUrl, enabled, bypassPlatforms } = req.body as {
    proxyUrl?: string;
    enabled?: boolean;
    bypassPlatforms?: string[];
  };

  // --- proxyUrl ---
  if (typeof proxyUrl === 'string') {
    const trimmed = proxyUrl.trim();
    if (trimmed) {
      try {
        const u = new URL(trimmed);
        if (!PROXY_SCHEMES.includes(u.protocol)) {
          res.status(400).json({
            error: {
              message: 'Proxy URL must use http, https, socks5, socks5h, socks4, or socks4a scheme',
              type: 'invalid_request_error',
            },
          });
          return;
        }
      } catch {
        res.status(400).json({
          error: { message: 'Invalid proxy URL — must be a valid URL like socks5://host:port', type: 'invalid_request_error' },
        });
        return;
      }
      setSetting('proxy_url', trimmed);
    } else {
      setSetting('proxy_url', '');
    }
    applyProxyUrl(trimmed);
  }

  // --- enabled ---
  if (typeof enabled === 'boolean') {
    setSetting('proxy_enabled', enabled ? '1' : '0');
    applyProxyEnabled(enabled);
  }

  // --- bypassPlatforms ---
  if (Array.isArray(bypassPlatforms)) {
    const csv = bypassPlatforms.map(s => s.trim()).filter(Boolean).join(',');
    setSetting('proxy_bypass', csv);
    applyProxyBypass(csv);
  }

  res.json({
    proxyUrl: getProxyUrl(),
    enabled: isProxyEnabled(),
    bypassPlatforms: getProxyBypassPlatforms(),
    active: isProxyActive(),
  });
});

settingsRouter.get('/router', (_req: Request, res: Response) => {
  res.json({
    probeOnCooldown: getProbeOnCooldown(),
    strictChain: getStrictChain(),
    softLimits: getSoftLimitsEnabled(),
  });
});

const routerPutSchema = z.object({
  probeOnCooldown: z.boolean().optional(),
  strictChain: z.boolean().optional(),
  softLimits: z.boolean().optional(),
});

settingsRouter.put('/router', (req: Request, res: Response) => {
  const parsed = routerPutSchema.safeParse(req.body);
  if (!parsed.success) {
    const detail = parsed.error.errors
      .map(e => (e.path.length ? `${e.path.join('.')}: ${e.message}` : e.message))
      .slice(0, 5)
      .join(', ');
    res.status(400).json({ error: { message: `Invalid router settings: ${detail}`, type: 'invalid_request_error' } });
    return;
  }
  if (parsed.data.probeOnCooldown !== undefined) setProbeOnCooldown(parsed.data.probeOnCooldown);
  if (parsed.data.strictChain !== undefined) setStrictChain(parsed.data.strictChain);
  if (parsed.data.softLimits !== undefined) setSoftLimitsEnabled(parsed.data.softLimits);
  res.json({
    probeOnCooldown: getProbeOnCooldown(),
    strictChain: getStrictChain(),
    softLimits: getSoftLimitsEnabled(),
  });
});

settingsRouter.get('/context-handoff', (_req: Request, res: Response) => {
  const db = getSetting('context_handoff_mode');
  if (db === 'on_model_switch' || db === 'off') {
    res.json({ enabled: db === 'on_model_switch' });
    return;
  }
  const env = process.env.FREELLMAPI_CONTEXT_HANDOFF?.trim().toLowerCase();
  res.json({ enabled: env === 'on_model_switch' });
});

const contextHandoffPutSchema = z.object({
  enabled: z.boolean(),
});

settingsRouter.put('/context-handoff', (req: Request, res: Response) => {
  const parsed = contextHandoffPutSchema.safeParse(req.body);
  if (!parsed.success) {
    const detail = parsed.error.errors
      .map(e => (e.path.length ? `${e.path.join('.')}: ${e.message}` : e.message))
      .slice(0, 5)
      .join(', ');
    res.status(400).json({ error: { message: `Invalid context handoff settings: ${detail}`, type: 'invalid_request_error' } });
    return;
  }
  setSetting('context_handoff_mode', parsed.data.enabled ? 'on_model_switch' : 'off');
  res.json({ enabled: parsed.data.enabled });
});

settingsRouter.get('/zen-keyless', (_req: Request, res: Response) => {
  res.json(getZenKeylessState());
});

const zenKeylessPutSchema = z.object({
  enabled: z.boolean(),
});

settingsRouter.put('/zen-keyless', (req: Request, res: Response) => {
  const parsed = zenKeylessPutSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { message: 'Invalid zen keyless settings', type: 'invalid_request_error' } });
    return;
  }
  res.json(setZenKeylessMode(parsed.data.enabled));
});

settingsRouter.get('/analytics-retention', (_req: Request, res: Response) => {
  res.json(getRetentionConfigResponse());
});

function getRetentionConfigResponse(): { retentionDays: number; maxRows: number } {
  const cfg = getRequestAnalyticsRetentionConfig();
  return { retentionDays: cfg.retentionDays, maxRows: cfg.maxRows };
}

const analyticsRetentionPutSchema = z.object({
  retentionDays: z.number().int().nonnegative().optional(),
  maxRows: z.number().int().nonnegative().optional(),
});

settingsRouter.put('/analytics-retention', (req: Request, res: Response) => {
  const parsed = analyticsRetentionPutSchema.safeParse(req.body);
  if (!parsed.success) {
    const detail = parsed.error.errors
      .map(e => (e.path.length ? `${e.path.join('.')}: ${e.message}` : e.message))
      .slice(0, 5)
      .join(', ');
    res.status(400).json({ error: { message: `Invalid analytics retention settings: ${detail}`, type: 'invalid_request_error' } });
    return;
  }
  if (parsed.data.retentionDays !== undefined) setSetting('analytics_retention_days', String(parsed.data.retentionDays));
  if (parsed.data.maxRows !== undefined) setSetting('analytics_max_rows', String(parsed.data.maxRows));
  res.json(getRetentionConfigResponse());
});
