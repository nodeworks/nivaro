import { useQuery } from '@tanstack/react-query'
import { Plus, Trash2 } from 'lucide-react'
import { HUB_MASK } from '../hub-api'
import { ChoiceCombobox, Field, ghostButton } from '../hub-parts'
import {
  fetchProviderTypes,
  fetchResources,
  fieldErrors,
  fieldsPayload,
  type ProviderTypes,
  providerKeys,
  type ResourceTypeInfo,
  valuesOf
} from '../providers/providers-api'
import { ResourceFields } from '../providers/ResourceForm'
import { ConnectionPicker } from '../providers/ResourcePickers'

/**
 * Create app, per environment (Task 11): optional provider parts the creation makes through the
 * change engine — a Vercel project, an Auth0 application (its sign-in addresses default to the
 * environment's), a Route 53 record, an RDS instance. Each part is one type, one connection and
 * that type's fields, drawn from the provider's own FieldSpec like the Resources form.
 *
 * Task 33 adds an Entra app registration (it and its client secret become the stack's sign-in),
 * a managed Redis (Upstash or Redis Cloud: the stack's REDIS_URL), a Sentry project and an
 * Anthropic workspace. The stack-bound ones follow the API's rule (create/provider-parts.ts
 * `partsProblem`): Docker only, one Entra and one Redis per environment, Redis set to external.
 */

export const PART_TYPES = [
  'vercel.project',
  'auth0.application',
  'aws.route53_record',
  'aws.rds_instance',
  'entra.app_registration',
  'upstash.redis_database',
  'redis-cloud.database',
  'sentry.project',
  'anthropic.workspace'
] as const
export type PartType = (typeof PART_TYPES)[number]
export const MAX_PARTS = 6

const PART_WORDS: Record<PartType, string> = {
  'vercel.project': 'Vercel project',
  'auth0.application': 'Auth0 application',
  'aws.route53_record': 'Route 53 record',
  'aws.rds_instance': 'RDS instance',
  'entra.app_registration': 'Entra app registration (sign-in)',
  'upstash.redis_database': 'Upstash Redis',
  'redis-cloud.database': 'Redis Cloud database',
  'sentry.project': 'Sentry project',
  'anthropic.workspace': 'Anthropic workspace'
}

const PART_HINT: Record<PartType, string> = {
  'vercel.project': 'A Vercel project for this environment.',
  'auth0.application':
    'Sign-in, logout and origin addresses default to this environment’s address when left empty.',
  'aws.route53_record': 'A DNS record in a hosted zone the Hub manages.',
  'aws.rds_instance':
    'The instance only. Once it is available, link it as a database server on the Databases tab.',
  'entra.app_registration':
    'The Hub makes the registration and a client secret and puts them in this environment’s stack (OIDC_CLIENT_ID, OIDC_CLIENT_SECRET). Sign-in and logout addresses default to this environment’s address.',
  'upstash.redis_database':
    'Its address, password included, becomes this environment’s REDIS_URL (a stack secret).',
  'redis-cloud.database':
    'Its address, password included, becomes this environment’s REDIS_URL (a stack secret).',
  'sentry.project': 'Each promotion of this environment records a release on it.',
  'anthropic.workspace': 'A workspace for this environment’s AI use.'
}

export const ENTRA_PART: PartType = 'entra.app_registration'
/** Parts whose outputs are written to the environment's Docker stack (API STACK_BOUND_TYPES). */
export const STACK_BOUND: readonly PartType[] = [
  'entra.app_registration',
  'upstash.redis_database',
  'redis-cloud.database'
]
export const REDIS_PARTS: readonly PartType[] = ['upstash.redis_database', 'redis-cloud.database']

/**
 * What the Hub would refuse about one environment's parts together (the API's `partsProblem`,
 * same order, same words), or null. `kind` is the creation kind, `stackRedis` the stack's Redis.
 */
export function envPartsProblem(
  parts: Array<Pick<PartDraft, 'type'>>,
  o: { kind: string; stackRedis: string | null }
): string | null {
  const types = parts.map((p) => p.type).filter((t): t is PartType => !!t)
  if (types.some((t) => STACK_BOUND.includes(t)) && o.kind !== 'docker')
    return 'An Entra app registration or a managed Redis is bound to the environment’s stack: pick a Docker driver to use one.'
  if (types.filter((t) => t === ENTRA_PART).length > 1)
    return 'One Entra app registration per environment.'
  const redis = types.filter((t) => REDIS_PARTS.includes(t))
  if (redis.length > 1) return 'One managed Redis per environment.'
  if (redis.length && o.stackRedis !== 'external')
    return 'A managed Redis needs the stack’s Redis set to external (the Hub fills REDIS_URL).'
  return null
}

