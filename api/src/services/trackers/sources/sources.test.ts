import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Sources (Task 9b): support tickets and business records on GitLab issues — inbound state,
 * outbound close + labels, record templates read as the creating person, create_roles, and a
 * source switched off on a connection.
 */

// ── In-memory stand-in for the tables ─────────────────────────────────────────
type Row = Record<string, any>
const tables: Record<string, Row[]> = {}
const ids: Record<string, number> = {}
const t = (name: string) => {
  tables[name] ??= []
  return tables[name]
}
const cmp = (a: any, b: any) => {
  const x = a instanceof Date ? a.getTime() : a
  const y = b instanceof Date ? b.getTime() : b
  return x < y ? -1 : x > y ? 1 : 0
}
const likeRe = (pattern: string) =>
  new RegExp(
    `^${pattern
      .split('%')
      .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/_/g, '.'))
      .join('.*')}$`,
    's'
  )
const OPS: Record<string, (a: any, b: any) => boolean> = {
  '=': (a, b) => cmp(a, b) === 0,
  '<': (a, b) => a != null && cmp(a, b) < 0,
  '<=': (a, b) => a != null && cmp(a, b) <= 0,
  '>': (a, b) => a != null && cmp(a, b) > 0,
  '>=': (a, b) => a != null && cmp(a, b) >= 0,
  like: (a, b) => typeof a === 'string' && likeRe(String(b)).test(a)
}

function builder(name: string) {
  const preds: Array<(r: Row) => boolean> = []
  let order: [string, string] | null = null
  const pred = (a: any, op?: any, v?: any): ((r: Row) => boolean) => {
    if (typeof a === 'function') {
      const sub: Array<['and' | 'or', (r: Row) => boolean]> = []
      const g: any = {
        where: (x: any, o?: any, y?: any) => {
          sub.push(['and', pred(x, o, y)])
          return g
        },
        orWhere: (x: any, o?: any, y?: any) => {
          sub.push(['or', pred(x, o, y)])
          return g
        }
      }
      a(g)
      return (r) =>
        sub.reduce<boolean>(
          (acc, [c, p], i) => (i === 0 ? p(r) : c === 'and' ? acc && p(r) : acc || p(r)),
          true
        )
    }
    if (typeof a === 'object')
      return (r) => Object.entries(a).every(([k, val]) => cmp(r[k], val) === 0)
    if (v === undefined) return (r) => cmp(r[a], op) === 0
    return (r) => OPS[op](r[a], v)
  }
  const rows = () => {
    let out = t(name).filter((r) => preds.every((p) => p(r)))
    if (order) {
      const [col, dir] = order
      out = [...out].sort((a, b) => cmp(a[col], b[col]) * (dir === 'desc' ? -1 : 1))
    }
    return out
  }
  const b: any = {}
  b.where = (a: any, op?: any, v?: any) => {
    preds.push(pred(a, op, v))
    return b
  }
  b.whereIn = (col: string, list: any[]) => {
    preds.push((r) => list.some((x) => cmp(r[col], x) === 0))
    return b
  }
  b.whereNot = (a: Row) => {
    const p = pred(a)
    preds.push((r) => !p(r))
    return b
  }
  b.orderBy = (col: string, dir = 'asc') => {
    order = [col, dir]
    return b
  }
  b.limit = () => b
  b.select = () => b
  b.as = () => b
  b.count = () => ({ first: async () => ({ n: rows().length }) })
  b.first = async () => (rows()[0] ? { ...rows()[0] } : undefined)
  b.update = async (patch: Row) => {
    const hit = rows()
    for (const r of hit) Object.assign(r, patch)
    return hit.length
  }
  b.delete = async () => {
    const hit = new Set(rows())
    tables[name] = t(name).filter((r) => !hit.has(r))
    return hit.size
  }
  b.insert = (row: Row) => {
    const doIt = () => {
      ids[name] = (ids[name] ?? 0) + 1
      const id = ids[name]
      t(name).push({ id, ...row })
      return [{ id }]
    }
    return {
      returning: async () => doIt(),
      // biome-ignore lint/suspicious/noThenProperty: awaitable like a knex insert
      then: (res: any, rej: any) => Promise.resolve().then(doIt).then(res, rej)
    }
  }
  // biome-ignore lint/suspicious/noThenProperty: awaitable like a knex builder
  b.then = (res: any, rej: any) => Promise.resolve(rows().map((r) => ({ ...r }))).then(res, rej)
  return b
}

