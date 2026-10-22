import { describe, expect, it } from 'vitest'
import {
  dueInjects,
  dueReminders,
  INJECT_GRACE_MS,
  nextMonthlyStart,
  notePoints,
  participantsOf,
  stagingTemplate,
  validatePlan
} from './gameday-plan.js'

const LEAD = '11111111-1111-4111-8111-111111111111'
const SCRIBE = '22222222-2222-4222-8222-222222222222'
const R1 = '33333333-3333-4333-8333-333333333333'

const base = (over: Record<string, unknown> = {}) => ({
  title: 'October game day',
  starts_at: '2026-11-10T19:00:00.000Z',
  duration_min: 60,
  lead: LEAD,
  scribe: SCRIBE,
  responders: [R1, R1, LEAD],
  injects: [
    { at_s: 600, kind: 'checkpoint', label: 'Halfway' },
    { at_s: 0, kind: 'fault', label: 'Slow', fault: { fault_key: 'slow_requests', seconds: 30 } },
    { at_s: 120, kind: 'announce', text: 'Look at the dashboard' }
  ],
  ...over
})

describe('validatePlan (#2852)', () => {
  it('normalizes a good plan: sorted injects, ids, defaults, deduped responders', () => {
    const { plan, warnings } = validatePlan(base(), { faultExists: () => true })
    expect(warnings).toEqual([])
    expect(plan.injects.map((i) => i.at_s)).toEqual([0, 120, 600])
    expect(plan.injects.map((i) => i.id)).toEqual(['i2', 'i3', 'i1'])
    expect(plan.responders).toEqual([R1])
    expect(plan.reminders_min).toEqual([1440, 15])
    expect(plan.channel).toBe(true)
    expect(plan.blind).toBe(false)
    expect(plan.repeat).toBe('none')
    expect(plan.injects[1].label).toBe('Announcement')
  })

  it('collects every error and throws CHAOS_PLAN', () => {
    try {
      validatePlan(
        base({
          title: '',
          lead: 'nobody',
          duration_min: 5,
          injects: [
            { at_s: 0, kind: 'fault', fault: {} },
            { at_s: 10, kind: 'announce' },
            { at_s: 0, kind: 'dance' }
          ]
        })
      )
      expect.unreachable()
    } catch (e) {
      const err = e as { statusCode: number; code: string; details: { errors: string[] } }
      expect(err.statusCode).toBe(400)
      expect(err.code).toBe('CHAOS_PLAN')
      expect(err.details.errors).toEqual(
        expect.arrayContaining([
          'A title is required',
          'Pick a lead',
          'The day lasts 15 to 480 minutes',
          'Inject 1: pick a fault or a preset',
          'Inject 2: an announcement needs text',
          'Inject 3: kind must be fault, announce or checkpoint'
        ])
      )
    }
  })

  it('refuses injects after the end and a start in the past', () => {
    expect(() => validatePlan(base({ injects: [{ at_s: 3601, kind: 'checkpoint' }] }))).toThrow(
      /after the day ends/
    )
    expect(() => validatePlan(base(), { now: Date.parse('2026-11-11T00:00:00Z') })).toThrow(
      /in the past/
    )
  })

  it('warns (never fails) on a fault key this instance does not have', () => {
    const { warnings } = validatePlan(base(), { faultExists: (k) => k !== 'slow_requests' })
    expect(warnings[0]).toMatch(/slow_requests is not in this instance's catalog/)
  })

  it('the monthly staging template is a valid plan', () => {
    const { plan } = validatePlan(stagingTemplate('2026-11-10T19:00:00.000Z', LEAD), {
      faultExists: () => true
    })
    expect(plan.repeat).toBe('monthly')
    expect(plan.injects.filter((i) => i.kind === 'fault').map((i) => i.fault?.fault_key)).toEqual([
      'kill_web_task',
      'redis_pause',
      'storage_readonly',
      'db_latency'
    ])
  })
})

describe('participants and timing', () => {
  it('lists lead, scribe and responders once', () => {
    expect(participantsOf({ lead: LEAD, scribe: SCRIBE, responders: [R1, SCRIBE] })).toEqual([
      LEAD,
      SCRIBE,
      R1
    ])
  })

  it('splits due and missed injects and skips the done ones', () => {
    const { plan } = validatePlan(base(), { faultExists: () => true })
    const t0 = Date.parse('2026-11-10T19:00:00Z')
    expect(dueInjects(plan, t0, t0 + 1000, new Set()).due.map((i) => i.id)).toEqual(['i2'])
    expect(dueInjects(plan, t0, t0 + 130_000, new Set(['i2'])).due.map((i) => i.id)).toEqual(['i3'])
    const late = dueInjects(plan, t0, t0 + 120_000 + INJECT_GRACE_MS + 1, new Set(['i2']))
    expect(late.missed.map((i) => i.id)).toEqual(['i3'])
    expect(late.due.map((i) => i.id)).toEqual(['i1'])
  })

  it('sends each reminder once, only before the start', () => {
    const plan = { starts_at: '2026-11-10T19:00:00.000Z', reminders_min: [1440, 15] }
    const start = Date.parse(plan.starts_at)
    expect(dueReminders(plan, start - 2 * 86_400_000, [])).toEqual([])
    expect(dueReminders(plan, start - 86_400_000, [])).toEqual([1440])
    expect(dueReminders(plan, start - 10 * 60_000, [1440])).toEqual([15])
    expect(dueReminders(plan, start + 1, [])).toEqual([])
  })

  it('next month: same nth weekday at the same Eastern time across DST', () => {
    // Tue 13 Oct 2026 14:00 EDT (second Tuesday) → Tue 10 Nov 2026 14:00 EST.
    expect(nextMonthlyStart('2026-10-13T18:00:00.000Z')).toBe('2026-11-10T19:00:00.000Z')
    // Fifth Thursday of Oct 2026 (29th) → Nov has four: the last one (26th).
    expect(nextMonthlyStart('2026-10-29T18:00:00.000Z')).toBe('2026-11-26T19:00:00.000Z')
    // December rolls the year.
    expect(nextMonthlyStart('2026-12-08T19:00:00.000Z')).toBe('2027-01-12T19:00:00.000Z')
  })
})

describe('notePoints (#2853)', () => {
  const ev = (at: string, kind: string, data: Record<string, unknown> = {}) => ({ at, kind, data })

  it('times detect, cause and fix from the first live fault', () => {
    const p = notePoints([
      ev('2026-10-21T14:00:00Z', 'note', { mark: 'noticed' }),
      ev('2026-10-21T14:01:00Z', 'step', { outcome: 'refused' }),
      ev('2026-10-21T14:02:00Z', 'step', { outcome: 'armed' }),
      ev('2026-10-21T14:03:30Z', 'note', { mark: 'declared' }),
      ev('2026-10-21T14:05:00Z', 'note', { mark: 'cause' }),
      ev('2026-10-21T14:09:00Z', 'note', { mark: 'fixed' }),
      ev('2026-10-21T14:10:00Z', 'note', { text: 'all good' })
    ])
    expect(p).toEqual({
      first_fault_at: '2026-10-21T14:02:00.000Z',
      ttd_s: 90,
      ttc_s: 180,
      ttf_s: 420,
      notes: 5
    })
  })

  it('a plain run counts its armed event; nothing armed = no points', () => {
    expect(
      notePoints([
        ev('2026-10-21T14:00:00Z', 'armed'),
        ev('2026-10-21T14:00:20Z', 'note', { mark: 'noticed' })
      ]).ttd_s
    ).toBe(20)
    expect(notePoints([ev('2026-10-21T14:00:20Z', 'note', { mark: 'fixed' })]).ttf_s).toBeNull()
  })
})
