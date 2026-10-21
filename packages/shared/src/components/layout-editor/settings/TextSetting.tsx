import { type ReactNode, useRef, useState } from 'react'
import type { LayoutPatch } from '../../../lib/layout-ops'
import { cn } from '../../../lib/utils'
import { inputCls, Setting } from './controls'
import { changeLabel, column, type SectionProps } from './section-props'

/**
 * A text layout column as one setting row. What is typed stays in the input
 * (never rebuilt from the draft while it is being edited) and is sent after a
 * pause (the draft coalesces it, 600 ms) or on blur / Enter; Escape puts the
 * value from before the edit back. Empty saves null.
 *
 * `blurOnly` (link names): sent on blur or Enter only. The server slugifies
 * these, and every pause would rename ?layout= links half-typed.
 */
export function TextSetting({
  k,
  props,
  placeholder,
  sanitize,
  disabled,
  mono,
  extra,
  note,
  blurOnly = false
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
  blurOnly?: boolean
}) {
  const col = column(k)
  const raw = props.layout[col]
  const saved = raw == null ? '' : String(raw)
  const id = `setting-${col}`
  // null = not editing: show the saved value. Refs too, so blur after Escape
  // reads the cleared buffer in the same tick.
  const [buffer, setBuffer] = useState<string | null>(null)
  const bufferRef = useRef<string | null>(null)
  // The saved value when this edit began (the draft follows the typing).
  const startRef = useRef<string | null>(null)
  const edit = (next: string | null) => {
    bufferRef.current = next
    setBuffer(next)
  }
  const patchOf = (v: string) => ({ [col]: v === '' ? null : v }) as LayoutPatch
  const type = (v: string) => {
    if (startRef.current === null) startRef.current = saved
    edit(v)
    if (!blurOnly) props.setText(patchOf(v), changeLabel(k))
  }
  const commit = () => {
    const typed = bufferRef.current
    edit(null)
    startRef.current = null
    if (blurOnly && typed !== null && typed !== saved) props.set(patchOf(typed), changeLabel(k))
    props.flush()
  }
  const revert = () => {
    const start = startRef.current
    if (!blurOnly && start !== null && bufferRef.current !== start)
      props.setText(patchOf(start), changeLabel(k))
    edit(null)
  }
  return (
    <Setting k={k} htmlFor={id} note={note}>
      <div className='flex items-center gap-1.5'>
        <input
          id={id}
          value={buffer ?? saved}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(e) => type(sanitize ? sanitize(e.target.value) : e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
            else if (e.key === 'Escape') {
              revert()
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
