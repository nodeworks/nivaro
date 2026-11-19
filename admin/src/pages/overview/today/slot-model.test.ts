import { describe, expect, it } from 'vitest'
import { parseTodayDrill, toLevel, withTodayDrill } from './model'
import {
  cadenceWords,
  durationWords,
  filterSlotMarks,
  groupSlotMarks,
  isFiltered,
  jobTag,
  needsALook,
  outcomeWords,
  readableJobName,
  type SlotMark,
  slotJobs,
  slotPeople,
  slowRunIds,
  sortGroups,
  sortSlotMarks
} from './slot-model'

const T0 = Date.parse('2026-11-19T13:18:00.000Z')
const at = (s: number) => new Date(T0 + s * 1000).toISOString()

let nextRun = 1
function run(job: string, s: number, ms: number, extra: Partial<SlotMark> = {}): SlotMark {
  const id = nextRun++
  return {
    at: at(s),
    kind: 'job',
    failed: false,
    sentence: `${job} ran`,
    href: '/jobs',
    run_id: id,
    job_id: job,
    duration_ms: ms,
    ...extra
  }
}

/** 18 staged-imports runs 10 s apart, one slow; 6 outbox runs; one failed extension job. */
function slot(): SlotMark[] {
  const out: SlotMark[] = []
  for (let i = 0; i < 18; i++) out.push(run('staged-imports', i * 10, i === 5 ? 9000 : 200))
  for (let i = 0; i < 6; i++) out.push(run('outbox-worker', i * 30, 50))
  out.push(
    run('ext:acme:auto-create-mwf', 100, 1200, {
      failed: true,
      sentence: 'x failed',
      error: 'Partner refused'
    })
  )
  out.push({
    at: at(42),
    kind: 'config',
    failed: false,
    sentence: 'Pat changed the Orders flow',
    href: '/activity/5',
    activity_id: 5,
    user: 'AAA',
    user_name: 'Pat Lee'
  })
  return out
}

describe('readableJobName', () => {
  it('reads a job id aloud, capitals for abbreviations, extension left out', () => {
    expect(readableJobName('staged-imports')).toBe('Staged imports')
    expect(readableJobName('ext:efp-ops:auto-create-mwf')).toBe('Auto create MWF')
    expect(readableJobName('sla_breachSweep')).toBe('SLA breach sweep')
    expect(readableJobName('api-logs-prune')).toBe('API logs prune')
  })
  it('names a check by the name a person gave it, its type as the tag', () => {
    expect(readableJobName('ssl_cert:EFP Production API')).toBe('EFP Production API')
    expect(jobTag('ssl_cert:EFP Production API')).toEqual({
      text: 'SSL cert',
      tip: 'Check type: SSL cert'
    })
    expect(jobTag('ext:efp-ops:auto-create-mwf')?.text).toBe('efp-ops')
    expect(jobTag('staged-imports')).toBeUndefined()
    // An id tail is not a name.
    expect(readableJobName('transition:D81614EA-469A-40F4-8F46-C3C9479DF5E8')).toBe(
      'Transition D81614EA'
    )
    expect(
      readableJobName('transition:D81614EA-469A', 'Submit to Warehouse · FDX24INV-20435')
    ).toBe('Submit to Warehouse · FDX24INV-20435')
  })
  it('prefers the run’s own label when it says more than the id', () => {
    expect(readableJobName('x-1', 'Nightly invoice load')).toBe('Nightly invoice load')
    expect(readableJobName('staged-imports', 'staged-imports')).toBe('Staged imports')
    expect(readableJobName('ext:a:b-c', 'b-c')).toBe('B c')
  })
})

describe('words', () => {
  it('says durations and cadence briefly', () => {
    expect(durationWords(120)).toBe('120 ms')
    expect(durationWords(4500)).toBe('4.5 s')
    expect(durationWords(42_000)).toBe('42 s')
    expect(durationWords(180_000)).toBe('3 min')
    expect(durationWords(undefined)).toBe('—')
    expect(cadenceWords(10_000)).toBe('every ~10 s')
    expect(cadenceWords(300_000)).toBe('every ~5 min')
    expect(cadenceWords(59_700)).toBe('every ~1 min')
    expect(cadenceWords(null)).toBeNull()
  })
})

describe('slowRunIds', () => {
  it('flags a run 3× over its job’s median (and over 5 s), or over a minute', () => {
    const marks = slot()
    const slow = slowRunIds(marks)
    const slowRun = marks.find((m) => m.duration_ms === 9000)
    expect(slow.has(slowRun?.run_id as number)).toBe(true)
    expect(slow.size).toBe(1)
    // Few runs: only the one-minute rule applies.
    const few = [run('rare', 0, 61_000), run('rare', 5, 100)]
    expect(slowRunIds(few).size).toBe(1)
    // A quick job 3× over its usual but under 5 s is not slow.
    const quick = [run('q', 0, 100), run('q', 1, 100), run('q', 2, 100), run('q', 3, 900)]
    expect(slowRunIds(quick).size).toBe(0)
  })
})

