import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  evalFail: false,
  evaluated: [] as number[],
  recurred: [] as unknown[][],
  failures: [] as number[]
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
  }
}))

import { handleIssueWrite } from './crons.js'

beforeEach(() => {
  h.evalFail = false
  h.evaluated = []
  h.recurred = []
  h.failures = []
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
})
