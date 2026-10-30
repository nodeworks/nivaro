import { describe, expect, it } from 'vitest'
import {
  adminNeedsYou,
  bucketTimeline,
  dayBounds,
  healthStatus,
  isSlow,
  jobProblems,
  orderNeedsYou,
  type ProblemCandidate,
  personalNeedsYou,
  rankProblems,
  type TimelineMark
} from '../../../services/overview/logic.js'

const noAdmin = {
  failedJobs: 0,
  failedImports: 0,
  erpRejects: 0,
  supportUnassigned: 0,
  supportMine: 0,
  sqlCritical: 0,
  readinessFail: 0
}
const noPersonal = {
  approvals: 0,
  waiting: 0,
  waitingBreached: 0,
  tasksOverdue: 0,
  tasksDueToday: 0,
  mentionsUnread: 0
}

describe('needs you', () => {
  it('says nothing when nothing waits', () => {
    expect(adminNeedsYou(noAdmin)).toEqual([])
    expect(personalNeedsYou(noPersonal)).toEqual([])
  })

  it('writes one sentence and one action per fact, with singular/plural', () => {
    const items = adminNeedsYou({ ...noAdmin, failedImports: 3, supportUnassigned: 1 })
    expect(items.map((i) => i.sentence)).toEqual([
      '3 imports failed in the last 24 hours',
      '1 support request has nobody on it'
    ])
    expect(items[0].action).toEqual({ label: 'Review', href: '/imports' })
    expect(items[1].action.href).toBe('/support')
  })

  it('names deadlines on waiting records and marks them critical', () => {
    const [w] = personalNeedsYou({ ...noPersonal, waiting: 12, waitingBreached: 3 })
    expect(w.sentence).toBe('12 records are waiting on you (3 past their deadline)')
    expect(w.tone).toBe('critical')
    const [one] = personalNeedsYou({ ...noPersonal, waiting: 1 })
    expect(one.sentence).toBe('1 record is waiting on you')
    expect(one.tone).toBe('info')
  })

  it('orders critical before warn before info, keeping build order within a tone', () => {
    const items = orderNeedsYou([
      ...adminNeedsYou({ ...noAdmin, failedJobs: 2, supportMine: 1, readinessFail: 1 }),
      ...personalNeedsYou({ ...noPersonal, mentionsUnread: 2, tasksOverdue: 1 })
    ])
    expect(items.map((i) => i.key)).toEqual([
      'readiness',
      'jobs',
      'tasks-overdue',
      'support-mine',
      'mentions'
    ])
  })
})

describe('health', () => {
  it('reads slow from pool waits, saturation or a queue at the read gate', () => {
    expect(isSlow({ poolWaitP95Ms: 10, poolSaturatedPct: 0, gateQueued: 0 })).toBe(false)
    expect(isSlow({ poolWaitP95Ms: 800, poolSaturatedPct: 0, gateQueued: 0 })).toBe(true)
    expect(isSlow({ poolWaitP95Ms: 0, poolSaturatedPct: 40, gateQueued: 0 })).toBe(true)
    expect(isSlow({ poolWaitP95Ms: 0, poolSaturatedPct: 0, gateQueued: 5 })).toBe(true)
  })

  it('says it in words', () => {
    expect(healthStatus({ dbHealthy: true, slow: false }).headline).toBe("Everything's running")
    expect(healthStatus({ dbHealthy: true, slow: true }).status).toBe('slow')
    expect(healthStatus({ dbHealthy: false, slow: true }).status).toBe('down')
    expect(
      healthStatus({ dbHealthy: true, slow: false, readiness: { fail: 2, warn: 1 } }).headline
    ).toBe('Running, but 2 readiness checks are failing')
  })
})

