import { useDeferredValue, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Bug, Info, RefreshCw, Search, Server, Trash2 } from 'lucide-react'
import type { ServerLogEntry, ServerLogLevel, ServerLogsResponse } from '@freellmapi/shared/types'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PageHeader } from '@/components/page-header'

const LEVELS: ServerLogLevel[] = ['debug', 'info', 'warn', 'error']
const LOGS_REFETCH_INTERVAL_MS = 5_000

const levelStyles: Record<ServerLogLevel, string> = {
  debug: 'border-sky-500/20 bg-sky-500/10 text-sky-700 dark:text-sky-300',
  info: 'border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  warn: 'border-amber-500/25 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  error: 'border-destructive/25 bg-destructive/10 text-destructive',
}

const levelIcons: Record<ServerLogLevel, typeof Bug> = {
  debug: Bug,
  info: Info,
  warn: AlertTriangle,
  error: AlertTriangle,
}

function formatTimestamp(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString(undefined, {
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function LevelBadge({ level }: { level: ServerLogLevel }) {
  const Icon = levelIcons[level]
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[10px] font-medium uppercase tracking-wider sm:text-[11px] ${levelStyles[level]}`}>
      <Icon className="size-3" />
      {level}
    </span>
  )
}

function LevelToggle({ level, active, onClick }: { level: ServerLogLevel; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`shrink-0 rounded-full border px-3 py-1.5 text-xs font-medium uppercase tracking-wider transition ${
        active ? levelStyles[level] : 'border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground'
      }`}
    >
      {level}
    </button>
  )
}

function LogRow({ entry }: { entry: ServerLogEntry }) {
  return (
    <article className="group rounded-2xl border bg-card/80 p-3 transition hover:border-foreground/20 sm:p-4">
      <div className="mb-3 grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 sm:flex sm:flex-wrap">
        <LevelBadge level={entry.level} />
        <time className="min-w-0 truncate font-mono text-[11px] text-muted-foreground sm:text-xs" dateTime={entry.timestamp}>
          {formatTimestamp(entry.timestamp)}
        </time>
        <span className="font-mono text-[11px] text-muted-foreground sm:ml-auto">#{entry.id}</span>
      </div>
      <pre className="max-h-44 overflow-auto whitespace-pre-wrap break-words rounded-xl bg-background/35 p-3 font-mono text-[11px] leading-relaxed text-foreground/90 sm:max-h-none sm:bg-transparent sm:p-0 sm:text-xs">
        {entry.message}
      </pre>
    </article>
  )
}

export default function LogsPage() {
  const queryClient = useQueryClient()
  const [levels, setLevels] = useState<ServerLogLevel[]>(['warn', 'error'])
  const [search, setSearch] = useState('')
  const deferredSearch = useDeferredValue(search)

  const query = new URLSearchParams({
    limit: '300',
  })
  if (deferredSearch.trim()) query.set('q', deferredSearch.trim())

  const { data, isFetching, error, refetch } = useQuery({
    queryKey: ['server-logs', deferredSearch],
    queryFn: () => apiFetch<ServerLogsResponse>(`/api/logs?${query.toString()}`),
    refetchInterval: LOGS_REFETCH_INTERVAL_MS,
    refetchIntervalInBackground: false,
  })

  const clearMutation = useMutation({
    mutationFn: () => apiFetch<ServerLogsResponse>('/api/logs/clear', { method: 'POST' }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['server-logs'] }),
  })

  const allEntries = data?.entries ?? []
  const entries = allEntries.filter(entry => levels.includes(entry.level))
  const totalByLevel = LEVELS.reduce<Record<ServerLogLevel, number>>((acc, level) => {
    acc[level] = allEntries.filter(entry => entry.level === level).length
    return acc
  }, { debug: 0, info: 0, warn: 0, error: 0 })

  function toggleLevel(level: ServerLogLevel) {
    setLevels((current) => {
      if (current.includes(level)) {
        const next = current.filter(item => item !== level)
        return next.length > 0 ? next : current
      }
      return [...current, level].sort((a, b) => LEVELS.indexOf(a) - LEVELS.indexOf(b))
    })
  }

  function showAllLevels() {
    setLevels(LEVELS)
  }

  return (
    <div>
      <PageHeader
        title="Server Logs"
        description="Inspect recent backend events, provider failures, validation errors, and runtime warnings without leaving the dashboard."
        actions={
          <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
            <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isFetching}>
              <RefreshCw className={`size-4 ${isFetching ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
            <Button variant="outline" size="sm" onClick={() => clearMutation.mutate()} disabled={clearMutation.isPending}>
              <Trash2 className="size-4" />
              Clear
            </Button>
          </div>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-2 sm:mb-6 sm:gap-3 lg:grid-cols-4">
        {LEVELS.map(level => (
          <div key={level} className="rounded-2xl border bg-card/80 px-3 py-2.5 shadow-sm ring-1 ring-border/25 sm:rounded-3xl sm:px-4 sm:py-3">
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground sm:text-[11px]">{level}</p>
            <p className="mt-0.5 text-xl font-semibold tabular-nums sm:mt-1 sm:text-2xl">{totalByLevel[level]}</p>
          </div>
        ))}
      </div>

      <section className="mb-5 rounded-3xl border bg-card/80 p-3 shadow-sm ring-1 ring-border/25 sm:mb-6 sm:p-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="-mx-1 flex gap-2 overflow-x-auto px-1 pb-1">
            {LEVELS.map(level => (
              <LevelToggle key={level} level={level} active={levels.includes(level)} onClick={() => toggleLevel(level)} />
            ))}
            <button
              type="button"
              onClick={showAllLevels}
              className="shrink-0 rounded-full border bg-card px-3 py-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground transition hover:bg-accent hover:text-foreground"
            >
              All
            </button>
          </div>
          <label className="relative block min-w-0 lg:w-80">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search messages, providers, status codes..."
              className="h-9 pl-9"
            />
          </label>
        </div>
      </section>

      {error ? (
        <div className="rounded-3xl border border-destructive/20 bg-destructive/10 p-4 text-sm text-destructive">
          {(error as Error).message}
        </div>
      ) : entries.length === 0 ? (
        <div className="rounded-3xl border bg-card/80 px-6 py-12 text-center shadow-sm ring-1 ring-border/25 sm:py-16">
          <Server className="mx-auto mb-4 size-9 text-muted-foreground" />
          <h2 className="text-lg font-medium">No matching logs</h2>
          <p className="mt-1 text-sm text-muted-foreground">Try enabling more levels, clearing the search, or triggering a new request.</p>
        </div>
      ) : (
        <div className="space-y-2.5 sm:space-y-3">
          {entries.map(entry => <LogRow key={entry.id} entry={entry} />)}
        </div>
      )}
    </div>
  )
}
