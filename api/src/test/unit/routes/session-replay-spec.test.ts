import { gzipSync } from 'node:zlib'
import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { memoryKnex } from '../../fixtures/memory-knex.js'

/**
 * #1393 — a spec from a recording: clicks, typing and page changes inside the
 * window become the golden-path recorder's steps, selectors from data-* hooks
 * first with role + name next, and every typed value a placeholder.
 */

const h = vi.hoisted(() => ({
  db: null as unknown as ReturnType<typeof import('../../fixtures/memory-knex.js').memoryKnex>,
  activity: [] as Array<Record<string, unknown>>
}))

vi.mock('../../../db/index.js', () => ({
  db: new Proxy(() => {}, {
    apply: (_t, _this, args: [string]) => h.db(args[0]),
    get: (_t, k) => (h.db as unknown as Record<string | symbol, unknown>)[k]
  })
}))
vi.mock('../../../services/activity.js', () => ({
  logActivity: async (row: Record<string, unknown>) => {
    h.activity.push(row)
    return 1
  }
}))
vi.mock('../../../middleware/authenticate.js', () => ({
  requireAdmin: async (
    req: { headers: Record<string, string>; user?: unknown },
    reply: { code: (n: number) => { send: (b: unknown) => unknown } }
  ) => {
    if (req.headers['x-test-user'] !== 'admin') return reply.code(403).send({ error: 'Admin only' })
    req.user = { id: ADMIN }
  }
}))

import { sessionReplaySpecRoutes } from '../../../routes/session-replay-spec.js'
import { buildSpecPlan } from '../../../services/session-replay-spec.js'

const REC = '6f1c2b3a-1234-4abc-9def-0123456789ab'
const ADMIN = 'aaaaaaaa-1111-4111-8111-111111111111'
const T0 = 1_700_000_000_000

const text = (id: number, t: string) => ({ id, type: 3, textContent: t })
const el = (
  id: number,
  tagName: string,
  attributes: Record<string, string> = {},
  childNodes: unknown[] = []
) => ({ id, type: 2, tagName, attributes, childNodes })

/** A purchase order form, as rrweb serialises it. */
const PAGE = el(1, 'html', {}, [
  el(2, 'body', {}, [
    el(3, 'form', { 'data-form': 'po' }, [
      el(4, 'input', { 'data-field': 'po_number', type: 'text' }),
      el(5, 'input', { name: 'vendor', type: 'text' }),
      // Tooltip attrs are never hooks; the button falls back to role + name.
      el(6, 'button', { type: 'button', 'data-tip': 'Saves' }, [
        el(7, 'span', {}, [text(8, 'Save order')])
      ]),
      el(9, 'select', { 'data-field': 'currency' }),
      el(10, 'input', { type: 'checkbox', 'data-field': 'urgent' })
    ]),
    el(11, 'a', { href: '/orders' }, [text(12, 'All orders')]),
    el(13, 'div', { class: 'grid' }, [el(14, 'div', {}, [text(15, 'row')])])
  ])
])

const meta = (t: number, href: string) => ({
  type: 4,
  timestamp: T0 + t,
  data: { href, width: 1440, height: 900 }
})
const snapshot = (t: number) => ({ type: 2, timestamp: T0 + t, data: { node: PAGE } })
const click = (t: number, id: number) => ({
  type: 3,
  timestamp: T0 + t,
  data: { source: 2, type: 2, id }
})
const input = (t: number, id: number, txt = '***') => ({
  type: 3,
  timestamp: T0 + t,
  data: { source: 5, id, text: txt, isChecked: false }
})
const route = (t: number, path: string) => ({
  type: 5,
  timestamp: T0 + t,
  data: { tag: 'route', payload: { path } }
})
const addNode = (t: number, parentId: number, node: unknown) => ({
  type: 3,
  timestamp: T0 + t,
  data: { source: 0, adds: [{ parentId, node }], removes: [], texts: [], attributes: [] }
})

const EVENTS = [
  meta(0, 'https://erp.example.com/orders/new?draft=1'),
  snapshot(0),
  click(1000, 4), // focus the PO field: no step of its own
  input(1100, 4, '*'),
  input(1200, 4, '**'),
  input(1300, 4, '***'),
  input(2000, 5, '****'),
  click(3000, 8), // the span inside the Save button
  input(3500, 9, '***'), // a select
  click(3800, 10), // the checkbox …
  input(3801, 10), // … and its input event, which adds nothing
  // A toast rendered after the snapshot, with a hook
  addNode(4000, 2, el(20, 'button', { 'data-action': 'undo' }, [text(21, 'Undo')])),
  click(4500, 21),
  route(5000, '/orders'),
  route(5001, '/orders?page=1'),
  click(6000, 15), // a grid cell: no hook, no role → CSS path
  click(7000, 999) // a node the snapshot never had
]

