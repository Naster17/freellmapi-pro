import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Activity, AlertTriangle, ChevronDown, ChevronsUpDown, Radio, RefreshCw, ShieldAlert, Timer, Zap } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from '@/components/page-header'
import { CooldownList, type CooldownEntry } from '@/components/cooldown-list'
import { formatCount, formatTokens } from '@/lib/format'
import { formatSqliteUtcToLocalTime } from '@/lib/utils'
import { useI18n } from '@/i18n'
import type { ProviderQuotaObservation, QuotaMetric, QuotaObservationSource } from '../../../shared/types'

type LimitCounter = { used: number; limit: number | null; pct: number | null; remaining: number | null }
type ProviderReportedQuota = {
  quotaPoolKey: string
  metric: QuotaMetric
  limit: number | null
  remaining: number | null
  resetAt: string | null
  source: QuotaObservationSource
  confidence: number
  observedAt: string
  notes: string | null
}
type KeyUsage = {
  keyId: number
  label: string
  status: string
  lastUsedAt: string | null
  requests: number
  onCooldown: boolean
  rpm: LimitCounter
  rpd: LimitCounter
  tpm: LimitCounter
  tpd: LimitCounter
  providerRpd: LimitCounter
  providerReported: ProviderReportedQuota[]
  cooldowns: CooldownEntry[]
}
type ModelUsage = {
  modelDbId: number
  platform: string
  modelId: string
  displayName: string
  keyCount: number
  monthlyTokenBudget: string
  rpm: LimitCounter
  rpd: LimitCounter
  tpm: LimitCounter
  tpd: LimitCounter
  monthly: LimitCounter
  requests30d: number
  keys: KeyUsage[]
}
type ProviderUsage = {
  platform: string
  keyCount: number
  modelCount: number
  requests24h: number
  tokens24h: number
  requests30d: number
  monthly: LimitCounter
  providerRpd: LimitCounter
}
type UsageLimitsResponse = {
  generatedAt: string
  summary: {
    providerCount: number
    modelCount: number
    keyCount: number
    requests24h: number
    tokens24h: number
    requests30d: number
    tokens30d: number
    constrainedCount: number
    quotaSignalCount: number
    quotaReportingProviders: number
  }
  providers: ProviderUsage[]
  models: ModelUsage[]
  constrainedModels: ModelUsage[]
  quotaSignals: ProviderQuotaObservation[]
}

type InspectorReason = 'penalty' | 'cooldown' | 'recent_errors'

type PenaltyInspectorRow = {
  modelDbId: number | null
  platform: string
  modelId: string
  displayName: string
  enabled: boolean
  fallbackEnabled: boolean
  priority: number | null
  penalty: {
    hits: number
    value: number
    rateLimitFactor: number
  }
  cooldowns: Array<{
    keyId: number
    keyLabel: string | null
    keyStatus: string | null
    expiresAtMs: number
    expiresInMs: number
  }>
  recentErrors: Array<{
    id: number
    keyId: number | null
    keyLabel: string | null
    error: string
    latencyMs: number
    createdAt: string
  }>
  recentErrorCount: number
  reasons: InspectorReason[]
}

type PenaltyInspectorData = {
  generatedAtMs: number
  lookbackMinutes: number
  rows: PenaltyInspectorRow[]
}

const metricClass = 'rounded-3xl border bg-card px-4 py-3'
const COLLAPSED_PROVIDERS_KEY = 'freellmapi.usageLimits.collapsedProviders'
const USAGE_LIMITS_REFETCH_INTERVAL_MS = 5_000

