import { beforeEach, describe, expect, it, vi } from 'vitest'

// #960 (2026-11-08): updateUser — the write behind PATCH /users/:id — hands a person given a
// role (or reactivated) to the default-channel join; other edits do not.

const state = vi.hoisted(() => ({ joins: [] as Array<[string[], string]> }))

function chain(): unknown {
  const proxy: unknown = new Proxy(
    {},
    {
      get(_t, prop: string) {
        if (prop === 'then') return (res: (v: unknown) => void) => res(undefined)
        return () => proxy
      }
    }
  )
  return proxy
}

vi.mock('../../../db/index.js', () => ({ db: () => chain() }))
vi.mock('../../../services/chat-default-joins.js', () => ({
  joinDefaultChannelsSoon: vi.fn((ids: Iterable<string>, why: string) => {
    state.joins.push([[...ids], why])
    return Promise.resolve()
  })
}))

import { updateUser } from '../../../services/users.js'

const U = '11111111-1111-1111-1111-111111111111'
const ROLE = '22222222-2222-2222-2222-222222222222'

beforeEach(() => {
  state.joins = []
})

describe('updateUser → default chat channels', () => {
  it('a role change triggers the join', async () => {
    await updateUser(U, { role: ROLE } as never)
    expect(state.joins).toEqual([[[U], 'user updated']])
  })

  it('a reactivation triggers the join', async () => {
    await updateUser(U, { status: 'active' } as never)
    expect(state.joins).toHaveLength(1)
  })

  it('a name edit or a suspension does not', async () => {
    await updateUser(U, { first_name: 'Ada' } as never)
    await updateUser(U, { status: 'suspended' } as never)
    expect(state.joins).toEqual([])
  })
})
