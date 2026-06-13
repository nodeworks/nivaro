import { Monitor, Moon, ShieldCheck, Sun } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useTheme } from '@/lib/theme'

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
        body: JSON.stringify({ email, password }),
      })
      if (res.ok) {
        const redirect = sessionStorage.getItem('nivaro_post_login_redirect')
        sessionStorage.removeItem('nivaro_post_login_redirect')
        window.location.href = redirect || '/'
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
        const redirect = sessionStorage.getItem('nivaro_post_login_redirect')
        sessionStorage.removeItem('nivaro_post_login_redirect')
        window.location.href = redirect || '/'
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

export function LoginPage() {
  const params = new URLSearchParams(window.location.search)
  const error = params.get('error')
  const redirectTo = params.get('redirect')
  const totpStep = params.get('totp') === '1'
  const [tab, setTab] = useState<'microsoft' | 'password'>('microsoft')

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
          <div
            className='mb-10 flex h-16 w-16 items-center justify-center rounded-2xl shadow-lg'
            style={{
              background: '#1e96d2',
              animation: 'login-up 0.7s cubic-bezier(0.22, 1, 0.36, 1) both'
            }}
          >
            <NivaroMark size={36} color='#172940' />
          </div>

          <h1
            className='text-center text-[64px] font-black leading-none tracking-[-0.04em] text-white'
            style={{ animation: 'login-up 0.7s cubic-bezier(0.22, 1, 0.36, 1) 0.08s both' }}
          >
            Nivaro
          </h1>
          <p
            className='mt-4 text-center text-[13px] font-light tracking-[0.08em] text-white/50'
            style={{ animation: 'login-up 0.7s cubic-bezier(0.22, 1, 0.36, 1) 0.15s both' }}
          >
            Headless CMS
          </p>

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
                <button
                  type='button'
                  onClick={() => setTab('microsoft')}
                  className='flex-1 rounded-lg py-2 text-[13px] font-medium transition-colors'
                  style={
                    tab === 'microsoft'
                      ? { background: 'white', color: '#0f172a', boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }
                      : { color: '#64748b' }
                  }
                >
                  Microsoft
                </button>
                <button
                  type='button'
                  onClick={() => setTab('password')}
                  className='flex-1 rounded-lg py-2 text-[13px] font-medium transition-colors'
                  style={
                    tab === 'password'
                      ? { background: 'white', color: '#0f172a', boxShadow: '0 1px 3px rgba(0,0,0,0.08)' }
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
                  <a
                    href='/api/auth/login'
                    className='group flex w-full items-center justify-center gap-3 rounded-xl px-5 py-4 text-[14px] font-semibold text-white shadow-md transition-all hover:shadow-lg hover:brightness-110 active:scale-[0.985]'
                    style={{ background: '#0078d4' }}
                  >
                    <MicrosoftIcon />
                    Continue with Microsoft
                  </a>
                  <p className='mt-6 text-center text-[12px] leading-relaxed text-slate-400'>
                    Access is restricted to authorized users. If you need access, contact your
                    administrator.
                  </p>
                </>
              ) : (
                <PasswordLoginForm />
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
