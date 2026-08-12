import { useState, type ReactNode } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import {
  ArrowRight,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Minus,
  Plus,
  RefreshCw,
  SlidersHorizontal,
  Sparkles,
  X,
} from 'lucide-react'
import { apiFetch } from '@/lib/api'
import { PageHeader } from '@/components/page-header'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/select'
import { Dialog, DialogClose, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import { FieldError } from '@/components/ui/field-error'
import { CardSkeleton } from '@/components/ui/skeleton'
import { usePremium, type CatalogModelChange } from '@/hooks/use-premium'
import { useI18n } from '@/i18n'

function fmtWhen(ms: number | null): string | null {
  if (!ms) return null
  return new Date(ms).toLocaleString()
}

function fmtDate(iso: string | null): string {
  if (!iso) return ''
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })
}

function fmtGeneratedAt(iso: string | null): string | null {
  if (!iso) return null
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

function formatCount(value: number): string {
  return value.toLocaleString()
}

type CatalogSource = 'freellmapi.co' | 'naster17'
type ChangeBucketKey = 'added' | 'changed' | 'removed' | 'quirks'

interface ChangeRow {
  id: string
  title: string
  detail: string
  href?: string
}

function SnapshotMetric({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-2xl border bg-background/40 p-3">
      <p className="text-[11px] uppercase tracking-[0.14em] text-muted-foreground">{label}</p>
      <p className="mt-1 text-lg font-semibold tabular-nums">{value}</p>
    </div>
  )
}

function ChangeBucket({
  title,
  count,
  icon,
  tone,
  rows,
  empty,
  expanded,
  onToggle,
  onViewAll,
}: {
  title: string
  count: number
  icon: ReactNode
  tone: string
  rows: ChangeRow[]
  empty: string
  expanded: boolean
  onToggle: () => void
  onViewAll: () => void
}) {
  const { t } = useI18n()
  const visible = expanded ? rows : rows.slice(0, 4)
  return (
    <div className="rounded-2xl border bg-background/40 p-3 min-w-0">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center justify-between gap-3 text-left transition-colors outline-none rounded-lg px-0.5 hover:text-foreground"
      >
        <div className="flex min-w-0 items-center gap-2">
          <span className={`grid size-6 shrink-0 place-items-center rounded-full ${tone}`}>{icon}</span>
          <p className="truncate text-xs font-medium">{title}</p>
        </div>
        <span className="text-xs font-semibold tabular-nums">{formatCount(count)}</span>
      </button>
      <div className="mt-3 space-y-2">
        {rows.length > 0 ? (
          visible.map((row) =>
            row.href ? (
              <Link
                key={row.id}
                to={row.href}
                className="block min-w-0 rounded-xl bg-muted/35 px-3 py-2 transition-colors hover:bg-muted/60"
              >
                <p className="truncate text-xs font-medium">{row.title}</p>
                <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{row.detail}</p>
              </Link>
            ) : (
              <div key={row.id} className="min-w-0 rounded-xl bg-muted/35 px-3 py-2">
                <p className="truncate text-xs font-medium">{row.title}</p>
                <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{row.detail}</p>
              </div>
            ),
          )
        ) : (
          <p className="rounded-xl bg-muted/25 px-3 py-2 text-[11px] text-muted-foreground">{empty}</p>
        )}
      </div>
      {rows.length > 4 && (
        <div className="mt-3 flex items-center justify-between gap-2">
          <Button variant="ghost" size="sm" onClick={onToggle} className="h-7 px-2 text-[11px]">
            {expanded ? <ChevronUp /> : <ChevronDown />}
            {expanded ? t('premium.showLess') : t('premium.showMore', { count: formatCount(rows.length - 4) })}
          </Button>
          <Button variant="ghost" size="sm" onClick={onViewAll} className="h-7 px-2 text-[11px]">
            {t('premium.viewAll', { count: formatCount(rows.length) })}
          </Button>
        </div>
      )}
    </div>
  )
}

function ChangeListDialog({
  open,
  title,
  rows,
  hint,
  onOpenChange,
}: {
  open: boolean
  title: string
  rows: ChangeRow[]
  hint: string
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useI18n()
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup maxWidth="max-w-xl" className="p-5">
        <div className="mb-4 flex items-start justify-between gap-4">
          <div>
            <DialogTitle className="text-sm font-semibold">{title}</DialogTitle>
            <p className="mt-1 text-xs text-muted-foreground">{hint}</p>
          </div>
          <DialogClose
            aria-label={t('common.dismiss')}
            className="-mr-1 rounded-lg p-1 text-muted-foreground/70 transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <X className="size-4" />
          </DialogClose>
        </div>
        <div className="space-y-2">
          {rows.map((row) =>
            row.href ? (
              <Link
                key={row.id}
                to={row.href}
                onClick={() => onOpenChange(false)}
                className="block min-w-0 rounded-xl bg-muted/35 px-3 py-2 transition-colors hover:bg-muted/60"
              >
                <p className="truncate text-xs font-medium">{row.title}</p>
                <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{row.detail}</p>
              </Link>
            ) : (
              <div key={row.id} className="min-w-0 rounded-xl bg-muted/35 px-3 py-2">
                <p className="truncate text-xs font-medium">{row.title}</p>
                <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{row.detail}</p>
              </div>
            ),
          )}
        </div>
      </DialogPopup>
    </Dialog>
  )
}

export default function PremiumPage() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [keyInput, setKeyInput] = useState('')
  const [activateAttempted, setActivateAttempted] = useState(false)
  const [expandedBuckets, setExpandedBuckets] = useState<Partial<Record<ChangeBucketKey, boolean>>>({})
  const [detailBucket, setDetailBucket] = useState<ChangeBucketKey | null>(null)

  const { data, isLoading, licensed } = usePremium()

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ['premium'] })
    queryClient.invalidateQueries({ queryKey: ['models'] })
  }

  const activate = useMutation({
    meta: { silenceToast: true },
    mutationFn: (key: string) =>
      apiFetch('/api/premium/key', { method: 'POST', body: JSON.stringify({ key }) }),
    onSuccess: () => {
      setKeyInput('')
      invalidate()
    },
  })

  const removeKey = useMutation({
    mutationFn: () => apiFetch('/api/premium/key', { method: 'DELETE' }),
    onSuccess: invalidate,
  })

  const syncNow = useMutation({
    mutationFn: () => apiFetch('/api/premium/sync', { method: 'POST' }),
    onSuccess: invalidate,
  })

  const changeCatalogSource = useMutation({
    meta: { silenceToast: true },
    mutationFn: (source: CatalogSource) =>
      apiFetch('/api/premium/catalog-source', { method: 'PUT', body: JSON.stringify({ source }) }),
    onSuccess: invalidate,
  })

  const openPortal = useMutation({
    meta: { silenceToast: true },
    mutationFn: () => apiFetch<{ url: string }>('/api/premium/portal', { method: 'POST' }),
    onSuccess: ({ url }) => {
      window.open(url, '_blank', 'noopener')
    },
  })

  if (isLoading || !data) {
    return (
      <div>
        <PageHeader title={t('premium.title')} />
        <div className="space-y-6">
          <CardSkeleton />
          <CardSkeleton />
        </div>
      </div>
    )
  }

  const { hasKey, maskedKey, license, catalog, siteUrl } = data
  const catalogSource: CatalogSource = catalog.source ?? 'freellmapi.co'
  const live = catalog.appliedTier === 'live'
  const snapshot = catalog.snapshot
  const changes = catalog.changes
  const generatedAt = fmtGeneratedAt(snapshot?.generatedAt ?? null)

  const changeFieldLabels: Record<string, string> = {
    name: t('premium.changeFieldName'),
    availability: t('premium.changeFieldAvailability'),
    ranking: t('premium.changeFieldRanking'),
    size: t('premium.changeFieldSize'),
    limits: t('premium.changeFieldLimits'),
    quota: t('premium.changeFieldQuota'),
    context: t('premium.changeFieldContext'),
    capabilities: t('premium.changeFieldCapabilities'),
  }
  const modelDetail = (model: CatalogModelChange) => `${model.platform} / ${model.modelId}`
  const changedModelDetail = (model: CatalogModelChange) =>
    model.fields.map((field) => changeFieldLabels[field] ?? field).join(', ') || t('premium.changeFieldMetadata')

  const bucketRows: Record<ChangeBucketKey, ChangeRow[]> = {
    added: changes
      ? changes.added.map((model) => ({
          id: model.key,
          title: model.displayName,
          detail: modelDetail(model),
          href: `/models/chat/${model.modelId}`,
        }))
      : [],
    changed: changes
      ? changes.changed.map((model) => ({
          id: model.key,
          title: model.displayName,
          detail: changedModelDetail(model),
          href: `/models/chat/${model.modelId}`,
        }))
      : [],
    removed: changes
      ? changes.removed.map((model) => ({
          id: model.key,
          title: model.displayName,
          detail: modelDetail(model),
        }))
      : [],
    quirks: changes
      ? [
          ...changes.quirks.added.map((slug) => ({ id: `qa-${slug}`, title: slug, detail: t('premium.addedQuirk') })),
          ...changes.quirks.changed.map((slug) => ({ id: `qc-${slug}`, title: slug, detail: t('premium.updatedQuirk') })),
          ...changes.quirks.removed.map((slug) => ({ id: `qr-${slug}`, title: slug, detail: t('premium.removedQuirk') })),
        ]
      : [],
  }

  const bucketConfig: Record<ChangeBucketKey, { title: string; icon: ReactNode; tone: string; empty: string; count: number }> = {
    added: {
      title: t('premium.addedModels'),
      icon: <Plus className="size-3" />,
      tone: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400',
      empty: t('premium.noAddedModels'),
      count: changes?.counts.added ?? 0,
    },
    changed: {
      title: t('premium.changedModels'),
      icon: <SlidersHorizontal className="size-3" />,
      tone: 'bg-sky-500/15 text-sky-600 dark:text-sky-400',
      empty: t('premium.noChangedModels'),
      count: changes?.counts.changed ?? 0,
    },
    removed: {
      title: t('premium.removedModels'),
      icon: <Minus className="size-3" />,
      tone: 'bg-amber-500/15 text-amber-600 dark:text-amber-400',
      empty: t('premium.noRemovedModels'),
      count: changes?.counts.removed ?? 0,
    },
    quirks: {
      title: t('premium.quirkChanges'),
      icon: <Sparkles className="size-3" />,
      tone: 'bg-violet-500/15 text-violet-600 dark:text-violet-400',
      empty: t('premium.noQuirkChanges'),
      count: changes
        ? changes.counts.quirksAdded + changes.counts.quirksChanged + changes.counts.quirksRemoved
        : 0,
    },
  }

  const totalChangeCount = changes
    ? changes.counts.added +
      changes.counts.removed +
      changes.counts.changed +
      changes.counts.quirksAdded +
      changes.counts.quirksRemoved +
      changes.counts.quirksChanged
    : 0

  const toggleBucket = (key: ChangeBucketKey) =>
    setExpandedBuckets((prev) => ({ ...prev, [key]: !prev[key] }))

  const detailTitle = detailBucket ? bucketConfig[detailBucket].title : ''

  return (
    <div>
      <PageHeader
        title={t('premium.title')}
        actions={
          <Button variant="outline" size="sm" onClick={() => syncNow.mutate()} disabled={syncNow.isPending}>
            <RefreshCw className={syncNow.isPending ? 'animate-spin' : ''} />
            {syncNow.isPending ? t('premium.syncing') : t('premium.checkForUpdates')}
          </Button>
        }
      />

      <div className="space-y-8">
        {/* Catalog feed state */}
        <section>
          <h2 className="text-sm font-medium mb-3">{t('premium.catalogFeed')}</h2>
          <div className="space-y-5 rounded-3xl border bg-card p-4 sm:p-5">
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0 space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`inline-block size-2 rounded-full ${live ? 'bg-emerald-500' : 'bg-muted-foreground/40'}`} />
                  <span className="text-sm font-medium">{live ? t('premium.liveFeed') : t('premium.monthlySnapshot')}</span>
                  <Badge variant="outline" className="font-mono text-[11px]">
                    {catalog.appliedVersion ?? t('premium.bundled')}
                  </Badge>
                </div>
                <p className="max-w-3xl text-xs leading-relaxed text-muted-foreground">
                  {live
                    ? t('premium.liveDescription')
                    : t('premium.snapshotDescription')}
                </p>
              </div>
              <div className="flex flex-col gap-2 sm:items-end">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-muted-foreground">{t('premium.catalogSource')}</span>
                  <Select
                    value={catalogSource}
                    disabled={changeCatalogSource.isPending || syncNow.isPending}
                    onValueChange={(source) => {
                      if ((source === 'freellmapi.co' || source === 'naster17') && source !== catalogSource) {
                        changeCatalogSource.mutate(source)
                      }
                    }}
                  >
                    <SelectTrigger size="sm" className="w-40 bg-background/60">
                      <SelectValue>{catalogSource === 'naster17' ? t('premium.sourceNaster17') : t('premium.sourceOfficial')}</SelectValue>
                    </SelectTrigger>
                    <SelectContent align="end">
                      <SelectItem value="freellmapi.co">{t('premium.sourceOfficial')}</SelectItem>
                      <SelectItem value="naster17">{t('premium.sourceNaster17')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <span className="text-xs text-muted-foreground">
                  {t('premium.lastChecked', { when: fmtWhen(catalog.lastSyncMs) ?? t('common.never') })}
                </span>
              </div>
            </div>

            {snapshot ? (
              <>
                <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                  <SnapshotMetric label={t('premium.totalModels')} value={formatCount(snapshot.totalModels)} />
                  <SnapshotMetric label={t('premium.enabledModels')} value={formatCount(snapshot.enabledModels)} />
                  <SnapshotMetric label={t('premium.platforms')} value={formatCount(snapshot.platforms)} />
                  <SnapshotMetric label={t('premium.quirks')} value={formatCount(snapshot.quirks)} />
                </div>

                <div className="rounded-2xl border bg-muted/20 p-3 sm:p-4">
                  <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="text-sm font-medium">{t('premium.snapshotComparison')}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {generatedAt ? t('premium.generatedAt', { when: generatedAt }) : t('premium.latestAppliedSnapshot')}
                      </p>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline" className="font-mono text-[11px]">
                        {changes?.fromVersion ?? t('premium.noPreviousShort')}
                      </Badge>
                      <ArrowRight className="size-3.5 text-muted-foreground" />
                      <Badge variant="outline" className="font-mono text-[11px]">
                        {changes?.toVersion ?? snapshot.version}
                      </Badge>
                    </div>
                  </div>

                  {!changes?.hasPrevious ? (
                    <div className="mt-4 rounded-2xl border border-dashed bg-background/40 p-4">
                      <p className="text-sm font-medium">{t('premium.noPreviousSnapshot')}</p>
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t('premium.noPreviousSnapshotDescription')}</p>
                    </div>
                  ) : totalChangeCount === 0 ? (
                    <div className="mt-4 rounded-2xl border bg-background/40 p-4">
                      <p className="text-sm font-medium">{t('premium.noSnapshotChanges')}</p>
                      <p className="mt-1 text-xs text-muted-foreground">{t('premium.noSnapshotChangesDescription')}</p>
                    </div>
                  ) : (
                    <div className="mt-4 grid gap-3 lg:grid-cols-4">
                      {(Object.keys(bucketConfig) as ChangeBucketKey[]).map((key) => (
                        <ChangeBucket
                          key={key}
                          title={bucketConfig[key].title}
                          count={bucketConfig[key].count}
                          icon={bucketConfig[key].icon}
                          tone={bucketConfig[key].tone}
                          rows={bucketRows[key]}
                          empty={bucketConfig[key].empty}
                          expanded={Boolean(expandedBuckets[key])}
                          onToggle={() => toggleBucket(key)}
                          onViewAll={() => setDetailBucket(key)}
                        />
                      ))}
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="rounded-2xl border border-dashed bg-muted/20 p-4">
                <p className="text-sm font-medium">{t('premium.noSnapshotDetails')}</p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t('premium.noSnapshotDetailsDescription')}</p>
              </div>
            )}

            {catalog.lastError && (
              <p className="text-destructive text-xs mt-2">{t('premium.lastSyncProblem', { error: catalog.lastError })}</p>
            )}
            {changeCatalogSource.isError && (
              <p className="text-destructive text-xs mt-2">{(changeCatalogSource.error as Error).message}</p>
            )}
          </div>
        </section>

        {catalogSource !== 'naster17' && (
          <>
        {/* License */}
        <section>
          <h2 className="text-sm font-medium mb-3">{t('premium.license')}</h2>
          {hasKey ? (
            <div className="rounded-3xl border bg-card p-5 space-y-4">
              <div className="flex flex-wrap items-center gap-3">
                <span className="font-mono text-sm">{maskedKey}</span>
                {licensed ? (
                  <Badge className="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-transparent">
                    {license?.plan === 'annual'
                      ? t('premium.planAnnual')
                      : license?.plan === 'lifetime'
                        ? t('premium.planLifetime')
                        : t('premium.planGeneric')}
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-destructive border-destructive/40">
                    {license?.reason === 'expired' ? t('premium.expired') : t('premium.inactive')}
                  </Badge>
                )}
              </div>

              <p className="text-xs text-muted-foreground">
                {licensed && license?.plan === 'lifetime' && t('premium.lifetimeNote')}
                {licensed && license?.plan === 'annual' && !license.cancelAtPeriodEnd && license.expiresAt &&
                  t('premium.renewsOn', { date: fmtDate(license.expiresAt) })}
                {licensed && license?.plan === 'annual' && license.cancelAtPeriodEnd && license.expiresAt &&
                  t('premium.willNotRenew', { date: fmtDate(license.expiresAt) })}
                {!licensed &&
                  t('premium.keyInactive')}
              </p>

              <div className="flex flex-wrap items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => openPortal.mutate()} disabled={openPortal.isPending}>
                  <ExternalLink />
                  {openPortal.isPending ? t('premium.openingPortal') : t('premium.manageSubscription')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => removeKey.mutate()}
                  disabled={removeKey.isPending}
                  className="text-muted-foreground"
                >
                  {t('premium.removeKey')}
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                {t('premium.manageHint')}
              </p>
              {openPortal.isError && (
                <p className="text-destructive text-xs">{(openPortal.error as Error).message}</p>
              )}
            </div>
          ) : (
            <div className="rounded-3xl border bg-card p-5 space-y-4">
              <form
                className="flex flex-wrap items-end gap-3"
                onSubmit={(e) => {
                  e.preventDefault()
                  if (!keyInput.trim()) {
                    setActivateAttempted(true)
                    return
                  }
                  setActivateAttempted(false)
                  activate.mutate(keyInput.trim())
                }}
              >
                <div className="space-y-1.5 flex-1 min-w-[260px]">
                  <Label className="text-xs">{t('premium.licenseKey')}</Label>
                  <Input
                    value={keyInput}
                    onChange={(e) => setKeyInput(e.target.value)}
                    placeholder="fla_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
                    className="font-mono text-xs"
                    autoComplete="off"
                    aria-invalid={activateAttempted && !keyInput.trim()}
                  />
                  {activateAttempted && !keyInput.trim() && <FieldError error={t('validation.required')} />}
                </div>
                <Button type="submit" size="sm" disabled={activate.isPending}>
                  {activate.isPending ? t('premium.activating') : t('premium.activate')}
                </Button>
              </form>
              {activate.isError && (
                <p className="text-destructive text-xs">{(activate.error as Error).message}</p>
              )}
              <p className="text-xs text-muted-foreground">
                {t('premium.keyHint')}{' '}
                <a className="underline hover:text-foreground" href={`${siteUrl}/manage.html`} target="_blank" rel="noopener noreferrer">
                  {t('premium.recoverKey')}
                </a>
                .
              </p>
            </div>
          )}
        </section>
          </>
        )}

        {/* Upsell, only when not licensed */}
        {!licensed && catalogSource !== 'naster17' && (
          <section>
            <div className="rounded-3xl border bg-card p-5 flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-start gap-3">
                <Sparkles className="size-4 mt-0.5 text-muted-foreground" />
                <div>
                  <p className="text-sm font-medium">{t('premium.upsellTitle')}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {t('premium.upsellDescription')}
                  </p>
                </div>
              </div>
              <a
                href={`${siteUrl}/#pricing`}
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0"
              >
                <Button size="sm">
                  {t('premium.goPremium')}
                  <ExternalLink />
                </Button>
              </a>
            </div>
          </section>
        )}
      </div>

      {detailBucket && (
        <ChangeListDialog
          open
          title={detailTitle}
          rows={bucketRows[detailBucket]}
          hint={t('premium.viewAllHint')}
          onOpenChange={(open) => {
            if (!open) setDetailBucket(null)
          }}
        />
      )}
    </div>
  )
}
