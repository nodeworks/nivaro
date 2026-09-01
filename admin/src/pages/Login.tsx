import { Monitor, Moon, ShieldCheck, Sun } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { usePersistedTab } from '@/hooks/usePersistedTab'
import { useTheme } from '@/lib/theme'

function safeLoginRedirect(raw: string | null | undefined): string {
  if (!raw) return '/'
  try {
    const url = new URL(raw, window.location.origin)
    if (url.origin !== window.location.origin) return '/'
    return url.pathname + url.search + url.hash
  } catch {
    if (raw.startsWith('/') && !raw.startsWith('//')) return raw
    return '/'
  }
}

function PasswordLoginForm() {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/auth/login/password', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email, password })
      })
      if (res.ok) {
        const body = (await res.json().catch(() => null)) as { totp_required?: boolean } | null
        if (body?.totp_required) {
          window.location.href = '/login?totp=1'
          return
        }
        const raw = sessionStorage.getItem('nivaro_post_login_redirect')
        sessionStorage.removeItem('nivaro_post_login_redirect')
        window.location.href = safeLoginRedirect(raw)
        return
      }
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      setError(body?.error ?? 'Invalid email or password.')
    } catch {
      setError('Could not sign in. Check your connection and try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={submit} className='space-y-4'>
      {error && (
        <div className='rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700'>
          {error}
        </div>
      )}
      <div>
        <label
          htmlFor='login-email'
          className='mb-1.5 block text-[13px] font-medium text-slate-700'
        >
          Email
        </label>
        <input
          id='login-email'
          type='email'
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoFocus
          autoComplete='email'
          placeholder='you@example.com'
          className='w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-[14px] text-slate-900 outline-none transition-colors focus:border-[#1e96d2]'
        />
      </div>
      <div>
        <label
          htmlFor='login-password'
          className='mb-1.5 block text-[13px] font-medium text-slate-700'
        >
          Password
        </label>
        <input
          id='login-password'
          type='password'
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete='current-password'
          placeholder='••••••••'
          className='w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-[14px] text-slate-900 outline-none transition-colors focus:border-[#1e96d2]'
        />
      </div>
      <button
        type='submit'
        disabled={!email || !password || submitting}
        className='flex w-full items-center justify-center rounded-xl px-5 py-4 text-[14px] font-semibold text-white shadow-md transition-all hover:shadow-lg hover:brightness-110 active:scale-[0.985] disabled:opacity-50 disabled:shadow-none'
        style={{ background: '#1e96d2' }}
      >
        {submitting ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  )
}

const THEME_CYCLE = ['light', 'system', 'dark'] as const
const THEME_ICONS = { light: Sun, system: Monitor, dark: Moon } as const

function TotpForm() {
  const [token, setToken] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (token.length < 6 || submitting) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/auth/totp', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ token })
      })
      if (res.ok) {
        const raw = sessionStorage.getItem('nivaro_post_login_redirect')
        sessionStorage.removeItem('nivaro_post_login_redirect')
        window.location.href = safeLoginRedirect(raw)
        return
      }
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      setError(body?.error ?? 'Invalid code. Try again.')
      setToken('')
      inputRef.current?.focus()
    } catch {
      setError('Could not verify the code. Check your connection and try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={submit} className='w-full'>
      <div className='mb-8 text-center'>
        <div className='mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl bg-[#1e96d2]/10'>
          <ShieldCheck className='h-6 w-6 text-[#1e96d2]' />
        </div>
        <h2 className='text-[24px] font-bold tracking-tight text-slate-900'>
          Two-factor verification
        </h2>
        <p className='mt-1.5 text-[14px] text-slate-500'>
          Enter the 6-digit code from your authenticator app.
        </p>
      </div>

      {error && (
        <div className='mb-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700'>
          {error}
        </div>
      )}

      <input
        ref={inputRef}
        value={token}
        onChange={(e) => setToken(e.target.value.replace(/\D/g, '').slice(0, 6))}
        inputMode='numeric'
        autoComplete='one-time-code'
        placeholder='000000'
        aria-label='Authentication code'
        className='w-full rounded-xl border border-slate-200 bg-white px-5 py-4 text-center text-[24px] font-semibold tracking-[0.4em] text-slate-900 outline-none transition-colors focus:border-[#1e96d2]'
      />

      <button
        type='submit'
        disabled={token.length < 6 || submitting}
        className='mt-4 flex w-full items-center justify-center rounded-xl px-5 py-4 text-[14px] font-semibold text-white shadow-md transition-all hover:shadow-lg hover:brightness-110 active:scale-[0.985] disabled:opacity-50 disabled:shadow-none'
        style={{ background: '#1e96d2' }}
      >
        {submitting ? 'Verifying…' : 'Verify and sign in'}
      </button>

      <a
        href='/login'
        className='mt-5 block text-center text-[12px] text-slate-400 hover:text-slate-600'
      >
        Start over with a different account
      </a>
    </form>
  )
}

