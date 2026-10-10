import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// "Report a problem" (#1390): the route files an issue AND a support request
// linked to it. The database is a recording fake; notifications are stubbed
// so nothing reaches real people.

const PERSON = 'AAAAAAAA-0000-0000-0000-000000000001'
const OWN_REC = '11111111-2222-3333-4444-555555555555'
const FOREIGN_REC = '99999999-2222-3333-4444-555555555555'

interface Op {
  table: string
  kind: 'insert' | 'update' | 'first' | 'list'
  data?: Record<string, unknown>
  where: unknown[][]
}
const ops: Op[] = []
let ticketRow: Record<string, unknown> | null = null

function builder(table: string) {
  const where: unknown[][] = []
  let pending: Op | null = null
  const resolveList = () => {
    ops.push({ table, kind: 'list', where })
    return [] as unknown[]
  }
  const b: Record<string, unknown> = {}
  const chain = (..._a: unknown[]) => b
  for (const m of ['leftJoin', 'select', 'groupBy', 'count', 'whereIn', 'orderBy', 'limit'])
    b[m] = chain
  b.where = (...a: unknown[]) => {
    where.push(a)
    return b
  }
  b.insert = (data: Record<string, unknown>) => {
    pending = { table, kind: 'insert', data, where }
    ops.push(pending)
    return b
  }
  b.returning = async () => {
    if (table === 'nivaro_issues') return [{ id: 501 }]
    if (table === 'nivaro_tasks') {
      ticketRow = { id: 77, kind: 'support', ...(pending?.data ?? {}) }
      return [{ id: 77 }]
    }
    return [{ id: 1 }]
  }
  b.update = async (data: Record<string, unknown>) => {
    ops.push({ table, kind: 'update', data, where })
    return 1
  }
  b.first = async () => {
    ops.push({ table, kind: 'first', where })
    if (table === 'nivaro_session_recordings') {
      const own = where.some((w) => {
        const o = w[0] as Record<string, unknown>
        return o && o.id === OWN_REC && o.user === PERSON
      })
      return own ? { id: OWN_REC } : undefined
    }
    if (table.startsWith('nivaro_tasks')) return ticketRow ?? undefined
    return undefined
  }
  // biome-ignore lint/suspicious/noThenProperty: a knex builder is thenable
  b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve(resolveList()).then(res, rej)
  b.catch = () => Promise.resolve([])
  return b
}

vi.mock('../../../db/index.js', () => ({ db: vi.fn((t: string) => builder(t)) }))
vi.mock('../../../middleware/authenticate.js', () => ({
  requireAuth: vi.fn(async (req: { user?: { id: string } }) => {
    req.user = { id: PERSON }
  }),
  requireAdmin: vi.fn(async () => {})
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))
vi.mock('../../../services/items.js', () => ({ readOne: vi.fn(async () => ({ id: 1 })) }))
vi.mock('../../../services/workflow-transitions.js', () => ({
  resolveFriendlyId: vi.fn(async (_c: string, i: string) => i)
}))
vi.mock('../../../services/files.js', () => ({
  uploadFileBuffer: vi.fn(async () => ({ id: 'F1E2D3C4-0000-0000-0000-000000000000' }))
}))
vi.mock('../../../services/support-tickets.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../services/support-tickets.js')>()
  return {
    ...real,
    logTicketEvent: vi.fn(async () => {}),
    notifyTicket: vi.fn(async () => {}),
    supportAudience: vi.fn(async () => [])
  }
})

import { supportRoutes } from '../../../routes/support.js'
import { uploadFileBuffer } from '../../../services/files.js'

const SHOT = `data:image/jpeg;base64,${Buffer.from('fake-jpeg').toString('base64')}`

async function harness() {
  const app = Fastify()
  await app.register(supportRoutes, { prefix: '/support' })
  return app
}

describe('POST /support/problem-reports (#1390)', () => {
  beforeEach(() => {
    ops.length = 0
    ticketRow = null
    vi.mocked(uploadFileBuffer).mockClear()
  })

  it('files an issue and a linked support request carrying the screenshot', async () => {
    const app = await harness()
    const res = await app.inject({
      method: 'POST',
      url: '/support/problem-reports',
      payload: {
        description: 'Saving spun forever\nthen nothing',
        screenshot: SHOT,
        console: ['[error] boom'],
        route: '/records/workflows/1',
        app: 'efp',
        recording_id: OWN_REC,
        recording_offset_ms: null
      }
    })
    expect(res.statusCode).toBe(201)
    const body = res.json().data
    expect(body.issue_id).toBe(501)
    expect(body.ticket.id).toBe(77)
    expect(body.replay).toBe(true)

    const issue = ops.find((o) => o.table === 'nivaro_issues' && o.kind === 'insert')!
    expect(issue.data).toMatchObject({
      title: 'Saving spun forever',
      source: 'client',
      raised_by: PERSON,
      screenshot: SHOT,
      recording_id: OWN_REC,
      recording_offset_ms: null
    })
    expect(String(issue.data!.details)).toContain('[error] boom')
    expect(String(issue.data!.details)).toContain('Route: /records/workflows/1')

    const ticket = ops.find((o) => o.table === 'nivaro_tasks' && o.kind === 'insert')!
    expect(ticket.data).toMatchObject({ kind: 'support', created_by: PERSON, collection: null })
    expect(String(ticket.data!.description)).toContain('Issue #501')
    expect(JSON.parse(String(ticket.data!.attachments))).toEqual([
      'F1E2D3C4-0000-0000-0000-000000000000'
    ])
    expect(uploadFileBuffer).toHaveBeenCalledOnce()

    const link = ops.find((o) => o.table === 'nivaro_issues' && o.kind === 'update')!
    expect(String(link.data!.details)).toContain('Support request #77')
  })

  it("drops a replay that is not the reporter's own", async () => {
    const app = await harness()
    const res = await app.inject({
      method: 'POST',
      url: '/support/problem-reports',
      payload: { description: 'It broke', recording_id: FOREIGN_REC, recording_offset_ms: 4000 }
    })
    expect(res.statusCode).toBe(201)
    expect(res.json().data.replay).toBe(false)
    const issue = ops.find((o) => o.table === 'nivaro_issues' && o.kind === 'insert')!
    expect(issue.data).toMatchObject({ recording_id: null, recording_offset_ms: null })
    expect(uploadFileBuffer).not.toHaveBeenCalled()
  })

  it('refuses an empty report and a screenshot that is not an image', async () => {
    const app = await harness()
    const empty = await app.inject({
      method: 'POST',
      url: '/support/problem-reports',
      payload: { description: '   ' }
    })
    expect(empty.statusCode).toBe(400)
    const bad = await app.inject({
      method: 'POST',
      url: '/support/problem-reports',
      payload: { description: 'x', screenshot: 'data:text/html;base64,AAAA' }
    })
    expect(bad.statusCode).toBe(400)
    expect(ops.some((o) => o.kind === 'insert')).toBe(false)
  })
})
