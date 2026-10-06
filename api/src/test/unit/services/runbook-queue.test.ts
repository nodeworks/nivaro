import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: {} }))

import { normalizeRunbooks } from '../../../extensions/runbook-decls.js'
import {
  foldEventLine,
  type HostRunRow,
  hostOutcome,
  hostRunState,
  LineBatcher,
  MAX_LINE,
  pickClaimable,
  summarizeHostRun
} from '../../../services/runbook-queue.js'
import { runbookArgv, type StepEvent, stepStates } from '../../../services/runbook-runs.js'

const row = (over: Partial<HostRunRow> = {}): HostRunRow => ({
  id: '0f8fad5b-d9cb-469f-a165-70867728950e',
  extension: 'x',
  runbook: 'rebuild',
  mode: 'dry',
  target: 'EFP_Staging',
  args: null,
  from_step: null,
  resume_of: null,
  status: 'running',
  requested_by: 'u',
  requested_at: '2026-10-06T10:00:00Z',
  host: 'box',
  claimed_at: '2026-10-06T10:00:05Z',
  started_at: '2026-10-06T10:00:05Z',
  finished_at: null,
  heartbeat_at: '2026-10-06T10:10:00Z',
  failed_step: null,
  summary: null,
  cancel_requested: 0,
  events: null,
  ...over
})

