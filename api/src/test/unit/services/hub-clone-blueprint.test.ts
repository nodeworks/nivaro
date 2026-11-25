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
  const FILL = '{{fill in on the new app}}'
  const withRules = (actions: unknown[]) => {
    const b = bp()
    b.rules = [{ collection: 'orders', name: 'R', actions: JSON.stringify(actions) }]
    return JSON.parse(String(scrubBlueprintSecrets(b).blueprint.rules[0].actions))
  }

  it('names credential keys by their tokens, in English, German, Spanish and French', () => {
    for (const k of [
      'Authorization',
      'x-api-key',
      'clientSecret',
      'myApiKey',
      'db_password_2',
      'X-Amz-Signature',
      'authCode',
      'privateKeyPem',
      'Kennwort',
      'contraseña',
      'mot_de_passe',
      'AccountKey'
    ])
      expect(isSecretKey(k), k).toBe(true)
    for (const k of [
      'name',
      'field',
      'author',
      'keyboard',
      'group_key',
      'key',
      'label',
      'auth_type'
    ])
      expect(isSecretKey(k), k).toBe(false)
  })

  it('cleans URLs: user info, fragment and every query value (names kept)', () => {
    expect(scrubUrl('https://u:p@h.example.com/a?token=x&q=1')).toBe(
      'https://h.example.com/a?token=&q='
    )
    expect(scrubUrl('not a url')).toBeNull()
  })

  it('an action type off the in-app allow-list is fully denied; every action arrives disabled', () => {
    const [erp, setField] = withRules([
      {
        type: 'erp_submit',
        external_api: 'MWF',
        endpoint_path: '/api/Order?code=AbCdEf123456==',
        context: { region: 'east' }
      },
      { type: 'set_field', field: 'status', value: 'sent', note: 'Ring Bearer zZ9abcdefgh now' }
    ])
    expect(erp).toEqual({
      type: 'erp_submit',
      external_api: FILL,
      endpoint_path: FILL,
      context: { region: FILL },
      disabled: true
    })
    expect(setField).toMatchObject({
      type: 'set_field',
      field: 'status',
      value: 'sent',
      disabled: true
    })
    expect(setField.note).toBe('Ring Bearer  now') // prose, scanned
  })

  it('an unknown action type is denied, and so is an in-app type carrying an outbound key', () => {
    const [unknown, sneaky] = withRules([
      { type: 'brand_new_push', target: 'orders', note: 'hello' },
      { type: 'set_field', field: 'x', url: 'https://partner.example.com/x' }
    ])
    expect(unknown).toEqual({ type: 'brand_new_push', target: FILL, note: FILL, disabled: true })
    expect(sneaky.url).toBe(FILL)
    expect(sneaky.field).toBe(FILL)
  })

  it('a flow keeps its structure; a webhook trigger keeps auth_type and loses its secret', () => {
    const b = bp()
    b.flows = [
      {
        flow: {
          id: FLOW,
          name: 'Inbound',
          trigger: 'webhook',
          trigger_options: JSON.stringify({ auth_type: 'hmac-sha256', secret: 's3cr3t-hook-value' })
        },
        operations: [
          {
            id: 'op-1',
            flow: FLOW,
            key: 'read',
            type: 'item-read',
            options: JSON.stringify({
              collection: 'orders',
              filter: { status: { _eq: 'open' } },
              key: 'HMACSECRET123',
              name: 'sk_live_inname'
            })
          },
          {
            id: 'op-2',
            flow: FLOW,
            key: 'mail',
            type: 'mail',
            options: JSON.stringify({ to: 'ops@example.com' })
          }
        ]
      }
    ]
    const f = scrubBlueprintSecrets(b).blueprint.flows?.[0]
    expect(JSON.parse(String(f?.flow.trigger_options))).toEqual({
      auth_type: 'hmac-sha256',
      secret: ''
    })
    expect(JSON.parse(String(f?.operations[0].options))).toEqual({
      collection: 'orders',
      filter: { status: { _eq: 'open' } },
      key: FILL,
      name: FILL
    })
    expect(JSON.parse(String(f?.operations[1].options))).toEqual({ to: FILL })
    expect(String(f?.flow.description)).toMatch(/^Needs values \(fill in on the new app\):/)
  })

  it('an event flow keeps its collections and scope lists', () => {
    const b = bp()
    b.flows = [
      {
        flow: {
          id: FLOW,
          name: 'On save',
          trigger: 'event',
          trigger_options: JSON.stringify({ collections: ['orders'], scope: ['items.create'] })
        },
        operations: []
      }
    ]
    const f = scrubBlueprintSecrets(b).blueprint.flows?.[0]
    expect(JSON.parse(String(f?.flow.trigger_options))).toEqual({
      collections: ['orders'],
      scope: ['items.create']
    })
  })

  it('field options keep structure and labels, never other text; keys are scanned too', () => {
    const b = bp()
    b.collections[0].fields = [
      {
        field: 'kind',
        options: JSON.stringify({
          choices: [{ text: 'In progress', value: 'in_progress' }],
          remote: 'connect with sk_live_abcdef123456',
          lookup: { 'https://u:p@h.example/x?token=1': 'v' }
        })
      }
    ]
    const { blueprint, scrubbed } = scrubBlueprintSecrets(b)
    const opts = JSON.parse(String(blueprint.collections[0].fields[0].options))
    expect(opts.choices).toEqual([{ text: 'In progress', value: 'in_progress' }])
    expect(opts.remote).toBe(FILL)
    expect(Object.keys(opts.lookup)[0]).not.toContain('u:p')
    expect(Object.keys(opts.lookup)[0]).not.toContain('token=1')
    expect(scrubbed.join(' ')).not.toContain('u:p@')
  })

  it('the change counter, not the 500-path report, decides: 600 secrets are all scrubbed', () => {
    const b = bp()
    b.roles = [
      {
        role: { id: ROLE, name: 'Clerk' },
        policies: Array.from({ length: 600 }, (_, i) => ({
          role: ROLE,
          collection: 'orders',
          action: 'read',
          presets: JSON.stringify({ apiKey: `bulk-${i}-zz9` })
        }))
      }
    ]
    const { blueprint, scrubbed } = scrubBlueprintSecrets(b)
    expect(JSON.stringify(blueprint)).not.toMatch(/bulk-\d+-zz9/)
    expect(scrubbed.length).toBe(500)
  })

  it('leaves a blueprint without credentials or outbound parts untouched (same JSON text)', () => {
    const b = bp()
    for (const f of b.flows ?? []) delete f.flow.secret_col
    const { blueprint, scrubbed } = scrubBlueprintSecrets(b)
    expect(scrubbed).toEqual([])
    expect(JSON.stringify(blueprint)).toBe(JSON.stringify(b))
  })
})

