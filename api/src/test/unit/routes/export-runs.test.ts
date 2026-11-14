import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Background exports (#2122 follow-up): a big export runs the SAME build as the synchronous
// answer, as the person who asked, reports rows done / total, can be cancelled, and leaves a
// private file for them with a "Your export is ready" notice.

const state = vi.hoisted(() => ({
  reads: [] as Array<{ user: string; offset: number; limit: number; count: unknown }>,
  /** When set, the read at this offset waits for `release()`. */
  holdAt: null as number | null,
  hold: null as Promise<void> | null,
  release: () => {},
  progress: [] as Array<Record<string, unknown>>,
  tray: [] as Array<{ user: string; ev: Record<string, unknown> }>,
  uploads: [] as Array<{ user: string; buffer: Buffer; name: string; private: boolean }>,
  notices: [] as Array<{ user: string; opts: Record<string, unknown> }>,
  runs: new Map<number, Record<string, unknown>>(),
  nextRun: 1
}))

vi.mock('../../../middleware/authenticate.js', () => {
  const auth = async (req: any, reply: any) => {
    const id = req.headers['x-user']
    if (!id) return reply.code(401).send({ error: 'Unauthorized' })
    req.user = { id, role: 'r-approver' }
    req.isAdmin = req.headers['x-admin'] === '1'
  }
  return { authenticate: vi.fn(auth), requireAuth: vi.fn(auth) }
})
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))
vi.mock('../../../services/permissions.js', () => ({ can: vi.fn(async () => true) }))
vi.mock('../../../services/live-progress.js', () => ({
  emitJobProgress: vi.fn((user: string, ev: Record<string, unknown>) =>
    state.tray.push({ user, ev })
  )
}))
vi.mock('../../../services/job-runs.js', () => ({
  startJobRun: vi.fn(async (kind: string, jobId: string, opts: { triggeredBy: string }) => {
    const id = state.nextRun++
    const row: Record<string, unknown> = {
      id,
      kind,
      job_id: jobId,
      status: 'running',
      triggered_by: opts.triggeredBy,
      outcome: null,
      progress: null
    }
    state.runs.set(id, row)
    return {
      id,
      progress: (p: Record<string, unknown>) => {
        state.progress.push(p)
        row.progress = JSON.stringify(p)
      },
      log: () => {},
      complete: async (outcome: string) => {
        row.status = 'completed'
        row.outcome = outcome
      },
      fail: async (err: unknown) => {
        row.status = 'error'
        row.error = String(err)
      }
    }
  })
}))
vi.mock('../../../services/files.js', () => ({
  uploadFileBuffer: vi.fn(
    async (
      user: { id: string },
      buffer: Buffer,
      name: string,
      _type: string,
      _folder: unknown,
      opts: { private?: boolean }
    ) => {
      state.uploads.push({ user: user.id, buffer, name, private: !!opts?.private })
      return { id: `f0000000-0000-0000-0000-00000000000${state.uploads.length}` }
    }
  )
}))
vi.mock('../../../services/notification-channels.js', () => ({
  notifyUser: vi.fn(async (_app: unknown, user: string, opts: Record<string, unknown>) => {
    state.notices.push({ user, opts })
    return { id: 1 }
  })
}))
vi.mock('../../../services/mail-builders.js', () => ({ buildExportReadyMail: async () => null }))

// 2,500 rows: the even ones belong to Paul's region (his User Scope), the odd ones do not.
const ROWS = Array.from({ length: 2500 }, (_, i) => ({
  id: i + 1,
  title: `Row ${i + 1}`,
  status: i % 3 === 0 ? 'closed' : 'open',
  region: (i + 1) % 2 === 0 ? 'east' : 'west'
}))

