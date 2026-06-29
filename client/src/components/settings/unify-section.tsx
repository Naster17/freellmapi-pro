import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Switch } from '@/components/ui/switch'
import { apiFetch } from '@/lib/api'
import { useI18n } from '@/i18n'

type UnifySettings = {
  enabled: boolean
  overrides: { merges: { into: string; keys: string[] }[]; splits: { member: string; groupKey?: string }[] }
}

export function UnifySection() {
  const { t } = useI18n()
  const queryClient = useQueryClient()

  const { data, isError } = useQuery<UnifySettings>({
    queryKey: ['unify-settings'],
    queryFn: () => apiFetch('/api/settings/unify'),
  })

  const save = useMutation({
    mutationFn: (body: { enabled: boolean }) =>
      apiFetch<UnifySettings>('/api/settings/unify', {
        method: 'PUT',
        body: JSON.stringify(body),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['unify-settings'] }),
  })

  const enabled = data?.enabled ?? true

  return (
    <section className="rounded-3xl border bg-card p-4 sm:p-5">
      <div className="mb-3">
        <h2 className="text-sm font-medium">{t('settings.unifyTitle')}</h2>
        <p className="text-xs text-muted-foreground mt-1">{t('settings.unifyDescription')}</p>
      </div>

      <div className="flex items-start gap-3 rounded-2xl border bg-background/40 p-3">
        <Switch
          id="unify-models"
          checked={enabled}
          onCheckedChange={checked => save.mutate({ enabled: checked })}
          disabled={save.isPending || !data}
        />
        <label htmlFor="unify-models" className="space-y-0.5 cursor-pointer">
          <span className="text-xs font-medium block">{t('settings.unifyTitle')}</span>
          <span className="text-[11px] text-muted-foreground block">{t('settings.unifyDescription')}</span>
        </label>
      </div>

      {(save.isError || isError) && (
        <p className="text-destructive text-xs mt-2">{(save.error as Error | null)?.message ?? t('settings.loadError')}</p>
      )}
    </section>
  )
}
