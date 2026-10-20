import { useQuery } from '@tanstack/react-query'
import { CornerDownLeft, Plus, X } from 'lucide-react'
import { cn } from '../../../lib/utils'
import { SimpleSelect } from '../../ui/SimpleSelect'
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
    .map((f) => ({ value: f.field, label: f.label || f.field }))
  const FORMAT_OPTS = [
    { value: 'text', label: 'Text' },
    { value: 'date', label: 'Date' },
    { value: 'datetime', label: 'Date & Time' },
    { value: 'boolean', label: 'Yes / No' }
  ]
  return (
    <div className='mt-1.5 space-y-1.5 border-t border-slate-100 pt-1.5'>
      <p className='text-[9px] font-semibold uppercase tracking-wider text-slate-400'>
        Inline display
      </p>
      <div className='flex gap-1 mt-1'>
        <button
          type='button'
          onClick={() => onSeparatorChange(null)}
          className={cn(
            'flex-1 rounded border px-2 py-0.5 text-[10px]',
            separator === null
              ? 'border-nvr-cyan bg-nvr-cyan/10 text-nvr-navy dark:text-nvr-cyan'
              : 'border-slate-200 text-slate-500 hover:border-slate-300'
          )}
        >
          Stacked
        </button>
        <button
          type='button'
          onClick={() => onSeparatorChange(separator ?? ', ')}
          className={cn(
            'flex-1 rounded border px-2 py-0.5 text-[10px]',
            separator !== null
              ? 'border-nvr-cyan bg-nvr-cyan/10 text-nvr-navy dark:text-nvr-cyan'
              : 'border-slate-200 text-slate-500 hover:border-slate-300'
          )}
        >
          Inline
        </button>
      </div>
      {separator !== null && (
        <div className='flex items-center gap-1.5 mt-1'>
          <span className='text-[10px] text-slate-400 shrink-0'>Separator</span>
          <input
            type='text'
            value={separator}
            onChange={(e) => onSeparatorChange(e.target.value)}
            className='flex-1 rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] focus:outline-none focus:ring-1 focus:ring-nvr-cyan'
            placeholder=', '
          />
        </div>
      )}
      {entries.map((entry, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: stable config order
        <div key={i} className='space-y-1'>
          {separator !== null && i > 0 && (
            <button
              type='button'
              title={entry.line_break ? 'Remove line break' : 'Start new line before this field'}
              onClick={() =>
                onChange(entries.map((e, j) => (j === i ? { ...e, line_break: !e.line_break } : e)))
              }
              className={cn(
                'flex items-center gap-1 text-[10px] rounded px-1.5 py-0.5 border transition-colors',
                entry.line_break
                  ? 'border-nvr-cyan bg-nvr-cyan/10 text-nvr-navy dark:text-nvr-cyan'
                  : 'border-slate-200 text-slate-400 hover:border-slate-300 hover:text-slate-600'
              )}
            >
              <CornerDownLeft className='h-3 w-3' />
              New line
            </button>
          )}
          <div className='flex items-center gap-1'>
            <div className='flex-1 min-w-0'>
              <Combobox
                value={entry.field}
                onChange={(v) =>
                  onChange(entries.map((e, j) => (j === i ? { ...e, field: v } : e)))
                }
                options={fieldOptions}
                placeholder='Field…'
              />
            </div>
            <button
              type='button'
              onClick={() => onChange(entries.filter((_, j) => j !== i))}
              className='shrink-0 text-slate-300 hover:text-red-500'
            >
              <X className='h-3.5 w-3.5' />
            </button>
          </div>
          <div className='flex gap-1'>
            <input
              type='text'
              value={entry.label ?? ''}
              placeholder='Label…'
              onChange={(e) =>
                onChange(
                  entries.map((en, j) => (j === i ? { ...en, label: e.target.value || null } : en))
                )
              }
              className='flex-1 rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] focus:outline-none focus:ring-1 focus:ring-nvr-cyan placeholder:text-slate-300'
            />
            <SimpleSelect
              value={entry.format ?? 'text'}
              onChange={(v) =>
                onChange(
                  entries.map((en, j) =>
                    j === i ? { ...en, format: v === 'text' ? null : v } : en
                  )
                )
              }
              className='h-6 w-auto rounded border-slate-200 bg-white px-1.5 py-0.5 text-[10px] text-slate-600'
              options={FORMAT_OPTS.map((o) => ({ value: o.value, label: o.label }))}
            />
          </div>
        </div>
      ))}
      <button
        type='button'
        onClick={() => onChange([...entries, { field: '', label: null, format: null }])}
        className='flex items-center gap-1 text-[11px] text-slate-400 hover:text-nvr-cyan'
      >
        <Plus className='h-3.5 w-3.5' />
        Add field
      </button>
    </div>
  )
}
