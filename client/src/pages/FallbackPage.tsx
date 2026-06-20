import { Fragment, useEffect, useMemo, useState, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, ChevronDown, Search, SlidersHorizontal } from 'lucide-react'
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
import { formatLatency, formatPercent, formatTokens } from '@/lib/format'
import { platformColors } from '@/pages/fallback/model-colors'
import { CapabilityPills, ConnectionPill, ProviderPill } from '@/pages/fallback/model-pills'

export interface FallbackEntry {
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
  tpmLimit: number | null
  tpdLimit: number | null
  monthlyTokenBudget: string
  monthlyTokenBudgetTokens?: number
  contextWindow: number | null
  supportsVision: boolean
  supportsTools: boolean
  keyCount: number
  // Logical-model grouping (sent by the server when unify is relevant). Absent
  // for ungrouped rows; the UI falls back to a per-row "solo" group then.
  groupKey?: string
  canonicalId?: string
  groupLabel?: string
}

type RoutingStrategy = 'priority' | 'balanced' | 'smartest' | 'fastest' | 'reliable' | 'custom'

type RoutingWeights = { reliability: number; speed: number; intelligence: number }

export interface RoutingScore {
  modelDbId: number
  reliability: number
  speed: number
  intelligence: number
  headroom: number
  rateLimit: number
  score: number
  totalRequests: number
}

