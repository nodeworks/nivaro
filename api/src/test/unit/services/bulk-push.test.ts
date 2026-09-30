import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── Mocks: no database, no partner — every send is a stub ─────────────────────
const state = vi.hoisted(() => ({
  submissions: [] as Array<Record<string, unknown>>,
  apis: [] as Array<{ id: number; name: string }>,
  unreadable: new Set<string>(),
  actions: new Map<string, Record<string, unknown>>(),
  retry: vi.fn(),
  log: vi.fn()
}))

vi.mock('../../../db/index.js', () => {
  const chain = (rows: () => unknown[]) => {
    const c: Record<string, unknown> = {}
    for (const m of ['where', 'whereIn', 'orderBy', 'select']) c[m] = () => c
    // biome-ignore lint/suspicious/noThenProperty: a knex query builder is a thenable
    c.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      Promise.resolve(rows()).then(res, rej)
    return c
  }
  const db = (table: string) => {
    if (table === 'nivaro_erp_submissions') return chain(() => state.submissions)
    if (table === 'nivaro_external_apis') return chain(() => state.apis)
    return chain(() => [])
  }
  return { db }
})
vi.mock('../../../services/items.js', () => ({
  readOne: async (_u: unknown, _c: string, id: string) =>
    state.unreadable.has(String(id)) ? null : { id }
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: state.log }))
vi.mock('../../../extensions/item-actions.js', () => ({
  itemActionRegistry: {
    get: (id: string) => state.actions.get(id),
    list: () => [...state.actions.values()]
  }
}))
vi.mock('../../../routes/erp-submissions.js', () => ({ retrySubmissionRow: state.retry }))

import {
  latestPerPartner,
  retryFailedPushes,
  runItemActionOver
} from '../../../services/bulk-push.js'

const req = { user: { id: 'U1', role: 'R1' }, isAdmin: false } as never

beforeEach(() => {
  state.submissions = []
  state.apis = [
    { id: 1, name: 'Partner A' },
    { id: 2, name: 'Partner B' }
  ]
  state.unreadable = new Set()
  state.actions = new Map()
  state.retry.mockReset()
  state.log.mockReset()
})

describe('runItemActionOver (#620 push)', () => {
  it('refuses an unknown action and one that does not apply to the collection', async () => {
    await expect(
      runItemActionOver({ actionId: 'nope', collection: 'orders', ids: ['1'], req })
    ).rejects.toMatchObject({ statusCode: 404 })
    state.actions.set('push-a', { id: 'push-a', label: 'Push to A', collections: ['other'] })
    await expect(
      runItemActionOver({ actionId: 'push-a', collection: 'orders', ids: ['1'], req })
    ).rejects.toMatchObject({ statusCode: 400 })
  })

  it('runs per record with the form button gates and reports every outcome', async () => {
    const execute = vi.fn(async ({ itemId }: { itemId: string }) => {
      if (itemId === '4') throw new Error('Partner said no')
      return { message: `sent ${itemId}` }
    })
    state.actions.set('push-a', {
      id: 'push-a',
      label: 'Push to A',
      applicable: async ({ itemId }: { itemId: string }) => {
        if (itemId === '5') throw new Error('broken check')
        return itemId !== '3'
      },
      execute
    })
    state.unreadable.add('2')
    const r = await runItemActionOver({
      actionId: 'push-a',
      collection: 'orders',
      ids: ['1', '2', '3', '4', '5'],
      payload: { message: 'note' },
      req
    })
    expect(r.outcomes.map((o) => [o.item, o.outcome])).toEqual([
      ['1', 'change'],
      ['2', 'fail'],
      ['3', 'skip'],
      ['4', 'fail'],
      ['5', 'change'] // a broken applicable() counts as applicable, as on the form
    ])
    expect(r.outcomes[0].reason).toBe('sent 1')
    expect(r.outcomes[3].reason).toBe('Partner said no')
    expect(execute).toHaveBeenCalledTimes(3)
    expect(execute.mock.calls[0][0]).toMatchObject({ payload: { message: 'note' }, userId: 'U1' })
    expect(r).toMatchObject({ succeeded: 2, failed: 2, skipped: 1 })
  })

  it('a dry run classifies without executing', async () => {
    const execute = vi.fn()
    state.actions.set('push-a', { id: 'push-a', label: 'Push to A', execute })
    const r = await runItemActionOver({
      actionId: 'push-a',
      collection: 'orders',
      ids: ['1', '2'],
      req,
      dryRun: true
    })
    expect(execute).not.toHaveBeenCalled()
    expect(r.succeeded).toBe(2)
    expect(state.log).not.toHaveBeenCalled()
  })
})

