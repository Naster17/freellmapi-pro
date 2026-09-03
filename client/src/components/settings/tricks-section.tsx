import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { useI18n } from '@/i18n'
import { BlockError, BlockTitle, SwitchRow } from '@/components/settings/server-section'
import { Button } from '@/components/ui/button'

type ZenKeylessState = {
  enabled: boolean
  sentinelKeyId: number | null
  zenKeyCount: number
  disabledZenKeyCount: number
  anonKeyCount: number
}

type RouterSettings = { probeOnCooldown: boolean; strictChain: boolean; softLimits: boolean }

function SoftLimitsGroup() {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  const { data, isError } = useQuery<RouterSettings>({
    queryKey: ['router-settings'],
    queryFn: () => apiFetch('/api/settings/router'),
  })

  const save = useMutation({
    mutationFn: (softLimits: boolean) =>
      apiFetch<RouterSettings>('/api/settings/router', {
        method: 'PUT',
        body: JSON.stringify({ softLimits }),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['router-settings'] }),
  })

  return (
    <>
      <BlockTitle title={t('settings.softLimitsTitle')} description={t('settings.softLimitsDescription')} />
      <SwitchRow
        label={t('settings.softLimitsLabel')}
        hint={t('settings.softLimitsHint')}
        checked={data?.softLimits ?? true}
        disabled={save.isPending || !data}
        onChange={checked => save.mutate(checked)}
      />
      <BlockError
        error={isError || save.isError ? (save.error as Error | null)?.message ?? t('settings.loadError') : ''}
      />
    </>
  )
}

function ZenAnonKeysRow({ data }: { data: ZenKeylessState }) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [armed, setArmed] = useState(false)

  const clear = useMutation({
    mutationFn: () =>
      apiFetch<ZenKeylessState & { removed: number }>('/api/settings/zen-keyless/anon-keys', {
        method: 'DELETE',
      }),
    onSuccess: () => {
      setArmed(false)
      queryClient.invalidateQueries({ queryKey: ['zen-keyless'] })
      queryClient.invalidateQueries({ queryKey: ['keys'] })
    },
  })

  return (
    <div className="flex items-start justify-between gap-6 border-b border-border/60 py-3.5 last:border-b-0">
      <div className="min-w-0 space-y-0.5">
        <span className="text-sm font-medium">
          {t('settings.zenAnonKeysLabel', { count: data.anonKeyCount })}
        </span>
        <p className="text-xs leading-relaxed text-muted-foreground">{t('settings.zenAnonKeysHint')}</p>
      </div>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        className={`mt-0.5 shrink-0 ${armed ? 'text-destructive' : 'text-muted-foreground hover:text-destructive'}`}
        disabled={clear.isPending || data.anonKeyCount === 0}
        onClick={() => (armed ? clear.mutate() : setArmed(true))}
      >
        {clear.isPending ? t('common.loading') : armed ? t('settings.zenAnonKeysConfirm') : t('settings.zenAnonKeysClear')}
      </Button>
    </div>
  )
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
      <SoftLimitsGroup />
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
      {data && <ZenAnonKeysRow data={data} />}
      <BlockError
        error={isError || save.isError ? (save.error as Error | null)?.message ?? t('settings.loadError') : ''}
      />
    </div>
  )
}
