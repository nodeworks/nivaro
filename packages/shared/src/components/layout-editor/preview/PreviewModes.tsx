import { X } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { cn, titleCase } from '../../../lib/utils'
import type { ActiveLayoutData } from '../../item-edit/types'
import { SimpleSelect } from '../../ui/SimpleSelect'
import type { PreviewAs } from '../EditorTopBar'
import { LoadError } from '../load-error'
import type { DescribeField } from '../overview/describe-conditions'
import { useRoleNames } from '../overview/overview-api'
import { segOption, segTrack } from '../panel-style'
import { useCollectionPipelines } from './preview-api'
import { drivingFields, type PreviewDevice } from './preview-model'

// The rest of the Preview as popover (one anchored popover for every canvas
// preview mode): compare a second role, a workflow state, what-if values,
// device width and the who-sees overlay.

const labelCls = 'mb-1 block text-[11.5px] font-semibold text-slate-600 dark:text-muted-foreground'
const hintCls = 'mt-1 text-[11.5px] leading-snug text-slate-500 dark:text-muted-foreground'
const inputCls =
  'h-8 w-full rounded-md border border-slate-200 bg-white px-2.5 text-[12.5px] text-slate-800 outline-none placeholder:text-slate-400 focus:border-nvr-cyan dark:border-border dark:bg-background dark:text-foreground dark:placeholder:text-muted-foreground'
const chipCls =
  'inline-flex h-6 items-center rounded-full border border-slate-200 px-2 text-[12px] text-slate-700 transition-colors hover:bg-muted dark:border-border dark:text-foreground'

const DEVICES: Array<{ value: PreviewDevice; label: string; tip: string }> = [
  { value: 'desktop', label: 'Desktop', tip: 'The full canvas width' },
  { value: 'tablet', label: 'Tablet', tip: '768 px wide' },
  { value: 'phone', label: 'Phone', tip: '390 px wide' }
]

export function fieldName(fields: DescribeField[], field: string): string {
  const l = fields.find((f) => f.field === field)?.label
  return l?.trim() ? l.trim() : titleCase(field)
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className='mt-3 border-t border-slate-100 pt-3 dark:border-border'>
      <p className={labelCls}>{title}</p>
      {children}
    </div>
  )
}

