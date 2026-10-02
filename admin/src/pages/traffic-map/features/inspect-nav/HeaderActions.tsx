/**
 * Investigation header actions of group "nav":
 *  - Time anchor (#1206): which moment the investigation looks around and how wide, with a
 *    "Rewind map to here" that pauses the map at that second;
 *  - Keys (#1209): the panel's and the ticker's keyboard keys, in a small popover.
 */
import { Clock } from 'lucide-react'
import { useState, useSyncExternalStore } from 'react'
import { toast } from 'sonner'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { SimpleSelect } from '@/components/ui/simple-select'
import { cn } from '@/lib/utils'
import { fmtClock } from '../../inspect/format'
import { getInspectSnapshot, setAnchor, setWindow, subscribeInspect } from '../../inspect/stack'
import { requestMapRewind } from '../../RewindBar'
import type { InspectPanelProps } from '../../registry/inspectables'
import { BTN } from '../shared'
import { canRewindTo, WINDOW_CHOICES, windowText } from './logic'

const HEAD_BTN =
  'inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11.5px] font-medium text-[var(--tm-fg-2)] transition-colors duration-150 ease-out hover:bg-[var(--tm-card-2)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
const POP = 'traffic-map border-[var(--tm-line)] bg-[var(--tm-card)] p-3 text-[var(--tm-fg)]'

function useStack() {
  return useSyncExternalStore(subscribeInspect, getInspectSnapshot, getInspectSnapshot)
}

export function AnchorAction({ inspectRef }: InspectPanelProps) {
  const s = useStack()
  const [open, setOpen] = useState(false)
  const anchor = s.anchor
  const levelAt = inspectRef.at ?? null
  const target = anchor ?? levelAt
  const options = (
    WINDOW_CHOICES.includes(s.windowSec as (typeof WINDOW_CHOICES)[number])
      ? [...WINDOW_CHOICES]
      : [...WINDOW_CHOICES, s.windowSec].sort((a, b) => a - b)
  ).map((v) => ({ value: String(v), label: windowText(v) }))
  const rewindable = canRewindTo(target)
  const rewind = () => {
    if (target == null) return
    const r = requestMapRewind(target)
    if (r === 'unavailable') toast.error('The map cannot pause here, so it cannot rewind.')
    else setOpen(false)
  }
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type='button'
          className={HEAD_BTN}
          aria-label='Time anchor and window'
          data-tip='The moment this investigation looks around, and how wide'
          data-tm-inspect-anchor={anchor ?? ''}
        >
          <Clock className='h-3.5 w-3.5' aria-hidden='true' />
          <span className='tabular-nums'>{anchor != null ? fmtClock(anchor) : 'Now'}</span>
          <span className='text-[var(--tm-muted)]'>{windowText(s.windowSec)}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align='end' className={cn(POP, 'w-[290px]')} data-tm-inspect-anchor-panel=''>
        <p className='text-[12.5px] font-medium' data-tm-inspect-anchor-text=''>
          {anchor != null
            ? `Anchored at ${fmtClock(anchor)} · ${windowText(s.windowSec)}`
            : `Anchored at now · ${windowText(s.windowSec)}`}
        </p>
        <p className='mt-0.5 text-[11.5px] text-[var(--tm-muted)]'>
          Panels look this far either side of the anchor for related requests, writes and changes.
        </p>
        <div className='mt-2.5 flex items-center justify-between gap-2 text-[12px]'>
          <span className='text-[var(--tm-fg-2)]'>Window</span>
          <SimpleSelect
            value={String(s.windowSec)}
            onChange={(v) => setWindow(Number(v))}
            options={options}
            ariaLabel='Window around the anchor'
            className='h-7 w-[120px] text-[12px]'
            contentClassName='traffic-map'
            triggerProps={{ 'data-tm-inspect-window': '' }}
          />
        </div>
        <div className='mt-3 flex flex-wrap gap-1.5'>
          {levelAt != null && levelAt !== anchor && (
            <button
              type='button'
              className={BTN}
              onClick={() => setAnchor(levelAt)}
              data-tm-inspect-anchor-here=''
              data-tip={`Anchor at this level's time, ${fmtClock(levelAt)}`}
            >
              Anchor at {fmtClock(levelAt)}
            </button>
          )}
          {anchor != null && (
            <button
              type='button'
              className={BTN}
              onClick={() => setAnchor(null)}
              data-tm-inspect-anchor-now=''
            >
              Anchor at now
            </button>
          )}
          <button
            type='button'
            className={BTN}
            disabled={!rewindable}
            onClick={rewind}
            data-tm-inspect-rewind=''
            data-tip={
              target == null
                ? 'This level has no time to rewind to'
                : rewindable
                  ? `Pause the map and show ${fmtClock(target)}`
                  : 'The map holds only the last 15 minutes; this moment is older'
            }
          >
            Rewind map to here
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

const KEYS: Array<[string, string]> = [
  ['Esc', 'Back one level (closes at the first)'],
  ['[  ]', 'Back / forward'],
  ['p', 'Pin this level and split'],
  ['j  k', 'Move down / up in Live events'],
  ['Enter', 'Open the selected event'],
  ['/  ⌘K', 'Search (while the map has focus)']
]

export function KeysAction() {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type='button'
          className={cn(HEAD_BTN, 'w-7 justify-center px-0')}
          aria-label='Keyboard keys'
          data-tip='Keyboard keys'
          data-tm-inspect-keys=''
        >
          <span aria-hidden='true' className='text-[13px] font-semibold leading-none'>
            ?
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align='end' className={cn(POP, 'w-[300px]')} data-tm-inspect-keys-panel=''>
        <p className='mb-1.5 text-[12.5px] font-medium'>Keys</p>
        <dl className='grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]'>
          {KEYS.map(([k, what]) => (
            <div key={k} className='contents'>
              <dt>
                <kbd className='rounded border border-[var(--tm-line)] bg-[var(--tm-card-2)] px-1 font-mono text-[11px]'>
                  {k}
                </kbd>
              </dt>
              <dd className='text-[var(--tm-fg-2)]'>{what}</dd>
            </div>
          ))}
        </dl>
        <p className='mt-2 text-[11.5px] text-[var(--tm-muted)]'>
          Panel keys work while focus is in the panel. Outside the map, / and ⌘K open the admin
          command palette as usual.
        </p>
      </PopoverContent>
    </Popover>
  )
}
