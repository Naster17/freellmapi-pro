import { useEffect, useState } from 'react'
import { Clock3 } from 'lucide-react'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'

export interface CooldownEntry {
  modelId: string
  expiresAtMs: number
  remainingSeconds: number
  reason: string | null
  modelCount?: number
}

const TICK_MS = 1_000

function formatRemaining(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1_000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.ceil(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.ceil(minutes / 60)
  return `${hours}h`
}

export function CooldownList({
  cooldowns,
  className,
  compact = false,
}: {
  cooldowns: CooldownEntry[]
  className?: string
  compact?: boolean
}) {
  const { t } = useI18n()
  const [, setTick] = useState(0)

  useEffect(() => {
    if (cooldowns.length === 0) return
    const timer = window.setInterval(() => setTick(n => n + 1), TICK_MS)
    return () => window.clearInterval(timer)
  }, [cooldowns.length])

  if (cooldowns.length === 0) return null

  return (
    <div
      className={cn('flex flex-wrap items-center gap-1.5', className)}
      role="status"
      aria-live="polite"
    >
      {cooldowns.map((cooldown) => {
        const remainingMs = cooldown.expiresAtMs - Date.now()
        const remaining = formatRemaining(remainingMs)
        const reasonKey = cooldown.reason ? `cooldown.reason.${cooldown.reason}` : null
        const reasonLabel = reasonKey && reasonKey !== t(reasonKey) ? t(reasonKey) : null
        const title = [
          t('cooldown.chip', { time: remaining }),
          reasonLabel,
        ].filter(Boolean).join(' · ')

        return (
          <span
            key={`${cooldown.modelId}:${cooldown.expiresAtMs}`}
            title={title}
            className={cn(
              'inline-flex items-center gap-1 rounded-full border bg-muted px-2 py-0.5 font-mono text-muted-foreground tabular-nums',
              compact ? 'text-[10px]' : 'text-[11px]',
            )}
          >
            <Clock3 className={cn(compact ? 'size-2.5' : 'size-3', 'shrink-0')} />
            <span className="text-foreground/60">{remaining}</span>
            {cooldown.modelCount && cooldown.modelCount > 1 && (
              <span className="text-foreground/50">×{cooldown.modelCount}</span>
            )}
            {reasonLabel && <span className="text-foreground/50">·</span>}
            {reasonLabel && <span className="max-w-[80px] truncate">{reasonLabel}</span>}
          </span>
        )
      })}
    </div>
  )
}
