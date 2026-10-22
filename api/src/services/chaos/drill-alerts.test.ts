import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../job-runs.js', () => ({
  startJobRun: vi.fn().mockResolvedValue({
    id: 7,
    progress: vi.fn(),
    log: vi.fn(),
    complete: vi.fn().mockResolvedValue(undefined),
    fail: vi.fn().mockResolvedValue(undefined)
  })
}))
const notify = vi.hoisted(() => vi.fn().mockResolvedValue({ id: 1, decision: { dropped: false } }))
vi.mock('../notification-channels.js', () => ({ notifyUser: notify }))

import { _resetAlertHookForTests, alertFired } from './alert-hook.js'
import { _resetDrillForTests, startDrill, stopDrill } from './drill.js'
import {
  _resetDrillAlertsForTests,
  drillAlert,
  drillWindows,
  runParticipants,
  tellDrillParticipants,
  wireDrillAlerts
} from './drill-alerts.js'
import './faults/index.js'
import { _resetRegistryForTests } from './registry.js'
import { _setRunStoreForTests, type ChaosRun, createRun, listRunEvents } from './runs.js'

const STARTER = '11111111-1111-1111-1111-111111111111'
const LEAD = '22222222-2222-2222-2222-222222222222'
const RESPONDER = '33333333-3333-3333-3333-333333333333'
const app = {} as Parameters<typeof tellDrillParticipants>[0]

const flush = () => new Promise((r) => setTimeout(r, 20))

beforeEach(() => {
  delete process.env.CLOUD_META_DB_URL
  process.env.NODE_ENV = 'test'
  _setRunStoreForTests('memory')
  notify.mockClear()
  wireDrillAlerts()
})
afterEach(async () => {
  await _resetRegistryForTests()
  _resetDrillForTests()
  _resetDrillAlertsForTests()
  _resetAlertHookForTests()
  _setRunStoreForTests(null)
})

describe('alerts tagged as drill (#2847)', () => {
  it('changes nothing when no fault is armed', async () => {
    const routing = await drillAlert({ source: 'ops-monitor', key: '1', label: 'API up' })
    expect(routing).toBeNull()
    alertFired({ source: 'log-rule', key: '2', label: 'Errors' })
    await flush()
    expect(notify).not.toHaveBeenCalled()
  })

  it('during a drill: records one alert event with time to detect and routes to participants', async () => {
    const { run } = await startDrill({
      fault_key: 'slow_requests',
      by: { id: STARTER, name: 'Ada' }
    })
    const routing = await drillAlert({
      source: 'ops-monitor',
      key: '9',
      label: 'API up',
      severity: 'error'
    })
    expect(routing).toMatchObject({ run_id: run.id, participants: [STARTER] })
    // A second firing of the same alert is not a second event.
    alertFired({ source: 'ops-monitor', key: '9', label: 'API up' })
    alertFired({ source: 'log-rule', key: '4', label: 'Errors' })
    await flush()
    const events = (await listRunEvents(run.id)).filter((e) => e.kind === 'alert')
    expect(events.map((e) => e.data.source)).toEqual(['ops-monitor', 'log-rule'])
    expect(events[0].data).toMatchObject({ label: 'API up', drill: true })
    expect(typeof events[0].data.ttd_ms).toBe('number')

    const told = await tellDrillParticipants(app, routing!, {
      subject: 'Monitor failing: API up',
      message: 'down'
    })
    expect(told).toBe(1)
    expect(notify).toHaveBeenCalledWith(
      app,
      STARTER,
      expect.objectContaining({
        subject: '[Drill] Monitor failing: API up',
        channels: { inapp: true }
      })
    )

    await stopDrill(run.id, { id: STARTER })
    expect(await drillAlert({ source: 'ops-monitor', key: '9', label: 'API up' })).toBeNull()
  })

  it('participants: starter, the game day roles and listed people; blind runs keep responders out', async () => {
    const day = await createRun({
      kind: 'gameday',
      label: 'Day',
      started_by: LEAD,
      meta: { roles: { lead: LEAD, responders: [RESPONDER] } }
    })
    const child = { started_by: STARTER, gameday_id: day.id, meta: {} } as unknown as ChaosRun
    expect((await runParticipants(child)).sort()).toEqual([STARTER, LEAD, RESPONDER].sort())
    const blindDay = await createRun({
      kind: 'gameday',
      label: 'Blind',
      started_by: LEAD,
      meta: {
        blind: true,
        roles: { lead: LEAD, responders: [RESPONDER] },
        participants: [RESPONDER]
      }
    })
    const blindChild = {
      started_by: STARTER,
      gameday_id: blindDay.id,
      meta: {}
    } as unknown as ChaosRun
    expect((await runParticipants(blindChild)).sort()).toEqual([STARTER, LEAD].sort())
  })

  it('drill windows: running and ended runs overlapping the window, never refused or ci', () => {
    const base = {
      target: null,
      params: {},
      hypothesis: [],
      verdict: null,
      verdict_detail: null,
      baseline: null,
      started_by: null,
      preset_id: null,
      gameday_id: null,
      meta: {},
      created_at: '',
      fault_key: 'x',
      label: 'L'
    }
    const runs = [
      {
        ...base,
        id: 'a',
        kind: 'drill',
        status: 'running',
        started_at: '2026-10-21T10:00:00Z',
        ends_at: '2026-10-21T10:01:00Z',
        ended_at: null
      },
      {
        ...base,
        id: 'b',
        kind: 'drill',
        status: 'completed',
        started_at: '2026-10-20T10:00:00Z',
        ends_at: null,
        ended_at: '2026-10-20T10:01:00Z'
      },
      {
        ...base,
        id: 'c',
        kind: 'drill',
        status: 'refused',
        started_at: '2026-10-21T10:00:00Z',
        ends_at: null,
        ended_at: null
      },
      {
        ...base,
        id: 'd',
        kind: 'ci',
        status: 'completed',
        started_at: '2026-10-21T10:00:00Z',
        ends_at: null,
        ended_at: '2026-10-21T10:01:00Z'
      },
      {
        ...base,
        id: 'e',
        kind: 'monkey',
        status: 'completed',
        started_at: '2026-10-01T10:00:00Z',
        ends_at: null,
        ended_at: '2026-10-01T10:01:00Z'
      }
    ] as ChaosRun[]
    const w = drillWindows(
      runs,
      Date.parse('2026-10-15T00:00:00Z'),
      Date.parse('2026-10-21T10:00:30Z')
    )
    expect(w.map((x) => [x.run_id, x.ended_at])).toEqual([
      ['a', null],
      ['b', '2026-10-20T10:01:00Z']
    ])
  })
})
