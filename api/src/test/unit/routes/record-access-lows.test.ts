import { beforeEach, describe, expect, it, vi } from 'vitest'

// Lows (security audit 2026-10-27): record templates aimed at other roles,
// widget feeds after their creator is suspended, extension bulk actions over
// records the caller may not change.

const st = vi.hoisted(() => ({
  user: undefined as Record<string, unknown> | undefined,
  updatable: new Set<string>()
}))
vi.mock('../../../db/index.js', () => ({
  db: () => {
    const b: Record<string, unknown> = {}
    b.where = () => b
    b.first = async () => st.user
    return b
  }
}))
vi.mock('../../../services/items.js', () => ({
  canUpdateItem: vi.fn(async (_u: unknown, _c: string, id: unknown) => st.updatable.has(String(id)))
}))

import { notUpdatable } from '../../../routes/bulk-actions.js'
import { audienceRefusal } from '../../../routes/record-templates.js'
import { activeFeedCreator } from '../../../routes/widget.js'

beforeEach(() => {
  st.user = undefined
  st.updatable = new Set()
})

describe('record template audience', () => {
  it('lets a non-admin keep a template private or share it with their own role', () => {
    expect(audienceRefusal(false, 'R1', null, false)).toBeNull()
    expect(audienceRefusal(false, 'r1', 'R1', true)).toBeNull()
  })
  it('refuses aiming at another role or at every role', () => {
    expect(audienceRefusal(false, 'R1', 'R2', false)).toMatch(/another role/)
    expect(audienceRefusal(false, 'R1', null, true)).toMatch(/every role/)
  })
  it('leaves administrators free', () => {
    expect(audienceRefusal(true, 'R1', 'R2', true)).toBeNull()
  })
})

describe('widget feed creator', () => {
  it('serves while the creator is active', async () => {
    st.user = { id: 'U1', status: 'active' }
    expect(await activeFeedCreator('U1')).toMatchObject({ id: 'U1' })
  })
  it('stops for a suspended, redacted or missing creator', async () => {
    st.user = { id: 'U1', status: 'suspended' }
    expect(await activeFeedCreator('U1')).toBeNull()
    st.user = { id: 'U1', status: 'active', is_redacted: 1 }
    expect(await activeFeedCreator('U1')).toBeNull()
    st.user = undefined
    expect(await activeFeedCreator('U1')).toBeNull()
    expect(await activeFeedCreator(null)).toBeNull()
  })
})

describe('extension bulk actions judge each record', () => {
  it('names the records the caller may not change', async () => {
    st.updatable = new Set(['1', '3'])
    const req = { user: { id: 'U1' }, workspaceId: null } as never
    expect(await notUpdatable(req, 'orders', [1, 2, 3, '4'])).toEqual(['2', '4'])
  })
})
