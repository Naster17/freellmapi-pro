import { useState, useRef, useEffect, useCallback } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch, getToken } from '@/lib/api'
import {
  DropdownMenuCheckboxItem,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from '@/components/ui/dropdown-menu'
import type { Platform } from '../../../shared/types'
import { Download, Upload } from 'lucide-react'
import { useI18n } from '@/i18n'

const KEYS_EXPORT_FORMAT = 'freellmapi-keys-v1'
const DEDUPE_STORAGE_KEY = 'freellmapi.keys.dedupeByLabel'
const SUMMARY_DISMISS_MS = 6000

interface KeysExportPayload {
  format: string
  exportedAt: string
  count: number
  keys: Array<{
    platform: Platform
    key?: string
    label?: string
    enabled?: boolean
    baseUrl?: string
    models?: Array<{ kind: 'chat' | 'embedding' | 'image' | 'audio'; modelId: string; displayName: string; family?: string | null }>
  }>
}

interface ImportResult {
  imported: number
  skipped: number
  failed: number
  fileName: string
}

function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export function KeysImportExportSub() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const fileRef = useRef<HTMLInputElement>(null)
  const [dedupe, setDedupe] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true
    const stored = localStorage.getItem(DEDUPE_STORAGE_KEY)
    return stored === null ? true : stored === 'true'
  })
  const [result, setResult] = useState<ImportResult | null>(null)
  const [importError, setImportError] = useState<string | null>(null)

  useEffect(() => {
    localStorage.setItem(DEDUPE_STORAGE_KEY, String(dedupe))
  }, [dedupe])

  useEffect(() => {
    if (!result) return
    const timer = setTimeout(() => setResult(null), SUMMARY_DISMISS_MS)
    return () => clearTimeout(timer)
  }, [result])

  const exportMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`${import.meta.env.BASE_URL.replace(/\/$/, '')}/api/keys/export`, {
        headers: getToken() ? { Authorization: `Bearer ${getToken()}` } : {},
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: { message: res.statusText } }))
        throw new Error(body.error?.message ?? `HTTP ${res.status}`)
      }
      return (await res.json()) as KeysExportPayload
    },
    onSuccess: (payload) => {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      downloadJson(`freellmapi-keys-${stamp}.json`, payload)
    },
  })

  const importMutation = useMutation({
    mutationFn: async ({ file, dedupeByLabel }: { file: File; dedupeByLabel: boolean }) => {
      const text = await file.text()
      let parsed: unknown
      try {
        parsed = JSON.parse(text)
      } catch {
        throw new Error('File is not valid JSON')
      }
      const payload = parsed as Partial<KeysExportPayload>
      if (!payload || typeof payload !== 'object' || !Array.isArray(payload.keys)) {
        throw new Error('File does not look like a keys export (missing "keys" array)')
      }
      if (payload.format && payload.format !== KEYS_EXPORT_FORMAT) {
        throw new Error(`Unsupported format '${payload.format}' (expected '${KEYS_EXPORT_FORMAT}')`)
      }
      return apiFetch<ImportResult>('/api/keys/import', {
        method: 'POST',
        body: JSON.stringify({ format: payload.format, keys: payload.keys, dedupeByLabel }),
      })
    },
    onSuccess: (summary, vars) => {
      setImportError(null)
      setResult({ ...summary, fileName: vars.file.name })
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      queryClient.invalidateQueries({ queryKey: ['models'] })
      queryClient.invalidateQueries({ queryKey: ['embeddings'] })
      queryClient.invalidateQueries({ queryKey: ['media'] })
    },
    onError: (err) => {
      setImportError(err instanceof Error ? err.message : 'Import failed')
    },
  })

  const handleFileChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setImportError(null)
    importMutation.mutate({ file, dedupeByLabel: dedupe })
  }, [dedupe, importMutation])

  const busy = exportMutation.isPending || importMutation.isPending

  return (
    <>
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={handleFileChange}
      />
      <DropdownMenuSub>
        <DropdownMenuSubTrigger>
          <span>{t('keys.importExport')}</span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          <DropdownMenuItem onClick={() => exportMutation.mutate()} disabled={busy} className="gap-2">
            <Download className="size-3.5" />
            <span>{exportMutation.isPending ? t('keys.exporting') : t('keys.exportKeys')}</span>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => fileRef.current?.click()} disabled={busy} className="gap-2">
            <Upload className="size-3.5" />
            <span>{importMutation.isPending ? t('keys.importing') : t('keys.importKeys')}</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuCheckboxItem
            checked={dedupe}
            onCheckedChange={(v) => setDedupe(v === true)}
            disabled={busy}
          >
            <span className="text-sm">{t('keys.dedupeByLabel')}</span>
          </DropdownMenuCheckboxItem>
          <DropdownMenuItem disabled className="text-muted-foreground">
            <span className="text-[11px] leading-snug">{t('keys.importExportHint')}</span>
          </DropdownMenuItem>
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      {result && (
        <div className="fixed bottom-4 right-4 z-50 rounded-xl border bg-card px-4 py-3 text-sm shadow-lg">
          <div className="flex items-center gap-3">
            <span className="font-medium">{result.fileName}</span>
            <span className="text-muted-foreground">
              {t('keys.importSummary', {
                imported: result.imported,
                skipped: result.skipped,
                failed: result.failed,
                total: result.imported + result.skipped + result.failed,
              })}
            </span>
            <button onClick={() => setResult(null)} className="ml-2 text-muted-foreground hover:text-foreground text-xs">
              {t('common.discard')}
            </button>
          </div>
        </div>
      )}
      {importError && (
        <div className="fixed bottom-4 right-4 z-50 rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm shadow-lg">
          <div className="flex items-center gap-3">
            <span className="text-destructive font-medium">{t('keys.importFailed')}</span>
            <span className="text-destructive/80">{importError}</span>
            <button onClick={() => setImportError(null)} className="ml-2 text-destructive/80 hover:text-destructive text-xs">
              {t('common.discard')}
            </button>
          </div>
        </div>
      )}
    </>
  )
}
