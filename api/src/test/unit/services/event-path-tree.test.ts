import { describe, expect, it } from 'vitest'
import {
  buildTree,
  FOLD_THRESHOLD,
  filterHiddenSubtrees,
  firstFailure,
  reparentCallsUnderPushes,
  STEP_CAP
} from '../../../services/event-path/tree.js'
import type { PathStep } from '../../../services/event-path/types.js'

const T0 = '2026-09-24T10:00:00.000Z'
const at = (ms: number) => new Date(Date.parse(T0) + ms).toISOString()
const root: PathStep = {
  key: 'request:c1',
  parent: null,
  kind: 'request',
  at: T0,
  summary: 'LinX mutation'
}

describe('buildTree', () => {
  it('nests by parent, orders children by time, computes offsets', () => {
    const { root: r } = buildTree(root, [
      { key: 'history:2', parent: 'request:c1', kind: 'transition', at: at(400), summary: 't' },
      { key: 'activity:1', parent: 'request:c1', kind: 'write', at: at(100), summary: 'w' },
      { key: 'submission:3', parent: 'history:2', kind: 'push', at: at(900), summary: 'p' }
    ])
    expect(r.children.map((c) => c.key)).toEqual(['activity:1', 'history:2'])
    expect(r.children[1].children[0].key).toBe('submission:3')
    expect(r.children[1].children[0].offset_ms).toBe(900)
  })

  it('attaches steps with an unknown or null parent to the root', () => {
    const { root: r } = buildTree(root, [
      { key: 'activity:9', parent: 'history:404', kind: 'write', at: at(5), summary: 'orphan' },
      { key: 'activity:8', parent: null, kind: 'write', at: at(1), summary: 'top' }
    ])
    expect(r.children.map((c) => c.key)).toEqual(['activity:8', 'activity:9'])
  })

  it('attaches a self-parented step to the root', () => {
    const { root: r } = buildTree(root, [
      { key: 'activity:1', parent: 'activity:1', kind: 'write', at: at(1), summary: 'self' }
    ])
    expect(r.children.map((c) => c.key)).toEqual(['activity:1'])
  })

  it('breaks a parent cycle by attaching it to the root', () => {
    const { root: r } = buildTree(root, [
      { key: 'history:1', parent: 'history:2', kind: 'transition', at: at(1), summary: 'a' },
      { key: 'history:2', parent: 'history:1', kind: 'transition', at: at(2), summary: 'b' }
    ])
    expect(r.children.map((c) => c.key)).toEqual(['history:1'])
    expect(r.children[0].children.map((c) => c.key)).toEqual(['history:2'])
  })

  it(`folds more than ${FOLD_THRESHOLD} writes to one collection under one parent`, () => {
    const writes: PathStep[] = Array.from({ length: 132 }, (_, i) => ({
      key: `activity:${i}`,
      parent: 'request:c1',
      kind: 'write',
      at: at(i),
      summary: 'updated',
      record: { collection: 'workflow_line_items', item: String(i) }
    }))
    const { root: r } = buildTree(root, writes)
    expect(r.children).toHaveLength(1)
    expect(r.children[0].kind).toBe('group')
    expect(r.children[0].summary).toBe('132 workflow line items updated')
    expect(r.children[0].members).toHaveLength(132)
  })

  it('does not fold exactly the threshold', () => {
    const writes: PathStep[] = Array.from({ length: FOLD_THRESHOLD }, (_, i) => ({
      key: `activity:${i}`,
      parent: 'request:c1',
      kind: 'write',
      at: at(i),
      summary: 'u',
      record: { collection: 'x', item: String(i) }
    }))
    expect(buildTree(root, writes).root.children).toHaveLength(FOLD_THRESHOLD)
  })

  it(`caps at ${STEP_CAP} and sets truncated`, () => {
    const many: PathStep[] = Array.from({ length: STEP_CAP + 10 }, (_, i) => ({
      key: `activity:${i}`,
      parent: `history:${i}`,
      kind: 'write',
      at: at(i),
      summary: 'u'
    }))
    const out = buildTree(root, many)
    expect(out.truncated).toBe(true)
    expect(out.count).toBe(STEP_CAP)
  })
})

