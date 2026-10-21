// Chat delivery + rendering (2026-10-21): request id cards (#2762), page cards
// that say what a page is and only for viewers who can open it (#2785), and
// one send per client id even when a resend overlaps the first send (#2782).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const tables = new Map<string, Record<string, unknown> | undefined>()
const counts = new Map<string, number>()

function builder(table: string) {
  const b: Record<string, unknown> = {}
  for (const m of ['where', 'whereRaw', 'whereIn', 'select', 'orderBy', 'count', 'leftJoin'])
    b[m] = () => b
  b.first = () => {
    if (table.endsWith('_widgets') || table === 'nivaro_queue_sources')
      return Promise.resolve({ n: counts.get(table) ?? 0 })
    return Promise.resolve(tables.get(table))
  }
  return b
}

vi.mock('../../../db/index.js', () => ({ db: vi.fn((t: string) => builder(t)) }))
vi.mock('../../../admin-base.js', () => ({ adminBaseUrl: () => 'https://admin.example' }))
vi.mock('../../../services/permissions.js', () => ({
  can: vi.fn(async () => false),
  applyRowFilter: vi.fn(),
  getRowFilter: vi.fn()
}))
vi.mock('../../../services/user-scopes.js', () => ({
  applyScopeEnforcement: vi.fn(),
  getUserScopeEnforcement: vi.fn()
}))
const findRequestRow = vi.fn()
vi.mock('../../../services/traffic-inspect/request.js', () => ({
  findRequestRow: (...a: unknown[]) => findRequestRow(...a),
  traceAbsence: () => ({ kept: false, code: 'fast', reason: 'Not kept — fast.' })
}))
const getTrace = vi.fn()
vi.mock('../../../services/request-trace.js', () => ({
  getTrace: (...a: unknown[]) => getTrace(...a)
}))
vi.mock('../../../services/chat.js', () => ({
  canSeeRoom: vi.fn(),
  channels: vi.fn(),
  generalChannel: vi.fn(),
  parseRoom: vi.fn()
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn() }))
vi.mock('../../../services/app-links.js', () => ({ linkTo: vi.fn() }))
vi.mock('../../../services/chat-health.js', () => ({
  recordChatSend: vi.fn(),
  recordChatSendFailure: vi.fn()
}))

import { appCardFor } from '../../../services/chat-app-card.js'
import {
  __resetRequestCardMemo,
  normalizeRequestId,
  requestCardFor,
  shapeRequestCard
} from '../../../services/chat-request-card.js'
import { clientIdClaimKey, withClientIdClaim } from '../../../services/chat-send.js'
import type { User } from '../../../types.js'

const ME = { id: 'AAAAAAAA-0000-4000-8000-000000000001', role: 'R1' } as unknown as User
const OTHER = 'BBBBBBBB-0000-4000-8000-000000000002'
const RID = '4f3a2b1c-0000-4000-8000-00000000c21e'

const ROW = {
  method: 'GET',
  path: '/api/items/workflows/12',
  route: 'GET /api/items/:collection/:id',
  status: 500,
  latency_ms: 1240,
  created_at: '2026-10-21T15:00:00.000Z',
  caller: { key: 'u1', label: 'Ana Ruiz', kind: 'user' as const }
}

beforeEach(() => {
  tables.clear()
  counts.clear()
  __resetRequestCardMemo()
  findRequestRow.mockReset()
  getTrace.mockReset()
})
afterEach(() => vi.clearAllMocks())

describe('request id cards (#2762)', () => {
  it('reads a request id or a trace id as the same request id', () => {
    expect(normalizeRequestId(RID.toUpperCase())).toBe(RID)
    expect(normalizeRequestId(RID.replace(/-/g, ''))).toBe(RID)
    expect(normalizeRequestId('not-an-id')).toBeNull()
    expect(normalizeRequestId('AB26-12345')).toBeNull()
  })

  it('gives administrators the details and everyone else only that it exists', async () => {
    findRequestRow.mockResolvedValue({ row: ROW, matched_by: 'request_id' })
    const admin = await requestCardFor(ME, true, RID)
    expect(admin?.details).toMatchObject({
      route: 'GET /api/items/:collection/:id',
      status: 500,
      duration_ms: 1240,
      person: 'Ana Ruiz',
      trace_kept: false,
      trace_url: `https://admin.example/traffic-map?inspect=${encodeURIComponent(`request:${RID}`)}`
    })
    const reader = await requestCardFor(ME, false, RID)
    expect(reader).toEqual({ kind: 'request', id: RID, details: null })
  })

  it('names nothing for an id that is not a request', async () => {
    findRequestRow.mockResolvedValue(null)
    getTrace.mockReturnValue(undefined)
    expect(await requestCardFor(ME, true, RID)).toBeNull()
    expect(await requestCardFor(ME, false, RID)).toBeNull()
    expect(shapeRequestCard(RID, null, true)).toBeNull()
  })

  it('describes a request from its kept trace before the log row is written', async () => {
    findRequestRow.mockResolvedValue(null)
    getTrace.mockReturnValue({
      id: RID,
      method: 'POST',
      route: '/api/chat/messages',
      url: '/api/chat/messages?x=1',
      status: 201,
      user: null,
      total_ms: 2400.4,
      ts: '2026-10-21T15:00:00.000Z'
    })
    const card = await requestCardFor(ME, true, RID)
    expect(card?.details).toMatchObject({
      route: 'POST /api/chat/messages',
      path: '/api/chat/messages',
      duration_ms: 2400,
      trace_kept: true,
      person: null
    })
  })

  it('a Traffic Map link to a request is a card for administrators only', async () => {
    findRequestRow.mockResolvedValue({ row: ROW, matched_by: 'request_id' })
    const path = `/traffic-map?inspect=request:${RID}`
    expect((await appCardFor(ME, true, path))?.kind).toBe('request')
    expect(await appCardFor(ME, false, path)).toBeNull()
  })
})

