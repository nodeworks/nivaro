import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Export presets (army 2026-10-25): a preset column `creator.static_token`
// exported a bearer credential for every readable row (critical), a parent
// outside the runner's scope exported its fields, and anyone could put a
// shared preset on everyone's export menu.

const who = vi.hoisted(() => ({ admin: false, canRead: true, hidden: new Set<string>() }))
const presetInserts = vi.hoisted(() => [] as Array<Record<string, unknown>>)

vi.mock('../../../middleware/authenticate.js', () => ({
  authenticate: vi.fn(async (req: { user?: unknown; isAdmin?: boolean }) => {
    req.user = { id: 'u-paul', role: 'role-approver' }
    req.isAdmin = who.admin
  })
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))
vi.mock('../../../services/permissions.js', () => ({ can: vi.fn(async () => who.canRead) }))
vi.mock('../../../services/items.js', () => ({
  readItems: vi.fn(async () => ({ data: [{ id: 1 }, { id: 2 }] }))
}))
vi.mock('../../../services/record-access.js', () => ({
  compileAccessGates: vi.fn(async () => ({})),
  visibleIds: vi.fn(
    async (_g: unknown, ids: string[]) => new Set(ids.filter((i) => !who.hidden.has(i)))
  )
}))
vi.mock('../../../services/db-batch.js', () => ({
  selectInChunks: vi.fn(async () => [
    { id: 1, vendor: 'V1' },
    { id: 2, vendor: 'V2' }
  ])
}))
vi.mock('../../../services/queues.js', () => ({
  pathReadableBy: vi.fn(async (_u: unknown, _c: string, segs: string[]) =>
    segs.includes('static_token')
      ? { readable: false, firstHop: null }
      : { readable: true, firstHop: { field: 'vendor', collection: 'vendors' } }
  ),
  resolvePathValues: vi.fn(
    async (_c: string, _ids: string[], segs: string[]) =>
      new Map([
        ['1', { value: segs.includes('static_token') ? 'nvt_SECRET' : 'Acme', ids: [] }],
        ['2', { value: segs.includes('static_token') ? 'nvt_SECRET' : 'Globex', ids: [] }]
      ])
  )
}))
vi.mock('../../../db/index.js', () => ({
  db: vi.fn((t: string) => {
    const c: Record<string, unknown> = {}
    for (const m of ['where', 'orderBy']) c[m] = vi.fn(() => c)
    c.first = vi.fn(async () =>
      t === 'nivaro_export_presets'
        ? {
            collection: 'workflows',
            name: 'Probe',
            is_shared: 1,
            created_by: 'u-paul',
            config: JSON.stringify({
              format: 'csv',
              columns: [{ key: 'id' }, { key: 'creator.static_token' }, { key: 'vendor.name' }]
            })
          }
        : undefined
    )
    c.insert = vi.fn((row: Record<string, unknown>) => {
      presetInserts.push(row)
      return { returning: vi.fn(async () => [{ id: 5 }]) }
    })
    return c
  })
}))

import { exportPresetRoutes } from '../../../routes/export-presets.js'

async function call(method: 'GET' | 'POST', url: string, payload?: unknown) {
  const app = Fastify({ logger: false })
  await app.register(exportPresetRoutes)
  return app.inject({ method, url, payload: payload as object })
}

beforeEach(() => {
  who.admin = false
  who.canRead = true
  who.hidden.clear()
  presetInserts.length = 0
})

describe('GET /:id/run — dotted columns', () => {
  it('exports a credential column blank and drops a hidden parent', async () => {
    who.hidden.add('V2')
    const res = await call('GET', '/5/run')
    expect(res.statusCode).toBe(200)
    expect(res.body).not.toContain('nvt_SECRET')
    const lines = res.body.replace(/^﻿/, '').split('\n')
    expect(lines[1]).toBe('1,,Acme')
    expect(lines[2]).toBe('2,,')
  })

  it('keeps a readable related value for the runner', async () => {
    const res = await call('GET', '/5/run')
    expect(res.body).toContain('2,,Globex')
  })
})

describe('POST / — preset create', () => {
  const body = {
    collection: 'workflows',
    name: 'Mine',
    config: { columns: [{ key: 'id' }] },
    is_shared: true
  }
  it('refuses a collection the caller cannot read', async () => {
    who.canRead = false
    expect((await call('POST', '/', body)).statusCode).toBe(403)
    expect(presetInserts).toHaveLength(0)
  })
  it('saves a non-admin preset as personal; an admin may share', async () => {
    expect((await call('POST', '/', body)).statusCode).toBe(201)
    expect(presetInserts[0].is_shared).toBe(false)
    who.admin = true
    await call('POST', '/', body)
    expect(presetInserts[1].is_shared).toBe(true)
  })
})
