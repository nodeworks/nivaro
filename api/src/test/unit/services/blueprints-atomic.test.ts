import type { Knex } from 'knex'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// Hub enhancement 24, review M5: with `atomic`, a workflow goes in with its states and transitions
// or not at all, so a retry that skips "existing" workflows never leaves one without its states.
// Every part reports its outcome.

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

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const { installBlueprint } = await import('../../../services/blueprints.js')

beforeAll(async () => {
  await db.schema.createTable('nivaro_workflow_templates', (t) => {
    t.string('id').primary()
    t.string('name')
    t.dateTime('created_at')
    t.dateTime('updated_at')
  })
  await db.schema.createTable('nivaro_workflow_states', (t) => {
    t.string('id').primary()
    t.string('template')
    t.string('key').notNullable()
  })
  await db.schema.createTable('nivaro_workflow_transitions', (t) => {
    t.string('id').primary()
    t.string('template')
  })
  await db.schema.createTable('nivaro_workflow_bindings', (t) => {
    t.increments('id')
    t.string('template')
    t.string('collection')
  })
})
afterAll(async () => {
  await db.destroy()
})

const wf = (states: Array<Record<string, unknown>>) => ({
  type: 'nivaro-blueprint' as const,
  version: 1 as const,
  name: 'T',
  exported_at: 'x',
  collections: [],
  relations: [],
  workflows: [
    {
      template: { id: 'wf1', name: 'Flow' },
      states,
      transitions: [{ id: 't1', template: 'wf1' }],
      bindings: [{ template: 'wf1', collection: 'assets' }]
    }
  ],
  layouts: [],
  queues: [],
  rules: []
})

describe('installBlueprint atomic parts', () => {
  it('a failing child leaves no parent; the retry installs the whole workflow', async () => {
    const parts: Array<[string, boolean]> = []
    const first = await installBlueprint(wf([{ id: 's1', template: 'wf1', key: null }]), null, {
      atomic: true,
      onPart: (p, ok) => parts.push([p, ok])
    })
    expect(first.errors).toHaveLength(1)
    expect(parts).toEqual([['workflow:wf1', false]])
    expect(await db('nivaro_workflow_templates').count({ n: '*' })).toEqual([{ n: 0 }])
    expect(await db('nivaro_workflow_transitions').count({ n: '*' })).toEqual([{ n: 0 }])

    const second = await installBlueprint(wf([{ id: 's1', template: 'wf1', key: 'a' }]), null, {
      atomic: true
    })
    expect(second.workflows.created).toBe(1)
    expect(await db('nivaro_workflow_states').count({ n: '*' })).toEqual([{ n: 1 }])
    expect(await db('nivaro_workflow_bindings').count({ n: '*' })).toEqual([{ n: 1 }])
  })

  it('without atomic (an administrator’s own install) nothing changes in how it runs', async () => {
    const report = await installBlueprint(wf([{ id: 's2', template: 'wf1', key: 'b' }]), null)
    expect(report.workflows.skipped).toBe(1)
  })
})
