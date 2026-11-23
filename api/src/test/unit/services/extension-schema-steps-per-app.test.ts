import { createTestDb } from '@nivaro/extension-kit'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Hub phase 6 Task 8 (rulings R5 / P6-8 I-1): on a shared deployment the schema-step bookkeeping is
// kept per app, and a replica that did not run an app's steps itself (it adopted the app's `ok`
// from Redis, or restarted) still reads that app's ledger from the app's own database.

vi.mock('../../../db/index.js', () => ({
  MIGRATION_LOCK_NAME: 'nivaro_migrations',
  PG_LOCK_KEY: 1
}))
vi.mock('../../../version.js', () => ({ NIVARO_VERSION: '9.9.9' }))

import type { Knex } from 'knex'
import { runWithTenantDb } from '../../../db/tenant-context.js'
import {
  clearSchemaSteps,
  declareSchemaStep,
  runSchemaChecks,
  runSchemaSteps,
  schemaStepStatus
} from '../../../services/extension-schema-steps.js'

const listFake = (knex: unknown) => async () =>
  new Set(
    Object.keys((knex as { state: { tables: Record<string, unknown> } }).state.tables).map(
      (t) => `table ${t}`
    )
  )

/** Run `fn` inside app `id` whose database is `k`, as the tenant hook does. */
function inApp<T>(id: string, k: unknown, fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) =>
    runWithTenantDb(k as Knex, id, () => void fn().then(resolve, reject), id)
  )
}

function declare() {
  declareSchemaStep('ext', {
    id: 'marker',
    description: 'marker table',
    up: async (t) => {
      ;(t as unknown as { state: { tables: Record<string, unknown[]> } }).state.tables.marker = []
    },
    check: async (t) => t.schema.hasTable('marker')
  })
}

beforeEach(() => clearSchemaSteps())

describe('schema steps per app', () => {
  it("keeps each app's ledger state apart (R5)", async () => {
    declare()
    const a = createTestDb()
    const b = createTestDb()
    await inApp('app-a', a, () => runSchemaSteps('ext', a as never, { listSchema: listFake(a) }))
    expect((await inApp('app-a', a, async () => schemaStepStatus('ext')))[0].status).toBe('applied')
    // app B never ran it: its own state, not app A's
    expect((await inApp('app-b', b, async () => schemaStepStatus('ext')))[0].status).toBe('pending')
  })

  it('a replica that did not run the steps reads the ledger from the app database (I-1)', async () => {
    declare()
    const a = createTestDb()
    // "replica 1" runs the app's steps
    await inApp('app-a', a, () => runSchemaSteps('ext', a as never, { listSchema: listFake(a) }))
    // "replica 2": a fresh process (state reset), the steps declared again at load, never run here
    clearSchemaSteps()
    declare()
    const st = await inApp('app-a', a, () => runSchemaChecks('ext'))
    expect(st[0]).toMatchObject({ status: 'applied', check_ok: true })
  })

  it('outside any app (self-hosted) the boot database is used, as before', async () => {
    declare()
    const db = createTestDb()
    await runSchemaSteps('ext', db as never, { listSchema: listFake(db) })
    expect((await runSchemaChecks('ext'))[0].status).toBe('applied')
  })
})