/** Static-token sign-in — the fallback when no identity provider covers a
 * user. Exchanges nivaro_users.static_token for a normal session cookie
 * (POST /auth/login/token); collapsed behind a text button so the password
 * form stays the obvious path. */
function TokenLoginFallback() {
  const [open, setOpen] = useState(false)
  const [token, setToken] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/auth/login/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ token: token.trim() })
      })
      if (res.ok) {
        const raw = sessionStorage.getItem('nivaro_post_login_redirect')
        sessionStorage.removeItem('nivaro_post_login_redirect')
        window.location.href = raw ?? '/'
        return
      }
      const body = await res.json().catch(() => null)
      setError(body?.error ?? 'Invalid token.')
    } catch {
      setError('Could not reach the server.')
    } finally {
      setSubmitting(false)
    }
  }
  if (!open) {
    return (
      <button
        type='button'
        onClick={() => setOpen(true)}
        className='mt-4 w-full text-center text-[12px] font-medium text-slate-400 underline decoration-slate-300 underline-offset-2 transition-colors hover:text-slate-600'
      >
        Sign in with an access token instead
      </button>
    )
  }
  return (
    <form onSubmit={submit} className='mt-5 border-t border-slate-200 pt-4'>
      <label
        htmlFor='login-token'
        className='mb-1.5 block text-[12px] font-medium text-slate-600'
      >
        Access token
      </label>
      <input
        id='login-token'
        type='password'
        value={token}
        onChange={(e) => setToken(e.target.value)}
        autoComplete='off'
        placeholder='Paste your static token'
        className='w-full rounded-xl border border-slate-200 bg-white px-4 py-3 font-mono text-[13px] text-slate-900 shadow-sm outline-none transition-colors placeholder:font-sans focus:border-slate-400'
      />
      {error && <p className='mt-2 text-[12px] text-red-600'>{error}</p>}
      <button
        type='submit'
        disabled={!token.trim() || submitting}
        className='mt-3 w-full rounded-xl bg-slate-900 px-5 py-3 text-[14px] font-semibold text-white shadow-md transition-all hover:shadow-lg hover:brightness-110 active:scale-[0.985] disabled:opacity-50'
      >
        {submitting ? 'Signing in…' : 'Sign in with token'}
      </button>
      <p className='mt-2 text-center text-[11px] leading-relaxed text-slate-400'>
        Your static token is on your user record — an administrator can issue one.
      </p>
    </form>
  )
}

