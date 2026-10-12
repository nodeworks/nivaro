import { beforeEach, describe, expect, it, vi } from 'vitest'

const linkLabels = vi.fn()
vi.mock('../../../services/ai-link-labels.js', () => ({ linkLabelsAsUser: linkLabels }))
vi.mock('../../../db/index.js', () => ({
  db: vi.fn((table: string) => {
    const b: Record<string, unknown> = {}
    b.where = vi.fn((w: { collection?: string }) => {
      b._c = w.collection
      return b
    })
    b.first = vi.fn(async () => (b._c === 'requests' || b._c === 'salaries' ? { collection: b._c } : undefined))
    return b
  })
}))

import { presencePageLabel, resolveRecordLabels } from '../../../routes/presence.js'

const VIEWER = { id: 'U1', role: 'R' } as never

beforeEach(() => linkLabels.mockReset())

describe('presence page labels', () => {
  it('asks only for registered collections, as the viewer', async () => {
    linkLabels.mockResolvedValue({ 'requests:5': 'REQ-5' })
    const out = await resolveRecordLabels(
      ['/collections/requests/5', '/collections/secret_table/9', '/collections/nivaro_users/1'],
      VIEWER
    )
    expect(out.get('requests:5')).toBe('REQ-5')
    const [user, byTarget] = linkLabels.mock.calls[0]
    expect(user).toBe(VIEWER)
    expect([...byTarget.keys()]).toEqual(['requests'])
  })

  it('names a record only when the viewer got a label for it', () => {
    const labels = new Map([['requests:5', 'REQ-5']])
    expect(presencePageLabel('/collections/requests/5', labels)).toBe('Requests › REQ-5')
    // A record they cannot read: the collection title only, never the id.
    expect(presencePageLabel('/collections/salaries/123', labels)).toBe('Salaries')
    expect(presencePageLabel('/collections/salaries', labels)).toBe('Salaries')
  })

  it('reads other routes as their first segment', () => {
    expect(presencePageLabel('/sla-rules/4?x=1', new Map())).toBe('Sla Rules')
    expect(presencePageLabel('/', new Map())).toBe('Home')
    expect(presencePageLabel(null, new Map())).toBeNull()
  })
})