vi.mock('../../../db/index.js', () => {
  const db: any = (name: string) => builder(name)
  db.raw = (sql: string) => ({ __raw: sql })
  // linkViews' capped member read: the fake returns the inner rows (no test link hits the cap)
  db.from = (sub: any) => {
    const w: any = {
      where: () => w,
      select: () => w,
      // biome-ignore lint/suspicious/noThenProperty: awaitable like a knex builder
      then: (res: any, rej: any) => sub.then(res, rej)
    }
    return w
  }
  return { db }
})
vi.mock('../../../db/pool-context.js', () => ({
  runInBackgroundPool: (fn: () => Promise<unknown>) => Promise.resolve().then(fn)
}))
vi.mock('../../db-batch.js', () => ({
  selectInChunks: async (list: any[], _n: number, fn: (c: any[]) => Promise<any[]>) =>
    list.length ? fn(list) : [],
  whereInList: (q: any, col: string, list: any[]) => q.whereIn(col, list)
}))
const feature = vi.hoisted(() => ({ on: true }))
vi.mock('../feature.js', () => ({ trackersEnabled: async () => feature.on }))
vi.mock('../identity.js', () => ({
  TRACKER_EMAIL: 'gitlab-sync@nivaro.local',
  trackerUserId: async () => 'GITLAB-BOT'
}))
vi.mock('../../activity.js', () => ({
  logActivity: async (row: Row) => {
    t('activity').push(row)
    return 1
  }
}))
vi.mock('../../issue-raise.js', () => ({
  noteIssueWrite: () => {},
  hitCounts: async () => ({ hits: 0, people: 0 }),
  hitKey: (i: { id: number }) => `issue:${i.id}`
}))
vi.mock('../../record-events.js', () => ({
  announceRecordAspect: () => {},
  emitRecordEvent: () => {}
}))
vi.mock('../../app-links.js', () => ({
  linkTo: async (kind: string, p: { id?: number }) =>
    kind === 'support'
      ? `https://nivaro.test/support?ticket=${p.id}`
      : 'https://nivaro.test/issues',
  recordLink: async (c: string, id: string) => `https://nivaro.test/collections/${c}/${id}`
}))
vi.mock('../../app-info-environment.js', () => ({ appEnvironment: () => 'test' }))
const items = vi.hoisted(() => ({
  readAs: [] as string[],
  rows: new Map<string, Row>()
}))
vi.mock('../../items.js', () => {
  class ForbiddenError extends Error {}
  class ItemNotFoundError extends Error {}
  class CollectionNotFoundError extends Error {}
  return {
    ForbiddenError,
    ItemNotFoundError,
    CollectionNotFoundError,
    isOutOfView: () => false,
    canUpdateItem: async () => true,
    readOne: async (user: { id: string }, collection: string, id: string) => {
      items.readAs.push(user.id)
      const row = items.rows.get(`${user.id}:${collection}:${id}`)
      if (!row) throw new ForbiddenError('no')
      return row
    }
  }
})
vi.mock('../../record-labels-as-viewer.js', () => ({
  recordLabelsAsViewer: async (_u: unknown, refs: Array<{ collection: string; id: string }>) =>
    Object.fromEntries(refs.map((r) => [`${r.collection}:${r.id}`, `Order ${r.id}`]))
}))
vi.mock('../../collections.js', () => ({ getCollection: async () => ({ display_name: 'Orders' }) }))
vi.mock('../../record-label-fallback.js', () => ({
  collectionTitle: (_c: string, d?: string | null) => d ?? 'Orders'
}))
const tickets = vi.hoisted(() => ({ works: false, sees: true }))
const notices = vi.hoisted(() => ({ sent: [] as Row[], resolved: [] as Row[] }))
vi.mock('../../support-tickets.js', () => ({
  canWorkTicket: async () => tickets.works,
  canSeeTicket: async () => tickets.sees,
  STATUS_LABELS: { open: 'Open', in_progress: 'In progress', done: 'Done', cancelled: 'Cancelled' },
  supportAudience: async () => ['DESK-1'],
  notifyTicket: async (_app: unknown, t: Row, recipients: unknown[], opts: Row) =>
    notices.sent.push({ ticket: t.id, recipients, ...opts })
}))
vi.mock('../../notification-resolve.js', () => ({
  resolveNotifications: async (ev: Row) => notices.resolved.push(ev)
}))
vi.mock('../../io-holder.js', () => ({ getApp: () => ({}) }))
vi.mock('../../user-scopes.js', () => ({ isAdminRole: async (r: string) => r === 'admin' }))
vi.mock('../engine.js', () => ({
  claimFlowFire: async () => ({ ok: true, id: 1 }),
  settleClaim: async () => {},
  releaseClaim: async () => {}
}))
const editLock = vi.hoisted(() => ({ refusal: null as Row | null }))
vi.mock('../../edit-lock.js', () => ({ recordWriteRefusal: async () => editLock.refusal }))
const provider = vi.hoisted(() => ({
  project: async (_p: string) => ({ id: 7, path_with_namespace: 'g/p', access_level: 30 }),
  getIssue: async (projectId: number, iid: number) => ({
    id: 9000 + iid,
    iid,
    project_id: projectId,
    web_url: `https://gitlab.example.com/g/p/-/issues/${iid}`,
    title: `Remote ${iid}`,
    state: 'opened',
    labels: ['secret-label'],
    assignees: [{ id: 1, username: 'ann', name: 'Ann' }],
    milestone: null,
    updated_at: '2026-11-17T11:00:00Z',
    description: null,
    confidential: iid === 99
  })
}))
vi.mock('../similar.js', () => ({
  fingerprintLink: async () => null,
  joinAsExample: async () => 0
}))
// the outbox: enqueue leaves a pending row (idempotent on key), nothing is sent
vi.mock('../outbox.js', () => ({
  OUTBOX: 'nivaro_tracker_outbox',
  kick: () => {},
  enqueue: async (row: Row) => {
    const same = t('nivaro_tracker_outbox').find((r) => r.idempotency_key === row.key)
    if (same) return same.id
    ids.nivaro_tracker_outbox = (ids.nivaro_tracker_outbox ?? 0) + 1
    const id = ids.nivaro_tracker_outbox
    t('nivaro_tracker_outbox').push({
      id,
      connection: row.connection,
      link: row.link ?? null,
      source_kind: row.source_kind ?? 'issue',
      source_id: row.source_id,
      op: row.op,
      payload: JSON.stringify(row.payload),
      idempotency_key: row.key,
      status: 'pending'
    })
    return id
  }
}))
const flows = vi.hoisted(() => ({ emitted: [] as Array<[string, Row, unknown]> }))
vi.mock('../../../flows/registry.js', () => ({
  emitTrigger: (type: string, payload: Row, _log: unknown, _user: unknown, opts: unknown) =>
    flows.emitted.push([type, payload, opts])
}))
vi.mock('../../users.js', () => ({
  getUser: async (id: string) =>
    id === 'U-1' ? { id: 'U-1', role: 'role-desk', status: 'active' } : undefined
}))
vi.mock('../../flow-executor.js', () => ({ resolveFlowCreator: async () => null }))
const conn = vi.hoisted(() => ({ view: null as Row | null }))
vi.mock('../connections.js', async () => {
  const { normalizeSync } =
    await vi.importActual<typeof import('../connections.js')>('../connections.js')
  return {
    normalizeSync,
    getConnection: async (id: number) => (conn.view && conn.view.id === id ? conn.view : null),
    listConnections: async () => (conn.view ? [conn.view] : []),
    providerFor: async () => provider,
    markBroken: async () => {}
  }
})

