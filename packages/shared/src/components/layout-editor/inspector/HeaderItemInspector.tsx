import type { PlacementRow } from '../../../lib/layout-ops'
import { Choice, JsonInput, Segmented, Setting, TextInput, useInspectorEnv } from './kit'
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
    <div className='space-y-4'>
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
        <JsonInput
          ariaLabel='Colour by value'
          rows={3}
          value={threshold}
          placeholder='[{ "op": "gt", "value": 0, "color": "red" }]'
          validate={checkThresholds}
          onCommit={(v) =>
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
