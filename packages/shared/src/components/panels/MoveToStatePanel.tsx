import { useMutation, useQuery } from '@tanstack/react-query'
import { AlertTriangle, Loader2, MoveRight } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { get, post } from '../../lib/commands'
import { toastError } from '../../lib/error-toast'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { SimpleSelect } from '../ui/SimpleSelect'

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
  states: givenStates,
  currentStateId: givenCurrent,
  onMoved,
  openSignal = 0,
  standalone = false,
  onCancel
}: {
  collection: string
  item: string | number
  /** The pipeline's states; read from the instance when not given (⋯ menu dialog). */
  states?: StateOption[]
  currentStateId?: string | null
  onMoved: () => void
  /** Bumped by the record's ⋯ menu → Move to state…: opens the form. */
  openSignal?: number
  /** Always open, no fold link — the ⋯ menu's dialog when no panel is on the form. */
  standalone?: boolean
  onCancel?: () => void
}) {
  const client = useNivaroClient()
  const [open, setOpen] = useState(standalone)
  const [target, setTarget] = useState('')
  const [reason, setReason] = useState('')
  useEffect(() => {
    if (openSignal > 0) setOpen(true)
  }, [openSignal])

  const { data: instanceData, isLoading } = useQuery({
    queryKey: ['move-state-instance', collection, String(item)],
    queryFn: () =>
      client.request(
        get(`/pipelines/instance/${collection}/${encodeURIComponent(String(item))}`)
      ) as Promise<{
        data: { instance: { current_state: string | null } | null; states: StateOption[] }
      }>,
    enabled: !givenStates
  })
  const states = givenStates ?? instanceData?.data?.states ?? []
  const currentStateId = givenStates
    ? (givenCurrent ?? null)
    : (instanceData?.data?.instance?.current_state ?? null)
  const noPipeline = !givenStates && !isLoading && !instanceData?.data?.instance

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
      if (!standalone) setOpen(false)
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

  if (noPipeline) {
    return (
      <p className='text-[12px] text-slate-500' data-move-to-state-none>
        This record has no pipeline to move.
      </p>
    )
  }

  return (
    <form
      className='rounded-lg border border-slate-200 bg-white dark:border-border dark:bg-card'
      data-move-to-state-form
      onSubmit={(e) => {
        e.preventDefault()
        if (canMove) move.mutate()
      }}
    >
      <div className='flex items-start gap-2.5 border-b border-slate-100 px-4 py-3 dark:border-border/60'>
        <MoveRight className='mt-0.5 h-4 w-4 shrink-0 text-slate-400' />
        <div className='min-w-0 space-y-0.5'>
          <p className='text-[13px] font-medium text-slate-800 dark:text-slate-100'>
            Move to state
          </p>
          <p className='flex items-center gap-1.5 text-[12px] text-amber-700 dark:text-amber-300'>
            <AlertTriangle className='h-3.5 w-3.5 shrink-0' />
            Skips the transition: no Fusion or MWF pushes, emails or flows run.
          </p>
        </div>
      </div>
      <div className='space-y-3 px-4 py-3.5'>
        <div className='flex flex-wrap items-start gap-x-4 gap-y-3'>
          <div className='w-full space-y-1.5 sm:w-60'>
            <span className='block text-[12px] font-medium text-slate-600 dark:text-slate-300'>
              New state
            </span>
            <SimpleSelect
              value={target}
              onChange={setTarget}
              options={options}
              ariaLabel='New state'
              className='h-8 text-[12.5px]'
              disabled={move.isPending || (!givenStates && isLoading)}
            />
          </div>
          <div className='min-w-0 flex-1 basis-72 space-y-1.5'>
            <span className='block text-[12px] font-medium text-slate-600 dark:text-slate-300'>
              Reason
            </span>
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder='Why it moves — saved in the history'
              maxLength={500}
              disabled={move.isPending}
              className='h-8 text-[12.5px]'
              aria-label='Reason'
              aria-describedby='move-state-hint'
            />
          </div>
        </div>
        <p id='move-state-hint' className='text-[11.5px] text-slate-500 dark:text-slate-400'>
          {!reasonOk && reason.length > 0
            ? `A few more words, please (${MOVE_REASON_MIN} characters or more).`
            : 'Automatic rules are checked again afterwards, so the record may move on by itself.'}
        </p>
        <div className='flex items-center gap-2'>
          <Button
            type='submit'
            size='sm'
            className='h-8 gap-1.5 bg-nvr-cyan px-3.5 text-[12.5px] text-white hover:bg-nvr-cyan/90'
            disabled={!canMove}
            data-move-to-state-submit
          >
            {move.isPending && <Loader2 className='h-3.5 w-3.5 animate-spin' />}
            Move
          </Button>
          <Button
            type='button'
            size='sm'
            variant='ghost'
            className='h-8 text-[12.5px]'
            onClick={() => (standalone ? onCancel?.() : setOpen(false))}
            disabled={move.isPending}
          >
            Cancel
          </Button>
        </div>
      </div>
    </form>
  )
}
