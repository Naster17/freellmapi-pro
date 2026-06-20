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
    <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-1 text-[11px] font-medium uppercase tracking-wider ${levelStyles[level]}`}>
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
      className={`rounded-full border px-3 py-1.5 text-xs font-medium uppercase tracking-wider transition ${
        active ? levelStyles[level] : 'border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground'
      }`}
    >
      {level}
    </button>
  )
}

function LogRow({ entry }: { entry: ServerLogEntry }) {
  return (
    <article className="group rounded-2xl border bg-card/80 p-4 transition hover:border-foreground/20">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <LevelBadge level={entry.level} />
        <time className="font-mono text-xs text-muted-foreground" dateTime={entry.timestamp}>
          {formatTimestamp(entry.timestamp)}
        </time>
        <span className="ml-auto font-mono text-[11px] text-muted-foreground">#{entry.id}</span>
      </div>
      <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-foreground/90">
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
          <div className="flex flex-wrap gap-2">
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

      <div className="mb-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {LEVELS.map(level => (
          <div key={level} className="rounded-3xl border bg-card px-4 py-3">
            <p className="text-[11px] uppercase tracking-wider text-muted-foreground">{level}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{totalByLevel[level]}</p>
          </div>
        ))}
      </div>

      <section className="mb-6 rounded-3xl border bg-card p-4">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex flex-wrap gap-2">
            {LEVELS.map(level => (
              <LevelToggle key={level} level={level} active={levels.includes(level)} onClick={() => toggleLevel(level)} />
            ))}
            <button
              type="button"
              onClick={showAllLevels}
              className="rounded-full border bg-card px-3 py-1.5 text-xs font-medium uppercase tracking-wider text-muted-foreground transition hover:bg-accent hover:text-foreground"
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
              className="pl-9"
            />
          </label>
        </div>
      </section>

      {error ? (
        <div className="rounded-3xl border border-destructive/20 bg-destructive/10 p-4 text-sm text-destructive">
          {(error as Error).message}
        </div>
      ) : entries.length === 0 ? (
        <div className="rounded-3xl border bg-card px-6 py-16 text-center">
          <Server className="mx-auto mb-4 size-9 text-muted-foreground" />
          <h2 className="text-lg font-medium">No matching logs</h2>
          <p className="mt-1 text-sm text-muted-foreground">Try enabling more levels, clearing the search, or triggering a new request.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {entries.map(entry => <LogRow key={entry.id} entry={entry} />)}
        </div>
      )}
    </div>
  )
}
