import knexFactory, { type Knex } from 'knex'
import { afterEach, describe, expect, it } from 'vitest'
import { readLedger } from '../../../services/tenancy/app-status.js'

// Hub phase 6, ruling P6-11b: the deployment's db-check tells "no ledger table", "an empty
// ledger", "an install" and "could not read it" apart, so the Hub never takes a read error for
// an empty database (place-shared would then generate a key over an install's sealed values).

let k: Knex | null = null
const open = () => {
  k = knexFactory({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true
  })
  return k
}

afterEach(async () => {
  await k?.destroy()
  k = null
})

describe('readLedger', () => {
  it('absent: no nivaro_migrations table', async () => {
    expect(await readLedger(open())).toEqual({ ledger: null, state: 'absent' })
  })

  it('empty: the table with no rows', async () => {
    const db = open()
    await db.schema.createTable('nivaro_migrations', (t) => {
      t.increments('id')
      t.string('name')
    })
    expect(await readLedger(db)).toEqual({ ledger: { count: 0, latest: null }, state: 'empty' })
  })

  it('present: rows (an install)', async () => {
    const db = open()
    await db.schema.createTable('nivaro_migrations', (t) => {
      t.increments('id')
      t.string('name')
    })
    await db('nivaro_migrations').insert([{ name: '001_init' }, { name: '551_hub_signins' }])
    expect(await readLedger(db)).toEqual({
      ledger: { count: 2, latest: '551_hub_signins' },
      state: 'present'
    })
  })

  it('error: the read throws — never "absent" or "empty"', async () => {
    // The table is there, but reading it fails (a lock timeout, missing rights, a dropped link).
    const failing = Object.assign(
      () => {
        throw new Error('permission denied for table nivaro_migrations')
      },
      { schema: { hasTable: async () => true } }
    ) as unknown as Knex
    expect(await readLedger(failing)).toEqual({ ledger: null, state: 'error' })
    // hasTable itself failing is the same.
    const noSchema = Object.assign(() => undefined, {
      schema: {
        hasTable: async () => {
          throw new Error('timeout')
        }
      }
    }) as unknown as Knex
    expect(await readLedger(noSchema)).toEqual({ ledger: null, state: 'error' })
  })
})

describe('the Hub client reads ledger_state', () => {
  it('keeps a known state and leaves out anything else', async () => {
    const { deploymentClient } = await import('../../../services/hub/shared/deployment-client.js')
    const answer = (body: unknown) =>
      deploymentClient(
        { id: 1, link_url: 'https://shared-one.internal.example.com' },
        {
          tokens: async () => ({ current: 't'.repeat(43), previous: null }),
          fetch: (async () =>
            new Response(JSON.stringify(body), {
              status: 200,
              headers: { 'content-type': 'application/json' }
            })) as typeof fetch
        }
      ).dbCheck({ client: 'pg', connection: 'postgres://u:p@h/db' })
    const base = { reachable: true, ledger: null, db_identity: null, error: null }
    expect((await answer({ ...base, ledger_state: 'error' })).ledger_state).toBe('error')
    expect((await answer({ ...base, ledger_state: 'absent' })).ledger_state).toBe('absent')
    expect('ledger_state' in (await answer({ ...base, ledger_state: 'maybe' }))).toBe(false)
    expect('ledger_state' in (await answer(base))).toBe(false)
  })
})
