import { useQuery } from '@tanstack/react-query'
import { useNivaroClient } from '../../../context'
import { get } from '../../../lib/commands'
import { cn, titleCase } from '../../../lib/utils'
import { FieldDefaultValueControl } from '../editors/field-default-value'
import { PipelineStateConditionRow, RoleConditionRow } from '../editors/lock-conditions'
import { tintCard } from '../panel-style'
import { useFieldCtx } from './field-context'
import { AddButton, Choice, Section, Segmented, Setting, TextInput, Toggle } from './kit'
import {
  asObject,
  defaultValuesOf,
  type LockCondition,
  layoutGrids,
  lockConditionsColumn,
  lockConditionsOf,
  withDefaultValue
} from './model'

const ALIAS_IFACES = new Set([
  'inline-table',
  'inline-grid',
  'list-o2m',
  'list-m2m',
  'list-o2m-tree-view',
  'm2m',
  'o2m',
  'relation-path'
])

type ChildField = { field: string; label?: string | null; type?: string; hidden?: boolean }

/** GET /field-config/:collection (rows of that collection's fields). */
export function useFieldRows(collection: string | null | undefined, layoutId?: number | null) {
  const client = useNivaroClient()
  return useQuery<ChildField[]>({
    queryKey: ['layout-editor', 'field-rows', collection, layoutId ?? null],
    queryFn: () =>
      client
        .request<{ data: ChildField[] }>(
          get(`/field-config/${collection}`, layoutId ? { layout_id: layoutId } : undefined)
        )
        .then((r) => (Array.isArray(r.data) ? r.data : [])),
    enabled: !!collection,
    staleTime: 60_000
  })
}