function readCollapsedProviders(): Record<string, boolean> {
  if (typeof window === 'undefined') return {}
  try {
    const raw = window.localStorage.getItem(COLLAPSED_PROVIDERS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function formatLimit(counter: LimitCounter, unit: string, tokenLike = false): string {
  const used = tokenLike ? formatTokens(counter.used) : formatCount(counter.used)
  if (counter.limit === null) return `${used} ${unit}`
  const limit = tokenLike ? formatTokens(counter.limit) : formatCount(counter.limit)
  return `${used} / ${limit} ${unit}`
}

function hasKnownLimit(counter: LimitCounter): boolean {
  return counter.limit !== null
}

function counterTone(counter: LimitCounter): string {
  const pct = counter.pct ?? 0
  if (pct >= 90) return 'bg-destructive'
  if (pct >= 70) return 'bg-amber-500'
  return 'bg-foreground'
}

function ProgressLine({ label, counter, unit, tokenLike = false }: { label: string; counter: LimitCounter; unit: string; tokenLike?: boolean }) {
  const pct = counter.pct ?? 0
  return (
    <div className="space-y-1.5">
      <div className="flex items-start justify-between gap-2 text-[11px]">
        <span className="font-medium text-muted-foreground uppercase tracking-wider">{label}</span>
        <span className="min-w-0 text-right tabular-nums text-muted-foreground break-words">{formatLimit(counter, unit, tokenLike)}</span>
      </div>
      <div className="h-2 rounded-full bg-muted overflow-hidden">
        <div className={`h-full rounded-full ${counterTone(counter)}`} style={{ width: `${counter.limit === null ? 0 : Math.min(100, pct)}%` }} />
      </div>
    </div>
  )
}

function Stat({ label, value, icon: Icon }: { label: string; value: string | number; icon: typeof Activity }) {
  return (
    <div className={metricClass}>
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] text-muted-foreground uppercase tracking-wider">{label}</p>
        <Icon className="size-3.5 text-muted-foreground" />
      </div>
      <p className="text-xl font-semibold tabular-nums mt-1">{value}</p>
    </div>
  )
}

function Panel({ title, children, subtitle }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 rounded-3xl border bg-card">
      <div className="px-4 py-3 border-b flex items-center justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-sm font-medium">{title}</h3>
          {subtitle && <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>}
        </div>
      </div>
      <div className="p-3 sm:p-4">{children}</div>
    </div>
  )
}

function formatQuotaNumber(value: number | null): string {
  return value == null ? '—' : formatCount(value)
}

const SIGNAL_ORDER: QuotaMetric[] = ['requests', 'tokens', 'credits', 'neurons']

function dedupSignals(signals: ProviderReportedQuota[]): ProviderReportedQuota[] {
  const byMetric = new Map<QuotaMetric, ProviderReportedQuota>()
  for (const signal of signals) {
    const existing = byMetric.get(signal.metric)
    if (!existing || signal.confidence > existing.confidence) {
      byMetric.set(signal.metric, signal)
    }
  }
  return SIGNAL_ORDER.filter(m => byMetric.has(m)).map(m => byMetric.get(m)!)
}

function formatResetAt(value: string | null): string {
  if (!value) return '—'
  const date = new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`)
  if (isNaN(date.getTime())) return '—'
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

const SOURCE_LABELS: Record<QuotaObservationSource, string> = {
  header: 'header',
  quota_api: 'quota api',
  error_body: 'error',
  local_usage: 'local',
  documentation: 'docs',
  probe: 'probe',
}

function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.ceil(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  return `${Math.ceil(minutes / 60)}h`
}

function penaltyColor(value: number): string {
  if (value >= 8) return 'bg-red-600/15 text-red-700 dark:text-red-400'
  if (value >= 5) return 'bg-orange-600/15 text-orange-700 dark:text-orange-400'
  if (value >= 3) return 'bg-amber-600/15 text-amber-700 dark:text-amber-400'
  if (value > 0) return 'bg-emerald-600/15 text-emerald-700 dark:text-emerald-400'
  return 'bg-muted text-muted-foreground'
}

function RouterPressurePanel() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const { data, dataUpdatedAt, isFetching } = useQuery<PenaltyInspectorData>({
    queryKey: ['fallback', 'penalty-inspector'],
    queryFn: () => apiFetch('/api/fallback/penalty-inspector'),
    refetchInterval: 5_000,
  })

  const rows = data?.rows ?? []
  if (rows.length === 0) return null

  return (
    <div className="min-w-0 rounded-3xl border bg-card">
      <button
        type="button"
        onClick={() => setOpen(c => !c)}
        className="w-full px-4 py-3 flex items-center justify-between gap-3 text-left hover:bg-muted/30 transition-colors"
        aria-expanded={open}
      >
        <div className="flex items-center gap-2.5 min-w-0">
          <AlertTriangle className="size-4 text-amber-600 dark:text-amber-400 shrink-0" />
          <div className="min-w-0">
            <h3 className="text-sm font-medium">{t('usageLimits.routerPressure')}</h3>
            <p className="text-xs text-muted-foreground mt-0.5 tabular-nums">
              {dataUpdatedAt > 0
                ? t('usageLimits.routerPressureUpdated', { time: formatSqliteUtcToLocalTime(new Date(dataUpdatedAt).toISOString(), { hour: '2-digit', minute: '2-digit', second: '2-digit' }) })
                : t('penaltyInspector.rowCount', { count: rows.length })}
              {isFetching && <span className="text-muted-foreground/60"> · {t('usageLimits.routerPressureLive')}</span>}
            </p>
          </div>
        </div>
        <ChevronDown className={`size-4 text-muted-foreground transition-transform ${open ? '' : '-rotate-90'}`} />
      </button>
      {open && (
        <div className="divide-y border-t">
          {rows.map(row => (
            <button
              key={`${row.platform}:${row.modelId}:${row.modelDbId ?? 'x'}`}
              type="button"
              onClick={() => navigate(`/models/chat/${row.modelId}`)}
              className="w-full px-4 py-2.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs text-left transition-colors hover:bg-muted/30 focus-visible:bg-muted/30 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground/20"
            >
              <div className="min-w-0 flex-1 flex items-center gap-1.5">
                <span className="truncate font-medium">{row.displayName}</span>
                <span className="text-muted-foreground">{row.platform}</span>
                {!row.fallbackEnabled && (
                  <span className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">{t('penaltyInspector.offChain')}</span>
                )}
              </div>
              <div className="flex items-center gap-1.5 shrink-0">
                <span className={`rounded-full px-2 py-0.5 tabular-nums ${penaltyColor(row.penalty.value)}`}>
                  {row.penalty.value}
                </span>
                {row.cooldowns.length > 0 && (
                  <span className="rounded-full bg-sky-600/15 px-2 py-0.5 text-sky-700 dark:text-sky-400">
                    {row.cooldowns.map(c => formatDuration(c.expiresInMs)).join(', ')}
                  </span>
                )}
                {row.recentErrorCount > 0 && (
                  <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground tabular-nums">
                    {row.recentErrorCount} err
                  </span>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

function ProviderQuotaRow({ signal }: { signal: ProviderQuotaObservation }) {
  const hasData = signal.limit !== null || signal.remaining !== null
  return (
    <div className="flex items-center gap-2 px-3 py-1.5 text-xs">
      <span className="text-muted-foreground">key #{signal.keyId}</span>
      <Badge variant="outline" className="font-mono text-[9px] px-1">{signal.metric}</Badge>
      {hasData ? (
        <span className="tabular-nums text-foreground/80">
          {formatQuotaNumber(signal.remaining)}<span className="text-muted-foreground"> / </span>{formatQuotaNumber(signal.limit)}
        </span>
      ) : (
        <span className="text-muted-foreground/50">—</span>
      )}
      <span className="ml-auto flex items-center gap-1.5">
        {signal.resetAt && <span className="text-muted-foreground/60 tabular-nums">{formatResetAt(signal.resetAt)}</span>}
        <span className="text-muted-foreground/50 tabular-nums">{formatSqliteUtcToLocalTime(signal.observedAt, { hour: '2-digit', minute: '2-digit' })}</span>
      </span>
    </div>
  )
}

function ProviderQuotaPanel({ signals }: { signals: ProviderQuotaObservation[] }) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [panelOpen, setPanelOpen] = useState(false)
  const [expandedProviders, setExpandedProviders] = useState<Record<string, boolean>>({})

  const clearSignals = useMutation({
    mutationFn: () => apiFetch<{ clearedState: number; clearedObservations: number }>('/api/usage-limits/quota-signals', { method: 'DELETE' }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['usage-limits'] })
    },
  })

  const meaningful = signals.filter(signal => signal.limit !== null || signal.remaining !== null)

  if (meaningful.length === 0) {
    return (
      <Panel title={t('usageLimits.providerQuotaSignals')} subtitle={t('usageLimits.providerQuotaSignalsEmpty')}>
        <p className="text-xs text-muted-foreground">
          {t('usageLimits.providerQuotaSignalsEmptyDescription')}
        </p>
      </Panel>
    )
  }

  const byProvider = new Map<string, ProviderQuotaObservation[]>()
  for (const signal of meaningful) {
    const list = byProvider.get(signal.platform) ?? []
    list.push(signal)
    byProvider.set(signal.platform, list)
  }

  const sortedProviders = [...byProvider.entries()].sort((a, b) => b[1].length - a[1].length)

  return (
    <div className="min-w-0 rounded-3xl border bg-card">
      <button
        type="button"
        onClick={() => setPanelOpen(current => !current)}
        className="w-full px-4 py-3 flex items-center justify-between gap-3 text-left hover:bg-muted/30 transition-colors"
        aria-expanded={panelOpen}
      >
        <div className="min-w-0">
          <h3 className="text-sm font-medium">{t('usageLimits.providerQuotaSignals')}</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t('usageLimits.signalsCount', { signals: meaningful.length, providers: sortedProviders.length })}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); clearSignals.mutate() }}
            disabled={clearSignals.isPending}
            className="inline-flex items-center gap-1.5 rounded-lg border bg-card px-2.5 py-1 text-[11px] text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive hover:border-destructive/30 disabled:opacity-50"
          >
            {t('usageLimits.clearSignals')}
          </button>
          <ChevronDown className={`size-4 text-muted-foreground transition-transform ${panelOpen ? '' : '-rotate-90'}`} />
        </div>
      </button>
      {panelOpen && (
        <div className="p-3 sm:p-4 border-t space-y-2">
          {sortedProviders.map(([platform, list]) => {
            const expanded = expandedProviders[platform] === true
            const visible = expanded ? list : list.slice(0, 2)
            const hidden = list.length - visible.length
            return (
              <div key={platform} className="rounded-2xl border bg-background/40 overflow-hidden">
                <button
                  type="button"
                  onClick={() => setExpandedProviders(current => ({ ...current, [platform]: !current[platform] }))}
                  className="w-full px-3 py-2 flex items-center justify-between gap-2 text-left hover:bg-muted/20 transition-colors"
                  aria-expanded={expanded}
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-medium text-xs capitalize">{platform}</span>
                    <Badge variant="outline" className="font-mono text-[9px]">{list.length}</Badge>
                  </div>
                  {hidden > 0 && (
                    <ChevronDown className={`size-3 text-muted-foreground transition-transform ${expanded ? '' : '-rotate-90'}`} />
                  )}
                </button>
                {visible.length > 0 && (
                  <div className="divide-y border-t">
                    {visible.map(signal => (
                      <ProviderQuotaRow key={`${signal.platform}:${signal.keyId}:${signal.quotaPoolKey}:${signal.metric}`} signal={signal} />
                    ))}
                  </div>
                )}
                {!expanded && hidden > 0 && (
                  <div className="px-3 py-1 text-[10px] text-muted-foreground border-t">
                    {t('usageLimits.quotaShowAll', { count: hidden })}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function ProviderModelsPanel({
  id,
  title,
  subtitle,
  collapsed,
  onToggle,
  children,
}: {
  id: string
  title: string
  subtitle: string
  collapsed: boolean
  onToggle: () => void
  children: React.ReactNode
}) {
  return (
    <div id={id} className="min-w-0 scroll-mt-6 rounded-3xl border bg-card overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="w-full px-4 py-3 flex items-center justify-between gap-3 text-left hover:bg-muted/30 transition-colors"
        aria-expanded={!collapsed}
      >
        <div className="min-w-0">
          <h3 className="text-sm font-medium">{title}</h3>
          <p className="text-xs text-muted-foreground mt-0.5 truncate">{subtitle}</p>
        </div>
        <ChevronDown className={`size-4 text-muted-foreground transition-transform ${collapsed ? '-rotate-90' : ''}`} />
      </button>
      {!collapsed && <div className="p-3 border-t sm:p-4">{children}</div>}
    </div>
  )
}

function limitScore(model: ModelUsage): number {
  return Math.max(...[model.rpm, model.rpd, model.tpm, model.tpd, model.monthly].map(counter => counter.pct ?? 0))
}

function hottestMetric(model: ModelUsage, noCapLabel: string): { label: string; pct: number | null } {
  const counters: [string, number | null][] = [
    ['RPM', model.rpm.pct],
    ['RPD', model.rpd.pct],
    ['TPM', model.tpm.pct],
    ['TPD', model.tpd.pct],
    ['30d tokens', model.monthly.pct],
  ]
  const known = counters.filter(([, pct]) => pct !== null)
  if (known.length === 0) return { label: noCapLabel, pct: null }
  const [label, pct] = known.sort((a, b) => (b[1] ?? -1) - (a[1] ?? -1))[0]
  return { label, pct }
}

function hottestMetricBadge(model: ModelUsage, uncappedLabel: string, noCapLabel: string): string {
  const hottest = hottestMetric(model, noCapLabel)
  if (hottest.pct === null) return uncappedLabel
  return `${hottest.pct}% ${hottest.label}`
}

function keyLimitLine(key: KeyUsage): string | null {
  const parts = [
    key.rpm.used > 0 && hasKnownLimit(key.rpm) ? formatLimit(key.rpm, 'rpm') : null,
    key.rpd.used > 0 && hasKnownLimit(key.rpd) ? formatLimit(key.rpd, 'rpd') : null,
    key.tpm.used > 0 && hasKnownLimit(key.tpm) ? formatLimit(key.tpm, 'tpm', true) : null,
    key.tpd.used > 0 && hasKnownLimit(key.tpd) ? formatLimit(key.tpd, 'tpd', true) : null,
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(' · ') : null
}

function ModelCard({ model }: { model: ModelUsage }) {
  const { t } = useI18n()
  const [showAllKeys, setShowAllKeys] = useState(false)
  const [expandedKey, setExpandedKey] = useState<number | null>(null)
  const visibleKeys = showAllKeys ? model.keys : model.keys.slice(0, 2)
  const hiddenKeyCount = Math.max(0, model.keys.length - visibleKeys.length)
  const hottest = hottestMetric(model, t('usageLimits.noCatalogQuota'))
  const limitLine = [
    hasKnownLimit(model.monthly) ? `${formatTokens(model.monthly.limit)} (${model.keyCount} ${model.keyCount === 1 ? t('usageLimits.keyLabel') : t('usageLimits.keysLabel')}) tok/mo` : null,
    hasKnownLimit(model.rpm) ? `${formatCount(model.rpm.limit)} rpm` : null,
    hasKnownLimit(model.rpd) ? `${formatCount(model.rpd.limit)} rpd` : null,
    hasKnownLimit(model.tpm) ? `${formatTokens(model.tpm.limit)} tpm` : null,
    hasKnownLimit(model.tpd) ? `${formatTokens(model.tpd.limit)} tpd` : null,
  ].filter(Boolean).join(' · ')

  return (
    <div className="min-w-0 rounded-2xl border bg-background/40 p-3 space-y-3 sm:p-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h4 className="min-w-0 max-w-full truncate text-sm font-medium">{model.displayName}</h4>
            <Badge variant="outline" className="font-mono text-[10px]">{model.platform}</Badge>
            {limitScore(model) >= 90 && <Badge variant="destructive">{t('usageLimits.hotLabel')}</Badge>}
          </div>
          <p className="text-[11px] text-muted-foreground mt-1 tabular-nums break-words">{limitLine || t('usageLimits.noCatalogQuota')}</p>
        </div>
        <div className="shrink-0 sm:text-right">
          <p className="text-base font-semibold tabular-nums sm:text-lg">{hottest.pct === null ? t('usageLimits.uncapped') : `${hottest.pct}%`}</p>
          <p className="text-[11px] text-muted-foreground">{hottest.label}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <ProgressLine label="RPM" counter={model.rpm} unit="rpm" />
        <ProgressLine label="RPD" counter={model.rpd} unit="rpd" />
        <ProgressLine label="TPM" counter={model.tpm} unit="tpm" tokenLike />
        <ProgressLine label="TPD" counter={model.tpd} unit="tpd" tokenLike />
      </div>
      <ProgressLine label={t('usageLimits.tokens30d')} counter={model.monthly} unit="tok" tokenLike />

      <div className="grid gap-1.5 pt-1">
        {visibleKeys.map(key => {
          const limitLine = keyLimitLine(key)
          const isExpanded = expandedKey === key.keyId
          const meaningfulSignals = dedupSignals(key.providerReported.filter(signal => signal.remaining === null || signal.remaining > 0))
          return (
          <div key={key.keyId} className="grid gap-1">
            <div
              className={`grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-lg bg-muted/40 px-2.5 py-1.5 text-xs transition-colors ${isExpanded ? 'bg-muted/60 rounded-b-none' : 'hover:bg-muted/60 cursor-pointer'}`}
              onClick={() => setExpandedKey(isExpanded ? null : key.keyId)}
            >
              <div className="flex min-w-0 items-center gap-x-1.5">
                <span className="size-1.5 shrink-0 rounded-full bg-foreground/60" />
                <span className="min-w-0 max-w-[160px] truncate font-medium">{key.label}</span>
                <span className="text-muted-foreground">{key.status}</span>
                {key.cooldowns.length > 0 && <CooldownList cooldowns={key.cooldowns} compact />}
              </div>
              <div className="flex shrink-0 items-center gap-1.5 text-muted-foreground tabular-nums">
                {limitLine && <span className="text-muted-foreground/80">{limitLine}</span>}
                {key.requests > 0 && limitLine && <span className="text-muted-foreground/40">·</span>}
                {key.requests > 0 && <span className="font-medium text-foreground/80">{key.requests} {t('usageLimits.reqLabel')}</span>}
              </div>
            </div>
            {isExpanded && (
              <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 rounded-b-lg bg-muted/40 px-2.5 py-1.5 text-xs">
                {meaningfulSignals.map(signal => (
                  <span
                    key={`${signal.quotaPoolKey}:${signal.metric}`}
                    className="inline-flex items-center gap-0.5 rounded-md bg-background/60 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground tabular-nums"
                    title={t('usageLimits.providerReportedTooltip', { source: SOURCE_LABELS[signal.source], confidence: Math.round(signal.confidence * 100) })}
                  >
                    {signal.remaining !== null ? `${signal.metric} ${formatQuotaNumber(signal.remaining)} left` : `${signal.metric} cap ${formatQuotaNumber(signal.limit)}`}
                  </span>
                ))}
                {meaningfulSignals.length === 0 && (
                  <span className="text-muted-foreground/60">{t('usageLimits.noAdditionalStats')}</span>
                )}
              </div>
            )}
          </div>
          )
        })}
        {model.keys.length > 2 && (
          <button
            type="button"
            onClick={() => setShowAllKeys(current => !current)}
            className="rounded-xl border border-dashed bg-background/40 px-3 py-2 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
          >
            {showAllKeys ? t('usageLimits.showOnlyRecentKeys') : t('usageLimits.showAllKeys', { count: hiddenKeyCount })}
          </button>
        )}
      </div>
    </div>
  )
}

function ProviderCard({ provider, onOpen }: { provider: ProviderUsage; onOpen: () => void }) {
  const { t } = useI18n()
  const hasProviderCap = provider.providerRpd.limit !== null
  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full rounded-3xl border bg-card p-4 text-left space-y-4 transition-colors hover:bg-muted/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-base font-semibold capitalize">{provider.platform}</h3>
          <p className="text-xs text-muted-foreground mt-1">
            {provider.modelCount} {t('usageLimits.models').toLowerCase()} · {provider.keyCount} {provider.keyCount === 1 ? t('usageLimits.keyLabel') : t('usageLimits.keysLabel')}
          </p>
        </div>
        <Badge variant={provider.providerRpd.pct !== null && provider.providerRpd.pct >= 80 ? 'destructive' : 'secondary'}>
          {hasProviderCap ? `${provider.providerRpd.pct}% ${t('usageLimits.providerCap')}` : t('usageLimits.providerLimits')}
        </Badge>
      </div>
      <div className="grid grid-cols-2 gap-3 text-sm">
        <div className="rounded-2xl bg-muted/40 p-3">
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{t('usageLimits.requests24h')}</p>
          <p className="font-semibold tabular-nums mt-1">{formatCount(provider.requests24h)}</p>
        </div>
        <div className="rounded-2xl bg-muted/40 p-3">
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{t('usageLimits.tokens24h')}</p>
          <p className="font-semibold tabular-nums mt-1">{formatTokens(provider.tokens24h)}</p>
        </div>
      </div>
      <ProgressLine label={hasProviderCap ? t('usageLimits.providerDailyCap') : t('usageLimits.providerWideCap')} counter={provider.providerRpd} unit="rpd" />
      <ProgressLine label={t('usageLimits.modelBudget')} counter={provider.monthly} unit="tok" tokenLike />
    </button>
  )
}

function providerPanelId(provider: string): string {
  return `usage-provider-${encodeURIComponent(provider)}`
}

export default function UsageLimitsPage() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [collapsedProviders, setCollapsedProviders] = useState(readCollapsedProviders)
  const [cooldownProbeToast, setCooldownProbeToast] = useState<{ kind: 'success' | 'partial' | 'timeout'; recovered: number; newlyCooled: number; stillCooled: number; probed: number } | null>(null)
  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['usage-limits'],
    queryFn: () => apiFetch<UsageLimitsResponse>('/api/usage-limits'),
    refetchInterval: USAGE_LIMITS_REFETCH_INTERVAL_MS,
    refetchIntervalInBackground: false,
  })

  const probeCooldowns = useMutation({
    mutationFn: () => apiFetch<{
      probed: number;
      recovered: Array<{ platform: string; modelId: string; keyId: number }>;
      newlyCooled: Array<{ platform: string; modelId: string; keyId: number; reason: string }>;
      stillCooled: number;
      timedOut: boolean;
    }>('/api/usage-limits/probe-cooldowns', { method: 'POST' }),
    onSuccess: (result) => {
      setCooldownProbeToast({
        kind: result.timedOut ? 'timeout' : result.recovered.length > 0 ? 'success' : 'partial',
        recovered: result.recovered.length,
        newlyCooled: result.newlyCooled.length,
        stillCooled: result.stillCooled,
        probed: result.probed,
      })
      queryClient.invalidateQueries({ queryKey: ['usage-limits'] })
    },
  })

  const providers = data?.providers ?? []
  const models = data?.models ?? []
  const modelsByProvider = providers.map(provider => ({
    provider: provider.platform,
    models: models.filter(model => model.platform === provider.platform),
  }))
  const allCollapsed = modelsByProvider.length > 0 && modelsByProvider.every(group => collapsedProviders[group.provider] === true)

  function toggleAllProviders() {
    const targetCollapsed = !allCollapsed
    const next: Record<string, boolean> = {}
    for (const group of modelsByProvider) {
      next[group.provider] = targetCollapsed
    }
    setCollapsedProviders(next)
    try {
      window.localStorage.setItem(COLLAPSED_PROVIDERS_KEY, JSON.stringify(next))
    } catch {
    }
  }

  function toggleProvider(provider: string) {
    setCollapsedProviders(current => {
      const next = { ...current, [provider]: !current[provider] }
      try {
        window.localStorage.setItem(COLLAPSED_PROVIDERS_KEY, JSON.stringify(next))
      } catch {
      }
      return next
    })
  }

  function openProvider(provider: string) {
    setCollapsedProviders(current => {
      const next = { ...current, [provider]: false }
      try {
        window.localStorage.setItem(COLLAPSED_PROVIDERS_KEY, JSON.stringify(next))
      } catch {
      }
      return next
    })

    window.requestAnimationFrame(() => {
      document.getElementById(providerPanelId(provider))?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    })
  }

  return (
    <div>
      <PageHeader
        title={t('usageLimits.title')}
        description={t('usageLimits.description')}
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => probeCooldowns.mutate()} disabled={probeCooldowns.isPending}>
              {probeCooldowns.isPending ? t('usageLimits.checkingCooldowns') : t('usageLimits.checkCooldowns')}
              <Timer className={`size-3.5 ${probeCooldowns.isPending ? 'animate-pulse' : ''}`} />
            </Button>
            <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
              {t('usageLimits.refresh')}
              <RefreshCw className={`size-4 ${isFetching ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        }
      />

      <div className="space-y-6">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <Stat label={t('usageLimits.tokens24h')} value={formatTokens(data?.summary.tokens24h)} icon={Zap} />
          <Stat label={t('usageLimits.requests24h')} value={formatCount(data?.summary.requests24h)} icon={Activity} />
          <Stat label={t('usageLimits.tokens30d')} value={formatTokens(data?.summary.tokens30d)} icon={Zap} />
          <Stat label={t('usageLimits.requests30d')} value={formatCount(data?.summary.requests30d)} icon={Activity} />
          <Stat label={t('usageLimits.hotModels')} value={data?.summary.constrainedCount ?? 0} icon={ShieldAlert} />
          <Stat label={t('usageLimits.quotaSignals')} value={`${data?.summary.quotaReportingProviders ?? 0}/${data?.summary.providerCount ?? 0}`} icon={Radio} />
        </div>

        {isLoading ? (
          <Panel title={t('common.loading')}>
            <p className="text-sm text-muted-foreground text-center py-8">{t('common.loading')}</p>
          </Panel>
        ) : models.length === 0 ? (
          <Panel title={t('usageLimits.noConnectedModels')}>
            <p className="text-sm text-muted-foreground text-center py-8">{t('usageLimits.noConnectedModelsDescription')}</p>
          </Panel>
        ) : (
          <>
            <RouterPressurePanel />

            <ProviderQuotaPanel signals={data?.quotaSignals ?? []} />

            <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
              {providers.map(provider => <ProviderCard key={provider.platform} provider={provider} onOpen={() => openProvider(provider.platform)} />)}
            </div>

            {data?.constrainedModels.length ? (
              <Panel title={t('usageLimits.pressureWatch')} subtitle={t('usageLimits.pressureWatchDescription')}>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  {data.constrainedModels.map(model => (
                    <div key={model.modelDbId} className="flex min-w-0 flex-col gap-2 rounded-2xl border bg-background/50 p-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
                      <div className="min-w-0 flex-1">
                        <p className="font-medium text-sm truncate">{model.displayName}</p>
                        <p className="text-xs text-muted-foreground truncate">{model.platform} · {model.modelId}</p>
                      </div>
                      <Badge className="w-fit" variant={limitScore(model) >= 90 ? 'destructive' : 'secondary'}>{hottestMetricBadge(model, t('usageLimits.uncapped'), t('usageLimits.noCatalogQuota'))}</Badge>
                    </div>
                  ))}
                </div>
              </Panel>
            ) : null}

            <div className="space-y-6">
              <div className="flex flex-wrap items-center justify-end gap-2">
                {modelsByProvider.length > 1 && (
                  <button
                    type="button"
                    onClick={toggleAllProviders}
                    className="inline-flex items-center gap-1.5 rounded-xl border bg-card px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/30 hover:text-foreground"
                  >
                    <ChevronsUpDown className="size-3.5" />
                    {allCollapsed ? t('usageLimits.expandAll') : t('usageLimits.collapseAll')}
                  </button>
                )}
              </div>

              {cooldownProbeToast && (
                <div className={`rounded-2xl border px-3 py-2 text-xs ${
                  cooldownProbeToast.kind === 'success'
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                    : cooldownProbeToast.kind === 'timeout'
                      ? 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300'
                      : 'border-border bg-card text-muted-foreground'
                }`}>
                  {cooldownProbeToast.kind === 'success' && t('usageLimits.cooldownProbeRecovered', {
                    recovered: cooldownProbeToast.recovered,
                    newlyCooled: cooldownProbeToast.newlyCooled,
                    stillCooled: cooldownProbeToast.stillCooled,
                  })}
                  {cooldownProbeToast.kind === 'partial' && t('usageLimits.cooldownProbeNone', {
                    probed: cooldownProbeToast.probed,
                    newlyCooled: cooldownProbeToast.newlyCooled,
                    stillCooled: cooldownProbeToast.stillCooled,
                  })}
                  {cooldownProbeToast.kind === 'timeout' && t('usageLimits.cooldownProbeTimeout', {
                    probed: cooldownProbeToast.probed,
                  })}
                </div>
              )}
              {modelsByProvider.map(group => (
                <ProviderModelsPanel
                  key={group.provider}
                  id={providerPanelId(group.provider)}
                  title={group.provider}
                  subtitle={t('usageLimits.modelsCount', { count: group.models.length })}
                  collapsed={collapsedProviders[group.provider] === true}
                  onToggle={() => toggleProvider(group.provider)}
                >
                  <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                    {group.models.map(model => <ModelCard key={model.modelDbId} model={model} />)}
                  </div>
                </ProviderModelsPanel>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
