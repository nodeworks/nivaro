import { beforeEach, describe, expect, it, vi } from 'vitest'

const linkLabels = vi.fn()
vi.mock('../../../services/ai-link-labels.js', () => ({ linkLabelsAsUser: linkLabels }))
const QUEUES = [
  { id: '241FC3F9-C3C2-4BDB-8E0F-0000000000A1', name: 'Warehouse approvals', owner: 'X', is_shared: true, role_id: null },
  { id: '241FC3F9-C3C2-4BDB-8E0F-0000000000B2', name: 'Rob only', owner: 'X', is_shared: false, role_id: null }
]
vi.mock('../../../middleware/authenticate.js', () => ({ isActiveAdmin: async () => false }))
vi.mock('../../../db/index.js', () => ({
  db: vi.fn((table?: string) => {
    const b: Record<string, unknown> = {}
    b.whereIn = vi.fn(() => b)
    b.select = vi.fn(async () => (table === 'nivaro_queues' ? QUEUES : []))
    b.where = vi.fn((w: { collection?: string }) => {
      b._c = w.collection
      return b
    })
    b.first = vi.fn(async () =>
      b._c === 'requests' || b._c === 'salaries' ? { collection: b._c } : undefined
    )
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

  // Rob 2026-11-14: the online list said "Queues" with the raw URL — name the worklist.
  it('names a worklist only for a viewer who may see it', async () => {
    const out = await resolveRecordLabels(['/queues/241fc3f9-c3c2-4bdb-8e0f-0000000000a1', '/queues/241FC3F9-C3C2-4BDB-8E0F-0000000000B2'], VIEWER)
    expect(presencePageLabel('/queues/241fc3f9-c3c2-4bdb-8e0f-0000000000a1', out)).toBe('Queues › Warehouse approvals')
    expect(presencePageLabel('/queues/241FC3F9-C3C2-4BDB-8E0F-0000000000B2', out)).toBe('Queues')
  })

  it('names a record only when the viewer got a label for it', () => {
    const labels = new Map([['requests:5', 'REQ-5']])
    expect(presencePageLabel('/collections/requests/5', labels)).toBe('Requests › REQ-5')
    // A record they cannot read: the collection title only, never the id.
    expect(presencePageLabel('/collections/salaries/123', labels)).toBe('Salaries')
    expect(presencePageLabel('/collections/salaries', labels)).toBe('Salaries')
    expect(presencePageLabel('/records/salaries/new', labels)).toBe('Salaries › New')
  })

  it('reads other routes as their first segment', () => {
    expect(presencePageLabel('/sla-rules/4?x=1', new Map())).toBe('Sla Rules')
    expect(presencePageLabel('/', new Map())).toBe('Home')
    expect(presencePageLabel('/admin/imports', new Map())).toBe('Admin › Imports')
    expect(presencePageLabel('/admin/data-integrity?tab=people', new Map())).toBe(
      'Admin › Data Integrity'
    )
    expect(presencePageLabel('/flows/3f525bd5-6b8f-4016-81eb-95a03432b467', new Map())).toBe(
      'Flows'
    )
    expect(presencePageLabel('/workflows/CM26-80332', new Map())).toBe('Workflows')
    expect(presencePageLabel(null, new Map())).toBeNull()
  })
})
