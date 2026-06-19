import { useEffect, useState, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, Search, SlidersHorizontal } from 'lucide-react'
import { useI18n } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover'
import { Switch } from '@/components/ui/switch'
import { PageHeader } from '@/components/page-header'
import { FloatingBar } from '@/components/floating-bar'
import { ModelsTabs } from '@/components/models-tabs'
import { Tooltip } from '@/components/tooltip'

interface FallbackEntry {
  modelDbId: number
  priority: number
  effectivePriority: number
  penalty: number
  rateLimitHits: number
  enabled: boolean
  platform: string
  modelId: string
  displayName: string
  intelligenceRank: number
  speedRank: number
  sizeLabel: string
  rpmLimit: number | null
  rpdLimit: number | null
  monthlyTokenBudget: string
  contextWindow: number | null
  supportsVision: boolean
  supportsTools: boolean
  keyCount: number
}

type RoutingStrategy = 'priority' | 'balanced' | 'smartest' | 'fastest' | 'reliable' | 'custom'

type RoutingWeights = { reliability: number; speed: number; intelligence: number }

interface RoutingScore {
  modelDbId: number
  reliability: number
  speed: number
  intelligence: number
  headroom: number
  rateLimit: number
  score: number
  totalRequests: number
}

interface RoutingData {
  strategy: RoutingStrategy
  weights: RoutingWeights | null
  customWeights: RoutingWeights
  scores: (RoutingScore & { platform: string; modelId: string; displayName: string; enabled: boolean })[]
}

interface AnalyticsModelRow {
  platform: string
  modelId: string
  requests: number
  successRate: number
  avgLatencyMs: number
}

type LimitCounter = { pct: number | null }
type UsageLimitModel = {
  modelDbId: number
  rpm: LimitCounter
  rpd: LimitCounter
  tpm: LimitCounter
  tpd: LimitCounter
  monthly: LimitCounter
}
type UsageLimitsData = { models: UsageLimitModel[] }

type ConnectionFilter = 'all' | 'connected' | 'disconnected' | 'enabled'
type CapabilityFilter = 'all' | 'vision' | 'tools' | 'vision-tools'
type ContextFilter = 'any' | 'unknown' | '32k' | '128k' | '1m'
type SortKey = 'model' | 'provider' | 'connected' | 'context' | 'capabilities' | 'success' | 'latency' | 'quota' | 'score' | 'enabled'
type SortDirection = 'asc' | 'desc'

// A merged row: fallback-chain metadata + live bandit scores.
type Row = FallbackEntry & Partial<RoutingScore>

// `tKey` is the i18n suffix under `strategies.*` (label) and `strategies.*Blurb`.
// It differs from the routing `key` for Manual, whose strategy id is 'priority'.
const STRATEGIES: { key: RoutingStrategy; tKey: string }[] = [
  { key: 'priority', tKey: 'manual' },
  { key: 'balanced', tKey: 'balanced' },
  { key: 'smartest', tKey: 'smartest' },
  { key: 'fastest', tKey: 'fastest' },
  { key: 'reliable', tKey: 'reliable' },
  { key: 'custom', tKey: 'custom' },
]

// Slider axes share the colors used by the score table columns below.
// `tKey` is the i18n suffix under `strategies.weight*`.
const WEIGHT_AXES: { key: keyof RoutingWeights; tKey: string; color: string }[] = [
  { key: 'reliability', tKey: 'weightReliability', color: '#22c55e' },
  { key: 'speed', tKey: 'weightSpeed', color: '#3b82f6' },
  { key: 'intelligence', tKey: 'weightIntelligence', color: '#a855f7' },
]