import type { User } from '../../../types.js'
import { normalizeSync } from '../connections.js'
import { mayCreateFrom } from '../create-access.js'
import { setFlowEventLogger } from '../flow-events.js'
import { createIssueFromFlow } from '../flow-ops.js'
import { applyIssueEventDetailed, applyNoteEventDetailed } from '../inbound.js'
import { chipOf, linkSourceExisting, requestSourceCreate } from '../links.js'
import { afterTicketChange, queueCommentOut } from '../outbound-sync.js'
import { buildSourceInput } from '../source-body.js'
import type { RemoteIssue } from '../types.js'
import { sourceFor, sourceKey } from './index.js'

const PROJECT = 7
const IID = 42

function setConnection(sync: Record<string, unknown> = {}) {
  conn.view = {
    id: 1,
    name: 'GitLab',
    provider: 'gitlab',
    base_url: 'https://gitlab.example.com',
    default_project_id: PROJECT,
    is_active: true,
    status: 'ok',
    sync: normalizeSync(sync)
  }
}

function link(over: Row = {}) {
  t('nivaro_tracker_links').push({
    id: 10,
    connection: 1,
    project_id: PROJECT,
    external_iid: IID,
    remote_state: 'opened',
    remote_labels: '[]',
    remote_updated_at: new Date('2026-11-17T10:00:00Z'),
    created_via: 'manual',
    ...over
  })
}

