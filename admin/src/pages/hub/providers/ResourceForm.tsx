import { ErrorNotice } from '@nivaro/shared'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Plus, RefreshCcw, X } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SimpleSelect } from '@/components/ui/simple-select'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'
import { HUB_MASK } from '../hub-api'
import { Field, ghostButton, SecretInput } from '../hub-parts'
import { ChangeView } from './ChangeView'
import {
  type ChangeModel,
  changeFromPlan,
  type FieldSpec,
  fetchResources,
  fieldDefault,
  fieldErrors,
  fieldsPayload,
  type HubResource,
  type PlanRequest,
  planChange,
  providerError,
  providerKeys,
  type ResourceScope,
  type ResourceTypeInfo,
  resourceName,
  valuesOf
} from './providers-api'

/**
 * The generic resource form: every field of a resource type drawn from its FieldSpec (string,
 * number, yes/no, choice, list, group, link to another resource, secret), then "Plan change" —
 * the engine reads the provider and answers the plan, shown in the change view below the form.
 * Nothing is written at the provider until the person starts the plan there.
 */

type Values = Record<string, unknown>

const inputClass = 'h-8 bg-white text-[13px] dark:bg-background'

/** The fields of one resource type, as a form. Errors are keyed by dotted path. */
export function ResourceFields({
  fields,
  values,
  onChange,
  mode,
  idPrefix,
  errors = {},
  refOptions,
  pathPrefix = ''
}: {
  fields: FieldSpec[]
  values: Values
  onChange: (next: Values) => void
  mode: 'create' | 'update'
  idPrefix: string
  errors?: Record<string, string>
  /** Resources a `ref` field of `refType` may point at. */
  refOptions: (refType: string) => HubResource[]
  pathPrefix?: string
}) {
  // Read-only fields are the provider's (an ARN, a URL): shown on the resource, never on the form.
  const shown = fields.filter((f) => !f.readOnly)
  return (
    <div className='grid grid-cols-1 gap-3 sm:grid-cols-2'>
      {shown.map((f) => {
        const path = `${pathPrefix}${f.key}`
        const id = `${idPrefix}-${path.replace(/\./g, '-')}`
        const locked = mode === 'update' && !!f.createOnly
        const wide = f.kind === 'list' || f.kind === 'object'
        const set = (v: unknown) => onChange({ ...values, [f.key]: v })
        const hint = fieldHint(f, locked)
        return (
          <div key={f.key} className={cn(wide && 'sm:col-span-2')}>
            {f.kind === 'object' ? (
              <fieldset className='m-0 min-w-0 rounded-md border border-slate-200 p-3 dark:border-border'>
                <legend className='px-1 text-[12px] font-medium text-slate-700 dark:text-foreground'>
                  {f.label}
                </legend>
                {hint && (
                  <p className='m-0 mb-2 text-[11px] text-slate-500 dark:text-muted-foreground'>
                    {hint}
                  </p>
                )}
                <ResourceFields
                  fields={f.fields ?? []}
                  values={(values[f.key] as Values | null) ?? {}}
                  onChange={set}
                  mode={mode}
                  idPrefix={idPrefix}
                  errors={errors}
                  refOptions={refOptions}
                  pathPrefix={`${path}.`}
                />
              </fieldset>
            ) : f.kind === 'list' ? (
              <ListField
                spec={f}
                id={id}
                path={path}
                value={Array.isArray(values[f.key]) ? (values[f.key] as unknown[]) : []}
                onChange={set}
                mode={mode}
                locked={locked}
                hint={hint}
                errors={errors}
                refOptions={refOptions}
                idPrefix={idPrefix}
              />
            ) : (
              <Field id={id} label={f.label} hint={hint} error={errors[path] ?? null}>
                <ScalarInput
                  spec={f}
                  id={id}
                  value={values[f.key]}
                  onChange={set}
                  disabled={locked}
                  refOptions={refOptions}
                />
              </Field>
            )}
          </div>
        )
      })}
    </div>
  )
}

