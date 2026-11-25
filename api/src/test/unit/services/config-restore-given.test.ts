import type { Knex } from 'knex'
import { afterEach, describe, expect, it } from 'vitest'
import { runWithTenantDb } from '../../../db/tenant-context.js'
import type { ConfigSnapshot } from '../../../services/config-inventory.js'
import {
  applyGivenSnapshot,
  previewGivenSnapshot,
  RestoreError,
  restoreEngineSupported
} from '../../../services/config-restore.js'

// Hub config promotion reuses the restore engine with a snapshot handed in. On one app of a Hub
// shared deployment the engine judges (and would use) THAT app's database, never the deployment's
// own DB_* connection: a Postgres app is refused before anything is read.

const saved = { ...process.env }
afterEach(() => {
  process.env = { ...saved }
})

const fake = (client: string) => ({ client: { config: { client } } }) as unknown as Knex
const inApp = <T>(client: string, fn: () => Promise<T> | T): Promise<T> =>
  new Promise((resolve, reject) =>
    runWithTenantDb(
      fake(client),
      'app-a',
      () => {
        Promise.resolve().then(fn).then(resolve, reject)
      },
      'app-a-e1'
    )
  )

const snap: ConfigSnapshot = {
  format: 1,
  generated_at: '2026-11-25T00:00:00.000Z',
  instance: { version: '0.3.215', environment: 'staging', database: '' },
  classification: { config: [], derived: [], runtime: [], unclassified: [], absent: [] },
  tables: {},
  errors: {}
}

describe('restore engine on a Hub shared deployment', () => {
  it('judges the app’s own database engine', async () => {
    process.env.HUB_SHARED_DEPLOYMENT = 'shared-a'
    expect(await inApp('mssql', () => restoreEngineSupported())).toBe(true)
    expect(await inApp('pg', () => restoreEngineSupported())).toBe(false)
  })

  it('refuses a Postgres app before reading anything (plan and apply)', async () => {
    process.env.HUB_SHARED_DEPLOYMENT = 'shared-a'
    const err = await inApp('pg', () =>
      previewGivenSnapshot(snap, { ref: 'x', deletes: false }).catch((e) => e)
    )
    expect(err).toBeInstanceOf(RestoreError)
    expect((err as RestoreError).code).toBe('NOT_SUPPORTED_ON_DATABASE')
    const err2 = await inApp('pg', () =>
      applyGivenSnapshot(snap, {
        ref: 'x',
        deletes: false,
        planHash: 'a'.repeat(64),
        note: 'n',
        activityNote: 'a'
      }).catch((e) => e)
    )
    expect((err2 as RestoreError).status).toBe(501)
  })
})
