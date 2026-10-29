import { X } from 'lucide-react'
import { useMemo } from 'react'
import { validateExpression } from '../../../lib/expression'
import {
  confirmChangeOf,
  counterOf,
  type DisplayFormat,
  displayFormulaOf,
  type TextRule,
  textRulesOf
} from '../../../lib/placement-behaviour'
import { cn } from '../../../lib/utils'
import { PipelineStateConditionRow, RoleConditionRow } from '../editors/lock-conditions'
import { columnOf, useColumnFacts } from '../inspect/inspect-api'
import { effectText, tintCard } from '../panel-style'
import { isRelational } from './applies'
import { useFieldCtx } from './field-context'
import {
  AddButton,
  DraftInput,
  Segmented,
  Setting,
  TextArea,
  TextInput,
  Toggle,
  useInspectorEnv
} from './kit'
import type { FieldInfo, Obj } from './model'

// Placement behaviour settings (#2703 #2704 #2705 #2706 #2709 #2712): what a
// field does on a live record, stored in the placement's overrides. The
// record page reads them through lib/placement-behaviour.ts.

const removeBtn =
  'rounded p-0.5 text-slate-400 transition-colors hover:bg-muted hover:text-slate-700 dark:hover:text-foreground'

/** Typed text a person enters (long text included) — not relations, numbers or computed values. */
export function takesText(info: Pick<FieldInfo, 'type' | 'relKind' | 'isPath' | 'iface'>) {
  if (isRelational(info)) return false
  const iface = info.iface ?? ''
  return (
    ['string', 'text', 'richtext', 'rich_text', 'markdown', 'wysiwyg'].includes(info.type) ||
    /textarea|rich|wysiwyg|markdown/i.test(iface)
  )
}

/**
 * A field a person types or picks a value into (the field's own column).
 * `allowM2M` also lets a many-to-many picker through: its id list is a value
 * the person picks (O2M lists, aliases, paths and computed fields stay out).
 */
function takesValue(info: FieldInfo, field: string, opts: { allowM2M?: boolean } = {}) {
  const m2m = opts.allowM2M === true && info.relKind === 'M2M'
  return (
    !field.startsWith('__') &&
    !info.isPath &&
    (m2m || (info.type !== 'alias' && info.relKind !== 'M2M')) &&
    info.relKind !== 'O2M' &&
    info.computedType !== 'virtual' &&
    info.computedType !== 'read'
  )
}

// ── #2703 Label and help by state or role (Look tab) ─────────────────────────

export function TextRulesSetting() {
  const ctx = useFieldCtx()
  const { ov, info, env, row } = ctx
  const name = info.label
  const rules = textRulesOf(ov)
  const save = (next: TextRule[], label: string, text?: boolean) =>
    ctx.setOverride('text_rules', next.length ? next : undefined, label, text)
  const update = (i: number, patch: Partial<TextRule>, label: string, text?: boolean) =>
    save(
      rules.map((r, j) => (j === i ? { ...r, ...patch } : r)),
      label,
      text
    )
  if (row.field.startsWith('__')) return null
  return (
    <Setting
      k='field.text_rules'
      label='Label and help by state or role'
      effect='Different words in a workflow state or for a role: “Requested date” becomes “Delivered date” once Completed. The first rule that matches wins; the record page, read view and PDF follow it.'
    >
      {rules.map((r, i) => (
        <div
          // biome-ignore lint/suspicious/noArrayIndexKey: rules have no id; order is their identity
          key={i}
          data-text-rule={i}
          className={cn(tintCard, 'space-y-2 px-2.5 py-2')}
        >
          <div className='flex items-center gap-2'>
            <div className='flex-1'>
              <Segmented
                value={r.type}
                options={[
                  { value: 'pipeline_state', label: 'In a state' },
                  { value: 'role', label: 'For a role' }
                ]}
                onChange={(v) =>
                  update(
                    i,
                    v === 'role'
                      ? {
                          type: 'role',
                          role_ids: [],
                          state_keys: undefined,
                          pipeline_id: undefined
                        }
                      : { type: 'pipeline_state', state_keys: [], role_ids: undefined },
                    `Change when ${name} reads differently`
                  )
                }
              />
            </div>
            <button
              type='button'
              aria-label='Remove this rule'
              data-tip='Remove this rule'
              className={removeBtn}
              onClick={() =>
                save(
                  rules.filter((_, j) => j !== i),
                  `Remove a label rule from ${name}`
                )
              }
            >
              <X className='h-3.5 w-3.5' />
            </button>
          </div>
          {r.type === 'role' ? (
            <RoleConditionRow
              roleIds={r.role_ids ?? []}
              onRoleIdsChange={(ids) =>
                update(i, { role_ids: ids }, `Change the roles for ${name}`)
              }
            />
          ) : (
            <PipelineStateConditionRow
              collection={env.collection}
              pipelineId={r.pipeline_id}
              stateKeys={r.state_keys ?? []}
              onPipelineChange={(id) =>
                update(i, { pipeline_id: id, state_keys: [] }, `Change the pipeline for ${name}`)
              }
              onStateKeysChange={(keys) =>
                update(i, { state_keys: keys }, `Change the states for ${name}`)
              }
            />
          )}
          <TextInput
            ariaLabel='Label in this case'
            value={r.label ?? ''}
            placeholder={`Label (${name})`}
            onChange={(v) =>
              update(i, { label: v || undefined }, `Change a label rule of ${name}`, true)
            }
          />
          <TextInput
            ariaLabel='Help text in this case'
            value={r.note ?? ''}
            placeholder='Help text (unchanged when empty)'
            onChange={(v) =>
              update(i, { note: v || undefined }, `Change a help rule of ${name}`, true)
            }
          />
        </div>
      ))}
      <AddButton
        onClick={() =>
          save(
            [...rules, { type: 'pipeline_state', state_keys: [] }],
            `Add a label rule to ${name}`
          )
        }
      >
        + Add a rule
      </AddButton>
    </Setting>
  )
}

