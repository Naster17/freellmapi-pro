import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Activity, ChevronDown, RefreshCw, ShieldAlert, Zap } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { PageHeader } from '@/components/page-header'
import { formatCount, formatTokens } from '@/lib/format'
import { useI18n } from '@/i18n'

type LimitCounter = { used: number; limit: number | null; pct: number | null; remaining: number | null }
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
  }
  providers: ProviderUsage[]
  models: ModelUsage[]
  constrainedModels: ModelUsage[]
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

function hottestMetric(model: ModelUsage): { label: string; pct: number | null } {
  const counters: [string, number | null][] = [
    ['RPM', model.rpm.pct],
    ['RPD', model.rpd.pct],
    ['TPM', model.tpm.pct],
    ['TPD', model.tpd.pct],
    ['30d tokens', model.monthly.pct],
  ]
  const known = counters.filter(([, pct]) => pct !== null)
  if (known.length === 0) return { label: 'No published cap', pct: null }
  const [label, pct] = known.sort((a, b) => (b[1] ?? -1) - (a[1] ?? -1))[0]
  return { label, pct }
}

function hottestMetricBadge(model: ModelUsage): string {
  const hottest = hottestMetric(model)
  if (hottest.pct === null) return 'uncapped'
  return `${hottest.pct}% ${hottest.label}`
}

function keyLimitLine(key: KeyUsage): string | null {
  const parts = [
    hasKnownLimit(key.rpm) ? formatLimit(key.rpm, 'rpm') : null,
    hasKnownLimit(key.rpd) ? formatLimit(key.rpd, 'rpd') : null,
    hasKnownLimit(key.tpm) ? formatLimit(key.tpm, 'tpm', true) : null,
    hasKnownLimit(key.tpd) ? formatLimit(key.tpd, 'tpd', true) : null,
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(' · ') : null
}

function ModelCard({ model }: { model: ModelUsage }) {
  const [showAllKeys, setShowAllKeys] = useState(false)
  const visibleKeys = showAllKeys ? model.keys : model.keys.slice(0, 2)
  const hiddenKeyCount = Math.max(0, model.keys.length - visibleKeys.length)
  const hottest = hottestMetric(model)
  const limitLine = [
    hasKnownLimit(model.monthly) ? `${formatTokens(model.monthly.limit)} (${model.keyCount} ${model.keyCount === 1 ? 'key' : 'keys'}) tok/mo` : null,
    hasKnownLimit(model.rpm) ? `${formatCount(model.rpm.limit)} rpm` : null,
    hasKnownLimit(model.rpd) ? `${formatCount(model.rpd.limit)} rpd` : null,
    hasKnownLimit(model.tpm) ? `${formatTokens(model.tpm.limit)} tpm` : null,
    hasKnownLimit(model.tpd) ? `${formatTokens(model.tpd.limit)} tpd` : null,
  ].filter(Boolean).join(' · ')

  return (
    <div className="min-w-0 rounded-2xl border bg-background/40 p-3 space-y-4 sm:p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h4 className="min-w-0 max-w-full truncate text-sm font-medium">{model.displayName}</h4>
            <Badge variant="outline" className="font-mono text-[10px]">{model.platform}</Badge>
            {limitScore(model) >= 90 && <Badge variant="destructive">hot</Badge>}
          </div>
          <p className="text-[11px] text-muted-foreground mt-1 tabular-nums break-words">{limitLine || 'No catalog quota published'}</p>
          <p className="text-[11px] text-muted-foreground/70 mt-0.5 truncate font-mono">{model.modelId}</p>
        </div>
        <div className="shrink-0 sm:text-right">
          <p className="text-base font-semibold tabular-nums sm:text-lg">{hottest.pct === null ? 'uncapped' : `${hottest.pct}%`}</p>
          <p className="text-[11px] text-muted-foreground">{hottest.label}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <ProgressLine label="RPM" counter={model.rpm} unit="rpm" />
        <ProgressLine label="RPD" counter={model.rpd} unit="rpd" />
        <ProgressLine label="TPM" counter={model.tpm} unit="tpm" tokenLike />
        <ProgressLine label="TPD" counter={model.tpd} unit="tpd" tokenLike />
      </div>
      <ProgressLine label="30-day tokens" counter={model.monthly} unit="tok" tokenLike />

      <div className="grid gap-2 pt-1">
        {visibleKeys.map(key => {
          const limitLine = keyLimitLine(key)
          return (
          <div key={key.keyId} className="flex min-w-0 flex-col gap-1.5 rounded-xl bg-muted/40 px-3 py-2 text-xs sm:flex-row sm:items-center sm:justify-between sm:gap-3">
            <div className="min-w-0 flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="size-1.5 rounded-full bg-foreground/60" />
              <span className="min-w-0 max-w-full truncate">{key.label}</span>
              <span className="text-muted-foreground">{key.status}</span>
              {key.requests > 0 && <span className="text-muted-foreground/60 tabular-nums">{key.requests} req</span>}
              {key.onCooldown && <span className="text-amber-600 dark:text-amber-400">cooldown</span>}
            </div>
            {limitLine && <div className="min-w-0 break-words tabular-nums text-muted-foreground sm:shrink-0 sm:text-right">{limitLine}</div>}
          </div>
          )
        })}
        {model.keys.length > 2 && (
          <button
            type="button"
            onClick={() => setShowAllKeys(current => !current)}
            className="rounded-xl border border-dashed bg-background/40 px-3 py-2 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/40 transition-colors"
          >
            {showAllKeys ? 'Show only recent keys' : `Show all keys (${hiddenKeyCount} more)`}
          </button>
        )}
      </div>
    </div>
  )
}

function ProviderCard({ provider, onOpen }: { provider: ProviderUsage; onOpen: () => void }) {
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
            {provider.modelCount} models · {provider.keyCount} {provider.keyCount === 1 ? 'key' : 'keys'}
          </p>
        </div>
        <Badge variant={provider.providerRpd.pct !== null && provider.providerRpd.pct >= 80 ? 'destructive' : 'secondary'}>
          {hasProviderCap ? `${provider.providerRpd.pct}% provider cap` : 'per-model limits'}
        </Badge>
      </div>
      <div className="grid grid-cols-2 gap-3 text-sm">
        <div className="rounded-2xl bg-muted/40 p-3">
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground">24h requests</p>
          <p className="font-semibold tabular-nums mt-1">{formatCount(provider.requests24h)}</p>
        </div>
        <div className="rounded-2xl bg-muted/40 p-3">
          <p className="text-[11px] uppercase tracking-wider text-muted-foreground">24h tokens</p>
          <p className="font-semibold tabular-nums mt-1">{formatTokens(provider.tokens24h)}</p>
        </div>
      </div>
      <ProgressLine label={hasProviderCap ? 'Provider daily cap' : 'Provider-wide cap'} counter={provider.providerRpd} unit="rpd" />
      <ProgressLine label="30-day model budget" counter={provider.monthly} unit="tok" tokenLike />
    </button>
  )
}

