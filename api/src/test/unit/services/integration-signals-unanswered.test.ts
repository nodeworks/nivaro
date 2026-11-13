import { beforeEach, describe, expect, it, vi } from 'vitest'

// Sends that never got an answer, past their time (erp-unanswered.ts), show on the Integrations
// console's Firefight list as two signals: orders from a blocking push (critical — the move
// waits on them) and every other send (warn). Each row opens the send in place, where an
// administrator is pointed at the ERP tab to mark it.

const state = vi.hoisted(() => ({
  stale: [] as Array<Record<string, unknown>>
}))

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/erp-unanswered.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../services/erp-unanswered.js')>()),
  staleUnansweredSends: vi.fn(async () => state.stale)
}))

import { getIntegrationSignal } from '../../../services/integration-signals.js'
import { registerCoreIntegrationSignals } from '../../../services/integration-signals-core.js'

registerCoreIntegrationSignals()

const ctx = { thresholds: {}, businessDaysAgo: async () => new Date() }
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString()

beforeEach(() => {
  state.stale = [
    {
      id: 52,
      collection: 'inventory_request',
      item: '32842',
      api_name: 'MDSi',
      endpoint_path: '/deploymentRequests',
      started_at: hoursAgo(3),
      blocking: true
    },
    {
      id: 40,
      collection: 'workflows',
      item: '1001',
      api_name: 'MWF',
      endpoint_path: '/update_workflow.php',
      started_at: hoursAgo(5),
      blocking: false
    }
  ]
})

describe('stale unanswered sends', () => {
  it('orders from a blocking push are their own critical signal', async () => {
    const def = getIntegrationSignal('core:unanswered-orders')
    expect(def).toMatchObject({ severity: 'critical', tab: 'pushes' })
    const { count, rows } = await def!.evaluate(ctx)
    expect(count).toBe(1)
    expect(rows[0]).toMatchObject({
      key: 'inventory_request:32842:MDSi:/deploymentRequests',
      occurrence: 'sub:52',
      group: 'MDSi',
      api: 'MDSi',
      title: 'MDSi /deploymentRequests',
      since: state.stale[0].started_at,
      record: { collection: 'inventory_request', id: '32842' },
      drill: { kind: 'submission', id: '52' }
    })
    expect(rows[0].detail).toBe(
      'No answer for 3h — MDSi may already have it. Check in MDSi, then mark the send received or not received.'
    )
    expect(rows[0].actions.map((a) => a.kind)).toEqual(['open'])
  })

  it('every other unanswered send is a warning', async () => {
    const def = getIntegrationSignal('core:unanswered-sends')
    expect(def).toMatchObject({ severity: 'warn' })
    const { count, rows } = await def!.evaluate(ctx)
    expect(count).toBe(1)
    expect(rows[0]).toMatchObject({
      key: 'workflows:1001:MWF:/update_workflow.php',
      drill: { kind: 'submission', id: '40' }
    })
  })

  it('one row per record and push: the newest send names it', async () => {
    state.stale = [
      { ...state.stale[0], id: 60 },
      { ...state.stale[0], id: 52 }
    ]
    const { count, rows } = await getIntegrationSignal('core:unanswered-orders')!.evaluate(ctx)
    expect(count).toBe(1)
    expect(rows[0].occurrence).toBe('sub:60')
  })
})