describe('buildTree truncation', () => {
  it('drops writes first: a failed push after 2,000+ writes survives and is the first failure', () => {
    const writes: PathStep[] = Array.from({ length: STEP_CAP + 10 }, (_, i) => ({
      key: `activity:${i}`,
      parent: 'request:c1',
      kind: 'write',
      at: at(i),
      summary: 'u'
    }))
    const push: PathStep = {
      key: 'submission:9',
      parent: 'request:c1',
      kind: 'push',
      at: at(STEP_CAP + 50),
      summary: 'Push to LinX · failed',
      failed: true
    }
    const hist: PathStep = {
      key: 'history:1',
      parent: 'request:c1',
      kind: 'transition',
      at: at(STEP_CAP + 40),
      summary: 't'
    }
    const out = buildTree(root, [...writes, hist, push])
    expect(out.truncated).toBe(true)
    expect(out.count).toBe(STEP_CAP)
    const keys = out.root.children.map((c) => c.key)
    expect(keys).toContain('submission:9')
    expect(keys).toContain('history:1')
    // the oldest writes are the ones kept
    expect(keys).toContain('activity:0')
    expect(keys).not.toContain(`activity:${STEP_CAP + 9}`)
    expect(firstFailure(out.root)).toBe('submission:9')
  })
})

describe('filterHiddenSubtrees', () => {
  const secret = { collection: 'workflows', item: '1' }
  const open = { collection: 'workflows', item: '2' }
  const steps: PathStep[] = [
    {
      key: 'history:1',
      parent: 'request:c1',
      kind: 'transition',
      at: at(1),
      summary: 't',
      record: secret
    },
    {
      key: 'submission:2',
      parent: 'history:1',
      kind: 'push',
      at: at(2),
      summary: 'p',
      record: secret
    },
    { key: 'attempt:3', parent: 'submission:2', kind: 'attempt', at: at(3), summary: 'a' },
    { key: 'call:4', parent: 'submission:2', kind: 'partner_call', at: at(4), summary: 'c' },
    { key: 'flow_run:5', parent: 'history:1', kind: 'flow', at: at(5), summary: 'f' },
    {
      key: 'activity:6',
      parent: 'flow_run:5',
      kind: 'write',
      at: at(6),
      summary: 'w',
      record: open
    },
    { key: 'call:7', parent: 'activity:6', kind: 'partner_call', at: at(7), summary: 'c2' },
    { key: 'call:8', parent: 'request:c1', kind: 'partner_call', at: at(8), summary: 'top' }
  ]
  const canRead = (r: { collection: string; item: string }) => r.item !== '1'

  it('drops a hidden step with its whole subtree and counts every dropped step', () => {
    const out = filterHiddenSubtrees(steps, canRead)
    expect(out.steps.map((s) => s.key)).toEqual(['activity:6', 'call:7', 'call:8'])
    expect(out.hidden).toBe(5)
  })

  it('keeps a descendant with its own readable record; it re-attaches to the root', () => {
    const out = filterHiddenSubtrees(steps, canRead)
    const tree = buildTree(root, out.steps).root
    expect(tree.children.map((c) => c.key)).toEqual(['activity:6', 'call:8'])
    expect(tree.children[0].children.map((c) => c.key)).toEqual(['call:7'])
  })

  it('a hidden push takes its re-parented calls with it', () => {
    const out = filterHiddenSubtrees(
      reparentCallsUnderPushes([
        {
          key: 'submission:2',
          parent: 'request:c1',
          kind: 'push',
          at: at(2),
          summary: 'p',
          record: secret,
          api_id: 3
        },
        {
          key: 'call:4',
          parent: 'request:c1',
          kind: 'partner_call',
          at: at(4),
          summary: 'c',
          api_id: 3
        }
      ]),
      canRead
    )
    expect(out.steps).toEqual([])
    expect(out.hidden).toBe(2)
  })
})

