import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  LineChart, Line, Legend,
} from 'recharts'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { PageHeader } from '@/components/page-header'
import { Tooltip as HoverTooltip } from '@/components/tooltip'
import { formatTokens } from '@/lib/format'
import { formatSqliteUtcToLocalTime, sqliteUtcToIso } from '@/lib/utils'
import { useI18n } from '@/i18n'

type TimeRange = '24h' | '7d' | '30d' | '90d' | '365d'

interface RecentRequestRow {
  id: number
  platform: string
  modelId: string
  displayName: string
  status: 'success' | 'error' | string
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  latencyMs: number
  requestType: string
  routeMode: 'auto' | 'pick' | 'fallback' | 'fusion' | 'embed' | 'image' | 'audio'
  clientIp: string | null
  error: string | null
  createdAt: string
}

function Stat({ label, value, hint, className, onClick }: { label: string; value: string | number; hint?: string; className?: string; onClick?: () => void }) {
  const card = (
    <div className={`rounded-3xl border bg-card/80 px-4 py-3 shadow-sm ring-1 ring-border/30 transition-colors hover:bg-card ${onClick ? 'cursor-pointer select-none' : ''}`} onClick={onClick}>
      <p className="text-[11px] text-muted-foreground uppercase tracking-wider">{label}</p>
      <p className={`text-xl font-semibold tabular-nums mt-1 ${className ?? ''}`}>{value}</p>
    </div>
  )
  // Same portal tooltip as the routing strategy chips. Opens BELOW the card:
  // the stats row sits right under the sticky navbar.
  return hint ? <HoverTooltip text={hint} side="bottom" className="block">{card}</HoverTooltip> : card
}

function Panel({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-3xl border bg-card/80 shadow-sm ring-1 ring-border/30">
      <div className="border-b bg-muted/20 px-4 py-3">
        <h3 className="text-sm font-medium">{title}</h3>
      </div>
      <div className="p-4">{children}</div>
    </div>
  )
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-[180px] items-center justify-center rounded-2xl border border-dashed bg-background/35 px-4 py-8 text-center">
      <div className="space-y-2">
        <div className="mx-auto size-1.5 rounded-full bg-muted-foreground/45" />
        <p className="text-sm text-muted-foreground">{children}</p>
      </div>
    </div>
  )
}

const axisStyle = { fontSize: 11, fill: 'var(--muted-foreground)' } as const
const gridStyle = 'var(--border)'
const primaryFill = 'var(--foreground)'
const ANALYTICS_REFETCH_INTERVAL_MS = 5_000
const RECENT_REQUESTS_LIMIT = 25

function TimeCell({ value }: { value: string }) {
  const { short, full } = formatRecentCallTime(value)
  return (
    <HoverTooltip text={full} side="top">
      <span className="cursor-default">{short}</span>
    </HoverTooltip>
  )
}

function formatRecentCallTime(value: string): { short: string; full: string } {
  const date = new Date(sqliteUtcToIso(value))
  if (isNaN(date.getTime())) return { short: '—', full: '—' }
  const pad = (n: number) => String(n).padStart(2, '0')
  const hours24 = date.getHours()
  const period = hours24 >= 12 ? 'PM' : 'AM'
  const hours12 = hours24 % 12 || 12
  const short = `${hours12}:${pad(date.getMinutes())} ${period}`
  const full = `${hours12}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ${period} ${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${String(date.getFullYear()).slice(-2)}`
  return { short, full }
}

function rangeKey(range: TimeRange) {
  return range === '24h' ? 'analytics.range24h'
    : range === '7d' ? 'analytics.range7d'
    : range === '30d' ? 'analytics.range30d'
    : range === '90d' ? 'analytics.range90d'
    : 'analytics.range365d'
}

function rangeLabelKey(range: TimeRange) {
  return range === '24h' ? 'analytics.rangeLabel24h'
    : range === '7d' ? 'analytics.rangeLabel7d'
    : range === '30d' ? 'analytics.rangeLabel30d'
    : range === '90d' ? 'analytics.rangeLabel90d'
    : 'analytics.rangeLabel365d'
}

