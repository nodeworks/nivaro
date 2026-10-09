import { Crosshair, Trash2 } from 'lucide-react'
import { memo, type ReactNode, useId, useRef } from 'react'
import { Button } from '../../ui/button'
import { Input } from '../../ui/input'
import { Textarea } from '../../ui/textarea'
import { ANNOTATION_PALETTE } from '../annotationStyles'
import {
  ALLOWED_SPEEDS,
  EDIT_LIMITS,
  type ListKey,
  musicShare,
  removeItem,
  removeSegment,
  setPieceMusic,
  setSpeed,
  setStepStyle,
  stepNumbers,
  stepStyleOf,
  trimSegment,
  upsertItemChecked,
  zoomInView
} from '../edits'
import type {
  Annotation,
  Blur,
  Caption,
  Chapter,
  RecordedClick,
  StepStyle,
  Tone,
  VideoEdits,
  Zoom
} from '../types'
import { seconds, TimeField } from './TimeField'
import type { Selection } from './Timeline'
import { clickForRipple, clickTargetText, shortForText, withTypedText } from './tools'

const TONES: Array<{ value: Tone; label: string }> = [
  { value: 'accent', label: 'Blue' },
  { value: 'warning', label: 'Red' },
  { value: 'neutral', label: 'Dark' }
]
const KIND: Record<Annotation['type'], string> = {
  callout: 'Callout',
  step: 'Step',
  arrow: 'Arrow',
  box: 'Box',
  spotlight: 'Spotlight',
  ripple: 'Click ripple'
}
const STEP_SHAPE_CHOICES: Array<{ value: StepStyle['shape']; label: string }> = [
  { value: 'circle', label: 'Circle' },
  { value: 'square', label: 'Square' }
]
const STEP_SIZE_CHOICES: Array<{ value: StepStyle['size']; label: string }> = [
  { value: 'small', label: 'Small' },
  { value: 'medium', label: 'Medium' },
  { value: 'large', label: 'Large' }
]
const MIN = EDIT_LIMITS.minItemMs
/** A piece's music share, as a share of the video's music volume. */
const PIECE_MUSIC = [
  { value: 0, label: 'Off' },
  { value: 0.25, label: 'Low' },
  { value: 0.5, label: 'Half' },
  { value: 1, label: 'Full' }
]
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

const label = 'text-[12px] font-medium text-foreground'
const hint = 'text-[12px] leading-snug text-muted-foreground'
const segment =
  'h-8 min-w-[40px] border-l border-input px-2 text-[12.5px] tabular-nums transition-colors duration-150 first:border-l-0 focus-visible:relative focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan motion-reduce:transition-none'
const on = 'bg-nvr-cyan/15 font-semibold text-foreground'
const off = 'bg-background text-foreground hover:bg-muted'

type Timed = { id: string; start_ms: number; end_ms: number }

/**
 * Changes the selected thing: a kept piece (speed, trim, cut), a chapter
 * (title, place), or a callout, arrow, box, ripple, zoom, blur or caption
 * (text, colour, zoom easing, blur strength, timing). Times can be typed or
 * stepped from the keyboard. Every change goes through upsertItemChecked;
 * a refusal goes to `onError` (the editor's note).
 */
