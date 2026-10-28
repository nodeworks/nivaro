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

const voided = vi.hoisted(() => ({ users: new Set<string>() }))
vi.mock('../../../services/edit-lock.js', () => ({
  lockHolderVerdict: async (holder: string) =>
    voided.users.has(holder)
      ? { locked: true, allowed: false, message: 'This record is at Level 1.' }
      : { locked: false, allowed: true, message: '' }
}))

import { editLockRefusal } from '../../../services/item-lock-guard.js'
import { setLockPresenceProbe } from '../../../services/lock-presence.js'

/** A lock row as the table holds it: taken `takenAgoMs` ago, last heartbeat `beatAgoMs` ago, 30 s lease. */
const held = (user: string, beatAgoMs = 2_000, takenAgoMs = 120_000) => ({
  user,
  locked_at: new Date(Date.now() - takenAgoMs),
  expires_at: new Date(Date.now() - beatAgoMs + 30_000)
})

const person = (id: string, authMethod = 'session') => ({ user: { id }, authMethod }) as never

describe('editLockRefusal', () => {
  beforeEach(() => {
    for (const k of Object.keys(rows)) delete rows[k]
    rows.nivaro_collections = { item_locking_enabled: 1 }
    rows.nivaro_users = { first_name: 'Andy', last_name: 'Francis', email: 'a@x' }
    voided.users.clear()
    setLockPresenceProbe(null)
  })

  it('ignores a lock its holder may no longer use (record moved into a step they do not own)', async () => {
    rows.nivaro_item_locks = held('U-BRYAN')
    expect((await editLockRefusal(person('u-peter'), 'workflows', '372793'))?.status).toBe(409)
    voided.users.add('U-BRYAN')
    expect(await editLockRefusal(person('u-peter'), 'workflows', '372793')).toBeNull()
  })

  it('refuses a save over a record someone else holds, naming them', async () => {
    rows.nivaro_item_locks = held('U-ANDY')
    const r = await editLockRefusal(person('u-howard'), 'workflows', '372704')
    expect(r?.status).toBe(409)
    expect(r?.body.code).toBe('RECORD_LOCKED')
    expect(r?.body.locked_by_name).toBe('Andy Francis')
    expect(r?.body.error).toContain('Andy Francis is editing this record')
  })

  it('lets the holder (any of their tabs, any id case) and a free record through', async () => {
    rows.nivaro_item_locks = held('U-ANDY')
    expect(await editLockRefusal(person('u-andy'), 'workflows', '1')).toBeNull()
    rows.nivaro_item_locks = undefined
    expect(await editLockRefusal(person('u-howard'), 'workflows', '1')).toBeNull()
  })

  it('never binds integrations or connected apps, system tables, or a collection with locking off', async () => {
    rows.nivaro_item_locks = held('U-ANDY')
    expect(await editLockRefusal(person('u-svc', 'api_key'), 'workflows', '1')).toBeNull()
    expect(await editLockRefusal(person('u-svc', 'oauth'), 'workflows', '1')).toBeNull()
    expect(await editLockRefusal(person('u-howard'), 'nivaro_help_videos', '1')).toBeNull()
    rows.nivaro_collections = { item_locking_enabled: 0 }
    expect(await editLockRefusal(person('u-howard'), 'workflows', '1')).toBeNull()
  })

  describe('a lock counts only while its holder is still here (2026-10-28)', () => {
    it('a live heartbeat still refuses the write (and the transition — same gate)', async () => {
      rows.nivaro_item_locks = held('U-ETIEN', 5_000)
      const r = await editLockRefusal(person('u-approver'), 'inventory_request', '42')
      expect(r?.status).toBe(409)
      expect(r?.body.code).toBe('RECORD_LOCKED')
    })

    it('a lapsed heartbeat (lease over) refuses nobody', async () => {
      rows.nivaro_item_locks = held('U-ETIEN', 31_000)
      expect(await editLockRefusal(person('u-approver'), 'inventory_request', '42')).toBeNull()
    })

    it('a holder the realtime view knows has left holds nothing, even inside the lease', async () => {
      setLockPresenceProbe((id) => id !== 'U-ETIEN')
      rows.nivaro_item_locks = held('U-ETIEN', 8_000)
      expect(await editLockRefusal(person('u-approver'), 'inventory_request', '42')).toBeNull()
      // Still connected: the lock holds.
      setLockPresenceProbe(() => true)
      expect((await editLockRefusal(person('u-approver'), 'inventory_request', '42'))?.status).toBe(
        409
      )
    })

    it('presence unknown (board stale, Redis away) = the heartbeat rule alone', async () => {
      setLockPresenceProbe(() => null)
      rows.nivaro_item_locks = held('U-ETIEN', 8_000)
      expect((await editLockRefusal(person('u-approver'), 'inventory_request', '42'))?.status).toBe(
        409
      )
      rows.nivaro_item_locks = held('U-ETIEN', 40_000)
      expect(await editLockRefusal(person('u-approver'), 'inventory_request', '42')).toBeNull()
    })

    it('a just-taken lock or a seconds-old heartbeat is never judged by presence', async () => {
      setLockPresenceProbe(() => false)
      rows.nivaro_item_locks = held('U-ETIEN', 1_000, 5_000)
      expect((await editLockRefusal(person('u-approver'), 'inventory_request', '42'))?.status).toBe(
        409
      )
      rows.nivaro_item_locks = held('U-ETIEN', 1_000)
      expect((await editLockRefusal(person('u-approver'), 'inventory_request', '42'))?.status).toBe(
        409
      )
    })
  })
})