// Slider popover for the 'custom' strategy. Sliders are independent (0-100)
// and the server renormalizes any vector, so we just show each axis's
// effective share live. Nothing is saved until Apply is pressed.
function CustomWeightsPopover({ saved, onSave, saving }: {
  saved: RoutingWeights
  onSave: (w: RoutingWeights) => void
  saving: boolean
}) {
  const { t } = useI18n()
  const [values, setValues] = useState<RoutingWeights>(() => fromSaved(saved))
  const [dirty, setDirty] = useState(false)

  // Defensive: an older/partial server response (or a future field rename) could
  // leave `saved` undefined; never let that white-screen the whole page (there's
  // no error boundary above us). Fall back to an even split.
  function fromSaved(w?: RoutingWeights): RoutingWeights {
    const safe = w ?? { reliability: 1 / 3, speed: 1 / 3, intelligence: 1 / 3 }
    return {
      reliability: Math.round(safe.reliability * 100),
      speed: Math.round(safe.speed * 100),
      intelligence: Math.round(safe.intelligence * 100),
    }
  }

  function update(key: keyof RoutingWeights, v: number) {
    setValues({ ...values, [key]: v })
    setDirty(true)
  }

  function apply() {
    if (sum <= 0) return
    onSave({
      reliability: values.reliability / 100,
      speed: values.speed / 100,
      intelligence: values.intelligence / 100,
    })
    setDirty(false)
  }

  const sum = values.reliability + values.speed + values.intelligence

  return (
    <Popover onOpenChange={open => { if (open) { setValues(fromSaved(saved)); setDirty(false) } }}>
      <PopoverTrigger className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
        <SlidersHorizontal className="size-3.5" />
        {t('strategies.adjust')}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80">
        <div className="space-y-4">
          <div>
            <h3 className="text-sm font-medium">{t('strategies.customWeights')}</h3>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t('strategies.customWeightsHelp')}
            </p>
          </div>
          {WEIGHT_AXES.map(axis => {
            const share = sum > 0 ? Math.round((values[axis.key] / sum) * 100) : 0
            const axisLabel = t(`strategies.${axis.tKey}`)
            return (
              <div key={axis.key}>
                <div className="mb-1 flex items-baseline justify-between text-xs">
                  <span className="inline-flex items-center gap-1.5">
                    <span className="size-2 rounded-sm" style={{ background: axis.color }} />
                    {axisLabel}
                  </span>
                  <span className="tabular-nums text-muted-foreground">{share}%</span>
                </div>
                <input
                  type="range"
                  min={0}
                  max={100}
                  step={1}
                  value={values[axis.key]}
                  onChange={e => update(axis.key, Number(e.target.value))}
                  className="w-full cursor-pointer"
                  style={{ accentColor: axis.color }}
                  aria-label={`${axisLabel} weight`}
                />
              </div>
            )
          })}
          {sum <= 0 && (
            <p className="text-xs text-amber-600 dark:text-amber-500">
              {t('strategies.weightRequired')}
            </p>
          )}
          <Button
            size="sm"
            className="w-full"
            disabled={!dirty || sum <= 0 || saving}
            onClick={apply}
          >
            {saving ? t('common.applying') : dirty ? t('common.apply') : t('common.applied')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  if (!Number.isInteger(n)) return n.toFixed(1)
  return String(n)
}

function formatContextWindow(n?: number | null): string {
  if (!n) return 'unknown'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`
  return String(n)
}

function formatLatency(ms?: number | null): string {
  if (!ms || ms <= 0) return '—'
  if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)}s`
  return `${Math.round(ms)}ms`
}

function formatPercent(value?: number | null): string {
  return value == null ? '—' : `${Math.round(value * 10) / 10}%`
}

function maxKnownPct(model?: UsageLimitModel): number | null {
  if (!model) return null
  const known = [model.rpm, model.rpd, model.tpm, model.tpd, model.monthly]
    .map(counter => counter.pct)
    .filter((pct): pct is number => pct !== null)
  return known.length > 0 ? Math.max(...known) : null
}

interface TokenUsageData {
  totalBudget: number
  totalUsed: number
  models: { displayName: string; platform: string; budget: number; keyCount?: number }[]
}

const platformColors: Record<string, string> = {
  google:      '#4285f4',
  groq:        '#f55036',
  cerebras:    '#8b5cf6',
  nvidia:      '#76b900',
  mistral:     '#f59e0b',
  openrouter:  '#ec4899',
  github:      '#6e7b8b',
  cohere:      '#d946ef',
  cloudflare:  '#f38020',
  zhipu:       '#06b6d4',
  ollama:      '#000000',
  kilo:        '#7c3aed',
  pollinations: '#a855f7',
  llm7:        '#0ea5e9',
  huggingface: '#ff9d00',
}

// Legend rows visible while collapsed (~6 rows: 6 × 16px line + 5 × 6px gap).
const LEGEND_COLLAPSED_PX = 126

function TokenUsageBar({ data }: { data: TokenUsageData }) {
  const { t } = useI18n()
  const { totalBudget, totalUsed, models } = data
  const remaining = Math.max(0, totalBudget - totalUsed)
  const remainingPct = totalBudget > 0 ? Math.round((remaining / totalBudget) * 100) : 0

  // Collapse the per-model legend to a few rows; the chevron reveals the rest.
  // The toggle only appears when the legend actually overflows the collapsed
  // height (column count — and so row count — depends on viewport width).
  const [expanded, setExpanded] = useState(false)
  const [collapsible, setCollapsible] = useState(false)
  const legendRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = legendRef.current
    if (!el) return
    const check = () => setCollapsible(el.scrollHeight > LEGEND_COLLAPSED_PX + 1)
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [models.length])

  const modelsWithWidth = models.map(m => ({
    ...m,
    remainingTokens: totalBudget > 0 ? (m.budget / totalBudget) * remaining : 0,
    widthPct: totalBudget > 0 ? (m.budget / totalBudget) * (remaining / totalBudget) * 100 : 0,
  }))
  const usedPct = totalBudget > 0 ? (totalUsed / totalBudget) * 100 : 0

  return (
    <section className="rounded-3xl border bg-card p-5">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-sm font-medium">{t('models.monthlyTokenBudget')}</h2>
        <span className="text-xs text-muted-foreground tabular-nums">
          <span className="text-foreground font-medium">{formatTokens(remaining)}</span> {t('models.remaining')}
          <span className="mx-1.5">·</span>
          {remainingPct}% {t('models.of')} {formatTokens(totalBudget)}
        </span>
      </div>

      <div className="flex h-2.5 rounded-full overflow-hidden bg-muted">
        {modelsWithWidth.map((m, i) => (
          <div
            key={i}
            title={`${m.displayName} (${m.platform}): ${formatTokens(m.remainingTokens)} remaining`}
            style={{
              width: `${m.widthPct}%`,
              backgroundColor: platformColors[m.platform] ?? '#94a3b8',
            }}
          />
        ))}
        {totalUsed > 0 && (
          <div
            title={`Used: ${formatTokens(totalUsed)}`}
            className="bg-muted-foreground/30"
            style={{ width: `${usedPct}%` }}
          />
        )}
      </div>

      <div
        ref={legendRef}
        className="mt-4 overflow-hidden transition-[max-height] duration-300 ease-in-out"
        style={collapsible ? { maxHeight: expanded ? legendRef.current?.scrollHeight : LEGEND_COLLAPSED_PX } : undefined}
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-5 gap-y-1.5 text-xs tabular-nums">
          {modelsWithWidth.map((m, i) => (
            <div key={i} className="flex items-center gap-2 min-w-0">
              <span
                className="size-2 rounded-sm flex-shrink-0"
                style={{ backgroundColor: platformColors[m.platform] ?? '#94a3b8' }}
              />
              <span className="truncate">{m.displayName}</span>
              <span className="flex-1" />
              <span className="font-mono text-muted-foreground">{formatTokens(m.remainingTokens)}</span>
            </div>
          ))}
        </div>
      </div>

      {collapsible && (
        <button
          onClick={() => setExpanded(e => !e)}
          className="mt-2 flex w-full items-center justify-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {expanded ? t('models.showLess') : t('models.showAllModels', { count: models.length })}
          <ChevronDown className={`size-3.5 transition-transform duration-300 ${expanded ? 'rotate-180' : ''}`} />
        </button>
      )}
    </section>
  )
}

