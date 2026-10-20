import { Plus, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { cn } from '../../../lib/utils'
import { choiceLabelsFrom, describeConditions } from '../overview/describe-conditions'
import { inputCls, PickList, quietText, Segmented } from '../settings/controls'
import {
  fieldLabel,
  isStoredField,
  parseFieldOptions,
  type SettingsField
} from '../settings/settings-api'
import {
  RECORD_RULE_OP_LABELS,
  RECORD_RULE_OPS,
  type RecordRule,
  type RecordRuleOp,
  type RecordRuleRow,
  rowsFromRules,
  rulesFromRows,
  sameJson
} from './layout-rows'

/**
 * "Show for matching records": a field / op / value rule list. Only the ops the
 * server's layout resolver evaluates (is, is not, has a value), field and choice
 * labels instead of keys, half-filled rows kept here until they are complete.
 * Raw JSON sits behind Advanced.
 */
export function RecordConditionsEditor({
  value,
  fields,
  onChange,
  onBlur
}: {
  /** Stored record_conditions (array or JSON text). */
  value: unknown
  fields: SettingsField[]
  /** `text` = a value being typed: the caller coalesces and sends after a pause or on blur. */
  onChange: (rules: RecordRule[] | null, opts: { text: boolean }) => void
  onBlur?: () => void
}) {
  const [rows, setRows] = useState<RecordRuleRow[]>(() => rowsFromRules(value))
  // Someone else's change (undo, another tab): adopt it. Our own echo matches the
  // complete rows we sent, so half-filled rows survive it.
  useEffect(() => {
    setRows((current) =>
      sameJson(rulesFromRows(current), value ?? null) ? current : rowsFromRules(value)
    )
  }, [value])

  const ruleFields = useMemo(() => fields.filter(isStoredField), [fields])
  const choiceLabels = useMemo(() => choiceLabelsFrom(fields), [fields])
  const fieldOptions = useMemo(
    () =>
      ruleFields
        .map((f) => ({ value: f.field, label: fieldLabel(fields, f.field), hint: f.field }))
        .sort((a, b) => a.label.localeCompare(b.label)),
    [ruleFields, fields]
  )

  const commit = (next: RecordRuleRow[], text = false) => {
    setRows(next)
    const rules = rulesFromRows(next)
    if (!sameJson(rules, value ?? null)) onChange(rules, { text })
  }
  const update = (i: number, patch: Partial<RecordRuleRow>, text = false) =>
    commit(
      rows.map((r, j) => (j === i ? { ...r, ...patch } : r)),
      text
    )

  const complete = rulesFromRows(rows)
  const sentence = describeConditions(complete, fields, choiceLabels)

  return (
    <div className='space-y-2' data-record-conditions>
      {rows.length === 0 ? (
        <p className={quietText}>No rules: records get this form only as the default or by role.</p>
      ) : (
        <ul className='space-y-1.5'>
          {rows.map((row, i) => {
            const meta = fields.find((f) => f.field === row.field)
            const choices = parseFieldOptions(meta?.options).choices
            const choiceList = Array.isArray(choices)
              ? (choices as Array<{ text?: unknown; value?: unknown }>)
                  .filter((c) => c && c.value != null)
                  .map((c) => ({
                    value: String(c.value),
                    label: choiceLabels[row.field]?.[String(c.value)] ?? String(c.text ?? c.value)
                  }))
              : null
            const isBool = meta?.type === 'boolean'
            return (
              <li
                // biome-ignore lint/suspicious/noArrayIndexKey: rows have no id; order is stable
                key={i}
                data-rule-row={i}
                className='flex flex-wrap items-center gap-1.5 rounded-md border border-slate-200 bg-white p-1.5 dark:border-border dark:bg-card'
              >
                <PickList
                  ariaLabel='Rule field'
                  value={row.field || null}
                  options={fieldOptions}
                  placeholder='Field…'
                  onChange={(v) => update(i, { field: v ?? '', value: '' })}
                  className='min-w-[150px] flex-1'
                />
                <Segmented<RecordRuleOp>
                  ariaLabel='Rule test'
                  value={row.op}
                  options={RECORD_RULE_OPS.map((op) => ({
                    value: op,
                    label: RECORD_RULE_OP_LABELS[op]
                  }))}
                  onChange={(op) => update(i, { op })}
                />
                {row.op !== 'nnull' &&
                  (choiceList && choiceList.length > 0 ? (
                    <PickList
                      ariaLabel='Rule value'
                      value={row.value || null}
                      options={choiceList}
                      placeholder='Value…'
                      onChange={(v) => update(i, { value: v ?? '' })}
                      className='min-w-[120px] flex-1'
                    />
                  ) : isBool ? (
                    <Segmented<string>
                      ariaLabel='Rule value'
                      value={row.value}
                      options={[
                        { value: 'true', label: 'Yes' },
                        { value: 'false', label: 'No' }
                      ]}
                      onChange={(v) => update(i, { value: v })}
                    />
                  ) : (
                    <input
                      aria-label='Rule value'
                      value={row.value}
                      onChange={(e) => update(i, { value: e.target.value }, true)}
                      onBlur={onBlur}
                      placeholder='Value…'
                      className={cn(inputCls, 'h-8 min-w-[120px] flex-1')}
                    />
                  ))}
                <button
                  type='button'
                  aria-label='Remove rule'
                  onClick={() => commit(rows.filter((_, j) => j !== i))}
                  className='ml-auto rounded p-1 text-slate-400 hover:bg-muted hover:text-[#9c2f47] dark:hover:text-[#f08aa1]'
                >
                  <Trash2 className='h-3.5 w-3.5' />
                </button>
              </li>
            )
          })}
        </ul>
      )}
      <div className='flex items-center justify-between gap-2'>
        <button
          type='button'
          onClick={() => setRows((r) => [...r, { field: '', op: 'eq', value: '' }])}
          className='inline-flex items-center gap-1 text-[12px] font-medium text-slate-600 hover:text-nvr-navy dark:text-muted-foreground dark:hover:text-nvr-cyan'
        >
          <Plus className='h-3.5 w-3.5' />
          Add rule
        </button>
        {rows.length > (complete?.length ?? 0) && (
          <span className={quietText}>Unfinished rules are not saved yet.</span>
        )}
      </div>
      {sentence.length > 0 && (
        <p className='text-[12px] text-slate-600 dark:text-muted-foreground' data-rule-sentence>
          Opens for records where{' '}
          {sentence.map((s, i) =>
            s.strong ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional
              <strong key={i} className='font-semibold text-slate-800 dark:text-foreground'>
                {s.text}
              </strong>
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: segments are positional
              <span key={i}>{s.text}</span>
            )
          )}
          .
        </p>
      )}
      <AdvancedJson
        value={complete}
        validate={validateRules}
        onApply={(rules) => onChange(rules as RecordRule[] | null, { text: false })}
      />
    </div>
  )
}