/** Whether an environment's parts make its sign-in (an Entra part that would be sent). */
export const makesSignin = (parts: PartDraft[]) =>
  parts.some((p) => p.type === ENTRA_PART && !!p.connectionId)

/**
 * Create app's sign-in rule (the API's in create/plan.ts): sign-in may be left out on a shared
 * deployment (the deployment's own registration), and on a Docker creation whose EVERY
 * environment makes an Entra app registration (the Hub makes each one and puts it in the stack).
 * Left out = all three fields empty; anything typed is sent and checked in full.
 */
export function signinRule(o: {
  kind: string
  envParts: PartDraft[][]
  issuer: string
  clientId: string
  clientSecret: string
}) {
  const entraEnvs = o.kind === 'docker' ? o.envParts.filter(makesSignin).length : 0
  const entraEverywhere =
    o.kind === 'docker' && o.envParts.length > 0 && entraEnvs === o.envParts.length
  const optional = o.kind === 'shared' || entraEverywhere
  const empty = !o.issuer.trim() && !o.clientId.trim() && !o.clientSecret
  return { entraEnvs, entraEverywhere, optional, omitSignin: optional && empty }
}

export interface PartDraft {
  uid: string
  type: PartType | ''
  connectionId: number | null
  values: Record<string, unknown>
  /** A field was changed: its own errors show from then on (not on a part just added). */
  touched?: boolean
}

let seq = 0
export const newPart = (): PartDraft => ({
  uid: `part-${++seq}`,
  type: '',
  connectionId: null,
  values: {}
})

export function partTypeInfo(types: ProviderTypes | undefined, type: string) {
  const provider = type.split('.')[0]
  return types?.providers.find((p) => p.key === provider)?.types.find((t) => t.key === type) ?? null
}

/** Why a part cannot be sent yet, keyed by field path ('' = the part itself), or {}. */
export function partProblems(p: PartDraft, info: ResourceTypeInfo | null): Record<string, string> {
  if (!p.type) return { '': 'Pick what to make' }
  if (!p.connectionId) return { '': 'Pick the connection it is made through' }
  return info ? fieldErrors(info.fields, p.values, 'create') : {}
}

const blank = (v: unknown) => v === '' || v == null || (Array.isArray(v) && v.length === 0)

/**
 * The request's `providers` of one environment. Empty values are left out (so Auth0 takes the
 * environment's addresses); `mask` replaces secret values with the mask for a preview.
 */
export function partsPayload(
  parts: PartDraft[],
  types: ProviderTypes | undefined,
  o: { mask?: boolean } = {}
): Array<{ connection_id: number; type: PartType; fields: Record<string, unknown> }> {
  const out: Array<{ connection_id: number; type: PartType; fields: Record<string, unknown> }> = []
  for (const p of parts) {
    if (!p.type || !p.connectionId) continue
    const info = partTypeInfo(types, p.type)
    const fields = info ? fieldsPayload(info.fields, p.values, 'create') : {}
    for (const [k, v] of Object.entries(fields)) if (blank(v)) delete fields[k]
    if (o.mask && info)
      for (const f of info.fields)
        if (f.kind === 'secret' && f.key in fields) fields[f.key] = HUB_MASK
    out.push({ connection_id: p.connectionId, type: p.type, fields })
  }
  return out
}