describe('page cards (#2785)', () => {
  it('a custom query is an administrator page: a card for them, a plain link for others', async () => {
    tables.set('nivaro_custom_queries', {
      id: 7,
      name: 'Open orders',
      slug: 'open-orders',
      description: 'Orders not yet received',
      params: JSON.stringify([{ name: 'year' }, { name: 'zone' }])
    })
    expect(await appCardFor(ME, true, '/custom-queries/7')).toEqual({
      kind: 'custom-query',
      id: '7',
      name: 'Open orders',
      slug: 'open-orders',
      params: 2,
      description: 'Orders not yet received'
    })
    expect(await appCardFor(ME, false, '/custom-queries/7')).toBeNull()
  })

  it('a dashboard card says what it is, never its data, and only for who can open it', async () => {
    tables.set('nivaro_dashboards', {
      id: 'd1',
      name: 'Ops',
      user: OTHER,
      is_shared: false,
      description: '  Daily   numbers '
    })
    counts.set('nivaro_dashboard_widgets', 6)
    expect(await appCardFor(ME, false, '/dashboards/d1')).toBeNull()
    tables.set('nivaro_dashboards', {
      id: 'd1',
      name: 'Ops',
      user: OTHER,
      is_shared: true,
      role_id: null,
      description: '  Daily   numbers '
    })
    expect(await appCardFor(ME, false, '/dashboards/d1')).toEqual({
      kind: 'dashboard',
      id: 'd1',
      name: 'Ops',
      widgets: 6,
      description: 'Daily numbers'
    })
  })

  it('a queue follows the queue access rule (shared to another role = no card)', async () => {
    tables.set('nivaro_queues', {
      id: 'q1',
      name: 'Approvals',
      owner: OTHER,
      is_shared: true,
      role_id: 'R2'
    })
    expect(await appCardFor(ME, false, '/queues/q1')).toBeNull()
    tables.set('nivaro_queues', {
      id: 'q1',
      name: 'Approvals',
      owner: OTHER,
      is_shared: true,
      role_id: 'R1'
    })
    counts.set('nivaro_queue_sources', 3)
    const card = await appCardFor(ME, false, '/queues/q1')
    expect(card).toMatchObject({ kind: 'queue', name: 'Approvals', sources: 3 })
    expect(card).not.toHaveProperty('total')
  })

  it('a saved view needs read access to its collection', async () => {
    tables.set('nivaro_saved_views', {
      id: 'v1',
      name: 'Late',
      collection: 'workflows',
      user: ME.id,
      is_shared: false
    })
    expect(await appCardFor(ME, false, '/collections/workflows?view=v1')).toBeNull()
    const { can } = await import('../../../services/permissions.js')
    vi.mocked(can).mockResolvedValueOnce(true)
    tables.set('nivaro_collections', { display_name: 'Workflows' })
    expect(await appCardFor(ME, false, '/collections/workflows?view=v1')).toMatchObject({
      kind: 'view',
      name: 'Late',
      collection_label: 'Workflows'
    })
  })
})

describe('one send per client id (#2782)', () => {
  const app = {} as never
  const actor = { user: ME } as never

  it('keys a send by sender, room and client id', () => {
    expect(clientIdClaimKey('abc', 'ch:x', 'c1')).toBe('nvr:chatcid:ABC:ch:x:c1')
    expect(clientIdClaimKey('abc', 'ch:x', null)).toBeNull()
    expect(clientIdClaimKey(null, 'ch:x', 'c1')).toBeNull()
  })

  it('a resend that overlaps the first send waits for it instead of running beside it', async () => {
    const order: string[] = []
    let release!: () => void
    const first = withClientIdClaim(
      app,
      actor,
      { room: 'ch:x', message: 'hi', clientId: 'c1' },
      () => {
        order.push('first:start')
        return new Promise<string>((r) => {
          release = () => {
            order.push('first:end')
            r('first')
          }
        })
      }
    )
    const second = withClientIdClaim(
      app,
      actor,
      { room: 'ch:x', message: 'hi', clientId: 'c1' },
      async () => {
        order.push('second:start')
        return 'second'
      }
    )
    await new Promise((r) => setTimeout(r, 50))
    expect(order).toEqual(['first:start'])
    release()
    expect(await first).toBe('first')
    expect(await second).toBe('second')
    expect(order).toEqual(['first:start', 'first:end', 'second:start'])
  })

  it('sends with different client ids do not wait for each other', async () => {
    let release!: () => void
    const a = withClientIdClaim(
      app,
      actor,
      { room: 'ch:x', message: 'a', clientId: 'a' },
      () => new Promise<string>((r) => (release = () => r('a')))
    )
    const b = await withClientIdClaim(
      app,
      actor,
      { room: 'ch:x', message: 'b', clientId: 'b' },
      async () => 'b'
    )
    expect(b).toBe('b')
    release()
    expect(await a).toBe('a')
  })
})
