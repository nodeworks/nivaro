import { useQuery } from '@tanstack/react-query'
import { Clock } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { Textarea } from '@/components/ui/textarea'
import { useAuth } from '@/lib/auth'
import { cn, formatDateTime } from '@/lib/utils'
import { ghostButton } from '../hub-parts'
import { changeKeys, fetchEnvWindow, fetchSharedWindow } from './changes-api'

/**
 * Deploy-window notices for the start panels and the administrator's emergency override
 * ("Start outside the window"): a typed reason (10–500 characters) sent as
 * `outside_window_reason`. It skips the windows only — freezes and the pre-deploy checklist
 * still apply — and the Hub logs it and tells the app's owners.
 */

export const REASON_MIN = 10

export function OutsideWindowOverride({
  onReason,
  what
}: {
  onReason: (reason: string | null) => void
  /** "promotion", "move", "upgrade", "apply" — in the button. */
  what: string
}) {
  const { user } = useAuth()
  const isAdmin = !!(user as { is_admin?: boolean } | null)?.is_admin
  const id = useId()
  const [open, setOpen] = useState(false)
  const [reason, setReason] = useState('')
  const ok = reason.trim().length >= REASON_MIN
  useEffect(() => {
    onReason(open && ok ? reason.trim() : null)
  }, [open, ok, reason, onReason])
  if (!isAdmin) return null
  if (!open)
    return (
      <button type='button' className={ghostButton} onClick={() => setOpen(true)}>
        Start outside the window…
      </button>
    )
  return (
    <div className='w-full space-y-1.5'>
      <label htmlFor={id} className='block text-[12px] font-medium'>
        Why this {what} cannot wait for the window
      </label>
      <Textarea
        id={id}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        maxLength={500}
        rows={2}
        placeholder='A leaked secret, a broken login, an outage fix…'
        className='bg-white text-[12px] text-slate-900 dark:bg-background dark:text-foreground'
      />
      <p className='m-0 text-[11px]'>
        {ok
          ? 'Freezes and the pre-deploy checklist still apply. The Hub logs the reason and tells the app’s owners.'
          : `At least ${REASON_MIN} characters. Freezes and the checklist still apply.`}
      </p>
      <button
        type='button'
        className={ghostButton}
        onClick={() => {
          setOpen(false)
          setReason('')
        }}
      >
        Keep to the window
      </button>
    </div>
  )
}

function Notice({
  invalid,
  children,
  override
}: {
  invalid?: boolean
  children: React.ReactNode
  override: React.ReactNode
}) {
  return (
    <div
      role='status'
      className={cn(
        'flex flex-wrap items-start gap-x-3 gap-y-2 rounded-md border px-3 py-2 text-[12px]',
        invalid
          ? 'border-red-200 bg-red-50 text-red-900 dark:border-red-900/60 dark:bg-red-950/40 dark:text-red-200'
          : 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200'
      )}
    >
      <Clock className='mt-0.5 h-3.5 w-3.5 shrink-0' aria-hidden />
      <p className='m-0 min-w-0 flex-[1_1_260px]'>{children}</p>
      {override}
    </div>
  )
}

/** An environment's window for a move or Apply now; renders nothing while it is open. */
export function EnvWindowGate({
  envId,
  what,
  onReason
}: {
  envId: number
  what: 'move' | 'apply' | 'extension'
  onReason: (reason: string | null) => void
}) {
  const q = useQuery({
    queryKey: changeKeys.window(envId),
    queryFn: () => fetchEnvWindow(envId),
    staleTime: 30_000
  })
  const w = q.data
  if (!w || !w.governed || w.open) return null
  const invalid = (w.invalid?.length ?? 0) > 0
  const action =
    what === 'move' ? 'A move' : what === 'extension' ? 'An extension promotion' : 'Apply now'
  return (
    <Notice
      invalid={invalid}
      override={
        <OutsideWindowOverride
          what={what === 'move' ? 'move' : what === 'extension' ? 'promotion' : 'apply'}
          onReason={onReason}
        />
      }
    >
      {invalid
        ? `The deploy window “${w.invalid?.[0]?.name}” cannot be read, so the Hub refuses this until an administrator fixes it on the Changes tab.`
        : `${action} is outside this app’s deploy window${w.opens_at ? `; the next one opens ${formatDateTime(w.opens_at)}` : ''}. The Hub refuses it until then.`}
    </Notice>
  )
}

/** The Hub-wide windows for a shared deployment upgrade; renders nothing while they allow it. */
export function SharedWindowGate({
  sharedId,
  onReason
}: {
  sharedId: number
  onReason: (reason: string | null) => void
}) {
  const q = useQuery({
    queryKey: changeKeys.sharedWindow(sharedId),
    queryFn: () => fetchSharedWindow(sharedId),
    staleTime: 30_000
  })
  const w = q.data
  if (!w || w.open) return null
  return (
    <Notice
      invalid={w.code === 'WINDOW_INVALID'}
      override={<OutsideWindowOverride what='upgrade' onReason={onReason} />}
    >
      {w.code === 'WINDOW_INVALID'
        ? 'A Hub-wide deploy window cannot be read, so the Hub refuses upgrades until an administrator fixes it on the Changes tab.'
        : `Shared deployment upgrades are outside the Hub-wide deploy windows${w.opens_at ? `; the next one opens ${formatDateTime(w.opens_at)}` : ''}.`}
    </Notice>
  )
}