export function LoginPage() {
  const params = new URLSearchParams(window.location.search)
  const error = params.get('error')
  const redirectTo = params.get('redirect')
  const totpStep = params.get('totp') === '1'
  const [tab, setTab] = usePersistedTab<'microsoft' | 'password'>('nvr_tab_login', 'microsoft')
  const [providers, setProviders] = useState<{
    oidc: { enabled: boolean; label: string }
    saml: { enabled: boolean; label: string }
    /** Additional admin-configured OIDC providers (#538). */
    sso?: Array<{ id: number; key: string; label: string; logo_url?: string | null; button_color?: string | null }>
  } | null>(null)
  useEffect(() => {
    fetch('/api/auth/providers')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setProviders(d?.data ?? null))
      .catch(() => {})
  }, [])
  // Instance branding (#21) — logo, headline, welcome copy. Nivaro defaults
  // when nothing is configured.
  const [branding, setBranding] = useState<{
    name: string | null
    logo_url: string | null
    login_title: string | null
    login_message: string | null
    login_links?: Array<{ label: string; url: string }>
    notices?: Array<{ id: number; subject: string; body: string; severity: string }>
  } | null>(null)
  useEffect(() => {
    fetch('/api/auth/branding')
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setBranding(d?.data ?? null))
      .catch(() => {})
  }, [])
  const oidcLabel = providers?.oidc.label ?? 'Microsoft'
  const isMicrosoft = oidcLabel.toLowerCase() === 'microsoft'
  // Primary provider can be disabled (OIDC_ENABLED=false — only honored
  // server-side when a custom provider exists). The first tab then carries
  // just the custom/SAML buttons, or disappears entirely.
  const oidcOn = providers ? providers.oidc.enabled !== false : true
  const anySsoButtons = oidcOn || providers?.saml.enabled || (providers?.sso ?? []).length > 0
  useEffect(() => {
    if (providers && !anySsoButtons && tab === 'microsoft') setTab('password')
  }, [providers, anySsoButtons, tab, setTab])

  useEffect(() => {
    if (redirectTo) sessionStorage.setItem('nivaro_post_login_redirect', redirectTo)
  }, [redirectTo])
  const { theme, setTheme } = useTheme()
  const nextTheme =
    THEME_CYCLE[
      (THEME_CYCLE.indexOf(theme as (typeof THEME_CYCLE)[number]) + 1) % THEME_CYCLE.length
    ]
  const ThemeIcon = THEME_ICONS[theme as keyof typeof THEME_ICONS] ?? Monitor

  return (
    <div className='flex min-h-screen overflow-hidden'>
      {/* ── Left panel ─────────────────────────────────────────────── */}
      <div
        className='relative hidden flex-col overflow-hidden lg:flex lg:w-1/2'
        style={{ background: '#172940' }}
      >
        {/* Subtle grid texture */}
        <div
          className='absolute inset-0 opacity-[0.04]'
          style={{
            backgroundImage:
              'linear-gradient(rgba(255,255,255,0.6) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.6) 1px, transparent 1px)',
            backgroundSize: '48px 48px'
          }}
        />

        {/* Ambient N watermark — breathes slowly in background */}
        <div className='absolute inset-0 flex items-center justify-center pointer-events-none'>
          <svg
            width='520'
            height='520'
            viewBox='0 0 24 24'
            aria-hidden='true'
            style={{ animation: 'login-mark-pulse 7s ease-in-out infinite' }}
          >
            <rect x='2' y='2' width='6' height='20' fill='white' />
            <rect x='16' y='2' width='6' height='20' fill='white' />
            <polygon points='8,2 12.5,2 16,22 11.5,22' fill='white' />
          </svg>
        </div>

        {/* Corner accent — top left */}
        <svg
          className='absolute left-8 top-8'
          width='72'
          height='72'
          viewBox='0 0 72 72'
          fill='none'
          aria-hidden='true'
          style={{ opacity: 0.22, animation: 'login-fade 1.2s ease 0.5s both' }}
        >
          <line x1='0' y1='0' x2='72' y2='0' stroke='#1e96d2' strokeWidth='1.5' />
          <line x1='0' y1='0' x2='0' y2='72' stroke='#1e96d2' strokeWidth='1.5' />
          <circle cx='0' cy='0' r='3' fill='#1e96d2' />
        </svg>

        {/* Corner accent — bottom right */}
        <svg
          className='absolute bottom-8 right-8 rotate-180'
          width='72'
          height='72'
          viewBox='0 0 72 72'
          fill='none'
          aria-hidden='true'
          style={{ opacity: 0.22, animation: 'login-fade 1.2s ease 0.5s both' }}
        >
          <line x1='0' y1='0' x2='72' y2='0' stroke='#1e96d2' strokeWidth='1.5' />
          <line x1='0' y1='0' x2='0' y2='72' stroke='#1e96d2' strokeWidth='1.5' />
          <circle cx='0' cy='0' r='3' fill='#1e96d2' />
        </svg>

        {/* Content */}
        <div className='relative z-10 flex flex-1 flex-col items-center justify-center px-12 py-16'>
          {/* Mark badge */}
          {branding?.logo_url ? (
            <img
              src={branding.logo_url}
              alt={branding.name ?? 'Logo'}
              className='mb-10 max-h-24 max-w-[260px] object-contain'
              style={{ animation: 'login-up 0.7s cubic-bezier(0.22, 1, 0.36, 1) both' }}
            />
          ) : (
            <div
              className='mb-10 flex h-16 w-16 items-center justify-center rounded-2xl shadow-lg'
              style={{
                background: '#1e96d2',
                animation: 'login-up 0.7s cubic-bezier(0.22, 1, 0.36, 1) both'
              }}
            >
              <NivaroMark size={36} color='#172940' />
            </div>
          )}

          <h1
            className='text-center text-[64px] font-black leading-none tracking-[-0.04em] text-white'
            style={{ animation: 'login-up 0.7s cubic-bezier(0.22, 1, 0.36, 1) 0.08s both' }}
          >
            {branding?.login_title || branding?.name || 'Nivaro'}
          </h1>
          <p
            className='mt-4 text-center text-[13px] font-light tracking-[0.08em] text-white/50'
            style={{ animation: 'login-up 0.7s cubic-bezier(0.22, 1, 0.36, 1) 0.15s both' }}
          >
            {branding?.login_message || 'Headless CMS'}
          </p>

          {/* Scheduled login notices (#648) — announcement rows on the 'login'
              channel, window-filtered server-side. Maintenance heads-up before
              anyone signs in. */}
          {(branding?.notices?.length ?? 0) > 0 && (
            <div
              className='mt-5 w-full max-w-[420px] space-y-2'
              style={{ animation: 'login-fade 0.8s ease 0.2s both' }}
            >
              {branding?.notices?.map((n) => (
                <div
                  key={n.id}
                  className={`rounded-lg border px-3.5 py-2.5 text-left backdrop-blur ${
                    n.severity === 'critical'
                      ? 'border-red-400/40 bg-red-500/15'
                      : n.severity === 'warn'
                        ? 'border-amber-400/40 bg-amber-500/15'
                        : 'border-white/20 bg-white/10'
                  }`}
                >
                  <p className='text-[12.5px] font-semibold text-white'>{n.subject}</p>
                  {n.body && (
                    <p className='mt-0.5 text-[12px] leading-snug text-white/70'>{n.body}</p>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Configurable help/support links (#347) — Settings → Project. */}
          {(branding?.login_links?.length ?? 0) > 0 && (
            <div
              className='mt-4 flex flex-wrap items-center gap-x-4 gap-y-1'
              style={{ animation: 'login-fade 0.8s ease 0.24s both' }}
            >
              {branding?.login_links?.map((l) => (
                <a
                  key={l.url}
                  href={l.url}
                  target='_blank'
                  rel='noreferrer'
                  className='text-[12px] text-white/50 underline decoration-white/20 underline-offset-2 transition-colors hover:text-white/85'
                >
                  {l.label}
                </a>
              ))}
            </div>
          )}

          <div
            className='mt-12 flex items-center gap-2'
            style={{ animation: 'login-fade 0.8s ease 0.28s both' }}
          >
            <div className='h-px w-16 bg-white/10' />
            <div className='h-1 w-1 rounded-full bg-white/20' />
            <div
              className='h-1.5 w-1.5 rounded-full'
              style={{ background: '#1e96d2', opacity: 0.7 }}
            />
            <div className='h-1 w-1 rounded-full bg-white/20' />
            <div className='h-px w-16 bg-white/10' />
          </div>

          <p
            className='mt-8 max-w-xs text-center text-[13px] leading-relaxed text-white/40'
            style={{ animation: 'login-up 0.7s cubic-bezier(0.22, 1, 0.36, 1) 0.32s both' }}
          >
            A metadata-driven headless CMS for enterprise applications.
          </p>
        </div>

        {/* Bottom strip */}
        <div
          className='relative z-10 border-t border-white/[0.06] px-12 py-5'
          style={{ animation: 'login-fade 1s ease 0.45s both' }}
        >
          <p className='text-[11px] text-white/25'>Nivaro · Restricted Access</p>
        </div>
      </div>

      {/* ── Right panel ──────────────────────────────────────────────── */}
      <div className='relative flex flex-1 flex-col items-center justify-center bg-secondary px-8 py-12 lg:w-1/2'>
        <button
          type='button'
          onClick={() => setTheme(nextTheme)}
          aria-label={`Theme: ${theme}. Switch to ${nextTheme}`}
          className='absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-md text-slate-400 transition-colors hover:bg-slate-200/60 hover:text-slate-600 dark:hover:bg-white/10 dark:hover:text-white'
        >
          <ThemeIcon className='h-4 w-4' />
        </button>

        {/* Mobile mark */}
        <div
          className='mb-8 flex flex-col items-center lg:hidden'
          style={{ animation: 'login-up 0.7s cubic-bezier(0.22, 1, 0.36, 1) both' }}
        >
          <div
            className='flex h-12 w-12 items-center justify-center rounded-xl shadow-md'
            style={{ background: '#172940' }}
          >
            <NivaroMark size={24} color='#1e96d2' />
          </div>
          <p className='mt-3 text-[18px] font-bold text-slate-900'>Nivaro</p>
        </div>

        <div
          className='w-full max-w-sm'
          style={{ animation: 'login-up 0.7s cubic-bezier(0.22, 1, 0.36, 1) 0.12s both' }}
        >
          {totpStep ? (
            <TotpForm />
          ) : (
            <>
              <div className='mb-6 text-center'>
                <h2 className='text-[24px] font-bold tracking-tight text-slate-900'>
                  Sign in to your account
                </h2>
              </div>

              {/* Tab switcher */}
              <div className='mb-6 flex rounded-xl border border-slate-200 bg-slate-100 p-1'>
                {anySsoButtons && (
                  <button
                    type='button'
                    onClick={() => setTab('microsoft')}
                    className='flex-1 rounded-lg py-2 text-[13px] font-medium transition-colors'
                    style={
                      tab === 'microsoft'
                        ? {
                            background: 'white',
                            color: '#0f172a',
                            boxShadow: '0 1px 3px rgba(0,0,0,0.08)'
                          }
                        : { color: '#64748b' }
                    }
                  >
                    SSO
                  </button>
                )}
                <button
                  type='button'
                  onClick={() => setTab('password')}
                  className='flex-1 rounded-lg py-2 text-[13px] font-medium transition-colors'
                  style={
                    tab === 'password'
                      ? {
                          background: 'white',
                          color: '#0f172a',
                          boxShadow: '0 1px 3px rgba(0,0,0,0.08)'
                        }
                      : { color: '#64748b' }
                  }
                >
                  Email / Password
                </button>
              </div>

              {error && tab === 'microsoft' && (
                <div className='mb-5 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700'>
                  Authentication failed. Please try again or contact IT support.
                </div>
              )}

              {tab === 'microsoft' ? (
                <>
                  {oidcOn && (
                    <a
                      href={`/api/auth/login?returnTo=${encodeURIComponent(`${window.location.origin}/`)}`}
                      className='group flex w-full items-center justify-center gap-3 rounded-xl px-5 py-4 text-[14px] font-semibold text-white shadow-md transition-all hover:shadow-lg hover:brightness-110 active:scale-[0.985]'
                      style={{ background: isMicrosoft ? '#0078d4' : '#0f172a' }}
                    >
                      {isMicrosoft ? <MicrosoftIcon /> : <KeyIcon />}
                      Continue with {oidcLabel}
                    </a>
                  )}
                  {providers?.saml.enabled && (
                    <a
                      href='/api/auth/saml/login'
                      className='mt-3 flex w-full items-center justify-center gap-3 rounded-xl border border-slate-200 bg-white px-5 py-3.5 text-[14px] font-semibold text-slate-700 shadow-sm transition-all hover:border-slate-300 hover:shadow active:scale-[0.985]'
                    >
                      <KeyIcon dark />
                      Continue with {providers.saml.label}
                    </a>
                  )}
                  {/* Additional OIDC providers (#538) — same PKCE flow against
                      admin-configured issuers (Settings → Sign-in providers). */}
                  {(providers?.sso ?? []).map((p) => (
                    <a
                      key={p.id}
                      href={`/api/auth/login?provider=${encodeURIComponent(p.key)}&returnTo=${encodeURIComponent(`${window.location.origin}/`)}`}
                      className={
                        p.button_color
                          ? 'mt-3 flex w-full items-center justify-center gap-3 rounded-xl px-5 py-3.5 text-[14px] font-semibold text-white shadow-md transition-all hover:shadow-lg hover:brightness-110 active:scale-[0.985]'
                          : 'mt-3 flex w-full items-center justify-center gap-3 rounded-xl border border-slate-200 bg-white px-5 py-3.5 text-[14px] font-semibold text-slate-700 shadow-sm transition-all hover:border-slate-300 hover:shadow active:scale-[0.985]'
                      }
                      style={p.button_color ? { background: p.button_color } : undefined}
                    >
                      {p.logo_url ? (
                        <img src={p.logo_url} alt='' className='h-5 w-5 rounded object-contain' />
                      ) : (
                        <KeyIcon dark={!p.button_color} />
                      )}
                      Continue with {p.label}
                    </a>
                  ))}
                  <p className='mt-6 text-center text-[12px] leading-relaxed text-slate-400'>
                    Access is restricted to authorized users. If you need access, contact your
                    administrator.
                  </p>
                </>
              ) : (
                <>
                  <PasswordLoginForm />
                  <TokenLoginFallback />
                </>
              )}
            </>
          )}
        </div>

        <div className='mt-16 text-center' style={{ animation: 'login-fade 1s ease 0.4s both' }}>
          <p className='text-[11px] text-slate-400'>© 2026 Nivaro · All rights reserved</p>
        </div>
      </div>
    </div>
  )
}

function NivaroMark({ size = 24, color = 'currentColor' }: { size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox='0 0 24 24' aria-hidden='true'>
      <rect x='2' y='2' width='6' height='20' fill={color} />
      <rect x='16' y='2' width='6' height='20' fill={color} />
      <polygon points='8,2 12.5,2 16,22 11.5,22' fill={color} />
    </svg>
  )
}

function KeyIcon({ dark = false }: { dark?: boolean }) {
  return (
    <svg
      width='16'
      height='16'
      viewBox='0 0 24 24'
      fill='none'
      stroke={dark ? '#334155' : 'white'}
      strokeWidth='2'
      strokeLinecap='round'
      strokeLinejoin='round'
      aria-hidden='true'
    >
      <path d='M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4' />
    </svg>
  )
}

function MicrosoftIcon() {
  return (
    <svg
      width='18'
      height='18'
      viewBox='0 0 21 21'
      fill='none'
      xmlns='http://www.w3.org/2000/svg'
      aria-label='Microsoft'
      role='img'
    >
      <title>Microsoft</title>
      <rect x='1' y='1' width='9' height='9' fill='#f25022' />
      <rect x='11' y='1' width='9' height='9' fill='#7fba00' />
      <rect x='1' y='11' width='9' height='9' fill='#00a4ef' />
      <rect x='11' y='11' width='9' height='9' fill='#ffb900' />
    </svg>
  )
}
