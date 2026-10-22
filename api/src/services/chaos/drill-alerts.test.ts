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
const mail = vi.hoisted(() => vi.fn().mockResolvedValue(undefined))
vi.mock('../mail.js', () => ({ sendMail: mail, sendRawMail: vi.fn() }))

import { db } from '../../db/index.js'
import { notifyImmediateSubscribersForTests } from '../metric-alerts.js'
import { raiseIssueForTests } from '../ops-monitors.js'
import type { ArmedFault } from './catalog.js'
import { _resetDrillForTests, startDrill, stopDrill } from './drill.js'
import {
  alertRelatesTo,
  drillAlert,
  drillWindows,
  runParticipants,
  tellDrillParticipants,
  withDrillNote
} from './drill-alerts.js'
import './faults/index.js'
import { _resetRegistryForTests } from './registry.js'
import { _setRunStoreForTests, type ChaosRun, createRun, updateRun } from './runs.js'

const STARTER = '11111111-1111-1111-1111-111111111111'
const LEAD = '22222222-2222-2222-2222-222222222222'
const RESPONDER = '33333333-3333-3333-3333-333333333333'
const SUBSCRIBER = '44444444-4444-4444-4444-444444444444'
const app = {} as Parameters<typeof tellDrillParticipants>[0]

beforeEach(() => {
  delete process.env.CLOUD_META_DB_URL
  process.env.NODE_ENV = 'test'
  _setRunStoreForTests('memory')
  notify.mockClear()
})
afterEach(async () => {
  await _resetRegistryForTests()
  _resetDrillForTests()
  _setRunStoreForTests(null)
})

const fault = (fault_key: string, target: ArmedFault['target'] = { kind: 'all' }) =>
  ({ id: 'f', fault_key, label: fault_key, target, params: {} }) as unknown as ArmedFault

describe('alerts tagged as drill (#2847)', () => {
  it('changes nothing when no fault is armed', async () => {
    expect(await drillAlert({ source: 'monitor', key: '1', label: 'API up' })).toBeNull()
    expect(withDrillNote('down', null)).toBe('down')
  })

  it('knows when an alert is about what the fault touches', () => {
    expect(
      alertRelatesTo(
        { source: 'log_rule', key: '1', label: 'Mail send failures' },
        fault('mail_down')
      )
    ).toBe(true)
    expect(
      alertRelatesTo(
        { source: 'monitor', key: '2', label: 'Redis reachable' },
        fault('redis_pause')
      )
    ).toBe(true)
    expect(
      alertRelatesTo(
        { source: 'metric_alert', key: '3', label: 'API p95 latency' },
        fault('slow_requests')
      )
    ).toBe(true)
    expect(
      alertRelatesTo(
        { source: 'metric_alert', key: '4', label: 'Budget over plan' },
        fault('slow_requests')
      )
    ).toBe(false)
    expect(
      alertRelatesTo({ source: 'monitor', key: '5', label: 'Mail relay' }, fault('redis_pause'))
    ).toBe(false)
    // Words match whole, not inside other words ("mail" is not in "mailbox-free text").
    expect(
      alertRelatesTo({ source: 'x', key: '6', label: 'Emailing digest' }, fault('mail_down'))
    ).toBe(false)
  })

  it('during an unrelated drill the alert still reaches its normal recipients, tagged', async () => {
    const { run } = await startDrill({ fault_key: 'mail_down', by: { id: STARTER, name: 'Ada' } })
    // ops monitor raise path: subscriber + creator are the normal recipients.
    const original = vi.mocked(db).getMockImplementation()
    vi.mocked(db).mockImplementation(((table: string) => {
      const chain: Record<string, unknown> = {}
      for (const m of ['where', 'whereIn']) chain[m] = () => chain
      chain.first = async () => null
      chain.insert = async () => [1]
      chain.update = async () => 1
      chain.pluck = async () => (table === 'nivaro_monitor_subscribers' ? [SUBSCRIBER] : [])
      return chain
    }) as never)
    await raiseIssueForTests(
      { id: 9, name: 'Budget sync', type: 'http', created_by: null } as never,
      'down',
      app
    )
    if (original) vi.mocked(db).mockImplementation(original)
    const calls = notify.mock.calls.map((c) => [c[1], c[2].subject, c[2].message])
    expect(calls).toContainEqual([
      SUBSCRIBER,
      'Monitor failing: Budget sync',
      `down\n\nFired during the chaos drill “Mail transport down” (run ${run.id}).`
    ])
    // The drill's starter is told too, marked.
    expect(calls.find((c) => c[0] === STARTER)?.[1]).toBe('[Drill] Monitor failing: Budget sync')
  })

  it('during an unrelated drill a metric alert still emails and notifies its subscriber', async () => {
    const { run } = await startDrill({ fault_key: 'mail_down', by: { id: STARTER, name: 'Ada' } })
    const original = vi.mocked(db).getMockImplementation()
    vi.mocked(db).mockImplementation((() => {
      const chain: Record<string, unknown> = {}
      for (const m of ['join', 'where', 'whereIn']) chain[m] = () => chain
      chain.select = async () => [
        { id: 1, user: SUBSCRIBER, delivery_in_app: true, delivery_email: true, email: 's@x' }
      ]
      chain.update = async () => 1
      return chain
    }) as never)
    mail.mockClear()
    await notifyImmediateSubscribersForTests(
      app,
      {
        id: 5,
        name: 'Budget over plan',
        def_name: 'Budget',
        def_unit: '',
        operator: 'gt'
      } as never,
      12,
      10,
      77
    )
    if (original) vi.mocked(db).mockImplementation(original)
    expect(mail).toHaveBeenCalledWith(
      expect.objectContaining({ to: 's@x', subject: 'Alert: Budget over plan' })
    )
    const toSub = notify.mock.calls.find((c) => c[1] === SUBSCRIBER)
    expect(toSub?.[2].message).toContain(
      `Fired during the chaos drill “Mail transport down” (run ${run.id}).`
    )
    // The drill's starter hears about it too, in-app only.
    expect(notify.mock.calls.find((c) => c[1] === STARTER)?.[2]).toMatchObject({
      subject: '[Drill] Alert: Budget over plan',
      channels: { inapp: true }
    })
  })

  it('a related alert says it may be caused by the drill; the starter is not told twice', async () => {
    const { run } = await startDrill({ fault_key: 'mail_down', by: { id: STARTER, name: 'Ada' } })
    const d = await drillAlert({ source: 'log_rule', key: '4', label: 'Mail send errors' })
    expect(d).toMatchObject({ run_id: run.id, related: true, participants: [STARTER] })
    expect(withDrillNote('x', d)).toContain('May be caused by the chaos drill')
    expect(
      await tellDrillParticipants(app, d!, { subject: 's', message: 'm' }, [STARTER.toUpperCase()])
    ).toBe(0)
    await stopDrill(run.id, { id: STARTER })
    expect(await drillAlert({ source: 'log_rule', key: '4', label: 'Mail send errors' })).toBeNull()
  })

  it('blind runs keep the note out of the normal copy, never the alert', async () => {
    const { run } = await startDrill({ fault_key: 'mail_down', by: { id: STARTER, name: 'Ada' } })
    await updateRun(run.id, { meta: { ...run.meta, blind: true } })
    const d = await drillAlert({ source: 'monitor', key: '1', label: 'API up' })
    expect(d?.blind).toBe(true)
    expect(withDrillNote('down', d)).toBe('down')
    expect(withDrillNote('down', d, true)).toContain('Fired during the chaos drill')
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
