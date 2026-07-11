import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react'
import { BrowserRouter, Routes, Route, Navigate, NavLink, Link, useLocation, useNavigate } from 'react-router-dom'
import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ChevronDown, FileText, Languages, Menu, MoreHorizontal, Moon, Search, Settings, Sun } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { AuthGate } from '@/components/auth-gate'
import { CommandPalette, openCommandPalette } from '@/components/command-palette'
import { ErrorBoundary } from '@/components/error-boundary'
import { KeysImportExportSub, KeysImportHost } from '@/components/keys-import-export-menu'
import { Toaster } from '@/components/toaster'
import { I18nProvider, useI18n, SUPPORTED_LOCALES, type Locale } from '@/i18n'
import { logout } from '@/lib/api'
import { toast } from '@/lib/toast'

const KeysPage = lazy(() => import('@/pages/KeysPage'))
const PlaygroundPage = lazy(() => import('@/pages/PlaygroundPage'))
const FallbackPage = lazy(() => import('@/pages/FallbackPage'))
const ModelDetailPage = lazy(() => import('@/pages/ModelDetailPage'))
const FusionPage = lazy(() => import('@/pages/FusionPage'))
const EmbeddingsPage = lazy(() => import('@/pages/EmbeddingsPage'))
const EmbeddingDetailPage = lazy(() => import('@/pages/EmbeddingDetailPage'))
const ImagePage = lazy(() => import('@/pages/ImagePage'))
const AudioPage = lazy(() => import('@/pages/AudioPage'))
const MediaDetailPage = lazy(() => import('@/pages/MediaDetailPage'))
const AnalyticsPage = lazy(() => import('@/pages/AnalyticsPage'))
const LogsPage = lazy(() => import('@/pages/LogsPage'))
const UsageLimitsPage = lazy(() => import('@/pages/UsageLimitsPage'))
const CatalogPage = lazy(() => import('@/pages/PremiumPage'))
const SettingsPage = lazy(() => import('@/pages/SettingsPage'))
const NotFoundPage = lazy(() => import('@/pages/NotFoundPage'))

// Every failed mutation surfaces as an error toast, so no action fails
// silently. A page that already shows the failure inline can opt out with
// `meta: { silenceToast: true }` on the mutation.
const queryClient = new QueryClient({
  mutationCache: new MutationCache({
    onError: (error, _variables, _context, mutation) => {
      if (mutation.meta?.silenceToast) return
      toast.error(error instanceof Error ? error.message : String(error))
    },
  }),
})

const navItems = [
  { to: '/models', labelKey: 'nav.models' },
  { to: '/keys', labelKey: 'nav.keys' },
  { to: '/analytics', labelKey: 'nav.analytics' },
  { to: '/usage-limits', labelKey: 'nav.usageLimits' },
  { to: '/catalog', labelKey: 'nav.premium' },
  { to: '/playground', labelKey: 'nav.playground' },
]

type OverflowItem = {
  to: string
  labelKey: string
  icon?: typeof Settings
}

const overflowItems: OverflowItem[] = [
  { to: '/settings', labelKey: 'nav.settings', icon: Settings },
  { to: '/logs', labelKey: 'nav.logs', icon: FileText },
]

// The five modality pages behind "Models"; surfaced in the nav dropdown and
// the mobile submenu so Fusion/Embeddings/Image/Audio are discoverable without
// first landing on the chat table.
const modelItems = [
  { to: '/models/chat', labelKey: 'models.chatModelsTab' },
  { to: '/models/embeddings', labelKey: 'models.embeddingsTab' },
  { to: '/models/image', labelKey: 'models.imageTab' },
  { to: '/models/audio', labelKey: 'models.audioTab' },
  { to: '/models/fusion', labelKey: 'models.fusionTab' },
]

const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform)

declare global {
  interface Window {
    __FREEAPI_DESKTOP__?: boolean
  }
}

function getPreferredDarkMode() {
  if (typeof window === 'undefined') {
    return false
  }

  const stored = localStorage.getItem('theme')
  return stored === 'dark' || (!stored && window.matchMedia('(prefers-color-scheme: dark)').matches)
}

function NavItem({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `relative text-sm px-1 py-4 transition-colors ${
          isActive
            ? 'text-foreground after:absolute after:inset-x-0 after:-bottom-px after:h-px after:bg-foreground'
            : 'text-muted-foreground hover:text-foreground'
        }`
      }
    >
      {children}
    </NavLink>
  )
}

function useDarkMode() {
  const [dark, setDark] = useState(getPreferredDarkMode)

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark)
  }, [dark])

  function toggle() {
    setDark((current) => {
      const next = !current
      localStorage.setItem('theme', next ? 'dark' : 'light')
      return next
    })
  }

  return { dark, toggle }
}

