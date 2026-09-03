import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { copyText } from '@/lib/clipboard'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { ModelCombobox } from '@/components/model-combobox'
import { FieldError } from '@/components/ui/field-error'
import type { ApiKey, Platform } from '../../../../shared/types'
import { useI18n } from '@/i18n'
import { toast } from '@/lib/toast'
import { GetKeyLink, PLATFORMS } from './shared'

// The "Provider key" pane of the Add key dialog: paste a credential for a known
// provider. Extracted verbatim from the old inline KeysPage form so all field
// validation, the keyless/Cloudflare special cases, and the POST /api/keys
// mutation stay identical. On success it toasts and asks the dialog to close.
// `initialPlatform` preselects the provider (checklist-chip entry); the field
// stays editable. The dialog remounts this pane per open, so a plain initial
// state is enough.
export function AddKeyForm({ onSuccess, initialPlatform }: { onSuccess: () => void; initialPlatform?: Platform }) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [platform, setPlatform] = useState<Platform | ''>(initialPlatform ?? '')
  const [apiKey, setApiKey] = useState('')
  const [accountId, setAccountId] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [label, setLabel] = useState('')
  const [addAttempted, setAddAttempted] = useState(false)
  // Several credentials for one provider in one go (#705). Pooling keys is the
  // point of this app, and the only bulk path was the file importer, so anyone
  // holding five Groq keys reopened this dialog five times. Off by default: the
  // single-key field masks what you type, and a textarea cannot.
  const [several, setSeveral] = useState(false)

  // #707: the platform dropdown had no search and no way to skip providers that
  // already have keys, which is painful at thirty-odd entries. The shared
  // ModelCombobox already does search + arrow keys, so this reuses it and only
  // supplies the options. PLATFORMS keeps its curated order — it is sorted by
  // recommendation, not alphabetically — and the search box handles "find it
  // fast". The added/not-added split reads the same ['keys'] query the
  // Providers tab owns, so it costs no extra request.
  const { data: keys = [] } = useQuery<ApiKey[]>({
    queryKey: ['keys'],
    queryFn: () => apiFetch('/api/keys'),
  })
  const addedPlatforms = useMemo(() => new Set(keys.map(k => k.platform)), [keys])
  const [hideAdded, setHideAdded] = useState(false)

  const platformOptions = useMemo(
    () => PLATFORMS
      // The selected provider always stays listed, so hiding added ones never
      // blanks out the trigger label.
      .filter(p => !hideAdded || !addedPlatforms.has(p.value) || p.value === platform)
      .map(p => ({
        value: p.value,
        label: p.label,
        sub: addedPlatforms.has(p.value) ? t('keys.discoverAlreadyAdded') : undefined,
      })),
    [hideAdded, addedPlatforms, platform, t],
  )

  const addKey = useMutation({
    meta: { silenceToast: true },
    mutationFn: (body: { platform: string; key: string; label?: string; baseUrl?: string }) =>
      apiFetch<{ notice?: string | null }>('/api/keys', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      queryClient.invalidateQueries({ queryKey: ['keys-providers'] })
      toast.success(t('keys.keyAdded'))
      // Server notice when the key is for a platform with no models in the
      // current catalog tier yet (#438) — surfaced as a toast now that the
      // dialog closes on success.
      if (data?.notice) toast.info(data.notice)
      onSuccess()
    },
  })

  // Reuses the bulk endpoint the file importer already posts to, which dedupes
  // against every stored key and reports per-key failures.
  const addSeveral = useMutation({
    meta: { silenceToast: true },
    mutationFn: (body: { keys: { platform: string; keyName?: string; keyValue: string }[] }) =>
      apiFetch<{ imported: number; total: number; errors: { key: string; error: string }[] }>(
        '/api/keys/import-selected', { method: 'POST', body: JSON.stringify(body) },
      ),
    onSuccess: (data) => {
      for (const key of ['keys', 'health', 'fallback', 'keys-providers']) {
        queryClient.invalidateQueries({ queryKey: [key] })
      }
      toast.success(t('keys.importResult', { imported: data.imported, failed: data.total - data.imported }))
      onSuccess()
    },
  })

  const needsAccountId = platform === 'cloudflare'
  const needsBaseUrl = platform === 'modal'
  const isKeyless = PLATFORMS.find(p => p.value === platform)?.keyless ?? false
  // Cline authenticates by OAuth instead of a pasted key — the key field is
  // replaced by a "Connect Cline" button that starts the browser authorize
  // flow against api.cline.bot (POST /api/cline/oauth/start, then the
  // dashboard's /keys/cline/callback page completes the exchange).
  const isOAuth = PLATFORMS.find(p => p.value === platform)?.oauth ?? false
  const [oauthPending, setOauthPending] = useState(false)
  // The authorize URL, kept after a copy so repeated copies don't re-call
  // /start (each call mints a new pending state server-side).
  const [oauthUrl, setOauthUrl] = useState<string | null>(null)
  const startClineOAuth = useMutation({
    mutationFn: () =>
      apiFetch<{ authUrl: string; state: string }>('/api/cline/oauth/start', {
        method: 'POST',
        body: JSON.stringify({ redirectUri: window.location.origin }),
      }),
    onSuccess: (data) => {
      setOauthPending(true)
      // Full navigation: the authorize round-trip ends on the
      // /keys/cline/callback route, which completes the exchange and sends
      // the user back here.
      window.location.href = data.authUrl
    },
  })
  // Copy-instead-of-navigate variant: same /start call, but the authorize URL
  // lands on the clipboard so it can be opened in another browser / profile
  // (e.g. when the dashboard runs headless or on another machine).
  const copyClineOAuth = useMutation({
    mutationFn: async () => {
      if (oauthUrl) return { authUrl: oauthUrl }
      const data = await apiFetch<{ authUrl: string; state: string }>('/api/cline/oauth/start', {
        method: 'POST',
        body: JSON.stringify({ redirectUri: window.location.origin }),
      })
      setOauthUrl(data.authUrl)
      return data
    },
    onSuccess: async (data) => {
      const ok = await copyText(data.authUrl)
      if (ok) toast.success(t('keys.clineCopiedLink'))
      else toast.error(t('common.copyFailed'))
    },
  })
  // Cloudflare pairs each token with an account id, Modal pairs its proxy token
  // with a per-endpoint URL, and keyless providers have nothing to paste, so
  // none of them can take a list.
  const canPasteSeveral = !isKeyless && !needsAccountId && !needsBaseUrl && !isOAuth
  const severalMode = several && canPasteSeveral
  // One per line or comma-separated, deduped, blanks dropped.
  const keyList = severalMode
    ? [...new Set(apiKey.split(/[\n,]+/).map(s => s.trim()).filter(Boolean))]
    : []

  // Field-level validation: the submit stays clickable and reveals what is
  // missing instead of being silently disabled.
  const platformError = !platform ? t('validation.required') : null
  const keyError = severalMode
    ? (keyList.length === 0 ? t('validation.required') : null)
    : (!isKeyless && !isOAuth && !apiKey.trim() ? t('validation.required') : null)
  const accountIdError = needsAccountId && !accountId.trim() ? t('validation.required') : null
  const baseUrlError = needsBaseUrl && !baseUrl.trim() ? t('validation.required') : null
  const pending = addKey.isPending || addSeveral.isPending

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (platformError || keyError || accountIdError || baseUrlError) {
      setAddAttempted(true)
      return
    }
    setAddAttempted(false)
    if (severalMode) {
      addSeveral.mutate({
        keys: keyList.map(keyValue => ({ platform, keyValue, keyName: label || undefined })),
      })
      return
    }
    // Keyless providers submit an empty key; the backend stores a sentinel.
    const key = isKeyless ? '' : (needsAccountId ? `${accountId}:${apiKey}` : apiKey)
    addKey.mutate({ platform, key, label: label || undefined, baseUrl: needsBaseUrl ? baseUrl.trim() : undefined })
  }

  return (
    <div>
      <form onSubmit={handleSubmit} className="flex flex-wrap gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs">{t('keys.platform')}</Label>
          <ModelCombobox
            value={platform}
            options={platformOptions}
            onSelect={v => setPlatform(v as Platform)}
            ariaLabel={t('keys.platform')}
            triggerPlaceholder={t('keys.selectPlatform')}
            placeholder={t('keys.filterPlaceholder')}
            emptyText={t('keys.noFilterMatch')}
            align="start"
            ariaInvalid={addAttempted && !!platformError}
            triggerClassName={`flex h-8 w-[220px] items-center justify-between gap-2 whitespace-nowrap rounded-lg border bg-transparent px-3 text-sm outline-none transition-colors hover:bg-muted/50 focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 dark:bg-input/30 ${addAttempted && platformError ? 'border-destructive' : 'border-input'}`}
            header={
              <div className="flex items-center gap-2 border-b px-3 py-2">
                <input
                  id="hide-added-platforms"
                  type="checkbox"
                  checked={hideAdded}
                  onChange={e => setHideAdded(e.target.checked)}
                  className="size-3.5 accent-foreground"
                />
                <label htmlFor="hide-added-platforms" className="text-xs text-muted-foreground">
                  {t('keys.hideAdded')}
                </label>
              </div>
            }
          />
          {addAttempted && <FieldError error={platformError} />}
          {(() => {
            const sel = PLATFORMS.find(p => p.value === platform)
            return sel?.url ? <div className="pt-0.5"><GetKeyLink url={sel.url} /></div> : null
          })()}
        </div>
        {needsAccountId && (
          <div className="space-y-1.5">
            <Label className="text-xs">{t('keys.accountId')}</Label>
            <Input
              value={accountId}
              onChange={e => setAccountId(e.target.value)}
              placeholder="a1b2c3d4…"
              className="w-[200px] font-mono text-xs"
              aria-invalid={addAttempted && !!accountIdError}
            />
            {addAttempted && <FieldError error={accountIdError} />}
          </div>
        )}
        {needsBaseUrl && (
          <div className="space-y-1.5">
            <Label className="text-xs">{t('keys.endpointUrl')}</Label>
            <Input
              value={baseUrl}
              onChange={e => setBaseUrl(e.target.value)}
              placeholder="https://<workspace>--ep-<name>.modal.direct"
              className="w-[320px] font-mono text-xs"
              aria-invalid={addAttempted && !!baseUrlError}
            />
            {addAttempted && <FieldError error={baseUrlError} />}
          </div>
        )}
        <div className="space-y-1.5 flex-1 min-w-[240px]">
          {isOAuth ? (
            <>
              <Label className="text-xs">{t('keys.clineAccount')}</Label>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={startClineOAuth.isPending || oauthPending}
                  onClick={() => startClineOAuth.mutate()}
                >
                  {startClineOAuth.isPending || oauthPending ? t('keys.clineConnecting') : t('keys.clineConnect')}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={copyClineOAuth.isPending}
                  title={t('keys.clineCopyLinkHint')}
                  onClick={() => copyClineOAuth.mutate()}
                >
                  {copyClineOAuth.isPending ? t('keys.clineCopying') : t('keys.clineCopyLink')}
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">{t('keys.clineHint')}</p>
              {startClineOAuth.isError && (
                <p className="text-destructive text-xs">{((startClineOAuth.error) as Error).message}</p>
              )}
            </>
          ) : (
          <>
          <div className="flex items-center justify-between gap-2">
            <Label className="text-xs">{needsAccountId ? t('keys.apiToken') : t('keys.customApiKey')}</Label>
            {canPasteSeveral && (
              <button
                type="button"
                onClick={() => setSeveral(v => !v)}
                className={`text-[11px] underline-offset-2 hover:underline ${severalMode ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {t('keys.pasteSeveral')}
              </button>
            )}
          </div>
          {severalMode ? (
            <Textarea
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              placeholder={'gsk_first…\ngsk_second…'}
              rows={3}
              className="font-mono text-xs"
              aria-invalid={addAttempted && !!keyError}
            />
          ) : (
            <Input
              type="password"
              value={isKeyless ? '' : apiKey}
              onChange={e => setApiKey(e.target.value)}
              placeholder={isKeyless ? t('keys.noKeyNeededPlaceholder') : (needsAccountId ? t('keys.bearerTokenPlaceholder') : t('keys.pasteKeyPlaceholder'))}
              className="font-mono text-xs"
              disabled={isKeyless}
              aria-invalid={addAttempted && !!keyError}
            />
          )}
          {addAttempted && <FieldError error={keyError} />}
          {isKeyless && (
            <p className="text-[11px] text-muted-foreground">
              {t('keys.keylessHint')}
            </p>
          )}
          </>
          )}
        </div>
        {!isOAuth && (
        <div className="space-y-1.5">
          <Label className="text-xs">{t('keys.label')}</Label>
          <div className="flex flex-wrap items-center space-x-3">
            <Input
              value={label}
              onChange={e => setLabel(e.target.value)}
              placeholder={t('keys.customDisplayNameOptional')}
              className="w-[160px]"
            />
            <Button type="submit" size="sm" disabled={pending}>
              {pending
                ? t('keys.adding')
                : severalMode && keyList.length > 1
                  ? t('keys.importSelected', { count: keyList.length })
                  : isKeyless ? t('keys.enable') : t('keys.addKey')}
            </Button>
          </div>
        </div>
        )}
      </form>
      {(addKey.isError || addSeveral.isError) && (
        <p className="text-destructive text-xs mt-2">{((addKey.error ?? addSeveral.error) as Error).message}</p>
      )}
    </div>
  )
}
