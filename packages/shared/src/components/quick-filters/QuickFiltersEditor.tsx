import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronRight,
  Copy,
  GripVertical,
  Plus,
  Trash2
} from 'lucide-react'
import { useRef, useState } from 'react'
import { cn } from '../../lib/utils'
import { moveFilter, type QuickFilterDef, quickFilterProblems, uniqueKey } from './config'
import { pathLabel } from './facets'
import { QuickFilterForm } from './QuickFilterForm'

const iconBtn =
  'flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-slate-100 hover:text-slate-700 disabled:pointer-events-none disabled:opacity-30 dark:hover:bg-slate-800 dark:hover:text-slate-200'

/**
 * The quick-filter list as Data model → Settings shows it: one row per filter,
 * each opening the SAME form the list's in-place editor uses. Controlled —
 * the host saves. Raw JSON stays one click away for a shape this UI does not
 * express yet.
 */
export function QuickFiltersEditor({
  collection,
  value,
  onChange
}: {
  collection: string
  value: QuickFilterDef[]
  onChange: (next: QuickFilterDef[]) => void
}) {
  const [openIdx, setOpenIdx] = useState<number | null>(null)
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const [showRaw, setShowRaw] = useState(false)
  const [rawDraft, setRawDraft] = useState('')
  const [rawError, setRawError] = useState('')
  // Keys stored when the editor opened: those filters' keys never follow a rename.
  const savedKeys = useRef(new Set(value.map((f) => f.key)))

  const update = (i: number, partial: Partial<QuickFilterDef>) =>
    onChange(
      value.map((f, idx) => {
        if (idx !== i) return f
        const next = { ...f, ...partial }
        for (const k of Object.keys(partial) as Array<keyof QuickFilterDef>)
          if (partial[k] === undefined) delete next[k]
        return next
      })
    )
  const move = (from: number, to: number) => {
    const next = moveFilter(value, from, to)
    if (next === value) return
    onChange(next)
    setOpenIdx(openIdx === from ? to : openIdx)
  }

  return (
    <div className='space-y-2'>
      {value.length === 0 && (
        <p className='rounded-md border border-dashed border-slate-200 px-3 py-4 text-center text-[12px] text-slate-500 dark:border-slate-700 dark:text-slate-400'>
          No quick filters. The list shows the search box and Add Filter only.
        </p>
      )}

      {value.map((f, i) => {
        const issues = quickFilterProblems(f, value)
        const open = openIdx === i
        const paths = f.or_paths?.length ? f.or_paths : [f.path ?? []]
        return (
          // biome-ignore lint/a11y/noStaticElementInteractions: drag is a pointer shortcut; the row's Move up / Move down buttons are the keyboard path
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: rows have no stable id; the key may be blank or duplicated while edited
            key={i}
            draggable
            onDragStart={() => setDragIdx(i)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => {
              if (dragIdx !== null) move(dragIdx, i)
              setDragIdx(null)
            }}
            onDragEnd={() => setDragIdx(null)}
            className={cn(
              'rounded-lg border bg-white dark:bg-slate-900',
              issues.length > 0
                ? 'border-amber-300 dark:border-amber-500/60'
                : 'border-slate-200 dark:border-slate-700',
              dragIdx === i && 'opacity-50'
            )}
          >
            <div className='flex items-center gap-1.5 px-2 py-1.5'>
              <GripVertical
                aria-hidden
                className='h-3.5 w-3.5 shrink-0 cursor-grab text-slate-300 dark:text-slate-600'
              />
              <button
                type='button'
                onClick={() => setOpenIdx(open ? null : i)}
                aria-expanded={open}
                className='flex min-w-0 flex-1 items-center gap-1.5 text-left'
              >
                {open ? (
                  <ChevronDown aria-hidden className='h-3.5 w-3.5 shrink-0 text-slate-400' />
                ) : (
                  <ChevronRight aria-hidden className='h-3.5 w-3.5 shrink-0 text-slate-400' />
                )}
                <span className='min-w-[5rem] max-w-[60%] shrink-0 truncate text-[12.5px] font-medium text-slate-800 sm:max-w-[40%] dark:text-slate-100'>
                  {f.label?.trim() || (
                    <span className='font-normal italic text-slate-500'>Untitled filter</span>
                  )}
                </span>
                <span className='hidden min-w-0 truncate text-[11.5px] text-slate-500 sm:inline dark:text-slate-400'>
                  {paths
                    .map((p) => pathLabel(p))
                    .filter(Boolean)
                    .join(' or ') || '—'}
                </span>
              </button>
              {issues.length > 0 && (
                <span className='shrink-0 rounded bg-amber-50 px-1.5 py-0.5 text-[10.5px] font-medium text-amber-800 dark:bg-amber-500/10 dark:text-amber-200'>
                  {issues[0]}
                </span>
              )}
              <button
                type='button'
                aria-label={`Move ${f.label || 'filter'} up`}
                data-tip='Move up'
                disabled={i === 0}
                onClick={() => move(i, i - 1)}
                className={cn(iconBtn, 'hidden sm:flex')}
              >
                <ArrowUp className='h-3.5 w-3.5' />
              </button>
              <button
                type='button'
                aria-label={`Move ${f.label || 'filter'} down`}
                data-tip='Move down'
                disabled={i === value.length - 1}
                onClick={() => move(i, i + 1)}
                className={cn(iconBtn, 'hidden sm:flex')}
              >
                <ArrowDown className='h-3.5 w-3.5' />
              </button>
              <button
                type='button'
                aria-label={`Duplicate ${f.label || 'filter'}`}
                data-tip='Duplicate'
                onClick={() =>
                  onChange([
                    ...value.slice(0, i + 1),
                    { ...f, key: uniqueKey(`${f.key || 'filter'}_copy`, value) },
                    ...value.slice(i + 1)
                  ])
                }
                className={iconBtn}
              >
                <Copy className='h-3.5 w-3.5' />
              </button>
              <button
                type='button'
                aria-label={`Remove ${f.label || 'filter'}`}
                data-tip='Remove'
                onClick={() => {
                  onChange(value.filter((_, idx) => idx !== i))
                  if (openIdx === i) setOpenIdx(null)
                }}
                className={cn(iconBtn, 'hover:text-red-600 dark:hover:text-red-400')}
              >
                <Trash2 className='h-3.5 w-3.5' />
              </button>
            </div>
            {open && (
              <QuickFilterForm
                collection={collection}
                value={f}
                all={value}
                isNew={!savedKeys.current.has(f.key)}
                onChange={(partial) => update(i, partial)}
                className='border-t border-slate-100 px-3 py-3 dark:border-slate-800'
              />
            )}
          </div>
        )
      })}

      <div className='flex items-center gap-3'>
        <button
          type='button'
          onClick={() => {
            onChange([
              ...value,
              { key: '', label: '', path: [], collection: '', label_field: '', value_field: 'id' }
            ])
            setOpenIdx(value.length)
          }}
          className='inline-flex h-7 items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 text-[12px] font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800'
        >
          <Plus aria-hidden className='h-3.5 w-3.5' />
          Add filter
        </button>
        <button
          type='button'
          onClick={() => {
            setRawDraft(JSON.stringify(value, null, 2))
            setRawError('')
            setShowRaw((v) => !v)
          }}
          className='text-[11.5px] text-slate-500 hover:text-slate-800 hover:underline dark:text-slate-400 dark:hover:text-slate-100'
        >
          {showRaw ? 'Hide JSON' : 'Edit as JSON'}
        </button>
      </div>

      {showRaw && (
        <div>
          {/* The escape hatch stays: this UI knows the shape as it is today, and
              a config it cannot express should still be editable. */}
          <textarea
            value={rawDraft}
            onChange={(e) => setRawDraft(e.target.value)}
            rows={8}
            aria-label='Quick filters as JSON'
            className='w-full rounded-md border border-slate-200 bg-white px-2.5 py-2 font-mono text-[11.5px] text-slate-800 focus:border-nvr-cyan/60 focus:outline-none focus:ring-2 focus:ring-nvr-cyan/25 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100'
          />
          {rawError && <p className='text-[11.5px] text-red-600 dark:text-red-400'>{rawError}</p>}
          <button
            type='button'
            className='mt-1 inline-flex h-7 items-center rounded-md border border-slate-200 bg-white px-2.5 text-[12px] font-medium text-slate-700 hover:bg-slate-50 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800'
            onClick={() => {
              try {
                const parsed = JSON.parse(rawDraft || '[]')
                if (!Array.isArray(parsed)) throw new Error('not an array')
                setRawError('')
                onChange(parsed)
              } catch {
                setRawError('That is not valid JSON — it must be a list of quick-filter objects.')
              }
            }}
          >
            Apply JSON
          </button>
        </div>
      )}
    </div>
  )
}