function fieldHint(f: FieldSpec, locked: boolean): ReactNode {
  const parts: string[] = []
  if (f.help) parts.push(f.help)
  if (locked) parts.push('Set when it was created; it cannot change.')
  else if (f.replaceOnChange) parts.push('Changing this replaces the resource (delete + create).')
  return parts.length ? parts.join(' ') : undefined
}

function ScalarInput({
  spec: f,
  id,
  value,
  onChange,
  disabled,
  refOptions
}: {
  spec: FieldSpec
  id: string
  value: unknown
  onChange: (v: unknown) => void
  disabled?: boolean
  refOptions: (refType: string) => HubResource[]
}) {
  switch (f.kind) {
    case 'boolean':
      return (
        <div className='flex h-8 items-center gap-2'>
          <Switch
            id={id}
            checked={value === true}
            disabled={disabled}
            onCheckedChange={(v) => onChange(v === true)}
          />
          <span className='text-[12px] text-slate-600 dark:text-slate-300'>
            {value === true ? 'On' : 'Off'}
          </span>
        </div>
      )
    case 'enum': {
      const options = [
        ...(f.required ? [] : [{ value: '', label: 'Not set' }]),
        ...(f.options ?? [])
      ]
      return (
        <SimpleSelect
          value={typeof value === 'string' ? value : String(value ?? '')}
          onChange={onChange}
          options={options}
          ariaLabel={f.label}
          disabled={disabled}
          className='h-8 bg-white text-left text-[13px] dark:bg-background'
          triggerProps={{ id }}
        />
      )
    }
    case 'ref': {
      const picked =
        value && typeof value === 'object' && 'resourceId' in (value as object)
          ? String((value as { resourceId: unknown }).resourceId)
          : ''
      const list = f.refType ? refOptions(f.refType) : []
      const options = [
        {
          value: '',
          label: list.length ? 'Pick one' : 'None yet: create or adopt one first'
        },
        ...list.map((r) => ({ value: String(r.id), label: resourceName(r) }))
      ]
      return (
        <SimpleSelect
          value={picked}
          onChange={(v) => onChange(v ? { resourceId: Number(v) } : null)}
          options={options}
          ariaLabel={f.label}
          disabled={disabled || list.length === 0}
          className='h-8 bg-white text-left text-[13px] dark:bg-background'
          triggerProps={{ id }}
        />
      )
    }
    case 'secret':
      return (
        <SecretInput
          id={id}
          value={typeof value === 'string' ? value : ''}
          onChange={onChange}
          stored={value === HUB_MASK}
          placeholder={value === HUB_MASK ? undefined : 'Stored sealed, never shown again'}
        />
      )
    case 'number':
      return (
        <Input
          id={id}
          value={value == null ? '' : String(value)}
          onChange={(e) => onChange(e.target.value)}
          inputMode='decimal'
          disabled={disabled}
          className={cn(inputClass, 'font-mono tabular-nums')}
        />
      )
    default:
      return (
        <Input
          id={id}
          value={value == null ? '' : String(value)}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          spellCheck={false}
          className={inputClass}
        />
      )
  }
}

