// Task 11a tests: fake provider adapters under the REAL type keys the flow hooks name (aws.*,
// vercel.*, expo.*, github.*), so the change engine, the registry and the hooks run unchanged
// against an in-memory "provider". No module-level state: makeFakeWorld() builds a fresh world.
import type {
  DesiredResource,
  FieldSpec,
  Observed,
  PlannedOp,
  ProviderAdapter,
  ResourceTypeSpec
} from '../../../services/hub/providers/types.js'

interface Thing {
  type: string
  fields: Record<string, unknown>
  tags: Record<string, string>
  version: number
}

export interface FakeCall {
  provider: string
  kind: string
  type: string
  action?: string
  ext: string | null
  data?: Record<string, unknown>
}

const f = (key: string, extra: Partial<FieldSpec> = {}): FieldSpec => ({
  key,
  label: key,
  kind: 'string',
  ...extra
})
const ref = (key: string, refType: string, extra: Partial<FieldSpec> = {}): FieldSpec =>
  f(key, { kind: 'ref', refType, ...extra })

const caps = (over: Partial<ResourceTypeSpec['capabilities']> = {}) => ({
  create: true,
  update: true,
  delete: true,
  adopt: true,
  snapshot: false,
  tag: true,
  ...over
})

function spec(
  key: string,
  scope: 'app' | 'shared',
  fields: FieldSpec[],
  refs: ResourceTypeSpec['refs'] = [],
  over: Partial<ResourceTypeSpec> = {}
): ResourceTypeSpec {
  return {
    key,
    label: key,
    scope,
    fields,
    capabilities: caps(),
    reversible: true,
    refs,
    risk: (op) => (op.kind === 'delete' ? ['destructive'] : []),
    ...over
  }
}

export const FAKE_TYPES: Record<string, ResourceTypeSpec[]> = {
  aws: [
    spec('aws.route53_zone', 'shared', [f('name')], [], { capabilities: caps({ create: false }) }),
    spec(
      'aws.route53_record',
      'app',
      [
        ref('zone', 'aws.route53_zone', { required: true }),
        f('name', { required: true }),
        f('record_type'),
        f('ttl', { kind: 'number' }),
        f('values', { kind: 'list', items: f('value') })
      ],
      [{ field: 'zone', type: 'aws.route53_zone' }]
    ),
    spec('aws.rds_instance', 'app', [
      f('name', { required: true }),
      f('engine'),
      f('master_password', { kind: 'secret' }),
      f('endpoint', { readOnly: true }),
      f('port', { kind: 'number', readOnly: true })
    ])
  ],
  vercel: [
    spec('vercel.project', 'app', [f('name', { required: true })]),
    spec(
      'vercel.deployment',
      'app',
      [ref('project', 'vercel.project', { required: true }), f('mode')],
      [{ field: 'project', type: 'vercel.project' }],
      { capabilities: caps({ create: false, delete: false }), nameField: 'project' }
    )
  ],
  expo: [
    spec('expo.branch', 'app', [f('name', { required: true })]),
    spec(
      'expo.channel',
      'app',
      [f('name', { required: true }), ref('branch', 'expo.branch')],
      [{ field: 'branch', type: 'expo.branch', required: false }]
    )
  ],
  auth0: [
    spec('auth0.application', 'app', [
      f('name', { required: true }),
      f('callbacks', { kind: 'list', items: f('url') }),
      f('allowed_logout_urls', { kind: 'list', items: f('url') }),
      f('allowed_origins', { kind: 'list', items: f('url') }),
      f('web_origins', { kind: 'list', items: f('url') })
    ])
  ],
  github: [
    spec('github.repository', 'app', [
      f('name', { required: true }),
      f('template'),
      f('visibility'),
      f('description'),
      f('default_branch')
    ]),
    spec(
      'github.environment',
      'app',
      [ref('repository', 'github.repository', { required: true }), f('name', { required: true })],
      [{ field: 'repository', type: 'github.repository' }]
    ),
    spec(
      'github.actions_secret',
      'app',
      [
        ref('repository', 'github.repository', { required: true }),
        f('environment'),
        f('name', { required: true }),
        f('value', { kind: 'secret', required: true })
      ],
      [{ field: 'repository', type: 'github.repository' }]
    ),
    spec(
      'github.actions_variable',
      'app',
      [
        ref('repository', 'github.repository', { required: true }),
        f('environment'),
        f('name', { required: true }),
        f('value', { required: true })
      ],
      [{ field: 'repository', type: 'github.repository' }]
    ),
    spec(
      'github.workflow',
      'app',
      [
        ref('repository', 'github.repository'),
        f('workflow'),
        f('ref'),
        f('inputs'),
        f('dispatch', { kind: 'boolean', trigger: true }),
        f('approve_environment'),
        f('approve_run_id'),
        f('approve_sha'),
        f('approve', { kind: 'boolean', trigger: true })
      ],
      [{ field: 'repository', type: 'github.repository' }],
      { capabilities: caps({ create: false, delete: false }) }
    )
  ]
}

const REF_FIELDS = new Set(['zone', 'project', 'branch', 'repository'])

