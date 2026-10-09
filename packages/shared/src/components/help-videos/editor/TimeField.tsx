import { Minus, Plus } from 'lucide-react'
import { type KeyboardEvent, useId, useState } from 'react'

/** "12.5", "12,5" or "1:02.5" → milliseconds; null when it isn't a time. */
export function parseTime(text: string): number | null {
  const t = text.trim().replace(',', '.').replace(/\s*s$/, '')
  const m = /^(?:(\d+):)?(\d+(?:\.\d*)?|\.\d+)$/.exec(t)
  if (!m) return null
  const secs = Number(m[1] ?? 0) * 60 + Number(m[2])
  return Number.isFinite(secs) ? Math.round(secs * 1000) : null
}
export const seconds = (ms: number) => (ms / 1000).toFixed(1)

const stepButton =
  'inline-flex w-7 shrink-0 items-center justify-center text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground focus-visible:relative focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-nvr-cyan motion-reduce:transition-none'

/**
 * A time in seconds that the keyboard can set exactly: type it (Enter or
 * leaving the field applies it, Escape puts it back), ArrowUp/ArrowDown
 * step it by 0.1 s (Shift: 1 s), and − / + do the same for the pointer.
 * The parent decides what a time may be; a refused one simply shows the
 * stored value again.
 */
export function TimeField({
  label,
  ms,
  onCommit,
  onInvalid,
  earlier,
  later,
  data
}: {
  label: string
  ms: number
  onCommit: (ms: number) => void
  onInvalid: (message: string) => void
  /** Accessible names of the step buttons ("Start 0.1 seconds earlier"). */
  earlier: string
  later: string
  data?: string
}) {
  const id = useId()
  const [text, setText] = useState<string | null>(null)
  const commit = () => {
    if (text === null) return
    setText(null)
    const v = parseTime(text)
    if (v === null) onInvalid('Type a time in seconds, like 12.5')
    else if (v !== ms) onCommit(v)
  }
  const step = (dir: 1 | -1, big: boolean) => onCommit(ms + dir * (big ? 1000 : 100))
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      commit()
    } else if (e.key === 'Escape' && text !== null) {
      e.preventDefault()
      e.stopPropagation()
      setText(null)
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault()
      setText(null)
      step(e.key === 'ArrowUp' ? 1 : -1, e.shiftKey)
    }
  }
  return (
    <div className='flex min-w-0 flex-col gap-1'>
      <label htmlFor={id} className='text-[12px] font-medium text-foreground'>
        {label}
      </label>
      <div className='flex h-8 items-stretch overflow-hidden rounded-md border border-input bg-background transition-colors duration-150 focus-within:border-nvr-cyan motion-reduce:transition-none'>
        <button
          type='button'
          className={`${stepButton} border-r border-input`}
          aria-label={earlier}
          title={`${earlier} (Shift: a whole second)`}
          onClick={(e) => step(-1, e.shiftKey)}
        >
          <Minus className='h-3.5 w-3.5' aria-hidden />
        </button>
        <input
          id={id}
          value={text ?? seconds(ms)}
          inputMode='decimal'
          autoComplete='off'
          spellCheck={false}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={onKey}
          aria-describedby={`${id}-unit`}
          className='w-full min-w-0 bg-transparent px-1 text-right text-[13px] tabular-nums text-foreground outline-none'
          data-hv-time={data}
        />
        <span
          id={`${id}-unit`}
          className='flex items-center pr-1.5 pl-0.5 text-[12px] text-muted-foreground'
        >
          <span aria-hidden>s</span>
          <span className='sr-only'>seconds</span>
        </span>
        <button
          type='button'
          className={`${stepButton} border-l border-input`}
          aria-label={later}
          title={`${later} (Shift: a whole second)`}
          onClick={(e) => step(1, e.shiftKey)}
        >
          <Plus className='h-3.5 w-3.5' aria-hidden />
        </button>
      </div>
    </div>
  )
}
