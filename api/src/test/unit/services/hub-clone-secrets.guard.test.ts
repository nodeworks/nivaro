import type { Knex } from 'knex'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// Hub enhancement 46 GUARD: an app's structure export for a clone never carries a secret out of
// the source. Seeds a real (in-memory SQLite) app with a flow webhook step that sends auth
// headers, an external API with a key and a body secret, a payload template whose body names that
// body secret (and has a literal password typed in), a transition action with an inline bearer,
// and a rule with a URL holding user info — then runs the SOURCE's export
// (services/hub-link/clone-export.ts, the one GET /api/hub-link/clone/blueprint answers) and
// asserts none of the secret values is anywhere in what leaves, and that the export never even
// reads the external API or settings tables.

const SECRETS = {
  flowAuth: 'Bearer flow-auth-header-value-7f3a',
  flowKey: 'x-api-key-value-19c2',
  apiKey: 'external-api-key-value-55d1',
  bodySecret: 'mwf-body-secret-value-a90e',
  inlineBodyPassword: 'literal-body-password-0b7c',
  transitionBearer: 'transition-bearer-token-3e8f',
  urlPassword: 'url-userinfo-password-c41d',
  queryToken: 'query-token-value-6b2a'
}

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
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))
vi.mock('../../../services/payload-templates/index.js', () => ({
  getTemplate: vi.fn(async (key: string) =>
    key === 'mwf-status'
      ? {
          key: 'mwf-status',
          label: 'MWF status',
          description: null,
          external_api: 'MWF',
          endpoint_path: '/status',
          collection: 'orders',
          published_mode: 'map',
          // The body secret appears as its placeholder (a name, never the value); a literal
          // password someone typed into the JSON body must still be emptied.
          published_body: JSON.stringify({
            token: '⟦nvr-secret:token⟧',
            password: 'literal-body-password-0b7c',
            status: '{{ state }}'
          }),
          locked_keys: [],
          lookups: {}
        }
      : null
  ),
  installTemplateDraft: vi.fn()
}))

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const { exportCloneBlueprint } = await import('../../../services/hub-link/clone-export.js')

const tablesRead: string[] = []

async function table(name: string, cols: string[]) {
  await db.schema.createTable(name, (t) => {
    if (!cols.includes('id')) t.increments('id').primary()
    for (const c of cols) {
      if (c === 'id') t.string('id', 64).primary()
      else t.text(c).nullable()
    }
  })
}

