import type { ReactNode } from 'react'
import type { LayoutPatch } from '../../../lib/layout-ops'
import { cn } from '../../../lib/utils'
import { inputCls, Setting } from './controls'
import { changeLabel, column, type SectionProps } from './section-props'

/**
 * A text layout column as one setting row. Every keystroke shows in the draft;
 * the save waits for a pause (or blur, which flushes). Empty saves null.
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
  const value = raw == null ? '' : String(raw)
  const id = `setting-${col}`
  return (
    <Setting k={k} htmlFor={id} note={note}>
      <div className='flex items-center gap-1.5'>
        <input
          id={id}
          value={value}
          disabled={disabled}
          placeholder={placeholder}
          onChange={(e) => {
            const next = sanitize ? sanitize(e.target.value) : e.target.value
            props.setText({ [col]: next === '' ? null : next } as LayoutPatch, changeLabel(k))
          }}
          onBlur={() => props.flush()}
          className={cn(inputCls, mono && 'font-mono text-[12px]')}
        />
        {extra}
      </div>
    </Setting>
  )
}
