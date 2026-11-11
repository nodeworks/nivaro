import { useMutation } from '@tanstack/react-query'
import { Loader2, MoveRight } from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { post } from '../../lib/commands'
import { toastError } from '../../lib/error-toast'
import { Button } from '../ui/button'
import { SimpleSelect } from '../ui/SimpleSelect'
import { Textarea } from '../ui/textarea'

export const MOVE_REASON_MIN = 5

interface StateOption {
  id: string
  label: string
}

interface MoveResult {
  to: { label: string }
  ended: { label: string } | null
}

/**
 * Admin "Move to state" — an inline repair form on the pipeline panel. Puts
 * this one record straight into the chosen state with a reason; no transition
 * steps run (POST /pipelines/instance/:collection/:item/move-state).
 */
export function MoveToStatePanel({
  collection,
  item,
  states,
  currentStateId,
  onMoved
}: {
  collection: string
  item: string | number
  states: StateOption[]
  currentStateId: string | null
  onMoved: () => void
}) {
  const client = useNivaroClient()
  const [open, setOpen] = useState(false)
  const [target, setTarget] = useState('')
  const [reason, setReason] = useState('')

  const options = useMemo(
    () => [
      { value: '', label: 'Pick a state' },
      ...states
        .filter((s) => String(s.id).toUpperCase() !== String(currentStateId ?? '').toUpperCase())
        .map((s) => ({ value: String(s.id), label: s.label }))
    ],
    [states, currentStateId]
  )

  const move = useMutation({
    mutationFn: () =>
      client.request(
        post(`/pipelines/instance/${collection}/${encodeURIComponent(String(item))}/move-state`, {
          to_state: target,
          reason: reason.trim()
        })
      ) as Promise<{ data: MoveResult }>,
    onSuccess: (res) => {
      const r = res?.data
      toast.success(
        r?.ended
          ? `Moved to ${r.to.label}, then an automatic rule took it to ${r.ended.label}`
          : `Moved to ${r?.to.label ?? 'the new state'}`
      )
      setOpen(false)
      setTarget('')
      setReason('')
      onMoved()
    },
    onError: (err) => toastError(err, 'Could not move it')
  })

  const reasonOk = reason.trim().length >= MOVE_REASON_MIN
  const canMove = !!target && reasonOk && !move.isPending

  if (!open) {
    return (
      <button
        type='button'
        className='flex items-center gap-1.5 text-[12px] text-slate-400 transition-colors hover:text-slate-600 dark:hover:text-slate-300'
        onClick={() => setOpen(true)}
        data-move-to-state-open
      >
        <MoveRight className='h-3.5 w-3.5' />
        Move to state…
      </button>
    )
  }

  return (
    <div
      className='space-y-3 rounded-lg border border-amber-200 bg-amber-50/60 p-3 dark:border-amber-500/25 dark:bg-amber-500/[0.06]'
      data-move-to-state-form
    >
      <div className='space-y-1'>
        <p className='text-[12px] font-medium text-slate-800 dark:text-slate-200'>Move to state</p>
        <p className='text-[11px] leading-relaxed text-slate-600 dark:text-slate-400'>
          Administrators only. Puts this record straight into the state you pick. No transition
          steps run: no Fusion or MWF pushes, emails or flows. Automatic rules are checked again
          afterwards, so it may move on by itself.
        </p>
      </div>
      <div className='grid gap-2 sm:grid-cols-[minmax(0,220px)_1fr]'>
        <SimpleSelect
          value={target}
          onChange={setTarget}
          options={options}
          ariaLabel='New state'
          disabled={move.isPending}
        />
        <Textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder='Why? Saved in the history.'
          rows={2}
          maxLength={500}
          disabled={move.isPending}
          className='min-h-[38px] text-[12px]'
          aria-label='Reason'
        />
      </div>
      <div className='flex items-center justify-end gap-2'>
        {!reasonOk && reason.length > 0 && (
          <span className='mr-auto text-[11px] text-slate-500'>
            A few more words, please ({MOVE_REASON_MIN} characters or more).
          </span>
        )}
        <Button
          size='sm'
          variant='ghost'
          className='h-7 text-[12px]'
          onClick={() => setOpen(false)}
          disabled={move.isPending}
        >
          Cancel
        </Button>
        <Button
          size='sm'
          className='h-7 gap-1.5 bg-nvr-cyan text-[12px] text-white hover:bg-nvr-cyan/90'
          onClick={() => move.mutate()}
          disabled={!canMove}
          data-move-to-state-submit
        >
          {move.isPending && <Loader2 className='h-3 w-3 animate-spin' />}
          Move
        </Button>
      </div>
    </div>
  )
}