function providerPanelId(provider: string): string {
  return `usage-provider-${encodeURIComponent(provider)}`
}

export default function UsageLimitsPage() {
  const { t } = useI18n()
  const [collapsedProviders, setCollapsedProviders] = useState(readCollapsedProviders)
  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['usage-limits'],
    queryFn: () => apiFetch<UsageLimitsResponse>('/api/usage-limits'),
    refetchInterval: USAGE_LIMITS_REFETCH_INTERVAL_MS,
    refetchIntervalInBackground: false,
  })

  const providers = data?.providers ?? []
  const models = data?.models ?? []
  const modelsByProvider = providers.map(provider => ({
    provider: provider.platform,
    models: models.filter(model => model.platform === provider.platform),
  }))

  function toggleProvider(provider: string) {
    setCollapsedProviders(current => {
      const next = { ...current, [provider]: !current[provider] }
      try {
        window.localStorage.setItem(COLLAPSED_PROVIDERS_KEY, JSON.stringify(next))
      } catch {
        // Ignore storage failures; the UI state still updates for this session.
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
        // Ignore storage failures; the UI state still updates for this session.
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
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={`size-4 ${isFetching ? 'animate-spin' : ''}`} />
            {t('usageLimits.refresh')}
          </Button>
        }
      />

      <div className="space-y-6">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          <Stat label={t('usageLimits.tokens24h')} value={formatTokens(data?.summary.tokens24h)} icon={Zap} />
          <Stat label={t('usageLimits.requests24h')} value={formatCount(data?.summary.requests24h)} icon={Activity} />
          <Stat label={t('usageLimits.tokens30d')} value={formatTokens(data?.summary.tokens30d)} icon={Zap} />
          <Stat label={t('usageLimits.requests30d')} value={formatCount(data?.summary.requests30d)} icon={Activity} />
          <Stat label={t('usageLimits.hotModels')} value={data?.summary.constrainedCount ?? 0} icon={ShieldAlert} />
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
                      <Badge className="w-fit" variant={limitScore(model) >= 90 ? 'destructive' : 'secondary'}>{hottestMetricBadge(model)}</Badge>
                    </div>
                  ))}
                </div>
              </Panel>
            ) : null}

            <div className="space-y-6">
              {modelsByProvider.map(group => (
                <ProviderModelsPanel
                  key={group.provider}
                  id={providerPanelId(group.provider)}
                  title={group.provider}
                  subtitle={`${group.models.length} models`}
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
