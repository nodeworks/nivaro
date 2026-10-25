import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// POST /items/:collection/bulk?async=1 runs in the background without the
// request. The approval-state edit lock (edit-lock.ts) skips writes that carry
// no request, so the background run hands it the caller's admin flag: a
// non-owner's async update of an edit-locked record is refused per row, as
// the synchronous path refuses it, and the job itself does not fail.

const who = vi.hoisted(() => ({ isAdmin: false }))
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'USER-1', role: 'ROLE-1' }
    req.isAdmin = who.isAdmin
  }
}))
vi.mock('../../../middleware/workspace.js', () => ({ resolveWorkspace: async () => {} }))
vi.mock('../../../services/idempotency.js', () => ({
  idempotencyPreHandler: () => async () => {}
}))
vi.mock('../../../services/activity.js', async (orig) => ({
  ...(await orig<object>()),
  logActivity: vi.fn(async () => null)
}))
const run = vi.hoisted(() => ({
  id: 7,
  progress: vi.fn(),
  complete: vi.fn(async () => {}),
  fail: vi.fn(async () => {})
}))
vi.mock('../../../services/job-runs.js', async (orig) => ({
  ...(await orig<object>()),
  startJobRun: vi.fn(async () => run)
}))
vi.mock('../../../services/job-cancel.js', () => ({
  isCancelled: () => false,
  clearCancel: () => {}
}))
vi.mock('../../../services/permissions.js', async (orig) => ({
  ...(await orig<object>()),
  can: vi.fn(async () => true)
}))
const lock = vi.hoisted(() => ({
  calls: [] as Array<{ ids?: unknown[]; isAdmin: unknown; hasReq: boolean }>
}))
vi.mock('../../../services/edit-lock.js', async (orig) => {
  const real = await orig<typeof import('../../../services/edit-lock.js')>()
  return {
    ...real,
    assertNotEditLocked: vi.fn(
      async (
        _u: unknown,
        _c: string,
        opts: { ids?: Array<string | number> },
        req?: { isAdmin?: boolean }
      ) => {
        lock.calls.push({ ids: opts.ids, isAdmin: req?.isAdmin, hasReq: !!req })
        if (!req) return
        if (!req.isAdmin && (opts.ids ?? []).map(String).includes('LOCKED'))
          throw new real.EditLockedError(
            'This record is at Level 1 Approval — only the person who created it, the owners of that step and administrators can change it.'
          )
      }
    )
  }
})
const svc = vi.hoisted(() => ({
  updateOne: vi.fn(async (_u: unknown, _c: string, id: string) => ({ id })),
  createOneReported: vi.fn(async () => ({
    id: 'NEW',
    item: { id: 'NEW' },
    readable: true,
    linkFailures: [],
    upserted: false
  }))
}))
vi.mock('../../../services/items.js', async (orig) => ({
  ...(await orig<object>()),
  ...svc
}))

import { itemsRoutes } from '../../../routes/items.js'

const stored = new Map<string, string>()
async function app() {
  const a = Fastify()
  a.decorate('redis', {
    set: vi.fn(async (k: string, v: string) => {
      stored.set(k, v)
      return 'OK'
    })
  } as never)
  await a.register(itemsRoutes, { prefix: '/api/items' })
  return a
}

async function finalState() {
  for (let i = 0; i < 100; i++) {
    const raw = stored.get('nvr:bulk:7')
    const state = raw ? JSON.parse(raw) : null
    if (state && state.status !== 'running') return state
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('bulk run never finished')
}

beforeEach(() => {
  stored.clear()
  lock.calls.length = 0
  svc.updateOne.mockClear()
  run.complete.mockClear()
  run.fail.mockClear()
  who.isAdmin = false
})

describe('POST /items/:collection/bulk?async=1 — approval-state edit lock', () => {
  it('refuses the locked row per row, writes the others, and completes the job', async () => {
    const res = await (await app()).inject({
      method: 'POST',
      url: '/api/items/workflows/bulk?async=1',
      payload: {
        rows: [
          { id: 'LOCKED', name: 'x' },
          { id: 'OPEN', name: 'y' }
        ]
      }
    })
    expect(res.statusCode).toBe(202)
    const state = await finalState()
    expect(state.status).toBe('completed')
    expect(state.results[0]).toMatchObject({ index: 0, status: 403, code: 'EDIT_LOCKED' })
    expect(state.results[1]).toMatchObject({ index: 1, status: 200, id: 'OPEN' })
    // The refused row never reached the write.
    expect(svc.updateOne.mock.calls.map((c) => c[2])).toEqual(['OPEN'])
    // The gate ran with the caller's context, not skipped for a missing request.
    expect(lock.calls.filter((c) => c.hasReq && c.isAdmin === false).length).toBeGreaterThan(0)
    expect(run.complete).toHaveBeenCalled()
    expect(run.fail).not.toHaveBeenCalled()
  })

  it('an all-refused run fails the job with a summary, not a throw', async () => {
    await (await app()).inject({
      method: 'POST',
      url: '/api/items/workflows/bulk?async=1',
      payload: { rows: [{ id: 'LOCKED', name: 'x' }] }
    })
    const state = await finalState()
    expect(state.status).toBe('completed')
    expect(state.failed).toBe(1)
    expect(run.fail).toHaveBeenCalledWith(expect.stringContaining('1 refused'))
  })

  it('an administrator passes', async () => {
    who.isAdmin = true
    await (await app()).inject({
      method: 'POST',
      url: '/api/items/workflows/bulk?async=1',
      payload: { rows: [{ id: 'LOCKED', name: 'x' }] }
    })
    const state = await finalState()
    expect(state.results[0]).toMatchObject({ status: 200, id: 'LOCKED' })
  })
})
