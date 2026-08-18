import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Switch } from '@/components/ui/switch'
import { apiFetch } from '@/lib/api'
import { useI18n } from '@/i18n'

type RouterSettings = { probeOnCooldown: boolean; strictChain: boolean }
type ContextHandoffSettings = { enabled: boolean }
type CostTrackingSettings = { enabled: boolean }
type UnifySettings = {
  enabled: boolean
  overrides: { merges: { into: string; keys: string[] }[]; splits: { member: string; groupKey?: string }[] }
}
type AnalyticsRetention = { retentionDays: number; maxRows: number }

export function BlockTitle({ title, description }: { title: string; description?: string }) {
  return (
    <div className="mb-3 mt-6 first:mt-0">
      <h3 className="text-sm font-medium">{title}</h3>
      {description && <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>}
    </div>
  )
}

export function SwitchRow({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string
  hint: string
  checked: boolean
  disabled: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <div className="flex items-start justify-between gap-6 border-b border-border/60 py-3.5 last:border-b-0">
      <div className="min-w-0 space-y-0.5">
        <span className="text-sm font-medium">{label}</span>
        <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>
      </div>
      <Switch size="sm" checked={checked} onCheckedChange={onChange} disabled={disabled} className="mt-0.5 shrink-0" />
    </div>
  )
}

export function BlockError({ error }: { error: string }) {
  if (!error) return null
  return <p className="mt-2 text-xs text-destructive">{error}</p>
}

function RouterGroup() {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  const { data, isError } = useQuery<RouterSettings>({
    queryKey: ['router-settings'],
    queryFn: () => apiFetch('/api/settings/router'),
  })

  const save = useMutation({
    mutationFn: (body: { probeOnCooldown?: boolean; strictChain?: boolean }) =>
      apiFetch<RouterSettings>('/api/settings/router', { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['router-settings'] }),
  })

  return (
    <>
      <BlockTitle title={t('settings.routerTitle')} description={t('settings.routerDescription')} />
      <SwitchRow
        label={t('settings.routerProbeTitle')}
        hint={t('settings.routerProbeDescription')}
        checked={data?.probeOnCooldown ?? true}
        disabled={save.isPending || !data}
        onChange={checked => save.mutate({ probeOnCooldown: checked })}
      />
      <SwitchRow
        label={t('settings.routerStrictTitle')}
        hint={t('settings.routerStrictDescription')}
        checked={data?.strictChain ?? true}
        disabled={save.isPending || !data}
        onChange={checked => save.mutate({ strictChain: checked })}
      />
      <BlockError error={isError || save.isError ? (save.error as Error | null)?.message ?? t('settings.loadError') : ''} />
    </>
  )
}

function ContextHandoffGroup() {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  const { data, isError } = useQuery<ContextHandoffSettings>({
    queryKey: ['context-handoff'],
    queryFn: () => apiFetch('/api/settings/context-handoff'),
  })

  const save = useMutation({
    mutationFn: (enabled: boolean) =>
      apiFetch<ContextHandoffSettings>('/api/settings/context-handoff', { method: 'PUT', body: JSON.stringify({ enabled }) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['context-handoff'] }),
  })

  return (
    <>
      <SwitchRow
        label={t('settings.contextHandoffTitle')}
        hint={t('settings.contextHandoffDescription')}
        checked={data?.enabled ?? false}
        disabled={save.isPending || !data}
        onChange={checked => save.mutate(checked)}
      />
      <BlockError error={isError || save.isError ? (save.error as Error | null)?.message ?? t('settings.loadError') : ''} />
    </>
  )
}

function CostTrackingGroup() {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  const { data, isError } = useQuery<CostTrackingSettings>({
    queryKey: ['cost-tracking'],
    queryFn: () => apiFetch('/api/settings/cost-tracking'),
  })

  const save = useMutation({
    mutationFn: (enabled: boolean) =>
      apiFetch<CostTrackingSettings>('/api/settings/cost-tracking', { method: 'PUT', body: JSON.stringify({ enabled }) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['cost-tracking'] }),
  })

  return (
    <>
      <SwitchRow
        label={t('settings.costTrackingTitle')}
        hint={t('settings.costTrackingDescription')}
        checked={data?.enabled ?? false}
        disabled={save.isPending || !data}
        onChange={checked => save.mutate(checked)}
      />
      <BlockError error={isError || save.isError ? (save.error as Error | null)?.message ?? t('settings.loadError') : ''} />
    </>
  )
}

