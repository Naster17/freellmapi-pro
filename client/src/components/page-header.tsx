import type { ReactNode } from 'react'

export function PageHeader({
  title,
  description,
  actions,
  divider = true,
}: {
  title: string
  description?: string
  actions?: ReactNode
  divider?: boolean
}) {
  return (
    <div className={`mb-6 flex flex-wrap items-start justify-between gap-4 md:flex-nowrap md:items-end md:gap-6 ${divider ? 'pb-6 border-b' : ''}`}>
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && (
          <p className="text-sm text-muted-foreground mt-1">{description}</p>
        )}
      </div>
      {actions && <div className="flex w-full min-w-0 items-center gap-2 sm:w-auto sm:shrink-0">{actions}</div>}
    </div>
  )
}