// ── #2709 Counter (Look tab) ─────────────────────────────────────────────────

export function CounterSetting() {
  const ctx = useFieldCtx()
  const { ov, info, env, row } = ctx
  const { data: facts } = useColumnFacts(env.collection)
  const column = columnOf(facts, row.field)
  if (!takesText(info) || row.field.startsWith('__')) return null
  const name = info.label
  const cfg = counterOf(ov)
  const columnSize = column?.max_length != null && column.max_length > 0 ? column.max_length : null
  const write = (
    next: { unit?: string; limit?: number } | undefined,
    label: string,
    text?: boolean
  ) => ctx.setOverride('counter', next, label, text)
  return (
    <div data-setting='field.counter' className='space-y-3'>
      <Toggle
        k='field.counter.on'
        label='Counter and limit'
        effect={
          columnSize
            ? `Counts as people type. The limit starts at the column size (${columnSize.toLocaleString()} characters); past it the form will not save.`
            : 'Counts as people type; past a limit the form will not save.'
        }
        checked={!!cfg}
        onChange={(v) =>
          write(
            v ? { unit: 'characters', ...(columnSize ? { limit: columnSize } : {}) } : undefined,
            v ? `Count the characters of ${name}` : `Stop counting ${name}`
          )
        }
      />
      {cfg && (
        <>
          <Setting k='field.counter.unit' label='Count' effect='Characters or words.'>
            <Segmented
              value={cfg.unit}
              options={[
                { value: 'characters', label: 'Characters' },
                { value: 'words', label: 'Words' }
              ]}
              onChange={(v) =>
                write(
                  {
                    unit: v,
                    ...(v === 'words'
                      ? {}
                      : cfg.limit != null
                        ? { limit: cfg.limit }
                        : columnSize
                          ? { limit: columnSize }
                          : {})
                  },
                  `Count the ${v} of ${name}`
                )
              }
            />
          </Setting>
          <Setting
            k='field.counter.limit'
            label='Limit'
            effect={
              cfg.unit === 'words'
                ? 'Most words allowed. Empty counts without a limit.'
                : `Most characters allowed. Empty counts without a limit${columnSize ? `; the column holds ${columnSize.toLocaleString()}` : ''}.`
            }
          >
            <TextInput
              type='number'
              ariaLabel='Limit'
              value={cfg.limit == null ? '' : String(cfg.limit)}
              placeholder={
                cfg.unit === 'characters' && columnSize ? String(columnSize) : 'No limit'
              }
              onChange={(v) => {
                const n = v === '' ? undefined : Math.max(1, Math.floor(Number(v)))
                if (n !== undefined && !Number.isFinite(n)) return
                write(
                  { unit: cfg.unit, ...(n ? { limit: n } : {}) },
                  `Set the limit of ${name}`,
                  true
                )
              }}
            />
          </Setting>
        </>
      )}
    </div>
  )
}

// ── #2704 #2705 #2706 (Rules tab) ────────────────────────────────────────────

