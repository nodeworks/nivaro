import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { cn, titleCase } from '../../../lib/utils'
import { inputCls, PickList, quietText, Toggle } from '../settings/controls'

type ReadField = { field: string; label?: string | null }

export interface ReadPresentationPatch {
  sheet_width?: number | null
  header_fields?: string[] | null
  hide_empty?: boolean
}

export const SHEET_WIDTH_MIN = 320
export const SHEET_WIDTH_MAX = 2000
export const HEADER_FIELDS_MAX = 8

/** Sheet width in px. Out of range says so and saves nothing (it never nulls a typo). */
export function SheetWidthInput({
  value,
  onChange,
  id
}: {
  value: number | null | undefined
  onChange: (width: number | null) => void
  id?: string
}) {
  const [text, setText] = useState(value ? String(value) : '')
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setText(value ? String(value) : '')
    setError(null)
  }, [value])
  return (
    <div>
      <div className='flex items-center gap-1.5'>
        <input
          id={id}
          type='number'
          inputMode='numeric'
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => {
            const t = text.trim()
            if (t === '') {
              setError(null)
              if (value != null) onChange(null)
              return
            }
            const n = Number(t)
            if (!Number.isFinite(n) || n < SHEET_WIDTH_MIN || n > SHEET_WIDTH_MAX) {
              setError(
                `Use a width from ${SHEET_WIDTH_MIN} to ${SHEET_WIDTH_MAX} px, or leave it empty. Nothing was saved.`
              )
              return
            }
            setError(null)
            if (Math.round(n) !== value) onChange(Math.round(n))
          }}
          placeholder='640'
          aria-invalid={!!error}
          className={cn(inputCls, 'w-24', error && 'border-[#9c2f47] dark:border-[#f08aa1]')}
        />
        <span className={quietText}>px</span>
      </div>
      {error && <p className='mt-1 text-[12px] text-[#9c2f47] dark:text-[#f08aa1]'>{error}</p>}
    </div>
  )
}

/** Header band fields by label, in order; the first is the sheet's title. */
export function HeaderFieldsPicker({
  value,
  fields,
  onChange
}: {
  value: string[]
  fields: ReadField[]
  onChange: (keys: string[] | null) => void
}) {
  const labelOf = (f: string) => fields.find((x) => x.field === f)?.label || titleCase(f)
  const set = (keys: string[]) => onChange(keys.length ? keys : null)
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir
    if (j < 0 || j >= value.length) return
    const next = [...value]
    ;[next[i], next[j]] = [next[j], next[i]]
    set(next)
  }
  const options = fields
    .filter((f) => !value.includes(f.field) && !f.field.includes('.'))
    .map((f) => ({ value: f.field, label: labelOf(f.field), hint: f.field }))
    .sort((a, b) => a.label.localeCompare(b.label))
  const iconBtn =
    'flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-muted hover:text-slate-700 disabled:opacity-25 dark:hover:text-foreground'
  return (
    <div className='space-y-1.5' data-header-fields>
      {value.length === 0 ? (
        <p className={quietText}>None: the sheet shows the record's display name only.</p>
      ) : (
        <ol className='space-y-1'>
          {value.map((f, i) => (
            <li
              key={f}
              className='flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2 py-1 text-[12.5px] dark:border-border dark:bg-card'
            >
              <span className='min-w-0 flex-1 truncate text-slate-800 dark:text-foreground'>
                {labelOf(f)}
                {i === 0 && (
                  <span className='ml-1.5 rounded bg-slate-100 px-1 py-px text-[11px] text-slate-600 dark:bg-muted dark:text-muted-foreground'>
                    title
                  </span>
                )}
              </span>
              <button
                type='button'
                onClick={() => move(i, -1)}
                disabled={i === 0}
                className={iconBtn}
                aria-label={`Move ${labelOf(f)} up`}
              >
                <ArrowUp className='h-3.5 w-3.5' />
              </button>
              <button
                type='button'
                onClick={() => move(i, 1)}
                disabled={i === value.length - 1}
                className={iconBtn}
                aria-label={`Move ${labelOf(f)} down`}
              >
                <ArrowDown className='h-3.5 w-3.5' />
              </button>
              <button
                type='button'
                onClick={() => set(value.filter((x) => x !== f))}
                className={iconBtn}
                aria-label={`Remove ${labelOf(f)}`}
              >
                <X className='h-3.5 w-3.5' />
              </button>
            </li>
          ))}
        </ol>
      )}
      {value.length < HEADER_FIELDS_MAX ? (
        <span className='inline-flex items-center gap-1'>
          <Plus className='h-3.5 w-3.5 text-slate-400' />
          <PickList
            ariaLabel='Add header field'
            value={null}
            options={options}
            placeholder='Add a field…'
            onChange={(v) => v && set([...value, v])}
          />
        </span>
      ) : (
        <p className={quietText}>{HEADER_FIELDS_MAX} fields is the most the band shows.</p>
      )}
    </div>
  )
}

/**
 * Read view presentation for detail / summary layouts: sheet width, header band
 * fields and hide-empty. Form settings places the three pieces as separate
 * settings; this composite keeps the classic editor's single block.
 */
export function ReadPresentationEditor({
  layout,
  fields,
  onPatch
}: {
  layout: { sheet_width?: number | null; header_fields?: string[] | null; hide_empty?: boolean }
  fields: ReadField[]
  onPatch: (p: ReadPresentationPatch) => void
}) {
  return (
    <div className='space-y-2 border-t border-slate-100 pt-2 dark:border-border'>
      <p className='text-[12px] font-medium text-slate-600 dark:text-slate-300'>Read view</p>
      <div className='flex items-center justify-between gap-2'>
        <span className={quietText}>Sheet width</span>
        <SheetWidthInput value={layout.sheet_width} onChange={(w) => onPatch({ sheet_width: w })} />
      </div>
      <div>
        <span className={quietText}>Header band fields (first = title)</span>
        <div className='mt-1'>
          <HeaderFieldsPicker
            value={layout.header_fields ?? []}
            fields={fields}
            onChange={(keys) => onPatch({ header_fields: keys })}
          />
        </div>
      </div>
      <div className='flex items-center justify-between'>
        <span className={quietText}>Hide empty values</span>
        <Toggle
          label='Hide empty values'
          checked={!!layout.hide_empty}
          onChange={(v) => onPatch({ hide_empty: v })}
        />
      </div>
    </div>
  )
}
