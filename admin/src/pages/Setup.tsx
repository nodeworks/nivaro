import { useState } from 'react'

export function SetupPage() {
  const params = new URLSearchParams(window.location.search)
  const token = params.get('token') ?? ''

  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)

  if (!token) {
    return (
      <div className='flex min-h-screen items-center justify-center bg-secondary p-8'>
        <div className='w-full max-w-sm text-center'>
          <p className='text-[14px] text-slate-500'>Invalid or missing setup token.</p>
        </div>
      </div>
    )
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (password.length < 8) return setError('Password must be at least 8 characters.')
    if (password !== confirm) return setError('Passwords do not match.')
    setSubmitting(true)
    setError(null)
    try {
      const res = await fetch('/api/auth/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ token, password }),
      })
      const body = (await res.json().catch(() => null)) as { error?: string } | null
      if (!res.ok) return setError(body?.error ?? 'Setup failed. The link may have expired.')
      setDone(true)
      setTimeout(() => (window.location.href = '/'), 1200)
    } catch {
      setError('Could not connect. Check your connection and try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className='flex min-h-screen items-center justify-center bg-secondary px-8 py-12'>
      <div className='w-full max-w-sm'>
        <div className='mb-8 text-center'>
          <div
            className='mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl shadow-md'
            style={{ background: '#172940' }}
          >
            <svg width='22' height='22' viewBox='0 0 24 24' aria-hidden='true'>
              <rect x='2' y='2' width='6' height='20' fill='#1e96d2' />
              <rect x='16' y='2' width='6' height='20' fill='#1e96d2' />
              <polygon points='8,2 12.5,2 16,22 11.5,22' fill='#1e96d2' />
            </svg>
          </div>
          <h2 className='text-[24px] font-bold tracking-tight text-slate-900 dark:text-white'>
            Set your password
          </h2>
          <p className='mt-1.5 text-[14px] text-slate-500'>
            Choose a password to secure your account.
          </p>
        </div>

        {done ? (
          <div className='rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-4 text-center text-[14px] font-medium text-emerald-700'>
            Password set. Taking you in…
          </div>
        ) : (
          <form onSubmit={submit} className='space-y-4'>
            {error && (
              <div className='rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-[13px] text-red-700'>
                {error}
              </div>
            )}

            <div>
              <label
                htmlFor='setup-password'
                className='mb-1.5 block text-[13px] font-medium text-slate-700 dark:text-slate-300'
              >
                New password
              </label>
              <input
                id='setup-password'
                type='password'
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoFocus
                autoComplete='new-password'
                placeholder='Min. 8 characters'
                className='w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-[14px] text-slate-900 outline-none transition-colors focus:border-[#1e96d2] dark:border-slate-700 dark:bg-slate-900 dark:text-white'
              />
            </div>

            <div>
              <label
                htmlFor='setup-confirm'
                className='mb-1.5 block text-[13px] font-medium text-slate-700 dark:text-slate-300'
              >
                Confirm password
              </label>
              <input
                id='setup-confirm'
                type='password'
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete='new-password'
                placeholder='Repeat password'
                className='w-full rounded-xl border border-slate-200 bg-white px-4 py-3 text-[14px] text-slate-900 outline-none transition-colors focus:border-[#1e96d2] dark:border-slate-700 dark:bg-slate-900 dark:text-white'
              />
            </div>

            <button
              type='submit'
              disabled={!password || !confirm || submitting}
              className='mt-2 flex w-full items-center justify-center rounded-xl px-5 py-4 text-[14px] font-semibold text-white shadow-md transition-all hover:shadow-lg hover:brightness-110 active:scale-[0.985] disabled:opacity-50 disabled:shadow-none'
              style={{ background: '#1e96d2' }}
            >
              {submitting ? 'Setting password…' : 'Set password and sign in'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