describe('host runbook queue', () => {
  it('reads a running run with a silent agent as lost', () => {
    const now = Date.parse('2026-10-06T10:11:00Z')
    expect(hostRunState(row(), now)).toBe('running')
    expect(hostRunState(row(), Date.parse('2026-10-06T10:14:00Z'))).toBe('lost')
    expect(hostRunState(row({ heartbeat_at: null, claimed_at: null, started_at: null }), now)).toBe(
      'lost'
    )
    // Only running rows can be lost.
    expect(hostRunState(row({ status: 'queued', heartbeat_at: null }), now)).toBe('queued')
    expect(hostRunState(row({ status: 'done' }), Date.parse('2027-01-01T00:00:00Z'))).toBe('done')
    const s = summarizeHostRun(row(), Date.parse('2026-10-06T11:00:00Z'))
    expect(s).toMatchObject({ state: 'lost', source: 'host', cancel_requested: false })
    expect(s.summary).toMatch(/stopped reporting/)
  })

  it('claims the oldest queued run this agent can run', () => {
    const rows = [
      { id: 'a', extension: 'x', runbook: 'other', status: 'queued' as const },
      { id: 'b', extension: 'x', runbook: 'rebuild', status: 'running' as const },
      { id: 'c', extension: 'x', runbook: 'rebuild', status: 'queued' as const },
      { id: 'd', extension: 'x', runbook: 'rebuild', status: 'queued' as const }
    ]
    expect(pickClaimable(rows, new Set(['x:rebuild']))?.id).toBe('c')
    expect(pickClaimable(rows, new Set(['y:rebuild']))).toBeNull()
  })

  it('batches output into numbered lines, keeping the partial tail', () => {
    const b = new LineBatcher(10)
    expect(b.push('one\ntw')).toEqual(['one'])
    expect(b.push('o\r\nthree\n')).toEqual(['two', 'three'])
    expect(b.queued.map((q) => q.seq)).toEqual([11, 12, 13])
    b.ack(12)
    expect(b.queued).toEqual([{ seq: 13, line: 'three' }])
    expect(b.push('x'.repeat(MAX_LINE + 50))).toEqual([])
    expect(b.end()[0].length).toBe(MAX_LINE)
    expect(b.nextSeq).toBe(15)
  })

  it("folds phase events and nests a wrapped runbook's steps under the running phase", () => {
    const ev: StepEvent[] = []
    expect(foldEventLine(ev, 'noise')).toBe(false)
    foldEventLine(ev, '@@event {"step":"promote","status":"start","at":"t1"}')
    foldEventLine(ev, '@@sub {"step":"state-views","status":"ok","at":"t2","secs":12}')
    foldEventLine(ev, '@@sub {"step":"sequences","status":"start","at":"t3"}')
    foldEventLine(ev, '@@sub {"step":"sequences","status":"ok","at":"t4","secs":3}')
    const track = stepStates(['refresh', 'promote', 'convert'], ev, 'running')
    expect(track.map((s) => s.status)).toEqual(['pending', 'running', 'pending'])
    expect(track[1].lines).toEqual(['state-views ok 12s', 'sequences ok 3s'])
    // A sub event with no phase running is dropped.
    expect(foldEventLine([], '@@sub {"step":"a","status":"ok","at":"t"}')).toBe(false)
  })

  it('judges the outcome: refused, done, failed at a phase, cancelled', () => {
    expect(
      hostOutcome({
        code: 75,
        cancelled: false,
        tail: ['### REFUSED: another go-live script is running'],
        events: []
      })
    ).toEqual({
      status: 'refused',
      summary: 'another go-live script is running'
    })
    expect(
      hostOutcome({ code: 0, cancelled: false, tail: ['### DONE — nightly complete'], events: [] })
    ).toEqual({
      status: 'done',
      summary: 'nightly complete'
    })
    expect(
      hostOutcome({
        code: 2,
        cancelled: false,
        tail: ['PHASE FAILED: 3-promote — resume with: x --from 3'],
        events: []
      })
    ).toMatchObject({ status: 'failed', failed_step: 'promote' })
    expect(
      hostOutcome({
        code: 1,
        cancelled: false,
        tail: ['boom'],
        events: [{ step: 'schema', status: 'fail', at: 't' }]
      })
    ).toMatchObject({ status: 'failed', failed_step: 'schema', summary: 'exit 1 — boom' })
    expect(hostOutcome({ code: null, cancelled: true, tail: [], events: [] }).status).toBe(
      'cancelled'
    )
  })

  it('carries skip_dry_gate only when it is exactly true', () => {
    const base = { key: 'k', command: ['bash', 'extensions/x/a.sh'], dry_args: [], go_args: [] }
    const [on] = normalizeRunbooks('x', [{ ...base, skip_dry_gate: true }])
    expect(on.skip_dry_gate).toBe(true)
    for (const v of [undefined, false, 'true', 1]) {
      const [d] = normalizeRunbooks('x', [{ ...base, skip_dry_gate: v }])
      expect(d.skip_dry_gate).toBeUndefined()
    }
  })

  it('normalizes host declarations: command, phases, runs_on', () => {
    const [d] = normalizeRunbooks('x', [
      {
        key: 'rebuild',
        label: 'Rebuild',
        runs_on: 'host',
        command: ['bash', 'extensions/x/scripts/job.sh', 'staging'],
        phases: [{ key: 'refresh', label: 'Refresh' }, { key: 'Bad Key' }, { key: 'refresh' }],
        dry_args: ['--dry'],
        go_args: [],
        resume_flag: '--from'
      }
    ])
    expect(d).toMatchObject({ runs_on: 'host', phases: [{ key: 'refresh', label: 'Refresh' }] })
    expect(runbookArgv(d, 'dry', 'promote')).toEqual({
      file: 'bash',
      args: ['extensions/x/scripts/job.sh', 'staging', '--dry', '--from', 'promote'],
      script: 'extensions/x/scripts/job.sh'
    })
    // An arbitrary binary, a file outside the extension, or no script at all: dropped.
    for (const command of [
      ['curl', 'extensions/x/a.sh'],
      ['bash', 'extensions/y/a.sh'],
      ['bash', 'extensions/x/../../a.sh'],
      ['bash', '-c', 'rm -rf /']
    ])
      expect(normalizeRunbooks('x', [{ key: 'k', command, dry_args: [], go_args: [] }])).toEqual([])
    expect(normalizeRunbooks('x', [{ key: 'k', dry_args: [], go_args: [] }])).toEqual([])
    const [local] = normalizeRunbooks('x', [
      { key: 'k', script: 'extensions/x/s.ts', dry_args: ['--dry-run'], go_args: [] }
    ])
    expect(local.runs_on).toBe('local')
    expect(runbookArgv(local, 'dry').args).toEqual([
      'tsx',
      'extensions/x/s.ts',
      '--dry-run',
      '--events'
    ])
  })
})