beforeAll(async () => {
  await table('nivaro_collections', ['collection', 'display_name', 'hidden', 'sort'])
  await table('nivaro_fields', ['collection', 'field', 'type', 'interface', 'options', 'sort'])
  await table('nivaro_relations', ['many_collection', 'many_field', 'one_collection'])
  await table('nivaro_workflow_templates', ['id', 'name', 'description'])
  await table('nivaro_workflow_states', ['id', 'template', 'key', 'label', 'sort'])
  await table('nivaro_workflow_transitions', [
    'id',
    'template',
    'from_state',
    'to_state',
    'label',
    'actions',
    'sort'
  ])
  await table('nivaro_workflow_bindings', ['template', 'collection'])
  await table('nivaro_pipeline_owner_dimensions', ['binding', 'field', 'label', 'sort'])
  await table('nivaro_collection_layouts', ['collection', 'name'])
  await table('nivaro_field_groups', ['layout_id', 'collection', 'key', 'label'])
  await table('nivaro_layout_field_assignments', ['layout_id', 'field', 'group_key'])
  await table('nivaro_queues', ['id', 'name'])
  await table('nivaro_queue_sources', ['queue_id', 'type', 'collection'])
  await table('nivaro_rules', ['collection', 'name', 'trigger', 'actions', 'enabled'])
  await table('nivaro_roles', ['id', 'name', 'admin_access', 'app_access', 'workspace'])
  await table('nivaro_policies', ['role', 'collection', 'action', 'fields'])
  await table('nivaro_flows', ['id', 'name', 'status', 'trigger', 'trigger_options'])
  await table('nivaro_flow_operations', ['id', 'flow', 'name', 'key', 'type', 'options'])
  await table('nivaro_external_apis', ['name', 'base_url', 'auth_config'])
  await table('nivaro_settings', ['anthropic_api_key', 'smtp_pass'])

  await db('nivaro_collections').insert([{ collection: 'orders' }, { collection: 'nivaro_users' }])
  await db('nivaro_fields').insert({ collection: 'orders', field: 'title', type: 'string' })
  await db('nivaro_workflow_templates').insert({ id: 'wf-1', name: 'Order flow' })
  await db('nivaro_workflow_states').insert({ id: 's-1', template: 'wf-1', key: 'new' })
  await db('nivaro_workflow_transitions').insert({
    id: 't-1',
    template: 'wf-1',
    label: 'Send',
    actions: JSON.stringify([
      {
        type: 'webhook',
        url: 'https://erp.example.com/hook',
        headers: { Authorization: 'Bearer transition-bearer-token-3e8f' },
        payload_template_key: 'mwf-status'
      }
    ])
  })
  await db('nivaro_workflow_bindings').insert({ template: 'wf-1', collection: 'orders' })
  await db('nivaro_rules').insert({
    collection: 'orders',
    name: 'Ping',
    trigger: 'update',
    enabled: '1',
    actions: JSON.stringify([
      {
        type: 'webhook',
        url: `https://bot:${SECRETS.urlPassword}@hooks.example.com/x?token=${SECRETS.queryToken}&q=1`
      }
    ])
  })
  await db('nivaro_roles').insert({
    id: '11111111-2222-4333-8444-555555555555',
    name: 'Clerk',
    admin_access: '0',
    app_access: '1'
  })
  await db('nivaro_policies').insert({
    role: '11111111-2222-4333-8444-555555555555',
    collection: 'orders',
    action: 'read',
    fields: '*'
  })
  await db('nivaro_flows').insert({
    id: '22222222-3333-4444-8555-666666666666',
    name: 'Notify ERP',
    status: 'active',
    trigger: 'schedule',
    trigger_options: JSON.stringify({ cron: '0 * * * *' })
  })
  await db('nivaro_flow_operations').insert({
    id: '33333333-4444-4555-8666-777777777777',
    flow: '22222222-3333-4444-8555-666666666666',
    name: 'Post',
    key: 'post',
    type: 'webhook',
    options: JSON.stringify({
      url: 'https://erp.example.com/api',
      method: 'POST',
      headers: { Authorization: SECRETS.flowAuth, 'X-Api-Key': SECRETS.flowKey }
    })
  })
  await db('nivaro_external_apis').insert({
    name: 'MWF',
    base_url: 'https://mwf.example.com',
    auth_config: JSON.stringify({
      type: 'api_key',
      key: SECRETS.apiKey,
      body_secrets: { token: SECRETS.bodySecret }
    })
  })
  db.on('query', (q: { sql: string }) => {
    const m = /from [`"]?([a-z_]+)/i.exec(q.sql)
    if (m) tablesRead.push(m[1])
  })
})

afterAll(async () => {
  await db.destroy()
})

describe('Hub clone export: no secret leaves the source', () => {
  it('empties every seeded credential before the bundle leaves', async () => {
    const out = await exportCloneBlueprint({ label: 'shop' })
    const json = JSON.stringify(out)
    for (const [name, value] of Object.entries(SECRETS))
      expect(json.includes(value), `${name} left the source`).toBe(false)
    // The flow step keeps its header NAMES (what to fill in on the clone), never their values.
    const op = out.package.blueprint.flows?.[0]?.operations[0]
    const opts = JSON.parse(String(op?.options)) as { headers: Record<string, string>; url: string }
    expect(opts.headers).toEqual({ Authorization: '', 'X-Api-Key': '' })
    expect(opts.url).toBe('https://erp.example.com/api')
    // A body secret travels as its placeholder only.
    expect(json).toContain('⟦nvr-secret:token⟧')
    expect(out.scrubbed.length).toBeGreaterThanOrEqual(5)
    expect(out.scrubbed.join(' ')).not.toMatch(/value-/)
  })

  it('never reads the external API configurations or the settings', () => {
    expect(tablesRead).not.toContain('nivaro_external_apis')
    expect(tablesRead).not.toContain('nivaro_settings')
    expect(tablesRead).not.toContain('nivaro_users')
  })

  it('brings roles and flows, flows inactive, rules switched off, no system collections', async () => {
    const { package: pkg } = await exportCloneBlueprint({ label: 'shop' })
    const bp = pkg.blueprint
    expect(bp.collections.map((c) => c.meta.collection)).toEqual(['orders'])
    expect(bp.roles?.map((r) => r.role.name)).toEqual(['Clerk'])
    expect(bp.roles?.[0].policies).toHaveLength(1)
    expect(bp.flows?.map((f) => f.flow.status)).toEqual(['inactive'])
    expect(bp.rules.map((r) => r.enabled)).toEqual([false])
    expect(pkg.manifest.counts.roles).toBe(1)
    expect(pkg.manifest.counts.flows).toBe(1)
  })
})