export function makeFakeWorld() {
  const things = new Map<string, Thing>()
  const calls: FakeCall[] = []
  let n = 0
  const observedOf = (id: string): Observed | null => {
    const t = things.get(id)
    if (!t) return null
    return {
      type: t.type,
      externalId: id,
      name: String(t.fields.name ?? id),
      fields: { ...t.fields },
      tags: { ...t.tags },
      version: String(t.version)
    }
  }
  /** A thing the provider already has (adopt targets, a hosted zone). */
  const seed = (type: string, id: string, fields: Record<string, unknown>) => {
    things.set(id, { type, fields, tags: {}, version: 1 })
    return id
  }
  const plain = (d: DesiredResource): Record<string, unknown> => {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(d.fields)) {
      if (REF_FIELDS.has(k) || k === 'dispatch' || k === 'approve' || k === 'mode') continue
      if (v && typeof v === 'object' && 'fingerprint' in (v as object)) continue
      out[k] = v
    }
    for (const [k, v] of Object.entries(d.refs)) if (v != null) out[k] = v
    return out
  }

  function adapter(key: string): ProviderAdapter {
    return {
      key,
      label: key,
      connection: {
        fields: [{ key: 'token', label: 'Token', kind: 'string', secret: true }],
        hosts: () => [`api.${key}.example`],
        describe: () => key
      },
      types: FAKE_TYPES[key],
      testConnection: async () => ({ ok: true, identity: key, permissions: [], missing: [] }),
      observe: async (_ctx, _type, id) => observedOf(id),
      list: async () => ({ items: [], cursor: null }),
      plan(_ctx, desired, observed): PlannedOp[] {
        const base = (o: Partial<PlannedOp>): PlannedOp => ({
          kind: 'noop',
          type: (desired?.type ?? observed?.type) as string,
          resourceId: desired?.resourceId ?? null,
          externalId: observed?.externalId ?? null,
          reason: '',
          changes: [],
          preconditions: {},
          risk: [],
          ...o
        })
        if (!desired) return observed ? [base({ kind: 'delete', reason: 'Delete it.' })] : []
        if (!observed) return [base({ kind: 'create', reason: 'Create it.' })]
        if (desired.type === 'github.workflow' && desired.fields.dispatch === true)
          return [
            base({
              kind: 'update',
              action: 'dispatch',
              reason: 'Run it.',
              changes: [{ field: 'dispatch', from: false, to: true }],
              data: { ref: desired.fields.ref, inputs: desired.fields.inputs }
            })
          ]
        if (desired.type === 'github.workflow' && desired.fields.approve === true)
          return [
            base({
              kind: 'update',
              action: 'approve_deployment',
              reason: 'Approve it.',
              changes: [{ field: 'approve', from: false, to: true }],
              data: { environment: desired.fields.approve_environment, ref: desired.fields.ref }
            })
          ]
        if (desired.type === 'vercel.deployment') {
          if (observed.fields.production === true) return []
          return [
            base({
              kind: 'update',
              action: desired.fields.mode === 'rollback' ? 'rollback' : 'promote',
              reason: 'Make it live.',
              changes: [{ field: 'production', from: false, to: true }]
            })
          ]
        }
        const want = plain(desired)
        const changes = Object.keys(want)
          .filter((k) => JSON.stringify(want[k]) !== JSON.stringify(observed.fields[k]))
          .map((k) => ({ field: k, from: observed.fields[k], to: want[k] }))
        if (!changes.length) return []
        return [
          base({
            kind: 'update',
            reason: 'Update it.',
            changes,
            ...(desired.type === 'expo.channel' && changes.every((c) => c.field === 'branch')
              ? { action: 'point' }
              : {})
          })
        ]
      },
      async apply(_ctx, op, desired) {
        calls.push({
          provider: key,
          kind: op.kind,
          type: op.type,
          ...(op.action ? { action: op.action } : {}),
          ext: op.externalId,
          ...(op.data ? { data: op.data } : {})
        })
        if (op.kind === 'create') {
          const id = `${op.type}-${++n}`
          const fields = plain(desired as DesiredResource)
          if (op.type === 'aws.rds_instance') {
            fields.endpoint = `${String(fields.name)}.rds.example`
            fields.port = 5432
          }
          things.set(id, {
            type: op.type,
            fields,
            tags: { ...(desired as DesiredResource).tags },
            version: 1
          })
          return { ok: true, externalId: id, observed: observedOf(id) }
        }
        const id = op.externalId as string
        if (op.kind === 'delete') {
          things.delete(id)
          return { ok: true, externalId: id, observed: null }
        }
        if (op.kind === 'noop') return { ok: true, externalId: id, observed: observedOf(id) }
        const t = things.get(id)
        if (!t) throw new Error('gone')
        if (op.action === 'promote' || op.action === 'rollback') t.fields.production = true
        else if (op.action !== 'dispatch' && op.action !== 'approve_deployment')
          t.fields = { ...t.fields, ...plain(desired as DesiredResource) }
        t.version++
        return { ok: true, externalId: id, observed: observedOf(id) }
      }
    }
  }
  return {
    things,
    calls,
    seed,
    adapters: ['aws', 'vercel', 'expo', 'auth0', 'github'].map(adapter)
  }
}
