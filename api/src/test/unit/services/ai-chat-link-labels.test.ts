// query_items / saved_view label links through linkLabelsAsUser (as the
// asker); a link with no label for them stays a bare id, and the chat
// assistant's open-room reads can switch labels off altogether.
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
const linkLabelsAsUser = vi.fn(async (_u: unknown, _m: Map<string, Set<string>>) => ({
  'vendors:1': 'ACME',
  'nivaro_users:U1': 'Ana Lee'
}))
vi.mock('../../../services/ai-link-labels.js', () => ({
  linkLabelsAsUser: (u: unknown, m: Map<string, Set<string>>) => linkLabelsAsUser(u, m),
  linkLabelKey: (c: string, id: unknown) =>
    `${c}:${c === 'nivaro_users' ? String(id).toUpperCase() : String(id)}`
}))

import { chatLabelForeignKeys } from '../../../services/ai-chat.js'
import type { User } from '../../../types.js'

const ASKER = { id: 'ASKER', role: 'R' } as unknown as User
const rel = {
  m2o: [
    { field: 'vendor', collection: 'vendors' },
    { field: 'owner', collection: 'nivaro_users' }
  ],
  aliases: []
} as never

describe('chatLabelForeignKeys', () => {
  it('labels only what the asker could read; the rest stay bare ids', async () => {
    const rows = await chatLabelForeignKeys(
      ASKER,
      [
        { id: 10, vendor: 1, owner: 'u1' },
        { id: 11, vendor: 2, owner: 'u9' }
      ],
      rel
    )
    expect(linkLabelsAsUser.mock.calls[0][0]).toBe(ASKER)
    expect(rows).toEqual([
      { id: 10, vendor: { id: 1, label: 'ACME' }, owner: { id: 'u1', label: 'Ana Lee' } },
      { id: 11, vendor: 2, owner: 'u9' }
    ])
  })
  it('labels: false leaves every link bare and reads nothing', async () => {
    linkLabelsAsUser.mockClear()
    const rows = [{ id: 10, vendor: 1 }]
    expect(await chatLabelForeignKeys(ASKER, rows, rel, { labels: false })).toBe(rows)
    expect(linkLabelsAsUser).not.toHaveBeenCalled()
  })
})