export function RulesTab() {
  const ctx = useFieldCtx()
  const { info, ov, opts, env, row } = ctx
  const name = info.label
  const layout = env.bundle.layout
  const special = row.field.startsWith('__') || info.isPath

  // Lock conditions (assignment column)
  const locks = lockConditionsOf(row)
  const setLocks = (next: LockCondition[], label: string) =>
    ctx.setPlacement({ lock_conditions: lockConditionsColumn(next) }, label)
  const setLock = (i: number, patch: Partial<LockCondition>, label: string) =>
    setLocks(
      locks.map((c, j) => (j === i ? { ...c, ...patch } : c)),
      label
    )

  // Apply to lines
  const grids = layoutGrids(env.bundle, ctx.globals, ctx.relations)
  const atlQualifies =
    !special &&
    info.relKind !== 'M2M' &&
    info.relKind !== 'O2M' &&
    !ALIAS_IFACES.has(info.iface ?? '') &&
    grids.length > 0
  const atl = asObject(ov.apply_to_lines) as { grid?: string; target?: string; label?: string }
  const atlGrid = grids.find((g) => g.field === atl.grid) ?? null
  const { data: atlChildFields = [] } = useFieldRows(atlQualifies ? atlGrid?.childCollection : null)
  const atlTargets = atlChildFields.filter(
    (f) =>
      f.field !== 'id' &&
      !f.field.startsWith('__') &&
      !f.field.includes('.') &&
      !['alias', 'o2m', 'm2m'].includes(f.type ?? '')
  )
  const setAtl = (next: { grid?: string; target?: string; label?: string } | null, label: string) =>
    ctx.setOverride('apply_to_lines', next ?? undefined, label)

  const defaults = defaultValuesOf(layout)
  const maxValues = typeof opts.max_values === 'number' ? opts.max_values : null

  return (
    <div className='space-y-5'>
      <Toggle
        k='field.required'
        label='Required'
        effect='The form will not save without a value.'
        checked={ov.required === true}
        onChange={(v) =>
          ctx.setOverride(
            'required',
            v ? true : undefined,
            v ? `Make ${name} required` : `Make ${name} optional`
          )
        }
      />
      <Toggle
        k='field.readonly'
        label='Read-only'
        effect='Shown but not editable on this form.'
        checked={ov.readonly === true}
        onChange={(v) =>
          ctx.setOverride(
            'readonly',
            v ? true : undefined,
            v ? `Make ${name} read-only` : `Make ${name} editable`
          )
        }
      />
      {(info.computedType === 'rollup' || info.computedType === 'write') && (
        <Toggle
          k='field.editable_computed'
          label='Allow manual entry'
          effect='Lets people type over the calculated value here; the next recalculation still overwrites it.'
          checked={ov.editable_computed === true}
          onChange={(v) =>
            ctx.setOverride(
              'editable_computed',
              v ? true : undefined,
              v ? `Allow typing into ${name}` : `Keep ${name} calculated only`
            )
          }
        />
      )}

      <Setting
        k='field.lock_conditions'
        label='Read-only when'
        effect='Locks the field while any of these holds. No conditions: always editable.'
      >
        <div className='space-y-2'>
          {locks.map((c, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: conditions are positional
              key={i}
              className={cn(tintCard, 'space-y-3 p-3')}
            >
              <div className='flex items-center gap-1.5'>
                <div className='flex-1' data-setting='field.lock_conditions.type'>
                  <Segmented
                    value={c.type}
                    options={[
                      { value: 'pipeline_state', label: 'Pipeline state' },
                      { value: 'role', label: 'Role' }
                    ]}
                    onChange={(t) =>
                      setLocks(
                        locks.map((x, j) =>
                          j === i
                            ? t === 'role'
                              ? { type: 'role', role_ids: [] }
                              : { type: 'pipeline_state', state_keys: [] }
                            : x
                        ),
                        `Change a lock condition of ${name}`
                      )
                    }
                  />
                </div>
                <button
                  type='button'
                  aria-label='Remove condition'
                  onClick={() =>
                    setLocks(
                      locks.filter((_, j) => j !== i),
                      `Remove a lock condition from ${name}`
                    )
                  }
                  className='shrink-0 px-1 text-[12px] text-slate-400 hover:text-red-500'
                >
                  ✕
                </button>
              </div>
              {c.type === 'role' ? (
                <div data-setting='field.lock_conditions.role_ids'>
                  <RoleConditionRow
                    roleIds={c.role_ids ?? []}
                    onRoleIdsChange={(ids) =>
                      setLock(i, { role_ids: ids }, `Change the roles that lock ${name}`)
                    }
                  />
                </div>
              ) : (
                <PipelineStateConditionRow
                  collection={env.collection}
                  pipelineId={c.pipeline_id}
                  stateKeys={c.state_keys ?? []}
                  onPipelineChange={(id) =>
                    setLock(
                      i,
                      { pipeline_id: id, state_keys: [] },
                      `Change the pipeline that locks ${name}`
                    )
                  }
                  onStateKeysChange={(keys) =>
                    setLock(i, { state_keys: keys }, `Change the states that lock ${name}`)
                  }
                />
              )}
            </div>
          ))}
          <AddButton
            onClick={() =>
              setLocks(
                [...locks, { type: 'pipeline_state', state_keys: [] }],
                `Add a lock condition to ${name}`
              )
            }
          >
            + Add condition
          </AddButton>
        </div>
      </Setting>

      {!special && info.relKind !== 'O2M' && (
        <Setting
          k='field.default_value'
          label='Default for new records'
          effect='Filled in when someone creates a record on this form.'
        >
          <div onBlurCapture={() => env.flush()}>
            <FieldDefaultValueControl
              value={defaults[row.field]}
              onChange={(v, typing) =>
                env.apply(
                  [
                    {
                      op: 'layout_update',
                      patch: { default_values: withDefaultValue(layout, row.field, v) }
                    }
                  ],
                  { label: `Change the default of ${name}`, text: typing }
                )
              }
              isM2O={info.relKind === 'M2O'}
              isM2M={info.relKind === 'M2M'}
              relatedCollection={info.relatedCollection}
              settings={{ options: ctx.globalOptions, interface: info.iface }}
              abstractType={info.type}
            />
          </div>
        </Setting>
      )}

      {info.relKind === 'M2M' && (
        <Section title='How many'>
          <Setting
            k='field.max_values'
            label='Most values'
            effect='Empty: no limit. 1 makes it a single pick.'
          >
            <TextInput
              type='number'
              ariaLabel='Most values'
              value={maxValues == null ? '' : String(maxValues)}
              placeholder='No limit'
              onChange={(v) => {
                const n = v === '' ? undefined : Math.max(1, Math.round(Number(v)))
                if (n !== undefined && Number.isNaN(n)) return
                ctx.setOption('max_values', n, `Limit how many ${name} can be picked`, true)
              }}
            />
          </Setting>
          {maxValues != null && (
            <Toggle
              k='field.max_values_enforce_on_write'
              label='Refuse more on the server too'
              effect='Imports, the API and other forms cannot store more than the limit.'
              enforced
              checked={opts.enforce_on_write === true}
              onChange={(v) =>
                ctx.setOption(
                  'enforce_on_write',
                  v ? true : undefined,
                  v
                    ? `Enforce the limit of ${name} on the server`
                    : `Stop enforcing the limit of ${name}`
                )
              }
            />
          )}
        </Section>
      )}

      {atlQualifies && (
        <Section title='Apply to lines'>
          <p className='text-[12px] leading-snug text-slate-500 dark:text-muted-foreground'>
            A button beside the field copies its value into one column of every line of a grid.
          </p>
          <Setting
            k='field.apply_to_lines.grid'
            label='Grid'
            effect='The grid whose lines get the value.'
          >
            <Choice
              ariaLabel='Grid'
              value={atl.grid ?? ''}
              options={[
                { value: '', label: 'Off' },
                ...grids.map((g) => ({ value: g.field, label: g.label }))
              ]}
              onChange={(v) =>
                setAtl(
                  v ? { grid: v, target: '', ...(atl.label ? { label: atl.label } : {}) } : null,
                  v ? `Copy ${name} into lines` : `Stop copying ${name} into lines`
                )
              }
            />
          </Setting>
          <Setting
            k='field.apply_to_lines.target'
            label='Column'
            effect='The column of each line that receives the value.'
          >
            <Choice
              ariaLabel='Column'
              disabled={!atl.grid}
              value={atl.target ?? ''}
              options={[
                { value: '', label: atl.grid ? 'Pick a column…' : 'Pick a grid first' },
                ...atlTargets.map((f) => ({ value: f.field, label: f.label || titleCase(f.field) }))
              ]}
              onChange={(v) => setAtl({ ...atl, target: v }, `Copy ${name} into a column`)}
            />
          </Setting>
          <Setting
            k='field.apply_to_lines.label'
            label='Button label'
            effect='The words on the button.'
          >
            <TextInput
              ariaLabel='Button label'
              disabled={!atl.grid}
              value={atl.label ?? ''}
              placeholder='Apply to lines'
              onChange={(v) => {
                const { label: _old, ...rest } = atl
                ctx.setOverride(
                  'apply_to_lines',
                  v ? { ...rest, label: v } : rest,
                  `Rename the apply-to-lines button of ${name}`,
                  true
                )
              }}
            />
          </Setting>
        </Section>
      )}

      {env.layoutType === 'addendum' && (
        <Toggle
          k='field.prefill_from_parent'
          label='Prefill from the record'
          effect="A new addendum starts with the record's current value."
          checked={ov.prefill_from_parent !== false}
          onChange={(v) =>
            ctx.setOverride(
              'prefill_from_parent',
              v ? undefined : false,
              v ? `Prefill ${name} from the record` : `Start ${name} empty on addendums`
            )
          }
        />
      )}
    </div>
  )
}
