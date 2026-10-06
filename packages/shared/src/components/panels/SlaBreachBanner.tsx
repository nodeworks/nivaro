import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useNivaroClient } from '../../context'
import { post } from '../../lib/commands'
import { humanHours } from '../../lib/utils'
import { AdjustClockPopover, overrideSentence, slaStatusKey, useSlaStatus } from './SlaClock'

/**
 * SLA strip for the record form's banner stack. Breached records show how
 * long past the limit they are and an Acknowledge button — acknowledging
 * stops the escalation ladder for this state-entry episode. A record whose
 * clock was adjusted (#1239) shows who moved it and why even before it
 * breaches. People allowed to move the clock get "Adjust clock" here.
 * Renders nothing otherwise (the common case costs one status read the
 * form's SLA surfaces mostly issue anyway).
 */
export function SlaBreachBanner({ collection, itemId }: { collection: string; itemId: string }) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const [note, setNote] = useState('')
  const [ackOpen, setAckOpen] = useState(false)

  const { data } = useSlaStatus(collection, itemId)

  const ack = useMutation({
    mutationFn: () =>
      client.request(
        post('/sla/ack', { collection, item: itemId, note: note.trim() || undefined })
      ),
    onSuccess: () => {
      setAckOpen(false)
      void qc.invalidateQueries({ queryKey: slaStatusKey(collection, itemId) })
    }
  })

  if (!data) return null

  // Not breached: only an adjusted clock earns a strip.
  if (data.status !== 'breached') {
    if (!data.override || !data.status || data.status === 'none') return null
    const left = (data.total_hours ?? 0) - (data.elapsed_hours ?? 0)
    return (
      <div
        data-sla-override-banner
        className='nvr-expand-in flex flex-wrap items-center gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 dark:border-border dark:bg-muted/40'
      >
        <p className='min-w-0 flex-1 text-[12.5px] text-slate-700 dark:text-slate-200'>
          <span className='font-semibold'>SLA</span>
          {data.sla_rule?.name && ` — ${data.sla_rule.name}`} · {humanHours(left)} left ·{' '}
          {overrideSentence(data.override)}
          <span className='block truncate text-[11.5px] text-slate-500 dark:text-slate-400'>
            “{data.override.reason}”
          </span>
        </p>
        {data.can_adjust && (
          <AdjustClockPopover collection={collection} itemId={itemId} data={data} />
        )}
      </div>
    )
  }

  const hoursPast = Math.max(0, (data.elapsed_hours ?? 0) - (data.total_hours ?? 0))

  return (
    <div className='nvr-expand-in flex flex-wrap items-center gap-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 dark:border-red-500/30 dark:bg-red-500/10'>
      <p className='min-w-0 flex-1 text-[12.5px] text-red-800 dark:text-red-300'>
        <span className='font-semibold'>SLA breached</span>
        {data.sla_rule?.name && ` — ${data.sla_rule.name}`} · {humanHours(hoursPast)} past the limit
        {data.acknowledged
          ? ` · acknowledged by ${data.acknowledged.by || 'someone'}`
          : data.has_ladder
            ? ' · escalating until acknowledged'
            : ''}
        {data.override && (
          <span className='block text-[11.5px] text-red-700/80 dark:text-red-300/80'>
            {overrideSentence(data.override)} — “{data.override.reason}”
          </span>
        )}
      </p>
      {data.can_adjust && (
        <AdjustClockPopover collection={collection} itemId={itemId} data={data} tone='danger' />
      )}
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
