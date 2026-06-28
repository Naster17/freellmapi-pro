import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link, useParams } from 'react-router-dom'
import { ChevronLeft, Save, Trash2 } from 'lucide-react'
import { useI18n } from '@/i18n'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { CopyButton } from '@/components/copy-button'
import { Tooltip } from '@/components/tooltip'
import { PageHeader } from '@/components/page-header'
import { ModelsTabs } from '@/components/models-tabs'
import { type FallbackEntry, type RoutingData, type Row } from './FallbackPage'

function formatTokens(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`
  return String(n)
}

function cleanQuotaLabel(s: string | undefined): string | null {
  if (!s) return null
  let c = s
    .replace(/free\s*·\s*/ig, '')
    .replace(/\s*per ip\s*/ig, '')
    .replace(/[~?]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
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
  if (totalBudget > 0) return { text: t('models.aggregateBudget', { count: formatTokens(totalBudget) }), title: t('models.aggregateBudgetTitle') }
  if (maxRpm > 0) return { text: t('models.rateRpm', { count: maxRpm }), title: t('models.rateTitle') }
  if (maxRpd > 0) return { text: t('models.rateRpd', { count: maxRpd }), title: t('models.rateTitle') }
  if (rateLabelText) return { text: rateLabelText, title: t('models.rateTitle') }
  return null
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

// One model's own page: lists every provider that serves it (this model now
// fails over across these providers). Reached from the Models list; replaces the
// old inline group expansion.
export default function ModelDetailPage() {
  const { t } = useI18n()
  const { id } = useParams<{ id: string }>()
  const canonicalId = id ? decodeURIComponent(id) : ''
  const queryClient = useQueryClient()

  const { data: entries = [], isLoading } = useQuery<FallbackEntry[]>({
    queryKey: ['fallback'],
    queryFn: () => apiFetch('/api/fallback'),
  })
  const { data: routing } = useQuery<RoutingData>({
    queryKey: ['fallback', 'routing'],
    queryFn: () => apiFetch('/api/fallback/routing'),
  })
  const { data: keyData } = useQuery<{ apiKey: string }>({
    queryKey: ['unified-key'],
    queryFn: () => apiFetch('/api/settings/api-key'),
  })

  // Toggling a provider persists immediately (no save bar on this page): send the
  // full entries list with this one flipped, then refresh.
  const saveMutation = useMutation({
    mutationFn: (data: { modelDbId: number; priority: number; enabled: boolean }[]) =>
      apiFetch('/api/fallback', { method: 'PUT', body: JSON.stringify(data) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['fallback'] }),
  })
  const modelPatchMutation = useMutation({
    mutationFn: ({ modelDbId, patch }: { modelDbId: number; patch: ModelSettingsPatch }) =>
      apiFetch(`/api/models/${modelDbId}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
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

  // Providers serving this model: configured rows whose group matches the id
  // (canonicalId, or the bare model id for an ungrouped model).
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

  // A ready-to-run request referencing this model by its unified id, so it fails
  // over across every provider above. Same base-URL derivation as the Keys page.
  const baseUrl = import.meta.env.DEV
    ? `http://${window.location.hostname}:${__SERVER_PORT__}/v1`
    : `${window.location.origin}/v1`
  const snippet = `curl ${baseUrl}/chat/completions \\
  -H "Authorization: Bearer ${keyData?.apiKey || 'YOUR_API_KEY'}" \\
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
          <p className="text-sm text-muted-foreground">{t('common.loading')}</p>
        ) : members.length === 0 ? (
          <div className="rounded-3xl border border-dashed p-8 text-center">
            <p className="text-sm text-muted-foreground">{t('models.modelNotFound')}</p>
          </div>
        ) : (
          <>
            {/* Summary badges */}
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[11px] rounded-full px-2 py-0.5 bg-muted text-muted-foreground">{t('models.providerCount', { count: members.length })}</span>
              {quota && <span title={quota.title} className="text-[11px] rounded-full px-2 py-0.5 bg-muted text-muted-foreground tabular-nums">{quota.text}</span>}
              {vision && <span title={t('models.visionTitle')} className="text-[11px] rounded-full px-2 py-0.5 bg-cyan-600/15 text-cyan-700 dark:bg-cyan-400/15 dark:text-cyan-400">{t('models.vision')}</span>}
              {tools && <span title={t('models.toolsTitle')} className="text-[11px] rounded-full px-2 py-0.5 bg-violet-600/15 text-violet-700 dark:bg-violet-400/15 dark:text-violet-400">{t('models.tools')}</span>}
            </div>

            {/* Per-provider stats (same columns as the Models table) */}
            <div className="rounded-2xl border overflow-x-auto">
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

            <div className="rounded-2xl border bg-card p-4">
              <div className="mb-3">
                <h2 className="text-sm font-medium">{t('models.settingsHeading')}</h2>
                <p className="mt-0.5 text-xs text-muted-foreground">{t('models.settingsHint')}</p>
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

            {/* The provider-specific model id to send if you want to pin one provider. */}
            <div className="rounded-2xl border bg-card p-4">
              <h2 className="text-sm font-medium">{t('models.providerIdsHeading')}</h2>
              <p className="mt-0.5 mb-3 text-xs text-muted-foreground">{t('models.providerIdsHint')}</p>
              <div className="space-y-1.5">
                {members.map(m => (
                  <div key={m.modelDbId} className="flex items-center gap-2 text-xs">
                    <span className="w-28 shrink-0 text-muted-foreground">{m.platform}</span>
                    <code className="min-w-0 flex-1 truncate font-mono text-[11px]">{m.modelId}</code>
                    <Tooltip text={t('models.copyModelName')}>
                      <CopyButton text={m.modelId} label={t('models.copyModelName')} className="border-0 bg-transparent" />
                    </Tooltip>
                  </div>
                ))}
              </div>
            </div>

            {/* Ready-to-run snippet that references this model by its unified id. */}
            <div className="overflow-hidden rounded-2xl border bg-card">
              <div className="flex items-center gap-2 border-b px-3 py-2">
                <CopyButton text={snippet} className="size-7 shrink-0" label={t('common.copy')} />
                <span className="text-xs font-medium">{t('models.codeSnippetHeading')}</span>
              </div>
              <pre className="overflow-x-auto px-4 py-3 text-[11px] leading-relaxed"><code className="font-mono">{snippet}</code></pre>
            </div>
          </>
        )}
      </div>
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
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    setDisplayName(model.displayName)
    setContextWindow(model.contextWindow ? String(model.contextWindow) : '')
    setSupportsVision(model.supportsVision)
    setSupportsTools(model.supportsTools)
    setFallbackEnabled(model.enabled)
    setConfirmDelete(false)
  }, [model.modelDbId, model.displayName, model.contextWindow, model.supportsVision, model.supportsTools, model.enabled])

  useEffect(() => {
    if (!confirmDelete) return
    const timer = window.setTimeout(() => setConfirmDelete(false), 3000)
    return () => window.clearTimeout(timer)
  }, [confirmDelete])

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

  function remove() {
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    onDelete()
  }

  return (
    <div className="rounded-xl border bg-background/60 p-3">
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
      <div className="grid gap-3 md:grid-cols-[minmax(12rem,1fr)_8rem_auto_auto_auto_auto] md:items-end">
        <label className="space-y-1 text-xs text-muted-foreground">
          <span>{t('models.displayName')}</span>
          <Input
            value={displayName}
            onChange={e => setDisplayName(e.target.value)}
            aria-invalid={nameInvalid}
            className="text-sm"
          />
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          <span>{t('models.contextWindow')}</span>
          <Input
            type="number"
            min={1}
            step={1}
            value={contextWindow}
            onChange={e => setContextWindow(e.target.value)}
            aria-invalid={contextInvalid}
            className="text-sm tabular-nums"
          />
        </label>
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
        <div className="flex items-center justify-end gap-1">
          <Tooltip text={t('models.saveModelSettings')}>
            <Button type="button" size="icon-sm" variant="ghost" disabled={!canSave} onClick={save}>
              <Save className="size-3.5" />
            </Button>
          </Tooltip>
          <Button
            type="button"
            size={confirmDelete ? 'xs' : 'icon-sm'}
            variant="destructive"
            disabled={saving || deleting}
            onClick={remove}
          >
            {confirmDelete ? t('common.confirm') : <Trash2 className="size-3.5" />}
          </Button>
        </div>
      </div>
    </div>
  )
}
