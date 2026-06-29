import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Switch } from '@/components/ui/switch'
import { apiFetch } from '@/lib/api'
import { useI18n } from '@/i18n'

type RouterSettings = {
  probeOnCooldown: boolean
  strictChain: boolean
}

export function RouterBehaviorSection() {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  const { data, isError } = useQuery<RouterSettings>({
    queryKey: ['router-settings'],
    queryFn: () => apiFetch('/api/settings/router'),
  })

  const save = useMutation({
    mutationFn: (body: { probeOnCooldown?: boolean; strictChain?: boolean }) =>
      apiFetch<RouterSettings>('/api/settings/router', {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['router-settings'] }),
  })

  const probeOn = data?.probeOnCooldown ?? true
  const strictOn = data?.strictChain ?? true

  return (
    <section className="rounded-3xl border bg-card p-4 sm:p-5">
      <div className="mb-3">
        <h2 className="text-sm font-medium">{t('settings.routerTitle')}</h2>
        <p className="text-xs text-muted-foreground mt-1">{t('settings.routerDescription')}</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex items-start gap-3 rounded-2xl border bg-background/40 p-3">
          <Switch
            id="router-probe-on-cooldown"
            checked={probeOn}
            onCheckedChange={checked => save.mutate({ probeOnCooldown: checked })}
            disabled={save.isPending || !data}
          />
          <label htmlFor="router-probe-on-cooldown" className="space-y-0.5 cursor-pointer">
            <span className="text-xs font-medium block">{t('settings.routerProbeTitle')}</span>
            <span className="text-[11px] text-muted-foreground block">{t('settings.routerProbeDescription')}</span>
          </label>
        </div>

        <div className="flex items-start gap-3 rounded-2xl border bg-background/40 p-3">
          <Switch
            id="router-strict-chain"
            checked={strictOn}
            onCheckedChange={checked => save.mutate({ strictChain: checked })}
            disabled={save.isPending || !data}
          />
          <label htmlFor="router-strict-chain" className="space-y-0.5 cursor-pointer">
            <span className="text-xs font-medium block">{t('settings.routerStrictTitle')}</span>
            <span className="text-[11px] text-muted-foreground block">{t('settings.routerStrictDescription')}</span>
          </label>
        </div>
      </div>

      {(save.isError || isError) && (
        <p className="text-destructive text-xs mt-2">{(save.error as Error | null)?.message ?? t('settings.loadError')}</p>
      )}
    </section>
  )
}
