import { useI18n } from '@/i18n'
import { platformColors } from '@/pages/fallback/model-colors'

export function ProviderPill({ platform }: { platform: string }) {
  return (
    <span className="inline-grid h-6 max-w-full grid-cols-[auto_1fr] items-center gap-1.5 rounded-full bg-muted/70 px-2 text-xs text-foreground/85">
      <span className="size-1.5 rounded-full" style={{ backgroundColor: platformColors[platform] ?? '#94a3b8' }} />
      <span className="truncate">{platform}</span>
    </span>
  )
}

export function ConnectionPill({ connected }: { connected: boolean }) {
  const { t } = useI18n()
  return (
    <span className={`inline-flex h-6 items-center rounded-full px-2 text-xs ${connected ? 'bg-emerald-500/10 text-emerald-600 dark:text-emerald-400' : 'bg-muted text-muted-foreground'}`}>
      {connected ? t('models.connected') : t('models.disconnected')}
    </span>
  )
}

export function CapabilityPills({ supportsVision, supportsTools }: { supportsVision: boolean; supportsTools: boolean }) {
  const { t } = useI18n()
  if (!supportsVision && !supportsTools) return <span className="text-xs text-muted-foreground">—</span>
  return (
    <div className="flex items-center gap-1.5">
      {supportsVision && <span className="inline-flex h-6 items-center rounded-full bg-cyan-600/15 px-2 text-xs text-cyan-700 dark:bg-cyan-400/15 dark:text-cyan-400">{t('models.vision')}</span>}
      {supportsTools && <span className="inline-flex h-6 items-center rounded-full bg-violet-600/15 px-2 text-xs text-violet-700 dark:bg-violet-400/15 dark:text-violet-400">{t('models.tools')}</span>}
    </div>
  )
}

export function ReasoningPill({ level }: { level: 'high' | 'medium' | 'low' | 'none' }) {
  if (level === 'none') return null
  return (
    <span className="inline-flex h-6 items-center rounded-full bg-amber-600/15 px-2 text-xs text-amber-700 dark:bg-amber-400/15 dark:text-amber-400">R·{level}</span>
  )
}

export function SizeTierPill({ label }: { label: string }) {
  if (!label) return null
  return (
    <span className="inline-flex h-6 items-center rounded-full bg-muted/70 px-2 text-xs text-muted-foreground">{label}</span>
  )
}
