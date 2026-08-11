import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { useI18n } from '@/i18n'
import { BlockError, BlockTitle, SwitchRow } from '@/components/settings/server-section'

type ZenKeylessState = {
  enabled: boolean
  sentinelKeyId: number | null
  zenKeyCount: number
  disabledZenKeyCount: number
}

export function TricksSection() {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  const { data, isError } = useQuery<ZenKeylessState>({
    queryKey: ['zen-keyless'],
    queryFn: () => apiFetch('/api/settings/zen-keyless'),
  })

  const save = useMutation({
    mutationFn: (enabled: boolean) =>
      apiFetch<ZenKeylessState>('/api/settings/zen-keyless', {
        method: 'PUT',
        body: JSON.stringify({ enabled }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['zen-keyless'] }),
  })

  const enabled = data?.enabled ?? false

  return (
    <div className="space-y-1">
      <BlockTitle title={t('settings.zenKeylessTitle')} description={t('settings.zenKeylessDescription')} />
      <SwitchRow
        label={t('settings.zenKeylessLabel')}
        hint={t('settings.zenKeylessHint')}
        checked={enabled}
        disabled={save.isPending || !data}
        onChange={checked => save.mutate(checked)}
      />
      {enabled && data && data.disabledZenKeyCount > 0 && (
        <p className="pt-3 text-xs text-muted-foreground">
          {t('settings.zenKeylessDisabledCount', { count: data.disabledZenKeyCount })}
        </p>
      )}
      <BlockError
        error={isError || save.isError ? (save.error as Error | null)?.message ?? t('settings.loadError') : ''}
      />
    </div>
  )
}