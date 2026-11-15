import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// POST /send-view hands a colleague a view; GET /send-view/:id is for that colleague only,
// resolved as them. The socket poke carries the id alone; a recipient without the app open
// gets an ordinary notification in the 'views' category.

const USERS: Record<string, Record<string, unknown>> = {
  'U-ROB': { id: 'U-ROB', first_name: 'Rob', last_name: 'Lee', email: 'r@x', status: 'active' },
  'U-BETH': { id: 'U-BETH', first_name: 'Beth', last_name: 'Ames', email: 'b@x', status: 'active' },
  'U-BOT': { id: 'U-BOT', first_name: 'Sync', status: 'active', account_kind: 'integration' }
}

vi.mock('../../../middleware/authenticate.js', () => ({
  requireAuth: vi.fn(
    async (req: { headers: Record<string, string>; user?: unknown; authMethod?: string }) => {
      const who = req.headers['x-test-user']
      if (!who) throw Object.assign(new Error('Unauthorized'), { statusCode: 401 })
      req.user = USERS[who]
      req.authMethod = req.headers['x-test-auth'] ?? 'session'
    }
  )
}))
vi.mock('../../../db/index.js', () => ({
  db: vi.fn((table: string) => {
    let id: string | null = null
    const q = {
      where: (w: { id?: string }) => {
        id = w.id ?? null
        return q
      },
      first: async () => (table === 'nivaro_users' && id ? USERS[id] : undefined)
    }
    return q
  })
}))
vi.mock('../../../db/tenant-context.js', () => ({ getTenantId: () => null }))
vi.mock('../../../services/machine-accounts.js', () => ({
  isMachineAccount: (u: { account_kind?: string | null }) => !!u.account_kind
}))
const online = { value: true }
vi.mock('../../../services/ai-stream-delivery.js', () => ({
  userHasSocket: vi.fn(async () => online.value)
}))
const emitted: Array<{ user: string; event: string; payload: unknown }> = []
vi.mock('../../../services/user-sync.js', () => ({
  emitToUserRoom: (user: string, event: string, payload: unknown) =>
    emitted.push({ user, event, payload })
}))
const notified: Array<{ to: string; opts: Record<string, unknown> }> = []
vi.mock('../../../services/notification-channels.js', () => ({
  notifyUser: vi.fn(async (_app: unknown, to: string, opts: Record<string, unknown>) => {
    notified.push({ to, opts })
    return { id: 1 }
  })
}))
const limited = { value: false }
vi.mock('../../../services/windowed-limit.js', () => ({
  overWindowLimit: vi.fn(async () => limited.value)
}))
vi.mock('../../../services/record-labels-as-viewer.js', () => ({
  recordLabelsAsViewer: vi.fn(async (u: { id: string }) =>
    u.id === 'U-BETH' ? { 'workflows:7': 'CM26-7' } : { 'workflows:7': 'Workflows' }
  )
}))

import { sendViewRoutes } from '../../../routes/send-view.js'
import { resetSentViewMemory } from '../../../services/send-view.js'

async function app() {
  const a = Fastify()
  ;(a as unknown as { io: unknown }).io = {}
  await a.register(sendViewRoutes, { prefix: '/send-view' })
  return a
}

const RECORD = { kind: 'record', collection: 'workflows', item: '7' }

describe('/send-view', () => {
  beforeEach(() => {
    resetSentViewMemory()
    emitted.length = 0
    notified.length = 0
    online.value = true
    limited.value = false
  })

  it('pokes an online recipient with the id only, and opens as them', async () => {
    const a = await app()
    const res = await a.inject({
      method: 'POST',
      url: '/send-view',
      headers: { 'x-test-user': 'U-ROB' },
      payload: { to: 'U-BETH', view: RECORD, note: 'look' }
    })
    expect(res.statusCode).toBe(200)
    const { id, mode } = res.json().data
    expect(mode).toBe('live')
    expect(emitted).toEqual([{ user: 'U-BETH', event: 'view:sent', payload: { id } }])

    // Someone else asking for it: same answer as a missing id.
    const nosy = await a.inject({ url: `/send-view/${id}`, headers: { 'x-test-user': 'U-ROB' } })
    expect(nosy.statusCode).toBe(404)

    const got = await a.inject({ url: `/send-view/${id}`, headers: { 'x-test-user': 'U-BETH' } })
    expect(got.statusCode).toBe(200)
    const d = got.json().data
    expect(d.title).toBe('Workflows — CM26-7')
    expect(d.from).toEqual({ id: 'U-ROB', name: 'Rob Lee' })
    expect(d.target).toMatchObject({ kind: 'record', collection: 'workflows', id: '7' })
    expect(d.note).toBe('look')
    await a.close()
  })

  it('lands as a notification in the views category when they are not online', async () => {
    online.value = false
    const a = await app()
    const res = await a.inject({
      method: 'POST',
      url: '/send-view',
      headers: { 'x-test-user': 'U-ROB' },
      payload: {
        to: 'U-BETH',
        view: { kind: 'list', collection: 'workflows', lv: 'abc', summary: 'Region: NER' }
      }
    })
    expect(res.json().data.mode).toBe('notification')
    expect(emitted).toEqual([])
    expect(notified).toHaveLength(1)
    expect(notified[0].to).toBe('U-BETH')
    expect(notified[0].opts).toMatchObject({
      subject: 'Rob sent you: Workflows — Region: NER',
      category: 'views',
      target: { kind: 'record', collection: 'workflows', query: 'lv=abc' }
    })
    await a.close()
  })

  it('only people on their own sign-in send, never to themselves or machines, and rate-limited', async () => {
    const a = await app()
    const send = (headers: Record<string, string>, to = 'U-BETH') =>
      a.inject({ method: 'POST', url: '/send-view', headers, payload: { to, view: RECORD } })
    expect((await send({ 'x-test-user': 'U-ROB', 'x-test-auth': 'api_key' })).statusCode).toBe(403)
    expect((await send({ 'x-test-user': 'U-ROB', 'x-test-auth': 'masquerade' })).statusCode).toBe(
      403
    )
    expect((await send({ 'x-test-user': 'U-ROB', 'x-test-auth': 'oauth' })).statusCode).toBe(403)
    expect((await send({ 'x-test-user': 'U-ROB' }, 'U-ROB')).statusCode).toBe(400)
    expect((await send({ 'x-test-user': 'U-ROB' }, 'U-BOT')).statusCode).toBe(404)
    expect((await send({ 'x-test-user': 'U-ROB' }, 'U-NOBODY')).statusCode).toBe(404)
    limited.value = true
    const r = await send({ 'x-test-user': 'U-ROB' })
    expect(r.statusCode).toBe(429)
    expect(r.json().code).toBe('RATE_LIMITED')
    expect(emitted).toEqual([])
    await a.close()
  })
})
