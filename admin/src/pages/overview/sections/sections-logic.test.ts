import { rankSignals } from '@nivaro/shared'
import { describe, expect, it } from 'vitest'
import { mergeProblems, signalCandidates } from './problems-merge'
import { bucketSummary, bucketTone } from './timeline-text'
import type { ProblemCandidate, TimelineBucket } from './types'

const p = (
  key: string,
  severity: 'critical' | 'warn',
  since: string | null,
  source: ProblemCandidate['source'] = 'jobs'
): ProblemCandidate => ({ key, source, severity, since, sentence: key, href: '/' })

describe('mergeProblems', () => {
  it('interleaves the two ranked lists: critical first, then the oldest', () => {
    const server = [
      p('sql', 'critical', '2026-10-29T08:00:00Z', 'sql'),
      p('job', 'warn', '2026-10-29T01:00:00Z')
    ]
    const integrations = [
      p('erp', 'critical', '2026-10-28T08:00:00Z', 'integrations'),
      p('nuvolo', 'warn', '2026-10-29T09:00:00Z', 'integrations')
    ]
    expect(mergeProblems(server, integrations).map((x) => x.key)).toEqual(['erp', 'sql', 'job'])
  })

  it("keeps each list's own order and stops at the limit", () => {
    const server = [p('a', 'warn', null), p('b', 'warn', '2026-10-01T00:00:00Z')]
    expect(mergeProblems(server, [], 1).map((x) => x.key)).toEqual(['a'])
    expect(mergeProblems([], [], 3)).toEqual([])
  })
})

describe('signalCandidates', () => {
  const signal = (
    id: string,
    severity: 'critical' | 'warn',
    rows: string[],
    error: string | null = null
  ) => ({
    id,
    label: id.toUpperCase(),
    description: '',
    tab: 'firefight',
    severity,
    count: rows.length,
    error,
    last_run: null,
    thresholds: [],
    settings: { enabled: true, severity, thresholds: {} },
    rows: rows.map((first_seen, i) => ({ key: `${id}${i}`, title: 't', actions: [], first_seen })),
    snoozed: [],
    shown: rows.length
  })

  it('keeps open signals in the Firefight order and drops errored or empty ones', () => {
    const ranked = rankSignals([
      signal('push', 'warn', ['2026-10-20T00:00:00Z']),
      signal('erp', 'critical', ['2026-10-29T00:00:00Z', '2026-10-28T00:00:00Z']),
      signal('quiet', 'critical', []),
      signal('broken', 'critical', ['2026-10-01T00:00:00Z'], 'evaluator failed')
    ] as never)
    const out = signalCandidates(ranked)
    expect(out.map((c) => c.key)).toEqual(['integration:erp', 'integration:push'])
    expect(out[0]).toMatchObject({
      severity: 'critical',
      since: '2026-10-28T00:00:00Z',
      sentence: 'ERP: 2 open',
      href: '/integration-health?signal=erp'
    })
  })
})

describe('timeline words', () => {
  const b = (over: Partial<TimelineBucket>): TimelineBucket => ({
    start: '2026-10-29T10:00:00Z',
    end: '2026-10-29T10:30:00Z',
    total: 0,
    failed: 0,
    kinds: { job: 0, deploy: 0, import: 0, config: 0 },
    sample: [],
    ...over
  })

  it('names what ran in a slot', () => {
    expect(bucketSummary(b({}))).toBe('Nothing ran')
    expect(
      bucketSummary(
        b({ total: 14, failed: 1, kinds: { job: 12, deploy: 0, import: 1, config: 1 } })
      )
    ).toBe('1 failed, 1 import, 1 config change, 12 job runs')
  })

  it('lets the most important mark win', () => {
    expect(bucketTone(b({}))).toBe('empty')
    expect(bucketTone(b({ total: 3, kinds: { job: 3, deploy: 0, import: 0, config: 0 } }))).toBe(
      'jobs'
    )
    expect(bucketTone(b({ total: 2, kinds: { job: 1, deploy: 0, import: 0, config: 1 } }))).toBe(
      'change'
    )
    expect(bucketTone(b({ total: 2, kinds: { job: 1, deploy: 1, import: 0, config: 0 } }))).toBe(
      'deploy'
    )
    expect(
      bucketTone(b({ total: 2, failed: 1, kinds: { job: 1, deploy: 1, import: 0, config: 0 } }))
    ).toBe('failed')
  })
})
