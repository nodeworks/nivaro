import { join } from 'node:path'
import type { Knex } from 'knex'
import {
  estimateOf,
  lineOf,
  priceLookup,
  transferLine,
  unknownEstimate
} from '../../../services/hub/providers/pricing/index.js'
import type {
  DesiredResource,
  Observed,
  PlannedOp,
  PriceAnswer,
  ProviderAdapter,
  ResourceTypeSpec
} from '../../../services/hub/providers/types.js'

// Task 44a test fixture (not a test file): a fake provider whose `fake.box` prices from the price
// book (bundled table 250 ¢/box-month, or the fake price API when a test turns it on) with a data
// transfer line at 9 ¢/GB, and `fake.blob` — a costed type WITHOUT an estimate. The tests mock
// db/index.js with SQLite before importing this.

export const MIGRATIONS = [
  '542_hub_tables',
  '543_hub_promotions',
  '544_hub_databases',
  '545_hub_creations',
  '546_hub_stack_settings',
  '550_hub_oidc',
  '551_hub_signins',
  '552_hub_shared_deployments',
  '553_hub_moves',
  '555_hub_stack_files',
  '565_hub_release_ops',
  '566_hub_fleet',
  '567_hub_capacity',
  '568_hub_ops',
  '569_hub_data',
  '570_hub_people_owner_policy',
  '571_hub_app_templates',
  '573_hub_change_ops',
  '580_hub_placement',
  '581_hub_scale',
  '582_hub_providers',
  '585_hub_cost_live'
]

export async function migrate(db: Knex): Promise<void> {
  const dir = join(import.meta.dirname, '../../../db/migrations')
  for (const m of MIGRATIONS) await (await import(/* @vite-ignore */ join(dir, `${m}.ts`))).up(db)
  if (!(await db.schema.hasTable('nivaro_extension_settings')))
    await db.schema.createTable('nivaro_extension_settings', (t) => {
      t.increments('id').primary()
      t.string('extension_id', 100).notNullable()
      t.string('key', 100).notNullable()
      t.text('value').nullable()
      t.dateTime('updated_at').nullable()
    })
  if (!(await db.schema.hasTable('nivaro_users')))
    await db.schema.createTable('nivaro_users', (t) => {
      t.uuid('id').primary()
      t.string('first_name', 100).nullable()
      t.string('last_name', 100).nullable()
      t.string('status', 20).nullable()
    })
}

export const fake = {
  things: new Map<string, { type: string; fields: Record<string, unknown>; version: number }>(),
  n: 0,
  /** The fake price API's answer (null = it lists no price; 'throw' = it fails). */
  api: null as PriceAnswer | null | 'throw',
  apiCalls: 0,
  estimateThrows: false
}

export function resetFake(): void {
  fake.things = new Map()
  fake.n = 0
  fake.api = null
  fake.apiCalls = 0
  fake.estimateThrows = false
}

const field = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  label: key,
  kind: 'string' as const,
  ...extra
})

function observedOf(id: string): Observed | null {
  const t = fake.things.get(id)
  if (!t) return null
  return {
    type: t.type,
    externalId: id,
    name: String(t.fields.name ?? id),
    fields: { ...t.fields },
    tags: {},
    version: String(t.version)
  }
}

function type(key: string, withEstimate: boolean): ResourceTypeSpec {
  const t: ResourceTypeSpec = {
    key,
    label: key === 'fake.blob' ? 'Blob' : 'Box',
    scope: 'app',
    fields: [
      field('name', { required: true }),
      field('size', { kind: 'number' }),
      field('costly', { kind: 'boolean' })
    ],
    capabilities: {
      create: true,
      update: true,
      delete: true,
      adopt: true,
      snapshot: false,
      tag: true
    },
    reversible: true,
    refs: [],
    risk: (op) => (op.kind === 'delete' ? ['destructive'] : []),
    costClass: (d: DesiredResource) => (d.fields.costly === true ? 'monthly' : 'none')
  }
  if (withEstimate)
    t.estimate = async (ctx, desired, observed) => {
      if (fake.estimateThrows) throw new Error('price page down')
      const size = Number(desired?.fields.size ?? observed?.fields.size ?? 1)
      const p = await priceLookup(ctx, 'fake', 'box.month', ctx.region)
      if (!p) return unknownEstimate()
      const lines = [
        lineOf(
          'Box',
          size,
          'month',
          p.unitCents,
          p.source === 'bundled' ? 'plan_price' : 'price_list'
        )
      ]
      const t = transferLine(ctx.traffic, 9)
      if (t) lines.push(t)
      return estimateOf({
        basis: 'plan_price',
        confidence: 'list_price',
        lines,
        priceAsOf: p.asOf
      })
    }
  return t
}

function plan(
  _ctx: unknown,
  desired: DesiredResource | null,
  observed: Observed | null
): PlannedOp[] {
  const base = {
    resourceId: desired?.resourceId ?? null,
    changes: [],
    preconditions: {},
    risk: []
  }
  if (!desired)
    return observed
      ? [
          {
            ...base,
            kind: 'delete',
            type: observed.type,
            externalId: observed.externalId,
            reason: `Delete ${observed.name}.`
          }
        ]
      : []
  if (!observed)
    return [
      {
        ...base,
        kind: 'create',
        type: desired.type,
        externalId: null,
        reason: `Create ${String(desired.fields.name)}.`,
        changes: Object.keys(desired.fields).map((k) => ({ field: k, to: desired.fields[k] }))
      }
    ]
  const changes = ['size', 'costly']
    .filter((k) => k in desired.fields && desired.fields[k] !== observed.fields[k])
    .map((k) => ({ field: k, from: observed.fields[k], to: desired.fields[k] }))
  if (!changes.length) return []
  return [
    {
      ...base,
      kind: 'update',
      type: desired.type,
      externalId: observed.externalId,
      reason: `Update ${observed.name}.`,
      changes
    }
  ]
}

export const fakeAdapter: ProviderAdapter = {
  key: 'fake',
  label: 'Fake',
  connection: {
    fields: [{ key: 'org', label: 'Org', kind: 'string' }],
    hosts: () => ['api.fake.example'],
    describe: () => 'Fake'
  },
  types: [type('fake.box', true), type('fake.blob', false)],
  bundledPrices: {
    asOf: '2026-11-01',
    currency: 'USD',
    items: { 'box.month': { unit: 'month', unitCents: 250 } }
  },
  async priceApi() {
    fake.apiCalls++
    if (fake.api === 'throw') throw new Error('price api down')
    return fake.api
  },
  testConnection: async () => ({ ok: true, identity: 'fake', permissions: [], missing: [] }),
  observe: async (_ctx, _type, id) => observedOf(id),
  list: async () => ({ items: [], cursor: null }),
  plan: plan as ProviderAdapter['plan'],
  async apply(_ctx, op, desired) {
    if (op.kind === 'create') {
      const id = `box-${++fake.n}`
      fake.things.set(id, { type: op.type, fields: { ...(desired?.fields ?? {}) }, version: 1 })
      return { ok: true, externalId: id, observed: observedOf(id) }
    }
    const id = op.externalId as string
    if (op.kind === 'delete') {
      fake.things.delete(id)
      return { ok: true, externalId: id, observed: null }
    }
    const t = fake.things.get(id)
    if (t) {
      t.fields = { ...t.fields, ...(desired?.fields ?? {}) }
      t.version++
    }
    return { ok: true, externalId: id, observed: observedOf(id) }
  }
}