type ExplorerRow = Row & {
  analytics?: AnalyticsModelRow
  quotaPressure: number | null
}

function FilterSelect<T extends string>({ label, value, options, onChange }: {
  label: string
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
}) {
  const selected = options.find(option => option.value === value)?.label ?? value
  return (
    <div className="grid gap-1">
      <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{label}</span>
      <DropdownMenu>
        <DropdownMenuTrigger className="flex h-9 w-full items-center justify-between gap-2 rounded-lg border bg-background px-2.5 text-left text-xs outline-none transition-colors hover:bg-muted/35 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50">
          <span className="min-w-0 truncate">{selected}</span>
          <ChevronDown className="size-4 shrink-0 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-[var(--radix-dropdown-menu-trigger-width)] min-w-40">
          {options.map(option => (
            <DropdownMenuItem
              key={option.value}
              onClick={() => onChange(option.value)}
              className={option.value === value ? 'bg-accent text-accent-foreground font-medium' : undefined}
            >
              {option.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

function ExplorerStat({ label, value, tone }: { label: string; value: string | number; tone?: string }) {
  return (
    <div className="rounded-2xl border bg-background/45 px-3 py-2">
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={`mt-0.5 text-lg font-semibold tabular-nums ${tone ?? ''}`}>{value}</p>
    </div>
  )
}

function quotaTone(pct: number | null): { labelKey: string; className: string; fill: string } {
  if (pct === null) return { labelKey: 'models.quotaUnknownLabel', className: 'text-muted-foreground', fill: 'bg-muted-foreground/30' }
  if (pct >= 90) return { labelKey: 'models.quotaHotLabel', className: 'text-destructive', fill: 'bg-destructive' }
  if (pct >= 70) return { labelKey: 'models.quotaWarmLabel', className: 'text-amber-600 dark:text-amber-400', fill: 'bg-amber-500' }
  return { labelKey: 'models.quotaCoolLabel', className: 'text-emerald-600 dark:text-emerald-400', fill: 'bg-emerald-500' }
}

function ProviderPill({ platform }: { platform: string }) {
  return (
    <span className="inline-grid h-6 max-w-full grid-cols-[auto_1fr] items-center gap-1.5 rounded-full bg-muted/70 px-2 text-xs text-foreground/85">
      <span className="size-1.5 rounded-full" style={{ backgroundColor: platformColors[platform] ?? '#94a3b8' }} />
      <span className="truncate">{platform}</span>
    </span>
  )
}

function ConnectionPill({ connected }: { connected: boolean }) {
  const { t } = useI18n()
  return (
    <span className={`inline-flex h-6 items-center rounded-full px-2 text-xs ${connected ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-muted text-muted-foreground'}`}>
      {connected ? t('models.connected') : t('models.disconnected')}
    </span>
  )
}

function CapabilityPills({ supportsVision, supportsTools }: { supportsVision: boolean; supportsTools: boolean }) {
  const { t } = useI18n()
  if (!supportsVision && !supportsTools) return <span className="text-xs text-muted-foreground">—</span>
  return (
    <div className="flex items-center gap-1.5">
      {supportsVision && <span className="inline-flex h-6 items-center rounded-full bg-cyan-600/15 px-2 text-xs text-cyan-700 dark:bg-cyan-400/15 dark:text-cyan-400">{t('models.vision')}</span>}
      {supportsTools && <span className="inline-flex h-6 items-center rounded-full bg-violet-600/15 px-2 text-xs text-violet-700 dark:bg-violet-400/15 dark:text-violet-400">{t('models.tools')}</span>}
    </div>
  )
}

function ModelExplorer({
  rows,
  analytics,
  usageLimits,
  isManual,
  onToggle,
}: {
  rows: Row[]
  analytics: AnalyticsModelRow[]
  usageLimits?: UsageLimitsData
  isManual: boolean
  onToggle: (modelDbId: number, enabled: boolean) => void
}) {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const [provider, setProvider] = useState('all')
  const [connection, setConnection] = useState<ConnectionFilter>('connected')
  const [capability, setCapability] = useState<CapabilityFilter>('all')
  const [context, setContext] = useState<ContextFilter>('any')
  const [sort, setSort] = useState<{ key: SortKey; direction: SortDirection } | null>(null)

  const analyticsByModel = new Map(analytics.map(row => [`${row.platform}:${row.modelId}`, row]))
  const quotaByModel = new Map((usageLimits?.models ?? []).map(model => [model.modelDbId, maxKnownPct(model)]))
  const providerOptions = [...new Set(rows.map(row => row.platform))].sort((a, b) => a.localeCompare(b))

  const enriched: ExplorerRow[] = rows.map(row => ({
    ...row,
    analytics: analyticsByModel.get(`${row.platform}:${row.modelId}`),
    quotaPressure: quotaByModel.get(row.modelDbId) ?? null,
  }))

  function matchesContext(row: ExplorerRow) {
    if (context === 'any') return true
    if (context === 'unknown') return row.contextWindow == null
    const min = context === '32k' ? 32_000 : context === '128k' ? 128_000 : 1_000_000
    return (row.contextWindow ?? 0) >= min
  }

  function defaultCompare(a: ExplorerRow, b: ExplorerRow) {
    return Number(b.keyCount > 0) - Number(a.keyCount > 0)
      || Number(b.enabled) - Number(a.enabled)
      || (isManual ? a.priority - b.priority : 0)
      || (b.score ?? 0) - (a.score ?? 0)
      || a.displayName.localeCompare(b.displayName)
  }

  function sortValue(row: ExplorerRow, key: SortKey): string | number | null {
    if (key === 'model') return row.displayName.toLowerCase()
    if (key === 'provider') return row.platform.toLowerCase()
    if (key === 'connected') return row.keyCount > 0 ? 1 : 0
    if (key === 'context') return row.contextWindow
    if (key === 'capabilities') return Number(row.supportsVision) + Number(row.supportsTools)
    if (key === 'success') return row.analytics?.successRate ?? null
    if (key === 'latency') return row.analytics?.avgLatencyMs && row.analytics.avgLatencyMs > 0 ? row.analytics.avgLatencyMs : null
    if (key === 'quota') return row.quotaPressure
    if (key === 'score') return row.score ?? null
    return row.enabled ? 1 : 0
  }

  function sortedCompare(a: ExplorerRow, b: ExplorerRow) {
    if (!sort) return defaultCompare(a, b)
    const av = sortValue(a, sort.key)
    const bv = sortValue(b, sort.key)
    if (av === null && bv === null) return defaultCompare(a, b)
    if (av === null) return 1
    if (bv === null) return -1
    const dir = sort.direction === 'asc' ? 1 : -1
    if (typeof av === 'string' && typeof bv === 'string') {
      return av.localeCompare(bv) * dir || defaultCompare(a, b)
    }
    return ((av as number) - (bv as number)) * dir || defaultCompare(a, b)
  }

  function toggleSort(key: SortKey) {
    setSort(current => {
      if (!current || current.key !== key) return { key, direction: 'desc' }
      if (current.direction === 'desc') return { key, direction: 'asc' }
      return null
    })
  }

  function SortHeader({ sortKey, children, className = '', align = 'left' }: { sortKey: SortKey; children: React.ReactNode; className?: string; align?: 'left' | 'right' }) {
    const active = sort?.key === sortKey
    const direction = active ? sort.direction : null
    return (
      <th className={className}>
        <button
          type="button"
          onClick={() => toggleSort(sortKey)}
          className={`group inline-flex w-full items-center gap-1.5 ${align === 'right' ? 'justify-end' : 'justify-start'} rounded-md text-muted-foreground transition-colors hover:text-foreground`}
        >
          <span>{children}</span>
          {active && <ChevronDown className={`size-3.5 shrink-0 transition-transform ${direction === 'asc' ? 'rotate-180' : ''}`} />}
        </button>
      </th>
    )
  }

  const normalizedQuery = query.trim().toLowerCase()
  const filtered = enriched
    .filter(row => {
      const haystack = `${row.displayName} ${row.modelId} ${row.platform} ${row.sizeLabel}`.toLowerCase()
      if (normalizedQuery && !haystack.includes(normalizedQuery)) return false
      if (provider !== 'all' && row.platform !== provider) return false
      if (connection === 'connected' && row.keyCount === 0) return false
      if (connection === 'disconnected' && row.keyCount > 0) return false
      if (connection === 'enabled' && !row.enabled) return false
      if (capability === 'vision' && !row.supportsVision) return false
      if (capability === 'tools' && !row.supportsTools) return false
      if (capability === 'vision-tools' && (!row.supportsVision || !row.supportsTools)) return false
      return matchesContext(row)
    })
    .sort(sortedCompare)

  const connectedCount = rows.filter(row => row.keyCount > 0).length

  return (
    <section className="rounded-3xl border bg-card p-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="max-w-2xl">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-medium">{t('models.explorerTitle')}</h2>
            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground tabular-nums">
              {t('models.explorerShown', { shown: filtered.length, total: rows.length })}
            </span>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => setConnection(connection === 'all' ? 'connected' : 'all')}
              className="ml-1 h-6 rounded-full px-2 text-[10px]"
            >
              {connection === 'all' ? t('models.showConnectedOnly') : t('models.showAllCatalog')}
            </Button>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{t('models.explorerDescription')}</p>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:w-[440px]">
          <ExplorerStat label={t('models.totalCatalog')} value={rows.length} />
          <ExplorerStat label={t('models.connectedModels')} value={connectedCount} tone="text-emerald-600 dark:text-emerald-400" />
          <ExplorerStat label={t('models.visionModels')} value={rows.filter(row => row.supportsVision).length} tone="text-cyan-600 dark:text-cyan-400" />
          <ExplorerStat label={t('models.toolModels')} value={rows.filter(row => row.supportsTools).length} tone="text-violet-600 dark:text-violet-400" />
        </div>
      </div>

      <div className="mt-5 grid gap-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder={t('models.searchModels')}
            className="h-10 rounded-xl pl-9 text-sm"
          />
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <FilterSelect
            label={t('models.filterProvider')}
            value={provider}
            onChange={setProvider}
            options={[{ value: 'all', label: t('models.allProviders') }, ...providerOptions.map(value => ({ value, label: value }))]}
          />
          <FilterSelect<ConnectionFilter>
            label={t('models.filterConnection')}
            value={connection}
            onChange={setConnection}
            options={[
              { value: 'all', label: t('models.connectionAll') },
              { value: 'connected', label: t('models.connectionConnected') },
              { value: 'disconnected', label: t('models.connectionDisconnected') },
              { value: 'enabled', label: t('models.connectionEnabled') },
            ]}
          />
          <FilterSelect<CapabilityFilter>
            label={t('models.filterCapability')}
            value={capability}
            onChange={setCapability}
            options={[
              { value: 'all', label: t('models.capabilityAll') },
              { value: 'vision', label: t('models.capabilityVision') },
              { value: 'tools', label: t('models.capabilityTools') },
              { value: 'vision-tools', label: t('models.capabilityVisionTools') },
            ]}
          />
          <FilterSelect<ContextFilter>
            label={t('models.filterContext')}
            value={context}
            onChange={setContext}
            options={[
              { value: 'any', label: t('models.contextAny') },
              { value: '32k', label: t('models.context32k') },
              { value: '128k', label: t('models.context128k') },
              { value: '1m', label: t('models.context1m') },
              { value: 'unknown', label: t('models.contextUnknown') },
            ]}
          />
        </div>
      </div>

      <div className="mt-5 rounded-2xl border overflow-hidden">
        <table className="w-full table-fixed text-sm">
          <thead>
            <tr className="border-b text-left text-xs text-muted-foreground">
              <SortHeader sortKey="model" className="py-2.5 pl-4 pr-3 font-medium">{t('models.columnModel')}</SortHeader>
              <SortHeader sortKey="provider" className="hidden w-28 py-2.5 pr-3 font-medium lg:table-cell">{t('models.columnProvider')}</SortHeader>
              <SortHeader sortKey="connected" className="hidden w-24 py-2.5 pr-3 font-medium md:table-cell">{t('models.columnConnected')}</SortHeader>
              <SortHeader sortKey="context" className="hidden w-20 py-2.5 pr-3 font-medium xl:table-cell">{t('models.columnContext')}</SortHeader>
              <SortHeader sortKey="capabilities" className="hidden w-28 py-2.5 pr-3 font-medium lg:table-cell">{t('models.columnCapabilities')}</SortHeader>
              <SortHeader sortKey="success" className="w-24 py-2.5 pr-3 font-medium text-right" align="right">{t('models.columnSuccess')}</SortHeader>
              <SortHeader sortKey="latency" className="hidden w-20 py-2.5 pr-3 font-medium text-right sm:table-cell" align="right">{t('models.columnLatency')}</SortHeader>
              <SortHeader sortKey="quota" className="w-28 py-2.5 pr-3 font-medium">{t('models.columnQuota')}</SortHeader>
              <SortHeader sortKey="score" className="hidden w-20 py-2.5 pr-3 font-medium text-right md:table-cell" align="right">{t('strategies.scoreColumn')}</SortHeader>
              <SortHeader sortKey="enabled" className="w-14 py-2.5 pr-4 font-medium text-right" align="right">{t('models.columnOn')}</SortHeader>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={10} className="px-4 py-10 text-center text-sm text-muted-foreground">{t('models.noExplorerMatches')}</td>
              </tr>
            ) : filtered.map(row => {
              const connected = row.keyCount > 0
              const quota = quotaTone(row.quotaPressure)
              const quotaWidth = row.quotaPressure === null ? 0 : Math.min(100, row.quotaPressure)
              return (
                <tr key={row.modelDbId} className={`border-b last:border-0 transition-colors hover:bg-muted/35 ${row.enabled ? '' : 'opacity-60'}`}>
                  <td className="min-w-0 py-3 pl-4 pr-3 align-middle">
                    <div className="min-w-0">
                      <p className="truncate font-medium leading-tight">{row.displayName}</p>
                      <p className="mt-0.5 font-mono text-[11px] text-muted-foreground/75 truncate">{row.modelId}</p>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 md:hidden">
                        <ProviderPill platform={row.platform} />
                        <ConnectionPill connected={connected} />
                        <span className="font-mono text-[10px] text-muted-foreground tabular-nums">{formatContextWindow(row.contextWindow)}</span>
                        <CapabilityPills supportsVision={row.supportsVision} supportsTools={row.supportsTools} />
                      </div>
                    </div>
                  </td>
                  <td className="hidden py-3 pr-3 align-middle lg:table-cell"><ProviderPill platform={row.platform} /></td>
                  <td className="hidden py-3 pr-3 align-middle md:table-cell"><ConnectionPill connected={connected} /></td>
                  <td className="hidden py-3 pr-3 align-middle font-mono text-xs text-muted-foreground tabular-nums xl:table-cell">{formatContextWindow(row.contextWindow)}</td>
                  <td className="hidden py-3 pr-3 align-middle lg:table-cell"><CapabilityPills supportsVision={row.supportsVision} supportsTools={row.supportsTools} /></td>
                  <td className="py-3 pr-3 align-middle text-right">
                    <p className="font-mono text-xs tabular-nums">{formatPercent(row.analytics?.successRate)}</p>
                    <p className="mt-0.5 text-[10px] text-muted-foreground tabular-nums">{row.analytics?.requests ? t('models.obs', { count: row.analytics.requests }) : t('models.noTraffic')}</p>
                  </td>
                  <td className="hidden py-3 pr-3 align-middle text-right font-mono text-xs text-muted-foreground tabular-nums sm:table-cell">{formatLatency(row.analytics?.avgLatencyMs)}</td>
                  <td className="py-3 pr-3 align-middle">
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                        <div className={`h-full rounded-full ${quota.fill}`} style={{ width: `${quotaWidth}%` }} />
                      </div>
                      <span className={`font-mono text-xs tabular-nums ${quota.className}`}>{row.quotaPressure === null ? t(quota.labelKey) : `${Math.round(row.quotaPressure)}%`}</span>
                    </div>
                  </td>
                  <td className="hidden py-3 pr-3 align-middle text-right font-mono text-xs font-medium tabular-nums md:table-cell">{row.score !== undefined ? row.score.toFixed(3) : '—'}</td>
                  <td className="py-3 pr-4 align-middle text-right">
                    <Switch checked={row.enabled} onCheckedChange={checked => onToggle(row.modelDbId, checked)} />
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}

export default function FallbackPage() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [localEntries, setLocalEntries] = useState<FallbackEntry[] | null>(null)

  const { data: entries = [], isLoading } = useQuery<FallbackEntry[]>({
    queryKey: ['fallback'],
    queryFn: () => apiFetch('/api/fallback'),
  })

  const { data: tokenUsage } = useQuery<TokenUsageData>({
    queryKey: ['fallback', 'token-usage'],
    queryFn: () => apiFetch('/api/fallback/token-usage'),
  })

  const { data: routing } = useQuery<RoutingData>({
    queryKey: ['fallback', 'routing'],
    queryFn: () => apiFetch('/api/fallback/routing'),
    refetchInterval: 15_000,
  })

  const { data: analytics = [] } = useQuery<AnalyticsModelRow[]>({
    queryKey: ['analytics', 'by-model', '7d'],
    queryFn: () => apiFetch('/api/analytics/by-model?range=7d'),
  })

  const { data: usageLimits } = useQuery<UsageLimitsData>({
    queryKey: ['usage-limits'],
    queryFn: () => apiFetch('/api/usage-limits'),
    refetchInterval: 15_000,
  })

  const saveMutation = useMutation({
    mutationFn: (data: { modelDbId: number; priority: number; enabled: boolean }[]) =>
      apiFetch('/api/fallback', { method: 'PUT', body: JSON.stringify(data) }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      setLocalEntries(null)
    },
  })

  const strategyMutation = useMutation({
    mutationFn: (payload: { strategy: RoutingStrategy; weights?: RoutingWeights }) =>
      apiFetch('/api/fallback/routing', { method: 'PUT', body: JSON.stringify(payload) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['fallback', 'routing'] }),
  })

  const strategy: RoutingStrategy = routing?.strategy ?? 'balanced'
  const isManual = strategy === 'priority'

  // Merge fallback metadata with live scores, keyed by model.
  const scoreById = new Map((routing?.scores ?? []).map(s => [s.modelDbId, s]))
  const allEntries = localEntries ?? entries

  // Entry fields win on overlap: the routing snapshot also carries `enabled`
  // (and identity fields), which would otherwise clobber unsaved local toggles.
  const allRows: Row[] = allEntries.map(e => ({ ...(scoreById.get(e.modelDbId) ?? {}), ...e }))

  function handleToggle(modelDbId: number, enabled: boolean) {
    setLocalEntries(allEntries.map(e => (e.modelDbId === modelDbId ? { ...e, enabled } : e)))
  }

  function handleSave() {
    saveMutation.mutate(allEntries.map(e => ({ modelDbId: e.modelDbId, priority: e.priority, enabled: e.enabled })))
  }

  const hasChanges = localEntries !== null

  return (
    <div>
      <PageHeader
        title={t('models.title')}
        description={t('strategies.description')}
        divider={false}
        actions={<ModelsTabs />}
      />

      <div className="space-y-6">
        {/* Monthly token budget — moved to the top */}
        {tokenUsage && tokenUsage.totalBudget > 0 && <TokenUsageBar data={tokenUsage} />}

        {/* Strategy selector */}
        <section className="rounded-3xl border bg-card p-5">
          <div className="flex items-baseline justify-between mb-3">
            <h2 className="text-sm font-medium">{t('strategies.title')}</h2>
            {routing?.weights && (
              <span className="text-xs text-muted-foreground tabular-nums">
                {t('strategies.weightsSummary', {
                  reliability: Math.round(routing.weights.reliability * 100),
                  speed: Math.round(routing.weights.speed * 100),
                  intelligence: Math.round(routing.weights.intelligence * 100),
                })}
              </span>
            )}
          </div>

          <div className="inline-flex flex-wrap items-center gap-1 rounded-xl border p-1">
            {STRATEGIES.map(s => (
              <Tooltip key={s.key} text={t(`strategies.${s.tKey}Blurb`)}>
                <button
                  disabled={strategyMutation.isPending}
                  onClick={() => strategyMutation.mutate({ strategy: s.key })}
                  className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${
                    s.key === strategy
                      ? 'bg-foreground text-background font-medium'
                      : 'text-muted-foreground hover:text-foreground hover:bg-muted'
                  }`}
                >
                  {t(`strategies.${s.tKey}`)}
                </button>
              </Tooltip>
            ))}
            {strategy === 'custom' && routing && (
              <CustomWeightsPopover
                saved={routing.customWeights}
                saving={strategyMutation.isPending}
                onSave={w => strategyMutation.mutate({ strategy: 'custom', weights: w })}
              />
            )}
          </div>

          <p className="mt-2 text-xs text-muted-foreground">
            {isManual ? t('models.explorerManualHint') : t('strategies.modeScoreHint')}
          </p>
        </section>

        {/* Searchable model explorer */}
        {isLoading ? (
          <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
        ) : allRows.length === 0 ? (
          <div className="rounded-3xl border border-dashed p-8 text-center">
            <p className="text-sm text-muted-foreground">
              {t('models.noModelsBefore')}<a href="/keys" className="underline text-foreground">{t('models.keysPageLink')}</a>{t('models.noModelsAfter')}
            </p>
          </div>
        ) : (
          <>
            <ModelExplorer rows={allRows} analytics={analytics} usageLimits={usageLimits} isManual={isManual} onToggle={handleToggle} />

            {/* Floating action bar — fixed to the viewport so it's always visible,
                sliding up when there are unsaved changes and back down on save/discard. */}
            <FloatingBar show={hasChanges}>
              <span className="text-xs text-muted-foreground">{t('common.unsavedChanges')}</span>
              <Button variant="outline" size="sm" onClick={() => setLocalEntries(null)}>{t('common.discard')}</Button>
              <Button size="sm" onClick={handleSave} disabled={saveMutation.isPending}>
                {saveMutation.isPending ? t('common.saving') : t('common.saveChanges')}
              </Button>
            </FloatingBar>

          </>
        )}
      </div>
    </div>
  )
}