export function ProviderPartsEditor({
  idPrefix,
  envKey,
  parts,
  onChange,
  tried,
  kind,
  stackRedis
}: {
  idPrefix: string
  envKey: string
  parts: PartDraft[]
  onChange: (next: PartDraft[]) => void
  tried: boolean
  /** The creation kind: stack-bound parts are offered on a Docker creation only. */
  kind: string
  /** The Docker stack's Redis (bundled | external); null off Docker. */
  stackRedis: string | null
}) {
  const types = useQuery({ queryKey: providerKeys.types(), queryFn: fetchProviderTypes })
  const set = (uid: string, patch: Partial<PartDraft>) =>
    onChange(parts.map((p) => (p.uid === uid ? { ...p, ...patch } : p)))
  const offered = PART_TYPES.filter(
    (t) => partTypeInfo(types.data, t) && (kind === 'docker' || !STACK_BOUND.includes(t))
  )
  const together = envPartsProblem(parts, { kind, stackRedis })
  return (
    <div className='space-y-2 sm:col-span-2'>
      <div>
        <h5 className='m-0 text-[12px] font-medium text-slate-700 dark:text-foreground'>
          Provider parts
        </h5>
        <p className='m-0 text-[11px] text-slate-500 dark:text-muted-foreground'>
          Optional. Made for {envKey || 'this environment'} through the change engine, after its
          database.
        </p>
      </div>
      {parts.map((p, i) => {
        const info = p.type ? partTypeInfo(types.data, p.type) : null
        const all = partProblems(p, info)
        const problems: Record<string, string> = tried
          ? all
          : p.touched
            ? Object.fromEntries(Object.entries(all).filter(([k]) => k !== ''))
            : {}
        const id = `${idPrefix}-part-${p.uid}`
        return (
          <div
            key={p.uid}
            className='space-y-3 rounded-md border border-slate-200 bg-slate-50/60 p-3 dark:border-border dark:bg-muted/30'
          >
            <div className='grid grid-cols-1 items-start gap-3 sm:grid-cols-[1fr_1fr_auto]'>
              <Field id={`${id}-type`} label={`Part ${i + 1}`}>
                <ChoiceCombobox
                  id={`${id}-type`}
                  value={p.type}
                  onChange={(v) => {
                    const ti = partTypeInfo(types.data, v)
                    set(p.uid, {
                      type: v as PartType,
                      connectionId:
                        v.split('.')[0] === p.type.split('.')[0] ? p.connectionId : null,
                      values: ti ? valuesOf(ti.fields, null) : {}
                    })
                  }}
                  options={[
                    ...offered,
                    // A pick the kind no longer offers (Entra, then a GitLab target) stays shown:
                    // the line under the parts says why it cannot be sent.
                    ...(p.type && !offered.includes(p.type) ? [p.type] : [])
                  ].map((t) => ({ value: t, label: PART_WORDS[t] }))}
                  placeholder={types.isPending ? 'Loading…' : 'What to make'}
                  empty='No provider for these parts is registered on this Hub.'
                />
              </Field>
              <Field
                id={`${id}-conn`}
                label='Connection'
                error={problems[''] && p.type ? problems[''] : null}
              >
                {p.type ? (
                  <ConnectionPicker
                    id={`${id}-conn`}
                    provider={p.type.split('.')[0]}
                    value={p.connectionId}
                    onChange={(c) => set(p.uid, { connectionId: c })}
                  />
                ) : (
                  <ChoiceCombobox
                    id={`${id}-conn`}
                    value=''
                    onChange={() => undefined}
                    options={[]}
                    placeholder='Pick what to make first'
                    disabled
                  />
                )}
              </Field>
              <button
                type='button'
                aria-label={`Remove part ${i + 1}`}
                data-tip='Remove'
                className={`${ghostButton} sm:mt-6`}
                onClick={() => onChange(parts.filter((x) => x.uid !== p.uid))}
              >
                <Trash2 className='h-3.5 w-3.5' aria-hidden />
              </button>
            </div>
            {!p.type && problems[''] && (
              <p className='m-0 text-[11px] text-red-600 dark:text-red-400'>{problems['']}</p>
            )}
            {p.type && (
              <p className='m-0 text-[11px] text-slate-500 dark:text-muted-foreground'>
                {PART_HINT[p.type]}
              </p>
            )}
            {info && p.connectionId && (
              <PartFields
                idPrefix={id}
                info={info}
                connectionId={p.connectionId}
                values={p.values}
                onChange={(values) => set(p.uid, { values, touched: true })}
                errors={problems}
              />
            )}
          </div>
        )
      })}
      {together && (
        <p role='alert' className='m-0 text-[11px] text-red-600 dark:text-red-400'>
          {together}
        </p>
      )}
      {parts.length < MAX_PARTS && (
        <button
          type='button'
          className={ghostButton}
          onClick={() => onChange([...parts, newPart()])}
        >
          <Plus className='h-3.5 w-3.5' aria-hidden /> Add a provider part
        </button>
      )}
    </div>
  )
}

function PartFields({
  idPrefix,
  info,
  connectionId,
  values,
  onChange,
  errors
}: {
  idPrefix: string
  info: ResourceTypeInfo
  connectionId: number
  values: Record<string, unknown>
  onChange: (v: Record<string, unknown>) => void
  errors: Record<string, string>
}) {
  // A new app has no resources yet: a link points at a shared one on the same connection.
  const shared = useQuery({
    queryKey: providerKeys.resources({ connection: connectionId, scope: 'shared' }),
    queryFn: () => fetchResources({ connection: connectionId, scope: 'shared' }),
    enabled: info.fields.some((f) => f.kind === 'ref')
  })
  return (
    <ResourceFields
      fields={info.fields}
      values={values}
      onChange={onChange}
      mode='create'
      idPrefix={idPrefix}
      errors={errors}
      refOptions={(t) => (shared.data ?? []).filter((r) => r.type === t && !r.deleted_at)}
    />
  )
}
