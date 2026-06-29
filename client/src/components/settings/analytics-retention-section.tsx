import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { apiFetch } from '@/lib/api'
import { useI18n } from '@/i18n'

type AnalyticsRetention = {
  retentionDays: number
  maxRows: number
}

export function AnalyticsRetentionSection() {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  const { data, isError } = useQuery<AnalyticsRetention>({
    queryKey: ['analytics-retention'],
    queryFn: () => apiFetch('/api/settings/analytics-retention'),
  })

  const [retentionDays, setRetentionDays] = useState<string>('')
  const [maxRows, setMaxRows] = useState<string>('')

  useEffect(() => {
    if (!data) return
    setRetentionDays(String(data.retentionDays))
    setMaxRows(String(data.maxRows))
  }, [data])

  const save = useMutation({
    mutationFn: (body: { retentionDays?: number; maxRows?: number }) =>
      apiFetch<AnalyticsRetention>('/api/settings/analytics-retention', {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['analytics-retention'] }),
  })

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
    <section className="rounded-3xl border bg-card p-4 sm:p-5">
      <div className="mb-3">
        <h2 className="text-sm font-medium">{t('settings.analyticsRetentionTitle')}</h2>
        <p className="text-xs text-muted-foreground mt-1">{t('settings.analyticsRetentionDescription')}</p>
      </div>

      <form onSubmit={onSubmit} className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <label htmlFor="retention-days" className="text-xs font-medium block">
              {t('settings.retentionDaysLabel')}
            </label>
            <Input
              id="retention-days"
              type="number"
              min={0}
              step={1}
              value={retentionDays}
              onChange={e => setRetentionDays(e.target.value)}
              disabled={!data}
            />
            <p className="text-[11px] text-muted-foreground">{t('settings.retentionDaysHint')}</p>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="max-rows" className="text-xs font-medium block">
              {t('settings.maxRowsLabel')}
            </label>
            <Input
              id="max-rows"
              type="number"
              min={0}
              step={1}
              value={maxRows}
              onChange={e => setMaxRows(e.target.value)}
              disabled={!data}
            />
            <p className="text-[11px] text-muted-foreground">{t('settings.maxRowsHint')}</p>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2">
          {save.isSuccess && (
            <span className="text-xs text-muted-foreground">{t('common.saved')}</span>
          )}
          <Button type="submit" size="sm" disabled={save.isPending || !data}>
            {save.isPending ? t('common.saving') : t('common.save')}
          </Button>
        </div>
      </form>

      {(save.isError || isError) && (
        <p className="text-destructive text-xs mt-2">{(save.error as Error | null)?.message ?? t('settings.loadError')}</p>
      )}
    </section>
  )
}
