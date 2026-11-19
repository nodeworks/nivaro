import { afterEach, describe, expect, it } from 'vitest'
import {
  cellLockKey,
  decodeCellLock,
  encodeCellLock,
  memoryCellLockStore,
  readCellLocks,
  releaseCellLock,
  takeCellLock
} from '../../../services/cell-locks.js'
import {
  LOCK_LIVE_MS,
  resetLockPresenceMemory,
  setLockPresenceProbe
} from '../../../services/lock-presence.js'

const beth = { id: 'U-BETH', name: 'Beth Lee' }
const mark = { id: 'U-MARK', name: 'Mark Li' }

afterEach(() => setLockPresenceProbe(null))

describe('cell locks — keys and values', () => {
  it('key carries tenant, collection, row and field', () => {
    expect(cellLockKey('orders', '7', 'qty', 't1')).toBe('nvr:cell-lock:t1:orders:7:qty')
  })

  it('round-trips and refuses garbage', () => {
    const v = { user: 'U', name: 'N', locked_at: 'a', expires_at: 'b' }
    expect(decodeCellLock(encodeCellLock(v))).toEqual(v)
    expect(decodeCellLock('no-newline')).toBeNull()
    expect(decodeCellLock('U\n{bad')).toBeNull()
  })
})

describe('cell locks — lease rules', () => {
  it('the first person holds the cell; a second is told who', async () => {
    let now = 1_000_000
    const store = memoryCellLockStore(() => now)
    const key = cellLockKey('orders', '7', 'qty', '')
    expect(await takeCellLock(store, key, beth, now)).toEqual({ ok: true })
    const r = await takeCellLock(store, key, mark, now)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.holder.name).toBe('Beth Lee')
    // A renewal by the holder keeps when she started.
    now += 5_000
    expect(await takeCellLock(store, key, beth, now)).toEqual({ ok: true })
    const [held] = await readCellLocks(
      store,
      'orders',
      [{ id: '7', field: 'qty' }],
      mark.id,
      now,
      ''
    )
    expect(held).toMatchObject({
      name: 'Beth Lee',
      mine: false,
      since: new Date(1_000_000).toISOString()
    })
  })

  it('a lapsed lease is free again', async () => {
    let now = 2_000_000
    const store = memoryCellLockStore(() => now)
    const key = cellLockKey('orders', '7', 'qty', '')
    await takeCellLock(store, key, beth, now)
    now += LOCK_LIVE_MS + 1
    expect(await takeCellLock(store, key, mark, now)).toEqual({ ok: true })
  })

  it('a holder known to have left loses the cell inside the lease', async () => {
    let now = 3_000_000
    const store = memoryCellLockStore(() => now)
    const key = cellLockKey('orders', '7', 'qty', '')
    await takeCellLock(store, key, beth, now)
    resetLockPresenceMemory(0) // this process has been judging for ages
    // Gone for the whole absence window (realtime audit H1): last beat 22 s ago, no connection.
    now += 22_000
    setLockPresenceProbe((u) => (u === beth.id ? false : true))
    const read = await readCellLocks(store, 'orders', [{ id: '7', field: 'qty' }], mark.id, now, '')
    expect(read).toEqual([])
    expect(await takeCellLock(store, key, mark, now)).toEqual({ ok: true })
  })

  it('only the holder releases', async () => {
    const now = 4_000_000
    const store = memoryCellLockStore(() => now)
    const key = cellLockKey('orders', '7', 'qty', '')
    await takeCellLock(store, key, beth, now)
    expect(await releaseCellLock(store, key, mark.id)).toBe(false)
    expect(await releaseCellLock(store, key, beth.id)).toBe(true)
    expect(
      await readCellLocks(store, 'orders', [{ id: '7', field: 'qty' }], mark.id, now, '')
    ).toEqual([])
  })

  it('reads mark the viewer’s own cells', async () => {
    const now = 5_000_000
    const store = memoryCellLockStore(() => now)
    await takeCellLock(store, cellLockKey('orders', '7', 'qty', ''), beth, now)
    await takeCellLock(store, cellLockKey('orders', '8', 'price', ''), mark, now)
    const read = await readCellLocks(
      store,
      'orders',
      [
        { id: '7', field: 'qty' },
        { id: '7', field: 'price' },
        { id: '8', field: 'price' }
      ],
      beth.id,
      now,
      ''
    )
    expect(read.map((r) => [r.id, r.field, r.mine])).toEqual([
      ['7', 'qty', true],
      ['8', 'price', false]
    ])
  })
})
