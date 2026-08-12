import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { ImportKey, ImportSelectedResponse, Platform, PreviewKey, PreviewResponse } from '../../../../shared/types'
import { Eye, EyeOff, FileSearch, Loader2, Upload } from 'lucide-react'
import { useI18n } from '@/i18n'
import { toast } from '@/lib/toast'
import { CUSTOM_GROUP, PLATFORMS } from './shared'

interface ImportRow extends PreviewKey {
  selected: boolean
  platform: Platform | ''
  visible: boolean
  isDuplicate: boolean
}

// Always rendered inside the Add key dialog: no outer section chrome/heading.
// `onImported` lets that dialog close (and surface a result toast) once a batch
// import succeeds.
export function ImportKeysSection({ onImported }: { onImported?: () => void } = {}) {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [files, setFiles] = useState<File[]>([])
  const [rows, setRows] = useState<ImportRow[]>([])
  const [skipped, setSkipped] = useState<string[]>([])

  // 'custom' is not one of PLATFORMS — it is configured through its own form,
  // so it is deliberately absent from the generic provider dropdown. An
  // imported row is the one case where it belongs there: the file already
  // names the endpoint, and without the option the row can never be selected
  // and the endpoint can never be restored (#687).
  const importablePlatforms = [...PLATFORMS.filter(p => !p.keyless), CUSTOM_GROUP]

  function platformFromPreview(key: PreviewKey): Platform | '' {
    // A custom row is only importable with its base URL; there is nowhere to
    // route it otherwise.
    if (key.detectedPlatform === 'custom') return key.baseUrl ? 'custom' : ''
    return importablePlatforms.some(p => p.value === key.detectedPlatform)
      ? key.detectedPlatform as Platform
      : ''
  }

  const preview = useMutation({
    meta: { silenceToast: true },
    mutationFn: async (nextFiles: File[]) => {
      const formData = new FormData()
      nextFiles.forEach(file => formData.append('files', file))
      return apiFetch<PreviewResponse>('/api/keys/preview', { method: 'POST', body: formData })
    },
    onSuccess: (data) => {
      setRows(data.keys.map(key => {
        const detected = platformFromPreview(key)
        return {
          ...key,
          platform: detected,
          selected: detected !== '' && !key.isDuplicate,
          visible: false,
          isDuplicate: key.isDuplicate ?? false,
        }
      }))
      setSkipped(data.skipped)
    },
  })

  const importSelected = useMutation({
    meta: { silenceToast: true },
    mutationFn: (keys: ImportKey[]) =>
      apiFetch<ImportSelectedResponse>('/api/keys/import-selected', {
        method: 'POST',
        body: JSON.stringify({ keys }),
      }),
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['keys'] })
      queryClient.invalidateQueries({ queryKey: ['health'] })
      queryClient.invalidateQueries({ queryKey: ['fallback'] })
      queryClient.invalidateQueries({ queryKey: ['keys-providers'] })
      // The dialog closes on success, so surface the imported/failed counts as
      // a toast.
      if (onImported) {
        toast.success((data.modelsRegistered ?? 0) > 0
          ? t('keys.importResultWithModels', { imported: data.imported, models: data.modelsRegistered, failed: data.errors.length })
          : t('keys.importResult', { imported: data.imported, failed: data.errors.length }))
        onImported()
      }
    },
  })

  const selectedKeys: ImportKey[] = rows
    .filter(row => row.selected && row.platform && row.keyValue.trim())
    .map(row => ({
      keyName: row.keyName,
      keyValue: row.keyValue,
      platform: row.platform,
      ...(row.baseUrl ? { baseUrl: row.baseUrl } : {}),
      ...(row.models?.length ? { models: row.models } : {}),
    }))

  const selectableRows = rows.filter(row => !row.isDuplicate)
  const allSelected = selectableRows.length > 0 && selectableRows.every(row => row.selected)
  const duplicatesCount = rows.filter(row => row.isDuplicate).length

  function toggleAll() {
    setRows(prev => prev.map(row => (row.isDuplicate ? row : { ...row, selected: !allSelected })))
  }

  function updateRow(index: number, patch: Partial<ImportRow>) {
    setRows(prev => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)))
  }

  function chooseFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const nextFiles = Array.from(e.target.files ?? [])
    setFiles(nextFiles)
    setRows([])
    setSkipped([])
    preview.reset()
    importSelected.reset()
    preview.mutate(nextFiles)
  }

  return (
    <div className="flex flex-col overflow-hidden rounded-2xl border bg-card">
      <div className="border-b p-4">
        <p className="text-xs text-muted-foreground">{t('keys.importKeysDescription')}</p>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <div className="min-w-[220px] flex-1 space-y-1.5">
            <Label className="text-xs">{t('keys.importFiles')}</Label>
            <Input
              type="file"
              multiple
              accept=".env,.json,.jsonc,.md,.txt,.csv"
              onChange={chooseFiles}
              className="cursor-pointer text-xs file:mr-3 file:rounded-lg file:border-0 file:bg-foreground file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-background file:transition-opacity hover:file:opacity-90"
            />
          </div>
          {files.length > 0 && (
            <span className="pb-1.5 text-xs text-muted-foreground tabular-nums">
              {t('keys.importFileCount', { count: files.length })}
            </span>
          )}
        </div>
      </div>

      {preview.isPending && (
        <p className="flex items-center gap-2 border-b px-4 py-2.5 text-xs text-muted-foreground">
          <Loader2 className="size-3 animate-spin" />
          {t('keys.previewing')}
        </p>
      )}

      {preview.isError && (
        <p className="border-b px-4 py-2.5 text-xs text-destructive">{(preview.error as Error).message}</p>
      )}

      {skipped.length > 0 && (
        <p className="border-b px-4 py-2.5 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{t('keys.skippedItems')}</span>
          <span> {skipped.slice(0, 5).join(', ')}</span>
          {skipped.length > 5 && <span> {t('keys.moreItems', { count: skipped.length - 5 })}</span>}
        </p>
      )}

      {rows.length > 0 && (
        <>
          <div className="max-h-[min(50vh,26rem)] overflow-y-auto">
            <Table className="table-fixed">
              <TableHeader className="sticky top-0 z-10 bg-card">
                <TableRow>
                  <TableHead className="w-9">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleAll}
                      disabled={selectableRows.length === 0}
                      aria-label={t('keys.selected')}
                      className="size-4 accent-primary"
                    />
                  </TableHead>
                  <TableHead className="w-32">{t('keys.provider')}</TableHead>
                  <TableHead className="w-36">{t('keys.keyName')}</TableHead>
                  <TableHead>{t('keys.keyValue')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row, index) => (
                  <TableRow key={`${row.keyName}:${index}`} className={row.isDuplicate ? 'bg-muted/50' : ''}>
                    <TableCell>
                      <input
                        type="checkbox"
                        checked={row.selected}
                        disabled={row.isDuplicate}
                        onChange={() => updateRow(index, { selected: !row.selected })}
                        className="size-4 accent-primary"
                      />
                    </TableCell>
                    <TableCell>
                      <Select
                        value={row.platform}
                        onValueChange={(value) => updateRow(index, { platform: value as Platform, selected: true })}
                      >
                        <SelectTrigger className="w-full min-w-0 text-xs">
                          <SelectValue placeholder={t('keys.chooseProvider')} />
                        </SelectTrigger>
                        <SelectContent>
                          {importablePlatforms.map(p => (
                            <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>
                      <div className="flex min-w-0 flex-col gap-1">
                        <Input
                          value={row.keyName}
                          onChange={e => updateRow(index, { keyName: e.target.value })}
                          className="w-full min-w-0 font-mono text-xs"
                        />
                        <div className="flex gap-1">
                          {row.isDuplicate && (
                            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                              {t('keys.duplicate')}
                            </span>
                          )}
                          {(row.models?.length ?? 0) > 0 && (
                            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                              {t('keys.importModelCount', { count: row.models!.length })}
                            </span>
                          )}
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex min-w-0 items-center gap-1">
                        <Input
                          type={row.visible ? 'text' : 'password'}
                          value={row.keyValue}
                          onChange={e => updateRow(index, { keyValue: e.target.value })}
                          className="w-full min-w-0 font-mono text-xs"
                        />
                        <Button
                          type="button"
                          variant="ghost"
                          size="xs"
                          className="size-7 shrink-0 p-0"
                          onClick={() => updateRow(index, { visible: !row.visible })}
                          title={row.visible ? t('common.hide') : t('common.show')}
                        >
                          {row.visible ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 border-t bg-muted/30 px-4 py-3">
            <div className="min-w-0">
              <p className="text-xs text-foreground tabular-nums">
                {t('keys.importSelectionSummary', { selected: selectedKeys.length, total: rows.length })}
              </p>
              {duplicatesCount > 0 && (
                <p className="mt-0.5 text-[11px] text-amber-600 dark:text-amber-400">
                  {t('keys.duplicatesFound', { count: duplicatesCount })}
                </p>
              )}
            </div>
            <Button
              type="button"
              size="sm"
              className="gap-1.5"
              onClick={() => importSelected.mutate(selectedKeys)}
              disabled={selectedKeys.length === 0 || importSelected.isPending}
            >
              {importSelected.isPending ? (
                <><Loader2 className="size-3.5 animate-spin" />{t('keys.importing')}</>
              ) : (
                <><Upload className="size-3.5" />{t('keys.importSelected', { count: selectedKeys.length })}</>
              )}
            </Button>
          </div>

          {importSelected.isError && (
            <p className="border-t px-4 py-2.5 text-xs text-destructive">{(importSelected.error as Error).message}</p>
          )}
        </>
      )}

      {rows.length === 0 && preview.isSuccess && (
        <div className="flex flex-col items-center px-4 py-12 text-center">
          <FileSearch className="size-6 text-muted-foreground" />
          <p className="mt-2 text-xs text-muted-foreground">{t('keys.noPreviewKeys')}</p>
        </div>
      )}
    </div>
  )
}