function RouteBadge({ mode, t }: { mode: RecentRequestRow['routeMode']; t: (key: string) => string }) {
  const meta = {
    auto: { label: t('analytics.routeAuto'), hint: t('analytics.routeHintAuto'), className: 'text-muted-foreground' },
    pick: { label: t('analytics.routePick'), hint: t('analytics.routeHintPick'), className: 'bg-secondary text-secondary-foreground' },
    fallback: { label: t('analytics.routeFallback'), hint: t('analytics.routeHintFallback'), className: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300' },
    fusion: { label: t('analytics.routeFusion'), hint: t('analytics.routeHintFusion'), className: 'border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300' },
    embed: { label: t('analytics.routeEmbed'), hint: t('analytics.routeHintEmbed'), className: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300' },
    image: { label: t('analytics.routeImage'), hint: t('analytics.routeHintImage'), className: 'border-fuchsia-500/30 bg-fuchsia-500/10 text-fuchsia-700 dark:text-fuchsia-300' },
    audio: { label: t('analytics.routeAudio'), hint: t('analytics.routeHintAudio'), className: 'border-lime-500/30 bg-lime-500/10 text-lime-700 dark:text-lime-300' },
  }[mode]
  return (
    <HoverTooltip text={meta.hint} side="top">
      <Badge variant="outline" className={`h-5 px-1.5 text-[10px] ${meta.className}`}>{meta.label}</Badge>
    </HoverTooltip>
  )
}

export default function AnalyticsPage() {
  const { t } = useI18n()
  const [range, setRange] = useState<TimeRange>('7d')
  const [savingsMode, setSavingsMode] = useState<'estimated' | 'actual'>('estimated')

  const { data: summary } = useQuery({
    queryKey: ['analytics', 'summary', range],
    queryFn: () => apiFetch<any>(`/api/analytics/summary?range=${range}`),
    refetchInterval: ANALYTICS_REFETCH_INTERVAL_MS,
    refetchIntervalInBackground: false,
  })

  const { data: byPlatform = [] } = useQuery({
    queryKey: ['analytics', 'by-platform', range],
    queryFn: () => apiFetch<any[]>(`/api/analytics/by-platform?range=${range}`),
    refetchInterval: ANALYTICS_REFETCH_INTERVAL_MS,
    refetchIntervalInBackground: false,
  })

  const { data: timeline = [] } = useQuery({
    queryKey: ['analytics', 'timeline', range],
    queryFn: () => apiFetch<any[]>(`/api/analytics/timeline?range=${range}`),
    refetchInterval: ANALYTICS_REFETCH_INTERVAL_MS,
    refetchIntervalInBackground: false,
  })

  const { data: byModel = [] } = useQuery({
    queryKey: ['analytics', 'by-model', range],
    queryFn: () => apiFetch<any[]>(`/api/analytics/by-model?range=${range}`),
    refetchInterval: ANALYTICS_REFETCH_INTERVAL_MS,
    refetchIntervalInBackground: false,
  })

  const { data: errors = [] } = useQuery({
    queryKey: ['analytics', 'errors', range],
    queryFn: () => apiFetch<any[]>(`/api/analytics/errors?range=${range}`),
    refetchInterval: ANALYTICS_REFETCH_INTERVAL_MS,
    refetchIntervalInBackground: false,
  })

  const { data: errorDist } = useQuery({
    queryKey: ['analytics', 'error-distribution', range],
    queryFn: () => apiFetch<{ byCategory: any[]; byPlatform: any[]; detailed: any[] }>(`/api/analytics/error-distribution?range=${range}`),
    refetchInterval: ANALYTICS_REFETCH_INTERVAL_MS,
    refetchIntervalInBackground: false,
  })

  const { data: recentRequests = [] } = useQuery<RecentRequestRow[]>({
    queryKey: ['analytics', 'recent', range],
    queryFn: () => apiFetch<RecentRequestRow[]>(`/api/analytics/recent?range=${range}&limit=${RECENT_REQUESTS_LIMIT}`),
    refetchInterval: ANALYTICS_REFETCH_INTERVAL_MS,
    refetchIntervalInBackground: false,
    staleTime: 4_000,
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
    queryFn: () => apiFetch<any>(`/api/analytics/summary?range=30d`),
    refetchInterval: ANALYTICS_REFETCH_INTERVAL_MS,
    refetchIntervalInBackground: false,
  })
  const actualSavings = summary?.estimatedCostSavings ?? 0
  const baseSavings = summary30?.estimatedCostSavings ?? 0
  const spanDays = (() => {
    if (!summary30?.firstRequestAt) return 30
    // SQLite stores UTC "YYYY-MM-DD HH:MM:SS"
    const first = new Date(summary30.firstRequestAt.replace(' ', 'T') + 'Z').getTime()
    const days = (Date.now() - first) / 86_400_000
    if (!Number.isFinite(days)) return 30
    return Math.min(Math.max(days, 1 / 24), 30)
  })()
  const extrapolated = spanDays < 29.5
  const savings30d = extrapolated ? baseSavings * (30 / spanDays) : baseSavings
  const rangeLabel = t(rangeLabelKey(range))
  const spanLabel = spanDays >= 2 ? t('analytics.spanDays', { count: Math.round(spanDays) }) : t('analytics.spanHours', { count: Math.max(1, Math.round(spanDays * 24)) })
  const savingsHint = extrapolated
    ? t('analytics.savingsHint', { actual: actualSavings.toFixed(2), range: rangeLabel, span: spanLabel })
    : t('analytics.savingsHintExact', { actual: actualSavings.toFixed(2), range: rangeLabel })

  // Pinned = the client named a specific model instead of auto-routing.
  // Honored = that model actually served it (the rest failed over).
  const pinned = summary?.pinnedRequests ?? 0
  const pinHonored = summary?.pinHonoredRequests ?? 0
  const requestsHint = pinned > 0
    ? t('analytics.requestsHintPinned', { pinned, honored: pinHonored, failed: pinned - pinHonored })
    : t('analytics.requestsHintAuto')

  return (
    <div>
      <PageHeader
        title={t('analytics.title')}
        description={t('analytics.description')}
        actions={
          <div className="flex gap-1 rounded-lg border bg-card/70 p-0.5 shadow-sm">
            {(['24h', '7d', '30d', '90d', '365d'] as TimeRange[]).map(r => (
              <Button
                key={r}
                variant={range === r ? 'secondary' : 'ghost'}
                size="xs"
                onClick={() => setRange(r)}
              >
                {t(rangeKey(r))}
              </Button>
            ))}
          </div>
        }
      />

      <div className="space-y-6">
        {/* Summary stats */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
          <Stat label={t('analytics.requests')} value={summary?.totalRequests ?? 0} hint={requestsHint} />
          <Stat label={t('analytics.successRate')} value={`${summary?.successRate ?? 0}%`} />
          <Stat label={t('analytics.inputTokens')} value={formatTokens(summary?.totalInputTokens)} />
          <Stat label={t('analytics.outputTokens')} value={formatTokens(summary?.totalOutputTokens)} />
          <Stat label={t('analytics.avgLatency')} value={`${summary?.avgLatencyMs ?? 0} ms`} />
          {/* Priced per request at the served model's paid-API equivalent
              rate (not a flat frontier-model rate) — see db/model-pricing.ts.
              The value is a 30-day projection; the hover hint tells the whole
              story (actual period amount + whether it was extrapolated).
              Click toggles between projected 30-day savings and actual savings
              for the selected range. */}
          <Stat
            label={savingsMode === 'estimated' ? t('analytics.estSavings') : t('analytics.saved')}
            value={savingsMode === 'estimated' ? `$${savings30d.toFixed(2)}` : `$${actualSavings.toFixed(2)}`}
            hint={savingsMode === 'estimated' ? savingsHint : t('analytics.actualSavingsHint', { actual: actualSavings.toFixed(2), range: rangeLabel })}
            onClick={() => setSavingsMode(m => m === 'estimated' ? 'actual' : 'estimated')}
          />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Panel title={t('analytics.requestsByProvider')}>
            {byPlatform.length === 0 ? (
              <EmptyState>{t('common.noData')}</EmptyState>
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={byPlatform} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                  <XAxis dataKey="platform" tick={{ ...axisStyle, fontSize: 10 }} tickLine={false} axisLine={{ stroke: gridStyle }} interval={0} angle={-35} textAnchor="end" height={40} />
                  <YAxis tick={axisStyle} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={{ backgroundColor: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
                  <Bar dataKey="requests" fill={primaryFill} radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Panel>

          <Panel title={t('analytics.avgLatencyByProvider')}>
            {byPlatform.length === 0 ? (
              <EmptyState>{t('common.noData')}</EmptyState>
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={byPlatform} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                  <XAxis dataKey="platform" tick={{ ...axisStyle, fontSize: 10 }} tickLine={false} axisLine={{ stroke: gridStyle }} interval={0} angle={-35} textAnchor="end" height={40} />
                  <YAxis unit="ms" tick={axisStyle} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={{ backgroundColor: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
                  <Bar dataKey="avgLatencyMs" name={t('analytics.latencyMs')} fill="var(--muted-foreground)" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Panel>

          <div className="lg:col-span-2">
            <Panel title={t('analytics.requestsOverTime')}>
              {timeline.length === 0 ? (
                <EmptyState>{t('common.noData')}</EmptyState>
              ) : (
                <ResponsiveContainer width="100%" height={240}>
                  <LineChart data={timeline} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                    <XAxis dataKey="timestamp" tick={axisStyle} tickLine={false} axisLine={{ stroke: gridStyle }} />
                    <YAxis tick={axisStyle} tickLine={false} axisLine={false} />
                    <Tooltip contentStyle={{ backgroundColor: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
                    <Legend wrapperStyle={{ fontSize: 12 }} iconType="line" />
                    <Line type="monotone" dataKey="successCount" name={t('common.success')} stroke={primaryFill} strokeWidth={1.5} dot={false} />
                    <Line type="monotone" dataKey="failureCount" name={t('common.failures')} stroke="var(--destructive)" strokeWidth={1.5} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              )}
            </Panel>
          </div>

          <div className="lg:col-span-2">
            <Panel title={t('analytics.perModelBreakdown')}>
              {byModel.length === 0 ? (
                <EmptyState>{t('common.noData')}</EmptyState>
              ) : (
                <div className="-mx-4 max-h-[360px] overflow-auto">
                  <Table className="min-w-[1080px] table-fixed text-xs">
                    <colgroup>
                      <col className="w-[28%]" />
                      <col className="w-[10%]" />
                      <col className="w-[8%]" />
                      <col className="w-[6%]" />
                      <col className="w-[7%]" />
                      <col className="w-[11%]" />
                      <col className="w-[7%]" />
                      <col className="w-[7%]" />
                      <col className="w-[7%]" />
                      <col className="w-[9%]" />
                    </colgroup>
                    <TableHeader className="[&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:h-9 [&_th]:bg-card/95 [&_th]:py-1 [&_th]:backdrop-blur">
                      <TableRow>
                        <TableHead className="pl-4 pr-3">{t('common.model')}</TableHead>
                        <TableHead className="pl-3 pr-3">{t('common.provider')}</TableHead>
                        <TableHead className="px-3 text-center">{t('analytics.requests')}</TableHead>
                        <TableHead className="px-3 text-center">{t('analytics.pinned')}</TableHead>
                        <TableHead className="px-3 text-center">{t('common.success')}</TableHead>
                        <TableHead className="px-3 text-right">{t('analytics.latency')}</TableHead>
                        <TableHead className="px-3 text-right">{t('analytics.inTokens')}</TableHead>
                        <TableHead className="px-3 text-right">{t('analytics.outTokens')}</TableHead>
                        <TableHead className="px-3 text-right">{t('analytics.cachedTokens')}</TableHead>
                        <TableHead className="pl-3 pr-4 text-right">{t('analytics.saved')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {byModel.map((m: any, i: number) => (
                        <TableRow key={i}>
                          <TableCell className="pl-4 pr-3 py-2">
                            <div className="font-medium truncate">{m.displayName}</div>
                            <div className="mt-0.5 truncate text-[10px] text-muted-foreground font-mono">{m.modelId}</div>
                          </TableCell>
                          <TableCell className="pl-3 pr-3 py-2 text-xs text-muted-foreground truncate" title={m.platform}>{m.platform}</TableCell>
                          <TableCell className="px-3 py-2 text-center tabular-nums">{m.requests}</TableCell>
                          <TableCell className="px-3 py-2 text-center tabular-nums">{m.pinnedRequests > 0 ? m.pinnedRequests : '—'}</TableCell>
                          <TableCell className="px-3 py-2 text-center tabular-nums">{m.successRate}%</TableCell>
                          <TableCell className="px-3 py-2 text-right tabular-nums">{m.avgLatencyMs} ms</TableCell>
                          <TableCell className="px-3 py-2 text-right tabular-nums">{formatTokens(m.totalInputTokens)}</TableCell>
                          <TableCell className="px-3 py-2 text-right tabular-nums">{formatTokens(m.totalOutputTokens)}</TableCell>
                          <TableCell className="px-3 py-2 text-right tabular-nums">{formatTokens(m.totalCachedTokens)}</TableCell>
                          <TableCell className="pl-3 pr-4 py-2 text-right tabular-nums">${(m.estimatedCost ?? 0).toFixed(2)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </Panel>
          </div>

          <div className="lg:col-span-2">
            <Panel title={t('analytics.recentRequests')}>
              {recentRequests.length === 0 ? (
                <EmptyState>{t('analytics.noRequests')}</EmptyState>
              ) : (
                <div className="-mx-4 max-h-[320px] overflow-auto">
                  <Table className="min-w-[1080px] table-fixed text-xs">
                    <colgroup>
                      <col className="w-[28%]" />
                      <col className="w-[10%]" />
                      <col className="w-[8%]" />
                      <col className="w-[6%]" />
                      <col className="w-[7%]" />
                      <col className="w-[11%]" />
                      <col className="w-[7%]" />
                      <col className="w-[7%]" />
                      <col className="w-[7%]" />
                      <col className="w-[9%]" />
                    </colgroup>
                    <TableHeader className="[&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:h-9 [&_th]:bg-card/95 [&_th]:py-1 [&_th]:backdrop-blur">
                      <TableRow>
                        <TableHead className="pl-4 pr-3">{t('common.model')}</TableHead>
                        <TableHead className="pl-3 pr-3">{t('common.provider')}</TableHead>
                        <TableHead className="px-3 text-center">{t('analytics.ip')}</TableHead>
                        <TableHead className="px-3 text-center">{t('analytics.route')}</TableHead>
                        <TableHead className="px-3 text-center">{t('analytics.status')}</TableHead>
                        <TableHead className="px-3 text-right">{t('analytics.latency')}</TableHead>
                        <TableHead className="px-3 text-right">{t('analytics.inTokens')}</TableHead>
                        <TableHead className="px-3 text-right">{t('analytics.outTokens')}</TableHead>
                        <TableHead className="px-3 text-right">{t('analytics.cachedTokens')}</TableHead>
                        <TableHead className="pl-3 pr-4 text-right">{t('analytics.time')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {recentRequests.map((row) => (
                        <TableRow key={row.id}>
                          <TableCell className="py-2 pl-4 pr-3">
                            <div className="truncate font-medium" title={row.modelId}>{row.displayName}</div>
                            <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                              <span className="truncate" title={row.modelId}>{row.modelId}</span>
                            </div>
                          </TableCell>
                          <TableCell className="truncate py-2 pl-3 pr-3 text-muted-foreground" title={row.platform}>{row.platform}</TableCell>
                          <TableCell className="py-2 px-3 text-center font-mono text-[11px] text-muted-foreground whitespace-nowrap" title={row.clientIp ?? undefined}>{row.clientIp ?? '—'}</TableCell>
                          <TableCell className="py-2 px-3 text-center"><RouteBadge mode={row.routeMode} t={t} /></TableCell>
                          <TableCell className="py-2 px-3 text-center">
                            {row.status === 'success' ? (
                              <Badge variant="outline" className="h-5 px-1.5 text-[10px] border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300">{t('common.success')}</Badge>
                            ) : (
                              <HoverTooltip text={row.error ?? t('common.error')} side="top">
                                <Badge variant="destructive" className="h-5 px-1.5 text-[10px]">{t('common.error')}</Badge>
                              </HoverTooltip>
                            )}
                          </TableCell>
                          <TableCell className="py-2 px-3 text-right tabular-nums">{row.latencyMs} ms</TableCell>
                          <TableCell className="py-2 px-3 text-right tabular-nums">{formatTokens(row.inputTokens)}</TableCell>
                          <TableCell className="py-2 px-3 text-right tabular-nums">{formatTokens(row.outputTokens)}</TableCell>
                          <TableCell className="py-2 px-3 text-right tabular-nums">{formatTokens(row.cachedTokens)}</TableCell>
                          <TableCell className="py-2 pl-3 pr-4 text-right font-mono text-[11px] text-muted-foreground tabular-nums">
                            <TimeCell value={row.createdAt} />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </Panel>
          </div>

          <Panel title={t('analytics.errorsByProvider')}>
            {!errorDist?.byPlatform?.length ? (
              <EmptyState>{t('analytics.noErrors')}</EmptyState>
            ) : (
              <ResponsiveContainer width="100%" height={240}>
                <BarChart data={errorDist.byPlatform} margin={{ top: 6, right: 6, left: -12, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="2 4" stroke={gridStyle} />
                  <XAxis dataKey="platform" tick={{ ...axisStyle, fontSize: 10 }} tickLine={false} axisLine={{ stroke: gridStyle }} interval={0} angle={-35} textAnchor="end" height={40} />
                  <YAxis tick={axisStyle} tickLine={false} axisLine={false} />
                  <Tooltip contentStyle={{ backgroundColor: 'var(--popover)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
                  <Bar dataKey="count" fill="var(--destructive)" radius={[3, 3, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </Panel>

          <Panel title={t('analytics.recentErrors')}>
            {errors.length === 0 ? (
              <EmptyState>{t('analytics.noErrors')}</EmptyState>
            ) : (
              <div className="-mx-4 max-h-[240px] overflow-auto">
                <Table>
                  <TableHeader className="[&_th]:sticky [&_th]:top-0 [&_th]:z-10 [&_th]:bg-card/95 [&_th]:backdrop-blur">
                    <TableRow>
                      <TableHead className="pl-4">{t('common.provider')}</TableHead>
                      <TableHead>{t('analytics.message')}</TableHead>
                      <TableHead className="text-right pr-4">{t('analytics.time')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {errors.slice(0, 20).map((e: any) => (
                      <TableRow key={e.id}>
                        <TableCell className="pl-4 text-xs">{e.platform}</TableCell>
                        <TableCell className="text-xs max-w-[200px] truncate">{e.error}</TableCell>
                        <TableCell className="text-right text-xs text-muted-foreground tabular-nums pr-4">
                          {formatSqliteUtcToLocalTime(e.createdAt, { hour: '2-digit', minute: '2-digit' })}
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
    </div>
  )
}
