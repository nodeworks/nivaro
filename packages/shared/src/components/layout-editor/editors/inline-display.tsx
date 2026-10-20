import { useQuery } from '@tanstack/react-query'
import { CornerDownLeft, Plus, X } from 'lucide-react'
import { cn, titleCase } from '../../../lib/utils'
import { SimpleSelect } from '../../ui/SimpleSelect'
import { effectText, inputBase, segOption, tintCard } from '../panel-style'
import { Combobox } from './controls'
import { useEditorApi } from './editor-api'

export type InlineDisplayEntry = {
  field: string
  label: string | null
  format: string | null
  line_break?: boolean
}
export type InlineDisplayConfig = { entries: InlineDisplayEntry[]; separator: string | null }
export type SubtitleField = {
  field: string
  label: string | null
  color?: string
  weight?: string
  display_as?: string
}

export function InlineDisplaySection({
  relatedCollection,
  entries,
  separator,
  onChange,
  onSeparatorChange
}: {
  relatedCollection: string
  entries: InlineDisplayEntry[]
  separator: string | null
  onChange: (entries: InlineDisplayEntry[]) => void
  onSeparatorChange: (sep: string | null) => void
}) {
  const api = useEditorApi()
  const { data: relFields = [] } = useQuery<Array<{ field: string; label?: string }>>({
    queryKey: ['field-config', relatedCollection],
    queryFn: () =>
      api.get(`/field-config/${relatedCollection}`).then((r) => r.data?.data ?? r.data ?? []),
    staleTime: 60_000
  })
  const fieldOptions = (relFields as Array<{ field: string; label?: string }>)
    .filter((f) => !f.field.startsWith('__'))
    .map((f) => ({ value: f.field, label: f.label || titleCase(f.field) }))
  // A path into the picked record's own links ("unit_type.name") is named hop by
  // hop: "Unit Type → Name". Only the first hop's label is known here.
  const pathLabel = (path: string) => {
    const [first, ...rest] = path.split('.')
    const head = fieldOptions.find((o) => o.value === first)?.label ?? titleCase(first)
    return [head, ...rest.map((r) => titleCase(r))].join(' → ')
  }
  const optionsFor = (value: string) =>
    value && !fieldOptions.some((o) => o.value === value)
      ? [...fieldOptions, { value, label: pathLabel(value) }]
      : fieldOptions
  const FORMAT_OPTS = [
    { value: 'text', label: 'Text' },
    { value: 'date', label: 'Date' },
    { value: 'datetime', label: 'Date & Time' },
    { value: 'boolean', label: 'Yes / No' }
  ]
  const setEntry = (i: number, patch: Partial<InlineDisplayEntry>) =>
    onChange(entries.map((e, j) => (j === i ? { ...e, ...patch } : e)))
  return (
    <div className='space-y-3'>
      <div
        className='grid grid-cols-2 gap-0.5 rounded-md bg-slate-100 p-0.5 dark:bg-muted'
        data-setting='field.inline_display.mode'
      >
        <button
          type='button'
          aria-pressed={separator === null}
          onClick={() => onSeparatorChange(null)}
          className={segOption(separator === null)}
        >
          One per line
        </button>
        <button
          type='button'
          aria-pressed={separator !== null}
          onClick={() => onSeparatorChange(separator ?? ', ')}
          className={segOption(separator !== null)}
        >
          On one line
        </button>
      </div>
      {separator !== null && (
        <div className='flex items-center gap-2' data-setting='field.inline_display.separator'>
          <span className={cn(effectText, 'shrink-0')}>Between values</span>
          <input
            type='text'
            aria-label='Between values'
            value={separator}
            onChange={(e) => onSeparatorChange(e.target.value)}
            className={cn(inputBase, 'h-7 w-20 font-mono')}
            placeholder=', '
          />
        </div>
      )}
      {entries.length > 0 && (
        <ul className='space-y-2'>
          {entries.map((entry, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: stable config order
            <li key={i} className={cn(tintCard, 'space-y-2 p-2.5')}>
              {separator !== null && i > 0 && (
                <button
                  type='button'
                  aria-pressed={!!entry.line_break}
                  data-setting='field.inline_display.line_break'
                  data-tip={
                    entry.line_break ? 'Remove line break' : 'Start new line before this field'
                  }
                  onClick={() => setEntry(i, { line_break: !entry.line_break })}
                  className={cn(
                    'inline-flex h-6 items-center gap-1 rounded px-1.5 text-[12px] transition-colors',
                    entry.line_break
                      ? 'bg-nvr-cyan/10 font-medium text-slate-900 dark:text-foreground'
                      : 'text-slate-500 hover:bg-slate-100 hover:text-slate-800 dark:text-muted-foreground dark:hover:bg-muted dark:hover:text-foreground'
                  )}
                >
                  <CornerDownLeft className='h-3 w-3' />
                  New line before
                </button>
              )}
              <div className='flex items-center gap-1.5'>
                <div className='min-w-0 flex-1' data-setting='field.inline_display.fields'>
                  <Combobox
                    value={entry.field}
                    onChange={(v) => setEntry(i, { field: v })}
                    options={optionsFor(entry.field)}
                    placeholder='Pick a field…'
                  />
                </div>
                <button
                  type='button'
                  aria-label='Remove'
                  data-tip='Remove'
                  onClick={() => onChange(entries.filter((_, j) => j !== i))}
                  className='inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-slate-400 transition-colors hover:bg-slate-100 hover:text-red-600 dark:hover:bg-muted dark:hover:text-red-400'
                >
                  <X className='h-3.5 w-3.5' />
                </button>
              </div>
              <div className='flex gap-1.5'>
                <input
                  type='text'
                  aria-label='Label'
                  data-setting='field.inline_display.label'
                  value={entry.label ?? ''}
                  placeholder='Label (optional)'
                  onChange={(e) => setEntry(i, { label: e.target.value || null })}
                  className={cn(inputBase, 'h-7 min-w-0 flex-1 text-[12px]')}
                />
                <span className='contents' data-setting='field.inline_display.format'>
                  <SimpleSelect
                    value={entry.format ?? 'text'}
                    ariaLabel='Show as'
                    onChange={(v) => setEntry(i, { format: v === 'text' ? null : v })}
                    className={cn(
                      inputBase,
                      'h-7 w-[108px] shrink-0 text-[12px] focus:ring-0 focus:ring-offset-0'
                    )}
                    options={FORMAT_OPTS.map((o) => ({ value: o.value, label: o.label }))}
                  />
                </span>
              </div>
            </li>
          ))}
        </ul>
      )}
      <button
        type='button'
        onClick={() => onChange([...entries, { field: '', label: null, format: null }])}
        className='inline-flex items-center gap-1 text-[12px] font-medium text-sky-700 hover:underline dark:text-nvr-cyan'
      >
        <Plus className='h-3.5 w-3.5' />
        Add a field
      </button>
    </div>
  )
}
