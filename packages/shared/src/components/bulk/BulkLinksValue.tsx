import { X } from 'lucide-react'
import { resolveOptionFilterTokens } from '../../lib/option-filter-tokens'
import { cn } from '../../lib/utils'
import { parseJson } from '../item-edit/helpers'
import { RelatedItemLabel, RelationCombobox } from '../item-edit/RelationCombobox'
import type { BulkLinkMode } from './bulk-update-preview'

const MODES: Array<{ value: BulkLinkMode; label: string; hint: string }> = [
  { value: 'append', label: 'Add', hint: 'Add these links; links a record already has stay' },
  { value: 'replace', label: 'Replace', hint: 'Each record’s links become exactly these' },
  { value: 'remove', label: 'Remove', hint: 'Take these links off; the rest stay' }
]

/**
 * The value step of bulk "Update field" for a to-many field (2026-11-13): how
 * the picked records apply (Add / Replace / Remove) and which records. Options
 * come from the field's own picker settings (option filter, sort) as the form
 * uses them; a filter that names the record being edited cannot apply to many
 * records and is dropped. Each record's own picker cascades are checked by the
 * server when the write lands.
 */
export function BulkLinksValue({
  related,
  fieldLabel,
  fieldOptions,
  mode,
  ids,
  onMode,
  onIds
}: {
  related: string
  fieldLabel: string
  fieldOptions?: unknown
  mode: BulkLinkMode
  ids: Array<string | number>
  onMode: (m: BulkLinkMode) => void
  onIds: (ids: Array<string | number>) => void
}) {
  const opts = parseJson<{ option_filter?: Record<string, unknown>; option_sort?: string }>(
    fieldOptions
  )
  const filter = resolveOptionFilterTokens(
    opts?.option_filter && typeof opts.option_filter === 'object' ? opts.option_filter : undefined,
    undefined,
    'new'
  )
  const has = (id: unknown) => ids.some((x) => String(x).toLowerCase() === String(id).toLowerCase())
  return (
    <div className='space-y-2' data-bulk-links>
      <fieldset
        aria-label={`How to change ${fieldLabel}`}
        className='m-0 grid min-w-0 grid-cols-3 gap-0.5 rounded-md border-0 bg-muted p-0.5'
      >
        {MODES.map((m) => (
          <button
            key={m.value}
            type='button'
            aria-pressed={mode === m.value}
            data-bulk-links-mode={m.value}
            data-tip={m.hint}
            onClick={() => onMode(m.value)}
            className={cn(
              'h-7 rounded-[5px] text-[12.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan',
              mode === m.value
                ? 'bg-background text-foreground shadow-sm'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {m.label}
          </button>
        ))}
      </fieldset>
      {ids.length > 0 && (
        <ul className='flex flex-wrap gap-1' aria-label={`Picked ${fieldLabel}`}>
          {ids.map((id) => (
            <li
              key={String(id)}
              data-bulk-links-chip={String(id)}
              className='inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-muted/60 py-0.5 pl-2 pr-1 text-[12px] text-foreground'
            >
              <span className='min-w-0 truncate'>
                <RelatedItemLabel collection={related} id={id} />
              </span>
              <button
                type='button'
                onClick={() => onIds(ids.filter((x) => x !== id))}
                aria-label='Remove from the list'
                className='rounded-full p-0.5 text-muted-foreground hover:bg-background hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-nvr-cyan'
              >
                <X className='h-3 w-3' />
              </button>
            </li>
          ))}
        </ul>
      )}
      <RelationCombobox
        collection={related}
        value={null}
        onChange={(v) => {
          const id = v && typeof v === 'object' ? (v as { id?: unknown }).id : v
          if ((typeof id === 'string' || typeof id === 'number') && id !== '' && !has(id))
            onIds([...ids, id])
        }}
        extraFilter={filter ?? undefined}
        optionSort={
          typeof opts?.option_sort === 'string' && opts.option_sort ? opts.option_sort : undefined
        }
        placeholder={ids.length ? 'Add another…' : `Pick ${fieldLabel}…`}
      />
    </div>
  )
}
