import { useEffect, useMemo, useRef, useState } from 'react'
import { type ExprValue, evaluateExpression, validateExpression } from '../lib/expression'
import { cn } from '../lib/utils'

export interface FormulaField {
  /** Token path, e.g. `amount` or `line.total`. */
  field: string
  label?: string
  /** Shown in the picker so an author can tell a currency from a count. */
  type?: string
}

export interface FormulaEditorProps {
  value: string
  onChange: (value: string) => void
  /** Fields offered by autocomplete and checked against for typos. */
  fields: FormulaField[]
  /**
   * A record to evaluate against, so the author sees the answer rather than
   * guessing. Omitted = no preview, which is honest rather than showing a
   * result computed from nothing.
   */
  sample?: Record<string, unknown> | null
  /** Labels the preview, e.g. the id of the record it was computed from. */
  sampleLabel?: string
  placeholder?: string
  rows?: number
  /**
   * Set for formulas the SERVER evaluates (stored rollups, write-computed
   * fields). The preview is then explicitly labelled as an approximation,
   * because the server resolves relations this editor cannot see.
   */
  serverEvaluated?: boolean
  className?: string
}

function formatPreview(v: ExprValue): string {
  if (v === null) return 'no value'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') {
    return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e6) / 1e6)
  }
  return `"${v}"`
}

/**
 * Authoring surface for `{{token}}` formulas.
 *
 * The point is that a formula can be wrong in three distinct ways, and until
 * now none of them said anything: a syntax error rendered as a blank cell, a
 * renamed field silently became zero, and the author could not see what the
 * expression actually produced without saving and going to look. Each gets its
 * own signal here — a parse error with a caret position, an unknown-field
 * warning, and a live result computed against a real record.
 */
export function FormulaEditor({
  value,
  onChange,
  fields,
  sample,
  sampleLabel,
  placeholder,
  rows = 3,
  serverEvaluated,
  className
}: FormulaEditorProps) {
  const taRef = useRef<HTMLTextAreaElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [search, setSearch] = useState('')

  const knownFields = useMemo(() => fields.map((f) => f.field), [fields])
  const validation = useMemo(
    () => (value.trim() ? validateExpression(value, knownFields) : null),
    [value, knownFields]
  )

  const preview = useMemo(() => {
    if (!sample || !validation?.ok) return null
    try {
      return evaluateExpression(value, sample)
    } catch {
      return null
    }
  }, [value, sample, validation])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    const list = q
      ? fields.filter(
          (f) => f.field.toLowerCase().includes(q) || (f.label ?? '').toLowerCase().includes(q)
        )
      : fields
    return list.slice(0, 60)
  }, [fields, search])

  // Close the picker on outside click — it is a plain inline panel rather than
  // a portal because it lives inside settings popovers that already manage
  // their own layering.
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!pickerOpen) return
    function onDown(e: MouseEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setPickerOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    searchRef.current?.focus()
    return () => document.removeEventListener('mousedown', onDown)
  }, [pickerOpen])

  function insert(token: string) {
    const ta = taRef.current
    const snippet = `{{${token}}}`
    if (!ta) {
      onChange(value + snippet)
    } else {
      const start = ta.selectionStart ?? value.length
      const end = ta.selectionEnd ?? value.length
      onChange(value.slice(0, start) + snippet + value.slice(end))
      // Restore the caret after the inserted token rather than dumping it at
      // the end, so an author can keep typing mid-expression.
      requestAnimationFrame(() => {
        ta.focus()
        const at = start + snippet.length
        ta.setSelectionRange(at, at)
      })
    }
    setSearch('')
    setPickerOpen(false)
  }

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <textarea
        ref={taRef}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        rows={rows}
        spellCheck={false}
        placeholder={placeholder ?? '{{amount}} - {{allocated_total}}'}
        className={cn(
          'w-full rounded border bg-background px-2 py-1.5 font-mono text-[12px] outline-none',
          validation && !validation.ok
            ? 'border-red-400 dark:border-red-500/60'
            : 'border-slate-200 dark:border-border'
        )}
      />

      <div className='mt-1 flex flex-wrap items-center gap-2'>
        <button
          type='button'
          onClick={() => setPickerOpen((v) => !v)}
          className='rounded border border-slate-200 px-1.5 py-0.5 text-[11px] hover:bg-muted dark:border-border'
        >
          ＋ Insert field
        </button>

        {validation && !validation.ok && (
          <span className='text-[11px] text-red-600 dark:text-red-400'>
            {validation.error}
            {validation.position !== undefined ? ` (at character ${validation.position + 1})` : ''}
          </span>
        )}

        {validation?.ok && validation.unknownTokens.length > 0 && (
          <span className='text-[11px] text-amber-600 dark:text-amber-400'>
            Unknown field{validation.unknownTokens.length > 1 ? 's' : ''}:{' '}
            <span className='font-mono'>{validation.unknownTokens.join(', ')}</span> — these read as
            0
          </span>
        )}

        {validation?.ok && sample && (
          <span className='text-[11px] text-muted-foreground'>
            ={' '}
            <span className='font-mono font-medium text-foreground'>{formatPreview(preview)}</span>
            {sampleLabel ? ` for ${sampleLabel}` : ''}
            {serverEvaluated ? ' (approximate — the server computes the stored value)' : ''}
          </span>
        )}
      </div>

      {pickerOpen && (
        <div className='absolute z-50 mt-1 w-full max-w-[420px] rounded-md border border-slate-200 bg-background shadow-lg dark:border-border'>
          <input
            // Focused via a ref rather than the autoFocus attribute: the panel
            // only opens on an explicit click, so moving focus into its search
            // box is expected — but autoFocus is a page-load concept and the
            // linter is right to refuse it.
            ref={searchRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder='Search fields…'
            className='w-full border-b border-slate-200 bg-transparent px-2 py-1.5 text-[12px] outline-none dark:border-border'
          />
          <div className='max-h-56 overflow-y-auto py-1'>
            {filtered.length === 0 ? (
              <p className='px-2 py-2 text-[11px] text-muted-foreground'>No matching fields</p>
            ) : (
              filtered.map((f) => (
                <button
                  key={f.field}
                  type='button'
                  onClick={() => insert(f.field)}
                  className='flex w-full items-center gap-2 px-2 py-1 text-left hover:bg-muted'
                >
                  <span className='min-w-0 flex-1 truncate font-mono text-[11.5px]'>{f.field}</span>
                  {f.label && f.label !== f.field && (
                    <span className='shrink-0 truncate text-[10.5px] text-muted-foreground'>
                      {f.label}
                    </span>
                  )}
                  {f.type && (
                    <span className='shrink-0 text-[10px] text-muted-foreground'>{f.type}</span>
                  )}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
