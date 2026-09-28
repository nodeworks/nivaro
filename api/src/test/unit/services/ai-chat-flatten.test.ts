import { describe, expect, it } from 'vitest'
import { flattenPath } from '../../../services/ai-chat.js'

const node = (over: Record<string, unknown>) =>
  ({
    key: 'x',
    parent: null,
    kind: 'write',
    at: '2026-09-28T00:00:00.000Z',
    summary: 'wrote',
    children: [],
    offset_ms: 0,
    ...over
  }) as never

describe('flattenPath (#751)', () => {
  it('walks children depth-first with depth marks, records and failure flags', () => {
    const root = node({
      kind: 'request',
      who: 'LinX',
      summary: 'POST /graphql',
      children: [
        node({
          summary: 'created workflow',
          record: { collection: 'workflows', item: '1', label: 'CR26-1' },
          children: [node({ kind: 'push', summary: 'MWF push', failed: true, reason: 'HTTP 401' })]
        }),
        node({ kind: 'group', summary: '3 junction rows', members: [node({ summary: 'linked' })] })
      ]
    })
    const out = flattenPath(root)
    expect(out.map((s) => `${s.depth}:${s.kind}`)).toEqual([
      '0:request',
      '1:write',
      '2:push',
      '1:group',
      '2:write'
    ])
    expect(out[1].record).toBe('CR26-1 (workflows/1)')
    expect(out[2].failed).toBe(true)
    expect(out[2].reason).toBe('HTTP 401')
    expect(out[0].who).toBe('LinX')
  })

  it('caps the list', () => {
    const root = node({ children: Array.from({ length: 10 }, () => node({})) })
    expect(flattenPath(root, 4)).toHaveLength(4)
  })
})
