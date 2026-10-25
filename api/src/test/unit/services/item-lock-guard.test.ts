import { beforeEach, describe, expect, it, vi } from 'vitest'

// Per table: what `.first()` answers. A chain records nothing — the guard's
// questions are which row exists, not how the SQL reads.
const rows: Record<string, unknown> = {}
vi.mock('../../../db/index.js', () => ({
  db: vi.fn((table: string) => {
    const chain: Record<string, unknown> = {}
    for (const m of ['where', 'select']) chain[m] = () => chain
    chain.first = () => Promise.resolve(rows[table])
    return chain
  })
}))

import { editLockRefusal } from '../../../services/item-lock-guard.js'

const person = (id: string, authMethod = 'session') => ({ user: { id }, authMethod }) as never

describe('editLockRefusal', () => {
  beforeEach(() => {
    for (const k of Object.keys(rows)) delete rows[k]
    rows.nivaro_collections = { item_locking_enabled: 1 }
    rows.nivaro_users = { first_name: 'Andy', last_name: 'Francis', email: 'a@x' }
  })

  it('refuses a save over a record someone else holds, naming them', async () => {
    rows.nivaro_item_locks = { user: 'U-ANDY' }
    const r = await editLockRefusal(person('u-howard'), 'workflows', '372704')
    expect(r?.status).toBe(409)
    expect(r?.body.code).toBe('RECORD_LOCKED')
    expect(r?.body.locked_by_name).toBe('Andy Francis')
    expect(r?.body.error).toContain('Andy Francis is editing this record')
  })

  it('lets the holder (any of their tabs, any id case) and a free record through', async () => {
    rows.nivaro_item_locks = { user: 'U-ANDY' }
    expect(await editLockRefusal(person('u-andy'), 'workflows', '1')).toBeNull()
    rows.nivaro_item_locks = undefined
    expect(await editLockRefusal(person('u-howard'), 'workflows', '1')).toBeNull()
  })

  it('never binds integrations or connected apps, system tables, or a collection with locking off', async () => {
    rows.nivaro_item_locks = { user: 'U-ANDY' }
    expect(await editLockRefusal(person('u-svc', 'api_key'), 'workflows', '1')).toBeNull()
    expect(await editLockRefusal(person('u-svc', 'oauth'), 'workflows', '1')).toBeNull()
    expect(await editLockRefusal(person('u-howard'), 'nivaro_help_videos', '1')).toBeNull()
    rows.nivaro_collections = { item_locking_enabled: 0 }
    expect(await editLockRefusal(person('u-howard'), 'workflows', '1')).toBeNull()
  })
})
