import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  evalFail: false,
  evaluated: [] as number[],
  recurred: [] as unknown[][],
  failures: [] as number[],
  gate: null as Promise<void> | null
}))
vi.mock('../../db/index.js', () => ({ db: () => ({}) }))
vi.mock('../../db/pool-context.js', () => ({
  runInBackgroundPool: (fn: () => Promise<unknown>) => Promise.resolve().then(fn)
}))
vi.mock('../issue-raise.js', () => ({ onIssueWrite: () => () => {}, pruneHits: async () => {} }))
vi.mock('./connections.js', () => ({ listConnections: async () => [] }))
vi.mock('./feature.js', () => ({ trackersEnabled: async () => true }))
vi.mock('./inbound.js', () => ({
  noteReconcileFailure: () => {},
  reconcileConnection: async () => ({ checked: 0, applied: 0 })
}))
vi.mock('./outbox.js', () => ({ processOutbox: async () => ({}) }))
vi.mock('./engine.js', () => ({
  evaluateQueued: async (id: number) => {
    h.evaluated.push(id)
    if (h.evalFail) throw new Error('engine down')
  },
  noteEvaluationFailure: (id: number) => h.failures.push(id),
  sweep: async () => ({ evaluated: 0 }),
  trimAllDecisions: async () => {}
}))
vi.mock('./outbound-sync.js', () => ({
  onRecurrence: async (...a: unknown[]) => {
    h.recurred.push(a)
    if (h.gate) await h.gate
  }
}))

import { handleIssueWrite } from './crons.js'

beforeEach(() => {
  h.evalFail = false
  h.evaluated = []
  h.recurred = []
  h.failures = []
  h.gate = null
})

describe('handleIssueWrite', () => {
  it('runs the engine, then onRecurrence for raised / recurred only', async () => {
    await handleIssueWrite({ issueId: 5, kind: 'raised' })
    await handleIssueWrite({ issueId: 6, kind: 'changed' })
    expect(h.evaluated).toEqual([5, 6])
    expect(h.recurred).toEqual([[5, 'raised']])
  })

  it('a failing engine is logged and onRecurrence still runs', async () => {
    h.evalFail = true
    await handleIssueWrite({ issueId: 7, kind: 'recurred' })
    expect(h.failures).toEqual([7])
    expect(h.recurred).toEqual([[7, 'recurred']])
  })

  // final review M6: a burst of recurrences of one issue runs onRecurrence once at a time, and
  // once more afterwards per kind that arrived meanwhile — not once per write
  it('coalesces onRecurrence per issue', async () => {
    let open!: () => void
    h.gate = new Promise<void>((r) => {
      open = r
    })
    const first = handleIssueWrite({ issueId: 9, kind: 'recurred' })
    await new Promise((r) => setTimeout(r, 0))
    const burst = Array.from({ length: 20 }, (_, i) =>
      handleIssueWrite({ issueId: 9, kind: i === 3 ? 'raised' : 'recurred' })
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(h.recurred).toEqual([[9, 'recurred']])
    h.gate = null
    open()
    await Promise.all([first, ...burst])
    expect(h.evaluated).toHaveLength(21)
    expect(h.recurred).toEqual([
      [9, 'recurred'],
      [9, 'raised'],
      [9, 'recurred']
    ])
    // another issue is not held by this one
    await handleIssueWrite({ issueId: 10, kind: 'recurred' })
    expect(h.recurred.at(-1)).toEqual([10, 'recurred'])
  })
})