let memberId = 0
function member(kind: string, sourceId: string) {
  t('nivaro_tracker_link_members').push({
    id: ++memberId,
    link: 10,
    connection: 1,
    source_kind: kind,
    source_id: sourceId
  })
}

function ticket(over: Row = {}) {
  t('nivaro_tasks').push({
    id: 55,
    kind: 'support',
    title: 'Cannot open PO 12',
    description: 'It spins forever. /close @everyone',
    status: 'in_progress',
    priority: 'normal',
    created_by: 'REQ-1',
    assignee: null,
    category_id: null,
    created_at: new Date('2026-11-17T09:00:00Z'),
    ...over
  })
}

function remote(over: Partial<RemoteIssue> = {}): RemoteIssue {
  return {
    id: 9042,
    iid: IID,
    project_id: PROJECT,
    web_url: 'https://gitlab.example.com/g/p/-/issues/42',
    title: 'Crash',
    state: 'opened',
    labels: [],
    assignees: [],
    milestone: null,
    updated_at: '2026-11-17T11:00:00Z',
    description: null,
    ...over
  }
}

const user = (over: Partial<User> = {}): User =>
  ({ id: 'U-1', role: 'role-desk', status: 'active', ...over }) as User

const outbox = (op?: string) =>
  t('nivaro_tracker_outbox')
    .filter((r) => !op || r.op === op)
    .map((r): Row => ({ ...r, payload: JSON.parse(r.payload) }))

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k]
  for (const k of Object.keys(ids)) delete ids[k]
  memberId = 0
  feature.on = true
  tickets.works = false
  tickets.sees = true
  editLock.refusal = null
  notices.sent.length = 0
  notices.resolved.length = 0
  items.readAs.length = 0
  items.rows.clear()
  flows.emitted.length = 0
  setFlowEventLogger(null)
  setConnection()
})