function validateRules(v: unknown): string | null {
  if (v === null) return null
  if (!Array.isArray(v)) return 'Must be a list of rules, or null.'
  for (const [i, r] of v.entries()) {
    if (!r || typeof r !== 'object') return `Rule ${i + 1} must be an object.`
    const { field, op, value } = r as Record<string, unknown>
    if (typeof field !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(field))
      return `Rule ${i + 1} needs a field name.`
    if (!RECORD_RULE_OPS.includes(op as RecordRuleOp))
      return `Rule ${i + 1}: op must be eq, neq or nnull.`
    if (op !== 'nnull' && value === undefined) return `Rule ${i + 1} needs a value.`
  }
  return null
}

/** Raw JSON for the setting, behind a disclosure. Applies on blur when valid. */
export function AdvancedJson({
  value,
  validate,
  onApply,
  label = 'Advanced: edit as JSON'
}: {
  value: unknown
  validate: (v: unknown) => string | null
  onApply: (v: unknown) => void
  label?: string
}) {
  const shown = JSON.stringify(value ?? null, null, 2)
  const [text, setText] = useState(shown)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    setText(shown)
    setError(null)
  }, [shown])
  return (
    <details
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
      className='text-[12px]'
    >
      <summary className='cursor-pointer select-none text-slate-500 dark:text-muted-foreground'>
        {label}
      </summary>
      {open && (
        <div className='mt-1.5 space-y-1'>
          <textarea
            aria-label={label}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onBlur={() => {
              if (text === shown) return
              let parsed: unknown
              try {
                parsed = JSON.parse(text)
              } catch {
                setError('Not valid JSON. Nothing was saved.')
                return
              }
              const err = validate(parsed)
              if (err) return setError(`${err} Nothing was saved.`)
              setError(null)
              onApply(parsed)
            }}
            rows={Math.min(10, Math.max(3, text.split('\n').length))}
            className={cn(inputCls, 'h-auto py-1.5 font-mono text-[11.5px]')}
          />
          {error && <p className='text-[12px] text-[#9c2f47] dark:text-[#f08aa1]'>{error}</p>}
        </div>
      )}
    </details>
  )
}