function ListField({
  spec: f,
  id,
  path,
  value,
  onChange,
  mode,
  locked,
  hint,
  errors,
  refOptions,
  idPrefix
}: {
  spec: FieldSpec
  id: string
  path: string
  value: unknown[]
  onChange: (v: unknown[]) => void
  mode: 'create' | 'update'
  locked: boolean
  hint: ReactNode
  errors: Record<string, string>
  refOptions: (refType: string) => HubResource[]
  idPrefix: string
}) {
  const item: FieldSpec = f.items ?? { key: 'item', label: f.label, kind: 'string' }
  const full = f.max != null && value.length >= f.max
  return (
    <fieldset className='m-0 min-w-0 border-0 p-0'>
      <legend className='mb-1.5 p-0 text-[12px] font-medium text-slate-700 dark:text-foreground'>
        {f.label}
        <span className='ml-1.5 font-normal tabular-nums text-slate-500 dark:text-muted-foreground'>
          {value.length}
        </span>
      </legend>
      {value.length === 0 ? (
        <p className='m-0 mb-2 text-[12px] text-slate-500 dark:text-muted-foreground'>None yet.</p>
      ) : (
        <ol className='m-0 mb-2 list-none space-y-2 p-0'>
          {value.map((v, i) => {
            const itemPath = `${path}.${i}`
            const itemId = `${id}-${i}`
            const setAt = (next: unknown) => onChange(value.map((x, j) => (j === i ? next : x)))
            return (
              // biome-ignore lint/suspicious/noArrayIndexKey: list items have no identity of their own
              <li key={i} className='flex items-start gap-2'>
                <div className='min-w-0 flex-1'>
                  {item.kind === 'object' ? (
                    <div className='rounded-md border border-slate-200 p-3 dark:border-border'>
                      <ResourceFields
                        fields={item.fields ?? []}
                        values={(v as Values | null) ?? {}}
                        onChange={setAt}
                        mode={mode}
                        idPrefix={idPrefix}
                        errors={errors}
                        refOptions={refOptions}
                        pathPrefix={`${itemPath}.`}
                      />
                    </div>
                  ) : (
                    <>
                      <label htmlFor={itemId} className='sr-only'>
                        {`${f.label} ${i + 1}`}
                      </label>
                      <ScalarInput
                        spec={{ ...item, label: `${f.label} ${i + 1}` }}
                        id={itemId}
                        value={v}
                        onChange={setAt}
                        disabled={locked}
                        refOptions={refOptions}
                      />
                      {errors[itemPath] && (
                        <p className='m-0 mt-1 text-[11px] text-red-600 dark:text-red-400'>
                          {errors[itemPath]}
                        </p>
                      )}
                    </>
                  )}
                </div>
                {!locked && (
                  <button
                    type='button'
                    aria-label={`Remove ${f.label} ${i + 1}`}
                    data-tip='Remove'
                    className={cn(ghostButton, 'w-8 px-0')}
                    onClick={() => onChange(value.filter((_, j) => j !== i))}
                  >
                    <X className='h-3.5 w-3.5' aria-hidden />
                  </button>
                )}
              </li>
            )
          })}
        </ol>
      )}
      {!locked && (
        <button
          type='button'
          className={ghostButton}
          disabled={full}
          onClick={() => onChange([...value, fieldDefault(item)])}
        >
          <Plus className='h-3.5 w-3.5' aria-hidden /> Add {addWord(f, item)}
        </button>
      )}
      {errors[path] ? (
        <p className='m-0 mt-1 text-[11px] text-red-600 dark:text-red-400'>{errors[path]}</p>
      ) : hint ? (
        <p className='m-0 mt-1 text-[11px] text-slate-500 dark:text-muted-foreground'>{hint}</p>
      ) : null}
    </fieldset>
  )
}

/**
 * Create a resource of `type`, or change `resource`: the fields, then Plan change. The plan opens
 * in the change view in place of the buttons; closing it brings the form back as it was.
 */
