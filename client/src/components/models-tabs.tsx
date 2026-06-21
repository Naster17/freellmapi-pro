import { NavLink } from 'react-router-dom'
import { useI18n } from '@/i18n'

// Segmented Chat | Embeddings | Fusion switcher shared by the Models pages.
// Industry-standard layout: one "Models" section, modality as a tab — chat
// routing (cross-model fallback), embeddings routing (same-model,
// cross-provider fallback), and fusion (multi-model synthesis) are different
// machines behind one roof.
export function ModelsTabs() {
  const { t } = useI18n()
  const tab = (isActive: boolean) =>
    `inline-flex min-w-0 items-center justify-center gap-1 whitespace-nowrap rounded-lg px-1 py-1.5 text-[11px] transition-colors sm:flex-none sm:gap-1.5 sm:px-3 sm:text-xs ${
      isActive ? 'bg-foreground text-background font-medium' : 'text-muted-foreground hover:text-foreground hover:bg-muted'
    }`
  return (
    <div className="grid w-full grid-cols-5 gap-1 rounded-xl border p-1 sm:inline-flex sm:w-auto">
      <NavLink to="/models/chat" className={({ isActive }) => tab(isActive)}>{t('models.chatModelsTab')}</NavLink>
      <NavLink to="/models/image" className={({ isActive }) => tab(isActive)}>{t('models.imageTab')}</NavLink>
      <NavLink to="/models/audio" className={({ isActive }) => tab(isActive)}>{t('models.audioTab')}</NavLink>
      <NavLink to="/models/embeddings" className={({ isActive }) => tab(isActive)}>{t('models.embeddingsTab')}</NavLink>
      <NavLink to="/models/fusion" className={({ isActive }) => tab(isActive)}>
        {({ isActive }) => (
          <>
            {t('models.fusionTab')}
            <span className={`rounded px-0.5 py-0.5 text-[8px] font-semibold uppercase leading-none tracking-wide sm:px-1 sm:text-[9px] ${
              isActive ? 'bg-background/20 text-background' : 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
            }`}>
              {t('models.newBadge')}
            </span>
          </>
        )}
      </NavLink>
    </div>
  )
}
