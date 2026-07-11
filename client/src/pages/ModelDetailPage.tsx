import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'
import { ChevronLeft, Save, Trash2 } from 'lucide-react'
import { useI18n } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { ConfirmButton } from '@/components/confirm-button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { CopyButton } from '@/components/copy-button'
import { TableSkeleton } from '@/components/ui/skeleton'
import { Tooltip } from '@/components/tooltip'
import { PageHeader } from '@/components/page-header'
import { ModelsTabs } from '@/components/models-tabs'
import { CooldownList, type CooldownEntry } from '@/components/cooldown-list'
import { formatLatency, formatPercent, formatTokens } from '@/lib/format'
import { type FallbackEntry, type RoutingData, type Row } from './FallbackPage'

type LimitCounter = { used: number; limit: number | null; pct: number | null; remaining: number | null }

function formatTokensLocal(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function cleanQuotaLabel(s: string | undefined): string | null {
  if (!s) return null
  let c = s.replace(/free\s*·\s*/ig, '').replace(/\s*per ip\s*/ig, '').replace(/[~?]/g, '').replace(/\s+/g, ' ').trim()
  c = c.replace(/^\(([^()]*)\)$/, '$1').trim()
  return c || null
}

function groupQuotaBadge(
  members: Row[],
  t: (key: string, vars?: Record<string, string | number>) => string,
): { text: string; title: string } | null {
  const totalBudget = members.reduce((sum, m) => sum + (m.monthlyTokenBudgetTokens ?? 0), 0)
  const maxRpm = Math.max(0, ...members.map(m => m.rpmLimit ?? 0))
  const maxRpd = Math.max(0, ...members.map(m => m.rpdLimit ?? 0))
  const rateLabelText = members.map(m => cleanQuotaLabel(m.monthlyTokenBudget)).find(Boolean) ?? null
  if (totalBudget > 0) return { text: t('models.aggregateBudget', { count: formatTokensLocal(totalBudget) }), title: t('models.aggregateBudgetTitle') }
  if (maxRpm > 0) return { text: t('models.rateRpm', { count: maxRpm }), title: t('models.rateTitle') }
  if (maxRpd > 0) return { text: t('models.rateRpd', { count: maxRpd }), title: t('models.rateTitle') }
  if (rateLabelText) return { text: rateLabelText, title: t('models.rateTitle') }
  return null
}

function reasoningLevel(modelId: string, displayName: string): 'high' | 'medium' | 'low' | 'none' {
  const v = `${modelId} ${displayName}`.toLowerCase()
  const high = ['big-pickle', 'command-a-reasoning', 'deepseek-r1', 'deepseek-v4', 'gpt-oss-120b', 'gpt-oss:120b', 'kimi-k2-thinking', 'magistral-medium', 'minimax-m2', 'nemotron-3-ultra', 'north-mini-code', 'qwen3-coder', 'qwen3-next', 'qwen3-235', 'qwen-3-235', 'qwen-3-coder', 'qwen/qwen3-coder', 'qwen/qwen3-next', 'gemini-2.5-pro', 'gemini-3', 'cogito-2.1', 'glm-5']
  if (high.some(m => v.includes(m)) || /\bo[134]\b/.test(v)) return 'high'
  const low = ['gpt-oss-20b', 'gpt-oss:20b', 'openai-fast', 'r1-distill', 'lfm-2.5-1.2b-thinking', 'nemotron-nano-9b-v2']
  if (low.some(m => v.includes(m))) return 'low'
  const medium = ['reasoning', 'thinking', 'gemini-2.5-flash', 'gemma-4', 'glm-4.5', 'glm-4.6', 'glm-4.7', 'magistral', 'mistral-medium', 'mistral-small', 'nemotron-3-super', 'nemotron-3-120b', 'nemotron-3-nano-30b-a3b', 'qwen3', 'qwen-3', 'kimi-k2']
  if (medium.some(m => v.includes(m))) return 'medium'
  if (['cogito', 'nemotron', 'gpt-oss'].some(m => v.includes(m))) return 'medium'
  return 'none'
}

function penaltyColor(value: number): string {
  if (value === 0) return 'text-emerald-600 dark:text-emerald-400'
  if (value <= 2) return 'text-foreground'
  if (value <= 5) return 'text-amber-600 dark:text-amber-400'
  return 'text-red-600 dark:text-red-400'
}

function quotaBarColor(pct: number | null): string {
  if (pct === null) return 'bg-muted-foreground/20'
  if (pct < 70) return 'bg-emerald-500'
  if (pct < 90) return 'bg-amber-500'
  return 'bg-red-500'
}

function limitBar(counter: LimitCounter, label: string) {
  const pct = counter.pct
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-muted-foreground">{label}</span>
        {counter.limit !== null ? (
          <span className="font-mono tabular-nums">{formatTokensLocal(counter.used)}/{formatTokensLocal(counter.limit)}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
        <div className={`h-full rounded-full transition-[width] ${quotaBarColor(pct)}`} style={{ width: `${Math.min(100, pct ?? 0)}%` }} />
      </div>
      {pct !== null && <p className="text-right font-mono text-[10px] tabular-nums text-muted-foreground">{pct.toFixed(0)}%</p>}
    </div>
  )
}

function AxisBar({ value, color }: { value: number | undefined; color: string }) {
  const v = value ?? 0
  return (
    <div className="flex items-center gap-1.5">
      <div className="h-1.5 w-12 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full" style={{ width: `${Math.round(v * 100)}%`, backgroundColor: color }} />
      </div>
      <span className="w-7 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
        {value === undefined ? '–' : Math.round(v * 100)}
      </span>
    </div>
  )
}

function ModelTableHead() {
  const { t } = useI18n()
  return (
    <thead>
      <tr className="border-b text-left text-muted-foreground">
        <th className="py-2 pl-3 pr-2 text-center font-medium">#</th>
        <th className="py-2 pr-3 font-medium">{t('models.columnModel')}</th>
        <th className="py-2 pr-3 font-medium">{t('strategies.weightReliability')}</th>
        <th className="py-2 pr-3 font-medium">{t('strategies.weightSpeed')}</th>
        <th className="py-2 pr-3 font-medium">{t('strategies.weightIntelligence')}</th>
        <th className="py-2 pr-3 font-medium">
          <Tooltip text={t('strategies.guardrailsTooltip')}>
            <span className="cursor-help underline decoration-dotted underline-offset-2">{t('strategies.guardrails')}</span>
          </Tooltip>
        </th>
        <th className="py-2 pr-3 text-right font-medium">{t('strategies.scoreColumn')}</th>
        <th className="py-2 pr-3 text-right font-medium">{t('models.columnOn')}</th>
      </tr>
    </thead>
  )
}

function RowContent({ row, rank, onToggle }: { row: Row; rank: number; onToggle: (modelDbId: number, enabled: boolean) => void }) {
  const { t } = useI18n()
  const guard = (row.headroom ?? 1) * (row.rateLimit ?? 1)
  return (
    <>
      <td className="py-2 pl-3 pr-2 text-center font-mono text-xs tabular-nums text-muted-foreground">{rank}</td>
      <td className="py-2 pr-3 align-middle">
        <div className="font-medium">{row.displayName}</div>
        <div className="mt-0.5 text-[11px] text-muted-foreground">{row.platform} · {row.modelId}</div>
      </td>
      <td className="py-2 pr-3 align-middle"><AxisBar value={row.reliability} color="#22c55e" /></td>
      <td className="py-2 pr-3 align-middle"><AxisBar value={row.speed} color="#3b82f6" /></td>
      <td className="py-2 pr-3 align-middle"><AxisBar value={row.intelligence} color="#a855f7" /></td>
      <td className="py-2 pr-3 align-middle font-mono text-[11px] tabular-nums text-muted-foreground">{guard < 0.999 ? `x${guard.toFixed(2)}` : '–'}</td>
      <td className="py-2 pr-3 text-right font-mono text-xs font-medium tabular-nums">{row.score !== undefined ? row.score.toFixed(3) : '–'}</td>
      <td className="py-2 pr-3 text-right"><Switch checked={row.enabled} onCheckedChange={(c) => onToggle(row.modelDbId, c)} aria-label={t('models.columnOn')} /></td>
    </>
  )
}

type ModelSettingsPatch = {
  displayName: string
  contextWindow: number | null
  supportsVision: boolean
  supportsTools: boolean
  fallbackEnabled: boolean
}

export default function ModelDetailPage() {
  const { t } = useI18n()
  const params = useParams<{ '*': string }>()
  const rawPath = params['*'] ?? ''
  const canonicalId = rawPath ? decodeURIComponent(rawPath) : ''
  const queryClient = useQueryClient()

  const { data: entries = [], isLoading } = useQuery<FallbackEntry[]>({
    queryKey: ['fallback'],
    queryFn: () => apiFetch('/api/fallback'),
  })
  const { data: routing } = useQuery<RoutingData>({
    queryKey: ['fallback', 'routing'],
    queryFn: () => apiFetch('/api/fallback/routing'),
  })
  const { data: health } = useQuery<{
    platforms: Array<{ platform: string; hasProvider: boolean; totalKeys: number; healthyKeys: number; rateLimitedKeys: number; invalidKeys: number; errorKeys: number; unknownKeys: number; enabledKeys: number }>
  }>({
    queryKey: ['health'],
    queryFn: () => apiFetch('/api/health'),
  })
  const { data: penaltyData } = useQuery<{
    generatedAtMs: number; lookbackMinutes: number;
    rows: Array<{ modelDbId: number | null; platform: string; modelId: string; displayName: string; enabled: boolean; fallbackEnabled: boolean; priority: number | null; penalty: { hits: number; value: number; rateLimitFactor: number }; cooldowns: Array<{ keyId: number; keyLabel: string | null; keyStatus: string | null; expiresAtMs: number; expiresInMs: number }>; recentErrors: Array<{ id: number; keyId: number | null; keyLabel: string | null; error: string; latencyMs: number; createdAt: string }>; recentErrorCount: number; reasons: string[] }>
  }>({
    queryKey: ['penalty-inspector'],
    queryFn: () => apiFetch('/api/fallback/penalty-inspector'),
  })
  const { data: usageLimits } = useQuery<{
    models: Array<{ modelDbId: number; platform: string; modelId: string; displayName: string; keyCount: number; rpm: LimitCounter; rpd: LimitCounter; tpm: LimitCounter; tpd: LimitCounter; monthly: LimitCounter; requests30d: number }>
  }>({
    queryKey: ['usage-limits'],
    queryFn: () => apiFetch('/api/usage-limits'),
  })
  const { data: analytics = [] } = useQuery<Array<{ platform: string; modelId: string; displayName: string; requests: number; successRate: number; avgLatencyMs: number; totalInputTokens: number; totalOutputTokens: number; totalCachedTokens: number; pinnedRequests: number; estimatedCost: number }>>({
    queryKey: ['analytics', 'by-model', '7d'],
    queryFn: () => apiFetch('/api/analytics/by-model?range=7d'),
  })

  const saveMutation = useMutation({
    mutationFn: (data: { modelDbId: number; priority: number; enabled: boolean }[]) =>
      apiFetch('/api/fallback', { method: 'PUT', body: JSON.stringify(data) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['fallback'] }),
  })
  const modelPatchMutation = useMutation({
    mutationFn: ({ modelDbId, patch }: { modelDbId: number; patch: ModelSettingsPatch }) =>
      apiFetch(`/api/models/${modelDbId}`, { method: 'PATCH', body: JSON.stringify(patch) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      queryClient.invalidateQueries({ queryKey: ['fallback', 'routing'] })
      queryClient.invalidateQueries({ queryKey: ['models'] })
    },
  })
  const modelDeleteMutation = useMutation({
    mutationFn: (modelDbId: number) => apiFetch(`/api/models/${modelDbId}`, { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      queryClient.invalidateQueries({ queryKey: ['fallback', 'routing'] })
      queryClient.invalidateQueries({ queryKey: ['models'] })
    },
  })

  const isManual = (routing?.strategy ?? 'balanced') === 'priority'
  const scoreById = new Map((routing?.scores ?? []).map(s => [s.modelDbId, s]))

  const members: Row[] = entries
    .filter(e => e.keyCount > 0 && (e.canonicalId ?? e.modelId) === canonicalId)
    .map(e => ({ ...(scoreById.get(e.modelDbId) ?? {}), ...e }))
    .sort((a, b) => (isManual ? a.priority - b.priority : (b.score ?? 0) - (a.score ?? 0)))

  function handleToggle(modelDbId: number, enabled: boolean) {
    saveMutation.mutate(entries.map(e => ({
      modelDbId: e.modelDbId,
      priority: e.priority,
      enabled: e.modelDbId === modelDbId ? enabled : e.enabled,
    })))
  }

  const label = members[0]?.groupLabel ?? members[0]?.displayName ?? canonicalId
  const quota = members.length ? groupQuotaBadge(members, t) : null
  const vision = members.some(m => m.supportsVision)
  const tools = members.some(m => m.supportsTools)
  const rLevel = members.length > 0 ? reasoningLevel(members[0].modelId, members[0].displayName) : 'none'
  const sizeTier = members[0]?.sizeLabel ?? ''

  const memberPlatforms = new Set(members.map(m => m.platform))
  const memberModelIds = new Set(members.map(m => m.modelId))
  const memberDbIds = new Set(members.map(m => m.modelDbId))
  const platformHealth = health?.platforms.filter(p => memberPlatforms.has(p.platform)) ?? []
  const penaltyRows = penaltyData?.rows.filter(r => memberDbIds.has(r.modelDbId ?? -1) || (memberPlatforms.has(r.platform) && memberModelIds.has(r.modelId))) ?? []
  const limitModels = usageLimits?.models.filter(m => memberDbIds.has(m.modelDbId)) ?? []
  const analyticsRows = analytics.filter(a => memberPlatforms.has(a.platform) && memberModelIds.has(a.modelId))
  const totalRequests = analyticsRows.reduce((sum, a) => sum + a.requests, 0)
  const totalInputTokens = analyticsRows.reduce((sum, a) => sum + a.totalInputTokens, 0)
  const totalOutputTokens = analyticsRows.reduce((sum, a) => sum + a.totalOutputTokens, 0)
  const totalCachedTokens = analyticsRows.reduce((sum, a) => sum + a.totalCachedTokens, 0)
  const totalTokens = totalInputTokens + totalOutputTokens
  const avgLatency = totalRequests > 0 ? analyticsRows.reduce((sum, a) => sum + a.avgLatencyMs * a.requests, 0) / totalRequests : 0
  const successRate = totalRequests > 0 ? analyticsRows.reduce((sum, a) => sum + a.successRate * a.requests, 0) / totalRequests : 0
  const totalCost = analyticsRows.reduce((sum, a) => sum + a.estimatedCost, 0)
  const cacheRatio = totalInputTokens > 0 ? totalCachedTokens / totalInputTokens : 0

  const { data: keyData } = useQuery<{ apiKey: string }>({
    queryKey: ['unified-key'],
    queryFn: () => apiFetch('/api/settings/api-key'),
  })

  const baseUrl = import.meta.env.DEV
    ? `http://${window.location.hostname}:${__SERVER_PORT__}/v1`
    : `${window.location.origin}/v1`

  const apiKey = keyData?.apiKey ?? ''
  const snippetDisplay = `curl ${baseUrl}/chat/completions \\
  -H "Authorization: Bearer $FREELLMAPI_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${canonicalId}",
    "messages": [
      { "role": "user", "content": "Hello!" }
    ]
  }'`

  const snippetCopy = `curl ${baseUrl}/chat/completions \\
  -H "Authorization: Bearer ${apiKey || 'YOUR_API_KEY'}" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${canonicalId}",
    "messages": [
      { "role": "user", "content": "Hello!" }
    ]
  }'`

  return (
    <div>
      <PageHeader title={label} description={t('models.providersHeading')} divider={false} actions={<ModelsTabs />} />

      <div className="space-y-6">
        <Link to="/models/chat" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ChevronLeft className="size-4" />{t('models.backToModels')}
        </Link>

        {isLoading ? (
          <TableSkeleton rows={3} />
        ) : members.length === 0 ? (
          <div className="rounded-3xl border border-dashed p-8 text-center">
            <p className="text-sm text-muted-foreground">{t('models.modelNotFound')}</p>
          </div>
        ) : (
          <>
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="inline-flex h-6 items-center gap-1.5 rounded-full bg-muted/70 px-2.5 text-xs tabular-nums text-foreground/85">
                <span className="size-1.5 rounded-full bg-foreground/40" />
                {t('models.providerCount', { count: members.length })}
              </span>
              {quota && (
                <span title={quota.title} className="inline-flex h-6 items-center rounded-full bg-muted/70 px-2.5 text-xs tabular-nums text-foreground/85">
                  {quota.text}
                </span>
              )}
              {sizeTier && (
                <span className="inline-flex h-6 items-center rounded-full bg-muted/70 px-2.5 text-xs text-foreground/85">
                  {sizeTier}
                </span>
              )}
              {vision && (
                <span title={t('models.visionTitle')} className="inline-flex h-6 items-center rounded-full bg-cyan-600/15 px-2.5 text-xs text-cyan-700 dark:bg-cyan-400/15 dark:text-cyan-400">
                  {t('models.vision')}
                </span>
              )}
              {tools && (
                <span title={t('models.toolsTitle')} className="inline-flex h-6 items-center rounded-full bg-violet-600/15 px-2.5 text-xs text-violet-700 dark:bg-violet-400/15 dark:text-violet-400">
                  {t('models.tools')}
                </span>
              )}
              {rLevel !== 'none' && (
                <span title={t('models.reasoningTitle')} className="inline-flex h-6 items-center rounded-full bg-amber-600/15 px-2.5 text-xs text-amber-700 dark:bg-amber-400/15 dark:text-amber-400">
                  R·{rLevel}
                </span>
              )}
            </div>

            {totalRequests > 0 && (
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6">
                <StatCard label={t('models.analyticsRequests')} value={formatTokensLocal(totalRequests)} />
                <StatCard label={t('models.columnSuccess')} value={formatPercent(successRate)} />
                <StatCard label={t('models.columnLatency')} value={formatLatency(avgLatency)} />
                <StatCard label={t('models.analyticsTokens')} value={formatTokens(totalTokens)} />
                <StatCard label={t('models.analyticsCost')} value={`$${totalCost.toFixed(2)}`} />
                {cacheRatio > 0 && <StatCard label={t('models.analyticsCache')} value={formatPercent(cacheRatio * 100)} />}
              </div>
            )}

            {penaltyRows.length > 0 && (
              <div className="rounded-3xl border bg-card p-5">
                <h2 className="text-sm font-medium">{t('models.penaltyHeading')}</h2>
                <p className="mt-1 mb-4 text-xs text-muted-foreground">{t('models.penaltyHint')}</p>
                <div className="space-y-2">
                  {penaltyRows.map((row, i) => {
                    const cds: CooldownEntry[] = row.cooldowns.map(c => ({ modelId: '', expiresAtMs: c.expiresAtMs, remainingSeconds: Math.round(c.expiresInMs / 1000), reason: null }))
                    return (
                      <div key={row.modelDbId ?? i} className="rounded-2xl border bg-background/60 px-4 py-2.5">
                        <div className="flex items-center justify-between text-xs">
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{row.displayName}</span>
                            <span className="text-muted-foreground">{row.platform}</span>
                          </div>
                          <span className={`font-mono tabular-nums ${penaltyColor(row.penalty.value)}`}>
                            {row.penalty.value > 0 ? t('models.penalty', { value: row.penalty.value }) : 'OK'}
                          </span>
                        </div>
                        {cds.length > 0 && <CooldownList cooldowns={cds} compact className="mt-1.5" />}
                        {row.recentErrors.length > 0 && (
                          <div className="mt-2 space-y-1">
                            {row.recentErrors.slice(0, 3).map(e => (
                              <div key={e.id} className="truncate text-[11px] text-red-600 dark:text-red-400" title={e.error}>
                                {e.error.length > 80 ? `${e.error.slice(0, 80)}…` : e.error}
                              </div>
                            ))}
                            {row.recentErrorCount > 3 && (
                              <p className="text-[11px] text-muted-foreground">+{row.recentErrorCount - 3} {t('models.moreErrors')}</p>
                            )}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {limitModels.length > 0 && (
              <div className="rounded-3xl border bg-card p-5">
                <h2 className="text-sm font-medium">{t('models.limitsHeading')}</h2>
                <p className="mt-1 mb-4 text-xs text-muted-foreground">{t('models.limitsHint')}</p>
                <div className="space-y-4">
                  {limitModels.map(model => (
                    <div key={model.modelDbId} className="rounded-2xl border bg-background/60 p-4">
                      <div className="mb-3 flex items-center gap-2 text-xs">
                        <span className="font-medium">{model.displayName}</span>
                        <span className="text-muted-foreground">{model.platform}</span>
                      </div>
                      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                        {limitBar(model.rpm, 'RPM')}
                        {limitBar(model.rpd, 'RPD')}
                        {limitBar(model.tpm, 'TPM')}
                        {limitBar(model.tpd, 'TPD')}
                        {limitBar(model.monthly, t('models.monthlyTokenBudget'))}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="rounded-3xl border bg-card overflow-x-auto">
              <table className="w-full text-sm">
                <ModelTableHead />
                <tbody>
                  {members.map((m, i) => (
                    <tr key={m.modelDbId} className={`border-b last:border-0 ${m.enabled ? '' : 'opacity-50'}`}>
                      <RowContent row={m} rank={i + 1} onToggle={handleToggle} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="rounded-3xl border bg-card p-5">
              <div className="mb-4">
                <h2 className="text-sm font-medium">{t('models.settingsHeading')}</h2>
                <p className="mt-1 text-xs text-muted-foreground">{t('models.settingsHint')}</p>
              </div>
              <div className="space-y-3">
                {members.map(m => (
                  <ProviderSettingsRow
                    key={m.modelDbId}
                    model={m}
                    saving={modelPatchMutation.isPending && modelPatchMutation.variables?.modelDbId === m.modelDbId}
                    deleting={modelDeleteMutation.isPending && modelDeleteMutation.variables === m.modelDbId}
                    onSave={(patch) => modelPatchMutation.mutate({ modelDbId: m.modelDbId, patch })}
                    onDelete={() => modelDeleteMutation.mutate(m.modelDbId)}
                  />
                ))}
              </div>
            </div>

            <div className="grid gap-6 lg:grid-cols-2">
              {platformHealth.length > 0 && (
                <div className="rounded-3xl border bg-card p-5">
                  <h2 className="text-sm font-medium">{t('models.healthHeading')}</h2>
                  <p className="mt-1 mb-4 text-xs text-muted-foreground">{t('models.healthHint')}</p>
                  <div className="space-y-3">
                    {platformHealth.map(p => {
                      const total = p.totalKeys
                      const healthyPct = total > 0 ? (p.healthyKeys / total) * 100 : 0
                      const issueCount = p.rateLimitedKeys + p.invalidKeys + p.errorKeys
                      const allOk = issueCount === 0
                      return (
                        <div key={p.platform} className="rounded-2xl border bg-background/60 px-4 py-3">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <span className={`size-2 rounded-full ${allOk ? 'bg-emerald-500' : 'bg-amber-500'}`} />
                              <span className="text-xs font-medium">{p.platform}</span>
                            </div>
                            <span className={`text-[11px] font-medium ${allOk ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}>
                              {allOk ? t('models.healthOk') : t('models.healthIssueCount', { count: issueCount })}
                            </span>
                          </div>
                          <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-muted">
                            <div
                              className={`h-full rounded-full transition-[width] ${allOk ? 'bg-emerald-500' : 'bg-amber-500'}`}
                              style={{ width: `${healthyPct}%` }}
                            />
                          </div>
                          <div className="mt-2 flex items-center gap-3 text-[11px] text-muted-foreground">
                            <span>{p.healthyKeys}/{total}</span>
                            {p.rateLimitedKeys > 0 && <span className="text-amber-600 dark:text-amber-400">{p.rateLimitedKeys} {t('models.healthRateLimited')}</span>}
                            {p.invalidKeys > 0 && <span className="text-red-600 dark:text-red-400">{p.invalidKeys} {t('models.healthInvalid')}</span>}
                            {p.errorKeys > 0 && <span className="text-red-600 dark:text-red-400">{p.errorKeys} {t('models.healthError')}</span>}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              <div className="overflow-hidden rounded-3xl border bg-card">
                <div className="flex items-center gap-2 border-b px-4 py-2.5">
                  <CopyButton text={snippetCopy} className="size-7 shrink-0" label={t('common.copy')} />
                  <span className="text-xs font-medium">{t('models.codeSnippetHeading')}</span>
                </div>
                <pre className="overflow-x-auto px-4 py-3 text-[11px] leading-relaxed"><code className="font-mono">{snippetDisplay}</code></pre>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border bg-background/60 px-3 py-2.5">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <div className="mt-1 truncate text-sm font-medium tabular-nums">{value}</div>
    </div>
  )
}

function ProviderSettingsRow({
  model,
  saving,
  deleting,
  onSave,
  onDelete,
}: {
  model: Row
  saving: boolean
  deleting: boolean
  onSave: (patch: ModelSettingsPatch) => void
  onDelete: () => void
}) {
  const { t } = useI18n()
  const [displayName, setDisplayName] = useState(model.displayName)
  const [contextWindow, setContextWindow] = useState(model.contextWindow ? String(model.contextWindow) : '')
  const [supportsVision, setSupportsVision] = useState(model.supportsVision)
  const [supportsTools, setSupportsTools] = useState(model.supportsTools)
  const [fallbackEnabled, setFallbackEnabled] = useState(model.enabled)

  useEffect(() => {
    setDisplayName(model.displayName)
    setContextWindow(model.contextWindow ? String(model.contextWindow) : '')
    setSupportsVision(model.supportsVision)
    setSupportsTools(model.supportsTools)
    setFallbackEnabled(model.enabled)
  }, [model.modelDbId, model.displayName, model.contextWindow, model.supportsVision, model.supportsTools, model.enabled])

  const parsedContext = contextWindow.trim() === '' ? null : Number(contextWindow)
  const contextInvalid = parsedContext !== null && (!Number.isInteger(parsedContext) || parsedContext <= 0)
  const nameInvalid = displayName.trim().length === 0
  const dirty =
    displayName.trim() !== model.displayName ||
    parsedContext !== (model.contextWindow ?? null) ||
    supportsVision !== model.supportsVision ||
    supportsTools !== model.supportsTools ||
    fallbackEnabled !== model.enabled
  const canSave = dirty && !nameInvalid && !contextInvalid && !saving && !deleting
  const sourceLabel = model.source === 'custom' ? t('models.customModel') : t('models.catalogModel')

  function save() {
    if (!canSave) return
    onSave({
      displayName: displayName.trim(),
      contextWindow: parsedContext,
      supportsVision,
      supportsTools,
      fallbackEnabled,
    })
  }

  return (
    <div className="rounded-2xl border bg-background/60 p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium">{model.platform}</span>
        <code className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">{model.modelId}</code>
        <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{sourceLabel}</span>
        {model.hasOverrides && (
          <span className="rounded-full bg-emerald-600/15 px-1.5 py-0.5 text-[10px] text-emerald-700 dark:text-emerald-400">
            {t('models.localOverride')}
          </span>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-[minmax(14rem,1fr)_6rem] sm:items-end">
        <label className="space-y-1 text-xs text-muted-foreground">
          <span>{t('models.displayName')}</span>
          <Input value={displayName} onChange={e => setDisplayName(e.target.value)} aria-invalid={nameInvalid} className="text-sm" />
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          <span>{t('models.contextWindow')}</span>
          <Input type="number" min={1} step={1} value={contextWindow} onChange={e => setContextWindow(e.target.value)} aria-invalid={contextInvalid} className="text-sm tabular-nums" />
        </label>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-4">
          <label className="flex h-8 items-center gap-2 text-xs">
            <Switch size="sm" checked={supportsTools} onCheckedChange={setSupportsTools} />
            <span>{t('models.tools')}</span>
          </label>
          <label className="flex h-8 items-center gap-2 text-xs">
            <Switch size="sm" checked={supportsVision} onCheckedChange={setSupportsVision} />
            <span>{t('models.vision')}</span>
          </label>
          <label className="flex h-8 items-center gap-2 text-xs">
            <Switch size="sm" checked={fallbackEnabled} onCheckedChange={setFallbackEnabled} />
            <span>{t('models.inFallback')}</span>
          </label>
        </div>
        <div className="flex items-center gap-1">
          <Tooltip text={t('models.saveModelSettings')}>
            <Button type="button" size="icon-sm" variant="ghost" disabled={!canSave} onClick={save}>
              <Save className="size-3.5" />
            </Button>
          </Tooltip>
          <ConfirmButton
            variant="destructive"
            size="icon-sm"
            armedSize="xs"
            armedClassName=""
            disabled={saving || deleting}
            onConfirm={onDelete}
            aria-label={t('common.delete')}
          >
            <Trash2 className="size-3.5" />
          </ConfirmButton>
        </div>
      </div>
    </div>
  )
}