export function ResourceForm({
  type,
  resource,
  connectionId,
  scope,
  appId,
  environmentId,
  idPrefix,
  isAdmin,
  onClose,
  onDone,
  confirmFrame
}: {
  type: ResourceTypeInfo
  /** null = create. */
  resource: HubResource | null
  connectionId: number
  scope: ResourceScope
  appId?: number
  environmentId?: number
  idPrefix: string
  isAdmin: boolean
  onClose: () => void
  /** After the change finished (or was cancelled from the view). */
  onDone?: () => void
  /** Wraps the change view (the production guard on an environment). */
  confirmFrame?: (child: ReactNode) => ReactNode
}) {
  const mode = resource ? 'update' : 'create'
  const initial = useMemo(() => valuesOf(type.fields, resource), [type.fields, resource])
  const [values, setValues] = useState<Values>(initial)
  const [tried, setTried] = useState(false)
  const [change, setChange] = useState<ChangeModel | null>(null)
  // Ref fields pick among the resources the Hub manages on the same connection.
  const refTypes = useMemo(() => [...new Set(collectRefTypes(type.fields))], [type.fields])
  const candidates = useQuery({
    queryKey: providerKeys.resources({ connection: connectionId }),
    queryFn: () => fetchResources({ connection: connectionId }),
    enabled: refTypes.length > 0
  })
  const refOptions = (refType: string) =>
    (candidates.data ?? []).filter(
      (r) =>
        r.type === refType &&
        !r.deleted_at &&
        (r.scope === 'shared' || (r.app_id === (appId ?? null) && r.id !== resource?.id))
    )
  const errors = fieldErrors(type.fields, values, mode)
  const invalid = Object.keys(errors).length > 0
  const payload = fieldsPayload(type.fields, values, mode, initial)
  const nothingChanged = mode === 'update' && Object.keys(payload).length === 0

  const plan = useMutation({
    mutationFn: () => {
      const req: PlanRequest = {
        connectionId,
        scope,
        ...(scope === 'app' && appId != null ? { appId } : {}),
        ...(scope === 'app' && environmentId != null ? { environmentId } : {}),
        ops: [
          resource
            ? { action: 'update', resourceId: resource.id, fields: payload }
            : { action: 'create', type: type.key, fields: payload }
        ]
      }
      return planChange(req)
    },
    onSuccess: (p) => setChange(changeFromPlan(p))
  })

  const title = resource ? `Change ${resourceName(resource)}` : `New ${type.label.toLowerCase()}`
  return (
    <div className='space-y-4 rounded-lg border border-slate-200 bg-white p-4 dark:border-border dark:bg-card'>
      <div className='flex flex-wrap items-baseline gap-x-2 gap-y-1'>
        <h4 className='m-0 text-[13px] font-semibold text-slate-900 dark:text-foreground'>
          {title}
        </h4>
        <span className='font-mono text-[11px] text-slate-500 dark:text-muted-foreground'>
          {type.key}
        </span>
      </div>
      {change ? (
        (confirmFrame ?? ((c: ReactNode) => c))(
          <ChangeView
            initial={change}
            isAdmin={isAdmin}
            onClose={() => setChange(null)}
            onReplace={setChange}
            onFinished={onDone}
          />
        )
      ) : (
        <>
          <ResourceFields
            fields={type.fields}
            values={values}
            onChange={setValues}
            mode={mode}
            idPrefix={idPrefix}
            errors={tried ? errors : {}}
            refOptions={refOptions}
          />
          {plan.isError && (
            <ErrorNotice description={providerError(plan.error, 'Could not plan the change')} />
          )}
          <div className='flex flex-wrap items-center gap-2'>
            <Button
              size='sm'
              className='h-8 bg-nvr-cyan text-white hover:bg-nvr-cyan/90'
              disabled={plan.isPending || nothingChanged}
              onClick={() => {
                setTried(true)
                if (!invalid) plan.mutate()
              }}
            >
              {plan.isPending ? (
                <>
                  <RefreshCcw className='h-3.5 w-3.5 animate-spin' aria-hidden /> Reading the
                  provider…
                </>
              ) : (
                'Plan change'
              )}
            </Button>
            <Button size='sm' variant='ghost' className='h-8' onClick={onClose}>
              Cancel
            </Button>
            <span className='text-[12px] text-slate-500 dark:text-muted-foreground'>
              {nothingChanged
                ? 'Nothing changed yet.'
                : 'Planning reads the provider and writes nothing.'}
            </span>
          </div>
        </>
      )}
    </div>
  )
}

/** "Add rule", "Add value": the item's own label when it has one. */
function addWord(list: FieldSpec, item: FieldSpec): string {
  const own = item.label && item.label !== list.label ? item.label : ''
  return (own || 'value').toLowerCase()
}

function collectRefTypes(fields: FieldSpec[]): string[] {
  const out: string[] = []
  for (const f of fields) {
    if (f.kind === 'ref' && f.refType) out.push(f.refType)
    if (f.items) out.push(...collectRefTypes([f.items]))
    if (f.fields) out.push(...collectRefTypes(f.fields))
  }
  return out
}
