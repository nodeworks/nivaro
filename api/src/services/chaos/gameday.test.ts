import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const notified: Array<{ user: string; subject: string; category?: string }> = []
const posted: Array<{ system: boolean; room: string; message: string }> = []

vi.mock('../notification-channels.js', () => ({
  notifyUser: vi.fn(
    async (_app: unknown, user: string, opts: { subject: string; category?: string }) => {
      notified.push({ user, subject: opts.subject, category: opts.category })
      return { id: 1, decision: {}, lane: null }
    }
  )
}))
vi.mock('../chat-send.js', () => ({
  postChatMessage: vi.fn(
    async (
      _app: unknown,
      actor: { system?: boolean },
      input: { room: string; message: string }
    ) => {
      posted.push({ system: !!actor.system, room: input.room, message: input.message })
      return {}
    }
  ),
  upsertMembership: vi.fn(async () => {})
}))

import { setAppRef } from '../io-holder.js'
import { visibleArmedFor } from './armed-visibility.js'
import { _resetBlindForTests, startBlindCluster } from './blind.js'
import { _resetCatalogForTests, registerFault } from './catalog.js'
import { _resetDrillForTests, stopAllDrills, wireDrillListeners } from './drill.js'
import {
  _resetGamedayForTests,
  addNote,
  createGameday,
  declareIncident,
  endGameday,
  fireDue,
  reportEvents,
  revealGameday,
  runGamedayTick,
  startGameday,
  stepGameday
} from './gameday.js'
import { _resetRegistryForTests, armedFaults } from './registry.js'
import { buildRunReport } from './report.js'
import { _setRunStoreForTests, getRun, listRunEvents, listRuns, updateRun } from './runs.js'

const LEAD = '11111111-1111-4111-8111-111111111111'
const SCRIBE = '22222222-2222-4222-8222-222222222222'
const RESP = '33333333-3333-4333-8333-333333333333'
const OUTSIDER = '44444444-4444-4444-8444-444444444444'
const op = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Op', operator: true }

const log = { warn: () => {}, info: () => {}, error: () => {} }

function plan(over: Record<string, unknown> = {}) {
  return {
    title: 'Test day',
    starts_at: new Date(Date.now() + 3600_000).toISOString(),
    duration_min: 30,
    lead: LEAD,
    scribe: SCRIBE,
    responders: [RESP],
    channel: false,
    injects: [
      { id: 'a', at_s: 0, kind: 'fault', fault: { fault_key: 'test_fault', seconds: 60 } },
      { id: 'b', at_s: 60, kind: 'checkpoint', label: 'Look' },
      { id: 'c', at_s: 120, kind: 'fault', fault: { fault_key: 'test_fault', seconds: 30 } }
    ],
    ...over
  }
}

async function steps(id: string) {
  return (await listRunEvents(id, { kinds: ['step'] })).map((e) => e.data)
}

beforeEach(async () => {
  notified.length = 0
  posted.length = 0
  _setRunStoreForTests('memory')
  _resetRegistryForTests()
  _resetCatalogForTests()
  _resetDrillForTests()
  _resetGamedayForTests()
  _resetBlindForTests()
  setAppRef({ log })
  registerFault({
    key: 'test_fault',
    label: 'Test fault',
    proves: 'test',
    claim_keys: [],
    targets: ['all'],
    params: {},
    max_seconds: 600,
    points: ['test.point']
  })
  wireDrillListeners()
  await startBlindCluster(null)
})

afterEach(() => {
  vi.useRealTimers()
  _resetRegistryForTests()
  _resetGamedayForTests()
  _resetBlindForTests()
  setAppRef(null)
})

