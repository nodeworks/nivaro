import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useNivaroClient } from '../../context'
import { del, get, patch } from '../../lib/commands'
import { cn } from '../../lib/utils'
import { ConfirmButton, Toggle } from '../profile/primitives'

/**
 * "Don't save my questions" — the Ask AI history opt-out (#1833). Stored as
 * preferences.ai_history_off; the server reads it on every question and then
 * keeps no conversation. Turning it on offers a SEPARATE, explicit "Also
 * delete my saved conversations" (the person's own only). Shared by Profile
 * and the Ask page's History sidebar — one query key, one shape.
 */

const PREFS_KEY = ['nvr-profile-prefs']

/** The person's preferences, on the same key and shape as the Profile cards. */
function usePrefs() {
  const client = useNivaroClient()
  return useQuery({
    queryKey: PREFS_KEY,
    queryFn: () =>
      client
        .request<{ data: { preferences?: Record<string, unknown> | null } }>(get('/users/me'))
        .then((r) => (r.data?.preferences ?? {}) as Record<string, unknown>)
  })
}

/** Is Ask AI history off for the signed-in person? (false while loading) */
export function useAiHistoryOff(): boolean {
  return usePrefs().data?.ai_history_off === true
}

export function AiHistorySwitch({
  compact,
  onDeleted
}: {
  /** Sidebar layout: tighter copy. */
  compact?: boolean
  /** After "Also delete my saved conversations" — the host refreshes its list. */
  onDeleted?: (count: number) => void
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const off = useAiHistoryOff()
  const [offerDelete, setOfferDelete] = useState(false)
  const [deleted, setDeleted] = useState<number | null>(null)
  const save = useMutation({
    mutationFn: (next: boolean) =>
      client.request(patch('/users/me/preferences', { ai_history_off: next ? true : null })),
    onSuccess: (_r, next) => {
      setOfferDelete(next)
      setDeleted(null)
      void qc.invalidateQueries({ queryKey: PREFS_KEY })
    }
  })
  const wipe = useMutation({
    mutationFn: () =>
      client
        .request<{ data: { deleted: number } }>(del('/ai/conversations/mine'))
        .then((r) => r.data?.deleted ?? 0),
    onSuccess: (n) => {
      setOfferDelete(false)
      setDeleted(n)
      onDeleted?.(n)
    }
  })

  return (
    <div data-ai-history-switch={off ? 'off' : 'on'}>
      <div className='flex items-start gap-2.5'>
        <Toggle on={off} onChange={() => save.mutate(!off)} label='Don’t save my questions' />
        <div className='min-w-0'>
          <p className='text-[12.5px] font-medium text-slate-800 dark:text-slate-100'>
            Don’t save my questions
          </p>
          <p
            className={cn(
              'text-slate-500 dark:text-muted-foreground',
              compact ? 'text-[11px]' : 'text-[11.5px]'
            )}
          >
            {off
              ? 'Answers still work, but nothing you ask is kept: no History, and no Share, Post to chat, Branch, export or saved plan cards — those need a saved conversation.'
              : 'Ask AI keeps your conversations in History so you can resume, share, branch and post them.'}
            {!compact &&
              ' Your memory notes and any thumbs up/down you choose to give are kept either way. Administrators’ AI usage log keeps capped copies of AI calls for 30 days.'}
          </p>
        </div>
      </div>
      {off && offerDelete && (
        <div className='mt-2 flex flex-wrap items-center gap-2 pl-[42px]'>
          <ConfirmButton
            onConfirm={() => wipe.mutate()}
            disabled={wipe.isPending}
            confirmLabel='Delete them all?'
            className='rounded-md border border-slate-200 px-2 py-1 text-[11.5px] font-medium text-slate-700 hover:bg-muted dark:border-border dark:text-slate-200'
            armedClassName='border-red-300 text-red-600 dark:border-red-500/40'
          >
            Also delete my saved conversations
          </ConfirmButton>
          <span className='text-[11px] text-slate-500 dark:text-muted-foreground'>
            Only the ones you started; shares of them go too.
          </span>
        </div>
      )}
      {deleted != null && (
        <p className='mt-1.5 pl-[42px] text-[11px] text-slate-500 dark:text-muted-foreground'>
          Deleted {deleted} {deleted === 1 ? 'conversation' : 'conversations'}.
        </p>
      )}
    </div>
  )
}
