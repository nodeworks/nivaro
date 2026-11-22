import { describe, expect, it, vi } from 'vitest'

// Hub phase 6, Task 13: a hook's own state on a shared deployment (one process, many apps). Two
// apps may hold the same collection and record id (dev = a copy of prod); a coalescing timer or
// worker queue keyed only by `collection:id` merged them and ran the check against whichever
// app's write drained the queue.

const checked = vi.hoisted(() => [] as Array<{ tenant: string | undefined; id: string }>)
vi.mock('../../../services/config-conformance.js', async () => {
  const { getTenantId } = await import('../../../db/tenant-context.js')
  return {
    hasChecks: vi.fn(async () => true),
    checkRecord: vi.fn(async (_c: string, id: string) => {
      checked.push({ tenant: getTenantId(), id })
      await new Promise((r) => setTimeout(r, 5))
      return { findings: [] }
    }),
    storeRecordResult: vi.fn(async () => {})
  }
})
vi.mock('../../../services/request-trace.js', () => ({ noteDerivedWrite: vi.fn() }))

const { runWithTenantDb } = await import('../../../db/tenant-context.js')
const { noteRawWrite } = await import('../../../hooks/record-integrity.js')

function asApp(tenantId: string, fn: () => void): void {
  runWithTenantDb({} as never, tenantId, fn, tenantId)
}

describe('record integrity on a shared deployment', () => {
  it('the same record id in two apps is checked twice, each in its own app', async () => {
    asApp('app-a-e1', () => noteRawWrite('orders', 7, {}))
    asApp('app-b-e2', () => noteRawWrite('orders', 7, {}))
    asApp('app-a-e1', () => noteRawWrite('orders', 8, {}))
    asApp('app-b-e2', () => noteRawWrite('orders', 8, {}))
    await new Promise((r) => setTimeout(r, 1800))
    expect(
      checked.sort((x, y) => `${x.tenant}${x.id}`.localeCompare(`${y.tenant}${y.id}`))
    ).toEqual([
      { tenant: 'app-a-e1', id: '7' },
      { tenant: 'app-a-e1', id: '8' },
      { tenant: 'app-b-e2', id: '7' },
      { tenant: 'app-b-e2', id: '8' }
    ])
  })
})