export function PreviewModes({
  collection,
  value,
  onChange,
  layout,
  fields
}: {
  collection: string
  value: PreviewAs
  onChange: (v: PreviewAs) => void
  /** The canvas layout (draft): its visibility conditions feed What if. */
  layout: ActiveLayoutData | null
  fields: DescribeField[]
}) {
  const { data: roles = [] } = useRoleNames(true)
  const {
    data: pipelines = [],
    isLoading: pipelinesLoading,
    isError: pipelinesFailed,
    refetch: refetchPipelines
  } = useCollectionPipelines(collection, true)
  const drivers = useMemo(() => (layout ? drivingFields(layout) : []), [layout])
  const [field, setField] = useState('')
  const [text, setText] = useState('')
  const picked = drivers.find((d) => d.field === field) ?? drivers[0] ?? null
  const values = value.values ?? {}
  const setValue = (f: string, v: unknown) => onChange({ ...value, values: { ...values, [f]: v } })
  const dropValue = (f: string) => {
    const { [f]: _, ...rest } = values
    onChange({ ...value, values: Object.keys(rest).length > 0 ? rest : null })
  }

  const stateOptions = pipelines.flatMap((p) =>
    p.states.map((s) => ({
      value: `${p.id}::${s.id}`,
      label: pipelines.length > 1 ? `${p.name} · ${s.label}` : s.label
    }))
  )

  return (
    <div data-preview-modes=''>
      <Section title='Compare with a second role'>
        <SimpleSelect
          value={value.compareRoleId ?? ''}
          onChange={(v) => onChange({ ...value, compareRoleId: v || null })}
          ariaLabel='Compare with role'
          disabled={!value.roleId}
          className='h-8 text-[12.5px]'
          options={[
            { value: '', label: 'No comparison' },
            ...roles
              .filter((r) => r.id !== value.roleId)
              .map((r) => ({ value: r.id, label: r.name }))
          ]}
        />
        <p className={hintCls}>
          {value.roleId
            ? 'Splits the canvas: the same record as both roles, differences marked.'
            : 'Pick a role above first.'}
        </p>
      </Section>

      <Section title='Workflow state'>
        {stateOptions.length > 0 ? (
          <SimpleSelect
            value={value.state ? `${value.state.pipelineId}::${value.state.id}` : ''}
            onChange={(v) => {
              if (!v) return onChange({ ...value, state: null })
              const [pid, sid] = v.split('::')
              const p = pipelines.find((x) => x.id === pid)
              const s = p?.states.find((x) => x.id === sid)
              if (p && s)
                onChange({
                  ...value,
                  state: { pipelineId: p.id, id: s.id, key: s.key, label: s.label }
                })
            }}
            ariaLabel='Preview in workflow state'
            className='h-8 text-[12.5px]'
            options={[{ value: '', label: 'The record’s own state' }, ...stateOptions]}
          />
        ) : pipelinesFailed ? (
          <LoadError what='the workflow states' onRetry={() => void refetchPipelines()} />
        ) : (
          <p className={hintCls}>
            {pipelinesLoading ? 'Loading…' : 'No pipeline is bound to this collection.'}
          </p>
        )}
        {stateOptions.length > 0 && (
          <p className={hintCls}>Shows what locks and what moving on needs at that step.</p>
        )}
      </Section>

      <Section title='What if'>
        {drivers.length === 0 ? (
          <p className={hintCls}>No step on this form shows only for some values.</p>
        ) : (
          <>
            <SimpleSelect
              value={picked?.field ?? ''}
              onChange={(v) => {
                setField(v)
                setText('')
              }}
              ariaLabel='Driving field'
              className='h-8 text-[12.5px]'
              options={drivers.map((d) => ({ value: d.field, label: fieldName(fields, d.field) }))}
            />
            {picked && (
              <>
                <p className={hintCls}>Decides {picked.drives.join(', ')}.</p>
                <div className='mt-1.5 flex flex-wrap gap-1'>
                  {picked.values.map((v) => (
                    <button
                      key={v}
                      type='button'
                      className={chipCls}
                      onClick={() => setValue(picked.field, v)}
                    >
                      {v}
                    </button>
                  ))}
                  <button
                    type='button'
                    className={chipCls}
                    onClick={() => setValue(picked.field, null)}
                  >
                    Empty
                  </button>
                </div>
                <form
                  className='mt-1.5 flex gap-1'
                  onSubmit={(e) => {
                    e.preventDefault()
                    if (text.trim()) setValue(picked.field, text.trim())
                  }}
                >
                  <input
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder='Another value…'
                    aria-label='What-if value'
                    className={inputCls}
                  />
                  <button
                    type='submit'
                    className='h-8 shrink-0 rounded-md bg-nvr-cyan px-2.5 text-[12px] font-medium text-white hover:opacity-90'
                  >
                    Set
                  </button>
                </form>
              </>
            )}
            {Object.keys(values).length > 0 && (
              <ul className='mt-2 flex flex-wrap gap-1'>
                {Object.entries(values).map(([f, v]) => (
                  <li
                    key={f}
                    className='inline-flex max-w-full items-center gap-1 rounded-full bg-nvr-cyan/10 px-2 py-0.5 text-[12px] text-slate-800 dark:text-foreground'
                  >
                    <span className='truncate'>
                      {fieldName(fields, f)} = {v == null || v === '' ? 'empty' : String(v)}
                    </span>
                    <button
                      type='button'
                      aria-label={`Stop overriding ${fieldName(fields, f)}`}
                      onClick={() => dropValue(f)}
                      className='text-slate-500 hover:text-slate-800 dark:text-muted-foreground dark:hover:text-foreground'
                    >
                      <X className='h-3 w-3' />
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </Section>

      <Section title='Device'>
        <div className={segTrack(DEVICES.length)}>
          {DEVICES.map((d) => (
            <button
              key={d.value}
              type='button'
              aria-pressed={(value.device ?? 'desktop') === d.value}
              data-tip={d.tip}
              onClick={() => onChange({ ...value, device: d.value })}
              className={segOption((value.device ?? 'desktop') === d.value)}
            >
              {d.label}
            </button>
          ))}
        </div>
      </Section>

      <Section title='Who sees each field'>
        <label className='flex cursor-pointer items-center justify-between gap-2 text-[12.5px] text-slate-700 dark:text-foreground'>
          Tint fields by how many roles see them
          <button
            type='button'
            role='switch'
            aria-checked={!!value.who}
            aria-label='Who sees each field'
            onClick={() => onChange({ ...value, who: !value.who })}
            className={cn(
              'relative h-4 w-7 shrink-0 rounded-full transition-colors',
              value.who ? 'bg-nvr-cyan' : 'bg-slate-300 dark:bg-border'
            )}
          >
            <span
              className={cn(
                'absolute left-0 top-0.5 h-3 w-3 rounded-full bg-white transition-transform',
                value.who ? 'translate-x-3.5' : 'translate-x-0.5'
              )}
            />
          </button>
        </label>
      </Section>
    </div>
  )
}
