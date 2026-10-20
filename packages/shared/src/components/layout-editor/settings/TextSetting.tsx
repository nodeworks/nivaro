import { type ReactNode, useRef, useState } from 'react'
import type { LayoutPatch } from '../../../lib/layout-ops'
import { cn } from '../../../lib/utils'
import { inputCls, Setting } from './controls'
import { changeLabel, column, type SectionProps } from './section-props'

/**
 * A text layout column as one setting row. What is typed stays in the input
 * (never rebuilt from the draft while it is being edited) and saves as one op on
 * blur or Enter; Escape puts the saved value back. The server trims and
 * slugifies some of these (link name, button labels), so saving on every pause
 * would eat a trailing space mid-word and rename ?layout= links half-typed.
 * Empty saves null.
 */
export function TextSetting({
  k,
  props,
  placeholder,
  sanitize,
  disabled,
  mono,
  extra,
  note
}: {
  k: string
  props: SectionProps
  placeholder?: string
  /** Rewrite what was typed before it is kept (e.g. link names). */
  sanitize?: (raw: string) => string
  disabled?: boolean
  mono?: boolean
  /** Rendered beside the input (a Generate button…). */
  extra?: ReactNode
  note?: ReactNode
}) {
  const col = column(k)
  const raw = props.layout[col]
  const saved = raw == null ? '' : String(raw)
  const id = `setting-${col}`
  // null = not editing: show the saved value. A ref too, so blur after Escape
  // reads the cleared buffer in the same tick.
  const [buffer, setBuffer] = useState<string | null>(null)
  const bufferRef = useRef<string | null>(null)
  const edit = (next: string | null) => {
    bufferRef.current = next
    setBuffer(next)
  }
  const commit = () => {
    const typed = bufferRef.current
    edit(null)
    if (typed !== null && typed !== saved)
      props.set({ [col]: typed === '' ? null : typed } as LayoutPatch, changeLabel(k))
    props.flush()
  }
  return (
    <Setting k={k} htmlFor={id} note={note}>
      <div className='flex items-center gap-1.5'>
        <input
          id={id}
          value={buffer ?? saved}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(e) => edit(sanitize ? sanitize(e.target.value) : e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            else if (e.key === 'Escape') {
              edit(null)
              e.currentTarget.blur()
            }
          }}
          className={cn(inputCls, mono && 'font-mono text-[12px]')}
        />
        {extra}
      </div>
    </Setting>
  )
}
