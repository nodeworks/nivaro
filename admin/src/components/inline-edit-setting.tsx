import type { InlineEditConfig, InlineEditorKind } from '@nivaro/shared'
import { useId } from 'react'
import { Checkbox } from '@/components/ui/checkbox'
import { Switch } from '@/components/ui/switch'

/**
 * #3224 — "Edit in the list" for one list (a collection's browser or a queue).
 * Off by default; an admin switches it on and ticks the columns people may
 * change straight in a row. Every change still goes through the record's own
 * rules on the server (field rights, User Scopes, validation, edit locks).
 */

const KIND_LABEL: Record<InlineEditorKind, string> = {
  text: 'text',
  longtext: 'long text',
  integer: 'whole number',
  number: 'number',
  date: 'date',
  datetime: 'date & time',
  boolean: 'yes / no',
  choice: 'choice',
  m2o: 'picker'
}

export interface InlineEditCandidate {
  field: string
  label: string
  kind: InlineEditorKind
  /** Small context next to the name (e.g. the source collection on a queue). */
  note?: string
}

export function InlineEditSetting({
  value,
  candidates,
  onChange,
  disabled,
  listNoun = 'list'
}: {
  value: InlineEditConfig
  candidates: InlineEditCandidate[]
  onChange: (next: InlineEditConfig) => void
  disabled?: boolean
  /** "list" / "queue" — how the copy names this surface. */
  listNoun?: string
}) {
  const id = useId()
  const chosen = new Set(value.fields)
  const toggle = (field: string, on: boolean) => {
    const next = on ? [...value.fields, field] : value.fields.filter((f) => f !== field)
    onChange({ ...value, fields: [...new Set(next)] })
  }
  return (
    <div className='space-y-2' data-inline-edit-setting={value.enabled ? 'on' : 'off'}>
      <div className='flex items-start justify-between gap-4'>
        <div className='min-w-0'>
          <p className='text-[12.5px] font-medium text-slate-700 dark:text-foreground'>
            Edit in the {listNoun}
          </p>
          <p className='text-[11.5px] text-slate-500 dark:text-muted-foreground'>
            People change a value straight in a row — click the cell, type, Enter or Tab saves, Esc
            cancels. The record&apos;s normal rules still decide: field rights, scopes, validation
            and edit locks.
          </p>
        </div>
        <Switch
          checked={value.enabled}
          disabled={disabled}
          aria-label={`Edit in the ${listNoun}`}
          onCheckedChange={(on) =>
            onChange({
              enabled: on,
              // Switching on with nothing ticked would edit nothing — start with every column.
              fields:
                on && value.fields.length === 0 ? candidates.map((c) => c.field) : value.fields
            })
          }
        />
      </div>
      {value.enabled && (
        <div className='ml-4 border-l-2 border-slate-100 pl-3 dark:border-border'>
          <div className='mb-1 flex items-center gap-2'>
            <p className='text-[12px] font-medium text-slate-600 dark:text-slate-300'>
              Editable columns
            </p>
            <button
              type='button'
              disabled={disabled}
              onClick={() => onChange({ ...value, fields: candidates.map((c) => c.field) })}
              className='text-[11px] text-slate-500 hover:text-slate-800 disabled:opacity-50 dark:text-slate-400 dark:hover:text-slate-100'
            >
              All
            </button>
            <button
              type='button'
              disabled={disabled}
              onClick={() => onChange({ ...value, fields: [] })}
              className='text-[11px] text-slate-500 hover:text-slate-800 disabled:opacity-50 dark:text-slate-400 dark:hover:text-slate-100'
            >
              None
            </button>
          </div>
          {candidates.length === 0 ? (
            <p className='text-[11.5px] text-slate-400 dark:text-muted-foreground'>
              No column here can be edited in a row — computed, read-only, file and multi-record
              fields always open the record.
            </p>
          ) : (
            <div className='flex flex-wrap gap-x-4 gap-y-1'>
              {candidates.map((c) => (
                <label
                  key={`${c.note ?? ''}:${c.field}`}
                  htmlFor={`ie-${id}-${c.note ?? ''}-${c.field}`}
                  className='flex cursor-pointer items-center gap-1.5 text-[12.5px] text-slate-700 dark:text-slate-200'
                >
                  <Checkbox
                    id={`ie-${id}-${c.note ?? ''}-${c.field}`}
                    checked={chosen.has(c.field)}
                    disabled={disabled}
                    onCheckedChange={(on) => toggle(c.field, !!on)}
                  />
                  <span>{c.label}</span>
                  <span className='text-[10.5px] text-slate-400 dark:text-muted-foreground'>
                    {KIND_LABEL[c.kind]}
                    {c.note ? ` · ${c.note}` : ''}
                  </span>
                </label>
              ))}
            </div>
          )}
          {value.fields.length === 0 && candidates.length > 0 && (
            <p className='mt-1 text-[11px] text-amber-600 dark:text-amber-400'>
              No column ticked — nothing can be edited in the {listNoun} yet.
            </p>
          )}
        </div>
      )}
    </div>
  )
}