describe('firstFailure', () => {
  it('returns the earliest failed step in tree order', () => {
    const { root: r } = buildTree(root, [
      { key: 'history:2', parent: 'request:c1', kind: 'transition', at: at(400), summary: 't' },
      {
        key: 'submission:3',
        parent: 'history:2',
        kind: 'push',
        at: at(900),
        summary: 'p',
        failed: true
      },
      {
        key: 'submission:4',
        parent: 'request:c1',
        kind: 'push',
        at: at(950),
        summary: 'p2',
        failed: true
      }
    ])
    expect(firstFailure(r)).toBe('submission:3')
  })
  it('returns null when nothing failed', () => {
    expect(firstFailure(buildTree(root, []).root)).toBeNull()
  })
})

describe('reparentCallsUnderPushes', () => {
  it('moves a partner call under the sibling push to the same API within 5 s', () => {
    const out = reparentCallsUnderPushes([
      {
        key: 'call:1',
        parent: 'history:2',
        kind: 'partner_call',
        at: at(800),
        summary: 'c',
        api_id: 9
      },
      {
        key: 'submission:3',
        parent: 'history:2',
        kind: 'push',
        at: at(900),
        summary: 'p',
        api_id: 9
      },
      {
        key: 'call:2',
        parent: 'history:2',
        kind: 'partner_call',
        at: at(8000),
        summary: 'late',
        api_id: 9
      }
    ])
    expect(out.find((s) => s.key === 'call:1')?.parent).toBe('submission:3')
    expect(out.find((s) => s.key === 'call:2')?.parent).toBe('history:2')
  })
})

describe('rootKeyOf', () => {
  it('names the root the top steps point at, never a fallback parent', async () => {
    const { rootKeyOf } = await import('../../../services/event-path/index.js')
    const steps: PathStep[] = [
      { key: 'activity:1', parent: 'auto', kind: 'write', at: T0, summary: 'a' },
      { key: 'activity:2', parent: 'cron:nightly', kind: 'write', at: T0, summary: 'b' },
      { key: 'history:3', parent: 'activity:2', kind: 'transition', at: T0, summary: 'c' }
    ]
    expect(rootKeyOf(steps)).toBe('cron:nightly')
    expect(rootKeyOf([{ ...steps[0] }])).toBeNull()
  })
})

describe('reparentCallsUnderPushes', () => {
  const push = (key: string, ms: number, failed = false): PathStep => ({
    key,
    parent: 'history:7',
    kind: 'push',
    at: at(ms),
    summary: key,
    failed,
    api_id: 3
  })
  const call = (key: string, ms: number, failed = false): PathStep => ({
    key,
    parent: 'history:7',
    kind: 'partner_call',
    at: at(ms),
    summary: key,
    failed,
    api_id: 3
  })

  it('gives two pushes to one API under one transition their own calls', () => {
    // MWF state push, then the completion push — each row written after its
    // call answered. The second call failed; it belongs under the second push.
    const out = reparentCallsUnderPushes([
      push('submission:1', 300),
      push('submission:2', 900, true),
      call('call:10', 100),
      call('call:11', 700, true)
    ])
    const parentOf = (k: string) => out.find((s) => s.key === k)?.parent
    expect(parentOf('call:10')).toBe('submission:1')
    expect(parentOf('call:11')).toBe('submission:2')
  })

  it('falls back to any push within 5 s when none follows the call', () => {
    const out = reparentCallsUnderPushes([push('submission:1', 0), call('call:10', 2000)])
    expect(out.find((s) => s.key === 'call:10')?.parent).toBe('submission:1')
  })

  it('leaves a call on another API or parent alone', () => {
    const other = { ...call('call:10', 100), api_id: 9 }
    const out = reparentCallsUnderPushes([push('submission:1', 300), other])
    expect(out.find((s) => s.key === 'call:10')?.parent).toBe('history:7')
  })
})
