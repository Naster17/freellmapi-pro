import { useState } from 'react'
import { Copy, Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { copyText } from '@/lib/clipboard'
import { toast } from '@/lib/toast'
import { useI18n } from '@/i18n'

interface CopyButtonProps {
  text: string
  className?: string
  label?: string
}

export function CopyButton({ text, className, label }: CopyButtonProps) {
  const { t } = useI18n()
  const resolvedLabel = label ?? t('common.copy')
  const [copied, setCopied] = useState(false)
  return (
    <button
      type="button"
      aria-label={copied ? t('common.copied') : resolvedLabel}
      onClick={() => {
        void copyText(text).then(ok => {
          if (!ok) {
            toast.error(t('common.copyFailed'))
            return
          }
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
      className={cn(
        'inline-flex items-center justify-center rounded-md border bg-background/80 text-muted-foreground transition-colors hover:text-foreground',
        className,
      )}
    >
      {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </button>
  )
}