describe('buildSpecPlan', () => {
  it('turns clicks, typing and page changes into recorder steps', () => {
    const plan = buildSpecPlan(EVENTS)
    const steps = plan.steps.map(({ at: _at, ...s }) => s)
    expect(steps).toEqual([
      { kind: 'goto', path: '/orders/new?draft=1' },
      {
        kind: 'fill',
        selector: '[data-field="po_number"]',
        value: '<value for data-field="po_number">',
        label: 'po_number'
      },
      {
        kind: 'fill',
        selector: 'input[name="vendor"]',
        value: '<value for name="vendor">',
        label: 'vendor'
      },
      {
        kind: 'click',
        selector: 'button:has-text("Save order")',
        role: { role: 'button', name: 'Save order' },
        label: 'Save order'
      },
      {
        kind: 'select',
        selector: '[data-field="currency"]',
        value: '<value for data-field="currency">',
        label: 'currency'
      },
      { kind: 'click', selector: '[data-field="urgent"]', label: 'urgent' },
      { kind: 'click', selector: '[data-action="undo"]', label: 'Undo' },
      { kind: 'goto', path: '/orders?page=1' },
      { kind: 'click', selector: 'div > div', label: 'row' }
    ])
    expect(plan).toMatchObject({
      viewport: { width: 1440, height: 900 },
      origin: 'https://erp.example.com',
      placeholders: 3,
      unresolved: 1
    })
  })

  it('keeps to the window, opening it on the page the person was on', () => {
    const plan = buildSpecPlan(EVENTS, 2500, 4600)
    expect(plan.steps.map((s) => s.kind)).toEqual(['goto', 'click', 'select', 'click', 'click'])
    expect(plan.steps[0]).toMatchObject({ kind: 'goto', path: '/orders/new?draft=1' })
    // The node added before the window still resolves inside it.
    expect(plan.steps.at(-1)).toMatchObject({ selector: '[data-action="undo"]' })
  })

  it('never writes the masked text into the spec', () => {
    const plan = buildSpecPlan(EVENTS)
    expect(JSON.stringify(plan)).not.toContain('***')
  })
})

async function post(body: unknown, user = 'admin') {
  const app = Fastify()
  await app.register(sessionReplaySpecRoutes, { prefix: '/api/session-recordings' })
  return app.inject({
    method: 'POST',
    url: `/api/session-recordings/${REC}/spec`,
    payload: body as Record<string, unknown>,
    headers: { 'x-test-user': user }
  })
}

beforeEach(() => {
  h.db = memoryKnex({
    nivaro_session_recordings: [{ id: REC, user: ADMIN, started_at: new Date(T0) }],
    nivaro_users: [{ id: ADMIN, first_name: 'Ada', last_name: 'Admin' }],
    nivaro_session_events: [
      {
        recording: REC,
        seq: 0,
        events: `gz:${gzipSync(Buffer.from(JSON.stringify(EVENTS))).toString('base64')}`
      }
    ]
  })
  h.activity = []
})

describe('POST /session-recordings/:id/spec', () => {
  it('refuses non-admins', async () => {
    expect((await post({}, 'user')).statusCode).toBe(403)
  })

  it('answers recorder steps for the window, named after the recording, and logs it', async () => {
    const res = await post({ from_ms: 0, to_ms: 2500 })
    expect(res.statusCode).toBe(200)
    const d = res.json().data
    expect(d).toMatchObject({
      recording_id: REC,
      name: 'replay-6f1c2b3a',
      title: "Replay of Ada Admin's session on 2023-11-14 (0:00–0:02)",
      viewport: { width: 1440, height: 900 },
      placeholders: 2
    })
    expect(d.steps.map((s: { kind: string }) => s.kind)).toEqual(['goto', 'fill', 'fill'])
    expect(h.activity).toEqual([
      expect.objectContaining({
        action: 'session-recording-spec',
        item: REC,
        comment: 'playwright spec 0:00–0:02: 3 step(s), 2 placeholder(s), 0 unresolved'
      })
    ])
  })

  it('validates the window and the recording', async () => {
    expect((await post({ from_ms: 3000, to_ms: 1000 })).statusCode).toBe(400)
    h.db.tables.nivaro_session_recordings = []
    expect((await post({})).statusCode).toBe(404)
  })
})
