import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: vi.fn(), dbRead: vi.fn() }))

import {
  applyOwnerOnly,
  type InstanceRow,
  type TransitionRow
} from '../../../services/record-instance.js'

const ME = 'AB000000-0000-4000-8000-000000000001'
const OTHER = 'AB000000-0000-4000-8000-000000000002'

const inst = (id: string, state: string | null = 'S1'): InstanceRow => ({
  id,
  template: 'T',
  collection: 'workflows',
  item: id.replace('i', ''),
  current_state: state,
  started_at: null,
  completed_at: null
})
const tx = (id: string, requireOwner: unknown = false): TransitionRow => ({
  id,
  template: 'T',
  from_state: 'S1',
  to_state: 'S2',
  label: id,
  color: null,
  required_roles: null,
  sort: 0,
  require_owner: requireOwner
})
const page = () => [
  { instance: inst('i1'), available: [tx('approve', true), tx('send-back')] },
  { instance: inst('i2'), available: [tx('approve', 1), tx('send-back')] },
  { instance: inst('i3'), available: [tx('send-back')] }
]
const ids = (e: { available: TransitionRow[] }) => e.available.map((t) => t.id)

describe('applyOwnerOnly ($workflow_instance.available_transitions, #794)', () => {
  it('keeps owner-only moves for the owner and hides them from everyone else', async () => {
    const entries = page()
    const resolve = vi.fn(
      async () =>
        new Map([
          ['i1', [{ id: ME.toLowerCase() }]],
          ['i2', [{ id: OTHER }]]
        ])
    )
    await applyOwnerOnly(entries, { role: 'r', isAdmin: false, userId: ME }, resolve)
    expect(entries.map(ids)).toEqual([['approve', 'send-back'], ['send-back'], ['send-back']])
  })

  it('resolves owners ONCE per page, only for instances offering an owner-only move', async () => {
    const resolve = vi.fn(async () => new Map())
    await applyOwnerOnly(page(), { role: 'r', isAdmin: false, userId: ME }, resolve)
    expect(resolve).toHaveBeenCalledTimes(1)
    expect((resolve.mock.calls[0] as unknown as [InstanceRow[]])[0].map((i) => i.id)).toEqual([
      'i1',
      'i2'
    ])
  })

  it('admins keep everything and nothing is resolved', async () => {
    const entries = page()
    const resolve = vi.fn(async () => new Map())
    await applyOwnerOnly(entries, { role: 'admin', isAdmin: true, userId: ME }, resolve)
    expect(resolve).not.toHaveBeenCalled()
    expect(entries.map(ids)).toEqual([
      ['approve', 'send-back'],
      ['approve', 'send-back'],
      ['send-back']
    ])
  })

  it('a page with no owner-only moves costs nothing', async () => {
    const resolve = vi.fn(async () => new Map())
    await applyOwnerOnly(
      [{ instance: inst('i3'), available: [tx('send-back')] }],
      { role: 'r', isAdmin: false, userId: ME },
      resolve
    )
    expect(resolve).not.toHaveBeenCalled()
  })

  it('fails closed: no viewer id, or an owner lookup that throws, hides the move', async () => {
    const noId = page()
    await applyOwnerOnly(
      noId,
      { role: 'r', isAdmin: false },
      vi.fn(async () => new Map())
    )
    expect(noId.map(ids)).toEqual([['send-back'], ['send-back'], ['send-back']])
    const broken = page()
    await applyOwnerOnly(
      broken,
      { role: 'r', isAdmin: false, userId: ME },
      vi.fn(async () => {
        throw new Error('db down')
      })
    )
    expect(broken.map(ids)).toEqual([['send-back'], ['send-back'], ['send-back']])
  })
})