describe('latestPerPartner', () => {
  it('keeps the newest row per (record, partner) from a newest-first list', () => {
    const rows = [
      { id: 9, item: '1', external_api: 1, status: 'accepted' },
      { id: 8, item: '1', external_api: 2, status: 'failed' },
      { id: 7, item: '1', external_api: 1, status: 'failed' },
      { id: 6, item: '2', external_api: 1, status: 'failed' }
    ] as never
    const m = latestPerPartner(rows)
    expect(m.get('1')?.map((r) => r.id)).toEqual([9, 8])
    expect(m.get('2')?.map((r) => r.id)).toEqual([6])
  })
})

describe('retryFailedPushes (#620 retry)', () => {
  it('retries only partners whose latest push failed; skips the rest with a reason', async () => {
    state.submissions = [
      { id: 12, item: '1', external_api: 1, status: 'accepted', attempts: 1 },
      { id: 11, item: '1', external_api: 2, status: 'failed', attempts: 2 },
      { id: 10, item: '2', external_api: 1, status: 'pending', attempts: 1 },
      { id: 9, item: '3', external_api: 1, status: 'failed', attempts: 1 },
      { id: 5, item: '2', external_api: 1, status: 'failed', attempts: 1 }
    ]
    state.retry.mockImplementation(async (row: { id: number }) =>
      row.id === 9
        ? { status: 'failed', error: 'HTTP 500: down' }
        : { status: 'accepted', error: null }
    )
    const r = await retryFailedPushes({ collection: 'orders', ids: ['1', '2', '3', '4'], req })
    expect(state.retry).toHaveBeenCalledTimes(2)
    expect(state.retry.mock.calls.map((c) => (c[0] as { id: number }).id)).toEqual([11, 9])
    const by = Object.fromEntries(r.outcomes.map((o) => [o.item, o]))
    expect(by['1']).toMatchObject({ outcome: 'change' })
    expect(by['1'].reason).toContain('Partner B: accepted')
    expect(by['2']).toMatchObject({ outcome: 'skip', reason: 'no failed push' })
    expect(by['3']).toMatchObject({ outcome: 'fail' })
    expect(by['3'].reason).toContain('HTTP 500')
    expect(by['4']).toMatchObject({ outcome: 'skip', reason: 'never pushed' })
  })

  it('a dry run names the partners it would retry and sends nothing', async () => {
    state.submissions = [{ id: 3, item: '1', external_api: 2, status: 'rejected', attempts: 1 }]
    const r = await retryFailedPushes({ collection: 'orders', ids: ['1'], req, dryRun: true })
    expect(state.retry).not.toHaveBeenCalled()
    expect(r.outcomes[0]).toMatchObject({ outcome: 'change', reason: 'would retry Partner B' })
  })

  it('never retries a record the caller cannot read', async () => {
    state.submissions = [{ id: 3, item: '1', external_api: 1, status: 'failed', attempts: 1 }]
    state.unreadable.add('1')
    const r = await retryFailedPushes({ collection: 'orders', ids: ['1'], req })
    expect(state.retry).not.toHaveBeenCalled()
    expect(r.outcomes[0].outcome).toBe('fail')
  })
})