export function RecommendedToggle() {
  const ctx = useFieldCtx()
  const { ov, info, row } = ctx
  if (row.field.startsWith('__')) return null
  const required =
    ov.required === true ||
    (ov.required === undefined && !!(info.global as { required?: unknown } | null)?.required)
  return (
    <Toggle
      k='field.recommended'
      label='Recommended'
      effect={
        required
          ? 'Required already wins; switch Required off to make this a recommendation.'
          : 'An amber marker and a reminder on save listing what is still empty. Saving is never blocked.'
      }
      checked={ov.recommended === true && !required}
      disabled={required}
      onChange={(v) =>
        ctx.setOverride(
          'recommended',
          v ? true : undefined,
          v ? `Recommend ${info.label}` : `Stop recommending ${info.label}`
        )
      }
    />
  )
}

export function ConfirmChangeSetting() {
  const ctx = useFieldCtx()
  const { ov, info, env, row } = ctx
  if (!takesValue(info, row.field)) return null
  const name = info.label
  const cfg = confirmChangeOf(ov)
  const raw = (
    ov.confirm_change && typeof ov.confirm_change === 'object' ? ov.confirm_change : {}
  ) as Obj
  const pipelineId = typeof raw.pipeline_id === 'string' ? raw.pipeline_id : undefined
  const write = (next: Obj | undefined, label: string) =>
    ctx.setOverride('confirm_change', next, label)
  return (
    <div data-setting='field.confirm_change' className='space-y-3'>
      <Toggle
        k='field.confirm_change.on'
        label='Confirm changes on saved records'
        effect='Changing it on an existing record asks “Are you sure?” and a short reason, kept with the change in the history. New records are not asked.'
        checked={!!cfg}
        onChange={(v) =>
          write(
            v ? { state_keys: [] } : undefined,
            v ? `Confirm changes to ${name}` : `Stop confirming changes to ${name}`
          )
        }
      />
      {cfg && (
        <Setting
          k='field.confirm_change.states'
          label='Only in these states'
          effect={
            cfg.state_keys.length
              ? 'Asked only while the record is in a ticked state.'
              : 'No state ticked: asked in every state.'
          }
        >
          <PipelineStateConditionRow
            collection={env.collection}
            pipelineId={pipelineId}
            stateKeys={cfg.state_keys}
            onPipelineChange={(id) =>
              write(
                { ...(id ? { pipeline_id: id } : {}), state_keys: [] },
                `Change the pipeline that confirms ${name}`
              )
            }
            onStateKeysChange={(keys) =>
              write(
                { ...(pipelineId ? { pipeline_id: pipelineId } : {}), state_keys: keys },
                `Change the states that confirm ${name}`
              )
            }
          />
        </Setting>
      )}
    </div>
  )
}

export function RepeatLastToggle() {
  const ctx = useFieldCtx()
  const { ov, info, row } = ctx
  if (!takesValue(info, row.field) || info.computedType) return null
  return (
    <Toggle
      k='field.repeat_last'
      label='Repeat last value'
      effect='A “Repeat last” button beside the label fills in what this person entered on their previous record here.'
      checked={ov.repeat_last === true}
      onChange={(v) =>
        ctx.setOverride(
          'repeat_last',
          v ? true : undefined,
          v ? `Offer to repeat the last ${info.label}` : `Stop offering to repeat ${info.label}`
        )
      }
    />
  )
}

/** Lets people save their own starting value for this field on new records. */
export function PersonalDefaultToggle() {
  const ctx = useFieldCtx()
  const { ov, info, row } = ctx
  if (!takesValue(info, row.field, { allowM2M: true }) || info.computedType) return null
  return (
    <Toggle
      k='field.personal_default'
      label='Personal default'
      effect='On this form, people can save their own starting value for this field, and new records start with it.'
      checked={ov.personal_default === true}
      onChange={(v) =>
        ctx.setOverride(
          'personal_default',
          v ? true : undefined,
          v
            ? `Allow personal defaults for ${info.label}`
            : `Stop personal defaults for ${info.label}`
        )
      }
    />
  )
}

/** Under Personal default: whether people manage it right on the form, or only on their
 *  profile (My defaults). On by default — the form's Make default control. */
export function PersonalDefaultInlineToggle() {
  const ctx = useFieldCtx()
  const { ov, info } = ctx
  if (ov.personal_default !== true) return null
  return (
    <Toggle
      k='field.personal_default_inline'
      label='Make default on the form'
      effect='People can save, update and clear their default right beside this field. Off: they manage it only on their profile (My defaults); the form still fills it in.'
      checked={ov.personal_default_inline !== false}
      onChange={(v) =>
        ctx.setOverride(
          'personal_default_inline',
          v ? undefined : false,
          v
            ? `Offer Make default on the form for ${info.label}`
            : `Keep ${info.label}'s default to the profile`
        )
      }
    />
  )
}

