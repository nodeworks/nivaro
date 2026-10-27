import { beforeEach, describe, expect, it, vi } from 'vitest'

// knex-shaped fake: records builder calls per table, resolves queued rows.
const state = vi.hoisted(() => ({
  calls: [] as Array<[string, string, unknown[]]>,
  rows: new Map<string, unknown[]>()
}))

function chain(table: string): unknown {
  const proxy: unknown = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === 'then') {
          const rows = (state.rows.get(table) ?? []).shift()
          return (res: (v: unknown) => void) => res(rows)
        }
        return (...args: unknown[]) => {
          state.calls.push([table, prop, args])
          return proxy
        }
      }
    }
  )
  return proxy
}

vi.mock('../../../db/index.js', () => ({ db: (t: string) => chain(t) }))

import { recordEntraIdentity } from '../../../services/users.js'

const OID = '11111111-1111-1111-1111-111111111111'
const TID = '22222222-2222-2222-2222-222222222222'
const updates = () => state.calls.filter(([, m]) => m === 'update')

beforeEach(() => {
  state.calls = []
  state.rows = new Map()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

describe('recordEntraIdentity', () => {
  it('stores oid and tid when the user has none', async () => {
    state.rows.set('nivaro_users', [{ entra_oid: null }, undefined])
    expect(await recordEntraIdentity('u1', OID, TID)).toBe('stored')
    expect(updates()).toHaveLength(1)
    expect(updates()[0][2][0]).toEqual({ entra_oid: OID, entra_tid: TID })
  })

  it('same oid again is a no-op', async () => {
    state.rows.set('nivaro_users', [{ entra_oid: OID, entra_tid: TID }])
    expect(await recordEntraIdentity('u1', OID, TID)).toBe('same')
    expect(updates()).toHaveLength(0)
  })

  it('refuses an oid already held by another user', async () => {
    state.rows.set('nivaro_users', [{ entra_oid: null }, { id: 'u2' }])
    expect(await recordEntraIdentity('u1', OID, TID)).toBe('conflict')
    expect(updates()).toHaveLength(0)
  })

  it('refuses a different oid for a user who already has one', async () => {
    state.rows.set('nivaro_users', [{ entra_oid: 'other-oid' }])
    expect(await recordEntraIdentity('u1', OID, TID)).toBe('conflict')
    expect(updates()).toHaveLength(0)
    expect(console.warn).toHaveBeenCalledTimes(1)
  })
})
