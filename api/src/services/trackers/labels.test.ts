import { describe, expect, it } from 'vitest'
import { normalizeSync } from './connections.js'
import {
  labelSwap,
  labelsFor,
  mappedLabelsFor,
  mergeLabels,
  normalizePriority,
  readMapped
} from './labels.js'

describe('tracker labels', () => {
  it('mergeLabels keeps first spelling and drops case duplicates', () => {
    expect(mergeLabels(['Bug', ' crash '], undefined, ['bug', '', 'CRASH', 'ui'], ['  '])).toEqual([
      'Bug',
      'crash',
      'ui'
    ])
    const many = Array.from({ length: 80 }, (_, i) => `l${i}`)
    expect(mergeLabels(many)).toHaveLength(50)
  })

  it('labelsFor adds always + severity + source', () => {
    const opts = normalizeSync({
      labels: {
        always: ['nivaro'],
        by_severity: { critical: ['sev::1'], error: ['sev::2'] },
        by_source: { client: ['frontend'], server: ['backend'] },
        on_example: ['recurring']
      }
    }).labels
    expect(labelsFor({ severity: 'critical', source: 'client' }, opts)).toEqual([
      'nivaro',
      'sev::1',
      'frontend'
    ])
    // 'error' is an alias of high: its labels live under high
    expect(opts.by_severity.high).toEqual(['sev::2'])
    expect(labelsFor({ severity: 'error', source: 'server' }, opts)).toEqual([
      'nivaro',
      'sev::2',
      'backend'
    ])
    expect(labelsFor({ severity: 'low', source: 'constructor' }, opts)).toEqual(['nivaro'])
  })

  it('normalizePriority maps aliases', () => {
    expect(normalizePriority('info')).toBe('low')
    expect(normalizePriority('warning')).toBe('medium')
    expect(normalizePriority('error')).toBe('high')
    expect(normalizePriority('CRITICAL')).toBe('critical')
    expect(normalizePriority('whatever')).toBe('medium')
  })

  it('mappedLabelsFor uses priority and lane maps', () => {
    const s = normalizeSync({
      priority_map: { critical: 'priority::1', high: 'priority::2' },
      lane_map: { open: 'workflow::to do', in_progress: 'workflow::doing' }
    })
    expect(mappedLabelsFor({ severity: 'critical', status: 'open' }, s)).toEqual([
      'priority::1',
      'workflow::to do'
    ])
    expect(mappedLabelsFor({ severity: 'error', status: 'resolved' }, s)).toEqual(['priority::2'])
    expect(mappedLabelsFor({ severity: 'low', status: 'bogus' }, s)).toEqual([])
  })

  it('labelSwap removes the other lane labels', () => {
    const lanes = {
      open: 'workflow::to do',
      in_progress: 'workflow::doing',
      resolved: 'workflow::review',
      closed: undefined
    }
    expect(labelSwap(lanes, 'in_progress')).toEqual({
      add: ['workflow::doing'],
      remove: ['workflow::to do', 'workflow::review']
    })
    // a status with no lane label still takes the others away, so lanes never stack
    expect(labelSwap(lanes, 'closed')).toEqual({
      add: [],
      remove: ['workflow::to do', 'workflow::doing', 'workflow::review']
    })
    // two keys sharing a label: never remove what is being added
    expect(labelSwap({ low: 'p::low', medium: 'p::low', high: 'p::high' }, 'low')).toEqual({
      add: ['p::low'],
      remove: ['p::high']
    })
  })

  it('readMapped prefers the label added in this event', () => {
    const lanes = {
      open: 'workflow::to do',
      in_progress: 'workflow::doing',
      resolved: 'workflow::review'
    }
    expect(readMapped(['workflow::review'], ['workflow::doing', 'workflow::review'], lanes)).toBe(
      'resolved'
    )
    // added then removed again in the same event: not current, so nothing to read
    expect(readMapped(['workflow::review'], ['workflow::doing'], lanes)).toBeNull()
    expect(readMapped([], ['workflow::doing'], lanes)).toBeNull()
    expect(readMapped(['Workflow::Doing'], ['workflow::doing'], lanes)).toBe('in_progress')
    expect(readMapped(['bug'], ['bug'], lanes)).toBeNull()
  })
})

describe('sync label + similar options', () => {
  it('normalizeSync clamps join_at and keeps suggest_at ≤ join_at', () => {
    expect(normalizeSync(null).similar).toEqual({ enabled: true, join_at: 0.88, suggest_at: 0.78 })
    expect(normalizeSync({ similar: { join_at: 2, suggest_at: 0.1 } }).similar).toEqual({
      enabled: true,
      join_at: 0.99,
      suggest_at: 0.5
    })
    expect(
      normalizeSync({ similar: { enabled: false, join_at: 0.7, suggest_at: 0.9 } }).similar
    ).toEqual({ enabled: false, join_at: 0.7, suggest_at: 0.7 })
    expect(normalizeSync({ similar: { join_at: 'x' } }).similar.join_at).toBe(0.88)
  })

  it('normalizeSync cleans labels and maps', () => {
    const s = normalizeSync({
      labels: {
        always: ['a,b', 'A B', 7, ''],
        by_severity: { bogus: ['x'], LOW: ['quiet'] },
        by_source: { ' Client ': ['fe'], constructor: 'nope' },
        on_example: 'recurring'
      },
      priority_map: { critical: 'p1', nope: 'x', low: '' },
      lane_map: { open: 'todo', done: 'x' },
      priority_two_way: false
    })
    expect(s.labels).toEqual({
      always: ['a b'],
      by_severity: { low: ['quiet'] },
      by_source: { client: ['fe'] },
      on_example: []
    })
    expect(s.priority_map).toEqual({ critical: 'p1' })
    expect(s.lane_map).toEqual({ open: 'todo' })
    expect(s.priority_two_way).toBe(false)
    expect(s.lanes_two_way).toBe(true)
  })
})
