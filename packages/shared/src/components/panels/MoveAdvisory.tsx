import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Loader2 } from 'lucide-react'
import { type CSSProperties, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { useNivaroClient } from '../../context'
import { get, post } from '../../lib/commands'
import { toastError } from '../../lib/error-toast'
import { cn } from '../../lib/utils'
import { invalidateRecordData } from '../item-edit/RecordInsights'
import { Button } from '../ui/button'

/**
 * What a registered transition check would answer for a move on offer — the
 * refusal, said before the move is pressed (`available_transitions[].advisory`
 * on GET /pipelines/instance/:collection/:item; api transition-checks.ts runs
 * the gate's own checks for it, so the two cannot disagree).
 */
export interface MoveAdvisory {
  code: string
  message: string
  /** The registry action that clears it, when the check names one. */
  fix?: { action: string; label?: string | null } | null
}

/**
 * A refusal the record page can fix in place: the refusal code → the key of
 * the registry action that fixes it, for checks that do not name their own
 * fix. Offered only when that action is available to the caller for this
 * collection (/bulk-actions/available judges access), so a person who cannot
 * fix it just reads the message (army4 a15-2: Priority could only be set from
 * the list's row menu).
 */
export const REFUSAL_FIX_ACTIONS: Readonly<Record<string, string>> = {
  PRIORITY_REQUIRED: 'priority',
  // A held record does not move forward (efp-ops hold-gate, army 11): taking
  // the hold off is one deliberate, noted step, then the move is tried again.
  ON_HOLD: 'remove-hold'
}

/** The registry action that clears an advisory: the one its check names, else the code's. */
export function advisoryFixKey(a: Pick<MoveAdvisory, 'code' | 'fix'>): string | null {
  return a.fix?.action?.trim() || REFUSAL_FIX_ACTIONS[a.code] || null
}

/**
 * One notice per distinct reason, with the moves it holds back: a single cause
 * (a hold, a spent budget) usually stops several moves with the same words.
 */
export function distinctAdvisories<T extends { id: string; advisory?: MoveAdvisory | null }>(
  moves: T[]
): Array<{ advisory: MoveAdvisory; moves: T[] }> {
  const out = new Map<string, { advisory: MoveAdvisory; moves: T[] }>()
  for (const m of moves) {
    if (!m.advisory?.message) continue
    const key = `${m.advisory.code}\u0000${m.advisory.message}`
    const hit = out.get(key)
    if (hit) hit.moves.push(m)
    else out.set(key, { advisory: m.advisory, moves: [m] })
  }
  return [...out.values()]
}

export interface RecordFixAction {
  key: string
  label: string
  require_reason: boolean
  source: string
}

/**
 * A registry action as it is offered to THIS person for the collection (null
 * when it is not: the registry judges access, never the page), and a runner
 * for it on one record — the same write the list's row menu makes, with its
 * permission check, reason and activity entry.
 */
export function useRecordFixAction(collection: string, item: string, actionKey: string | null) {
  const client = useNivaroClient()
  const queryClient = useQueryClient()
  const { data: action, isLoading } = useQuery({
    queryKey: ['bulk-actions-available-one', collection, actionKey],
    enabled: !!actionKey,
    queryFn: async () => {
      const res = await client.request<{ data: RecordFixAction[] }>(
        get('/bulk-actions/available', { collection })
      )
      return (res.data ?? []).find((a) => a.key === actionKey) ?? null
    },
    staleTime: 60_000
  })
  const run = async (reason: string) => {
    if (!action) throw new Error('This action is not available')
    const body = { collection, ids: [item], reason: reason.trim() || null }
    type Result = { data: { succeeded?: number; errors?: Array<{ error: string }> } }
    const res =
      action.source === 'extension'
        ? await client.request<Result>(post(`/bulk-actions/${action.key}/execute`, body))
        : await client.request<Result>(post('/bulk-actions/run', { ...body, key: action.key }))
    const r = res.data ?? {}
    if (action.source !== 'extension' && !(r.succeeded && r.succeeded > 0))
      throw new Error(r.errors?.[0]?.error || `${action.label} did not change the record`)
    invalidateRecordData(queryClient, collection, item)
  }
  return { action: action ?? null, isLoading: !!actionKey && isLoading, run }
}

/**
 * The notice for a move a check would refuse: the check's own words and, for a
 * person the registry lets clear it, the action that does — right beside the
 * move, before it is pressed. Anyone else reads the message (it says who can).
 *
 * `armedMove` is the move the person pressed anyway: the notice opens on the
 * fix and then goes on to that move. `floating` is the header's variant, which
 * has no row to sit in and opens under the buttons.
 *
 * A pressed move lights its notice up and brings it into view, whether or not
 * this person can clear it: for someone who cannot, nothing else on the page
 * changes, and the press looked ignored.
 */
export function MoveAdvisoryNotice({
  collection,
  item,
  advisory,
  armedMove,
  stops,
  floating,
  onFixed,
  onDismiss,
  className,
  style
}: {
  collection: string
  item: string
  advisory: MoveAdvisory
  /** `confirms`: the move asks before it runs (a note, a final step), so after
   *  the fix it is still the person's to confirm. */
  armedMove?: { id: string; label: string; confirms?: boolean } | null
  /** The moves this reason holds back, by name. Given when several reasons show
   *  at once: the marks on the buttons do not say which reason is whose. */
  stops?: string[]
  floating?: boolean
  /** The fix ran; `thenMove` is the pressed move to go on with (null = none was pressed). */
  onFixed?: (thenMove: { id: string; label: string } | null) => void
  /** Leave the armed state (Not now / Close). */
  onDismiss?: () => void
  className?: string
  style?: CSSProperties
}) {
  const { action, isLoading, run } = useRecordFixAction(collection, item, advisoryFixKey(advisory))
  const [asked, setAsked] = useState(false)
  const [reason, setReason] = useState('')
  const reasonRef = useRef<HTMLInputElement>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const open = !!action && (asked || !!armedMove)
  // The form opened by a press (here or on the move): the reason is what is asked for next.
  useEffect(() => {
    if (open) reasonRef.current?.focus()
  }, [open])
  // A pressed move: this is why it did not go. The notice may sit a card's
  // length from the button that was pressed.
  const armedId = armedMove?.id
  useEffect(() => {
    if (armedId) rootRef.current?.scrollIntoView?.({ block: 'nearest' })
  }, [armedId])
  const fixLabel = advisory.fix?.label?.trim() || action?.label || ''
  const fix = useMutation({
    mutationFn: () => run(reason),
    onSuccess: () => {
      // Only the fix is done. A move that asks first is still to confirm; one
      // that does not goes on by itself and says so in its own words.
      toast.success(
        armedMove?.confirms
          ? `Done: ${fixLabel}. Confirm ${armedMove.label} to finish.`
          : `Done: ${fixLabel}.`
      )
      setAsked(false)
      setReason('')
      onFixed?.(armedMove ?? null)
    },
    onError: (err) => toastError(err, `${action?.label ?? 'The action'} failed`)
  })
  const canRun = !fix.isPending && (!action?.require_reason || reason.trim().length > 0)
  const close = () => {
    setAsked(false)
    setReason('')
    onDismiss?.()
  }
  return (
    <div
      ref={rootRef}
      role={armedMove ? 'status' : 'note'}
      data-move-advisory={advisory.code}
      className={cn(
        'flex items-start gap-2.5',
        floating
          ? 'rounded-lg border border-amber-200 bg-amber-50 p-3 shadow-lg dark:border-amber-500/30 dark:bg-amber-950'
          : 'border-t border-amber-200/80 bg-amber-50/70 px-4 py-2.5 dark:border-amber-500/20 dark:bg-amber-500/[0.06]',
        armedMove && 'ring-1 ring-inset ring-amber-400 dark:ring-amber-400/60',
        className
      )}
      style={style}
    >
      <AlertTriangle
        aria-hidden
        className='mt-[3px] h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-400'
      />
      <div className='min-w-0 flex-1 space-y-2'>
        <div>
          <p className='break-words text-[13px] leading-snug text-slate-800 dark:text-slate-100'>
            {advisory.message}
          </p>
          {!!stops?.length && (
            <p
              className='mt-0.5 text-[11.5px] text-amber-800/80 dark:text-amber-300/80'
              data-move-advisory-stops
            >
              Stops: {stops.join(', ')}
            </p>
          )}
        </div>
        {open && action && (
          <form
            className='space-y-2'
            onSubmit={(e) => {
              e.preventDefault()
              if (canRun) fix.mutate()
            }}
          >
            {action.require_reason && (
              <input
                ref={reasonRef}
                type='text'
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder='Reason (required)'
                aria-label='Reason'
                className='w-full rounded-md border border-slate-200 bg-white px-3 py-1.5 text-[13px] text-slate-900 placeholder-slate-500 focus:outline-none focus:ring-2 focus:ring-nvr-cyan/30 dark:border-border dark:bg-card dark:text-slate-100 dark:placeholder-slate-400'
              />
            )}
            <div className='flex flex-wrap items-center justify-end gap-2'>
              <Button
                type='button'
                size='sm'
                variant='ghost'
                className='h-7 text-[12px]'
                onClick={close}
              >
                Not now
              </Button>
              <Button
                type='submit'
                size='sm'
                className='h-7 gap-1.5 text-[12px]'
                disabled={!canRun}
                data-move-advisory-run
              >
                {fix.isPending && <Loader2 className='h-3 w-3 animate-spin' />}
                {armedMove ? `${fixLabel}, then ${armedMove.label}` : fixLabel}
              </Button>
            </div>
          </form>
        )}
        {/* Pressed a move this person cannot clear: the message says who can; let them close it. */}
        {armedMove && !action && !isLoading && floating && (
          <div className='flex justify-end'>
            <Button
              type='button'
              size='sm'
              variant='ghost'
              className='h-7 text-[12px]'
              onClick={close}
            >
              Close
            </Button>
          </div>
        )}
      </div>
      {action && !open && (
        <Button
          type='button'
          size='sm'
          variant='outline'
          className='h-7 shrink-0 text-[12px]'
          onClick={() => setAsked(true)}
          data-move-advisory-fix={action.key}
        >
          {fixLabel}
        </Button>
      )}
    </div>
  )
}