describe('problems', () => {
  const p = (
    key: string,
    severity: 'critical' | 'warn',
    since: string | null
  ): ProblemCandidate => ({
    key,
    source: 'jobs',
    severity,
    since,
    sentence: key,
    href: '/'
  })

  it('ranks critical first, then the oldest open problem, unknown start last', () => {
    const ranked = rankProblems([
      p('new-warn', 'warn', '2026-10-29T10:00:00Z'),
      p('crit-unknown', 'critical', null),
      p('crit-new', 'critical', '2026-10-29T09:00:00Z'),
      p('crit-old', 'critical', '2026-10-28T09:00:00Z'),
      p('old-warn', 'warn', '2026-10-27T10:00:00Z')
    ])
    expect(ranked.map((r) => r.key)).toEqual([
      'crit-old',
      'crit-new',
      'crit-unknown',
      'old-warn',
      'new-warn'
    ])
  })

  it('a job is a problem only while its latest run failed', () => {
    const out = jobProblems([
      {
        job_id: 'sync',
        label: 'Directory sync',
        status: 'error',
        started_at: '2026-10-29T01:00:00Z'
      },
      {
        job_id: 'sync',
        label: 'Directory sync',
        status: 'completed',
        started_at: '2026-10-29T02:00:00Z'
      },
      { job_id: 'digest', label: null, status: 'error', started_at: '2026-10-29T03:00:00Z' },
      { job_id: 'digest', label: null, status: 'error', started_at: '2026-10-29T04:00:00Z' },
      { job_id: 'digest', label: null, status: 'error', started_at: '2026-10-29T05:00:00Z' }
    ])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({
      key: 'job:digest',
      severity: 'critical',
      since: '2026-10-29T03:00:00Z',
      sentence: 'digest failed 3 times in the last 24 hours'
    })
  })
})

describe('timeline', () => {
  const now = new Date('2026-10-29T12:00:00Z')
  const mark = (at: string, kind: TimelineMark['kind'], failed = false): TimelineMark => ({
    at,
    kind,
    failed,
    sentence: `${kind}@${at}`,
    href: '/'
  })

  it('buckets the last 24 h into 48 half-hour slots, oldest first', () => {
    const t = bucketTimeline([], now)
    expect(t.buckets).toHaveLength(48)
    expect(t.buckets[0].start).toBe('2026-10-28T12:00:00.000Z')
    expect(t.buckets[47].end).toBe('2026-10-29T12:00:00.000Z')
  })

  it('counts marks per slot, drops ones outside the window and samples failures first', () => {
    const t = bucketTimeline(
      [
        mark('2026-10-29T11:40:00Z', 'job'),
        mark('2026-10-29T11:45:00Z', 'job', true),
        mark('2026-10-29T11:50:00Z', 'config'),
        mark('2026-10-27T11:50:00Z', 'deploy'),
        mark('2026-10-29T00:10:00Z', 'deploy')
      ],
      now
    )
    const last = t.buckets[47]
    expect(last.total).toBe(3)
    expect(last.failed).toBe(1)
    expect(last.kinds).toEqual({ job: 2, deploy: 0, import: 0, config: 1 })
    expect(last.sample[0].failed).toBe(true)
    expect(t.buckets[24].kinds.deploy).toBe(1)
    // Routine successful job runs are counted, not listed.
    expect(t.routine_jobs).toBe(1)
    expect(t.notable.map((m) => m.kind)).toEqual(['config', 'job', 'deploy'])
  })
})

describe('day bounds', () => {
  it("uses the viewer's local midnight (Eastern is UTC-4 in October)", () => {
    const { start, end } = dayBounds('2026-10-29', 240)
    expect(start.toISOString()).toBe('2026-10-29T04:00:00.000Z')
    expect(end.toISOString()).toBe('2026-10-30T04:00:00.000Z')
  })

  it('falls back to the UTC day and ignores a nonsense offset', () => {
    const now = new Date('2026-10-29T23:30:00Z')
    expect(dayBounds(undefined, undefined, now).start.toISOString()).toBe(
      '2026-10-29T00:00:00.000Z'
    )
    expect(dayBounds('2026-10-29', 99999).start.toISOString()).toBe('2026-10-29T00:00:00.000Z')
  })
})