describe('game days (#2852)', () => {
  it('plans a day: planned row, step event, an invitation per participant in category chaos', async () => {
    const { run } = await createGameday(plan(), op)
    expect(run.kind).toBe('gameday')
    expect(run.status).toBe('planned')
    expect(run.meta).toMatchObject({
      lead: LEAD,
      participants: [LEAD, SCRIBE, RESP],
      roles: { lead: LEAD, scribe: SCRIBE, responders: [RESP] },
      blind: false
    })
    expect(await steps(run.id)).toEqual([{ phase: 'planned' }])
    expect(notified.map((n) => n.user).sort()).toEqual([LEAD, SCRIBE, RESP].sort())
    expect(notified.every((n) => n.category === 'chaos')).toBe(true)
  })

  it('starting fires +0:00 at once as the lead; the scheduler fires each later inject exactly once', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-21T14:00:00Z'))
    const { run } = await createGameday(plan({ starts_at: '2026-10-21T14:30:00Z' }), op)
    const started = await startGameday(run.id, op)
    expect(started.status).toBe('running')
    let s = await steps(run.id)
    expect(s.find((d) => d.inject_id === 'a')?.outcome).toBe('armed')
    const child = await getRun(String(s.find((d) => d.inject_id === 'a')?.child_run_id))
    expect(child?.gameday_id).toBe(run.id)
    expect(child?.started_by).toBe(LEAD)
    expect(armedFaults()).toHaveLength(1)

    // Two deliverers at +2:01 (the cron tick and the in-process timer): b and c once each.
    vi.setSystemTime(new Date('2026-10-21T14:02:01Z'))
    await Promise.all([fireDue(run.id), runGamedayTick(), fireDue(run.id)])
    s = await steps(run.id)
    expect(s.filter((d) => d.inject_id === 'b')).toHaveLength(1)
    expect(s.filter((d) => d.inject_id === 'c')).toHaveLength(1)
    expect(s.filter((d) => d.inject_id === 'a')).toHaveLength(1)

    // A manual step of something that already ran is refused.
    await expect(stepGameday(run.id, 'b', op)).rejects.toMatchObject({ code: 'CHAOS_INJECT_DONE' })
  })

  it('an inject more than ten minutes late is skipped as missed, not fired', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-21T14:00:00Z'))
    const { run } = await createGameday(
      plan({
        injects: [{ id: 'late', at_s: 60, kind: 'fault', fault: { fault_key: 'test_fault' } }]
      }),
      op
    )
    await startGameday(run.id, op)
    vi.setSystemTime(new Date('2026-10-21T14:12:00Z'))
    await fireDue(run.id)
    expect((await steps(run.id)).find((d) => d.inject_id === 'late')?.outcome).toBe('missed')
    expect(armedFaults()).toHaveLength(0)
  })

  it('an unknown fault key or a pre-flight refusal is a refused step, never a throw', async () => {
    const { run } = await createGameday(
      plan({ injects: [{ id: 'x', at_s: 0, kind: 'fault', fault: { fault_key: 'not_here' } }] }),
      op
    )
    await startGameday(run.id, op)
    const x = (await steps(run.id)).find((d) => d.inject_id === 'x')
    expect(x?.outcome).toBe('refused')
  })

  it('ends on time: child drills stopped, verdict rolled up, TTD from the marks, participants told', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-21T14:00:00Z'))
    const { run } = await createGameday(plan({ duration_min: 15 }), op)
    await startGameday(run.id, op)
    vi.setSystemTime(new Date('2026-10-21T14:00:45Z'))
    await addNote(run.id, { mark: 'noticed' }, { id: RESP, name: 'R', operator: false })
    notified.length = 0
    vi.setSystemTime(new Date('2026-10-21T14:15:01Z'))
    await fireDue(run.id)
    const done = await getRun(run.id)
    expect(done?.status).toBe('completed')
    expect(done?.verdict).toBe('held')
    expect((done?.verdict_detail as { ttd_s: number }).ttd_s).toBe(45)
    expect(armedFaults()).toHaveLength(0)
    expect((await listRuns({ status: 'running' })).length).toBe(0)
    expect(notified.map((n) => n.subject)).toContain('Game day ended: Test day')
  })

  it('Stop all closes the day; the scheduler then fires nothing', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-21T14:00:00Z'))
    const { run } = await createGameday(plan(), op)
    await startGameday(run.id, op)
    await stopAllDrills({ id: op.id }, 'stop all')
    expect((await getRun(run.id))?.status).toBe('stopped')
    vi.setSystemTime(new Date('2026-10-21T14:05:00Z'))
    expect(await fireDue(run.id)).toBe(0)
    expect(armedFaults()).toHaveLength(0)
  })

  it('the timeline bot posts fixed text only — never the plan’s labels or announcements', async () => {
    const { run } = await createGameday(
      plan({
        injects: [
          { id: 'a', at_s: 0, kind: 'checkpoint', label: '<b>secret label</b>' },
          { id: 'b', at_s: 0, kind: 'announce', text: 'hello team' }
        ]
      }),
      op
    )
    await updateRun(run.id, { meta: { ...run.meta, channel_room: 'ch:gameday-x' } })
    await startGameday(run.id, op)
    const system = posted.filter((p) => p.system).map((p) => p.message)
    expect(system.join('\n')).not.toMatch(/secret label|hello team/)
    expect(posted.find((p) => !p.system)?.message).toBe('hello team')
  })

  it('auto-start runs from the scheduler at the planned time', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-21T14:00:00Z'))
    const { run } = await createGameday(
      plan({ starts_at: '2026-10-21T14:10:00Z', auto_start: true }),
      op
    )
    await runGamedayTick()
    expect((await getRun(run.id))?.status).toBe('planned')
    vi.setSystemTime(new Date('2026-10-21T14:10:05Z'))
    await runGamedayTick()
    expect((await getRun(run.id))?.status).toBe('running')
  })

  it('monthly days plan their successor when they end', async () => {
    const { run } = await createGameday(plan({ repeat: 'monthly' }), op)
    await startGameday(run.id, op)
    await endGameday(run.id, 'completed', op)
    const next = String((await getRun(run.id))?.meta.next_id)
    const successor = await getRun(next)
    expect(successor?.status).toBe('planned')
    expect(successor?.kind).toBe('gameday')
  })
})