// ── #2712 Display formula (its own inspector) ────────────────────────────────

const FORMAT_OPTIONS: Array<{ value: DisplayFormat; label: string }> = [
  { value: '', label: 'Plain' },
  { value: 'integer', label: 'Whole' },
  { value: 'number', label: 'Decimal' },
  { value: 'currency', label: 'Money' },
  { value: 'percent', label: 'Percent' }
]

/** Label, expression and format of a `__calc_<n>__` placement. */
export function DisplayFormulaSettings({
  row,
  fields
}: {
  row: { field: string; group_key: string | null; overrides: unknown }
  /** The collection's field keys, for the unknown-field check. */
  fields: string[]
}) {
  const env = useInspectorEnv()
  const ov = useMemo(() => {
    const raw = row.overrides
    if (typeof raw === 'string') {
      try {
        return (JSON.parse(raw) ?? {}) as Obj
      } catch {
        return {} as Obj
      }
    }
    return (raw && typeof raw === 'object' ? raw : {}) as Obj
  }, [row.overrides])
  const df = displayFormulaOf(ov) ?? { expr: '', format: '' as DisplayFormat, currency: null }
  const label = typeof ov.label === 'string' ? ov.label : ''
  const at = { field: row.field, group_key: row.group_key }
  const write = (patch: Obj, text: string, typing?: boolean) => {
    const next: Obj = { ...ov, ...patch }
    for (const k of Object.keys(next)) if (next[k] === undefined) delete next[k]
    env.apply([{ op: 'update_placement', at, patch: { overrides: next } }], {
      label: text,
      text: typing
    })
  }
  const check = df.expr.trim() ? validateExpression(df.expr, fields) : null
  const onForm = new Set(
    env.bundle.placements.filter((p) => !p.field.startsWith('__')).map((p) => p.field)
  )
  const offForm = check?.ok ? check.tokens.filter((t) => !onForm.has(t.split('.')[0])) : []
  return (
    <div className='space-y-5'>
      <Setting k='display_formula.label' label='Label' effect='What the form calls the value.'>
        <TextInput
          ariaLabel='Label'
          value={label}
          placeholder='Remaining'
          onChange={(v) => write({ label: v || undefined }, 'Rename the formula', true)}
        />
      </Setting>
      <Setting
        k='display_formula.expr'
        label='Formula'
        effect={
          <>
            Fields in double braces, for example{' '}
            <code className='font-mono text-[11.5px]'>{'{{budget}} - {{committed}}'}</code>. Worked
            out on the page from what is on the form; never saved.
          </>
        }
      >
        <TextArea
          ariaLabel='Formula'
          rows={3}
          mono
          value={df.expr}
          onChange={(v) =>
            write({ display_formula: { ...df, expr: v } }, 'Change the formula', true)
          }
        />
        {check && !check.ok && (
          <p
            role='alert'
            data-formula-error=''
            className='text-[12px] text-red-700 dark:text-red-300'
          >
            {check.error}
          </p>
        )}
        {check?.ok && check.unknownTokens.length > 0 && (
          <p data-formula-unknown='' className='text-[12px] text-amber-700 dark:text-amber-300'>
            Not fields of this collection:{' '}
            <span className='font-mono'>{check.unknownTokens.join(', ')}</span>
          </p>
        )}
        {check?.ok && !check.unknownTokens.length && offForm.length > 0 && (
          <p data-formula-offform='' className={effectText}>
            Not on this form, so they read as empty here:{' '}
            <span className='font-mono'>{offForm.join(', ')}</span>
          </p>
        )}
      </Setting>
      <Setting k='display_formula.format' label='Show as' effect='How the number is written.'>
        <Segmented
          value={df.format}
          options={FORMAT_OPTIONS}
          onChange={(v) =>
            write({ display_formula: { ...df, format: v } }, 'Change how the formula shows')
          }
        />
      </Setting>
      {df.format === 'currency' && (
        <Setting
          k='display_formula.currency'
          label='Currency'
          effect='Three-letter code, for example USD.'
        >
          <DraftInput
            ariaLabel='Currency'
            value={df.currency ?? ''}
            mono
            placeholder='USD'
            onCommit={(v) => {
              const code = v.trim().toUpperCase()
              if (code && !/^[A-Z]{3}$/.test(code)) return
              write(
                { display_formula: { ...df, currency: code || null } },
                'Change the currency of the formula',
                true
              )
            }}
          />
        </Setting>
      )}
    </div>
  )
}