describe('sources', () => {
  it('sourceKey names each kind', () => {
    expect(sourceKey('issue', '12')).toBe('issue:12')
    expect(sourceKey('ticket', '55')).toBe('ticket:55')
    expect(sourceKey('record', 'workflows:9001')).toBe('record:workflows:9001')
    expect(sourceFor('record').ref('workflows:9001')).toEqual({
      collection: 'workflows',
      item: '9001'
    })
    expect(sourceFor('record').ref('nivaro_users:1')).toBeNull()
  })

  it('ticket close in GitLab sets done', async () => {
    link()
    ticket()
    member('ticket', '55')
    const out = await applyIssueEventDetailed(1, remote({ state: 'closed' }), 'jdoe', {
      stateChanged: true
    })
    expect(out.result).toBe('applied')
    const row = t('nivaro_tasks').find((r) => r.id === 55)
    expect(row?.status).toBe('done')
    expect(row?.completed_at).toBeInstanceOf(Date)
    expect(t('activity').at(-1)).toMatchObject({
      user: 'GITLAB-BOT',
      collection: 'nivaro_tasks',
      item: '55',
      comment: 'GitLab: closed by @jdoe',
      origin: 'integration'
    })
    // reopened in GitLab → open again
    await applyIssueEventDetailed(
      1,
      remote({ state: 'opened', updated_at: '2026-11-17T12:00:00Z' }),
      'jdoe',
      { stateChanged: true }
    )
    expect(t('nivaro_tasks').find((r) => r.id === 55)?.status).toBe('open')
  })

  it('ticket done closes GitLab issue when close_on_resolve', async () => {
    link()
    ticket({ status: 'done' })
    member('ticket', '55')
    await afterTicketChange(55, { status: 'done' }, { userId: 'U-1', via: 'user' }, 1000)
    expect(outbox('state')).toEqual([
      expect.objectContaining({
        source_kind: 'ticket',
        source_id: '55',
        idempotency_key: 'state:10:close:1000',
        payload: { project_id: PROJECT, iid: IID, state: 'close' }
      })
    ])

    // off: nothing more
    setConnection({ close_on_resolve: false })
    await afterTicketChange(55, { status: 'done' }, { userId: 'U-1', via: 'user' }, 2000)
    expect(outbox('state')).toHaveLength(1)
    // a change read from GitLab never goes back
    setConnection()
    await afterTicketChange(55, { status: 'done' }, { userId: 'U-1', via: 'gitlab' }, 3000)
    expect(outbox('state')).toHaveLength(1)
  })

  it('ticket priority map urgent → label', async () => {
    setConnection({
      ticket_priority_map: { urgent: 'priority::1', normal: 'priority::3' },
      ticket_lane_map: { in_progress: 'workflow::doing' },
      labels: { always: ['nivaro'] }
    })
    ticket({ priority: 'urgent' })
    const view = await sourceFor('ticket').load('55')
    expect(view).not.toBeNull()
    const input = await buildSourceInput(view!, null, undefined, { sync: conn.view!.sync })
    expect(input.labels).toEqual(['nivaro', 'priority::1', 'workflow::doing'])
    // ticket text is user-written: no quick action, no ping
    expect(input.description).not.toMatch(/^\/close/m)
    expect(input.description).not.toContain('@everyone')
    expect(input.description.trim().split('\n').pop()).toBe('<!-- nivaro:ticket:55 -->')

    // a person raises the priority → the label swap goes out
    link()
    member('ticket', '55')
    await afterTicketChange(55, { priority: 'urgent' }, { userId: 'U-1', via: 'user' }, 5)
    expect(outbox('labels')).toEqual([
      expect.objectContaining({
        source_kind: 'ticket',
        payload: expect.objectContaining({
          add_labels: ['priority::1'],
          remove_labels: ['priority::3']
        })
      })
    ])
  })

  it('record create reads fields as the creating user', async () => {
    items.rows.set('U-1:orders:7', { id: 7, amount: 120, note: 'ship @ops' })
    const res = await requestSourceCreate('record', 'orders:7', {
      connection: 1,
      via: 'manual',
      userId: 'U-1',
      asUser: user(),
      action: {
        connection: 1,
        issue_type: 'issue',
        labels: [],
        assignee_ids: [],
        map_assignee_by_email: false,
        confidential: false,
        title_template: '{{ label }} ({{ fields.amount }})',
        body_template:
          'amount={{ fields.amount }} secret={{ fields.secret }} note={{ fields.note }}',
        attach_screenshot: false,
        attach_replay_link: false,
        include_details: true
      }
    })
    expect(res.outboxId).toBeGreaterThan(0)
    expect(items.readAs).toEqual(['U-1'])
    const [row] = outbox('create')
    expect(row).toMatchObject({ source_kind: 'record', source_id: 'orders:7' })
    expect(row.idempotency_key).toBe('create:1:record:orders:7')
    expect(row.payload.input.title).toBe('Order 7 (120)')
    expect(row.payload.input.description).toContain('amount=120 secret= note=ship @\u200bops')
    expect(row.payload.input.description).toContain('https://nivaro.test/collections/orders/7')
    // someone who cannot read the record sends nothing
    await expect(
      requestSourceCreate('record', 'orders:8', {
        connection: 1,
        via: 'manual',
        asUser: user()
      })
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })
    // no reader at all: refused, never read as the system
    await expect(
      requestSourceCreate('record', 'orders:7', { connection: 1, via: 'manual' })
    ).rejects.toMatchObject({ code: 'NO_READER' })
  })

  it('record GitLab close adds a record comment', async () => {
    link()
    member('record', 'orders:7')
    const out = await applyIssueEventDetailed(1, remote({ state: 'closed' }), 'jdoe', {
      stateChanged: true
    })
    expect(out).toMatchObject({ result: 'applied' })
    const comments = t('nivaro_comments')
    expect(comments).toHaveLength(1)
    expect(comments[0]).toMatchObject({
      collection: 'orders',
      item: '7',
      user: 'GITLAB-BOT',
      text: 'GitLab issue 42 closed by jdoe'
    })
    expect(JSON.parse(comments[0].meta)).toEqual({
      tracker: { link: 10, state: 'closed', author: 'jdoe' }
    })
    // no status is written anywhere for a record
    expect(t('activity')).toHaveLength(0)
  })

  it('non-admin without create_roles cannot create from a ticket', async () => {
    ticket()
    tickets.works = true
    setConnection({ create_roles: [] })
    expect(
      await mayCreateFrom({ isAdmin: false, user: user() } as never, 'ticket', '55', 1)
    ).toMatchObject({ ok: false, status: 403 })
    // the issue log stays admin-only even with the role
    setConnection({ create_roles: ['role-desk'] })
    expect(
      await mayCreateFrom({ isAdmin: false, user: user() } as never, 'issue', '5', 1)
    ).toMatchObject({ ok: false, status: 403 })
    // in create_roles but not working the ticket
    tickets.works = false
    expect(
      await mayCreateFrom({ isAdmin: false, user: user() } as never, 'ticket', '55', 1)
    ).toMatchObject({ ok: false, status: 403 })
  })

  it('create_roles member who can update the ticket can create', async () => {
    ticket()
    tickets.works = true
    setConnection({ create_roles: ['ROLE-DESK'] })
    expect(
      await mayCreateFrom({ isAdmin: false, user: user() } as never, 'ticket', '55', 1)
    ).toEqual({ ok: true })
    expect(await mayCreateFrom({ isAdmin: true, user: user() } as never, 'issue', '5', 1)).toEqual({
      ok: true
    })
    const res = await requestSourceCreate('ticket', '55', {
      connection: 1,
      via: 'manual',
      userId: 'U-1',
      asUser: user()
    })
    expect(outbox('create')[0]).toMatchObject({
      id: res.outboxId,
      source_kind: 'ticket',
      source_id: '55',
      idempotency_key: 'create:1:ticket:55'
    })
  })

  it('source issue switched off: inbound sync ignores issue links', async () => {
    setConnection({ sources: { issue: false } })
    link()
    t('nivaro_issues').push({ id: 100, status: 'open', severity: 'medium' })
    member('issue', '100')
    const out = await applyIssueEventDetailed(1, remote({ state: 'closed' }), 'jdoe', {
      stateChanged: true
    })
    expect(out).toMatchObject({ result: 'ignored', reason: 'No Nivaro issues on this link' })
    expect(t('nivaro_issues')[0].status).toBe('open')
    // nothing deleted: the link and its member stay
    expect(t('nivaro_tracker_link_members')).toHaveLength(1)
    // no create / link for an issue on that connection
    await expect(
      requestSourceCreate('issue', '100', { connection: 1, via: 'manual' })
    ).rejects.toMatchObject({ code: 'SOURCE_OFF' })
    setConnection({ sources: { ticket: false } })
    ticket()
    await expect(
      requestSourceCreate('ticket', '55', { connection: 1, via: 'manual' })
    ).rejects.toMatchObject({ code: 'SOURCE_OFF' })
  })

  it("flow op gitlab.create_issue enqueues a create for the flow's record", async () => {
    items.rows.set('U-1:orders:7', { id: 7, amount: 120 })
    const out = await createIssueFromFlow(
      { connection: 1, collection: 'orders', item: '7', labels: 'from-flow, ops' },
      { userId: 'U-1', flowId: 'F-1' }
    )
    expect(out).toMatchObject({ kind: 'record', source_id: 'orders:7' })
    expect(items.readAs).toEqual(['U-1'])
    const [row] = outbox('create')
    expect(row).toMatchObject({ source_kind: 'record', source_id: 'orders:7' })
    expect(row.payload).toMatchObject({ created_via: 'rule', rule_id: null })
    expect(row.payload.input.labels).toEqual(['from-flow', 'ops'])
    expect(row.payload.input.title).toBe('Order 7')
    // the same record again: already queued → skipped, not an error
    t('nivaro_tracker_link_members').push({
      id: 1,
      link: 10,
      connection: 1,
      source_kind: 'record',
      source_id: 'orders:7'
    })
    expect(
      await createIssueFromFlow(
        { connection: 1, collection: 'orders', item: '7' },
        { userId: 'U-1', flowId: 'F-1' }
      )
    ).toEqual({ skipped: 'ALREADY_LINKED' })
    // a support ticket in a flow is the ticket source
    ticket()
    expect(
      await createIssueFromFlow(
        { connection: 1, collection: 'nivaro_tasks', item: '55' },
        { userId: 'U-1', flowId: 'F-1' }
      )
    ).toMatchObject({ kind: 'ticket', source_id: '55' })
    // no person to read a record as: refused, nothing queued
    expect(
      await createIssueFromFlow(
        { connection: 1, collection: 'orders', item: '9' },
        {
          flowId: 'F-1'
        }
      )
    ).toMatchObject({ code: 'NO_READER' })
  })

  it('inbound change emits gitlab.issue_changed', async () => {
    setFlowEventLogger({} as never)
    link()
    ticket()
    member('ticket', '55')
    member('record', 'orders:7')
    await applyIssueEventDetailed(1, remote({ state: 'closed' }), 'jdoe', { stateChanged: true })
    await new Promise((r) => setTimeout(r, 0))
    const events = flows.emitted.filter(([type]) => type === 'gitlab.issue_changed')
    expect(events.map(([, p]) => p)).toEqual([
      {
        connection: 1,
        link: 10,
        kind: 'ticket',
        source_id: '55',
        collection: 'nivaro_tasks',
        item: '55',
        project_id: PROJECT,
        iid: IID,
        change: 'state',
        state: 'closed'
      },
      {
        connection: 1,
        link: 10,
        kind: 'record',
        source_id: 'orders:7',
        collection: 'orders',
        item: '7',
        project_id: PROJECT,
        iid: IID,
        change: 'state',
        state: 'closed'
      }
    ])
    expect(events[0][2]).toEqual({ orderKey: '1:10' })
    // off until registered: nothing is emitted
    setFlowEventLogger(null)
    flows.emitted.length = 0
    await applyIssueEventDetailed(
      1,
      remote({ state: 'opened', updated_at: '2026-11-17T12:00:00Z' }),
      'jdoe',
      { stateChanged: true }
    )
    await new Promise((r) => setTimeout(r, 0))
    expect(flows.emitted).toHaveLength(0)
  })

  it('non-admin record create is refused when the record write gates refuse', async () => {
    setConnection({ create_roles: ['role-desk'] })
    expect(
      await mayCreateFrom({ isAdmin: false, user: user() } as never, 'record', 'orders:7', 1)
    ).toEqual({ ok: true })
    editLock.refusal = { status: 403, body: { error: 'Locked', code: 'EDIT_LOCKED' } }
    expect(
      await mayCreateFrom({ isAdmin: false, user: user() } as never, 'record', 'orders:7', 1)
    ).toMatchObject({ ok: false, status: 403 })
  })

  it('GitLab close / reopen / reply on a ticket notify like the desk', async () => {
    link()
    ticket()
    member('ticket', '55')
    await applyIssueEventDetailed(1, remote({ state: 'closed' }), 'jdoe', { stateChanged: true })
    expect(notices.sent).toEqual([
      expect.objectContaining({
        ticket: 55,
        recipients: ['REQ-1', 'DESK-1'],
        subject: 'Done: Cannot open PO 12',
        message: 'GitLab: closed by @jdoe',
        actorId: 'GITLAB-BOT',
        emailRequester: true
      })
    ])
    expect(notices.resolved).toEqual([
      expect.objectContaining({ on: 'ticket', id: 55, status: 'done', actorId: 'GITLAB-BOT' })
    ])
    await applyIssueEventDetailed(
      1,
      remote({ state: 'opened', updated_at: '2026-11-17T12:00:00Z' }),
      'jdoe',
      { stateChanged: true }
    )
    expect(notices.sent.at(-1)).toMatchObject({ subject: 'Open: Cannot open PO 12' })
    expect(notices.resolved).toHaveLength(1)
    // a GitLab reply lands on the ticket thread (meta.tracker) and is told like a desk reply
    const out = await applyNoteEventDetailed(1, PROJECT, IID, {
      id: 555,
      body: 'Fixed in the next release',
      author: { username: 'jdoe', name: 'Jane Doe' },
      created_at: '2026-11-17T12:30:00Z',
      system: false
    })
    expect(out.result).toBe('applied')
    expect(t('nivaro_comments')).toMatchObject([
      {
        collection: 'nivaro_tasks',
        item: '55',
        user: 'GITLAB-BOT',
        text: 'Fixed in the next release'
      }
    ])
    expect(JSON.parse(t('nivaro_comments')[0].meta).tracker).toEqual({
      link: 10,
      note_id: 555,
      author: 'Jane Doe (@jdoe)'
    })
    expect(notices.sent.at(-1)).toMatchObject({
      subject: 'Jane Doe (@jdoe) replied on GitLab: Cannot open PO 12',
      message: 'Fixed in the next release',
      emailRequester: true
    })
  })

  it('a GitLab note lands on ticket and record threads once', async () => {
    link()
    ticket()
    member('ticket', '55')
    member('record', 'orders:7')
    const note = {
      id: 556,
      body: 'Looking at it',
      author: { username: 'jdoe', name: 'Jane Doe' },
      created_at: '2026-11-17T12:30:00Z',
      system: false
    }
    expect(await applyNoteEventDetailed(1, PROJECT, IID, note)).toMatchObject({
      result: 'applied',
      reason: 'Comment added to 2 item(s)'
    })
    expect(t('nivaro_comments').map((c) => [c.collection, c.item])).toEqual([
      ['nivaro_tasks', '55'],
      ['orders', '7']
    ])
    expect(await applyNoteEventDetailed(1, PROJECT, IID, note)).toMatchObject({
      result: 'ignored',
      reason: 'Already stored'
    })
  })

  it('ticket and record comments go out; field comments and switched-off sources do not', async () => {
    link()
    ticket()
    member('ticket', '55')
    member('record', 'orders:7')
    t('nivaro_users').push({ id: 'U-1', first_name: 'Rob', last_name: 'Lee', email: 'r@x' })
    t('nivaro_comments').push(
      { id: 'c-t', collection: 'nivaro_tasks', item: '55', user: 'U-1', text: 'From the desk' },
      { id: 'c-r', collection: 'orders', item: '7', user: 'U-1', text: 'Ping @ops' },
      { id: 'c-f', collection: 'orders', item: '7', user: 'U-1', text: 'x', field: 'amount' }
    )
    for (const id of ['c-t', 'c-r', 'c-f']) await queueCommentOut(id)
    const sent = outbox('comment')
    expect(sent.map((r) => [r.source_kind, r.source_id])).toEqual([
      ['ticket', '55'],
      ['record', 'orders:7']
    ])
    expect(sent[0].payload.body).toMatch(/^\*\*Rob Lee\*\* \(Nivaro\): From the desk/)
    expect(sent[1].payload.body).toContain('Ping @\u200bops')

    // the ticket source off: no comment, close or label change goes out for it
    setConnection({
      sources: { ticket: false },
      ticket_priority_map: { urgent: 'priority::1' }
    })
    t('nivaro_comments').push({
      id: 'c-t2',
      collection: 'nivaro_tasks',
      item: '55',
      user: 'U-1',
      text: 'Again'
    })
    await queueCommentOut('c-t2')
    t('nivaro_tasks')[0].status = 'done'
    t('nivaro_tasks')[0].priority = 'urgent'
    await afterTicketChange(
      55,
      { status: 'done', priority: 'urgent' },
      { userId: 'U-1', via: 'user' },
      9
    )
    expect(outbox('comment')).toHaveLength(2)
    expect(outbox('state')).toHaveLength(0)
    expect(outbox('labels')).toHaveLength(0)
    // the record source off: its comments stay home
    setConnection({ sources: { record: false } })
    t('nivaro_comments').push({
      id: 'c-r2',
      collection: 'orders',
      item: '7',
      user: 'U-1',
      text: 'Hi'
    })
    await queueCommentOut('c-r2')
    expect(outbox('comment')).toHaveLength(2)
  })

  it('a create_roles member links only default-project, non-confidential issues and sees the chip', async () => {
    ticket()
    const view = await linkSourceExisting(
      'ticket',
      '55',
      1,
      'https://gitlab.example.com/g/p/-/issues/12',
      user(),
      { restricted: true }
    )
    // a non-admin's chip never carries GitLab's title, only the one it is given
    expect(chipOf(view, 'My ticket')).toEqual({
      iid: 12,
      web_url: 'https://gitlab.example.com/g/p/-/issues/12',
      state: 'opened',
      title: 'My ticket'
    })
    expect(JSON.stringify(chipOf(view, null))).not.toContain('Remote 12')
    t('nivaro_tasks').push({ id: 56, kind: 'support', title: 'Other', status: 'open' })
    await expect(
      linkSourceExisting('ticket', '56', 1, 'https://gitlab.example.com/g/p/-/issues/99', user(), {
        restricted: true
      })
    ).rejects.toMatchObject({ code: 'CONFIDENTIAL' })
    setConnection()
    conn.view!.default_project_id = 8
    await expect(
      linkSourceExisting('ticket', '56', 1, 'https://gitlab.example.com/g/p/-/issues/13', user(), {
        restricted: true
      })
    ).rejects.toMatchObject({ code: 'PROJECT_NOT_ALLOWED' })
    await expect(
      linkSourceExisting('issue', '5', 1, 'https://gitlab.example.com/g/p/-/issues/13', user(), {
        restricted: true
      })
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    // an admin is not limited
    const admin = await linkSourceExisting(
      'ticket',
      '56',
      1,
      'https://gitlab.example.com/g/p/-/issues/99',
      user()
    )
    expect(admin.labels).toEqual(['secret-label'])
  })
})
