import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line, Legend,
} from 'recharts'
import { Activity, ArrowDownToLine, ArrowUpFromLine, CircleCheck, Database, PiggyBank, Trash2, X } from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { RangeControl } from '@/components/range-control'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogClose, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { PageHeader } from '@/components/page-header'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip as HoverTooltip } from '@/components/tooltip'
import { formatSqliteUtcToLocalTime, visiblePolling } from '@/lib/utils'
import { platformColors } from '@/lib/routing'
import { useI18n } from '@/i18n'

type TimeRange = '12h' | '6h' | '3h' | '1h' | '30m' | '10m' | '24h' | '7d' | '30d' | '90d' | 'all'

const TIME_RANGES: TimeRange[] = ['24h', '7d', '30d', '90d', 'all']
const SUB_DAY_RANGES: TimeRange[] = ['12h', '6h', '3h', '1h', '30m', '10m']

const RANGE_SHORT_KEYS: Record<TimeRange, string> = {
  '24h': 'analytics.range24h',
  '7d': 'analytics.range7d',
  '30d': 'analytics.range30d',
  '90d': 'analytics.range90d',
  'all': 'analytics.rangeAll',
  '12h': 'analytics.range12h',
  '6h': 'analytics.range6h',
  '3h': 'analytics.range3h',
  '1h': 'analytics.range1h',
  '30m': 'analytics.range30m',
  '10m': 'analytics.range10m',
}

const RANGE_LABEL_KEYS: Record<TimeRange, string> = {
  '24h': 'analytics.rangeLabel24h',
  '7d': 'analytics.rangeLabel7d',
  '30d': 'analytics.rangeLabel30d',
  '90d': 'analytics.rangeLabel90d',
  'all': 'analytics.rangeLabelAll',
  '12h': 'analytics.rangeLabel12h',
  '6h': 'analytics.rangeLabel6h',
  '3h': 'analytics.rangeLabel3h',
  '1h': 'analytics.rangeLabel1h',
  '30m': 'analytics.rangeLabel30m',
  '10m': 'analytics.rangeLabel10m',
}

// The range toggle sticks: whichever window you last looked at is the one the
// tab opens with next time, instead of always snapping back to 7d (#711).
const RANGE_KEY = 'analytics.range'

const ANALYTICS_REFETCH_INTERVAL_MS = 5_000

function storedRange(): TimeRange {
  try {
    const v = localStorage.getItem(RANGE_KEY)
    if (v && ((TIME_RANGES as string[]).includes(v) || (SUB_DAY_RANGES as string[]).includes(v))) return v as TimeRange
  } catch { /* ignore */ }
  return '7d'
}

// Response shapes mirror the JSON emitted by server/src/routes/analytics.ts.
// Latency percentiles and TTFT are null when the raw window is empty (pruned).
interface SummaryResponse {
  totalRequests: number
  successRate: number
  totalInputTokens: number
  totalOutputTokens: number
  totalCachedTokens: number
  avgLatencyMs: number
  p50LatencyMs: number | null
  p95LatencyMs: number | null
  avgTtfbMs: number | null
  requestTypeCounts: { chat: number; embedding: number }
  estimatedCostSavings: number
  pinnedRequests: number
  pinHonoredRequests: number
  firstRequestAt: string | null
  lifetimeTotalRequests: number
}

interface ByPlatformRow {
  platform: string
  requests: number
  successRate: number
  avgLatencyMs: number
  p95LatencyMs: number | null
  avgTtfbMs: number | null
  errorCount: number
  avgTokensPerSecond: number | null
  totalInputTokens: number
  totalOutputTokens: number
}

interface ByClientRow {
  clientAgent: string
  requests: number
  successRate: number
  avgLatencyMs: number
  totalInputTokens: number
  totalOutputTokens: number
  lastSeenAt: string | null
}

interface TimelineBucket {
  timestamp: string
  requests: number
  successCount: number
  failureCount: number
  inputTokens: number
  outputTokens: number
}

interface ByModelRow {
  platform: string
  modelId: string
  displayName: string
  requests: number
  successRate: number
  avgLatencyMs: number
  totalInputTokens: number
  totalOutputTokens: number
  pinnedRequests: number
  estimatedCost: number
}

interface ByKeyRow {
  keyId: number
  label: string | null
  platform: string | null
  requests: number
  successRate: number
  avgLatencyMs: number
  totalInputTokens: number
  totalOutputTokens: number
}

interface ErrorDistribution {
  byCategory: Array<{ category: string; count: number }>
  byPlatform: Array<{ platform: string; count: number }>
  detailed: Array<{ platform: string; model_id: string; error_category: string; count: number }>
}

interface RecentErrorRow {
  id: number
  platform: string
  modelId: string
  error: string
  latencyMs: number
  createdAt: string
}

interface RecentCallRow {
  id: number
  platform: string
  modelId: string
  requestedModel: string | null
  requestType: string
  status: string
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  latencyMs: number
  error: string | null
  keyId: number | null
  keyLabel: string | null
  clientIp: string | null
  clientUserAgent: string | null
  createdAt: string
}

