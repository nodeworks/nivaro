import type { Knex } from 'knex'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { db } from '../../../db/index.js'
import { recordObligation, resolveObligation } from '../../../services/integration-obligations.js'
import { reconcileKind } from '../../../services/integration-reconcile.js'
import { announceRecordAspect, announceRecordAspects } from '../../../services/record-events.js'

// rt-fix C / M1: every obligation ledger write tells the record's open pages (`$integrations`);
// the reconcile sweep folds a kind's changes into one notice.
vi.mock('../../../services/record-events.js', () => ({
  announceRecordAspect: vi.fn(),
  announceRecordAspects: vi.fn(() => ({ announced: 1, rejected: [] }))
}))
vi.mock('../../../services/integration-alerts.js', () => ({
  alertUnmetObligations: vi.fn(async () => ({ notified: 0 }))
}))
vi.mock('../../../services/integration-incidents.js', () => ({
  currentApiHealth: vi.fn(async () => []),
  recordIncidentFlips: vi.fn(async () => undefined)
}))
vi.mock('../../../services/integration-remediation.js', () => ({
  runRetryPass: vi.fn(async () => ({ retried: 0, gaveUp: 0 })),
  runMissingRefirePass: vi.fn(async () => ({ refired: 0, queued: 0 }))
}))

const mockedDb = () => vi.mocked(db as unknown as (table: string) => unknown)

function chain(extra: Record<string, unknown> = {}) {
  const c: Record<string, ReturnType<typeof vi.fn<(...args: any[]) => any>>> = {
    where: vi.fn(),
    whereIn: vi.fn(),
    orderBy: vi.fn(),
    update: vi.fn().mockResolvedValue(1)
  }
  for (const k of ['where', 'whereIn', 'orderBy']) c[k].mockReturnValue(c)
  return Object.assign(c, extra)
}

afterEach(() => vi.clearAllMocks())

describe('obligation ledger writes announce $integrations', () => {
  it('recordObligation announces the record it opened a row for', async () => {
    mockedDb().mockReturnValue({
      insert: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 3 }]) })
    } as never)
    await recordObligation({
      api: 'MWF',
      kind: 'ir.push',
      collection: 'inventory_request',
      item: 77,
      trigger: 'transition',
      outcome: 'skipped',
      reason: 'market not on MWF'
    })
    expect(announceRecordAspect).toHaveBeenCalledWith('inventory_request', 77, '$integrations')
  })

  it('recordObligation with announce:false stays quiet', async () => {
    mockedDb().mockReturnValue({
      insert: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 3 }]) })
    } as never)
    await recordObligation({
      api: 'MWF',
      kind: 'ir.push',
      collection: 'inventory_request',
      item: 77,
      trigger: 'reconcile',
      announce: false
    })
    expect(announceRecordAspect).not.toHaveBeenCalled()
  })

  it('a failed insert announces nothing', async () => {
    mockedDb().mockReturnValue({
      insert: vi.fn().mockReturnValue({ returning: vi.fn().mockRejectedValue(new Error('x')) })
    } as never)
    await recordObligation({
      api: 'MWF',
      kind: 'ir.push',
      collection: 'inventory_request',
      item: 1,
      trigger: 'transition'
    })
    expect(announceRecordAspect).not.toHaveBeenCalled()
  })

  it('resolveObligation looks the record up by id and announces it (the MWF skip path)', async () => {
    const c = chain({
      first: vi.fn().mockResolvedValue({ collection: 'inventory_request', item: '9' })
    })
    mockedDb().mockReturnValue(c as never)
    await resolveObligation(12, { outcome: 'skipped', reason: 'skip_sends rule' })
    expect(c.update).toHaveBeenCalled()
    expect(c.first).toHaveBeenCalledWith('collection', 'item')
    expect(announceRecordAspect).toHaveBeenCalledWith('inventory_request', '9', '$integrations')
  })

  it('resolveObligation uses a known target without a lookup', async () => {
    const c = chain({ first: vi.fn() })
    mockedDb().mockReturnValue(c as never)
    await resolveObligation(
      12,
      { outcome: 'sent' },
      { target: { collection: 'workflows', item: 5 } }
    )
    expect(c.first).not.toHaveBeenCalled()
    expect(announceRecordAspect).toHaveBeenCalledWith('workflows', 5, '$integrations')
  })

  it('resolveObligation does not announce when the update failed or announce is off', async () => {
    const bad = chain({ first: vi.fn() })
    bad.update.mockRejectedValue(new Error('down'))
    mockedDb().mockReturnValue(bad as never)
    await resolveObligation(12, { outcome: 'sent' })
    const ok = chain({ first: vi.fn() })
    mockedDb().mockReturnValue(ok as never)
    await resolveObligation(12, { outcome: 'sent' }, { announce: false })
    expect(announceRecordAspect).not.toHaveBeenCalled()
  })
})

describe('reconcile sweep folds its notices per kind', () => {
  it('a "should have been told" (missing) row + an overdue row → ONE $integrations call for both items', async () => {
    const now = new Date('2026-11-18T12:00:00Z')
    const apiChain = chain({
      first: vi.fn().mockResolvedValue({ ack_grace_minutes: 60, skip_grace_minutes: 30 })
    })
    const latest = chain({
      select: vi.fn().mockResolvedValue([
        // item 2: a stale skip → overdue
        {
          id: 40,
          item: '2',
          outcome: 'skipped',
          reason: 'guard unmet',
          due_at: new Date(now.getTime() - 300 * 60_000),
          resolved_at: new Date(now.getTime() - 300 * 60_000)
        }
      ])
    })
    const orphan = chain({ select: vi.fn().mockResolvedValue([]) })
    const insert = {
      insert: vi.fn().mockReturnValue({ returning: vi.fn().mockResolvedValue([{ id: 50 }]) })
    }
    const update = chain()
    const final = chain({ select: vi.fn().mockResolvedValue([]) })
    const generic = chain({ first: vi.fn().mockResolvedValue(null) })
    const queue: unknown[] = []
    const database = vi.fn((table: string) => {
      if (table === 'nivaro_external_apis') return apiChain
      if (table === 'nivaro_integration_obligations') return queue.shift() ?? generic
      return generic
    }) as unknown as Knex
    queue.push(latest, orphan, final)
    mockedDb().mockImplementation(((table: string) => {
      if (table === 'nivaro_integration_obligations') return (insert as any).used ? update : insert
      return generic
    }) as never)

    const def = {
      api: 'MWF',
      kind: 'ir.push',
      collection: 'inventory_request',
      label: 'x',
      expect: async () => [
        { item: '1', due_at: new Date(now.getTime() - 600 * 60_000) },
        { item: '2', due_at: new Date(now.getTime() - 600 * 60_000) }
      ]
    }
    const r = await reconcileKind(def as never, database, now)
    expect(r.missing).toBe(1)
    expect(r.overdue).toBe(1)
    expect(announceRecordAspect).not.toHaveBeenCalled()
    expect(announceRecordAspects).toHaveBeenCalledTimes(1)
    const [collection, items, aspects] = vi.mocked(announceRecordAspects).mock.calls[0]
    expect(collection).toBe('inventory_request')
    expect([...(items as string[])].sort()).toEqual(['1', '2'])
    expect(aspects).toEqual(['$integrations'])
  })
})
