import { useEffect, useMemo, useState } from 'react'
import { Check, ChevronsUpDown, Gauge, Loader2, Monitor, Moon, Search, Sun, X } from 'lucide-react'
import {
  Dialog,
  DialogClose,
  DialogPopup,
  DialogTitle,
} from '@/components/ui/dialog'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { SUPPORTED_LOCALES, type Locale, useI18n } from '@/i18n'
import { type Theme, useTheme } from '@/theme-context'
import { apiFetch } from '@/lib/api'

function LanguageCombobox() {
  const { locale, setLocale, t } = useI18n()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)

  const languages = useMemo(() => {
    const collator = new Intl.Collator(locale, { sensitivity: 'base' })
    return SUPPORTED_LOCALES
      .map(code => ({ code, name: t(`languages.${code}`) }))
      .sort((a, b) => collator.compare(a.name, b.name))
  }, [locale, t])

  const normalizedQuery = query.trim().toLocaleLowerCase(locale)
  const filtered = normalizedQuery
    ? languages.filter(({ code, name }) =>
        `${name} ${code}`.toLocaleLowerCase(locale).includes(normalizedQuery),
      )
    : languages
  const currentName = languages.find(language => language.code === locale)?.name ?? locale

  function selectLocale(next: Locale) {
    setLocale(next)
    setOpen(false)
    setQuery('')
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive(current => Math.min(current + 1, filtered.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive(current => Math.max(current - 1, 0))
    } else if (event.key === 'Enter' && filtered[active]) {
      event.preventDefault()
      selectLocale(filtered[active].code)
    }
  }

  return (
    <Popover
      open={open}
      onOpenChange={nextOpen => {
        setOpen(nextOpen)
        setQuery('')
        setActive(0)
      }}
    >
      <PopoverTrigger
        aria-label={t('settings.language')}
        className="flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-input bg-transparent px-3 text-sm outline-none transition-colors hover:bg-muted/50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30"
      >
        <span className="truncate">{currentName}</span>
        <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[min(340px,calc(100vw-3rem))] p-0" onKeyDown={onKeyDown}>
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={event => {
              setQuery(event.target.value)
              setActive(0)
            }}
            placeholder={t('settings.searchLanguage')}
            aria-label={t('settings.searchLanguage')}
            role="combobox"
            aria-expanded="true"
            aria-controls="settings-language-list"
            aria-activedescendant={filtered[active] ? `settings-language-${filtered[active].code}` : undefined}
            className="h-10 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <div id="settings-language-list" role="listbox" className="max-h-72 overflow-y-auto p-1">
          {filtered.length === 0 ? (
            <p className="px-3 py-8 text-center text-sm text-muted-foreground">
              {t('settings.noLanguages')}
            </p>
          ) : (
            filtered.map((language, index) => (
              <button
                key={language.code}
                id={`settings-language-${language.code}`}
                type="button"
                role="option"
                aria-selected={language.code === locale}
                onMouseEnter={() => setActive(index)}
                onClick={() => selectLocale(language.code)}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-2 text-start text-sm transition-colors hover:bg-accent hover:text-accent-foreground ${
                  language.code === locale ? 'bg-accent/50' : index === active ? 'bg-muted' : ''
                }`}
              >
                <Check className={`size-4 shrink-0 ${language.code === locale ? 'opacity-100' : 'opacity-0'}`} />
                <span className="min-w-0 flex-1 truncate">{language.name}</span>
                <span className="shrink-0 font-mono text-[10px] text-muted-foreground">
                  {language.code}
                </span>
              </button>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

const themeIcons = {
  system: Monitor,
  light: Sun,
  dark: Moon,
} satisfies Record<Theme, typeof Monitor>

type CompressionMode = 'off' | 'lossless' | 'standard' | 'aggressive'

interface CompressionEngineConfig {
  enabled: boolean
  [key: string]: unknown
}

interface CompressionConfig {
  mode: CompressionMode
  engines: Record<string, CompressionEngineConfig>
  autoTriggerEstTokens?: number | null
  targetTokens?: number | null
  trustProjectFilters: boolean
  prefixFreeze: boolean
}

interface CompressionStats {
  requests: number
  compressedRequests: number
  estSavedTokens: number
  savingsPercent: number
}

const ENGINE_IDS = [
  'dedup',
  'lite',
  'read-lifecycle',
  'toolfilter',
  'jsoncompact',
  'relevance',
  'aging',
  'hard-budget',
] as const

function CompressionSettings({ active }: { active: boolean }) {
  const { t } = useI18n()
  const [config, setConfig] = useState<CompressionConfig | null>(null)
  const [stats, setStats] = useState<CompressionStats | null>(null)
  const [previewInput, setPreviewInput] = useState('')
  const [previewOutput, setPreviewOutput] = useState('')
  const [busy, setBusy] = useState<'load' | 'save' | 'preview' | null>('load')
  const [error, setError] = useState('')

  useEffect(() => {
    if (!active) return
    let cancelled = false
    Promise.all([
      apiFetch<CompressionConfig>('/api/settings/compression'),
      apiFetch<CompressionStats>('/api/compression/stats'),
    ]).then(([nextConfig, nextStats]) => {
      if (cancelled) return
      setConfig(nextConfig)
      setStats(nextStats)
      setError('')
    }).catch(reason => {
      if (!cancelled) setError(reason instanceof Error ? reason.message : t('common.unknownError'))
    }).finally(() => {
      if (!cancelled) setBusy(null)
    })
    return () => { cancelled = true }
  }, [active, t])

  async function save() {
    if (!config) return
    setBusy('save')
    setError('')
    try {
      setConfig(await apiFetch<CompressionConfig>('/api/settings/compression', {
        method: 'PUT',
        body: JSON.stringify(config),
      }))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('common.unknownError'))
    } finally {
      setBusy(null)
    }
  }

  async function preview() {
    if (!config || !previewInput.trim()) return
    setBusy('preview')
    setError('')
    try {
      let requestBody: unknown = previewInput
      try { requestBody = JSON.parse(previewInput) } catch { /* plain text preview */ }
      const result = await apiFetch<{
        compressed: unknown
        stats: { estSavedTokens: number }
      }>('/api/compression/preview', {
        method: 'POST',
        body: JSON.stringify({
          mode: config.mode,
          ...(requestBody && typeof requestBody === 'object' && 'messages' in requestBody
            ? requestBody as Record<string, unknown>
            : { body: previewInput }),
        }),
      })
      setPreviewOutput(`${JSON.stringify(result.compressed, null, 2)}\n\n~${result.stats.estSavedTokens} tokens saved`)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t('common.unknownError'))
    } finally {
      setBusy(null)
    }
  }

  if (busy === 'load' && !config) {
    return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{t('common.loading')}</div>
  }
  if (!config) {
    return error ? <p className="text-sm text-destructive">{error}</p> : null
  }

  const modes: Array<{ value: CompressionMode; label: string }> = [
    { value: 'off', label: t('settings.compressionOff') },
    { value: 'lossless', label: t('settings.compressionLossless') },
    { value: 'standard', label: t('settings.compressionStandard') },
    { value: 'aggressive', label: t('settings.compressionAggressive') },
  ]

  return (
    <section className="space-y-4 border-t pt-5">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Gauge className="size-4 text-muted-foreground" />
          <h2 className="text-sm font-medium">{t('settings.compressionTitle')}</h2>
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">{t('settings.compressionDescription')}</p>
      </div>

      <div className="grid grid-cols-2 gap-1 rounded-xl border p-1 sm:grid-cols-4" role="radiogroup">
        {modes.map(option => (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={config.mode === option.value}
            onClick={() => setConfig(current => current ? { ...current, mode: option.value } : current)}
            className={`rounded-lg px-2 py-2 text-xs transition-colors ${
              config.mode === option.value
                ? 'bg-foreground font-medium text-background'
                : 'text-muted-foreground hover:bg-muted hover:text-foreground'
            }`}
          >
            {option.label}
          </button>
        ))}
      </div>

      <div className="space-y-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('settings.compressionEngines')}</h3>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {ENGINE_IDS.map(id => (
            <label key={id} className="flex items-center gap-2 rounded-lg border px-2.5 py-2 text-xs">
              <input
                type="checkbox"
                checked={config.engines[id]?.enabled ?? true}
                onChange={event => setConfig(current => current ? {
                  ...current,
                  engines: {
                    ...current.engines,
                    [id]: { ...(current.engines[id] ?? {}), enabled: event.target.checked },
                  },
                } : current)}
                className="size-3.5 accent-foreground"
              />
              <span className="truncate font-mono">{id}</span>
            </label>
          ))}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-xs">
          <span className="font-medium">{t('settings.compressionAutoTrigger')}</span>
          <input
            type="number"
            min={1}
            value={config.autoTriggerEstTokens ?? ''}
            onChange={event => setConfig(current => current ? {
              ...current,
              autoTriggerEstTokens: event.target.value ? Number(event.target.value) : null,
            } : current)}
            placeholder="32000"
            className="h-9 w-full rounded-lg border bg-transparent px-3 font-mono outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          />
        </label>
        <div className="space-y-2 pt-0.5 text-xs">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={config.prefixFreeze}
              onChange={event => setConfig(current => current ? { ...current, prefixFreeze: event.target.checked } : current)}
              className="size-3.5 accent-foreground"
            />
            {t('settings.compressionPrefixFreeze')}
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={config.trustProjectFilters}
              onChange={event => setConfig(current => current ? { ...current, trustProjectFilters: event.target.checked } : current)}
              className="size-3.5 accent-foreground"
            />
            {t('settings.compressionTrustProjectFilters')}
          </label>
        </div>
      </div>

      {stats && (
        <div className="grid grid-cols-3 divide-x rounded-xl border py-3 text-center">
          <div><div className="text-base font-semibold">{stats.requests}</div><div className="text-[10px] text-muted-foreground">{t('analytics.requests')}</div></div>
          <div><div className="text-base font-semibold">~{stats.estSavedTokens}</div><div className="text-[10px] text-muted-foreground">{t('settings.compressionEstimatedTokensSaved')}</div></div>
          <div><div className="text-base font-semibold">{stats.savingsPercent}%</div><div className="text-[10px] text-muted-foreground">{t('settings.compressionStats')}</div></div>
        </div>
      )}

      <div className="space-y-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{t('settings.compressionPreview')}</h3>
        <div className="grid gap-2 sm:grid-cols-2">
          <textarea
            value={previewInput}
            onChange={event => setPreviewInput(event.target.value)}
            placeholder={t('settings.compressionPreviewPlaceholder')}
            className="min-h-28 resize-y rounded-lg border bg-transparent p-2 font-mono text-[11px] outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
          />
          <pre className="min-h-28 max-h-52 overflow-auto whitespace-pre-wrap rounded-lg border bg-muted/30 p-2 text-[11px] text-muted-foreground">
            {previewOutput}
          </pre>
        </div>
        <button
          type="button"
          onClick={preview}
          disabled={!previewInput.trim() || busy !== null}
          className="rounded-lg border px-3 py-1.5 text-xs transition-colors hover:bg-muted disabled:opacity-50"
        >
          {busy === 'preview' ? t('common.applying') : t('settings.compressionRunPreview')}
        </button>
      </div>

      {error && <p className="text-xs text-destructive">{error}</p>}
      <button
        type="button"
        onClick={save}
        disabled={busy !== null}
        className="w-full rounded-lg bg-foreground px-3 py-2 text-xs font-medium text-background disabled:opacity-50"
      >
        {busy === 'save' ? t('common.saving') : t('common.saveChanges')}
      </button>
    </section>
  )
}

export function SettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { t } = useI18n()
  const { theme, setTheme } = useTheme()
  const themes: { value: Theme; label: string }[] = [
    { value: 'system', label: t('settings.themeSystem') },
    { value: 'light', label: t('settings.themeLight') },
    { value: 'dark', label: t('settings.themeDark') },
  ]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup maxWidth="max-w-2xl">
        <div className="mb-6 flex items-center justify-between gap-4">
          <DialogTitle>{t('settings.title')}</DialogTitle>
          <DialogClose
            aria-label={t('common.dismiss')}
            className="-me-1 rounded-lg p-1 text-muted-foreground/70 transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <X className="size-4" />
          </DialogClose>
        </div>

        <div className="space-y-6">
          <section className="space-y-2">
            <h2 className="text-sm font-medium">{t('settings.language')}</h2>
            <LanguageCombobox />
          </section>

          <section className="space-y-2">
            <h2 className="text-sm font-medium">{t('settings.theme')}</h2>
            <div
              role="radiogroup"
              aria-label={t('settings.theme')}
              className="grid grid-cols-3 gap-1 rounded-xl border p-1"
            >
              {themes.map(option => {
                const Icon = themeIcons[option.value]
                const selected = theme === option.value
                return (
                  <button
                    key={option.value}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    onClick={() => setTheme(option.value)}
                    className={`inline-flex min-w-0 items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-xs transition-colors ${
                      selected
                        ? 'bg-foreground font-medium text-background'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground'
                    }`}
                  >
                    <Icon className="size-3.5 shrink-0" />
                    <span className="truncate">{option.label}</span>
                  </button>
                )
              })}
            </div>
          </section>

          <CompressionSettings active={open} />
        </div>
      </DialogPopup>
    </Dialog>
  )
}