interface RecentCallsResponse {
  total: number
  rows: RecentCallRow[]
}

// One hop of the failover ladder, from GET /api/analytics/requests/:id.
interface RequestAttempt {
  ordinal: number
  platform: string
  modelId: string
  keyOrdinal: number
  outcome: string
  startOffsetMs: number
  durationMs: number
  errorSummary: string | null
}

interface RequestDetail extends RecentCallRow {
  ttfbMs: number | null
  attempts: RequestAttempt[]
}

type StatusFilter = 'all' | 'success' | 'error'

// First product token of the UA ("python-requests/2.32.3", "curl/8.6.0", …)
// is enough to tell callers apart in a narrow cell; full string on hover.
function shortUserAgent(ua: string | null): string {
  if (!ua) return '—'
  const first = ua.split(' ')[0]
  return first.length > 32 ? first.slice(0, 32) + '…' : first
}

function keyDisplay(r: { keyId: number | null; keyLabel: string | null }, t: (key: string, vars?: Record<string, string | number>) => string): string {
  if (r.keyLabel) return r.keyLabel
  if (r.keyId != null) return t('analytics.keyLabelFallback', { id: r.keyId })
  return '—'
}

const TOKEN_UNITS: Array<[number, string]> = [
  [1e15, 'Q'],
  [1e12, 'T'],
  [1e9, 'B'],
  [1e6, 'M'],
  [1e3, 'K'],
]

function formatTokens(n?: number): string {
  if (!n) return '0'
  const unit = TOKEN_UNITS.find(([limit]) => n >= limit)
  if (!unit) return String(n)
  return `${(n / unit[0]).toFixed(1).replace(/\.0$/, '')}${unit[1]}`
}

function Stat({ label, value, hint, className, onClick, icon: Icon }: { label: string; value: string | number; hint?: string; className?: string; onClick?: () => void; icon: typeof Activity }) {
  const card = (
    <div
      className={`rounded-3xl border bg-card px-4 py-3 ${onClick ? 'cursor-pointer transition-colors hover:bg-muted/50' : ''}`}
      role={onClick ? 'button' : undefined}
      onClick={onClick}
    >
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] text-muted-foreground uppercase tracking-wider">{label}</p>
        <Icon className="size-3.5 text-muted-foreground" />
      </div>
      <p className={`text-xl font-semibold tabular-nums mt-1 ${className ?? ''}`}>{value}</p>
    </div>
  )
  // Same portal tooltip as the routing strategy chips. Opens BELOW the card:
  // the stats row sits right under the sticky navbar.
  return hint ? <HoverTooltip text={hint} side="bottom" className="block">{card}</HoverTooltip> : card
}

function Panel({ title, actions, children }: { title: string; actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="rounded-3xl border bg-card">
      <div className="px-4 py-3 border-b flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{title}</h3>
        {actions}
      </div>
      <div className="p-4">{children}</div>
    </div>
  )
}

// Platform swatch shared by the ladder and the per-provider table; same color
// source as the token-usage legend (lib/routing.ts), same gray fallback.
function PlatformDot({ platform }: { platform: string }) {
  return (
    <span
      className="size-2 rounded-full flex-shrink-0"
      style={{ backgroundColor: platformColors[platform] ?? '#94a3b8' }}
    />
  )
}

