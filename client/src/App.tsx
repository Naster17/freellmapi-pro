import { lazy, Suspense, useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate, NavLink, Link, useLocation, useNavigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Languages, Menu, MoreHorizontal, Moon, Sun } from 'lucide-react'
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
import { ErrorBoundary } from '@/components/error-boundary'
import { KeysImportExportSub, KeysImportHost } from '@/components/keys-import-export-menu'
import { I18nProvider, useI18n, SUPPORTED_LOCALES, type Locale } from '@/i18n'
import { logout } from '@/lib/api'

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

const queryClient = new QueryClient()

const navItems = [
  { to: '/models', labelKey: 'nav.models' },
  { to: '/keys', labelKey: 'nav.keys' },
  { to: '/analytics', labelKey: 'nav.analytics' },
  { to: '/usage-limits', labelKey: 'nav.usageLimits' },
  { to: '/catalog', labelKey: 'nav.premium' },
  { to: '/playground', labelKey: 'nav.playground' },
]

const overflowItems = [
  { to: '/logs', labelKey: 'nav.logs' },
]

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

// The preload's own early classList.add can be lost (it may run before this
// document exists), so the client claims the class itself at module load —
// before the first React paint — keeping html.desktop CSS (transparent body,
// glass backdrop) reliable.
if (isDesktopApp) {
  document.documentElement.classList.add('desktop')
}

// Language picker as a dropdown submenu, shared by the desktop (⋯) and mobile
// (☰) menus. Radio items show a check on the active locale; selecting one calls
// setLocale, which persists and re-renders every t() synchronously.
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
      // In the desktop shell the body backdrop is already translucent glass;
      // a lighter wash keeps the title bar from looking more solid than the page.
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
          {navItems.map((item) => (
            <NavItem key={item.to} to={item.to}>
              {t(item.labelKey)}
            </NavItem>
          ))}
        </nav>
        <div
          className="ml-auto hidden items-center gap-1 md:flex"
          style={isDesktopApp ? ({ WebkitAppRegion: 'no-drag' } as React.CSSProperties) : undefined}
        >
          <DropdownMenu>
            <DropdownMenuTrigger
              className={buttonVariants({ variant: 'ghost', size: 'icon' })}
              aria-label={t('nav.openMenu')}
            >
              <MoreHorizontal />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-48">
              {overflowItems.map((item) => (
                <DropdownMenuItem
                  key={item.to}
                  onClick={() => navigate(item.to)}
                  className={isActiveRoute(item.to) ? 'bg-accent text-accent-foreground font-medium' : undefined}
                >
                  {t(item.labelKey)}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={toggle} className="gap-2">
                {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
                <span>{t('nav.theme')}</span>
              </DropdownMenuItem>
              <LanguageSubMenu />
              <KeysImportExportSub />
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
                {navItems.map((item) => (
                  <DropdownMenuItem
                    key={item.to}
                    onClick={() => navigate(item.to)}
                    className={isActiveRoute(item.to) ? 'bg-accent text-accent-foreground font-medium' : undefined}
                  >
                    {t(item.labelKey)}
                  </DropdownMenuItem>
                ))}
                {overflowItems.map((item) => (
                  <DropdownMenuItem
                    key={item.to}
                    onClick={() => navigate(item.to)}
                    className={isActiveRoute(item.to) ? 'bg-accent text-accent-foreground font-medium' : undefined}
                  >
                    {t(item.labelKey)}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              <DropdownMenuGroup>
                <DropdownMenuItem onClick={toggle} className="gap-2">
                  {dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
                  <span>{t('nav.theme')}</span>
                </DropdownMenuItem>
                <LanguageSubMenu />
                <KeysImportExportSub />
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
              <ErrorBoundary>
                <Suspense fallback={<RouteFallback />}>
                  <Routes>
                    <Route path="/" element={<Navigate to="/models/chat" replace />} />
                    <Route path="/models" element={<Navigate to="/models/chat" replace />} />
                    <Route path="/models/chat" element={<FallbackPage />} />
                    <Route path="/models/chat/:id" element={<ModelDetailPage />} />
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
                    <Route path="/usage-limits" element={<UsageLimitsPage />} />
                    <Route path="/catalog" element={<CatalogPage />} />
                    <Route path="/premium" element={<Navigate to="/catalog" replace />} />
                    <Route path="/test" element={<Navigate to="/playground" replace />} />
                    <Route path="/health" element={<Navigate to="/keys" replace />} />
                  </Routes>
                </Suspense>
              </ErrorBoundary>
            </main>
          </div>
        </AuthGate>
      </BrowserRouter>
      </I18nProvider>
    </QueryClientProvider>
  )
}

export default App