describe('groupSlotMarks', () => {
  it('folds a job’s runs into one line with count, outcome and cadence', () => {
    const marks = slot()
    const groups = groupSlotMarks(marks, slowRunIds(marks))
    expect(groups).toHaveLength(4)
    const staged = groups.find((g) => g.job_id === 'staged-imports')
    expect(staged).toMatchObject({ count: 18, failed: 0, slow: 1, cadence_ms: 10_000 })
    expect(staged?.title).toBe('Staged imports')
    expect((staged?.marks[0].at ?? '') > (staged?.marks[17]?.at ?? '')).toBe(true)
    expect(outcomeWords(staged as never)).toBe('1 slow')
    const ext = groups.find((g) => g.extension === 'acme')
    expect(ext?.title).toBe('Auto create MWF')
    expect(outcomeWords(ext as never)).toBe('1 failed')
    expect(outcomeWords({ count: 6, failed: 0, slow: 0, kind: 'job' })).toBe('all succeeded')
  })

  it('floats failing groups to the top in any order', () => {
    const marks = slot()
    const groups = groupSlotMarks(marks, slowRunIds(marks))
    expect(sortGroups(groups, 'count')[0].failed).toBe(1)
    expect(sortGroups(groups, 'count')[1].job_id).toBe('staged-imports')
    expect(sortGroups(groups, 'new')[0].failed).toBe(1)
  })
})

describe('needsALook', () => {
  it('lists failures first, then slow runs, one line per job', () => {
    const marks = slot()
    marks.push(run('ext:acme:auto-create-mwf', 160, 900, { failed: true, error: 'Again' }))
    const look = needsALook(marks, slowRunIds(marks))
    expect(look.map((l) => l.tone)).toEqual(['failed', 'slow'])
    expect(look[0]).toMatchObject({ count: 2, title: 'Auto create MWF', error: 'Again' })
    expect(look[1]).toMatchObject({ count: 1, longest_ms: 9000, usual_ms: 200 })
  })
  it('is empty when every run was routine', () => {
    const marks = [run('a', 0, 10), run('a', 10, 12)]
    expect(needsALook(marks, slowRunIds(marks))).toEqual([])
  })
})

describe('filter + sort', () => {
  it('narrows by kind, outcome, job, person and words', () => {
    const marks = slot()
    const slow = slowRunIds(marks)
    expect(filterSlotMarks(marks, { kinds: ['config'] }, slow)).toHaveLength(1)
    expect(filterSlotMarks(marks, { outcome: 'failed' }, slow)).toHaveLength(1)
    expect(filterSlotMarks(marks, { outcome: 'slow' }, slow)).toHaveLength(1)
    expect(filterSlotMarks(marks, { outcome: 'ok' }, slow)).toHaveLength(24)
    expect(filterSlotMarks(marks, { src: 'outbox-worker' }, slow)).toHaveLength(6)
    expect(filterSlotMarks(marks, { who: 'aaa' }, slow)).toHaveLength(1)
    expect(filterSlotMarks(marks, { q: 'refused' }, slow)).toHaveLength(1)
    expect(filterSlotMarks(marks, { q: 'mwf' }, slow)).toHaveLength(1)
    expect(isFiltered({ sort: 'old', view: 'all' })).toBe(false)
    expect(isFiltered({ q: ' x ' })).toBe(true)
  })
  it('sorts by time, duration and kind', () => {
    const marks = slot()
    expect(sortSlotMarks(marks, 'new')[0].at).toBe(at(170))
    expect(sortSlotMarks(marks, 'old')[0].at).toBe(at(0))
    expect(sortSlotMarks(marks, 'long')[0].duration_ms).toBe(9000)
    expect(sortSlotMarks(marks, 'kind').at(-1)?.kind).toBe('config')
  })
  it('lists the jobs and people in the slot', () => {
    const marks = slot()
    expect(slotJobs(marks)[0]).toEqual({ id: 'staged-imports', name: 'Staged imports', count: 18 })
    expect(slotPeople(marks)).toEqual([{ id: 'AAA', name: 'Pat Lee', count: 1 }])
  })
})

describe('slot filters in the URL', () => {
  const START = '2026-11-19T13:18:00.000Z'
  it('round-trips and survives drilling down and back', () => {
    const d = {
      kind: 'slot' as const,
      at: START,
      who: '11111111-2222-3333-4444-555555555555',
      slot: {
        q: 'mwf',
        kinds: ['job' as const],
        outcome: 'failed' as const,
        src: 'ext:acme:auto-create-mwf',
        sort: 'long' as const,
        view: 'all' as const
      }
    }
    const p = withTodayDrill(new URLSearchParams(), d)
    expect(parseTodayDrill(p)).toEqual(d)
    const deeper = { ...d, run: 7 }
    expect(toLevel(deeper, 'root')).toEqual(d)
  })
  it('drops junk and defaults', () => {
    const p = new URLSearchParams(
      `today=slot&td_at=${START}&td_k=job,nope&td_o=meh&td_src=a b&td_sort=new&td_v=x`
    )
    expect(parseTodayDrill(p)).toEqual({ kind: 'slot', at: START, slot: { kinds: ['job'] } })
    expect(
      withTodayDrill(new URLSearchParams(), { kind: 'slot', at: START, slot: { sort: 'new' } }).has(
        'td_sort'
      )
    ).toBe(false)
  })
})
