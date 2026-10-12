import type { FastifyBaseLogger } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// The item-write flow operation (#1849 — what a plan's record steps become in
// a draft flow): writes go through the items service AS the flow's person,
// a dry run only previews, and update targets are ids or a filter.

const updateOne = vi.fn(async (..._a: unknown[]) => ({}))
const createOne = vi.fn(async (..._a: unknown[]) => ({ id: 77 }))
const readItems = vi.fn(async (..._a: unknown[]) => ({ data: [{ id: 4 }, { id: 5 }] }))
vi.mock('../../../services/items.js', () => ({
  updateOne: (...a: unknown[]) => updateOne(...a),
  createOne: (...a: unknown[]) => createOne(...a),
  readItems: (...a: unknown[]) => readItems(...a)
}))
vi.mock('../../../services/users.js', () => ({
  getUser: async (id: string) => (id === 'U1' ? { id: 'U1', role: 'R' } : undefined)
}))

const { runItemWrite } = await import('../../../services/flow-executor.js')

const log = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn()
} as unknown as FastifyBaseLogger
const ctx = (over: Record<string, unknown> = {}) =>
  ({
    flowId: 'F1',
    flowName: 'F',
    trigger: 'test',
    payload: {},
    log,
    userId: 'U1',
    ...over
  }) as never
const op = (options: Record<string, unknown>) =>
  ({
    id: 'o1',
    flow: 'F1',
    name: 'Write',
    key: 'write',
    type: 'item-write',
    position_x: 0,
    position_y: 0,
    options: JSON.stringify(options),
    resolve: null,
    reject: null
  }) as never

beforeEach(() => {
  updateOne.mockClear()
  createOne.mockClear()
  readItems.mockClear()
})

describe('item-write flow operation', () => {
  it('updates templated ids as the person, with templated values', async () => {
    const out = await runItemWrite(
      op({ collection: 'orders', ids: '{{keys}}', data: { status: 'Closed', note: 'by {{who}}' } }),
      { keys: [1, 2], who: 'flow' },
      ctx()
    )
    expect(out.status).toBe('resolve')
    expect(updateOne).toHaveBeenCalledTimes(2)
    expect(updateOne).toHaveBeenCalledWith({ id: 'U1', role: 'R' }, 'orders', '1', {
      status: 'Closed',
      note: 'by flow'
    })
  })

  it('resolves a filter through readItems and only previews on a dry run', async () => {
    const out = await runItemWrite(
      op({ collection: 'orders', filter: { status: { _eq: 'Open' } }, data: { status: 'Closed' } }),
      {},
      ctx({ dryRun: true })
    )
    expect(readItems).toHaveBeenCalledWith(
      { id: 'U1', role: 'R' },
      'orders',
      expect.objectContaining({ filter: { status: { _eq: 'Open' } } })
    )
    expect(updateOne).not.toHaveBeenCalled()
    expect(out.output.$preview_write).toMatchObject({ records: 2, ids: ['4', '5'] })
  })

  it('creates, and refuses system collections or nobody to run as', async () => {
    const created = await runItemWrite(
      op({ mode: 'create', collection: 'orders', data: { title: 'x' } }),
      {},
      ctx()
    )
    expect(created.output.write).toEqual({ id: 77 })
    const sys = await runItemWrite(
      op({ collection: 'nivaro_users', ids: '1', data: { a: 1 } }),
      {},
      ctx()
    )
    expect(sys.status).toBe('reject')
    const ghost = await runItemWrite(
      op({ collection: 'orders', ids: '1', data: { a: 1 } }),
      {},
      ctx({ userId: 'U9' })
    )
    expect(ghost.output.$error).toMatch(/no longer exists/)
  })

  it('reports refused records as a failed operation', async () => {
    updateOne.mockRejectedValueOnce(new Error('locked'))
    const out = await runItemWrite(
      op({ collection: 'orders', ids: '1,2', data: { a: 1 } }),
      {},
      ctx()
    )
    expect(out.status).toBe('reject')
    expect(out.output.write).toMatchObject({ updated: 1, failed: 1, errors: ['1: locked'] })
  })
})
