import { beforeEach, describe, expect, it, vi } from 'vitest'

// A plain function, not vi.fn(): the spy's own promise tracking reports a
// rejection the code under test catches as unhandled.
const state = vi.hoisted(() => ({
  calls: [] as unknown[][],
  impl: (async () => ({ data: [] })) as (...a: unknown[]) => Promise<unknown>
}))
vi.mock('../../../services/items.js', () => ({
  readItems: (...a: unknown[]) => {
    state.calls.push(a)
    return state.impl(...a)
  }
}))

import { missingIds, notFoundError } from '../../../services/graphql-strict.js'
import type { User } from '../../../types.js'

const user = { id: 'U1', role: 'R1' } as unknown as User

describe('missingIds (strict mutations, read as the caller)', () => {
  beforeEach(() => {
    state.calls = []
  })

  it('reads through readItems as the caller, never the table raw', async () => {
    state.impl = async () => ({ data: [{ id: 4 }] })
    expect(await missingIds(user, 'regions', [4, 999])).toEqual(['999'])
    expect(state.calls).toHaveLength(1)
    const [caller, collection, query] = state.calls[0]
    expect(caller).toBe(user)
    expect(collection).toBe('regions')
    expect(query).toMatchObject({ fields: ['id'], filter: { id: { _in: ['4', '999'] } } })
  })

  it('answers a present-but-hidden id exactly like an absent one', async () => {
    // A row filter / User Scope hides id 7: readItems does not return it, and
    // an id that does not exist is not returned either.
    state.impl = async () => ({ data: [] })
    const hidden = await missingIds(user, 'regions', [7])
    const absent = await missingIds(user, 'regions', [8])
    expect(hidden).toEqual(['7'])
    expect(absent).toEqual(['8'])
    expect(notFoundError('regions', hidden).message).toBe('No regions record with id 7')
  })

  it('matches uniqueidentifiers case-insensitively', async () => {
    state.impl = async () => ({ data: [{ id: 'ABCDEF01-0000' }] })
    expect(await missingIds(user, 'contacts', ['abcdef01-0000'])).toEqual([])
  })

  it('fails closed when the caller cannot read the collection', async () => {
    state.impl = async () => {
      throw Object.assign(new Error('Forbidden'), { name: 'ForbiddenError' })
    }
    expect(await missingIds(user, 'regions', [1, 2])).toEqual(['1', '2'])
  })

  it('names every missing id in the error', () => {
    const e = notFoundError('regions', ['1', '2']) as Error & {
      extensions: { code: string; status: number; ids: string[] }
    }
    expect(e.extensions).toEqual({ code: 'NOT_FOUND', status: 404, ids: ['1', '2'] })
  })
})
