import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useNavigation, useNivaroClient } from '../context'
import { get, patch } from '../lib/commands'

/**
 * First-login checklist (#134): a one-time personal-setup card — the personal
 * sibling of the instance setup checklist. Every row is judged LIVE from the
 * user's actual preferences/scopes (never a stored done-bit per row), links to
 * where it's done, and the card dismisses once via preferences.onboarding_done.
 * Hidden entirely once dismissed. Hosts mount it near the top of their home
 * surface (admin Dashboard).
 */

interface MePayload {
  preferences?: {
    timezone?: string
    email_digest?: string
    notification_prefs?: unknown
    onboarding_done?: boolean
  } | null
}

export function FirstLoginChecklist({ profileUrl = '/profile' }: { profileUrl?: string }) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const { navigate } = useNavigation()
  const [hidden, setHidden] = useState(false)

  const { data: me } = useQuery<MePayload | null>({
    queryKey: ['first-login-me'],
    queryFn: () =>
      client
        .request<MePayload>(get('/auth/me'))
        .then((r) => r)
        .catch(() => null),
    staleTime: 60_000
  })
  // /users/me/scopes returns {dimensions, defaults, restricted} — defaults is
  // a {dimension: values[]} map, not an array (crashed with .some on first ship).
  const { data: scopes } = useQuery<{ defaults?: Record<string, unknown[]> } | null>({
    queryKey: ['first-login-scopes'],
    queryFn: () =>
      client
        .request<{ data: never }>(get('/users/me/scopes'))
        .then((r) => r.data)
        .catch(() => null as never),
    enabled: !!me,
    staleTime: 60_000
  })

  const dismiss = useMutation({
    mutationFn: () => client.request(patch('/users/me/preferences', { onboarding_done: true })),
    onSuccess: () => {
      setHidden(true)
      void qc.invalidateQueries({ queryKey: ['first-login-me'] })
    }
  })

  if (hidden || !me) return null
  const prefs = me.preferences ?? {}
  if (prefs.onboarding_done) return null

  const rows: Array<{ label: string; done: boolean; hint: string }> = [
    {
      label: 'Set your timezone',
      done: !!prefs.timezone,
      hint: 'Dates and digests render in your local time'
    },
    {
      label: 'Choose email delivery',
      done: prefs.email_digest !== undefined,
      hint: 'Instant emails, or one daily summary'
    },
    {
      label: 'Set notification rules',
      done: prefs.notification_prefs != null,
      hint: 'Quiet hours and which categories reach you'
    },
    {
      label: 'Pick your default filters',
      done: Object.values(scopes?.defaults ?? {}).some((v) => Array.isArray(v) && v.length > 0),
      hint: 'Pre-filter lists to your zone or region'
    }
  ]
  const remaining = rows.filter((r) => !r.done).length

  return (
    <div className='rounded-lg border border-nvr-cyan/40 bg-nvr-cyan/5 p-4 dark:bg-nvr-cyan/10'>
      <div className='flex items-start justify-between gap-3'>
        <div>
          <p className='text-[13px] font-semibold text-slate-800 dark:text-foreground'>
            {remaining === 0 ? "You're all set" : 'Finish setting up your account'}
          </p>
          <p className='mt-0.5 text-[11.5px] text-slate-500 dark:text-muted-foreground'>
            {remaining === 0
              ? 'Everything below is configured — dismiss this card whenever.'
              : `${remaining} of ${rows.length} steps left — each takes under a minute, all on your profile.`}
          </p>
        </div>
        <button
          type='button'
          disabled={dismiss.isPending}
          onClick={() => dismiss.mutate()}
          className='shrink-0 rounded-md px-2 py-1 text-[11.5px] text-slate-500 hover:bg-slate-100 dark:hover:bg-accent'
        >
          Dismiss
        </button>
      </div>
      <div className='mt-3 grid gap-1.5 sm:grid-cols-2'>
        {rows.map((r) => (
          <button
            key={r.label}
            type='button'
            onClick={() => navigate(profileUrl)}
            className='flex items-start gap-2 rounded-md border border-slate-200 bg-white px-2.5 py-2 text-left hover:border-nvr-cyan dark:border-border dark:bg-card'
          >
            <span
              className={`mt-px flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-[10px] font-bold ${
                r.done
                  ? 'bg-emerald-500 text-white'
                  : 'border border-slate-300 text-transparent dark:border-slate-600'
              }`}
            >
              ✓
            </span>
            <span className='min-w-0'>
              <span
                className={`block text-[12.5px] font-medium ${
                  r.done
                    ? 'text-slate-400 line-through dark:text-slate-500'
                    : 'text-slate-700 dark:text-slate-200'
                }`}
              >
                {r.label}
              </span>
              <span className='block text-[11px] text-slate-400'>{r.hint}</span>
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
