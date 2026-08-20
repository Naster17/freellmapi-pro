import { useState } from 'react'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

export interface RangeOption<T extends string> {
  value: T
  label: string
}

export interface RangeControlProps<T extends string> {
  value: T
  options: readonly RangeOption<T>[]
  onValueChange: (value: T) => void
  activeOptions: readonly T[]
  activeOptionLabel: (value: T) => string
  ariaLabel?: string
  className?: string
}

export function RangeControl<T extends string>({
  value,
  options,
  onValueChange,
  activeOptions,
  activeOptionLabel,
  ariaLabel,
  className,
}: RangeControlProps<T>) {
  const [open, setOpen] = useState(false)
  const isSubActive = !options.some(option => option.value === value)
  const chips: readonly RangeOption<T>[] = isSubActive
    ? [{ value, label: activeOptionLabel(value) }, ...options]
    : options

  return (
    <div role="tablist" aria-label={ariaLabel} className={cn('inline-flex gap-1 rounded-xl border p-1', className)}>
      {chips.map(option => {
        const active = value === option.value
        if (!active) {
          return (
            <button
              key={option.value}
              type="button"
              role="tab"
              aria-selected={false}
              onClick={() => onValueChange(option.value)}
              className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs transition-colors text-muted-foreground hover:text-foreground hover:bg-muted"
            >
              {option.label}
            </button>
          )
        }
        return (
          <DropdownMenu key={option.value} open={open} onOpenChange={setOpen}>
            <DropdownMenuTrigger
              role="tab"
              aria-selected
              aria-haspopup="menu"
              aria-expanded={open}
              className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs transition-colors bg-foreground text-background font-medium"
            >
              {option.label}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" sideOffset={6} className="min-w-0 p-0.5">
              {activeOptions.map(option => (
                <DropdownMenuItem
                  key={option}
                  onClick={() => onValueChange(option)}
                  className="justify-center gap-1 px-1.5 py-1 text-xs"
                >
                  {value === option && <Check className="size-3" />}
                  {activeOptionLabel(option)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )
      })}
    </div>
  )
}