import { X } from 'lucide-react'
import { memo, useId, useRef, useState } from 'react'
import { Button } from '../../ui/button'
import { Input } from '../../ui/input'
import { captionLookOf, EDIT_LIMITS, removeItem, setCaptionLook } from '../edits'
import type { CaptionStyle, VideoEdits } from '../types'
import { typeAlongCaptionChecked } from './tools'

const stamp = (ms: number) => {
  const s = Math.max(0, ms) / 1000
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`
}

const segment =
  'h-7 min-w-[36px] border-l border-input px-2 text-[12px] transition-colors duration-150 first:border-l-0 focus-visible:relative focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan motion-reduce:transition-none'
const on = 'bg-nvr-cyan/15 font-semibold text-foreground'
const off = 'bg-background text-foreground hover:bg-muted'
const LOOK: Array<{
  key: keyof CaptionStyle
  label: string
  choices: Array<{ value: string; label: string }>
}> = [
  {
    key: 'size',
    label: 'Size',
    choices: [
      { value: 's', label: 'S' },
      { value: 'm', label: 'M' },
      { value: 'l', label: 'L' },
      { value: 'xl', label: 'XL' }
    ]
  },
  {
    key: 'background',
    label: 'Background',
    choices: [
      { value: 'none', label: 'None' },
      { value: 'shaded', label: 'Shaded' },
      { value: 'solid', label: 'Solid' }
    ]
  },
  {
    key: 'position',
    label: 'Position',
    choices: [
      { value: 'bottom', label: 'Bottom' },
      { value: 'top', label: 'Top' }
    ]
  }
]

/** How this video's captions look to viewers who have not chosen their own
 *  (#1551). Viewers can still change it for themselves in the player. */
function CaptionLook({
  edits,
  onChange
}: {
  edits: VideoEdits
  onChange: (e: VideoEdits) => void
}) {
  const look = captionLookOf(edits)
  return (
    <div className='space-y-1.5 border-t border-border pt-2' data-hv-caption-look-panel>
      <p className='text-[12px] font-medium text-foreground'>Caption look</p>
      {LOOK.map((row) => (
        <div key={row.key} className='flex items-center justify-between gap-2'>
          <span className='text-[12px] text-muted-foreground'>{row.label}</span>
          <fieldset
            className='inline-flex overflow-hidden rounded-md border border-input'
            aria-label={`Caption ${row.label.toLowerCase()}`}
          >
            {row.choices.map((c) => (
              <button
                key={c.value}
                type='button'
                aria-pressed={look[row.key] === c.value}
                onClick={() => onChange(setCaptionLook(edits, { [row.key]: c.value }))}
                className={`${segment} ${look[row.key] === c.value ? on : off}`}
                data-hv-caption-look={`${row.key}:${c.value}`}
              >
                {c.label}
              </button>
            ))}
          </fieldset>
        </div>
      ))}
      <p className='text-[12px] leading-snug text-muted-foreground'>
        Viewers who set their own caption look in the player keep theirs.
      </p>
    </div>
  )
}

/**
 * Type-along captioning: play the video, type what is said, press Enter.
 * The caption starts where the playhead is and closes the one before it
 * there. The playhead is read when Enter is pressed (`getSrcMs`), so the
 * panel does not redraw on every frame of playback.
 */
export const CaptionsPanel = memo(function CaptionsPanel({
  headless,
  edits,
  sourceMs,
  selectedId,
  getSrcMs,
  onChange,
  onRefused,
  onSeek,
  onSelect
}: {
  /** The side panel shows the title itself (the heading stays for screen readers). */
  headless?: boolean
  edits: VideoEdits
  sourceMs: number
  selectedId: string | null
  getSrcMs: () => number
  onChange: (e: VideoEdits) => void
  /** Why a caption couldn't start here (the editor's note). */
  onRefused: (reason: string) => void
  onSeek: (srcMs: number) => void
  onSelect: (id: string) => void
}) {
  const headingId = useId()
  const hintId = useId()
  const input = useRef<HTMLInputElement | null>(null)
  const [text, setText] = useState('')
  const commit = () => {
    const t = text.trim()
    if (!t) return
    const r = typeAlongCaptionChecked(edits, getSrcMs(), t, sourceMs)
    if (r.refused) {
      onRefused(r.refused)
      return
    }
    onChange(r.edits)
    setText('')
  }
  return (
    <section className='space-y-2' aria-labelledby={headingId} data-hv-captions>
      <h3
        id={headingId}
        className={headless ? 'sr-only' : 'text-[13px] font-semibold text-foreground'}
      >
        Captions
      </h3>
      <div className='flex gap-1.5'>
        <Input
          ref={input}
          value={text}
          maxLength={EDIT_LIMITS.text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              commit()
            }
          }}
          placeholder='Type what is said, then Enter'
          aria-label='Caption text'
          aria-describedby={hintId}
          className='h-8 min-w-0 flex-1 text-[13px]'
          data-hv-caption-input
        />
        <Button
          size='sm'
          variant='outline'
          className='h-8 text-[12.5px]'
          onClick={commit}
          disabled={!text.trim()}
          data-hv-caption-add
        >
          Add
        </Button>
      </div>
      <p id={hintId} className='text-[12px] leading-snug text-muted-foreground'>
        Keep the video playing while you type. Each caption starts where the playhead is when you
        press Enter.
      </p>
      {edits.captions.length === 0 ? (
        <p className='text-[12px] text-muted-foreground'>No captions yet.</p>
      ) : (
        <ul className='-mx-1.5 max-h-56 space-y-px overflow-y-auto overscroll-contain'>
          {edits.captions.map((c) => {
            const current = c.id === selectedId
            return (
              <li key={c.id} className='group flex items-center gap-0.5'>
                <button
                  type='button'
                  aria-current={current || undefined}
                  className={`flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-[13px] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan motion-reduce:transition-none ${current ? 'bg-nvr-cyan/15 font-medium text-foreground' : 'text-foreground hover:bg-muted'}`}
                  onClick={() => {
                    onSeek(c.start_ms)
                    onSelect(c.id)
                  }}
                  data-hv-caption-row={c.id}
                >
                  <span className='w-12 shrink-0 font-mono text-[12px] text-muted-foreground'>
                    {stamp(c.start_ms)}
                  </span>
                  <span className='min-w-0 truncate'>{c.text}</span>
                </button>
                <button
                  type='button'
                  aria-label={`Remove the caption “${c.text}”`}
                  className='inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-[opacity,background-color] duration-150 hover:bg-muted hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan group-hover:opacity-100 group-focus-within:opacity-100 motion-reduce:transition-none [@media(hover:none)]:opacity-100'
                  onClick={(e) => {
                    // Focus moves to the next caption's remove, else the box.
                    const li = e.currentTarget.closest('li')
                    const next = (
                      li?.nextElementSibling ?? li?.previousElementSibling
                    )?.querySelector<HTMLElement>('[data-hv-caption-remove]')
                    onChange(removeItem(edits, 'captions', c.id))
                    ;(next ?? input.current)?.focus()
                  }}
                  data-hv-caption-remove
                >
                  <X className='h-3.5 w-3.5' aria-hidden />
                </button>
              </li>
            )
          })}
        </ul>
      )}
      <CaptionLook edits={edits} onChange={onChange} />
    </section>
  )
})
