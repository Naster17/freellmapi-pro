import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { apiFetch } from '@/lib/api'
import { useI18n } from '@/i18n'

/**
 * Landing page for Cline's OAuth redirect (/keys/cline/callback?code=…&state=…).
 * Stages the code in sessionStorage and sends the user back to /keys, where
 * the Add provider form shows an authorized state and finishes the exchange
 * (POST /api/cline/oauth/complete) only when the user presses Add — so the
 * key row can carry the label typed in the form.
 */
export function ClineOAuthCallbackPage() {
  const { t } = useI18n()
  const [searchParams] = useSearchParams()
  const [error, setError] = useState<string | null>(null)
  const attempted = useRef(false)

  useEffect(() => {
    if (attempted.current) return
    attempted.current = true
    const code = searchParams.get('code')
    const state = searchParams.get('state') ?? undefined
    const errorParam = searchParams.get('error')
    if (errorParam) {
      setError(errorParam)
      return
    }
    if (!code) {
      setError(t('keys.clineNoCode'))
      return
    }
    try {
      sessionStorage.setItem('freellmapi.cline-pending', JSON.stringify({ code, state }))
      window.location.replace('/keys?cline=authorized')
    } catch {
      apiFetch('/api/cline/oauth/complete', {
        method: 'POST',
        body: JSON.stringify({ code, state }),
      })
        .then(() => {
          window.location.replace('/keys?cline=connected')
        })
        .catch((err: Error) => setError(err.message))
    }
  }, [searchParams, t])

  return (
    <div className="mx-auto max-w-md space-y-4 p-10 text-center">
      {error ? (
        <>
          <h1 className="text-lg font-semibold">{t('keys.clineFailed')}</h1>
          <p className="text-sm text-destructive">{error}</p>
          <p className="text-xs text-muted-foreground">{t('keys.clineRetryHint')}</p>
        </>
      ) : (
        <h1 className="text-lg font-semibold">{t('keys.clineCompleting')}</h1>
      )}
      <Link to="/keys" className="block text-sm text-muted-foreground underline-offset-2 hover:underline">
        {t('keys.backToKeys')}
      </Link>
    </div>
  )
}