describe('installer: roles with administrator access (review M2)', () => {
  const role = (id: string, name: string) => ({
    role: { id, name, admin_access: true, app_access: true },
    policies: []
  })
  const install = async (roles: NonNullable<Blueprint['roles']>, keep?: string[]) => {
    const b = sanitizeBlueprint({ ...bp(), roles }).blueprint
    b.collections = []
    b.workflows = []
    b.flows = []
    return installBlueprint(b, null, keep ? { keepAdminRoles: keep } : {})
  }

  it('the review names them; they arrive without admin access unless kept', async () => {
    const a = 'bbbbbbbb-1111-4111-8111-000000000001'
    const k = 'bbbbbbbb-1111-4111-8111-000000000002'
    const { review } = sanitizeBlueprint({ ...bp(), roles: [role(a, 'Regional Admins')] })
    expect(review.admin_roles).toEqual([{ id: a, name: 'Regional Admins' }])
    const r1 = await install([role(a, 'Regional Admins')])
    expect(r1.roles_admin_removed).toEqual(['Regional Admins'])
    const r2 = await install([role(k, 'Owners')], [k])
    expect(r2.roles_admin_removed).toBeUndefined()
    const rows = await db('nivaro_roles')
      .whereIn('id', [a, k])
      .select('id', 'admin_access', 'app_access')
    const by = new Map(rows.map((r) => [r.id, r]))
    expect(Number(by.get(a)?.admin_access)).toBe(0)
    expect(Number(by.get(k)?.admin_access)).toBe(1)
    expect(Number(by.get(a)?.app_access)).toBe(1)
  })
})

describe('installer: a cloned webhook flow', () => {
  it('arrives with bearer auth and a fresh random secret, inactive', async () => {
    const id = '44444444-3333-4444-8555-666666666666'
    const b = sanitizeBlueprint(bp()).blueprint
    b.collections = []
    b.workflows = []
    b.roles = []
    b.flows = [
      {
        flow: {
          id,
          name: 'Hook',
          trigger: 'webhook',
          trigger_options: '{"auth_type":"hmac-sha256","secret":""}'
        },
        operations: []
      }
    ]
    await installBlueprint(b, null)
    const row = await db('nivaro_flows').where({ id }).first('status', 'trigger_options')
    const opts = JSON.parse(row.trigger_options)
    expect(row.status).toBe('inactive')
    expect(opts.auth_type).toBe('bearer')
    expect(opts.secret).toMatch(/^[0-9a-f]{48}$/)
  })
})
