import type { Knex } from 'knex'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// Hub enhancement 46: the parts a structure blueprint adds (roles + policies, flows + steps,
// pipeline owner dimensions) through the ONE sanitizer and the ONE installer the template install
// already uses; and the pure scrubber's rules.

vi.mock('../../../db/index.js', async () => {
  const knex = (await import('knex')).default
  const { sqliteAfterCreate, sqliteCompat } = await import('../../../db/sqlite.js')
  sqliteCompat()
  const db = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: { min: 1, max: 1, afterCreate: sqliteAfterCreate }
  })
  return { db }
})
vi.mock('../../../services/payload-templates/index.js', () => ({
  getTemplate: vi.fn(async () => null),
  installTemplateDraft: vi.fn(async () => 'created')
}))

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const { installBlueprint } = await import('../../../services/blueprints.js')
const { sanitizeBlueprint } = await import('../../../services/blueprint-sanitize.js')
const { scrubBlueprintSecrets, scrubUrl, isSecretKey } = await import(
  '../../../services/blueprint-secrets.js'
)
type Blueprint = import('../../../services/blueprints.js').Blueprint

const ROLE = '11111111-2222-4333-8444-555555555555'
const ADMIN_ROLE = 'aaaaaaaa-2222-4333-8444-555555555555'
const FLOW = '22222222-3333-4444-8555-666666666666'

function bp(): Blueprint {
  return {
    type: 'nivaro-blueprint',
    version: 1,
    name: 'Structure of shop',
    exported_at: '2026-11-25T00:00:00.000Z',
    collections: [{ meta: { collection: 'orders' }, fields: [] }],
    relations: [],
    workflows: [
      {
        template: { id: 'wf-1', name: 'Order flow' },
        states: [{ id: 's-1', template: 'wf-1', key: 'new', label: 'New', sort: 0 }],
        transitions: [],
        bindings: [{ template: 'wf-1', collection: 'orders' }],
        dimensions: [
          { collection: 'orders', field: 'region', label: 'Region', sort: 0, binding: 99 },
          { collection: 'elsewhere', field: 'x', label: 'X', sort: 1 }
        ]
      }
    ],
    layouts: [],
    queues: [],
    rules: [],
    roles: [
      {
        role: { id: ROLE, name: 'Clerk', admin_access: false, app_access: true, workspace: 'w1' },
        policies: [
          { role: ROLE, collection: 'orders', action: 'update', fields: '*', id: 4 },
          { role: ROLE, collection: 'nivaro_users', action: 'read', fields: 'id,first_name' },
          { role: ROLE, collection: 'nivaro_users', action: 'update', fields: '*' },
          { role: ROLE, collection: 'payroll', action: 'read', fields: '*' }
        ]
      },
      { role: { id: ADMIN_ROLE, name: 'Administrator', admin_access: true }, policies: [] }
    ],
    flows: [
      {
        flow: { id: FLOW, name: 'Hourly', status: 'active', trigger: 'schedule', secret_col: 'x' },
        operations: [{ id: 'op-1', flow: FLOW, key: 'a', name: 'A', type: 'log', options: '{}' }]
      }
    ]
  }
}

beforeAll(async () => {
  const t = async (name: string, cols: string[], uuid = false) =>
    db.schema.createTable(name, (tb) => {
      if (uuid) tb.string('id', 64).primary()
      else tb.increments('id').primary()
      for (const c of cols) tb.text(c).nullable()
    })
  await t(
    'nivaro_roles',
    [
      'name',
      'description',
      'admin_access',
      'app_access',
      'ui_permissions',
      'created_at',
      'updated_at'
    ],
    true
  )
  await t('nivaro_policies', [
    'role',
    'collection',
    'action',
    'fields',
    'permissions',
    'validation',
    'presets',
    'row_filter',
    'created_at'
  ])
  await t(
    'nivaro_flows',
    [
      'name',
      'description',
      'status',
      'trigger',
      'trigger_options',
      'accountability',
      'created_at',
      'updated_at'
    ],
    true
  )
  await t(
    'nivaro_flow_operations',
    [
      'flow',
      'name',
      'key',
      'type',
      'position_x',
      'position_y',
      'options',
      'resolve',
      'reject',
      'created_at'
    ],
    true
  )
  await t(
    'nivaro_workflow_templates',
    ['name', 'description', 'color', 'icon', 'created_at', 'updated_at'],
    true
  )
  await t('nivaro_workflow_states', ['template', 'key', 'label', 'sort'], true)
  await t('nivaro_workflow_transitions', ['template'], true)
  await t('nivaro_workflow_bindings', ['template', 'collection'])
  await t('nivaro_pipeline_owner_dimensions', [
    'binding',
    'field',
    'label',
    'sort',
    'is_row_axis',
    'required'
  ])
  await db('nivaro_roles').insert({
    id: 'bbbbbbbb-0000-4000-8000-000000000000',
    name: 'Administrator',
    admin_access: '1'
  })
})

afterAll(async () => {
  await db.destroy()
})

