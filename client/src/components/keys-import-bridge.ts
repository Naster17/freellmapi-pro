export interface ImportApi {
  open: () => void
}

let _openImport: (() => void) | null = null

export function registerImportApi(api: ImportApi) {
  _openImport = api.open
}

export function unregisterImportApi(api: ImportApi) {
  if (_openImport === api.open) _openImport = null
}

export function openImportPicker() {
  _openImport?.()
}