vi.mock('../../../services/items.js', () => ({
  LIST_READ_MAX: 1000,
  readItems: vi.fn(
    async (
      user: { id: string },
      _c: string,
      q: { fields?: string[]; limit?: number; offset?: number; count?: boolean },
      req?: { query?: { conditions?: string } }
    ) => {
      const offset = q.offset ?? 0
      const limit = Math.min(q.limit ?? 25, 1000)
      state.reads.push({ user: user.id, offset, limit, count: q.count })
      if (state.holdAt != null && offset === state.holdAt && state.hold) await state.hold
      // As the person: Paul sees only his region; the list's conditions ride on req.query.
      let rows = ROWS.filter((r) => user.id !== 'u-paul' || r.region === 'east')
      const cond = req?.query?.conditions ? JSON.parse(req.query.conditions) : []
      for (const c of cond as Array<{ field: string; value: unknown }>)
        rows = rows.filter((r) => (r as Record<string, unknown>)[c.field] === c.value)
      const fields = q.fields ?? ['*']
      const page = rows
        .slice(offset, offset + limit)
        .map((r) =>
          fields.includes('*')
            ? r
            : Object.fromEntries(fields.map((f) => [f, (r as Record<string, unknown>)[f]]))
        )
      return { data: page, total: q.count === false ? null : rows.length }
    }
  )
}))
vi.mock('../../../db/index.js', () => ({
  db: vi.fn((t: string) => {
    const c: Record<string, any> = {}
    let where: Record<string, unknown> = {}
    for (const m of ['orderBy', 'select']) c[m] = vi.fn(() => c)
    c.where = vi.fn((k: unknown, v?: unknown) => {
      where = typeof k === 'object' ? (k as Record<string, unknown>) : { [String(k)]: v }
      return c
    })
    c.first = vi.fn(async () => {
      if (t === 'nivaro_export_presets')
        return {
          collection: 'workflows',
          name: 'Open work',
          is_shared: 1,
          created_by: 'u-admin',
          config: JSON.stringify({
            format: 'csv',
            columns: [{ key: 'id' }, { key: 'title', label: 'Title' }, { key: 'status' }]
          })
        }
      if (t === 'nivaro_job_runs') return state.runs.get(Number(where.id))
      return undefined
    })
    return c
  })
}))

import { exportPresetRoutes } from '../../../routes/export-presets.js'
import { exportRunsRoutes } from '../../../routes/export-runs.js'
import { __resetBackgroundRuns } from '../../../services/background-runs.js'
import { __waitForExportRun } from '../../../services/export-runs.js'

let app: FastifyInstance
beforeEach(async () => {
  state.reads.length = 0
  state.progress.length = 0
  state.tray.length = 0
  state.uploads.length = 0
  state.notices.length = 0
  state.runs.clear()
  state.holdAt = null
  state.hold = null
  __resetBackgroundRuns()
  delete process.env.EXPORT_BACKGROUND_ROWS
  app = Fastify({ logger: false })
  await app.register(exportPresetRoutes, { prefix: '/export-presets' })
  await app.register(exportRunsRoutes, { prefix: '/export-runs' })
})
afterEach(async () => {
  await app.close()
})

const OPEN = JSON.stringify([{ field: 'status', op: 'eq', value: 'open' }])
const paul = { 'x-user': 'u-paul' }

async function startBackground(body: Record<string, unknown>, headers = paul) {
  const res = await app.inject({
    method: 'POST',
    url: '/export-presets/5/run-async',
    headers,
    payload: body
  })
  return res
}

describe('background preset export', () => {
  it('writes exactly the file the synchronous export answers, as the person', async () => {
    const sync = await app.inject({
      method: 'GET',
      url: `/export-presets/5/run?conditions=${encodeURIComponent(OPEN)}`,
      headers: paul
    })
    expect(sync.statusCode).toBe(200)
    const res = await startBackground({ conditions: OPEN, background: 'always' })
    expect(res.statusCode).toBe(202)
    const { data } = res.json()
    expect(data.mode).toBe('background')
    expect(data.key).toBe(`job:${data.run_id}`)
    await __waitForExportRun(data.run_id)

    expect(state.uploads).toHaveLength(1)
    const up = state.uploads[0]
    expect(up.buffer.toString('utf8')).toBe(sync.rawPayload.toString('utf8'))
    // Paul's 1,250 rows, of which the open ones (more than one page): every page was read.
    const lines = up.buffer.toString('utf8').replace(/^﻿/, '').split('\n')
    const expected = ROWS.filter((r) => r.region === 'east' && r.status === 'open').length
    expect(lines).toHaveLength(expected + 1)
    expect(expected).toBeGreaterThan(800)
    // Every read ran as Paul; the file is his and private.
    expect(new Set(state.reads.map((r) => r.user))).toEqual(new Set(['u-paul']))
    expect(up.user).toBe('u-paul')
    expect(up.private).toBe(true)
    expect(up.name).toBe('Open work.csv')
    // Done: the tray's chip reads the file from the outcome; the person is told.
    const run = state.runs.get(data.run_id)!
    expect(run.status).toBe('completed')
    expect(String(run.outcome)).toMatch(/→ file f0000000-0000-0000-0000-000000000001$/)
    expect(state.notices).toHaveLength(1)
    expect(state.notices[0].user).toBe('u-paul')
    expect(state.notices[0].opts.subject).toBe('Your export is ready')
    expect(state.notices[0].opts.target).toEqual({
      kind: 'external',
      url: '/api/files/f0000000-0000-0000-0000-000000000001?download=1'
    })
  })

  it('pages past 1,000 rows (the sync export used to stop at one read)', async () => {
    const sync = await app.inject({ method: 'GET', url: '/export-presets/5/run', headers: paul })
    const lines = sync.body.replace(/^﻿/, '').split('\n')
    expect(lines).toHaveLength(1250 + 1)
    expect(state.reads.map((r) => r.offset)).toEqual([0, 1000])
  })

  it('reports rows done of the total, and Cancel is offered from the first tick', async () => {
    const res = await startBackground({ background: 'always' })
    const { data } = res.json()
    expect(data.total).toBe(1250)
    expect(data.cancel_path).toBe(`/export-runs/${data.run_id}/cancel`)
    await __waitForExportRun(data.run_id)
    const first = state.tray.find((t) => t.ev.key === data.key)!
    expect(first.user).toBe('u-paul')
    expect(first.ev.cancel_path).toBe(data.cancel_path)
    expect(state.progress[0]).toMatchObject({ done: 0, total: 1250, unit: 'rows' })
    expect(state.progress.at(-1)).toMatchObject({
      phase: 'Saving the file',
      done: 1250,
      total: 1250
    })
  })

  it('auto: a small export stays instant, a big one goes to the background', async () => {
    const small = await startBackground({ background: 'auto', conditions: OPEN })
    expect(small.statusCode).toBe(200)
    expect(small.json().data).toEqual({ mode: 'instant', rows: 833 })
    process.env.EXPORT_BACKGROUND_ROWS = '500'
    const big = await startBackground({ background: 'auto', conditions: OPEN })
    expect(big.statusCode).toBe(202)
    await __waitForExportRun(big.json().data.run_id)
  })

  it('never starts under View-as: auto answers instant, always is refused', async () => {
    const viewAs = Fastify({ logger: false })
    viewAs.addHook('preHandler', async (req: any) => {
      req.masqueradeAdminId = 'u-admin'
    })
    await viewAs.register(exportPresetRoutes, { prefix: '/export-presets' })
    const auto = await viewAs.inject({
      method: 'POST',
      url: '/export-presets/5/run-async',
      headers: paul,
      payload: { background: 'auto' }
    })
    expect(auto.json().data.mode).toBe('instant')
    const always = await viewAs.inject({
      method: 'POST',
      url: '/export-presets/5/run-async',
      headers: paul,
      payload: { background: 'always' }
    })
    expect(always.statusCode).toBe(403)
    await viewAs.close()
  })
})

