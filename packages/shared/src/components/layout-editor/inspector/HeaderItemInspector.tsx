import { X } from 'lucide-react'
import { useEffect, useState } from 'react'
import type { PlacementRow } from '../../../lib/layout-ops'
import { cn } from '../../../lib/utils'
import { effectText, inputBase, tintCard } from '../panel-style'
import {
  AddButton,
  Choice,
  JsonInput,
  Section,
  Segmented,
  Setting,
  TextInput,
  useInspectorEnv
} from './kit'
import { bindingValue, withStaticBinding } from './model'

export const HEADER_FORMATS = [
  { value: 'text', label: 'Text' },
  { value: 'currency', label: 'Currency ($)' },
  { value: 'integer', label: 'Whole number' },
  { value: 'decimal', label: 'Decimal' },
  { value: 'percent', label: 'Percent' },
  { value: 'date', label: 'Date' },
  { value: 'datetime', label: 'Date & time' }
]

export const COLORS = [
  { value: '', label: 'Default' },
  { value: 'cyan', label: 'Cyan' },
  { value: 'blue', label: 'Blue' },
  { value: 'green', label: 'Green' },
  { value: 'amber', label: 'Amber' },
  { value: 'red', label: 'Red' },
  { value: 'purple', label: 'Purple' }
]

export const WEIGHTS = [
  { value: '', label: 'Normal' },
  { value: 'medium', label: 'Medium' },
  { value: 'semibold', label: 'Semibold' },
  { value: 'bold', label: 'Bold' }
]

export const DISPLAY_AS = [
  { value: '', label: 'Text' },
  { value: 'pill', label: 'Pill' },
  { value: 'tag', label: 'Tag' }
]

const THRESHOLD_OPS = new Set(['lt', 'lte', 'gt', 'gte', 'eq'])

function checkThresholds(v: unknown): string | null {
  if (!Array.isArray(v)) return 'Needs a list like [{ "op": "gt", "value": 0, "color": "red" }]'
  for (const t of v) {
    const o = t as { op?: string; value?: unknown; color?: string }
    if (!o || !THRESHOLD_OPS.has(o.op ?? '') || o.value == null || !o.color)
      return 'Each needs op (lt, lte, gt, gte, eq), value and color'
  }
  return null
}

const str = (v: unknown) => (typeof v === 'string' ? v : '')

const THRESHOLD_OP_OPTIONS = [
  { value: 'lt', label: 'is below' },
  { value: 'lte', label: 'is at most' },
  { value: 'gt', label: 'is above' },
  { value: 'gte', label: 'is at least' },
  { value: 'eq', label: 'equals' }
]

interface ThresholdRow {
  op: string
  value: string
  color: string
}

const rowsOf = (v: unknown): ThresholdRow[] =>
  Array.isArray(v)
    ? v.map((t) => {
        const o = (t ?? {}) as { op?: string; value?: unknown; color?: string }
        return {
          op: o.op ?? 'gt',
          value: o.value == null ? '' : String(o.value),
          color: o.color ?? ''
        }
      })
    : []

/** Rows with op, value and colour; numbers stay numbers. */
const rulesOf = (rows: ThresholdRow[]) =>
  rows
    .filter((r) => THRESHOLD_OPS.has(r.op) && r.value.trim() !== '' && r.color)
    .map((r) => ({
      op: r.op,
      value: Number.isNaN(Number(r.value)) ? r.value : Number(r.value),
      color: r.color
    }))

/**
 * "Colour by value" as rules: when the value is above 0, show it red. Half
 * filled rules stay here until complete; raw JSON is folded underneath.
 */