export interface RoutingData {
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
type SortKey = 'model' | 'provider' | 'connected' | 'context' | 'capabilities' | 'success' | 'latency' | 'quota' | 'score' | 'enabled' | 'reliability' | 'speed' | 'intelligence' | 'guardrails'
type SortDirection = 'asc' | 'desc'
type ExplorerTableMode = 'metrics' | 'routing'
const DESKTOP_VIRTUAL_THRESHOLD = 250
const DESKTOP_ROW_HEIGHT = 64
const DESKTOP_ROW_OVERSCAN = 10

// A merged row: fallback-chain metadata + live bandit scores.
export type Row = FallbackEntry & Partial<RoutingScore>

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
function CustomWeightsPopover({ saved, onSave, saving, className = '', label }: {
  saved: RoutingWeights
  onSave: (w: RoutingWeights) => void
  saving: boolean
  className?: string
  label?: string
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
      <PopoverTrigger className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs transition-colors ${className || 'text-muted-foreground hover:text-foreground hover:bg-muted'}`}>
        <SlidersHorizontal className="size-3.5 shrink-0 opacity-80" />
        <span>{label ?? t('strategies.adjust')}</span>
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

function normalizedWeightEntries(weights: RoutingWeights): { axis: typeof WEIGHT_AXES[number]; percent: number }[] {
  const sum = weights.reliability + weights.speed + weights.intelligence || 1
  return WEIGHT_AXES.map(axis => ({ axis, percent: Math.round((weights[axis.key] / sum) * 100) }))
}

function WeightDistribution({ weights }: { weights: RoutingWeights | null }) {
  const { t } = useI18n()
  if (!weights) return null

  const entries = normalizedWeightEntries(weights)

  return (
    <div className="rounded-2xl border bg-background/45 p-3">
      <div className="mb-2.5 flex items-baseline justify-between gap-3">
        <p className="text-xs font-medium">{t('strategies.weightsTitle')}</p>
      </div>
      <div className="flex h-2 overflow-hidden rounded-full bg-muted">
        {entries.map(({ axis, percent }) => (
          <div
            key={axis.key}
            className="h-full transition-[width] duration-300 ease-out"
            style={{ width: `${percent}%`, backgroundColor: axis.color }}
          />
        ))}
      </div>
      <div className="mt-2.5 grid grid-cols-3 gap-2">
        {entries.map(({ axis, percent }) => (
          <div key={axis.key} className="min-w-0 rounded-xl bg-muted/45 px-2.5 py-1.5">
            <div className="flex items-center gap-1.5">
              <span className="size-2 rounded-sm" style={{ backgroundColor: axis.color }} />
              <span className="min-w-0 truncate text-[11px] text-muted-foreground">{t(`strategies.${axis.tKey}`)}</span>
            </div>
            <p className="mt-0.5 font-mono text-sm font-semibold tabular-nums">{percent}%</p>
          </div>
        ))}
      </div>
    </div>
  )
}

function RoutePreview({ rows, isManual }: { rows: Row[]; isManual: boolean }) {
  const { t } = useI18n()

  return (
    <div className="flex h-full min-h-0 flex-col rounded-2xl border bg-background/45 p-3">
      <div className="mb-2.5">
        <div>
          <p className="text-xs font-medium">{t('strategies.routePreviewTitle')}</p>
          <p className="mt-0.5 text-[11px] text-muted-foreground">{t(isManual ? 'strategies.routePreviewManual' : 'strategies.routePreviewLive')}</p>
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="flex flex-1 items-center justify-center rounded-xl border border-dashed p-4 text-center text-xs text-muted-foreground">
          {t('strategies.routePreviewEmpty')}
        </div>
      ) : (
        <div className="flex flex-1 flex-col gap-2">
          {rows.map((row, index) => {
            const score = row.score === undefined ? '—' : Math.round(row.score * 100)
            return (
              <div key={row.modelDbId} className="grid flex-1 grid-cols-[auto_minmax(0,1fr)_3.25rem] items-center gap-3 rounded-xl border bg-card/70 px-3 py-2">
                <span className="grid size-6 place-items-center rounded-full bg-foreground text-[11px] font-semibold text-background tabular-nums">
                  {index + 1}
                </span>
                <div className="min-w-0">
                  <p className="line-clamp-2 text-sm font-medium leading-snug text-foreground">{row.displayName}</p>
                  <div className="mt-1 flex min-w-0 items-center gap-2">
                    <ProviderPill platform={row.platform} />
                    {isManual && <span className="truncate text-[11px] text-muted-foreground">{t('strategies.routePreviewManualPosition', { position: row.priority })}</span>}
                  </div>
                </div>
                <div className="text-right">
                  <p className="font-mono text-sm font-semibold tabular-nums">{score}</p>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{isManual ? t('models.columnPriority') : t('strategies.scoreColumn')}</p>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function formatContextWindow(n?: number | null): string {
  if (n == null) return 'unknown'
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}K`
  return String(n)
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
  models: { modelDbId: number; displayName: string; platform: string; budget: number; keyCount?: number }[]
}

function mixHexColor(hex: string, target: string, amount: number): string {
  const cleanHex = hex.replace('#', '')
  const cleanTarget = target.replace('#', '')
  if (cleanHex.length !== 6 || cleanTarget.length !== 6) return hex
  const source = [0, 2, 4].map(i => Number.parseInt(cleanHex.slice(i, i + 2), 16))
  const targetRgb = [0, 2, 4].map(i => Number.parseInt(cleanTarget.slice(i, i + 2), 16))
  if (source.some(Number.isNaN) || targetRgb.some(Number.isNaN)) return hex
  const mixed = source.map((channel, i) => Math.round(channel + (targetRgb[i] - channel) * amount))
  return `#${mixed.map(channel => channel.toString(16).padStart(2, '0')).join('')}`
}

function modelSliceColor(platform: string, index: number, total: number): string {
  const base = platformColors[platform] ?? '#94a3b8'
  if (total <= 1) return base
  const position = index / (total - 1)
  const target = position < 0.5 ? '#0f172a' : '#ffffff'
  const amount = position < 0.5 ? 0.22 - position * 0.24 : (position - 0.5) * 0.46
  return mixHexColor(base, target, amount)
}

// Legend rows visible while collapsed (~6 rows: 6 × 16px line + 5 × 6px gap).
const LEGEND_COLLAPSED_PX = 126
const PROVIDER_ZOOM_PHASE_MS = 180
const TOKEN_SEGMENT_CLASS = 'block h-full w-full transition-[background-color,box-shadow,filter] duration-200 ease-out hover:z-10 hover:brightness-125 hover:saturate-125 hover:shadow-[inset_0_1px_0_rgb(255_255_255_/_0.28),inset_0_-5px_10px_rgb(0_0_0_/_0.12)] focus-visible:z-10 focus-visible:brightness-125 focus-visible:saturate-125 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

function TokenUsageBar({ data, onOpenModel }: { data: TokenUsageData; onOpenModel: (modelDbId: number) => void }) {
  const { t } = useI18n()
  const { totalBudget, totalUsed, models } = data
  const remaining = Math.max(0, totalBudget - totalUsed)
  const remainingPct = totalBudget > 0 ? Math.round((remaining / totalBudget) * 100) : 0

  // Collapse the per-model legend to a few rows; the chevron reveals the rest.
  // The toggle only appears when the legend actually overflows the collapsed
  // height (column count — and so row count — depends on viewport width).
  const [expanded, setExpanded] = useState(false)
  const [collapsible, setCollapsible] = useState(false)
  const [legendHeight, setLegendHeight] = useState(LEGEND_COLLAPSED_PX)
  const [activeProvider, setActiveProvider] = useState<string | null>(null)
  const [zoomPhase, setZoomPhase] = useState<'provider' | 'models'>('provider')
  const legendRef = useRef<HTMLDivElement>(null)
  const zoomTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const modelsWithWidth = models
    .map(m => ({
      ...m,
      remainingTokens: totalBudget > 0 ? (m.budget / totalBudget) * remaining : 0,
      widthPct: totalBudget > 0 ? (m.budget / totalBudget) * (remaining / totalBudget) * 100 : 0,
    }))
    .filter(m => m.budget > 0 && m.widthPct > 0)
  const usedPct = totalBudget > 0 ? (totalUsed / totalBudget) * 100 : 0
  const providerMap = new Map<string, {
    platform: string
    budget: number
    remainingTokens: number
    widthPct: number
    models: typeof modelsWithWidth
  }>()

  for (const model of modelsWithWidth) {
    const group = providerMap.get(model.platform) ?? {
      platform: model.platform,
      budget: 0,
      remainingTokens: 0,
      widthPct: 0,
      models: [],
    }
    group.budget += model.budget
    group.remainingTokens += model.remainingTokens
    group.widthPct += model.widthPct
    group.models.push(model)
    providerMap.set(model.platform, group)
  }

  const providerGroups = [...providerMap.values()]
    .map(group => ({
      ...group,
      models: [...group.models].sort((a, b) => b.remainingTokens - a.remainingTokens || a.displayName.localeCompare(b.displayName)),
    }))
    .sort((a, b) => b.remainingTokens - a.remainingTokens || a.platform.localeCompare(b.platform))
  const activeGroup = activeProvider ? providerGroups.find(group => group.platform === activeProvider) : undefined
  const groupedLegendModels = (activeGroup ? activeGroup.models : providerGroups.flatMap(group => group.models))

  function clearZoomTimer() {
    if (zoomTimerRef.current) {
      clearTimeout(zoomTimerRef.current)
      zoomTimerRef.current = null
    }
  }

  function resetProviderFocus(immediate = false) {
    clearZoomTimer()
    if (immediate || !activeProvider) {
      setActiveProvider(null)
      setZoomPhase('provider')
      return
    }
    setZoomPhase('provider')
    zoomTimerRef.current = setTimeout(() => {
      setActiveProvider(null)
      setZoomPhase('provider')
    }, PROVIDER_ZOOM_PHASE_MS)
  }

  function focusProvider(platform: string) {
    clearZoomTimer()
    setActiveProvider(platform)
    setZoomPhase('provider')
    setExpanded(false)
    zoomTimerRef.current = setTimeout(() => setZoomPhase('models'), PROVIDER_ZOOM_PHASE_MS)
  }

  useEffect(() => {
    const el = legendRef.current
    if (!el) return
    const check = () => {
      setLegendHeight(el.scrollHeight)
      setCollapsible(el.scrollHeight > LEGEND_COLLAPSED_PX + 1)
    }
    check()
    const ro = new ResizeObserver(check)
    ro.observe(el)
    return () => ro.disconnect()
  }, [groupedLegendModels.length, activeProvider])

  useEffect(() => () => {
    clearZoomTimer()
  }, [])

  return (
    <section className="rounded-3xl border bg-card p-4 sm:p-5" onMouseLeave={() => { if (activeGroup) resetProviderFocus(true) }}>
      <div className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-baseline sm:justify-between">
        <h2 className="text-sm font-medium">{t('models.monthlyTokenBudget')}</h2>
        <span className="text-xs text-muted-foreground tabular-nums">
          <span className="text-foreground font-medium">{formatTokens(remaining)}</span> {t('models.remaining')}
          <span className="mx-1.5">·</span>
          {remainingPct}% {t('models.of')} {formatTokens(totalBudget)}
        </span>
      </div>

      <div
        className="flex h-2.5 overflow-hidden rounded-full bg-muted transition-[filter] duration-200 ease-out"
      >
        {activeGroup && zoomPhase === 'provider' ? (
          <Tooltip
            key={activeGroup.platform}
            text={`${activeGroup.platform}: ${formatTokens(activeGroup.remainingTokens)} remaining · ${activeGroup.models.length} models`}
            className="block h-full shrink-0 transition-all duration-300 ease-out"
            style={{ width: '100%' }}
          >
            <button
              type="button"
              onClick={() => resetProviderFocus()}
              className={`${TOKEN_SEGMENT_CLASS} rounded-full`}
              style={{ backgroundColor: platformColors[activeGroup.platform] ?? '#94a3b8' }}
              aria-label={`${activeGroup.platform}: ${formatTokens(activeGroup.remainingTokens)}`}
            />
          </Tooltip>
        ) : activeGroup ? (
          activeGroup.models.map((model, i) => {
            const widthPct = activeGroup.remainingTokens > 0 ? (model.remainingTokens / activeGroup.remainingTokens) * 100 : 0
            return (
              <Tooltip
                key={`${activeGroup.platform}:${model.displayName}:${i}`}
                text={`${model.displayName} (${activeGroup.platform}): ${formatTokens(model.remainingTokens)} remaining · ${Math.round(widthPct)}% of ${activeGroup.platform}`}
                className="block h-full shrink-0 transition-all duration-300 ease-out"
                style={{ width: `${widthPct}%` }}
              >
                <button
                  type="button"
                  onClick={() => onOpenModel(model.modelDbId)}
                  className={`${TOKEN_SEGMENT_CLASS} ${i > 0 ? 'border-l border-background/70' : ''} ${i === 0 ? 'rounded-l-full' : ''} ${i === activeGroup.models.length - 1 ? 'rounded-r-full' : ''}`}
                  style={{ backgroundColor: modelSliceColor(activeGroup.platform, i, activeGroup.models.length) }}
                  aria-label={`${model.displayName}: ${formatTokens(model.remainingTokens)}`}
                />
              </Tooltip>
            )
          })
        ) : (
          <>
            {providerGroups.map((group, i) => (
              <Tooltip
                key={group.platform}
                text={`${group.platform}: ${formatTokens(group.remainingTokens)} remaining · ${group.models.length} models · ${Math.round((group.remainingTokens / Math.max(1, remaining)) * 100)}% of remaining`}
                className="block h-full shrink-0 transition-all duration-300 ease-out"
                style={{ width: `${group.widthPct}%` }}
              >
                <button
                  type="button"
                  onClick={() => focusProvider(group.platform)}
                  className={`${TOKEN_SEGMENT_CLASS} ${i > 0 ? 'border-l border-background/70' : ''} ${i === 0 ? 'rounded-l-full' : ''} ${i === providerGroups.length - 1 && totalUsed <= 0 ? 'rounded-r-full' : ''}`}
                  style={{ backgroundColor: platformColors[group.platform] ?? '#94a3b8' }}
                  aria-label={`${group.platform}: ${formatTokens(group.remainingTokens)}`}
                />
              </Tooltip>
            ))}
            {totalUsed > 0 && (
              <Tooltip text={`Used: ${formatTokens(totalUsed)}`} className="block h-full shrink-0 transition-all duration-300 ease-out" style={{ width: `${usedPct}%` }}>
                <span className={`${TOKEN_SEGMENT_CLASS} rounded-r-full border-l border-background/70 bg-muted-foreground/30`} />
              </Tooltip>
            )}
          </>
        )}
      </div>

      <div
        ref={legendRef}
        className="mt-4 overflow-hidden transition-[max-height] duration-300 ease-in-out"
        style={collapsible ? { maxHeight: expanded ? legendHeight : LEGEND_COLLAPSED_PX } : undefined}
      >
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-5 gap-y-1.5 text-xs tabular-nums">
          {groupedLegendModels.map((model, index) => (
            <div key={`${model.platform}:${model.displayName}:${index}`} className="flex items-center gap-2 min-w-0">
              <span
                className="size-2 rounded-sm flex-shrink-0"
                style={{ backgroundColor: activeGroup ? modelSliceColor(model.platform, index, groupedLegendModels.length) : platformColors[model.platform] ?? '#94a3b8' }}
              />
              <span className="truncate">{model.displayName}</span>
              <span className="flex-1" />
              <span className="font-mono text-muted-foreground">{formatTokens(model.remainingTokens)}</span>
            </div>
          ))}
        </div>
      </div>

      {collapsible && (
        <button
          onClick={() => setExpanded(e => !e)}
          className="mt-2 flex w-full items-center justify-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          {expanded ? t('models.showLess') : t('models.showAllModels', { count: groupedLegendModels.length })}
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

function RoutingBar({ value, color }: { value?: number; color: string }) {
  const pct = value === undefined ? 0 : Math.max(0, Math.min(100, Math.round(value * 100)))
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full" style={{ width: `${pct}%`, backgroundColor: color }} />
      </div>
      <span className="w-9 text-right font-mono text-xs text-muted-foreground tabular-nums">{value === undefined ? '—' : pct}</span>
    </div>
  )
}

function axisPercent(value?: number): string {
  return value === undefined ? '—' : `${Math.round(value * 100)}%`
}

function SpecLine({ label, value, percent, color, detail }: { label: string; value: string; percent?: number; color: string; detail?: string }) {
  const width = percent === undefined ? 0 : Math.max(0, Math.min(100, Math.round(percent * 100)))
  return (
    <div className="min-w-0 rounded-xl border bg-background/45 px-3 py-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-[10px] uppercase tracking-wider text-muted-foreground">{label}</span>
        <span className="font-mono text-sm font-semibold tabular-nums">{value}</span>
      </div>
      {percent !== undefined ? (
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full transition-[width] duration-300 ease-out" style={{ width: `${width}%`, backgroundColor: color }} />
        </div>
      ) : (
        <div className="mt-2 h-1.5 rounded-full bg-muted/55" />
      )}
      {detail && <p className="mt-1 truncate text-[11px] text-muted-foreground">{detail}</p>}
    </div>
  )
}

function guardValue(row: Partial<RoutingScore>): number {
  return (row.headroom ?? 1) * (row.rateLimit ?? 1)
}

function modelRouteSummary(row: ExplorerRow): string {
  const limits = [
    row.monthlyTokenBudget ? `${row.monthlyTokenBudget} tok/mo` : null,
    row.rpmLimit ? `${formatTokens(row.rpmLimit)} rpm` : null,
    row.rpdLimit ? `${formatTokens(row.rpdLimit)} rpd` : null,
  ].filter(Boolean)
  return limits.join(' · ')
}

function ModelSpecsPanel({ row }: { row: ExplorerRow }) {
  const { t } = useI18n()
  const guard = guardValue(row)

  return (
    <div className="grid grid-cols-2 gap-2 animate-in slide-in-from-top-1 duration-300 md:grid-cols-4">
      <SpecLine label={t('strategies.weightReliability')} value={axisPercent(row.reliability)} percent={row.reliability} color="#22c55e" detail={row.totalRequests ? t('models.obs', { count: row.totalRequests }) : t('models.noTraffic')} />
      <SpecLine label={t('strategies.weightSpeed')} value={axisPercent(row.speed)} percent={row.speed} color="#3b82f6" detail={formatLatency(row.analytics?.avgLatencyMs)} />
      <SpecLine label={t('strategies.weightIntelligence')} value={axisPercent(row.intelligence)} percent={row.intelligence} color="#a855f7" detail={row.sizeLabel} />
      <SpecLine label={t('strategies.guardrails')} value={guard < 0.999 ? `×${guard.toFixed(2)}` : 'clear'} color="#f59e0b" detail={`headroom ${axisPercent(row.headroom)} · rate ${axisPercent(row.rateLimit)}`} />
    </div>
  )
}

function MobileMetric({ label, value, children, className = '' }: { label: string; value?: React.ReactNode; children?: React.ReactNode; className?: string }) {
  return (
    <div className={`min-w-0 rounded-xl border bg-background/45 p-3 ${className}`}>
      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
      {value !== undefined && <div className="mt-1 truncate text-sm font-medium tabular-nums">{value}</div>}
      {children && <div className={value !== undefined ? 'mt-1' : 'mt-2'}>{children}</div>}
    </div>
  )
}

function ModelExplorer({
  rows,
  analytics,
  usageLimits,
  isManual,
  selectedModelId,
  onSelectModel,
  onToggle,
  onMove,
}: {
  rows: Row[]
  analytics: AnalyticsModelRow[]
  usageLimits?: UsageLimitsData
  isManual: boolean
  selectedModelId: number | null
  onSelectModel: (modelDbId: number | null) => void
  onToggle: (modelDbId: number, enabled: boolean) => void
  onMove: (modelDbId: number, direction: -1 | 1) => void
}) {
  const { t } = useI18n()
  const [query, setQuery] = useState('')
  const [provider, setProvider] = useState('all')
  const [connection, setConnection] = useState<ConnectionFilter>('connected')
  const [capability, setCapability] = useState<CapabilityFilter>('all')
  const [context, setContext] = useState<ContextFilter>('any')
  const [sort, setSort] = useState<{ key: SortKey; direction: SortDirection } | null>(null)
  const [tableMode, setTableMode] = useState<ExplorerTableMode>('metrics')
  const [desktopScrollTop, setDesktopScrollTop] = useState(0)
  const explorerRef = useRef<HTMLElement>(null)

  const analyticsByModel = useMemo(() => new Map(analytics.map(row => [`${row.platform}:${row.modelId}`, row])), [analytics])
  const quotaByModel = useMemo(() => new Map((usageLimits?.models ?? []).map(model => [model.modelDbId, maxKnownPct(model)])), [usageLimits])
  const providerOptions = useMemo(() => [...new Set(rows.map(row => row.platform))].sort((a, b) => a.localeCompare(b)), [rows])

  const enriched: ExplorerRow[] = useMemo(() => rows.map(row => ({
    ...row,
    analytics: analyticsByModel.get(`${row.platform}:${row.modelId}`),
    quotaPressure: quotaByModel.get(row.modelDbId) ?? null,
  })), [rows, analyticsByModel, quotaByModel])
  const manualOrder = useMemo(() => new Map(
    [...rows]
      .filter(row => row.keyCount > 0)
      .sort((a, b) => a.priority - b.priority)
      .map((row, index, ordered) => [row.modelDbId, { index, total: ordered.length }]),
  ), [rows])

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
    if (key === 'reliability') return row.reliability ?? null
    if (key === 'speed') return row.speed ?? null
    if (key === 'intelligence') return row.intelligence ?? null
    if (key === 'guardrails') return guardValue(row)
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
    setDesktopScrollTop(0)
    setSort(current => {
      if (!current || current.key !== key) return { key, direction: 'desc' }
      if (current.direction === 'desc') return { key, direction: 'asc' }
      return null
    })
  }

  function renderSortHeader(sortKey: SortKey, children: React.ReactNode, className = '', align: 'left' | 'right' = 'left') {
    const active = sort?.key === sortKey
    const direction = active ? sort.direction : null
    return (
      <th className={className} aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}>
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

  function renderMoveButtons(row: ExplorerRow) {
    const order = manualOrder.get(row.modelDbId)
    const first = !order || order.index === 0
    const last = !order || order.index === order.total - 1

    function move(direction: -1 | 1) {
      setSort(null)
      onMove(row.modelDbId, direction)
    }

    return (
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon-xs"
          disabled={first}
          aria-label={t('models.moveUp', { model: row.displayName })}
          onClick={() => move(-1)}
        >
          <ArrowUp className="size-3" />
        </Button>
        <Button
          variant="ghost"
          size="icon-xs"
          disabled={last}
          aria-label={t('models.moveDown', { model: row.displayName })}
          onClick={() => move(1)}
        >
          <ArrowDown className="size-3" />
        </Button>
      </div>
    )
  }

  function renderMoveControls(row: ExplorerRow) {
    return (
      <td className="w-20 py-3 pl-4 pr-2 align-middle" onClick={event => event.stopPropagation()}>
        {renderMoveButtons(row)}
      </td>
    )
  }

  const normalizedQuery = query.trim().toLowerCase()
  const filtered = useMemo(() => enriched
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
    .sort(sortedCompare), [enriched, normalizedQuery, provider, connection, capability, matchesContext, sortedCompare])

  const stats = useMemo(() => ({
    connected: rows.filter(row => row.keyCount > 0).length,
    vision: rows.filter(row => row.supportsVision).length,
    tools: rows.filter(row => row.supportsTools).length,
  }), [rows])
  const tableColSpan = (tableMode === 'routing' ? 8 : 10) + (isManual ? 1 : 0)
  const virtualDesktop = filtered.length > DESKTOP_VIRTUAL_THRESHOLD && selectedModelId === null
  const desktopStartIndex = virtualDesktop ? Math.max(0, Math.floor(desktopScrollTop / DESKTOP_ROW_HEIGHT) - DESKTOP_ROW_OVERSCAN) : 0
  const desktopVisibleCount = virtualDesktop ? Math.ceil(560 / DESKTOP_ROW_HEIGHT) + DESKTOP_ROW_OVERSCAN * 2 : filtered.length
  const desktopRows = virtualDesktop ? filtered.slice(desktopStartIndex, desktopStartIndex + desktopVisibleCount) : filtered
  const desktopTopSpacer = virtualDesktop ? desktopStartIndex * DESKTOP_ROW_HEIGHT : 0
  const desktopBottomSpacer = virtualDesktop ? Math.max(0, (filtered.length - desktopStartIndex - desktopRows.length) * DESKTOP_ROW_HEIGHT) : 0

  useEffect(() => {
    if (!selectedModelId) return
    const resetId = window.setTimeout(() => {
      setQuery('')
      setProvider('all')
      setConnection('all')
      setCapability('all')
      setContext('any')
      setDesktopScrollTop(0)
      const targetId = window.matchMedia('(min-width: 768px)').matches ? `model-row-${selectedModelId}` : `model-card-${selectedModelId}`
      document.getElementById(targetId)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }, 0)
    return () => window.clearTimeout(resetId)
  }, [selectedModelId])

  return (
    <section ref={explorerRef} id="model-explorer" className="rounded-3xl border bg-card p-4 sm:p-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="max-w-2xl">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-sm font-medium">{t('models.explorerTitle')}</h2>
            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground tabular-nums">
              {t('models.explorerShown', { shown: filtered.length, total: rows.length })}
            </span>
            <Button
              variant="ghost"
              size="xs"
              onClick={() => { setDesktopScrollTop(0); setTableMode(mode => mode === 'metrics' ? 'routing' : 'metrics') }}
              className="h-6 rounded-full px-2 text-[10px] sm:ml-1"
            >
              {tableMode === 'metrics' ? t('models.showRoutingSpecs') : t('models.showExplorerMetrics')}
            </Button>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">{t('models.explorerDescription')}</p>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:w-[440px]">
          <ExplorerStat label={t('models.connectedModels')} value={stats.connected} tone="text-emerald-600 dark:text-emerald-400" />
          <ExplorerStat label={t('models.visionModels')} value={stats.vision} tone="text-cyan-600 dark:text-cyan-400" />
          <ExplorerStat label={t('models.toolModels')} value={stats.tools} tone="text-violet-600 dark:text-violet-400" />
          <ExplorerStat label={t('models.totalModels')} value={rows.length} />
        </div>
      </div>

      <div className="mt-5 grid gap-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={event => { setDesktopScrollTop(0); setQuery(event.target.value) }}
            placeholder={t('models.searchModels')}
            className="h-10 rounded-xl pl-9 text-sm"
          />
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <FilterSelect
            label={t('models.filterProvider')}
            value={provider}
            onChange={value => { setDesktopScrollTop(0); setProvider(value) }}
            options={[{ value: 'all', label: t('models.allProviders') }, ...providerOptions.map(value => ({ value, label: value }))]}
          />
          <FilterSelect<ConnectionFilter>
            label={t('models.filterConnection')}
            value={connection}
            onChange={value => { setDesktopScrollTop(0); setConnection(value) }}
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
            onChange={value => { setDesktopScrollTop(0); setCapability(value) }}
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
            onChange={value => { setDesktopScrollTop(0); setContext(value) }}
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

      <div className="mt-5 overflow-hidden rounded-2xl border md:hidden">
        {filtered.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-muted-foreground">
            {t('models.noExplorerMatches')}
          </div>
        ) : (
          <div className="grid grid-cols-[minmax(0,1fr)_4.25rem_2.25rem] items-center gap-2 border-b bg-muted/20 px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            <span className="truncate">{t('models.columnModel')}</span>
            <span className="truncate text-right">{tableMode === 'routing' ? t('strategies.weightReliability') : t('models.columnQuota')}</span>
            <span className="truncate text-right">{t('models.columnOn')}</span>
          </div>
        )}
        {filtered.map((row, index) => {
          const connected = row.keyCount > 0
          const quota = quotaTone(row.quotaPressure)
          const quotaWidth = row.quotaPressure === null ? 0 : Math.min(100, row.quotaPressure)
          const expanded = selectedModelId === row.modelDbId
          const guard = guardValue(row)
          const reliabilityPct = row.reliability === undefined ? '—' : `${Math.round(row.reliability * 100)}%`
          const secondaryValue = tableMode === 'routing'
            ? reliabilityPct
            : (row.quotaPressure === null ? t(quota.labelKey) : `${Math.round(row.quotaPressure)}%`)

          return (
            <article
              key={row.modelDbId}
              id={`model-card-${row.modelDbId}`}
              className={`border-b last:border-b-0 transition-colors ${expanded ? 'bg-muted/20' : 'bg-card hover:bg-muted/20'} ${row.enabled ? '' : 'opacity-60'}`}
            >
              <div
                role="button"
                tabIndex={0}
                onClick={() => onSelectModel(expanded ? null : row.modelDbId)}
                onKeyDown={event => {
                  if (event.key !== 'Enter' && event.key !== ' ') return
                  event.preventDefault()
                  onSelectModel(expanded ? null : row.modelDbId)
                }}
                className="grid w-full cursor-pointer grid-cols-[minmax(0,1fr)_4.25rem_2.25rem] items-center gap-2 px-3 py-3 text-left"
              >
                <div className="min-w-0">
                  <div className="flex min-w-0 items-center gap-2">
                    {tableMode === 'routing' && (
                      <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-muted px-1 font-mono text-[10px] text-muted-foreground tabular-nums">
                        {index + 1}
                      </span>
                    )}
                    <span className="truncate text-sm font-medium leading-tight">{row.displayName}</span>
                  </div>
                  <div className="mt-1 flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
                    <span className="truncate">{row.platform}</span>
                    <span className="size-1 rounded-full bg-muted-foreground/45" />
                    <span className={connected ? 'text-emerald-600 dark:text-emerald-400' : ''}>{connected ? t('models.connected') : t('models.disconnected')}</span>
                  </div>
                </div>
                <div className={`text-right font-mono text-xs tabular-nums ${tableMode === 'routing' ? 'text-muted-foreground' : quota.className}`}>{secondaryValue}</div>
                <div className="flex items-center justify-end">
                  <span onClick={event => event.stopPropagation()}>
                    <Switch checked={row.enabled} onCheckedChange={checked => onToggle(row.modelDbId, checked)} />
                  </span>
                </div>
              </div>

              {expanded && (
                <div className="border-t bg-card/60 px-3 pb-3 pt-3">
                  <p className="truncate font-mono text-[11px] text-muted-foreground/75">{row.modelId}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    <ProviderPill platform={row.platform} />
                    <ConnectionPill connected={connected} />
                    <span className="inline-flex h-6 items-center rounded-full bg-muted/70 px-2 font-mono text-[10px] text-muted-foreground tabular-nums">
                      {formatContextWindow(row.contextWindow)}
                    </span>
                    <CapabilityPills supportsVision={row.supportsVision} supportsTools={row.supportsTools} />
                  </div>

                  {isManual && (
                    <div className="mt-3 flex items-center justify-between rounded-xl border bg-background/45 px-3 py-2" onClick={event => event.stopPropagation()}>
                      <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{t('models.columnPriority')}</span>
                      {renderMoveButtons(row)}
                    </div>
                  )}

                  {tableMode === 'routing' ? (
                    <>
                      <div className="mt-3 grid grid-cols-2 gap-2">
                        <MobileMetric label={t('strategies.scoreColumn')} value={row.score !== undefined ? row.score.toFixed(3) : '—'} />
                        <MobileMetric label={t('strategies.guardrails')} value={guard < 0.999 ? `×${guard.toFixed(2)}` : '—'} />
                      </div>
                      <div className="mt-2 grid gap-2">
                        <MobileMetric label={t('strategies.weightReliability')}><RoutingBar value={row.reliability} color="#22c55e" /></MobileMetric>
                        <MobileMetric label={t('strategies.weightSpeed')}><RoutingBar value={row.speed} color="#3b82f6" /></MobileMetric>
                        <MobileMetric label={t('strategies.weightIntelligence')}><RoutingBar value={row.intelligence} color="#a855f7" /></MobileMetric>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="mt-3 grid grid-cols-2 gap-2">
                        <MobileMetric label={t('models.columnSuccess')} value={formatPercent(row.analytics?.successRate)}>
                          <p className="text-[11px] text-muted-foreground tabular-nums">{row.analytics?.requests ? t('models.obs', { count: row.analytics.requests }) : t('models.noTraffic')}</p>
                        </MobileMetric>
                        <MobileMetric label={t('models.columnLatency')} value={formatLatency(row.analytics?.avgLatencyMs)} />
                        <MobileMetric label={t('strategies.scoreColumn')} value={row.score !== undefined ? row.score.toFixed(3) : '—'} />
                        <MobileMetric label={t('models.columnContext')} value={formatContextWindow(row.contextWindow)} />
                      </div>
                      <MobileMetric label={t('models.columnQuota')} className="mt-2">
                        <div className="flex items-center gap-2">
                          <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
                            <div className={`h-full rounded-full ${quota.fill}`} style={{ width: `${quotaWidth}%` }} />
                          </div>
                          <span className={`font-mono text-xs tabular-nums ${quota.className}`}>{row.quotaPressure === null ? t(quota.labelKey) : `${Math.round(row.quotaPressure)}%`}</span>
                        </div>
                      </MobileMetric>
                    </>
                  )}

                  <div className="mt-3 border-t pt-3">
                    <ModelSpecsPanel row={row} />
                  </div>
                </div>
              )}
            </article>
          )
        })}
      </div>

      <div
        className={`mt-5 hidden rounded-2xl border md:block ${virtualDesktop ? 'max-h-[35rem] overflow-auto' : 'overflow-hidden'}`}
        onScroll={event => { if (virtualDesktop) setDesktopScrollTop(event.currentTarget.scrollTop) }}
      >
        <table className="w-full table-fixed text-sm">
          <caption className="sr-only">{t('models.explorerTitle')}</caption>
          <thead>
            {tableMode === 'routing' ? (
              <tr className="border-b text-left text-xs text-muted-foreground">
                {isManual && <th className="w-20 py-2.5 pl-4 pr-2 font-medium">{t('models.columnPriority')}</th>}
                <th className="w-10 py-2.5 pl-4 pr-2 font-medium">#</th>
                {renderSortHeader('model', t('models.columnModel'), 'py-2.5 pr-3 font-medium')}
                {renderSortHeader('reliability', t('strategies.weightReliability'), 'hidden w-36 py-2.5 pr-3 font-medium md:table-cell')}
                {renderSortHeader('speed', t('strategies.weightSpeed'), 'hidden w-32 py-2.5 pr-3 font-medium md:table-cell')}
                {renderSortHeader('intelligence', t('strategies.weightIntelligence'), 'hidden w-36 py-2.5 pr-3 font-medium lg:table-cell')}
                {renderSortHeader('guardrails', t('strategies.guardrails'), 'hidden w-28 py-2.5 pr-3 font-medium xl:table-cell')}
                {renderSortHeader('score', t('strategies.scoreColumn'), 'w-20 py-2.5 pr-3 font-medium text-right', 'right')}
                {renderSortHeader('enabled', t('models.columnOn'), 'w-14 py-2.5 pr-4 font-medium text-right', 'right')}
              </tr>
            ) : (
              <tr className="border-b text-left text-xs text-muted-foreground">
                {isManual && <th className="w-20 py-2.5 pl-4 pr-2 font-medium">{t('models.columnPriority')}</th>}
                {renderSortHeader('model', t('models.columnModel'), 'py-2.5 pl-4 pr-3 font-medium')}
                {renderSortHeader('provider', t('models.columnProvider'), 'hidden w-28 py-2.5 pr-3 font-medium lg:table-cell')}
                {renderSortHeader('connected', t('models.columnConnected'), 'hidden w-24 py-2.5 pr-3 font-medium md:table-cell')}
                {renderSortHeader('context', t('models.columnContext'), 'hidden w-20 py-2.5 pr-3 font-medium xl:table-cell')}
                {renderSortHeader('capabilities', t('models.columnCapabilities'), 'hidden w-28 py-2.5 pr-3 font-medium lg:table-cell')}
                {renderSortHeader('success', t('models.columnSuccess'), 'w-24 py-2.5 pr-3 font-medium text-right', 'right')}
                {renderSortHeader('latency', t('models.columnLatency'), 'hidden w-20 py-2.5 pr-3 font-medium text-right sm:table-cell', 'right')}
                {renderSortHeader('quota', t('models.columnQuota'), 'w-28 py-2.5 pr-3 font-medium')}
                {renderSortHeader('score', t('strategies.scoreColumn'), 'hidden w-20 py-2.5 pr-3 font-medium text-right md:table-cell', 'right')}
                {renderSortHeader('enabled', t('models.columnOn'), 'w-14 py-2.5 pr-4 font-medium text-right', 'right')}
              </tr>
            )}
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={tableColSpan} className="px-4 py-10 text-center text-sm text-muted-foreground">{t('models.noExplorerMatches')}</td>
              </tr>
            ) : (
              <>
                {desktopTopSpacer > 0 && (
                  <tr aria-hidden="true">
                    <td colSpan={tableColSpan} style={{ height: desktopTopSpacer, padding: 0 }} />
                  </tr>
                )}
                {desktopRows.map((row, index) => {
              const connected = row.keyCount > 0
              const quota = quotaTone(row.quotaPressure)
              const quotaWidth = row.quotaPressure === null ? 0 : Math.min(100, row.quotaPressure)
              const expanded = selectedModelId === row.modelDbId
              const guard = guardValue(row)
              const displayIndex = desktopStartIndex + index
              return (
                <Fragment key={row.modelDbId}>
                <tr
                  id={`model-row-${row.modelDbId}`}
                  onClick={() => onSelectModel(expanded ? null : row.modelDbId)}
                  className={`cursor-pointer border-b transition-colors hover:bg-muted/35 ${expanded ? 'bg-muted/25' : ''} ${row.enabled ? '' : 'opacity-60'}`}
                >
                  {isManual && renderMoveControls(row)}
                  {tableMode === 'routing' ? (
                    <>
                      <td className="py-3 pl-4 pr-2 align-middle text-center font-mono text-xs text-muted-foreground tabular-nums">{displayIndex + 1}</td>
                      <td className="min-w-0 py-3 pr-3 align-middle">
                        <div className="min-w-0">
                          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                            <span className="truncate font-medium leading-tight">{row.displayName}</span>
                            <ProviderPill platform={row.platform} />
                            <CapabilityPills supportsVision={row.supportsVision} supportsTools={row.supportsTools} />
                          </div>
                          <p className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground/75">{modelRouteSummary(row) || row.modelId}</p>
                          <div className="mt-2 grid gap-1 md:hidden">
                            <RoutingBar value={row.reliability} color="#22c55e" />
                            <RoutingBar value={row.speed} color="#3b82f6" />
                            <RoutingBar value={row.intelligence} color="#a855f7" />
                          </div>
                        </div>
                      </td>
                      <td className="hidden py-3 pr-3 align-middle md:table-cell"><RoutingBar value={row.reliability} color="#22c55e" /></td>
                      <td className="hidden py-3 pr-3 align-middle md:table-cell"><RoutingBar value={row.speed} color="#3b82f6" /></td>
                      <td className="hidden py-3 pr-3 align-middle lg:table-cell"><RoutingBar value={row.intelligence} color="#a855f7" /></td>
                      <td className="hidden py-3 pr-3 align-middle font-mono text-xs text-muted-foreground tabular-nums xl:table-cell">{guard < 0.999 ? `×${guard.toFixed(2)}` : '—'}</td>
                      <td className="py-3 pr-3 align-middle text-right font-mono text-xs font-medium tabular-nums">{row.score !== undefined ? row.score.toFixed(3) : '—'}</td>
                      <td className="py-3 pr-4 align-middle text-right" onClick={event => event.stopPropagation()}>
                        <Switch checked={row.enabled} onCheckedChange={checked => onToggle(row.modelDbId, checked)} />
                      </td>
                    </>
                  ) : (
                    <>
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
                      <td className="py-3 pr-4 align-middle text-right" onClick={event => event.stopPropagation()}>
                        <Switch checked={row.enabled} onCheckedChange={checked => onToggle(row.modelDbId, checked)} />
                      </td>
                    </>
                  )}
                </tr>
                {expanded && (
                  <tr className="border-b bg-card">
                    <td colSpan={tableColSpan} className="px-3 py-3">
                      <ModelSpecsPanel row={row} />
                    </td>
                  </tr>
                )}
                </Fragment>
              )
            })}
                {desktopBottomSpacer > 0 && (
                  <tr aria-hidden="true">
                    <td colSpan={tableColSpan} style={{ height: desktopBottomSpacer, padding: 0 }} />
                  </tr>
                )}
              </>
            )}
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
  const [selectedModelId, setSelectedModelId] = useState<number | null>(null)

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
    refetchInterval: 15_000,
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
  const activeStrategyMeta = STRATEGIES.find(s => s.key === strategy) ?? STRATEGIES[1]
  const routePreviewRows = [...allRows]
    .filter(row => row.enabled && row.keyCount > 0)
    .sort((a, b) => isManual
      ? a.priority - b.priority
      : (b.score ?? -1) - (a.score ?? -1) || a.priority - b.priority)
    .slice(0, 2)

  function handleToggle(modelDbId: number, enabled: boolean) {
    setLocalEntries(allEntries.map(e => (e.modelDbId === modelDbId ? { ...e, enabled } : e)))
  }

  function handleMove(modelDbId: number, direction: -1 | 1) {
    const ordered = allEntries.filter(e => e.keyCount > 0).sort((a, b) => a.priority - b.priority)
    const index = ordered.findIndex(e => e.modelDbId === modelDbId)
    const target = index + direction
    if (index < 0 || target < 0 || target >= ordered.length) return
    const current = ordered[index]
    ordered[index] = ordered[target]
    ordered[target] = current
    const unconfigured = allEntries.filter(e => e.keyCount === 0).sort((a, b) => a.priority - b.priority)
    setLocalEntries([...ordered, ...unconfigured].map((entry, i) => ({ ...entry, priority: i + 1 })))
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
        {tokenUsage && tokenUsage.totalBudget > 0 && <TokenUsageBar data={tokenUsage} onOpenModel={setSelectedModelId} />}

        {/* Strategy selector */}
        <section className="overflow-hidden rounded-3xl border bg-card">
          <div className="grid items-stretch gap-4 p-4 sm:p-5 lg:grid-cols-[minmax(0,1fr)_300px] xl:grid-cols-[minmax(0,1fr)_320px]">
            <div className="min-w-0 space-y-3">
              <div className="min-w-0">
                <h2 className="text-sm font-medium">{t('strategies.title')}</h2>
                <p className="mt-1 max-w-2xl text-xs leading-relaxed text-muted-foreground">
                  {t(`strategies.${activeStrategyMeta.tKey}Blurb`)}
                </p>
              </div>

              <div className="rounded-2xl border bg-background/45 p-1.5">
                <div className="grid grid-cols-2 gap-1 sm:grid-cols-3 xl:grid-cols-[repeat(6,minmax(0,1fr))_minmax(10.25rem,1.2fr)]">
                  {STRATEGIES.map(s => (
                    <button
                      key={s.key}
                      disabled={strategyMutation.isPending}
                      onClick={() => strategyMutation.mutate({ strategy: s.key })}
                      className={`h-9 min-w-0 rounded-xl px-3 text-center text-xs transition-colors sm:whitespace-nowrap ${
                        s.key === strategy
                          ? 'bg-foreground text-background font-medium shadow-sm'
                          : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                      }`}
                    >
                      {t(`strategies.${s.tKey}`)}
                    </button>
                  ))}
                  {routing && (
                    <div className={strategy === 'custom' ? 'col-span-2 flex sm:col-span-3 xl:col-span-1' : 'hidden xl:flex'}>
                      <CustomWeightsPopover
                        saved={routing.customWeights}
                        saving={strategyMutation.isPending}
                        label={t('strategies.tuneWeights')}
                        className="h-9 w-full justify-center border border-border bg-card text-foreground hover:bg-muted sm:whitespace-nowrap"
                        onSave={w => strategyMutation.mutate({ strategy: 'custom', weights: w })}
                      />
                    </div>
                  )}
                </div>
              </div>

              <WeightDistribution weights={routing?.weights ?? null} />
            </div>

            <RoutePreview rows={routePreviewRows} isManual={isManual} />
          </div>
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
            <ModelExplorer
              rows={allRows}
              analytics={analytics}
              usageLimits={usageLimits}
              isManual={isManual}
              selectedModelId={selectedModelId}
              onSelectModel={setSelectedModelId}
              onToggle={handleToggle}
              onMove={handleMove}
            />

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
