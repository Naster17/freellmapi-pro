import { useState } from 'react'
import { X } from 'lucide-react'
import { Dialog, DialogClose, DialogPopup, DialogTitle } from '@/components/ui/dialog'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { useI18n } from '@/i18n'
import type { Platform } from '../../../../shared/types'
import { AddKeyForm } from './add-key-form'
import { ImportKeysSection } from './import-keys-section'
import { CustomProviderSection } from './custom-provider-section'

type Pane = 'provider' | 'import' | 'custom'

// The single "Add key" surface: one dialog, three panes (paste a provider key,
// import a file, or point at a custom OpenAI-compatible endpoint). Each pane
// keeps its own mutation and asks the dialog to close on success.
// `initialPlatform` preselects a provider in the "Provider key" pane, for
// entry points like the checklist chips that already name the provider.
export function AddKeyDialog({ open, onOpenChange, initialPlatform }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialPlatform?: Platform
}) {
  const { t } = useI18n()
  const [pane, setPane] = useState<Pane>('provider')
  const close = () => onOpenChange(false)

  // The pane sticks across opens (reopening to import twice should not reset
  // it), but a provider-specific entry point must land on the provider pane
  // or the preselection would be invisible. Adjusted during render (not in an
  // effect) so the first open paints the right pane.
  const [prevOpen, setPrevOpen] = useState(open)
  if (open !== prevOpen) {
    setPrevOpen(open)
    if (open && initialPlatform) setPane('provider')
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup maxWidth="max-w-3xl">
        <div className="mb-4 flex items-center justify-between gap-4">
          <DialogTitle>{t('keys.addKey')}</DialogTitle>
          <DialogClose
            aria-label={t('common.dismiss')}
            className="-mr-1 rounded-lg p-1 text-muted-foreground/70 transition-colors outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            <X className="size-4" />
          </DialogClose>
        </div>

        <SegmentedControl
          value={pane}
          onValueChange={setPane}
          options={[
            { value: 'provider', label: t('keys.paneProviderKey') },
            { value: 'import', label: t('keys.paneImportFile') },
            { value: 'custom', label: t('keys.paneCustomEndpoint') },
          ]}
          ariaLabel={t('keys.addKey')}
          className="mb-5"
        />

        {pane === 'provider' && <AddKeyForm onSuccess={close} initialPlatform={initialPlatform} />}
        {pane === 'import' && <ImportKeysSection onImported={close} />}
        {pane === 'custom' && <CustomProviderSection onAdded={close} />}
      </DialogPopup>
    </Dialog>
  )
}
