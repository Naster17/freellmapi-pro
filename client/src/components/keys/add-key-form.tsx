import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { FieldError } from '@/components/ui/field-error'
import type { Platform } from '../../../../shared/types'
import { useI18n } from '@/i18n'
import { toast } from '@/lib/toast'
import { GetKeyLink, PLATFORMS } from './shared'

// The "Provider key" pane of the Add key dialog: paste a credential for a known
// provider. Extracted verbatim from the old inline KeysPage form so all field
// validation, the keyless/Cloudflare special cases, and the POST /api/keys
// mutation stay identical. On success it toasts and asks the dialog to close.
export function AddKeyForm({ onSuccess }: { onSuccess: () => void }) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [platform, setPlatform] = useState<Platform | ''>('')
  const [apiKey, setApiKey] = useState('')
  const [accountId, setAccountId] = useState('')
  const [label, setLabel] = useState('')
  const [addAttempted, setAddAttempted] = useState(false)
  // Several credentials for one provider in one go (#705). Pooling keys is the
  // point of this app, and the only bulk path was the file importer, so anyone
  // holding five Groq keys reopened this dialog five times. Off by default: the
  // single-key field masks what you type, and a textarea cannot.
  const [several, setSeveral] = useState(false)

  const addKey = useMutation({
    meta: { silenceToast: true },
    mutationFn: (body: { platform: string; key: string; label?: string }) =>
      apiFetch<{ notice?: string | null }>('/api/keys', { method: 'POST', body: JSON.stringify(body) }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
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
      for (const key of ['keys', 'health', 'fallback']) {
        queryClient.invalidateQueries({ queryKey: [key] })
      }
      toast.success(t('keys.importResult', { imported: data.imported, failed: data.total - data.imported }))
      onSuccess()
    },
  })

  const needsAccountId = platform === 'cloudflare'
  const isKeyless = PLATFORMS.find(p => p.value === platform)?.keyless ?? false
  // Cloudflare pairs each token with an account id, and keyless providers have
  // nothing to paste, so neither can take a list.
  const canPasteSeveral = !isKeyless && !needsAccountId
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
    : (!isKeyless && !apiKey.trim() ? t('validation.required') : null)
  const accountIdError = needsAccountId && !accountId.trim() ? t('validation.required') : null
  const pending = addKey.isPending || addSeveral.isPending

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (platformError || keyError || accountIdError) {
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
    addKey.mutate({ platform, key, label: label || undefined })
  }

  return (
    <div>
      <form onSubmit={handleSubmit} className="flex flex-wrap gap-3">
        <div className="space-y-1.5">
          <Label className="text-xs">{t('keys.platform')}</Label>
          <Select value={platform} onValueChange={(v) => setPlatform(v as Platform)}>
            <SelectTrigger className="w-[220px]" aria-invalid={addAttempted && !!platformError}>
              <SelectValue placeholder={t('keys.selectPlatform')} />
            </SelectTrigger>
            <SelectContent>
              {PLATFORMS.map(p => (
                <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
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
        <div className="space-y-1.5 flex-1 min-w-[240px]">
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
        </div>
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
      </form>
      {(addKey.isError || addSeveral.isError) && (
        <p className="text-destructive text-xs mt-2">{((addKey.error ?? addSeveral.error) as Error).message}</p>
      )}
    </div>
  )
}