export const Inspector = memo(function Inspector({
  edits,
  selection,
  sourceMs,
  onChange,
  onSelect,
  onSeek,
  onError,
  clicks
}: {
  edits: VideoEdits
  selection: Selection
  sourceMs: number
  /** The recorder's clicks: a ripple says what its click hit. */
  clicks?: RecordedClick[] | null
  onChange: (e: VideoEdits, key?: string) => void
  onSelect: (s: Selection) => void
  onSeek: (srcMs: number) => void
  onError: (msg: string) => void
}) {
  const headingId = useId()
  const root = useRef<HTMLElement | null>(null)
  const frame = (title: string, kind: string, body: ReactNode) => (
    <section
      ref={root}
      tabIndex={-1}
      aria-labelledby={headingId}
      className='space-y-3 outline-none'
      data-hv-inspector={kind}
    >
      <h3 id={headingId} className='text-[13px] font-semibold text-foreground'>
        {title}
      </h3>
      {body}
    </section>
  )

  if (!selection)
    return (
      <section
        ref={root}
        tabIndex={-1}
        aria-labelledby={headingId}
        className='outline-none'
        data-hv-inspector='none'
      >
        <h3 id={headingId} className='sr-only'>
          Nothing selected
        </h3>
        <p className={hint}>
          Select something on the timeline or the picture to change it, or pick a Draw tool to add
          one.
        </p>
      </section>
    )

  // Focus stays in the panel when what it showed goes away.
  const removed = (next: VideoEdits) => {
    onChange(next)
    onSelect(null)
    root.current?.focus({ preventScroll: true })
  }
  const jump = (ms: number) => (
    <Button
      size='sm'
      variant='outline'
      className='h-8 text-[12.5px]'
      onClick={() => onSeek(ms)}
      data-hv-jump
    >
      <Crosshair className='!size-3.5' aria-hidden /> Jump to it
    </Button>
  )

  if (selection.lane === 'cuts') {
    const i = selection.index
    const s = edits.segments[i]
    if (!s) return frame('Nothing selected', 'none', null)
    const trim = (patch: { start_ms?: number; end_ms?: number }) => {
      const next = trimSegment(edits, i, patch, sourceMs)
      const t = next.segments[i]
      // Stopped by a neighbour or the recording's edge: nothing to write.
      if (t.start_ms !== s.start_ms || t.end_ms !== s.end_ms) onChange(next, `trim:${i}`)
    }
    return frame(
      `Piece ${i + 1} of ${edits.segments.length}`,
      'piece',
      <>
        <p className={hint}>A part of the recording that viewers see.</p>
        <div className='grid grid-cols-2 gap-2'>
          <TimeField
            label='Starts'
            ms={s.start_ms}
            onCommit={(v) => trim({ start_ms: v })}
            onInvalid={onError}
            earlier='Start 0.1 seconds earlier'
            later='Start 0.1 seconds later'
            data='start'
          />
          <TimeField
            label='Ends'
            ms={s.end_ms}
            onCommit={(v) => trim({ end_ms: v })}
            onInvalid={onError}
            earlier='End 0.1 seconds earlier'
            later='End 0.1 seconds later'
            data='end'
          />
        </div>
        <div className='space-y-1'>
          <p className={label} id={`${headingId}-speed`}>
            Speed
          </p>
          <fieldset
            className='inline-flex overflow-hidden rounded-md border border-input'
            aria-labelledby={`${headingId}-speed`}
          >
            {ALLOWED_SPEEDS.map((sp) => (
              <button
                key={sp}
                type='button'
                aria-pressed={s.speed === sp}
                onClick={() => onChange(setSpeed(edits, i, sp))}
                className={`${segment} ${s.speed === sp ? on : off}`}
              >
                {sp}×
              </button>
            ))}
          </fieldset>
        </div>
        {edits.music && (
          <div className='space-y-1'>
            <p className={label} id={`${headingId}-music`}>
              Music under this piece
            </p>
            <fieldset
              className='inline-flex overflow-hidden rounded-md border border-input'
              aria-labelledby={`${headingId}-music`}
            >
              {PIECE_MUSIC.map((m) => {
                const cur = musicShare(s.music)
                return (
                  <button
                    key={m.value}
                    type='button'
                    aria-pressed={cur === m.value}
                    onClick={() => onChange(setPieceMusic(edits, i, m.value))}
                    className={`${segment} ${cur === m.value ? on : off}`}
                    data-hv-piece-music={m.value}
                  >
                    {m.label}
                  </button>
                )
              })}
            </fieldset>
          </div>
        )}
        <div className='flex flex-wrap gap-2'>
          {jump(s.start_ms)}
          <Button
            size='sm'
            variant='outline'
            className='h-8 text-[12.5px]'
            onClick={() => {
              const r = removeSegment(edits, i)
              if (r.refused) onError(r.refused)
              else removed(r.edits)
            }}
            data-hv-cut-it
          >
            Cut this piece
          </Button>
        </div>
      </>
    )
  }

  const lane = selection.lane
  const item = (edits[lane] as Array<{ id: string }>).find((x) => x.id === selection.id)
  if (!item) return frame('Nothing selected', 'none', null)
  /** Write a changed copy of the item; a refusal goes to the note. */
  const update = (patch: Record<string, unknown>, key?: string) => {
    // A step stopped at 0 or at the end (or the colour it already has)
    // changes nothing: no undo step, no save.
    const now = item as unknown as Record<string, unknown>
    if (Object.entries(patch).every(([k, v]) => now[k] === v)) return
    const r = upsertItemChecked(edits, lane as ListKey, { ...item, ...patch } as never)
    if (r.refused) onError(r.refused)
    else if (r.edits !== edits) onChange(r.edits, key)
  }
  const remove = (
    <Button
      size='sm'
      variant='ghost'
      className='h-8 text-[12.5px] text-rose-700 hover:bg-rose-50 hover:text-rose-800 dark:text-rose-300 dark:hover:bg-rose-500/10 dark:hover:text-rose-200'
      onClick={() => removed(removeItem(edits, lane, item.id))}
      data-hv-remove
    >
      <Trash2 className='!size-3.5' aria-hidden /> Remove
    </Button>
  )

  if (lane === 'chapters') {
    const c = item as Chapter
    return frame(
      'Chapter',
      'chapters',
      <>
        <div className='flex flex-col gap-1'>
          <label htmlFor={`${headingId}-title`} className={label}>
            Title
          </label>
          <Input
            id={`${headingId}-title`}
            value={c.title}
            maxLength={EDIT_LIMITS.chapterTitle}
            onChange={(e) => update({ title: e.target.value }, `title:${c.id}`)}
            onKeyDown={(e) => {
              // Enter finishes the title; the editor's keys (M, S) work again.
              if (e.key === 'Enter') {
                e.preventDefault()
                root.current?.focus({ preventScroll: true })
              }
            }}
            className='h-8 text-[13px]'
            data-hv-chapter-title
          />
        </div>
        <TimeField
          label='Starts'
          ms={c.at_ms}
          onCommit={(v) => update({ at_ms: clamp(v, 0, sourceMs) }, `time:${c.id}`)}
          onInvalid={onError}
          earlier='Move the chapter 0.1 seconds earlier'
          later='Move the chapter 0.1 seconds later'
          data='at'
        />
        <div className='flex flex-wrap gap-2'>
          {jump(c.at_ms)}
          {remove}
        </div>
      </>
    )
  }

  const t = item as Timed
  const setStart = (v: number) => {
    const s = clamp(v, 0, sourceMs)
    if (t.end_ms - s < MIN) onError('It has to start at least 0.2 seconds before it ends')
    else update({ start_ms: s }, `time:${t.id}`)
  }
  const setEnd = (v: number) => {
    const en = clamp(v, 0, sourceMs)
    if (en - t.start_ms < MIN) onError('It has to end at least 0.2 seconds after it starts')
    else update({ end_ms: en }, `time:${t.id}`)
  }
  const shift = (d: number) => {
    const len = t.end_ms - t.start_ms
    const s = clamp(t.start_ms + d, 0, Math.max(0, sourceMs - len))
    if (s !== t.start_ms) update({ start_ms: s, end_ms: s + len }, `time:${t.id}`)
  }
  const timing = (
    <div className='space-y-2' data-hv-timing>
      <div className='grid grid-cols-2 gap-2'>
        <TimeField
          label='Starts'
          ms={t.start_ms}
          onCommit={setStart}
          onInvalid={onError}
          earlier='Start 0.1 seconds earlier'
          later='Start 0.1 seconds later'
          data='start'
        />
        <TimeField
          label='Ends'
          ms={t.end_ms}
          onCommit={setEnd}
          onInvalid={onError}
          earlier='End 0.1 seconds earlier'
          later='End 0.1 seconds later'
          data='end'
        />
      </div>
      <div className='flex items-center gap-2'>
        <span className={hint} id={`${headingId}-move`}>
          Move it
        </span>
        <fieldset
          className='inline-flex overflow-hidden rounded-md border border-input'
          aria-labelledby={`${headingId}-move`}
        >
          <button
            type='button'
            className={`${segment} ${off}`}
            onClick={(e) => shift(e.shiftKey ? -1000 : -100)}
            aria-label='Move it 0.1 seconds earlier'
            title='Shift: a whole second'
            data-hv-move='earlier'
          >
            − 0.1 s
          </button>
          <button
            type='button'
            className={`${segment} ${off}`}
            onClick={(e) => shift(e.shiftKey ? 1000 : 100)}
            aria-label='Move it 0.1 seconds later'
            title='Shift: a whole second'
            data-hv-move='later'
          >
            + 0.1 s
          </button>
        </fieldset>
      </div>
    </div>
  )
  const actions = (
    <div className='flex flex-wrap gap-2 border-t border-border pt-3'>
      {jump(t.start_ms)}
      {remove}
    </div>
  )

  /** "Short for its text" with a one-click fix, when it is. */
  const readTime = (x: { id: string; start_ms: number; end_ms: number; text: string }) => {
    const need = shortForText(x)
    if (need === null) return null
    const fits = Math.min(sourceMs, x.start_ms + need)
    return (
      <p
        className='text-[12px] leading-snug text-amber-800 dark:text-amber-300'
        data-hv-short-for-text
      >
        Short for its text: about {seconds(need)} s reads comfortably.{' '}
        {fits - x.start_ms > x.end_ms - x.start_ms && (
          <button
            type='button'
            className='font-medium text-foreground underline underline-offset-2 hover:no-underline'
            onClick={() => update({ end_ms: fits }, `time:${x.id}`)}
            data-hv-lengthen
          >
            Make it {seconds(fits - x.start_ms)} s
          </button>
        )}
      </p>
    )
  }

  if (lane === 'annotations') {
    const a = item as Annotation
    const stepNo = a.type === 'step' ? (stepNumbers(edits).get(a.id) ?? null) : null
    const style = stepStyleOf(edits)
    return frame(
      a.type === 'step' && stepNo !== null ? `Step ${stepNo}` : KIND[a.type],
      'annotations',
      <>
        {a.type === 'ripple' && (
          <p className={hint} data-hv-ripple-click>
            {(() => {
              const hit = clickForRipple(a, clicks)
              const what = clickTargetText(hit)
              return what ? (
                <>
                  Recorded click on <span className='font-medium text-foreground'>{what}</span>.
                </>
              ) : hit ? (
                'A recorded click; what it hit was not recorded.'
              ) : (
                'Placed by hand, not from a recorded click.'
              )
            })()}
          </p>
        )}
        {a.type === 'spotlight' && (
          <p className={hint}>Dims everything outside the outlined area while it shows.</p>
        )}
        {a.type === 'step' && (
          <p className={hint}>
            {stepNo === null
              ? 'Inside a cut, so viewers never see it and it has no number.'
              : 'Steps number themselves in the order they appear.'}
          </p>
        )}
        {(a.type === 'callout' || a.type === 'box' || a.type === 'step') && (
          <div className='flex flex-col gap-1'>
            <label htmlFor={`${headingId}-text`} className={label}>
              Text{a.type === 'step' ? ' (optional)' : ''}
            </label>
            <Textarea
              id={`${headingId}-text`}
              value={a.text}
              maxLength={EDIT_LIMITS.text}
              rows={2}
              onChange={(e) => {
                // A new callout or step follows its text's length until the
                // length is set by hand (tools.ts withTypedText).
                const next =
                  a.type === 'box'
                    ? { text: e.target.value }
                    : withTypedText(a, e.target.value, sourceMs)
                update(
                  { text: next.text, end_ms: 'end_ms' in next ? next.end_ms : a.end_ms },
                  `text:${a.id}`
                )
              }}
              className='min-h-[56px] rounded-md px-2.5 py-1.5 text-[13px]'
              data-hv-annotation-text
            />
            {a.type !== 'box' && readTime(a)}
          </div>
        )}
        {a.type === 'step' && (
          <div className='space-y-2' data-hv-step-style>
            <p className={hint}>Badge style, for every step in this video.</p>
            <div className='flex flex-wrap gap-2'>
              <fieldset
                className='inline-flex overflow-hidden rounded-md border border-input'
                aria-label='Badge shape'
              >
                {STEP_SHAPE_CHOICES.map((c) => (
                  <button
                    key={c.value}
                    type='button'
                    aria-pressed={style.shape === c.value}
                    onClick={() => onChange(setStepStyle(edits, { shape: c.value }))}
                    className={`${segment} ${style.shape === c.value ? on : off}`}
                    data-hv-step-shape={c.value}
                  >
                    {c.label}
                  </button>
                ))}
              </fieldset>
              <fieldset
                className='inline-flex overflow-hidden rounded-md border border-input'
                aria-label='Badge size'
              >
                {STEP_SIZE_CHOICES.map((c) => (
                  <button
                    key={c.value}
                    type='button'
                    aria-pressed={style.size === c.value}
                    onClick={() => onChange(setStepStyle(edits, { size: c.value }))}
                    className={`${segment} ${style.size === c.value ? on : off}`}
                    data-hv-step-size={c.value}
                  >
                    {c.label}
                  </button>
                ))}
              </fieldset>
            </div>
          </div>
        )}
        {a.type !== 'spotlight' && (
          <div className='space-y-1'>
            <p className={label} id={`${headingId}-tone`}>
              Colour
            </p>
            <fieldset
              className='inline-flex overflow-hidden rounded-md border border-input'
              aria-labelledby={`${headingId}-tone`}
            >
              {TONES.map((tone) => (
                <button
                  key={tone.value}
                  type='button'
                  aria-pressed={a.tone === tone.value}
                  onClick={() => update({ tone: tone.value })}
                  className={`${segment} inline-flex items-center gap-1.5 ${a.tone === tone.value ? on : off}`}
                  data-hv-tone={tone.value}
                >
                  <span
                    className='h-3 w-3 rounded-full ring-1 ring-black/10 dark:ring-white/25'
                    style={{ background: ANNOTATION_PALETTE[tone.value] }}
                    aria-hidden
                  />
                  {tone.label}
                </button>
              ))}
            </fieldset>
          </div>
        )}
        {timing}
        {actions}
      </>
    )
  }

  if (lane === 'zooms') {
    const z = item as Zoom
    return frame(
      'Zoom',
      'zooms',
      <>
        <p className={hint}>
          Shows the outlined area {zoomInView(edits, z.rect).mag.toFixed(1)} times larger. While it
          is selected the preview shows the whole picture, so you can place it.
        </p>
        <div className='flex flex-col gap-1'>
          <label htmlFor={`${headingId}-ease`} className={label}>
            Ease in and out{' '}
            <span className='font-normal text-muted-foreground tabular-nums'>
              {seconds(z.ease_ms)} s
            </span>
          </label>
          <input
            id={`${headingId}-ease`}
            type='range'
            min={0}
            max={2000}
            step={100}
            value={z.ease_ms}
            onChange={(e) => update({ ease_ms: Number(e.target.value) }, `ease:${z.id}`)}
            className='accent-nvr-cyan'
            data-hv-ease
          />
        </div>
        {timing}
        {actions}
      </>
    )
  }

  if (lane === 'blurs') {
    const b = item as Blur
    return frame(
      'Blur',
      'blurs',
      <>
        <div className='flex flex-col gap-1'>
          <label htmlFor={`${headingId}-strength`} className={label}>
            Strength{' '}
            <span className='font-normal text-muted-foreground tabular-nums'>{b.strength}</span>
          </label>
          <input
            id={`${headingId}-strength`}
            type='range'
            min={2}
            max={40}
            value={b.strength}
            onChange={(e) => update({ strength: Number(e.target.value) }, `str:${b.id}`)}
            className='accent-nvr-cyan'
            data-hv-strength
          />
        </div>
        <Button
          size='sm'
          variant='outline'
          className='h-8 text-[12.5px]'
          onClick={() => update({ start_ms: 0, end_ms: sourceMs })}
          disabled={b.start_ms === 0 && b.end_ms === sourceMs}
          data-hv-blur-whole
        >
          Blur it for the whole video
        </Button>
        {timing}
        {actions}
      </>
    )
  }

  const c = item as Caption
  return frame(
    'Caption',
    'captions',
    <>
      <div className='flex flex-col gap-1'>
        <label htmlFor={`${headingId}-caption`} className={label}>
          Text
        </label>
        <Textarea
          id={`${headingId}-caption`}
          value={c.text}
          maxLength={EDIT_LIMITS.text}
          rows={2}
          onChange={(e) => {
            // A caption typed along follows its text's length until it is set
            // by hand, and never runs into the next caption.
            const after = edits.captions
              .filter((x) => x.id !== c.id && x.start_ms > c.start_ms)
              .map((x) => x.start_ms)
            const next = withTypedText(c, e.target.value, Math.min(sourceMs, ...after))
            update({ text: next.text, end_ms: next.end_ms }, `cap:${c.id}`)
          }}
          className='min-h-[56px] rounded-md px-2.5 py-1.5 text-[13px]'
          data-hv-caption-text
        />
        {readTime(c)}
      </div>
      {timing}
      {actions}
    </>
  )
})
