import { createTestDb } from '@nivaro/extension-kit'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({
  MIGRATION_LOCK_NAME: 'nivaro_migrations',
  PG_LOCK_KEY: 1
}))
vi.mock('../../../version.js', () => ({ NIVARO_VERSION: '9.9.9' }))

import {
  clearSchemaSteps,
  declareSchemaStep,
  runSchemaChecks,
  runSchemaSteps,
  schemaStepStatus
} from '../../../services/extension-schema-steps.js'

const TABLE = 'nivaro_extension_schema_steps'

/** listSchema over the fake db: one line per table the fake holds. */
const listFake = (knex: unknown) => async () =>
  new Set(
    Object.keys((knex as { state: { tables: Record<string, unknown> } }).state.tables).map(
      (t) => `table ${t}`
    )
  )

describe('extension schema steps (#826)', () => {
  beforeEach(() => clearSchemaSteps())

  it('refuses a bad id, a missing up() and a duplicate id', () => {
    expect(() =>
      declareSchemaStep('ext', { id: 'no space', description: '', up: async () => {} })
    ).toThrow(/kebab/)
    expect(() => declareSchemaStep('ext', { id: 'a', description: '' } as never)).toThrow(/up\(\)/)
    declareSchemaStep('ext', { id: 'a', description: '', up: async () => {} })
    expect(() =>
      declareSchemaStep('ext', { id: 'a', description: '', up: async () => {} })
    ).toThrow(/twice/)
  })

  it('runs steps in order once, records the diff, and never re-runs an applied step', async () => {
    const db = createTestDb()
    const ran: string[] = []
    declareSchemaStep('ext', {
      id: 'one',
      description: 'first',
      up: async (t) => {
        ran.push('one')
        ;(t as unknown as typeof db).state.tables.efp_thing = []
      },
      check: async (t) => t.schema.hasTable('efp_thing')
    })
    declareSchemaStep('ext', {
      id: 'two',
      description: 'second',
      up: async () => {
        ran.push('two')
      }
    })
    const first = await runSchemaSteps('ext', db, { listSchema: listFake(db) })
    expect(first).toEqual({ applied: ['one', 'two'], skipped: [], failed: [] })
    expect(ran).toEqual(['one', 'two'])
    const rows = db.state.tables[TABLE]
    expect(rows.map((r) => [r.step, r.status, r.schema_changed, r.summary])).toEqual([
      ['one', 'applied', true, '+1 table'],
      ['two', 'applied', false, expect.stringMatching(/No schema change/)]
    ])
    expect(rows[0].check_ok).toBe(true)
    expect(rows[0].app_version).toBe('9.9.9')

    const again = await runSchemaSteps('ext', db, { listSchema: listFake(db) })
    expect(again).toEqual({ applied: [], skipped: ['one', 'two'], failed: [] })
    expect(ran).toEqual(['one', 'two'])
  })

  it('a throwing step is recorded as error, stops later steps, and is retried next time', async () => {
    const db = createTestDb()
    let fail = true
    declareSchemaStep('ext', {
      id: 'flaky',
      description: '',
      up: async () => {
        if (fail) throw new Error('column already exists')
      }
    })
    declareSchemaStep('ext', { id: 'after', description: '', up: async () => {} })
    const r1 = await runSchemaSteps('ext', db, { listSchema: listFake(db) })
    expect(r1.failed).toEqual([{ step: 'flaky', error: 'column already exists' }])
    expect(r1.applied).toEqual([])
    expect(schemaStepStatus('ext').map((s) => [s.step, s.status])).toEqual([
      ['flaky', 'error'],
      ['after', 'pending']
    ])
    fail = false
    const r2 = await runSchemaSteps('ext', db, { listSchema: listFake(db) })
    expect(r2.applied).toEqual(['flaky', 'after'])
    expect(schemaStepStatus('ext').every((s) => s.status === 'applied')).toBe(true)
  })

  it('a check that no longer finds what the step built reports drift', async () => {
    const db = createTestDb()
    declareSchemaStep('ext', {
      id: 'tbl',
      description: '',
      up: async (t) => {
        ;(t as unknown as typeof db).state.tables.efp_thing = []
      },
      check: async (t) =>
        (await t.schema.hasTable('efp_thing'))
          ? { ok: true }
          : { ok: false, detail: 'efp_thing gone' }
    })
    await runSchemaSteps('ext', db, { listSchema: listFake(db) })
    expect(schemaStepStatus('ext')[0].check_ok).toBe(true)
    delete db.state.tables.efp_thing
    const after = await runSchemaChecks('ext')
    expect(after[0]).toMatchObject({
      status: 'applied',
      check_ok: false,
      check_detail: 'efp_thing gone'
    })
  })
})
