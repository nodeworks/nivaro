/**
 * Range selection under the replay scrubber and what to do with a range:
 * raise an issue on it (#1366). Drag along the track to select; drag either
 * handle (or focus it and use the arrow keys) to adjust.
 */
import { useMutation } from '@tanstack/react-query'
import { Bug, X } from 'lucide-react'
import { memo, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Textarea } from '@/components/ui/textarea'
import { api } from '@/lib/api'
import { fmtClock } from './logic'
import { dragRange, fmtSpan, moveEdge, msAtX, type ReplayRange, usableRange } from './range'

function apiError(err: unknown, fallback: string): string {
  return (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback
}

// ── The track ────────────────────────────────────────────────────────────────

export const RangeTrack = memo(function RangeTrack({
  total,
  range,
  onChange
}: {
  total: number
  range: ReplayRange | null
  onChange: (r: ReplayRange | null) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const drag = useRef<{ kind: 'new'; anchor: number } | { kind: 'start' | 'end' } | null>(null)

  const msAt = (clientX: number) => {
    const el = ref.current
    if (!el) return 0
    const box = el.getBoundingClientRect()
    return msAtX(clientX, box.left, box.width, total)
  }

  function onPointerDown(e: React.PointerEvent<HTMLDivElement>) {
    if (!(total > 0) || e.button > 0) return
    const edge = (e.target as HTMLElement).dataset.edge as 'start' | 'end' | undefined
    if (edge && range) drag.current = { kind: edge }
    else {
      const anchor = msAt(e.clientX)
      drag.current = { kind: 'new', anchor }
      onChange([anchor, anchor])
    }
    e.currentTarget.setPointerCapture?.(e.pointerId)
    e.preventDefault()
  }

  function onPointerMove(e: React.PointerEvent<HTMLDivElement>) {
    const d = drag.current
    if (!d) return
    const ms = msAt(e.clientX)
    if (d.kind === 'new') onChange(dragRange(d.anchor, ms))
    else if (range) onChange(moveEdge(range, d.kind, ms, total))
  }

  function onPointerUp(e: React.PointerEvent<HTMLDivElement>) {
    const d = drag.current
    drag.current = null
    e.currentTarget.releasePointerCapture?.(e.pointerId)
    // A click (or a sliver) is not a selection.
    if (d?.kind === 'new' && !usableRange(range)) onChange(null)
  }

  function onHandleKey(edge: 'start' | 'end', e: React.KeyboardEvent) {
    if (!range) return
    const step = e.shiftKey ? 5_000 : 1_000
    const at = edge === 'start' ? range[0] : range[1]
    if (e.key === 'ArrowLeft') onChange(moveEdge(range, edge, at - step, total))
    else if (e.key === 'ArrowRight') onChange(moveEdge(range, edge, at + step, total))
    else if (e.key === 'Escape') onChange(null)
    else return
    e.preventDefault()
  }

  const pct = (ms: number) => `${Math.min(100, Math.max(0, (ms / Math.max(1, total)) * 100))}%`

  return (
    <div
      ref={ref}
      className='group/range relative mt-1 h-3 cursor-crosshair touch-none select-none rounded-sm bg-slate-100 dark:bg-muted'
      data-replay-range=''
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {!range && (
        <span className='pointer-events-none absolute inset-0 flex items-center justify-center text-[9px] leading-none text-slate-400 opacity-0 transition-opacity group-hover/range:opacity-100'>
          Drag to select a range — raise an issue on it
        </span>
      )}
      {range && (
        <>
          <div
            className='pointer-events-none absolute inset-y-0 bg-[#00ceff]/30'
            style={{ left: pct(range[0]), right: `calc(100% - ${pct(range[1])})` }}
          />
          {(['start', 'end'] as const).map((edge) => {
            const at = edge === 'start' ? range[0] : range[1]
            return (
              <span
                key={edge}
                role='slider'
                tabIndex={0}
                aria-label={edge === 'start' ? 'Range start' : 'Range end'}
                aria-valuemin={0}
                aria-valuemax={total}
                aria-valuenow={at}
                aria-valuetext={fmtClock(at)}
                data-edge={edge}
                onKeyDown={(e) => onHandleKey(edge, e)}
                className='absolute -top-0.5 h-4 w-1.5 -translate-x-1/2 cursor-ew-resize rounded-sm bg-[#00ceff] focus:outline-none focus:ring-2 focus:ring-[#00ceff]/50'
                style={{ left: pct(at) }}
              />
            )
          })}
        </>
      )}
    </div>
  )
})

// ── The action strip ─────────────────────────────────────────────────────────

export function RangeActions({
  recordingId,
  range,
  time,
  total,
  onChange,
  onSeek
}: {
  recordingId: string
  range: ReplayRange
  time: number
  total: number
  onChange: (r: ReplayRange | null) => void
  onSeek: (ms: number) => void
}) {
  const [dialog, setDialog] = useState<'issue' | null>(null)
  const ok = usableRange(range)
  return (
    <div
      className='mt-2 flex flex-wrap items-center gap-2 rounded-md border border-[#00ceff]/40 bg-[#00ceff]/5 px-3 py-1.5 text-[12px]'
      data-replay-range-actions=''
    >
      <button
        type='button'
        className='font-mono tabular-nums text-slate-700 hover:underline dark:text-slate-200'
        onClick={() => onSeek(range[0])}
        data-tip='Go to the start of the range'
      >
        {fmtClock(range[0])} – {fmtClock(range[1])}
      </button>
      <span className='text-slate-400'>{fmtSpan(range[1] - range[0])}</span>
      <Button
        size='sm'
        variant='ghost'
        className='h-6 px-2 text-[11.5px]'
        onClick={() => onChange(moveEdge(range, 'start', time, total))}
      >
        Start at playhead
      </Button>
      <Button
        size='sm'
        variant='ghost'
        className='h-6 px-2 text-[11.5px]'
        onClick={() => onChange(moveEdge(range, 'end', time, total))}
      >
        End at playhead
      </Button>
      <span className='flex-1' />
      <Button
        size='sm'
        variant='outline'
        className='h-7 gap-1.5 text-[12px]'
        disabled={!ok}
        onClick={() => setDialog('issue')}
      >
        <Bug className='h-3.5 w-3.5' /> Raise an issue
      </Button>
      <button
        type='button'
        aria-label='Clear range'
        className='p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
        onClick={() => onChange(null)}
      >
        <X className='h-3.5 w-3.5' />
      </button>
      <ClipIssueDialog
        open={dialog === 'issue'}
        onClose={() => setDialog(null)}
        recordingId={recordingId}
        range={range}
      />
    </div>
  )
}

// ── Raise an issue (#1366) ───────────────────────────────────────────────────

function ClipIssueDialog({
  open,
  onClose,
  recordingId,
  range
}: {
  open: boolean
  onClose: () => void
  recordingId: string
  range: ReplayRange
}) {
  const navigate = useNavigate()
  const [title, setTitle] = useState('')
  const [note, setNote] = useState('')
  const [severity, setSeverity] = useState('medium')
  const raise = useMutation({
    mutationFn: () =>
      api
        .post<{ data: { issue_id: number } }>(`/session-recordings/${recordingId}/clip-issue`, {
          from_ms: range[0],
          to_ms: range[1],
          title: title.trim() || undefined,
          note: note.trim() || undefined,
          severity
        })
        .then((r) => r.data.data),
    onSuccess: (d) => {
      toast.success(`Issue #${d.issue_id} raised with the clip`)
      onClose()
      navigate(`/issues/${d.issue_id}`)
    },
    onError: (err) => toast.error(apiError(err, 'Could not raise the issue'))
  })
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Raise an issue from this clip</DialogTitle>
          <DialogDescription>
            {fmtClock(range[0])} – {fmtClock(range[1])} is cut into its own replay and linked from
            the issue, with the page it opens on, its console errors and the requests made in it.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className='space-y-3'>
          <Input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder='Title (optional — named after the page otherwise)'
            aria-label='Issue title'
            maxLength={500}
          />
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder='What goes wrong in this clip?'
            aria-label='Issue note'
            rows={4}
          />
          <SimpleSelect
            value={severity}
            onChange={setSeverity}
            ariaLabel='Severity'
            className='h-8 w-40 text-[12.5px]'
            options={['low', 'medium', 'high', 'critical'].map((s) => ({ value: s, label: s }))}
          />
        </DialogBody>
        <DialogFooter>
          <Button variant='outline' onClick={onClose} disabled={raise.isPending}>
            Cancel
          </Button>
          <Button onClick={() => raise.mutate()} disabled={raise.isPending}>
            {raise.isPending ? 'Raising…' : 'Raise issue'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
