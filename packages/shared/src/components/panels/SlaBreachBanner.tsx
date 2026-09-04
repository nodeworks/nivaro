import { humanHours } from '../../lib/utils'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useNivaroClient } from '../../context'
import { get, post } from '../../lib/commands'

/**
 * SLA breach strip for the record form's banner stack: breached + laddered
 * records show how long past the limit they are and an Acknowledge button —
 * acknowledging stops the escalation ladder for this state-entry episode.
 * Renders nothing when not breached (the common case costs one status read
 * the form's SLA surfaces mostly issue anyway).
 */
export function SlaBreachBanner({ collection, itemId }: { collection: string; itemId: string }) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [note, setNote] = useState('')
  const [ackOpen, setAckOpen] = useState(false)

  const { data } = useQuery<{
    status?: string
    elapsed_hours?: number
    total_hours?: number
    sla_rule?: { name?: string } | null
    acknowledged?: { at: string; by: string } | null
    has_ladder?: boolean
  } | null>({
    queryKey: ['sla-breach', collection, itemId],
    queryFn: () =>
      client
        .request<Record<string, unknown>>(get(`/sla/status/${collection}/${itemId}`))
        .then((r) => r as never)
        .catch(() => null),
    enabled: !!itemId,
    staleTime: 60_000
  })

  const ack = useMutation({
    mutationFn: () =>
      client.request(post('/sla/ack', { collection, item: itemId, note: note.trim() || undefined })),
    onSuccess: () => {
      setAckOpen(false)
      void qc.invalidateQueries({ queryKey: ['sla-breach', collection, itemId] })
    }
  })

  if (!data || data.status !== 'breached') return null
  const hoursPast = Math.max(0, (data.elapsed_hours ?? 0) - (data.total_hours ?? 0))

  return (
    <div className='flex flex-wrap items-center gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 dark:border-red-500/30 dark:bg-red-500/10'>
      <p className='min-w-0 flex-1 text-[12.5px] text-red-800 dark:text-red-300'>
        <span className='font-semibold'>SLA breached</span>
        {data.sla_rule?.name && ` — ${data.sla_rule.name}`} · {humanHours(hoursPast)} past the limit
        {data.acknowledged
          ? ` · acknowledged by ${data.acknowledged.by || 'someone'}`
          : data.has_ladder
            ? ' · escalating until acknowledged'
            : ''}
      </p>
      {!data.acknowledged && (
        <>
          {ackOpen && (
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder='Optional note…'
              className='h-7 w-[200px] rounded-md border border-red-200 bg-white px-2 text-[12px] dark:border-red-500/40 dark:bg-card'
            />
          )}
          <button
            type='button'
            disabled={ack.isPending}
            onClick={() => {
              if (!ackOpen) setAckOpen(true)
              else ack.mutate()
            }}
            className='shrink-0 rounded-md border border-red-300 px-2.5 py-1 text-[12px] font-medium text-red-700 hover:bg-red-100 disabled:opacity-50 dark:border-red-500/40 dark:bg-transparent dark:text-red-300 dark:hover:bg-red-500/15'
          >
            {ack.isPending ? 'Acknowledging…' : ackOpen ? 'Confirm acknowledge' : 'Acknowledge'}
          </button>
        </>
      )}
    </div>
  )
}