// Compact ms rendering for ladder timings: sub-second stays in ms, longer
// spans read as seconds ("38.8 s") like the issue reports do.
function formatMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)} s`
  return `${ms} ms`
}

// Key/value line of the request-detail summary grid.
function DetailField({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <p className="text-[11px] text-muted-foreground uppercase tracking-wider">{label}</p>
      <p className={`text-sm mt-0.5 break-words ${mono ? 'tabular-nums' : ''}`}>{value}</p>
    </div>
  )
}

// Per-request drill-down: the parent row's fields plus the failover ladder —
// one entry per dispatched attempt (ordinal → provider/model → key ordinal →
// outcome → timing, with the redacted per-hop error when one was recorded).
// A dialog (the app's detail-popup idiom, cf. keys/export-keys-dialog) rather
// than a routed page so the list's range/filter context stays put behind it.
function RequestDetailDialog({ requestId, onClose }: { requestId: number | null; onClose: () => void }) {
  const { t } = useI18n()

  const { data: detail, isLoading } = useQuery({
    queryKey: ['analytics', 'request-detail', requestId],
    queryFn: () => apiFetch<RequestDetail>(`/api/analytics/requests/${requestId}`),
    enabled: requestId != null,
  })

  return (
    <Dialog open={requestId != null} onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogPopup maxWidth="max-w-2xl">
        <div className="mb-4 flex items-center justify-between gap-4">
          <DialogTitle>{t('analytics.requestDetailTitle', { id: requestId ?? '' })}</DialogTitle>
          <DialogClose
            aria-label={t('common.dismiss')}
            className="-mr-1 rounded-lg p-1 text-muted-foreground/70 transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <X className="size-4" />
          </DialogClose>
        </div>

        {isLoading || !detail ? (
          <div className="space-y-3">
            <Skeleton className="h-24 rounded-xl" />
            <Skeleton className="h-32 rounded-xl" />
          </div>
        ) : (
          <div className="space-y-5">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3">
              <DetailField
                label={t('analytics.time')}
                value={formatSqliteUtcToLocalTime(detail.createdAt, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                mono
              />
              <DetailField
                label={t('common.status')}
                value={
                  <span className={detail.status === 'success' ? '' : 'text-destructive'}>{detail.status}</span>
                }
              />
              <DetailField
                label={t('common.provider')}
                value={
                  <span className="inline-flex items-center gap-1.5">
                    <PlatformDot platform={detail.platform} />
                    {detail.platform}
                  </span>
                }
              />
              <DetailField label={t('common.model')} value={detail.modelId} />
              <DetailField label={t('analytics.keyColumn')} value={keyDisplay(detail, t)} />
              {detail.requestedModel && detail.requestedModel !== detail.modelId && (
                <DetailField label={t('analytics.requestedModel')} value={detail.requestedModel} />
              )}
              <DetailField
                label={`${t('analytics.inTokens')} / ${t('analytics.outTokens')}`}
                value={`${formatTokens(detail.inputTokens)} / ${formatTokens(detail.outputTokens)}`}
                mono
              />
              <DetailField label={t('analytics.latency')} value={formatMs(detail.latencyMs ?? 0)} mono />
              <DetailField label={t('analytics.ttft')} value={detail.ttfbMs != null ? formatMs(detail.ttfbMs) : '—'} mono />
              <DetailField label={t('analytics.clientIp')} value={detail.clientIp ?? '—'} mono />
              <DetailField label={t('analytics.clientAgent')} value={detail.clientUserAgent ?? '—'} />
            </div>

            {detail.error && (
              <div className="rounded-xl border border-destructive/30 bg-destructive/5 px-3 py-2">
                <p className="text-[11px] text-destructive uppercase tracking-wider">{t('analytics.message')}</p>
                <p className="text-xs text-destructive/90 mt-1 break-words">{detail.error}</p>
              </div>
            )}

            <div>
              <h4 className="text-sm font-medium">{t('analytics.failoverLadder')}</h4>
              <p className="text-xs text-muted-foreground mt-0.5">{t('analytics.failoverLadderHint')}</p>
              {detail.attempts.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-6">{t('analytics.noAttemptTrace')}</p>
              ) : (
                <ol className="mt-3 space-y-2">
                  {detail.attempts.map((a) => (
                    <li key={a.ordinal} className="rounded-xl border px-3 py-2">
                      <div className="flex items-center gap-2 text-xs">
                        <span className="w-6 text-muted-foreground tabular-nums">#{a.ordinal + 1}</span>
                        <PlatformDot platform={a.platform} />
                        <span className="font-medium">{a.platform}</span>
                        <span className="text-muted-foreground truncate" title={a.modelId}>{a.modelId}</span>
                        <Badge variant="outline">{t('analytics.keyOrdinal', { n: a.keyOrdinal })}</Badge>
                        <Badge variant={a.outcome === 'ok' || a.outcome === 'committed' ? 'secondary' : 'destructive'}>
                          {a.outcome}
                        </Badge>
                        <span
                          className="ml-auto whitespace-nowrap text-muted-foreground tabular-nums"
                          title={t('analytics.attemptTimingHint')}
                        >
                          +{formatMs(a.startOffsetMs)} · {formatMs(a.durationMs)}
                        </span>
                      </div>
                      {a.errorSummary && (
                        <p className="mt-1 pl-8 text-xs text-destructive/90 break-words">{a.errorSummary}</p>
                      )}
                    </li>
                  ))}
                </ol>
              )}
            </div>
          </div>
        )}
      </DialogPopup>
    </Dialog>
  )
}

const axisStyle = { fontSize: 11, fill: 'var(--muted-foreground)' } as const
const gridStyle = 'var(--border)'
const primaryFill = 'var(--foreground)'
const tooltipStyle = { backgroundColor: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 } as const

// Two categorical series hues, validated against the app's actual chart
// surfaces (light card #ffffff, dark card #101010) with the dataviz palette
// checker. Slot A (blue) = the "average / input" series; slot B (aqua) = the
// "p95 / output" series. The app's own --chart-* tokens are all grayscale
// (zero chroma), which fails the CVD separation check for a two-series chart,
// so we take the nearest passing categorical hues and theme them here.
const seriesA = 'var(--series-a)'
const seriesB = 'var(--series-b)'
const chartVars = `
.analytics-viz { --series-a: #2a78d6; --series-b: #1baf7a; }
.dark .analytics-viz { --series-a: #3987e5; --series-b: #199e70; }
`

export default function AnalyticsPage() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [range, setRange] = useState<TimeRange>(storedRange)
  const updateRange = (r: TimeRange) => {
    setRange(r)
    try { localStorage.setItem(RANGE_KEY, r) } catch { /* ignore */ }
  }
  // Capture "now" once at mount so the savings extrapolation below stays a pure
  // render (calling Date.now() during render is impure and non-deterministic).
  const [now] = useState(() => Date.now())

  const { data: summary, isLoading: summaryLoading } = useQuery({
    queryKey: ['analytics', 'summary', range],
    queryFn: () => apiFetch<SummaryResponse>(`/api/analytics/summary?range=${range}`),
    refetchInterval: visiblePolling(ANALYTICS_REFETCH_INTERVAL_MS),
  })

  const { data: byPlatform = [] } = useQuery({
    queryKey: ['analytics', 'by-platform', range],
    queryFn: () => apiFetch<ByPlatformRow[]>(`/api/analytics/by-platform?range=${range}`),
    refetchInterval: visiblePolling(ANALYTICS_REFETCH_INTERVAL_MS),
  })

  const { data: byClient = [] } = useQuery({
    queryKey: ['analytics', 'by-client', range],
    queryFn: () => apiFetch<ByClientRow[]>(`/api/analytics/by-client?range=${range}`),
    refetchInterval: visiblePolling(ANALYTICS_REFETCH_INTERVAL_MS),
  })

  const { data: timeline = [] } = useQuery({
    queryKey: ['analytics', 'timeline', range],
    queryFn: () => apiFetch<TimelineBucket[]>(`/api/analytics/timeline?range=${range}`),
    refetchInterval: visiblePolling(ANALYTICS_REFETCH_INTERVAL_MS),
  })

  const { data: byModel = [] } = useQuery({
    queryKey: ['analytics', 'by-model', range],
    queryFn: () => apiFetch<ByModelRow[]>(`/api/analytics/by-model?range=${range}`),
    refetchInterval: visiblePolling(ANALYTICS_REFETCH_INTERVAL_MS),
  })

  const { data: byKey = [] } = useQuery({
    queryKey: ['analytics', 'by-key', range],
    queryFn: () => apiFetch<ByKeyRow[]>(`/api/analytics/by-key?range=${range}`),
    refetchInterval: visiblePolling(ANALYTICS_REFETCH_INTERVAL_MS),
  })

  const { data: errors = [] } = useQuery({
    queryKey: ['analytics', 'errors', range],
    queryFn: () => apiFetch<RecentErrorRow[]>(`/api/analytics/errors?range=${range}`),
    refetchInterval: visiblePolling(ANALYTICS_REFETCH_INTERVAL_MS),
  })

  const { data: errorDist } = useQuery({
    queryKey: ['analytics', 'error-distribution', range],
    queryFn: () => apiFetch<ErrorDistribution>(`/api/analytics/error-distribution?range=${range}`),
    refetchInterval: visiblePolling(ANALYTICS_REFETCH_INTERVAL_MS),
  })

  const clearErrorsMutation = useMutation({
    mutationFn: () => apiFetch<{ cleared: number }>('/api/analytics/errors/clear', {
      method: 'POST',
      body: JSON.stringify({ range }),
    }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['analytics'] }),
  })

  // Recent-calls list filters (status/platform) + the row opened in the
  // drill-down dialog. Filters ride the query key so react-query refetches
  // (and caches) each combination on its own.
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')
  const [platformFilter, setPlatformFilter] = useState<string>('all')
  const [detailId, setDetailId] = useState<number | null>(null)

  const { data: recentCalls } = useQuery({
    queryKey: ['analytics', 'requests', range, statusFilter, platformFilter],
    queryFn: () => {
      const params = new URLSearchParams({ range, limit: '100' })
      if (statusFilter !== 'all') params.set('status', statusFilter)
      if (platformFilter !== 'all') params.set('platform', platformFilter)
      return apiFetch<RecentCallsResponse>(`/api/analytics/requests?${params}`)
    },
    refetchInterval: visiblePolling(ANALYTICS_REFETCH_INTERVAL_MS),
  })

  // Savings card shows ONE stable monthly figure regardless of the selected
  // range: the last-30-days data projected to a full month from its actual
  // span (a young install with 2 days of data shows 15x its 2-day total).
  // Once 30 days of history exist the real total shows as-is. The hover
  // hint carries the selected period's actual amount and the projection
  // basis. Querying 30d separately is free: react-query shares the cache
  // with the 30d tab.
  const { data: summary30 } = useQuery({
    queryKey: ['analytics', 'summary', '30d'],
    queryFn: () => apiFetch<SummaryResponse>(`/api/analytics/summary?range=30d`),
    refetchInterval: visiblePolling(ANALYTICS_REFETCH_INTERVAL_MS),
  })
  const actualSavings = summary?.estimatedCostSavings ?? 0
  const baseSavings = summary30?.estimatedCostSavings ?? 0
  const spanDays = (() => {
    if (!summary30?.firstRequestAt) return 30
    // SQLite stores UTC "YYYY-MM-DD HH:MM:SS"
    const first = new Date(summary30.firstRequestAt.replace(' ', 'T') + 'Z').getTime()
    const days = (now - first) / 86_400_000
    if (!Number.isFinite(days)) return 30
    return Math.min(Math.max(days, 1 / 24), 30)
  })()
  const extrapolated = spanDays < 29.5
  const savings30d = extrapolated ? baseSavings * (30 / spanDays) : baseSavings
  const rangeLabel = t(RANGE_LABEL_KEYS[range])
  const spanLabel = spanDays >= 2 ? t('analytics.spanDays', { count: Math.round(spanDays) }) : t('analytics.spanHours', { count: Math.max(1, Math.round(spanDays * 24)) })
  // One block, two metrics: the ACTUAL amount saved in the selected period
  // (default) or the 30-day projection. Click toggles which one shows.
  const [savingsMode, setSavingsMode] = useState<'actual' | 'estimated'>('actual')
  const savingsValue = savingsMode === 'actual' ? actualSavings : savings30d
  const savingsLabel = t(savingsMode === 'actual' ? 'analytics.savings' : 'analytics.estSavings')
  const savingsHint = (savingsMode === 'actual'
    ? t('analytics.savingsActualHint', { actual: actualSavings.toFixed(2), range: rangeLabel })
    : extrapolated
      ? t('analytics.savingsHint', { actual: actualSavings.toFixed(2), range: rangeLabel, span: spanLabel })
      : t('analytics.savingsHintExact', { actual: actualSavings.toFixed(2), range: rangeLabel }))
    + ' ' + t('analytics.savingsClickHint')

  // Pinned = the client named a specific model instead of auto-routing.
  // Honored = that model actually served it (the rest failed over).
  const pinned = summary?.pinnedRequests ?? 0
  const pinHonored = summary?.pinHonoredRequests ?? 0
  const chatCount = summary?.requestTypeCounts?.chat ?? 0
  const embeddingCount = summary?.requestTypeCounts?.embedding ?? 0
  const requestsHint = (pinned > 0
    ? t('analytics.requestsHintPinned', { pinned, honored: pinHonored, failed: pinned - pinHonored })
    : t('analytics.requestsHintAuto'))
    + ' ' + t('analytics.requestsHintTypes', { chat: chatCount, embedding: embeddingCount })

  // TTFT-by-provider is empty when no provider recorded a streaming first
  // token; render a muted line instead of an axis-only empty chart.
  const ttftHasData = byPlatform.some((p) => (p.avgTtfbMs ?? 0) > 0)

  return (
    <div className="analytics-viz">
      <style>{chartVars}</style>
      <PageHeader
        title={t('analytics.title')}
        description={t('analytics.description')}
        actions={
          <RangeControl
            value={range}
            onValueChange={updateRange}
            options={TIME_RANGES.map(r => ({ value: r, label: t(RANGE_SHORT_KEYS[r]) }))}
            activeOptions={SUB_DAY_RANGES}
            activeOptionLabel={(r) => t(RANGE_SHORT_KEYS[r])}
            ariaLabel={t('analytics.title')}
          />
        }
      />

      <div className="space-y-6">
        {/* Summary stats */}
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
          {summaryLoading ? (
            Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-[74px] rounded-3xl" />)
          ) : (
            <>
              <Stat label={t('analytics.requests')} value={summary?.totalRequests ?? 0} hint={requestsHint} icon={Activity} />
              <Stat label={t('analytics.successRate')} value={`${summary?.successRate ?? 0}%`} icon={CircleCheck} />
              <Stat label={t('analytics.inputTokens')} value={formatTokens(summary?.totalInputTokens)} icon={ArrowDownToLine} />
              <Stat label={t('analytics.outputTokens')} value={formatTokens(summary?.totalOutputTokens)} icon={ArrowUpFromLine} />
              <Stat label={t('analytics.cachedTokensStat')} value={formatTokens(summary?.totalCachedTokens)} icon={Database} />
              <Stat
                label={savingsLabel}
                value={`$${savingsValue.toFixed(2)}`}
                hint={savingsHint}
                icon={PiggyBank}
                onClick={() => setSavingsMode(mode => (mode === 'actual' ? 'estimated' : 'actual'))}
              />
            </>
          )}
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <div className="lg:col-span-2">
            <Panel title={t('analytics.requestsOverTime')}>
              {timeline.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">{t('common.noData')}</p>
              ) : (
                <ResponsiveContainer width="100%" height={240}>
                  <LineChart data={timeline} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                    <XAxis dataKey="timestamp" tick={axisStyle} tickLine={false} axisLine={{ stroke: gridStyle }} />
                    <YAxis tick={axisStyle} tickLine={false} axisLine={false} />
                    <Tooltip contentStyle={tooltipStyle} />
                    <Legend wrapperStyle={{ fontSize: 12 }} iconType="line" />
                    <Line type="monotone" dataKey="successCount" name={t('common.success')} stroke={primaryFill} strokeWidth={1.5} dot={false} isAnimationActive={false} />
                    <Line type="monotone" dataKey="failureCount" name={t('common.failures')} stroke="var(--destructive)" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </Panel>
          </div>

          {/* Tokens over time: input vs output, one axis, two-series legend. */}
          <div className="lg:col-span-2">
            <Panel title={t('analytics.tokensOverTime')}>
              {timeline.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">{t('common.noData')}</p>
              ) : (
                <ResponsiveContainer width="100%" height={240}>
                  <LineChart data={timeline} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                    <XAxis dataKey="timestamp" tick={axisStyle} tickLine={false} axisLine={{ stroke: gridStyle }} />
                    <YAxis tick={axisStyle} tickLine={false} axisLine={false} tickFormatter={(v: number) => formatTokens(v)} />
                    <Tooltip contentStyle={tooltipStyle} formatter={(value) => formatTokens(Number(value))} />
                    <Legend wrapperStyle={{ fontSize: 12 }} iconType="line" />
                    <Line type="monotone" dataKey="inputTokens" name={t('analytics.inputTokens')} stroke={seriesA} strokeWidth={2} dot={false} isAnimationActive={false} />
                    <Line type="monotone" dataKey="outputTokens" name={t('analytics.outputTokens')} stroke={seriesB} strokeWidth={2} dot={false} isAnimationActive={false} />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </Panel>
          </div>

          <Panel title={t('analytics.requestsByProvider')}>
            {byPlatform.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">{t('common.noData')}</p>
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={byPlatform} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                  <XAxis dataKey="platform" tick={axisStyle} tickLine={false} axisLine={{ stroke: gridStyle }} />
                  <YAxis tick={axisStyle} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Bar dataKey="requests" name={t('analytics.requests')} fill={primaryFill} radius={[3, 3, 0, 0]} maxBarSize={24} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Panel>

          <Panel title={t('analytics.requestsByAgent')}>
            {byClient.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">{t('common.noData')}</p>
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={byClient} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                  <XAxis dataKey="clientAgent" tick={axisStyle} tickLine={false} axisLine={{ stroke: gridStyle }} />
                  <YAxis tick={axisStyle} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Bar dataKey="requests" name={t('analytics.requests')} fill={seriesB} radius={[3, 3, 0, 0]} maxBarSize={24} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Panel>

          {/* Latency by provider: grouped avg + p95, same unit (ms), one axis. */}
          <Panel title={t('analytics.avgLatencyByProvider')}>
            {byPlatform.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">{t('common.noData')}</p>
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={byPlatform} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                  <XAxis dataKey="platform" tick={axisStyle} tickLine={false} axisLine={{ stroke: gridStyle }} />
                  <YAxis unit="ms" tick={axisStyle} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Legend wrapperStyle={{ fontSize: 12 }} iconType="rect" />
                  <Bar dataKey="avgLatencyMs" name={t('analytics.avgLatency')} fill={seriesA} radius={[3, 3, 0, 0]} maxBarSize={24} isAnimationActive={false} />
                  <Bar dataKey="p95LatencyMs" name={t('analytics.p95Latency')} fill={seriesB} radius={[3, 3, 0, 0]} maxBarSize={24} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Panel>

          {/* Time to first token by provider (single series → no legend). */}
          <Panel title={t('analytics.ttftByProvider')}>
            {byPlatform.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">{t('common.noData')}</p>
            ) : !ttftHasData ? (
              <p className="text-sm text-muted-foreground text-center py-8">{t('analytics.ttftEmpty')}</p>
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={byPlatform} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                  <XAxis dataKey="platform" tick={axisStyle} tickLine={false} axisLine={{ stroke: gridStyle }} />
                  <YAxis unit="ms" tick={axisStyle} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Bar dataKey="avgTtfbMs" name={t('analytics.avgTtft')} fill={seriesA} radius={[3, 3, 0, 0]} maxBarSize={24} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Panel>

          {/* Recent calls: one line per proxied request with the caller's IP +
              user agent. All local clients share the unified key, so this is
              the only view that answers "who is hitting the router". Rows open
              the failover-ladder drill-down; the header hosts status/provider
              filters (server-side, so total reflects the filtered set). */}
          <div className="lg:col-span-2">
            <Panel
              title={t('analytics.recentCalls')}
              actions={
                <div className="flex flex-wrap items-center gap-2">
                  <SegmentedControl
                    value={statusFilter}
                    onValueChange={setStatusFilter}
                    options={[
                      { value: 'all', label: t('analytics.filterAll') },
                      { value: 'success', label: t('common.success') },
                      { value: 'error', label: t('analytics.errors') },
                    ]}
                    ariaLabel={t('common.status')}
                  />
                  <Select value={platformFilter} onValueChange={(v) => setPlatformFilter(v ?? 'all')}>
                    <SelectTrigger size="sm" aria-label={t('common.provider')}>
                      <SelectValue>
                        {(v: string) => (!v || v === 'all' ? t('analytics.allProviders') : v)}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="all">{t('analytics.allProviders')}</SelectItem>
                      {byPlatform.map((p) => (
                        <SelectItem key={p.platform} value={p.platform}>
                          <span className="flex items-center gap-2">
                            <PlatformDot platform={p.platform} />
                            <span>{p.platform}</span>
                          </span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              }
            >
              {!recentCalls?.rows?.length ? (
                <p className="text-sm text-muted-foreground text-center py-8">{t('common.noData')}</p>
              ) : (
                <div className="max-h-[420px] overflow-y-auto -mx-4">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="pl-4">{t('analytics.time')}</TableHead>
                        <TableHead>{t('analytics.clientIp')}</TableHead>
                        <TableHead>{t('analytics.clientAgent')}</TableHead>
                        <TableHead>{t('common.model')}</TableHead>
                        <TableHead>{t('analytics.keyColumn')}</TableHead>
                        <TableHead>{t('common.provider')}</TableHead>
                        <TableHead>{t('common.status')}</TableHead>
                        <TableHead className="text-right">{t('analytics.inTokens')}</TableHead>
                        <TableHead className="text-right">{t('analytics.outTokens')}</TableHead>
                        <TableHead className="text-right">{t('analytics.cachedTokens')}</TableHead>
                        <TableHead className="text-right pr-4">{t('analytics.latency')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {recentCalls.rows.map((r) => (
                        <TableRow
                          key={r.id}
                          onClick={() => setDetailId(r.id)}
                          className="cursor-pointer"
                        >
                          <TableCell className="pl-4 text-xs text-muted-foreground tabular-nums whitespace-nowrap">
                            {formatSqliteUtcToLocalTime(r.createdAt, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                          </TableCell>
                          <TableCell className="text-xs font-medium tabular-nums">{r.clientIp ?? '—'}</TableCell>
                          <TableCell className="text-xs text-muted-foreground" title={r.clientUserAgent ?? undefined}>
                            {shortUserAgent(r.clientUserAgent)}
                          </TableCell>
                          <TableCell className="text-xs max-w-[220px] truncate" title={r.requestedModel && r.requestedModel !== r.modelId ? t('analytics.requestedModelHint', { model: r.requestedModel }) : undefined}>
                            {r.modelId}
                            {r.requestedModel && r.requestedModel !== r.modelId ? ' *' : ''}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground max-w-[160px] truncate" title={r.keyLabel ?? undefined}>
                            {keyDisplay(r, t)}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">{r.platform}</TableCell>
                          <TableCell className={`text-xs ${r.status === 'success' ? 'text-success' : 'text-destructive'}`} title={r.error ?? undefined}>
                            {r.status}
                          </TableCell>
                          <TableCell className="text-right text-xs tabular-nums">{formatTokens(r.inputTokens)}</TableCell>
                          <TableCell className="text-right text-xs tabular-nums">{formatTokens(r.outputTokens)}</TableCell>
                          <TableCell className="text-right text-xs tabular-nums">{formatTokens(r.cachedTokens)}</TableCell>
                          <TableCell className="text-right text-xs tabular-nums pr-4">{r.latencyMs} ms</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </Panel>
          </div>

          {/* Per-provider breakdown: the tabular face of the by-platform data —
              the charts above show volume/latency, this row surfaces the
              success-rate and error-count numbers (#335). */}
          <div className="lg:col-span-2">
            <Panel title={t('analytics.providerBreakdown')}>
              {byPlatform.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">{t('common.noData')}</p>
              ) : (
                <div className="max-h-[360px] overflow-y-auto -mx-4">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="pl-4">{t('common.provider')}</TableHead>
                        <TableHead className="text-right">{t('analytics.requests')}</TableHead>
                        <TableHead className="text-right">{t('common.success')}</TableHead>
                        <TableHead className="text-right">{t('analytics.errors')}</TableHead>
                        <TableHead className="text-right">{t('analytics.avgLatency')}</TableHead>
                        <TableHead className="text-right">{t('analytics.p95Latency')}</TableHead>
                        <TableHead className="text-right">{t('analytics.avgTtft')}</TableHead>
                        <TableHead className="text-right">{t('analytics.tokensPerSec')}</TableHead>
                        <TableHead className="text-right">{t('analytics.inTokens')}</TableHead>
                        <TableHead className="text-right pr-4">{t('analytics.outTokens')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {byPlatform.map((p) => (
                        <TableRow key={p.platform}>
                          <TableCell className="pl-4 text-sm font-medium">
                            <span className="flex items-center gap-2">
                              <PlatformDot platform={p.platform} />
                              {p.platform}
                            </span>
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{p.requests}</TableCell>
                          <TableCell className="text-right tabular-nums">{p.successRate}%</TableCell>
                          <TableCell className={`text-right tabular-nums ${p.errorCount > 0 ? 'text-destructive' : ''}`}>
                            {p.errorCount > 0 ? p.errorCount : '—'}
                          </TableCell>
                          <TableCell className="text-right tabular-nums">{p.avgLatencyMs} ms</TableCell>
                          <TableCell className="text-right tabular-nums">{p.p95LatencyMs != null ? `${p.p95LatencyMs} ms` : '—'}</TableCell>
                          <TableCell className="text-right tabular-nums">{p.avgTtfbMs != null ? `${p.avgTtfbMs} ms` : '—'}</TableCell>
                          <TableCell className="text-right tabular-nums">{p.avgTokensPerSecond != null ? p.avgTokensPerSecond : '—'}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatTokens(p.totalInputTokens)}</TableCell>
                          <TableCell className="text-right tabular-nums pr-4">{formatTokens(p.totalOutputTokens)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </Panel>
          </div>

          <div className="lg:col-span-2">
            <Panel title={t('analytics.perModelBreakdown')}>
              {byModel.length === 0 ? (
                <p className="text-sm text-muted-foreground text-center py-8">{t('common.noData')}</p>
              ) : (
                <div className="max-h-[360px] overflow-y-auto -mx-4">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="pl-4">{t('common.model')}</TableHead>
                        <TableHead>{t('common.provider')}</TableHead>
                        <TableHead className="text-right">{t('analytics.requests')}</TableHead>
                        <TableHead className="text-right">{t('analytics.pinned')}</TableHead>
                        <TableHead className="text-right">{t('common.success')}</TableHead>
                        <TableHead className="text-right">{t('analytics.latency')}</TableHead>
                        <TableHead className="text-right">{t('analytics.inTokens')}</TableHead>
                        <TableHead className="text-right">{t('analytics.outTokens')}</TableHead>
                        <TableHead className="text-right pr-4">{t('analytics.saved')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {byModel.map((m, i) => (
                        <TableRow key={i}>
                          <TableCell className="pl-4 text-sm font-medium">{m.displayName}</TableCell>
                          <TableCell className="text-xs text-muted-foreground">{m.platform}</TableCell>
                          <TableCell className="text-right tabular-nums">{m.requests}</TableCell>
                          <TableCell className="text-right tabular-nums">{m.pinnedRequests > 0 ? m.pinnedRequests : '—'}</TableCell>
                          <TableCell className="text-right tabular-nums">{m.successRate}%</TableCell>
                          <TableCell className="text-right tabular-nums">{m.avgLatencyMs} ms</TableCell>
                          <TableCell className="text-right tabular-nums">{formatTokens(m.totalInputTokens)}</TableCell>
                          <TableCell className="text-right tabular-nums">{formatTokens(m.totalOutputTokens)}</TableCell>
                          <TableCell className="text-right tabular-nums pr-4">${(m.estimatedCost ?? 0).toFixed(2)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </Panel>
          </div>

          {/* Usage by key: only rendered when the endpoint returns rows. */}
          {byKey.length > 0 && (
            <div className="lg:col-span-2">
              <Panel title={t('analytics.usageByKey')}>
                <div className="max-h-[360px] overflow-y-auto -mx-4">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="pl-4">{t('analytics.keyColumn')}</TableHead>
                        <TableHead>{t('common.provider')}</TableHead>
                        <TableHead className="text-right">{t('analytics.requests')}</TableHead>
                        <TableHead className="text-right">{t('common.success')}</TableHead>
                        <TableHead className="text-right">{t('analytics.latency')}</TableHead>
                        <TableHead className="text-right">{t('analytics.inTokens')}</TableHead>
                        <TableHead className="text-right pr-4">{t('analytics.outTokens')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {byKey.map((k) => (
                        <TableRow key={k.keyId}>
                          <TableCell className="pl-4 text-sm font-medium">
                            {k.label || t('analytics.keyLabelFallback', { id: k.keyId })}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">{k.platform ?? '—'}</TableCell>
                          <TableCell className="text-right tabular-nums">{k.requests}</TableCell>
                          <TableCell className="text-right tabular-nums">{k.successRate}%</TableCell>
                          <TableCell className="text-right tabular-nums">{k.avgLatencyMs} ms</TableCell>
                          <TableCell className="text-right tabular-nums">{formatTokens(k.totalInputTokens)}</TableCell>
                          <TableCell className="text-right tabular-nums pr-4">{formatTokens(k.totalOutputTokens)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </Panel>
            </div>
          )}

          <Panel title={t('analytics.errorsByProvider')}>
            {!errorDist?.byPlatform?.length ? (
              <p className="text-sm text-muted-foreground text-center py-8">{t('analytics.noErrors')}</p>
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={errorDist.byPlatform} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                  <XAxis dataKey="platform" tick={axisStyle} tickLine={false} axisLine={{ stroke: gridStyle }} />
                  <YAxis tick={axisStyle} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={tooltipStyle} />
                  <Bar dataKey="count" name={t('analytics.errors')} fill="var(--destructive)" radius={[3, 3, 0, 0]} maxBarSize={24} isAnimationActive={false} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Panel>

          <Panel
            title={t('analytics.recentErrors')}
            actions={
              <button
                onClick={() => clearErrorsMutation.mutate()}
                disabled={clearErrorsMutation.isPending}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
              >
                <Trash2 className="size-3" />
                {t('analytics.clearErrors')}
              </button>
            }
          >
            {errors.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-8">{t('analytics.noErrors')}</p>
            ) : (
              <div className="max-h-[240px] overflow-y-auto -mx-4">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="pl-4">{t('common.provider')}</TableHead>
                      <TableHead>{t('analytics.message')}</TableHead>
                      <TableHead className="text-right pr-4">{t('analytics.time')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {errors.slice(0, 20).map((e) => (
                      <TableRow
                        key={e.id}
                        onClick={() => setDetailId(e.id)}
                        className="cursor-pointer"
                      >
                        <TableCell className="pl-4 text-xs">{e.platform}</TableCell>
                        <TableCell className="text-xs max-w-[200px] truncate">{e.error}</TableCell>
                        <TableCell className="text-right text-xs text-muted-foreground tabular-nums pr-4">
                          {formatSqliteUtcToLocalTime(e.createdAt, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </Panel>
        </div>
      </div>

      <RequestDetailDialog requestId={detailId} onClose={() => setDetailId(null)} />
    </div>
  )
}
