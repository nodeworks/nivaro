import { useMutation, useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../context'
import { patch as patchCmd } from '../lib/commands'
import { cn } from '../lib/utils'

/** `nivaro_users.preferences.custom_status` — free text + emoji beside the
 *  presence state, self-clearing at `expires_at`. */
export type CustomStatus = { text: string; emoji: string | null; expires_at?: string | null }

/** A status whose expiry has passed reads as no status (the server does the
 *  same on /presence/online — the row is only cleared lazily). */
export function activeCustomStatus(raw: unknown): CustomStatus | null {
  if (!raw || typeof raw !== 'object') return null
  const s = raw as CustomStatus
  if (!s.text) return null
  if (s.expires_at && new Date(s.expires_at).getTime() <= Date.now()) return null
  return s
}

export function formatStatusExpiry(expiresAt: string | null | undefined): string | null {
  if (!expiresAt) return null
  const d = new Date(expiresAt)
  if (Number.isNaN(d.getTime())) return null
  const sameDay = d.toDateString() === new Date().toDateString()
  return `until ${sameDay ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`
}

const QUICK = ['📅', '🍽️', '🏠', '✈️', '🤒', '🎯', '☕']

/**
 * The ONE editor for a user's own custom status — the chat panel's Online tab
 * and the profile header both render it, so the two can never disagree.
 * Saves through PATCH /users/me/preferences and invalidates the presence
 * roster plus any query keys the host names (`invalidate`).
 */
export function CustomStatusEditor({
  status,
  invalidate = [],
  theme,
  showExpiry = false,
  className
}: {
  status: CustomStatus | null
  /** Extra query-key prefixes to invalidate after a save (the host's own
   *  "me" query). ['presence-online'] is always included. */
  invalidate?: ReadonlyArray<readonly unknown[]>
  /** Class slots (chat theme) — defaults use the brand tokens. */
  theme?: { accentSoft?: string; input?: string; action?: string }
  /** Profile variant: show "until 3:00 PM" beside the status. */
  showExpiry?: boolean
  className?: string
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState('')
  const [emoji, setEmoji] = useState('')
  const [duration, setDuration] = useState<'30' | '60' | 'today' | 'never'>('60')
  const accentSoft = theme?.accentSoft ?? 'bg-nvr-cyan/15 text-nvr-navy dark:text-nvr-cyan'
  const inputCls = theme?.input ?? 'border-slate-200 bg-white dark:border-border dark:bg-card'
  const actionCls = theme?.action ?? 'bg-nvr-cyan text-white hover:bg-[#00b8e0]'

  const save = useMutation({
    mutationFn: (next: (CustomStatus & { expires_at: string | null }) | null) =>
      client.request(patchCmd('/users/me/preferences', { custom_status: next })),
    onSuccess: () => {
      setEditing(false)
      // The presence roster (chat Online tab) and the profile's own "me" query
      // both show this status — refresh both wherever the save came from.
      void qc.invalidateQueries({ queryKey: ['presence-online'] })
      void qc.invalidateQueries({ queryKey: ['nvr-profile-user'] })
      for (const key of invalidate) void qc.invalidateQueries({ queryKey: [...key] })
    },
    onError: () => toast.error('Could not update your status')
  })
  const expiresAt = (): string | null => {
    if (duration === 'never') return null
    if (duration === 'today') {
      const d = new Date()
      d.setHours(23, 59, 59, 0)
      return d.toISOString()
    }
    return new Date(Date.now() + Number(duration) * 60_000).toISOString()
  }
  const commit = () => {
    if (!text.trim()) return
    save.mutate({ text: text.trim(), emoji: emoji || null, expires_at: expiresAt() })
  }

  if (!editing) {
    const expiry = showExpiry ? formatStatusExpiry(status?.expires_at) : null
    return (
      <div className={cn('flex items-center gap-1.5', className)} data-custom-status>
        <button
          type='button'
          onClick={() => {
            setText(status?.text ?? '')
            setEmoji(status?.emoji ?? '')
            setEditing(true)
          }}
          className={cn(
            'flex min-w-0 items-center gap-1.5 rounded-md border border-dashed px-2 py-1 text-left text-[11.5px]',
            status
              ? 'border-slate-200 text-slate-600 dark:border-border dark:text-slate-300'
              : 'border-slate-200 text-slate-400 dark:border-border'
          )}
          data-chat-my-status
        >
          {status ? (
            <span className='truncate'>
              {status.emoji ? `${status.emoji} ` : ''}
              {status.text}
              {expiry && <span className='ml-1.5 text-slate-400'>· {expiry}</span>}
            </span>
          ) : (
            <span>Set a status…</span>
          )}
        </button>
        {status && (
          <button
            type='button'
            onClick={() => save.mutate(null)}
            className='rounded p-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'
            aria-label='Clear status'
          >
            <X className='h-3.5 w-3.5' />
          </button>
        )}
      </div>
    )
  }
  return (
    <div
      className={cn(
        'space-y-1.5 rounded-lg border border-slate-200 p-2 dark:border-border',
        className
      )}
      data-custom-status-editor
    >
      <div className='flex gap-1'>
        {QUICK.map((e) => (
          <button
            key={e}
            type='button'
            onClick={() => setEmoji(emoji === e ? '' : e)}
            className={cn(
              'rounded-md px-1 py-0.5 text-[15px]',
              emoji === e ? accentSoft : 'hover:bg-slate-100 dark:hover:bg-muted'
            )}
          >
            {e}
          </button>
        ))}
      </div>
      <input
        // biome-ignore lint/a11y/noAutofocus: single-purpose inline form
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
          if (e.key === 'Escape') setEditing(false)
        }}
        maxLength={100}
        placeholder="What's up? (e.g. In a meeting until 3)"
        className={cn('h-7 w-full rounded-md border px-2 text-[12px]', inputCls)}
      />
      <div className='flex items-center gap-1.5'>
        <select
          value={duration}
          onChange={(e) => setDuration(e.target.value as typeof duration)}
          className='rounded border border-slate-200 bg-white px-1.5 py-0.5 text-[11px] text-slate-600 dark:border-border dark:bg-card dark:text-slate-300'
        >
          <option value='30'>Clear in 30 min</option>
          <option value='60'>Clear in 1 hour</option>
          <option value='today'>Clear today</option>
          <option value='never'>Don't clear</option>
        </select>
        <span className='flex-1' />
        <button
          type='button'
          onClick={() => setEditing(false)}
          className='rounded-md px-2 py-1 text-[11.5px] text-slate-500 hover:text-slate-700 dark:hover:text-slate-300'
        >
          Cancel
        </button>
        <button
          type='button'
          disabled={!text.trim() || save.isPending}
          onClick={commit}
          className={cn(
            'rounded-md px-2.5 py-1 text-[11.5px] font-semibold disabled:opacity-50',
            actionCls
          )}
        >
          Save
        </button>
      </div>
    </div>
  )
}