function ThresholdEditor({
  value,
  onChange
}: {
  value: unknown
  onChange: (rules: unknown[] | null) => void
}) {
  const stored = JSON.stringify(rulesOf(rowsOf(value)))
  const [rows, setRows] = useState<ThresholdRow[]>(() => rowsOf(value))
  // Someone else's change (undo, JSON below): adopt it; our own echo keeps half rows.
  useEffect(() => {
    setRows((cur) =>
      JSON.stringify(rulesOf(cur)) === stored ? cur : rowsOf(JSON.parse(stored) as unknown)
    )
  }, [stored])
  const commit = (next: ThresholdRow[]) => {
    setRows(next)
    const rules = rulesOf(next)
    if (JSON.stringify(rules) !== stored) onChange(rules.length ? rules : null)
  }
  const set = (i: number, patch: Partial<ThresholdRow>) =>
    commit(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)))
  return (
    <div className='space-y-2'>
      {rows.length === 0 ? (
        <p className={effectText}>No rules: the value keeps the colour above.</p>
      ) : (
        <ul className='space-y-2'>
          {rows.map((r, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rules are positional
            <li key={i} className={cn(tintCard, 'space-y-1.5 p-2.5')} data-threshold-row=''>
              <div className='flex items-center gap-1.5'>
                <span className={cn(effectText, 'shrink-0')}>When it</span>
                <div className='min-w-0 flex-1'>
                  <Choice
                    ariaLabel='Comparison'
                    value={r.op}
                    options={THRESHOLD_OP_OPTIONS}
                    onChange={(op) => set(i, { op })}
                  />
                </div>
                <button
                  type='button'
                  aria-label='Remove rule'
                  data-tip='Remove rule'
                  onClick={() => commit(rows.filter((_, j) => j !== i))}
                  className='inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-slate-500 transition-colors hover:bg-slate-100 hover:text-red-600 dark:hover:bg-muted dark:hover:text-red-400'
                >
                  <X className='h-3.5 w-3.5' />
                </button>
              </div>
              <div className='flex items-center gap-1.5'>
                <input
                  aria-label='Value'
                  value={r.value}
                  placeholder='0'
                  onChange={(e) => set(i, { value: e.target.value })}
                  className={cn(inputBase, 'w-24 shrink-0')}
                />
                <span className={cn(effectText, 'shrink-0')}>show it</span>
                <div className='min-w-0 flex-1'>
                  <Choice
                    ariaLabel='Colour'
                    value={r.color}
                    options={[{ value: '', label: 'Pick a colour…' }, ...COLORS.slice(1)]}
                    onChange={(color) => set(i, { color })}
                  />
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      <AddButton onClick={() => setRows([...rows, { op: 'gt', value: '', color: '' }])}>
        + Add a colour rule
      </AddButton>
      <Section title='Edit as JSON' collapsible className='border-t-0 pt-1'>
        <JsonInput
          ariaLabel='Colour by value as JSON'
          rows={3}
          value={stored === '[]' ? null : (JSON.parse(stored) as unknown)}
          placeholder='[{ "op": "gt", "value": 0, "color": "red" }]'
          validate={checkThresholds}
          onCommit={(v) => onChange(Array.isArray(v) && v.length ? v : null)}
        />
      </Section>
    </div>
  )
}

/** A field in the header strip (group `__header__`): label + how its value reads. */
export function HeaderItemInspector({ row, label }: { row: PlacementRow; label: string }) {
  const env = useInspectorEnv()
  const at = { field: row.field, group_key: row.group_key }
  const setMeta = (key: string, value: unknown, l: string, text?: boolean) =>
    env.apply(
      [
        {
          op: 'update_placement',
          at,
          patch: { input_bindings: withStaticBinding(row, key, value) }
        }
      ],
      { label: l, text }
    )
  const threshold = (() => {
    const raw = bindingValue(row, '__threshold__')
    if (typeof raw !== 'string') return raw ?? null
    try {
      return JSON.parse(raw) as unknown
    } catch {
      return null
    }
  })()

  return (
    <div className='space-y-5'>
      <Setting k='header.label_override' label='Label' effect={`Empty uses "${label}".`}>
        <TextInput
          ariaLabel='Label'
          value={row.label_override ?? ''}
          placeholder={label}
          onChange={(v) =>
            env.apply([{ op: 'update_placement', at, patch: { label_override: v || null } }], {
              label: `Rename ${label} in the header`,
              text: true
            })
          }
        />
      </Setting>
      <Setting
        k='header.display_format'
        label='Format'
        effect='How the value is written in the header.'
      >
        <Choice
          ariaLabel='Format'
          value={str(bindingValue(row, '__display_format__')) || 'text'}
          options={HEADER_FORMATS}
          onChange={(v) =>
            setMeta('__display_format__', v === 'text' ? null : v, `Change the format of ${label}`)
          }
        />
      </Setting>
      <Setting k='header.color' label='Colour' effect='The colour of the value in the header.'>
        <Choice
          ariaLabel='Colour'
          value={str(bindingValue(row, '__color__'))}
          options={COLORS}
          onChange={(v) => setMeta('__color__', v || null, `Change the colour of ${label}`)}
        />
      </Setting>
      <Setting k='header.weight' label='Weight' effect='How bold the value is.'>
        <Segmented
          value={str(bindingValue(row, '__weight__'))}
          options={WEIGHTS}
          onChange={(v) => setMeta('__weight__', v || null, `Change the weight of ${label}`)}
        />
      </Setting>
      <Setting
        k='header.display_as'
        label='Shown as'
        effect='Plain text, a coloured pill or a tag.'
      >
        <Segmented
          value={str(bindingValue(row, '__display_as__'))}
          options={DISPLAY_AS}
          onChange={(v) => setMeta('__display_as__', v || null, `Change how ${label} shows`)}
        />
      </Setting>
      <Setting
        k='header.link_template'
        label='Link'
        effect='Makes the value a link. {{value}} and any {{field}} are filled in.'
      >
        <TextInput
          ariaLabel='Link'
          mono
          value={str(bindingValue(row, '__link_template__'))}
          placeholder='https://…/{{value}}'
          onChange={(v) =>
            setMeta('__link_template__', v || null, `Change the link of ${label}`, true)
          }
        />
      </Setting>
      <Setting
        k='header.threshold'
        label='Colour by value'
        effect='The first rule that matches picks the colour.'
      >
        <ThresholdEditor
          value={threshold}
          onChange={(v) =>
            setMeta(
              '__threshold__',
              v == null ? null : JSON.stringify(v),
              `Change the colours of ${label}`
            )
          }
        />
      </Setting>
    </div>
  )
}