describe('cancel and status', () => {
  it('stops between pages: no file, no notice, the tray says Cancelled', async () => {
    state.holdAt = 1000
    state.hold = new Promise<void>((r) => {
      state.release = r
    })
    const { data } = (await startBackground({ background: 'always' })).json()
    // Wait until the job is parked on page 2.
    for (let i = 0; i < 50 && !state.reads.some((r) => r.offset === 1000); i++)
      await new Promise((r) => setTimeout(r, 5))

    const other = await app.inject({
      method: 'POST',
      url: `/export-runs/${data.run_id}/cancel`,
      headers: { 'x-user': 'u-ann' }
    })
    expect(other.statusCode).toBe(404)
    const peek = await app.inject({
      method: 'GET',
      url: `/export-runs/${data.run_id}`,
      headers: { 'x-user': 'u-ann' }
    })
    expect(peek.statusCode).toBe(404)

    const mine = await app.inject({
      method: 'GET',
      url: `/export-runs/${data.run_id}`,
      headers: paul
    })
    expect(mine.json().data).toMatchObject({ status: 'running', cancel_path: data.cancel_path })

    const cancel = await app.inject({
      method: 'POST',
      url: `/export-runs/${data.run_id}/cancel`,
      headers: paul
    })
    expect(cancel.json().data.outcome).toBe('stopped')
    state.release()
    await __waitForExportRun(data.run_id)

    expect(state.uploads).toHaveLength(0)
    expect(state.notices).toHaveLength(0)
    expect(state.runs.get(data.run_id)!.outcome).toBe('Cancelled')
    expect(state.tray.some((t) => t.ev.key === data.key && t.ev.status === 'canceled')).toBe(true)
    const after = await app.inject({
      method: 'GET',
      url: `/export-runs/${data.run_id}`,
      headers: paul
    })
    expect(after.json().data.status).toBe('canceled')
    // No page after the cancelled one was read.
    expect(state.reads.filter((r) => r.offset > 1000)).toHaveLength(0)
  })

  it('a finished run cannot be cancelled', async () => {
    const { data } = (await startBackground({ background: 'always' })).json()
    await __waitForExportRun(data.run_id)
    const res = await app.inject({
      method: 'POST',
      url: `/export-runs/${data.run_id}/cancel`,
      headers: paul
    })
    expect(res.json().data.outcome).toBe('finished')
    const got = await app.inject({
      method: 'GET',
      url: `/export-runs/${data.run_id}`,
      headers: paul
    })
    expect(got.json().data).toMatchObject({
      status: 'completed',
      file_id: 'f0000000-0000-0000-0000-000000000001'
    })
  })
})