function UnifyGroup() {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  const { data, isError } = useQuery<UnifySettings>({
    queryKey: ['unify-settings'],
    queryFn: () => apiFetch('/api/settings/unify'),
  })

  const save = useMutation({
    mutationFn: (enabled: boolean) =>
      apiFetch<UnifySettings>('/api/settings/unify', { method: 'PUT', body: JSON.stringify({ enabled }) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['unify-settings'] }),
  })

  return (
    <>
      <SwitchRow
        label={t('settings.unifyTitle')}
        hint={t('settings.unifyDescription')}
        checked={data?.enabled ?? true}
        disabled={save.isPending || !data}
        onChange={checked => save.mutate(checked)}
      />
      <BlockError error={isError || save.isError ? (save.error as Error | null)?.message ?? t('settings.loadError') : ''} />
    </>
  )
}

function AnalyticsRetentionGroup() {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  const { data, isError } = useQuery<AnalyticsRetention>({
    queryKey: ['analytics-retention'],
    queryFn: () => apiFetch('/api/settings/analytics-retention'),
  })

  const [draft, setDraft] = useState<{ retentionDays?: string; maxRows?: string } | null>(null)

  const save = useMutation({
    mutationFn: (body: { retentionDays?: number; maxRows?: number }) =>
      apiFetch<AnalyticsRetention>('/api/settings/analytics-retention', { method: 'PUT', body: JSON.stringify(body) }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['analytics-retention'] }),
  })

  const retentionDays = draft?.retentionDays ?? String(data?.retentionDays ?? '')
  const maxRows = draft?.maxRows ?? String(data?.maxRows ?? '')

  function onSubmit(e: React.FormEvent) {
    e.preventDefault()
    const body: { retentionDays?: number; maxRows?: number } = {}
    const rd = Number(retentionDays)
    const mr = Number(maxRows)
    if (data && Number.isInteger(rd) && rd >= 0) body.retentionDays = rd
    if (data && Number.isInteger(mr) && mr >= 0) body.maxRows = mr
    save.mutate(body)
  }

  return (
    <>
      <BlockTitle title={t('settings.analyticsRetentionTitle')} description={t('settings.analyticsRetentionDescription')} />
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label htmlFor="server-retention-days" className="text-xs font-medium">
              {t('settings.retentionDaysLabel')}
            </label>
            <input
              id="server-retention-days"
              type="number"
              min={0}
              step={1}
              value={retentionDays}
              onChange={e => setDraft(d => ({ ...d, retentionDays: e.target.value }))}
              disabled={!data}
              className="h-9 w-full rounded-lg border border-input bg-transparent px-3 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
            />
            <p className="text-[11px] text-muted-foreground">{t('settings.retentionDaysHint')}</p>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="server-max-rows" className="text-xs font-medium">
              {t('settings.maxRowsLabel')}
            </label>
            <input
              id="server-max-rows"
              type="number"
              min={0}
              step={1}
              value={maxRows}
              onChange={e => setDraft(d => ({ ...d, maxRows: e.target.value }))}
              disabled={!data}
              className="h-9 w-full rounded-lg border border-input bg-transparent px-3 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
            />
            <p className="text-[11px] text-muted-foreground">{t('settings.maxRowsHint')}</p>
          </div>
        </div>
        <div className="flex items-center justify-end gap-3">
          {save.isSuccess && <span className="text-xs text-muted-foreground">{t('common.saved')}</span>}
          <button
            type="submit"
            disabled={save.isPending || !data}
            className="rounded-lg bg-foreground px-4 py-2 text-xs font-medium text-background transition-opacity outline-none hover:opacity-90 focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-50"
          >
            {save.isPending ? t('common.saving') : t('common.save')}
          </button>
        </div>
      </form>
      <BlockError error={isError || save.isError ? (save.error as Error | null)?.message ?? t('settings.loadError') : ''} />
    </>
  )
}

export function ServerSection() {
  return (
    <div className="space-y-1">
      <RouterGroup />
      <ContextHandoffGroup />
      <CostTrackingGroup />
      <UnifyGroup />
      <AnalyticsRetentionGroup />
    </div>
  )
}