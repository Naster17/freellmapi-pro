import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { visiblePolling } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Badge } from '@/components/ui/badge'
import { ConfirmButton } from '@/components/confirm-button'
import { useI18n } from '@/i18n'
import { formatLatency } from '@/lib/format'
import { Activity, ArrowRight, Globe, Loader2, RefreshCw, Trash2, XCircle } from 'lucide-react'

interface ProxyDto {
  id: number
  label: string
  type: string
  host: string
  port: number
  address: string
  hasAuth: boolean
  enabled: boolean
  status: 'unknown' | 'healthy' | 'error'
  latencyMs: number | null
  lastCheckedAt: string | null
  lastError: string | null
}

interface ActivityHistory {
  proxyId: number
  label: string
  sinceMs: number
  untilMs: number | null
}

interface ActivityAssignment {
  platform: string
  sinceMs: number
  proxy: ProxyDto | null
  history: ActivityHistory[]
}

type ActivityKind = 'assigned' | 'rotated' | 'released' | 'proxy_down'

interface ActivityEvent {
  ts: number
  kind: ActivityKind
  platform: string
  proxyId: number
  proxyLabel: string
  latencyMs: number | null
}

interface ActivitySnapshot {
  assignments: ActivityAssignment[]
  events: ActivityEvent[]
}

const PROXY_TYPES: { value: string; labelKey: string }[] = [
  { value: 'socks5', labelKey: 'keys.proxyTypeSocks5' },
  { value: 'socks5h', labelKey: 'keys.proxyTypeSocks5h' },
  { value: 'socks4', labelKey: 'keys.proxyTypeSocks4' },
  { value: 'socks4a', labelKey: 'keys.proxyTypeSocks4a' },
  { value: 'http', labelKey: 'keys.proxyTypeHttp' },
  { value: 'https', labelKey: 'keys.proxyTypeHttps' },
]

const TYPE_LABEL_KEY = Object.fromEntries(PROXY_TYPES.map(t => [t.value, t.labelKey]))

const TYPE_ORDER = PROXY_TYPES.map(t => t.value)

const STATUS_RANK: Record<string, number> = { healthy: 0, unknown: 1, error: 2 }
const STATUS_DOT: Record<string, string> = {
  healthy: 'bg-emerald-500',
  unknown: 'bg-muted-foreground/40',
  error: 'bg-rose-500',
}

const EVENT_LABEL_KEY: Record<ActivityKind, string> = {
  assigned: 'keys.proxyEventAssigned',
  rotated: 'keys.proxyEventRotated',
  released: 'keys.proxyEventReleased',
  proxy_down: 'keys.proxyEventProxyDown',
}

function byLatency(a: ProxyDto, b: ProxyDto): number {
  const ra = STATUS_RANK[a.status] ?? 2
  const rb = STATUS_RANK[b.status] ?? 2
  if (ra !== rb) return ra - rb
  const la = a.latencyMs ?? Infinity
  const lb = b.latencyMs ?? Infinity
  if (la !== lb) return la - lb
  return a.id - b.id
}

function platformLabel(platform: string): string {
  return platform.charAt(0).toUpperCase() + platform.slice(1)
}

function eventTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

function AddProxySection({
  onCreated,
}: {
  onCreated: () => void
}) {
  const { t } = useI18n()
  const [type, setType] = useState('socks5')
  const [address, setAddress] = useState('')
  const [label, setLabel] = useState('')

  const create = useMutation({
    mutationFn: () =>
      apiFetch('/api/proxies', {
        method: 'POST',
        body: JSON.stringify({ type, address: address.trim(), label: label.trim() || undefined }),
      }),
    onSuccess: () => {
      setAddress('')
      setLabel('')
      onCreated()
    },
  })

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!address.trim()) return
    create.mutate()
  }

  return (
    <section>
      <h2 className="text-sm font-medium mb-1">{t('keys.addProxy')}</h2>
      <p className="text-xs text-muted-foreground mb-3">{t('keys.addProxyDescription')}</p>
      <form onSubmit={submit} className="flex flex-wrap gap-3 rounded-3xl border p-4 bg-card">
        <div className="space-y-1.5">
          <Label className="text-xs">{t('keys.proxyType')}</Label>
          <Select value={type} onValueChange={(v) => setType(v ?? 'socks5')}>
            <SelectTrigger className="w-[160px] py-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROXY_TYPES.map(p => (
                <SelectItem key={p.value} value={p.value}>{t(p.labelKey)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1.5 flex-1 min-w-[240px]">
          <Label className="text-xs">{t('keys.proxyAddress')}</Label>
          <Input
            value={address}
            onChange={e => setAddress(e.target.value)}
            placeholder="host:port or user:pass@host:port"
            className="font-mono text-xs"
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">{t('keys.label')}</Label>
          <div className="flex flex-wrap items-center space-x-3">
            <Input
              value={label}
              onChange={e => setLabel(e.target.value)}
              placeholder={t('keys.customDisplayNameOptional')}
              className="w-[160px]"
            />
            <Button type="submit" size="sm" disabled={!address.trim() || create.isPending}>
              {create.isPending ? t('keys.addingProxy') : t('keys.addProxySubmit')}
            </Button>
          </div>
        </div>
      </form>
      {create.isError && (
        <p className="text-destructive text-xs mt-2">{(create.error as Error).message}</p>
      )}
    </section>
  )
}

