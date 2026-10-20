import { ArrowDown, ArrowUp, Plus, X } from 'lucide-react'
import { titleCase } from '../../../lib/utils'
import { seedQuickPickerSteps } from '../../item-edit/helpers'
import { PickList, quietText } from '../settings/controls'
import type { SettingsRelation } from '../settings/settings-api'

type StepField = {
  field: string
  label?: string | null
  dependency_config?: unknown
  hidden?: boolean
  required?: boolean
}

/** At most this many steps (the server refuses more). */
export const QUICK_PICKER_MAX = 20

/** The walk the cascade rules imply: parents before children. */
export function seedSteps(
  fields: StepField[],
  relations: SettingsRelation[],
  collection: string
): string[] {
  return seedQuickPickerSteps(
    fields,
    relations.map((r) => ({
      many_collection: r.many_collection ?? '',
      many_field: r.many_field,
      one_collection: r.one_collection,
      one_field: r.one_field,
      junction_field: r.junction_field
    })),
    collection
  ).slice(0, QUICK_PICKER_MAX)
}

/**
 * Quick picker steps: relation fields walked one at a time (each narrowed by the
 * ones before it) before a new record's form opens, and shown as a strip on top
 * of the form. Labels first, the key quietly beside them.
 */
export function QuickPickerStepsEditor({
  steps,
  fields,
  relations,
  collection,
  onChange,
  showSeed = true
}: {
  steps: string[]
  fields: StepField[]
  relations: SettingsRelation[]
  collection: string
  onChange: (steps: string[]) => void
  /** Offer "Fill from cascade rules" here (Form settings shows it as its own row). */
  showSeed?: boolean
}) {
  const labelOf = (f: string) => fields.find((x) => x.field === f)?.label || titleCase(f)
  const eligible = fields
    .filter(
      (f) =>
        !steps.includes(f.field) &&
        relations.some(
          (r) =>
            (r.many_collection === collection && r.many_field === f.field && !r.junction_field) ||
            (r.one_collection === collection && r.one_field === f.field)
        )
    )
    .map((f) => ({ value: f.field, label: labelOf(f.field), hint: f.field }))
    .sort((a, b) => a.label.localeCompare(b.label))
  const move = (i: number, dir: -1 | 1) => {
    const j = i + dir
    if (j < 0 || j >= steps.length) return
    const next = [...steps]
    ;[next[i], next[j]] = [next[j], next[i]]
    onChange(next)
  }
  const iconBtn =
    'flex h-6 w-6 items-center justify-center rounded text-slate-400 hover:bg-muted hover:text-slate-700 disabled:opacity-25 dark:hover:text-foreground'
  return (
    <div className='space-y-1.5' data-quick-picker>
      {steps.length === 0 ? (
        <p className={quietText}>Off: new records open straight on the form.</p>
      ) : (
        <ol className='space-y-1'>
          {steps.map((f, i) => (
            <li
              key={f}
              data-quick-step={f}
              className='flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2 py-1 text-[12.5px] dark:border-border dark:bg-card'
            >
              <span className='w-4 text-center text-[11px] tabular-nums text-slate-400'>
                {i + 1}
              </span>
              <span className='min-w-0 flex-1 truncate text-slate-800 dark:text-foreground'>
                {labelOf(f)}
                <span className='ml-1.5 font-mono text-[11px] text-slate-400'>{f}</span>
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
                disabled={i === steps.length - 1}
                className={iconBtn}
                aria-label={`Move ${labelOf(f)} down`}
              >
                <ArrowDown className='h-3.5 w-3.5' />
              </button>
              <button
                type='button'
                onClick={() => onChange(steps.filter((s) => s !== f))}
                className={iconBtn}
                aria-label={`Remove ${labelOf(f)}`}
              >
                <X className='h-3.5 w-3.5' />
              </button>
            </li>
          ))}
        </ol>
      )}
      <div className='flex flex-wrap items-center gap-2'>
        {steps.length < QUICK_PICKER_MAX && (
          <span className='inline-flex items-center gap-1'>
            <Plus className='h-3.5 w-3.5 text-slate-400' />
            <PickList
              ariaLabel='Add step'
              value={null}
              options={eligible}
              placeholder='Add a step…'
              emptyText='No more relation fields'
              onChange={(v) => v && onChange([...steps, v])}
            />
          </span>
        )}
        {showSeed && (
          <button
            type='button'
            onClick={() => onChange(seedSteps(fields, relations, collection))}
            className='text-[12px] font-medium text-nvr-navy hover:underline dark:text-nvr-cyan'
          >
            Fill from cascade rules
          </button>
        )}
        {steps.length > 0 && (
          <button
            type='button'
            onClick={() => onChange([])}
            className='text-[12px] text-slate-500 hover:text-[#9c2f47] dark:text-muted-foreground dark:hover:text-[#f08aa1]'
          >
            Clear
          </button>
        )}
      </div>
    </div>
  )
}
