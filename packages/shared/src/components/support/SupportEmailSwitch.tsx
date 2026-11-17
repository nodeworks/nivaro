import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNivaroClient } from '../../context'
import { get, patch } from '../../lib/commands'
import { announceLocalPrefs } from '../../lib/user-sync'
import { cn } from '../../lib/utils'
import { Toggle } from '../profile/primitives'

/**
 * "Email me when my requests get a reply or change" — the requester's opt-in for support
 * email (off by default). Stored as preferences.support_email_updates; the server reads it
 * once per notice and then asks for email on the REQUESTER's copy of a reply from the desk,
 * "Your request is in progress" and status changes. The person's email setting for the
 * category (instant, daily summary or off) still decides. Shared by Support → My requests
 * and Profile → Notifications — one query key, one shape (the Profile cards' prefs).
 */

const PREFS_KEY = ['nvr-profile-prefs']

export function SupportEmailSwitch({ compact }: { compact?: boolean }) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const { data: prefs, isSuccess } = useQuery({
    queryKey: PREFS_KEY,
    queryFn: () =>
      client
        .request<{ data: { preferences?: Record<string, unknown> | null } }>(get('/users/me'))
        .then((r) => (r.data?.preferences ?? {}) as Record<string, unknown>)
  })
  const on = prefs?.support_email_updates === true
  const save = useMutation({
    mutationFn: (next: boolean) =>
      client.request(patch('/users/me/preferences', { support_email_updates: next ? true : null })),
    onMutate: (next: boolean) => {
      qc.setQueryData<Record<string, unknown>>(PREFS_KEY, (p) => ({
        ...(p ?? {}),
        support_email_updates: next ? true : null
      }))
    },
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: PREFS_KEY })
      announceLocalPrefs(['support_email_updates'])
    }
  })
  const label = 'Email me when my requests get a reply or change'

  return (
    <div
      data-support-email-switch={!isSuccess ? 'loading' : on ? 'on' : 'off'}
      // gap-2 like the profile rows beside it (urgent sound), so the labels line up.
      className='flex items-start gap-2 text-[12.5px] text-slate-600 dark:text-muted-foreground'
    >
      <span className='pt-px'>
        <Toggle
          on={on}
          onChange={() => {
            if (isSuccess && !save.isPending) save.mutate(!on)
          }}
          label={label}
        />
      </span>
      <div className='min-w-0'>
        <p className='text-[12.5px] font-medium text-slate-700 dark:text-slate-200'>{label}</p>
        <p
          className={cn(
            'max-w-[68ch] leading-snug text-slate-500 dark:text-slate-400',
            compact ? 'text-[11px]' : 'text-[11.5px]'
          )}
        >
          {on
            ? 'You get an email when someone replies, picks one up or changes its status, following your email setting for Workflow & approvals.'
            : 'Off: replies and changes reach you in the app (and as push, if you allow it), not by email.'}
        </p>
      </div>
    </div>
  )
}