describe('scribe marks (#2853) and declare (#2854)', () => {
  it('participants stamp notes; a child run’s note lands on the day; outsiders are refused', async () => {
    const { run } = await createGameday(plan(), op)
    await startGameday(run.id, op)
    const childId = String((await steps(run.id)).find((d) => d.inject_id === 'a')?.child_run_id)
    const ev = await addNote(
      childId,
      { mark: 'found_cause', text: 'redis' },
      { id: SCRIBE, name: 'S', operator: false }
    )
    expect(ev?.run_id).toBe(run.id)
    expect(ev?.data).toMatchObject({ mark: 'found_cause', text: 'redis', on_run: childId })
    await expect(
      addNote(run.id, { mark: 'noticed' }, { id: OUTSIDER, name: 'O', operator: false })
    ).rejects.toMatchObject({ code: 'CHAOS_NOT_PARTICIPANT' })
    await expect(addNote(run.id, {}, op)).rejects.toThrow(/Pick a mark/)
  })

  it('a fault run’s report borrows the day’s marks from its window (#2849)', async () => {
    const { run } = await createGameday(plan(), op)
    await startGameday(run.id, op)
    const childId = String((await steps(run.id)).find((d) => d.inject_id === 'a')?.child_run_id)
    await addNote(run.id, { mark: 'noticed' }, { id: RESP, name: 'R', operator: false })
    const child = await getRun(childId)
    const evs = await reportEvents(child!)
    const borrowed = evs.filter((e) => e.kind === 'note' && e.data.mark === 'noticed')
    expect(borrowed).toHaveLength(1)
    expect(borrowed[0].id).toBeLessThan(0)
    expect(borrowed[0].run_id).toBe(childId)
  })

  it('a note stamped on a fault run counts once in that run’s report (#2849 #2853)', async () => {
    const { run } = await createGameday(plan(), op)
    await startGameday(run.id, op)
    const childId = String((await steps(run.id)).find((d) => d.inject_id === 'a')?.child_run_id)
    await addNote(childId, { mark: 'found_cause' }, { id: SCRIBE, name: 'S', operator: false })
    const child = await getRun(childId)
    const evs = await reportEvents(child!)
    expect(evs.filter((e) => e.kind === 'note' && e.data.mark === 'found_cause')).toHaveLength(1)
    const report = buildRunReport(child!, evs)
    expect(report.notes.filter((n) => n.mark === 'found_cause')).toHaveLength(1)
  })

  it('declare stamps a declared mark on every running day', async () => {
    const { run } = await createGameday(plan(), op)
    await startGameday(run.id, op)
    expect(await declareIncident({ id: OUTSIDER, name: 'O', operator: false })).toBe(1)
    const notes = await listRunEvents(run.id, { kinds: ['note'] })
    expect(notes[0].data.mark).toBe('declared')
  })
})

describe('blind game days (#2854)', () => {
  it('hides the injected faults from responders until the lead reveals', async () => {
    const { run } = await createGameday(plan({ blind: true }), op)
    await startGameday(run.id, op)
    const armed = armedFaults()
    expect(armed).toHaveLength(1)
    expect(visibleArmedFor({ id: RESP, operator: false }, armed)).toEqual([])
    expect(visibleArmedFor({ id: LEAD, operator: false }, armed)).toHaveLength(1)
    expect(visibleArmedFor({ id: 'x', operator: true }, armed)).toHaveLength(1)
    await revealGameday(run.id, op)
    expect(visibleArmedFor({ id: RESP, operator: false }, armed)).toHaveLength(1)
    expect((await steps(run.id)).some((d) => d.phase === 'revealed')).toBe(true)
  })
})
