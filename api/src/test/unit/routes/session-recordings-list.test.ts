import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/** GET /session-recordings/ — the list's sort options and stats columns (#1358, #1397). */

const h = vi.hoisted(() => ({
  calls: [] as Array<[string, unknown[]]>
}))

vi.mock('../../../db/index.js', () => {
  const db = vi.fn(() => {
    const chain: Record<string, unknown> = {}
    const rec =
      (name: string) =>
      (...args: unknown[]) => {
        h.calls.push([name, args])
        return chain
      }
    for (const m of ['leftJoin', 'orderBy', 'orderByRaw', 'select', 'where', 'offset'])
      chain[m] = vi.fn(rec(m))
    chain.modify = vi.fn((fn: (qb: unknown) => void) => {
      fn(chain)
      return chain
    })
    chain.limit = vi.fn(async () => [])
    return chain
  })
  ;(db as unknown as Record<string, unknown>).raw = vi.fn((sql: string) => ({ sql }))
  return { db }
})
vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: async () => undefined,
  requireAuth: async () => undefined,
  requireAdmin: async () => undefined
}))

import { sessionRecordingRoutes } from '../../../routes/session-recordings.js'

async function list(qs: string) {
  const app = Fastify()
  await app.register(sessionRecordingRoutes, { prefix: '/api/session-recordings' })
  return app.inject({ method: 'GET', url: `/api/session-recordings/${qs}` })
}

beforeEach(() => {
  h.calls = []
})

describe('GET /session-recordings/ sort', () => {
  it('defaults to newest first', async () => {
    const res = await list('')
    expect(res.statusCode).toBe(200)
    expect(h.calls.filter((c) => c[0] === 'orderByRaw')).toEqual([])
    expect(h.calls.find((c) => c[0] === 'orderBy')?.[1]).toEqual(['r.started_at', 'desc'])
  })

  it('?sort=active orders by active time, unmeasured rows last, newest as tiebreak', async () => {
    const res = await list('?sort=active')
    expect(res.statusCode).toBe(200)
    const order = h.calls.filter((c) => c[0] === 'orderByRaw' || c[0] === 'orderBy')
    expect(order[0]).toEqual(['orderByRaw', ['COALESCE(r.active_ms, -1) DESC']])
    expect(order[1]).toEqual(['orderBy', ['r.started_at', 'desc']])
  })

  it('selects the active time and chapter count for the row (#1358, #1397)', async () => {
    await list('')
    const select = h.calls.find((c) => c[0] === 'select')?.[1] ?? []
    expect(select).toContain('r.active_ms')
    expect(select).toContain('r.chapter_count')
  })
})