describe('sanitizer: roles, flows, dimensions', () => {
  it('keeps known columns, policies inside the blueprint plus system reads, flows inactive', () => {
    const { blueprint, review } = sanitizeBlueprint(bp())
    const clerk = blueprint.roles?.find((r) => r.role.name === 'Clerk')
    expect(clerk?.role).not.toHaveProperty('workspace')
    expect(clerk?.policies.map((p) => `${p.collection}:${p.action}`)).toEqual([
      'orders:update',
      'nivaro_users:read'
    ])
    expect(review.refused.join(' ')).toContain('Policy of Clerk on nivaro_users')
    expect(review.refused.join(' ')).toContain('Policy of Clerk on payroll')
    expect(blueprint.flows?.[0].flow.status).toBe('inactive')
    expect(blueprint.flows?.[0].flow).not.toHaveProperty('secret_col')
    expect(blueprint.workflows[0].dimensions).toEqual([
      { collection: 'orders', field: 'region', label: 'Region', sort: 0 }
    ])
  })

  it('a blueprint without the new parts stays exactly as before', () => {
    const plain = bp()
    delete plain.roles
    delete plain.flows
    delete plain.workflows[0].dimensions
    const { blueprint } = sanitizeBlueprint(plain)
    expect(blueprint).not.toHaveProperty('roles')
    expect(blueprint).not.toHaveProperty('flows')
    expect(blueprint.workflows[0]).not.toHaveProperty('dimensions')
  })
})

describe('installer: roles, flows, dimensions', () => {
  it('installs roles with policies, skips a name that exists, flows always inactive', async () => {
    const { blueprint } = sanitizeBlueprint(bp())
    blueprint.collections = [] // the collections part is covered by the template install tests
    // A bundle that says active is still installed inactive (defence in depth).
    blueprint.flows = blueprint.flows?.map((f) => ({ ...f, flow: { ...f.flow, status: 'active' } }))
    const report = await installBlueprint(blueprint, null, { atomic: true })
    expect(report.roles).toEqual({ created: 1, skipped: 1 })
    expect(report.flows).toEqual({ created: 1, skipped: 0 })
    expect(report.errors).toEqual([])
    const flows = await db('nivaro_flows').select('id', 'status')
    expect(flows).toEqual([{ id: FLOW, status: 'inactive' }])
    expect(await db('nivaro_flow_operations').where({ flow: FLOW }).count({ n: '*' })).toEqual([
      { n: 1 }
    ])
    const policies = await db('nivaro_policies').where({ role: ROLE }).select('collection')
    expect(policies.map((p) => p.collection).sort()).toEqual(['nivaro_users', 'orders'])
    const binding = await db('nivaro_workflow_bindings').where({ collection: 'orders' }).first('id')
    const dims = await db('nivaro_pipeline_owner_dimensions').select('binding', 'field')
    expect(dims).toEqual([{ binding: String(binding.id), field: 'region' }])
  })

  it('a second install skips every part (idempotent)', async () => {
    const again = sanitizeBlueprint(bp()).blueprint
    again.collections = []
    const report = await installBlueprint(again, null)
    expect(report.roles).toEqual({ created: 0, skipped: 2 })
    expect(report.flows).toEqual({ created: 0, skipped: 1 })
    expect(report.workflows.skipped).toBe(1)
  })
})

describe('scrubber', () => {
  it('names credential keys', () => {
    for (const k of ['Authorization', 'x-api-key', 'api_key', 'client_secret', 'password', 'token'])
      expect(isSecretKey(k)).toBe(true)
    for (const k of ['token_url', 'auth_type', 'name', 'field', 'tokens_used'])
      expect(isSecretKey(k)).toBe(false)
  })

  it('cleans URLs: user info and credential query values', () => {
    expect(scrubUrl('https://u:p@h.example.com/a?token=x&q=1')).toBe(
      'https://h.example.com/a?token=&q=1'
    )
    expect(scrubUrl('https://h.example.com/a?q=1')).toBe('https://h.example.com/a?q=1')
    expect(scrubUrl('not a url')).toBeNull()
  })

  it('empties header values, auth values and secret keys; keeps placeholders; reports paths only', () => {
    const b = bp()
    b.rules = [
      {
        collection: 'orders',
        name: 'R',
        actions: JSON.stringify([
          { headers: [{ header: 'Authorization', value: 'Basic abc' }], api_key: 'k-1' },
          { body: { token: '⟦nvr-secret:token⟧' }, note: 'Bearer zzz' }
        ])
      }
    ]
    const { blueprint, scrubbed } = scrubBlueprintSecrets(b)
    const actions = JSON.parse(String(blueprint.rules[0].actions))
    expect(actions[0].headers).toEqual([{ header: 'Authorization', value: '' }])
    expect(actions[0].api_key).toBe('')
    expect(actions[1].body.token).toBe('⟦nvr-secret:token⟧')
    expect(actions[1].note).toBe('')
    expect(scrubbed).toEqual([
      'rules[R].actions[0].headers.Authorization',
      'rules[R].actions[0].api_key',
      'rules[R].actions[1].note'
    ])
    expect(JSON.stringify(scrubbed)).not.toContain('abc')
  })

  it('leaves a blueprint without credentials untouched (same JSON text)', () => {
    const b = bp()
    const { blueprint, scrubbed } = scrubBlueprintSecrets(b)
    expect(scrubbed).toEqual([])
    expect(JSON.stringify(blueprint)).toBe(JSON.stringify(b))
  })
})