function ConfiguredProxiesSection({ proxies }: { proxies: ProxyDto[] }) {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['proxies'] })
    queryClient.invalidateQueries({ queryKey: ['proxy-activity'] })
  }

  const update = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) =>
      apiFetch(`/api/proxies/${id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
    onSuccess: invalidate,
  })

  const checkOne = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/proxies/${id}/check`, { method: 'POST' }),
    onSuccess: invalidate,
  })

  const checkAll = useMutation({
    mutationFn: () => apiFetch('/api/proxies/check-all', { method: 'POST' }),
    onSuccess: invalidate,
  })

  const remove = useMutation({
    mutationFn: (id: number) => apiFetch(`/api/proxies/${id}`, { method: 'DELETE' }),
    onSuccess: invalidate,
  })

  const disableAll = useMutation({
    mutationFn: () =>
      Promise.all(proxies.filter(p => p.enabled).map(p => apiFetch(`/api/proxies/${p.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: false }) }))),
    onSuccess: invalidate,
  })

  const toggleGroup = useMutation({
    mutationFn: ({ type, enabled }: { type: string; enabled: boolean }) =>
      Promise.all(proxies.filter(p => p.type === type).map(p => apiFetch(`/api/proxies/${p.id}`, { method: 'PATCH', body: JSON.stringify({ enabled }) }))),
    onSuccess: invalidate,
  })

  // Deliberately mirrors the Providers tab pattern: one switch per proxy (like
  // a key row) plus a group switch that flips the whole type at once.
  const anyEnabled = proxies.some(p => p.enabled)
  const grouped = TYPE_ORDER
    .map(type => ({ type, proxies: proxies.filter(p => p.type === type).sort(byLatency) }))
    .filter(g => g.proxies.length > 0)

  if (proxies.length === 0) {
    return (
      <section>
        <div className="mb-3">
          <h2 className="text-sm font-medium">{t('keys.configuredProxies')}</h2>
        </div>
        <div className="flex flex-col items-center rounded-3xl border border-dashed px-6 py-14 text-center">
          <div className="mb-4 flex size-12 items-center justify-center rounded-2xl border bg-muted/40">
            <Globe className="size-5 text-muted-foreground" />
          </div>
          <h3 className="text-base font-medium">{t('keys.proxyEmptyTitle')}</h3>
          <p className="mt-1.5 max-w-sm text-sm text-muted-foreground">
            {t('keys.proxyEmptyDescription')}
          </p>
        </div>
      </section>
    )
  }

  return (
    <section>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-medium">{t('keys.configuredProxies')}</h2>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => checkAll.mutate()} disabled={checkAll.isPending}>
            {checkAll.isPending && <Loader2 className="size-3 animate-spin" />}
            {checkAll.isPending ? t('keys.checking') : t('keys.checkAll')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => disableAll.mutate()} disabled={disableAll.isPending || !anyEnabled}>
            {t('keys.proxyDisableAll')}
          </Button>
        </div>
      </div>

      <div className="space-y-4">
        {grouped.map(group => (
          <div key={group.type}>
            <div className="flex items-center gap-2 pb-2">
              <Switch
                checked={group.proxies.some(p => p.enabled)}
                onCheckedChange={(checked) => toggleGroup.mutate({ type: group.type, enabled: checked })}
                disabled={toggleGroup.isPending}
                aria-label={t('keys.proxyEnabledAria')}
              />
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <h3 className="text-sm font-medium">{t(TYPE_LABEL_KEY[group.type] ?? 'keys.proxyTypeSocks5')}</h3>
                <Badge variant="secondary" className="tabular-nums">{group.proxies.length}</Badge>
                <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                  {group.proxies.filter(p => p.status === 'healthy').length > 0 && (
                    <span className="inline-flex items-center gap-1">
                      <span className="size-1.5 rounded-full bg-emerald-500" />
                      {t('keys.summaryHealthy', { count: group.proxies.filter(p => p.status === 'healthy').length })}
                    </span>
                  )}
                  {group.proxies.filter(p => p.status === 'error').length > 0 && (
                    <span className="inline-flex items-center gap-1">
                      <span className="size-1.5 rounded-full bg-rose-500" />
                      {t(group.proxies.filter(p => p.status === 'error').length === 1 ? 'keys.summaryIssueOne' : 'keys.summaryIssueOther', { count: group.proxies.filter(p => p.status === 'error').length })}
                    </span>
                  )}
                </span>
              </div>
            </div>
            <div className="rounded-2xl border divide-y bg-card overflow-hidden">
              {group.proxies.map(p => {
                const isChecking = checkOne.isPending && checkOne.variables === p.id
                return (
                  <div key={p.id} className="group/krow flex flex-wrap items-center gap-3 px-4 py-3 hover:bg-muted/40 transition-colors">
                    <Switch
                      size="sm"
                      checked={p.enabled}
                      onCheckedChange={(enabled) => update.mutate({ id: p.id, enabled })}
                      disabled={update.isPending}
                      aria-label={t('keys.proxyEnabledAria')}
                    />
                    <span className={`size-1.5 rounded-full flex-shrink-0 ${STATUS_DOT[p.status] ?? STATUS_DOT.unknown}`} />
                    <code className={`text-xs font-mono flex-shrink-0 ${p.enabled ? '' : 'opacity-50'}`}>{p.address}</code>
                    <div className="flex min-w-0 flex-1 items-center gap-2">
                      <span className={`truncate text-xs ${p.label ? 'text-muted-foreground' : 'text-muted-foreground/50'} ${p.enabled ? '' : 'opacity-50'}`}>
                        {p.label || `${p.type}://${p.address}`}
                      </span>
                      {p.hasAuth && <Badge variant="secondary" className="shrink-0 text-[10px] text-muted-foreground">auth</Badge>}
                    </div>
                    {p.status === 'healthy' && (
                      <span className={`shrink-0 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium tabular-nums text-emerald-600 dark:text-emerald-400 ${p.enabled ? '' : 'opacity-50'}`}>
                        {formatLatency(p.latencyMs)}
                      </span>
                    )}
                    {p.status === 'error' && (
                      <span className="shrink-0 inline-flex items-center gap-1 rounded-full bg-rose-500/10 px-2 py-0.5 text-[11px] font-medium text-rose-600 dark:text-rose-400" title={p.lastError ?? ''}>
                        <XCircle className="size-3" />
                        {t('keys.proxyStatusError')}
                      </span>
                    )}
                    {p.status === 'unknown' && (
                      <span className="shrink-0 inline-flex items-center gap-1 rounded-full bg-muted/60 px-2 py-0.5 text-[11px] text-muted-foreground">
                        <span className="size-1.5 rounded-full bg-muted-foreground/40" />
                        {t('keys.proxyUnchecked')}
                      </span>
                    )}
                    <div className="ml-auto flex items-center gap-0.5 opacity-0 transition-opacity group-hover/krow:opacity-100 focus-within:opacity-100 pointer-coarse:opacity-100">
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => checkOne.mutate(p.id)}
                        disabled={checkOne.isPending}
                        aria-label={t('keys.checkNow')}
                        title={t('keys.checkNow')}
                      >
                        <RefreshCw className={`size-3 ${isChecking ? 'animate-spin' : ''}`} />
                      </Button>
                      <ConfirmButton
                        variant="ghost"
                        size="icon-xs"
                        armedSize="xs"
                        className="text-muted-foreground hover:text-destructive"
                        confirmLabel={t('keys.confirmRemove')}
                        onConfirm={() => remove.mutate(p.id)}
                        disabled={remove.isPending}
                        title={t('common.remove')}
                        aria-label={t('common.remove')}
                      >
                        <Trash2 className="size-3.5" />
                      </ConfirmButton>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  )
}

function ProxyActivitySection() {
  const { t } = useI18n()

  const { data } = useQuery<ActivitySnapshot>({
    queryKey: ['proxy-activity'],
    queryFn: () => apiFetch('/api/proxies/activity'),
    refetchInterval: visiblePolling(5_000),
  })

  const assignments = data?.assignments ?? []
  const events = data?.events ?? []

  if (assignments.length === 0 && events.length === 0) {
    return null
  }

  return (
    <section>
      <div className="mb-3">
        <h2 className="text-sm font-medium flex items-center gap-2">
          <Activity className="size-3.5 text-muted-foreground" />
          {t('keys.proxyActivityTitle')}
        </h2>
        <p className="text-xs text-muted-foreground mt-0.5">{t('keys.proxyActivityDescription')}</p>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <div className="rounded-3xl border bg-card p-4">
          <h3 className="text-xs font-medium mb-3">{t('keys.proxyFeedProviders')}</h3>
          {assignments.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('keys.proxyFeedEmpty')}</p>
          ) : (
            <ul className="space-y-3">
              {assignments.map(a => (
                <li key={a.platform} className="rounded-2xl border bg-background/40 px-3 py-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium">{platformLabel(a.platform)}</span>
                    {a.proxy && (
                      <code className="truncate font-mono text-[11px] text-muted-foreground">{a.proxy.type}://{a.proxy.address}</code>
                    )}
                    {a.proxy && a.proxy.latencyMs != null && (
                      <span className="shrink-0 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium tabular-nums text-emerald-600 dark:text-emerald-400">
                        {formatLatency(a.proxy.latencyMs)}
                      </span>
                    )}
                  </div>
                  {a.history.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-1 text-[10px] text-muted-foreground">
                      {a.history.map(h => (
                        <span key={`${h.proxyId}-${h.sinceMs}`} className="inline-flex items-center gap-1 rounded-md bg-muted/50 px-1.5 py-0.5 font-mono">
                          {h.label}
                        </span>
                      ))}
                      <ArrowRight className="size-3 text-muted-foreground/50" />
                      <span className="text-muted-foreground/70">{t('keys.proxyFeedNow')}</span>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="rounded-3xl border bg-card p-4">
          <h3 className="text-xs font-medium mb-3">{t('keys.proxyFeedEvents')}</h3>
          {events.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t('keys.proxyFeedEmpty')}</p>
          ) : (
            <ul className="space-y-1.5">
              {events.slice(0, 8).map((e, i) => (
                <li key={`${e.ts}-${i}`} className="flex items-center gap-2 text-[11px]">
                  <span className="shrink-0 w-14 tabular-nums text-muted-foreground">{eventTime(e.ts)}</span>
                  <span className="shrink-0 text-muted-foreground">{platformLabel(e.platform)}</span>
                  <ArrowRight className="size-3 shrink-0 text-muted-foreground/50" />
                  <span className="min-w-0 truncate font-mono text-muted-foreground">{e.proxyLabel}</span>
                  <span className="ml-auto shrink-0 text-muted-foreground/70">{t(EVENT_LABEL_KEY[e.kind])}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  )
}

export function ProxyTab() {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  const { data, isError, isLoading } = useQuery<{ proxies: ProxyDto[] }>({
    queryKey: ['proxies'],
    queryFn: () => apiFetch('/api/proxies'),
    refetchInterval: visiblePolling(5_000),
  })

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['proxies'] })
    queryClient.invalidateQueries({ queryKey: ['proxy-activity'] })
  }

  const proxies = data?.proxies ?? []

  return (
    <div className="space-y-8">
      <AddProxySection onCreated={invalidate} />

      <section className="rounded-3xl border bg-card p-5">
        <div className="flex items-center gap-2 mb-3">
          <Globe className="size-3.5 text-muted-foreground" />
          <h2 className="text-sm font-medium">{t('keys.proxyHowItWorks')}</h2>
        </div>
        <p className="text-xs text-muted-foreground max-w-prose">{t('keys.proxyHowItWorksDescription')}</p>
      </section>

      {isError ? (
        <p className="text-xs text-muted-foreground">{t('keys.proxyLoadFailed')}</p>
      ) : isLoading ? (
        <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
      ) : (
        <>
          <ConfiguredProxiesSection proxies={proxies} />
          <ProxyActivitySection />
        </>
      )}
    </div>
  )
}