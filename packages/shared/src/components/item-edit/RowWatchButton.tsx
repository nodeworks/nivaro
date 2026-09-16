import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Bell, BellRing } from 'lucide-react'
import type React from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { del, post } from '../../lib/commands'
import { MY_SUBSCRIPTIONS_KEY, useRecordSubscriptions } from './use-my-subscriptions'

/**
 * #11 — watch ONE grid row (a forecast year, a PO line) from the row's own
 * actions. The subscription is the same shape the record bell writes for
 * "all changes", pointed at the child collection + row id, so the server's
 * record-scoped path fires on exactly that row's diffs — and names the row
 * and the record it belongs to ("forecasts 2026 on CM26-79811").
 */
export function RowWatchButton({
  collection,
  rowId,
  rowLabel
}: {
  collection: string
  rowId: string
  /** The row's friendly label for the subscription's own label ("2026"). */
  rowLabel?: string | null
}) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  // One shared list read for every row + the record bell — narrowed here.
  const { data: subs = [] } = useRecordSubscriptions(collection, String(rowId))
  const watched = subs.length > 0
  const label = `Watching ${collection.replace(/_/g, ' ')} ${rowLabel || `#${rowId}`}`.slice(0, 255)
  const toggle = useMutation({
    mutationFn: async () => {
      if (watched) {
        for (const s of subs) await client.request(del(`/notification-subscriptions/${s.id}`))
        return false
      }
      await client.request(
        post('/notification-subscriptions', {
          collection,
          event_type: 'all',
          filter_field: 'id',
          filter_value: String(rowId),
          label
        })
      )
      return true
    },
    onSuccess: (now) => {
      void qc.invalidateQueries({ queryKey: MY_SUBSCRIPTIONS_KEY })
      toast.success(
        now ? 'Watching this line — its changes will notify you' : 'Stopped watching this line'
      )
    },
    onError: () => toast.error('Could not update the watch')
  })
  const onClick = (e: React.MouseEvent) => {
    e.stopPropagation()
    if (!toggle.isPending) toggle.mutate()
  }
  return (
    <button
      type='button'
      title={watched ? 'Stop watching this line' : 'Watch this line'}
      data-tip={
        watched ? 'You are notified when this line changes' : 'Notify me when this line changes'
      }
      data-row-watch={rowId}
      data-row-watched={watched ? 'true' : undefined}
      onClick={onClick}
      disabled={toggle.isPending}
      className={`rounded p-0.5 ${watched ? 'text-nvr-cyan' : 'text-slate-300 hover:text-[#00ceff]'}`}
    >
      {watched ? <BellRing className='h-3 w-3' /> : <Bell className='h-3 w-3' />}
    </button>
  )
}
