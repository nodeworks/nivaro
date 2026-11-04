import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn(), dbRead: vi.fn() }))
vi.mock('../../../services/edit-lock.js', () => ({
  adminOnlyTransitionsFor: vi.fn(async () => new Set(['T-CANCEL'])),
  adminOnlyStatesFor: vi.fn(async () => new Set(['approved']))
}))

import { applyAdminOnlyTransitions, type TransitionRow } from '../../../services/record-instance.js'

const tx = (id: string) => ({ id, template: 't', from_state: null }) as unknown as TransitionRow
const entry = (key: string) => ({
  state: { key } as never,
  available: [tx('t-cancel'), tx('t-forward')]
})

describe('applyAdminOnlyTransitions (list / row-menu offer)', () => {
  it('drops the listed moves for a non-admin at an admin-only state', async () => {
    const e = entry('approved')
    await applyAdminOnlyTransitions('workflows', [e], { role: 'r', isAdmin: false })
    expect(e.available.map((t) => t.id)).toEqual(['t-forward'])
  })

  it('keeps them while the record is still in an approval state, and for admins', async () => {
    const open = entry('l1_approval')
    const admin = entry('approved')
    await applyAdminOnlyTransitions('workflows', [open], { role: 'r', isAdmin: false })
    await applyAdminOnlyTransitions('workflows', [admin], { role: 'r', isAdmin: true })
    expect(open.available).toHaveLength(2)
    expect(admin.available).toHaveLength(2)
  })
})