function Brand() {
  return (
    <Link to="/" className="flex items-center gap-2.5 transition-opacity hover:opacity-70">
      <span className="inline-block size-2 rounded-full bg-foreground shadow-sm shadow-foreground/20" />
      <span className="text-sm font-semibold tracking-tight">FreeLLMAPI</span>
    </Link>
  )
}

// True when the dashboard runs inside the desktop shell (Electron preload
// sets this). The navbar then doubles as the window title bar: draggable,
// padded for the macOS traffic lights, and without the web-only Sign out.
const isDesktopApp = typeof window !== 'undefined' && window.__FREEAPI_DESKTOP__ === true

if (isDesktopApp) {
  document.documentElement.classList.add('desktop')
}

function LanguageSubMenu() {
  const { locale, setLocale, t } = useI18n()
  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger className="gap-2">
        <Languages className="size-4" />
        <span>{t('nav.language')}</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent>
        <DropdownMenuRadioGroup value={locale} onValueChange={(v) => setLocale(v as Locale)}>
          {SUPPORTED_LOCALES.map((code) => (
            <DropdownMenuRadioItem key={code} value={code}>
              {t(`languages.${code}`)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  )
}

function Navbar() {
  const { dark, toggle } = useDarkMode()
  const { t } = useI18n()
  const location = useLocation()
  const navigate = useNavigate()

  function isActiveRoute(to: string) {
    return location.pathname === to
  }

  return (
    <header
      className={`sticky top-0 z-40 border-b backdrop-blur ${isDesktopApp ? 'bg-background/45' : 'bg-background/80'}`}
      style={isDesktopApp ? ({ WebkitAppRegion: 'drag' } as React.CSSProperties) : undefined}
    >
      <div
        className={`mx-auto flex min-h-[56px] max-w-6xl items-center px-4 sm:min-h-0 sm:px-6 ${isDesktopApp ? 'pl-20 sm:pl-20' : ''}`}
        style={isDesktopApp ? { minHeight: 52 } : undefined}
      >
        <Brand />
        <nav
          className="ml-10 hidden items-center gap-6 md:flex"
          style={isDesktopApp ? ({ WebkitAppRegion: 'no-drag' } as React.CSSProperties) : undefined}
        >
          {navItems.map((item) =>
            item.to === '/models' ? (
              <div key={item.to} className="flex items-center gap-0.5">
                <NavItem to={item.to}>{t(item.labelKey)}</NavItem>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    aria-label={t('nav.modelsMenu')}
                    className="rounded-md p-1 text-muted-foreground transition-colors hover:text-foreground"
                  >
                    <ChevronDown className="size-3.5" />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="w-44">
                    {modelItems.map((m) => (
                      <DropdownMenuItem key={m.to} onClick={() => navigate(m.to)}>
                        {t(m.labelKey)}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ) : (
              <NavItem key={item.to} to={item.to}>
                {t(item.labelKey)}
              </NavItem>
            ),
          )}
        </nav>
        <div
          className="ml-auto hidden items-center gap-1 md:flex"
          style={isDesktopApp ? ({ WebkitAppRegion: 'no-drag' } as React.CSSProperties) : undefined}
        >
          <button
            type="button"
            onClick={openCommandPalette}
            aria-label={t('palette.title')}
            className={buttonVariants({ variant: 'ghost', size: 'sm' })}
          >
            <Search className="size-3.5" />
            <kbd className="text-[10px] text-muted-foreground">{isMac ? '⌘K' : 'Ctrl K'}</kbd>
          </button>
          <DropdownMenu>
            <DropdownMenuTrigger
              className={buttonVariants({ variant: 'ghost', size: 'icon' })}
              aria-label={t('nav.openMenu')}
            >
              <MoreHorizontal />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              <KeysImportExportSub />
              <DropdownMenuItem onClick={toggle} className="gap-2">
                {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
                <span>{t('nav.theme')}</span>
              </DropdownMenuItem>
              {overflowItems.map((item) => {
                const Icon = item.icon
                return (
                  <DropdownMenuItem
                    key={item.to}
                    onClick={() => navigate(item.to)}
                    className={isActiveRoute(item.to) ? 'bg-accent text-accent-foreground font-medium gap-2' : 'gap-2'}
                  >
                    {Icon && <Icon className="size-4" />}
                    {t(item.labelKey)}
                  </DropdownMenuItem>
                )
              })}
              <DropdownMenuSeparator />
              <LanguageSubMenu />
              {!isDesktopApp && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => logout()}>{t('nav.signOut')}</DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        <div className="ml-auto flex items-center md:hidden">
          <DropdownMenu>
            <DropdownMenuTrigger
              className={buttonVariants({ variant: 'ghost', size: 'icon', className: 'size-10 rounded-xl text-muted-foreground hover:bg-muted/70 hover:text-foreground' })}
              aria-label={t('nav.openMenu')}
            >
              <Menu className="size-5" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuGroup>
                {navItems.map((item) =>
                  item.to === '/models' ? (
                    <DropdownMenuSub key={item.to}>
                      <DropdownMenuSubTrigger
                        className={location.pathname.startsWith('/models') ? 'bg-accent text-accent-foreground font-medium' : undefined}
                      >
                        {t(item.labelKey)}
                      </DropdownMenuSubTrigger>
                      <DropdownMenuSubContent>
                        {modelItems.map((m) => (
                          <DropdownMenuItem key={m.to} onClick={() => navigate(m.to)}>
                            {t(m.labelKey)}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuSubContent>
                    </DropdownMenuSub>
                  ) : (
                    <DropdownMenuItem
                      key={item.to}
                      onClick={() => navigate(item.to)}
                      className={isActiveRoute(item.to) ? 'bg-accent text-accent-foreground font-medium' : undefined}
                    >
                      {t(item.labelKey)}
                    </DropdownMenuItem>
                  ),
                )}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <KeysImportExportSub />
                <DropdownMenuItem onClick={toggle} className="gap-2">
                  {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
                  <span>{t('nav.theme')}</span>
                </DropdownMenuItem>
                {overflowItems.map((item) => {
                  const Icon = item.icon
                  return (
                    <DropdownMenuItem
                      key={item.to}
                      onClick={() => navigate(item.to)}
                      className={isActiveRoute(item.to) ? 'bg-accent text-accent-foreground font-medium gap-2' : 'gap-2'}
                    >
                      {Icon && <Icon className="size-4" />}
                      {t(item.labelKey)}
                    </DropdownMenuItem>
                  )
                })}
                <LanguageSubMenu />
                {!isDesktopApp && (
                  <DropdownMenuItem onClick={() => logout()}>{t('nav.signOut')}</DropdownMenuItem>
                )}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  )
}

function RouteFallback() {
  const { t } = useI18n()
  return <p className="text-sm text-muted-foreground" role="status">{t('common.loading')}</p>
}

function RouteAnnouncer() {
  const location = useLocation()
  const { t } = useI18n()
  const active = navItems.find(item => location.pathname.startsWith(item.to))
  const label = active ? t(active.labelKey) : 'FreeLLMAPI'
  return (
    <div className="sr-only" aria-live="polite" aria-atomic="true">
      {label}
    </div>
  )
}

function PageBoundary({ children }: { children: ReactNode }) {
  const location = useLocation()
  return <ErrorBoundary key={location.pathname}>{children}</ErrorBoundary>
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <I18nProvider>
      <BrowserRouter basename={import.meta.env.BASE_URL}>
        <AuthGate>
          <div className={`min-h-screen ${isDesktopApp ? 'desktop-backdrop' : 'bg-background'}`}>
            <Navbar />
            <KeysImportHost />
            <RouteAnnouncer />
            <main id="main-content" className="mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8" tabIndex={-1}>
              <PageBoundary>
                <Suspense fallback={<RouteFallback />}>
                  <Routes>
                    <Route path="/" element={<Navigate to="/models/chat" replace />} />
                    <Route path="/models" element={<Navigate to="/models/chat" replace />} />
                    <Route path="/models/chat" element={<FallbackPage />} />
                    <Route path="/models/chat/*" element={<ModelDetailPage />} />
                    <Route path="/models/fusion" element={<FusionPage />} />
                    <Route path="/models/embeddings" element={<EmbeddingsPage />} />
                    <Route path="/models/embeddings/:id" element={<EmbeddingDetailPage />} />
                    <Route path="/models/image" element={<ImagePage />} />
                    <Route path="/models/image/:id" element={<MediaDetailPage modality="image" />} />
                    <Route path="/models/audio" element={<AudioPage />} />
                    <Route path="/models/audio/:id" element={<MediaDetailPage modality="audio" />} />
                    <Route path="/playground" element={<PlaygroundPage />} />
                    <Route path="/keys" element={<KeysPage />} />
                    <Route path="/fallback" element={<Navigate to="/models/chat" replace />} />
                    <Route path="/analytics" element={<AnalyticsPage />} />
                    <Route path="/logs" element={<LogsPage />} />
                    <Route path="/settings" element={<SettingsPage />} />
                    <Route path="/usage-limits" element={<UsageLimitsPage />} />
                    <Route path="/catalog" element={<CatalogPage />} />
                    <Route path="/premium" element={<Navigate to="/catalog" replace />} />
                    <Route path="/test" element={<Navigate to="/playground" replace />} />
                    <Route path="/health" element={<Navigate to="/keys" replace />} />
                    <Route path="*" element={<NotFoundPage />} />
                  </Routes>
                </Suspense>
              </PageBoundary>
            </main>
            <Toaster />
            <CommandPalette />
          </div>
        </AuthGate>
      </BrowserRouter>
      </I18nProvider>
    </QueryClientProvider>
  )
}

export default App
