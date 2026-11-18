import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── In-memory stand-in for the tables the inbound side reads and writes ──────────
type Row = Record<string, any>
const tables: Record<string, Row[]> = {}
const ids: Record<string, number> = {}
const UNIQUE: Record<string, string[]> = {
  nivaro_tracker_events: ['event_uuid'],
  nivaro_tracker_links: ['connection', 'project_id', 'external_iid'],
  nivaro_tracker_link_members: ['connection', 'source_kind', 'source_id']
}
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

/** where / orWhere predicates, combined left to right. */
function group() {
  const parts: Array<['and' | 'or', (r: Row) => boolean]> = []
  const g: any = {}
  const pred = (a: any, op?: any, v?: any): ((r: Row) => boolean) => {
    if (typeof a === 'function') {
      const sub = group()
      a(sub)
      return (r) => sub.test(r)
    }
    if (typeof a === 'object')
      return (r) => Object.entries(a).every(([k, val]) => cmp(r[k], val) === 0)
    if (v === undefined) return (r) => cmp(r[a], op) === 0
    return (r) => OPS[op](r[a], v)
  }
  g.where = (a: any, op?: any, v?: any) => {
    parts.push(['and', pred(a, op, v)])
    return g
  }
  g.orWhere = (a: any, op?: any, v?: any) => {
    parts.push(['or', pred(a, op, v)])
    return g
  }
  g.whereIn = (col: string, list: any[]) => {
    parts.push(['and', (r) => list.some((x) => cmp(r[col], x) === 0)])
    return g
  }
  g.test = (r: Row) =>
    parts.reduce<boolean>(
      (acc, [conj, p], i) => (i === 0 ? p(r) : conj === 'and' ? acc && p(r) : acc || p(r)),
      true
    )
  return g
}

function builder(name: string) {
  const preds = group()
  let order: [string, string] | null = null
  const rows = () => {
    let out = t(name).filter((r) => preds.test(r))
    if (order) {
      const [col, dir] = order
      out = [...out].sort((a, b) => cmp(a[col], b[col]) * (dir === 'desc' ? -1 : 1))
    }
    return out
  }
  const b: any = {}
  b.where = (...a: any[]) => {
    preds.where(...a)
    return b
  }
  b.orWhere = (...a: any[]) => {
    preds.orWhere(...a)
    return b
  }
  b.whereIn = (col: string, list: any[]) => {
    preds.whereIn(col, list)
    return b
  }
  b.orderBy = (col: string, dir = 'asc') => {
    order = [col, dir]
    return b
  }
  b.select = () => b
  b.first = async () => (rows()[0] ? { ...rows()[0] } : undefined)
  b.update = async (patch: Row) => {
    const hit = rows()
    for (const r of hit) Object.assign(r, patch)
    return hit.length
  }
  b.delete = async () => {
    const hit = new Set(rows().map((r) => r.id))
    tables[name] = t(name).filter((r) => !hit.has(r.id))
    return hit.size
  }
  b.insert = (row: Row) => {
    const doIt = () => {
      const keys = UNIQUE[name]
      if (keys && t(name).some((r) => keys.every((k) => r[k] != null && cmp(r[k], row[k]) === 0)))
        throw new Error('Violation of UNIQUE KEY constraint')
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

vi.mock('../../db/index.js', () => ({ db: (name: string) => builder(name) }))
const background = vi.hoisted(() => ({ runs: [] as Promise<unknown>[] }))
vi.mock('../../db/pool-context.js', () => ({
  runInBackgroundPool: (fn: () => Promise<unknown>) => {
    const p = Promise.resolve().then(fn)
    background.runs.push(p)
    return p
  }
}))
vi.mock('../db-batch.js', () => ({
  selectInChunks: async (list: any[], _n: number, fn: (c: any[]) => Promise<any[]>) =>
    list.length ? fn(list) : [],
  whereInList: (q: any, col: string, list: any[]) => q.whereIn(col, list)
}))
const feature = vi.hoisted(() => ({ on: true }))
vi.mock('./feature.js', () => ({ trackersEnabled: async () => feature.on }))
vi.mock('./outbox.js', () => ({ OUTBOX: 'nivaro_tracker_outbox' }))
vi.mock('./identity.js', () => ({ trackerUserId: async () => 'GITLAB-BOT' }))

const activity = vi.hoisted(() => ({ rows: [] as Row[] }))
vi.mock('../activity.js', () => ({
  logActivity: async (row: Row) => {
    activity.rows.push(row)
    return 1
  }
}))
const funnel = vi.hoisted(() => ({ writes: [] as Array<[number, string]> }))
vi.mock('../issue-raise.js', () => ({
  noteIssueWrite: (id: number, kind: string) => funnel.writes.push([id, kind])
}))
const realtime = vi.hoisted(() => ({ aspects: [] as unknown[][], events: [] as unknown[][] }))
vi.mock('../record-events.js', () => ({
  announceRecordAspect: (...a: unknown[]) => realtime.aspects.push(a),
  emitRecordEvent: (...a: unknown[]) => realtime.events.push(a)
}))

const provider = {
  updatedIssues: vi.fn<(...args: any[]) => any>(),
  notes: vi.fn<(...args: any[]) => any>()
}
const conn = vi.hoisted(() => ({
  view: null as Row | null,
  secret: 'right-secret'
}))
vi.mock('./connections.js', async () => {
  const { normalizeSync } =
    await vi.importActual<typeof import('./connections.js')>('./connections.js')
  return {
    normalizeSync,
    getConnection: async (id: number) => (conn.view && conn.view.id === id ? conn.view : null),
    listConnections: async () => (conn.view ? [conn.view] : []),
    verifyWebhookToken: async (_id: number, token?: string) => token === conn.secret,
    providerFor: async () => provider,
    markBroken: vi.fn(async () => {})
  }
})

import { trackerHookRoutes } from '../../routes/tracker-hooks.js'
import { markBroken, normalizeSync } from './connections.js'
import { STUCK_CLAIM_MS, sweepStuckImports } from './import.js'
import {
  absoluteGitlabLinks,
  applyIssueEvent,
  applyNoteEvent,
  isOwnNote,
  noteReconcileFailure,
  OWN_COMMENT_MARKER,
  projectWebUrl,
  reconcileConnection,
  resetReconcileState,
  setTrackerRedis
} from './inbound.js'
import { addMember, upsertLinkFromRemote } from './link-store.js'
import { type RemoteIssue, type RemoteNote, TrackerError } from './types.js'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const PROJECT = 7
const IID = 42

function setConnection(sync: Record<string, unknown> = {}, extra: Row = {}) {
  conn.view = {
    id: 1,
    name: 'GitLab',
    provider: 'gitlab',
    base_url: 'https://gitlab.example.com',
    is_active: true,
    status: 'ok',
    last_reconcile_at: null,
    sync: normalizeSync(sync),
    ...extra
  }
}

function seed(opts: { statuses?: string[]; severities?: string[]; link?: Row } = {}) {
  const statuses = opts.statuses ?? ['open', 'in_progress']
  t('nivaro_tracker_links').push({
    id: 10,
    connection: 1,
    project_id: PROJECT,
    external_iid: IID,
    remote_state: 'opened',
    remote_labels: '[]',
    remote_updated_at: new Date('2026-11-17T10:00:00Z'),
    last_synced_at: new Date(),
    created_at: new Date(),
    ...opts.link
  })
  statuses.forEach((status, i) => {
    const id = 100 + i
    t('nivaro_issues').push({ id, status, severity: opts.severities?.[i] ?? 'medium' })
    t('nivaro_tracker_link_members').push({
      id: i + 1,
      link: 10,
      connection: 1,
      source_kind: 'issue',
      source_id: String(id)
    })
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

function note(over: Partial<RemoteNote> = {}): RemoteNote {
  return {
    id: 555,
    body: 'Looking at this now',
    author: { username: 'jdoe', name: 'Jane Doe' },
    created_at: '2026-11-17T11:00:00Z',
    system: false,
    ...over
  }
}

const statusOf = (id: number) => t('nivaro_issues').find((r) => r.id === id)?.status
const severityOf = (id: number) => t('nivaro_issues').find((r) => r.id === id)?.severity
const issueUpdates = () => activity.rows.filter((r) => r.collection === 'nivaro_issues')

beforeEach(() => {
  vi.restoreAllMocks()
  resetReconcileState()
  vi.mocked(markBroken).mockClear()
  for (const k of Object.keys(tables)) delete tables[k]
  for (const k of Object.keys(ids)) delete ids[k]
  activity.rows.length = 0
  funnel.writes.length = 0
  realtime.aspects.length = 0
  realtime.events.length = 0
  background.runs.length = 0
  provider.updatedIssues.mockReset()
  provider.notes.mockReset()
  provider.notes.mockResolvedValue([])
  feature.on = true
  setConnection()
})

// ── Webhook route ─────────────────────────────────────────────────────────────

async function hookApp() {
  const app = Fastify()
  await app.register(trackerHookRoutes, { prefix: '/api/tracker-hooks' })
  return app
}

function issueHook(attrs: Row = {}, extra: Row = {}) {
  return {
    object_kind: 'issue',
    user: { username: 'jdoe', name: 'Jane Doe' },
    project: { id: PROJECT },
    object_attributes: {
      id: 9042,
      iid: IID,
      title: 'Crash',
      state: 'opened',
      action: 'update',
      updated_at: '2026-11-17 11:00:00 UTC',
      url: 'https://gitlab.example.com/g/p/-/issues/42',
      ...attrs
    },
    labels: [],
    assignees: [],
    ...extra
  }
}

async function post(
  app: Awaited<ReturnType<typeof hookApp>>,
  payload: unknown,
  headers: Record<string, string> = {},
  url = '/api/tracker-hooks/gitlab/1'
) {
  const res = await app.inject({
    method: 'POST',
    url,
    payload: payload as Row,
    headers: { 'x-gitlab-token': conn.secret, 'x-gitlab-event': 'Issue Hook', ...headers }
  })
  await Promise.all(background.runs)
  return res
}

describe('webhook route', () => {
  it('refuses bad token', async () => {
    t('nivaro_tracker_connections').push({ id: 1 })
    seed()
    const app = await hookApp()
    const res = await post(app, issueHook({ state: 'closed', action: 'close' }), {
      'x-gitlab-token': 'wrong'
    })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'Unauthorized' })
    expect(res.body).not.toMatch(/gitlab\.example|GitLab|connection/i)
    expect(t('nivaro_tracker_events')).toHaveLength(0)
    expect(statusOf(100)).toBe('open')
    expect(t('nivaro_tracker_connections')[0].last_webhook_at).toBeUndefined()
    await app.close()
  })

  it('answers the same bare 401 for an unknown connection and a wrong token, FEATURE_OFF when off', async () => {
    const app = await hookApp()
    const unknown = await post(app, issueHook(), {}, '/api/tracker-hooks/gitlab/99')
    expect(unknown.statusCode).toBe(401)
    expect(unknown.json()).toEqual({ error: 'Unauthorized' })
    const bad = await post(app, issueHook(), {}, '/api/tracker-hooks/gitlab/1e9')
    expect(bad.statusCode).toBe(401)
    expect(bad.json()).toEqual({ error: 'Unauthorized' })
    feature.on = false
    const off = await post(app, issueHook())
    expect(off.statusCode).toBe(404)
    expect(off.json().code).toBe('FEATURE_OFF')
    expect(t('nivaro_tracker_events')).toHaveLength(0)
    await app.close()
  })

  it('a paused connection with the right token is answered 200 and ignored', async () => {
    seed()
    const app = await hookApp()
    setConnection({}, { is_active: false })
    const paused = await post(app, issueHook({ state: 'closed', action: 'close' }))
    expect(paused.statusCode).toBe(200)
    expect(paused.json()).toEqual({ ok: true, ignored: true })
    expect(t('nivaro_tracker_events')).toHaveLength(0)
    expect(statusOf(100)).toBe('open')
    // a wrong token on a paused connection is the same 401 as anywhere
    const wrong = await post(app, issueHook(), { 'x-gitlab-token': 'nope' })
    expect(wrong.statusCode).toBe(401)
    await app.close()
  })

  // security review: the webhook keeps its own failure counter (never the shared budget)
  it('counts failed token checks per address; a good token is never limited', async () => {
    const counts = new Map<string, number>()
    const app = Fastify()
    app.decorate('redis', {
      incr: async (k: string) => {
        counts.set(k, (counts.get(k) ?? 0) + 1)
        return counts.get(k)
      },
      expire: async () => 1,
      set: async () => 'OK',
      eval: async () => 1
    } as never)
    await app.register(trackerHookRoutes, { prefix: '/api/tracker-hooks' })
    const send = (token: string, extra: Record<string, string> = {}) =>
      app.inject({
        method: 'POST',
        url: '/api/tracker-hooks/gitlab/1',
        payload: issueHook(),
        remoteAddress: '203.0.113.9',
        headers: { 'x-gitlab-token': token, 'x-gitlab-event': 'Issue Hook', ...extra }
      })
    const codes: number[] = []
    // a credential header or session cookie changes nothing on this route
    for (let i = 0; i < 25; i++)
      codes.push(
        (await send('wrong', { authorization: 'Bearer x', cookie: 'nivaro_session=abc' }))
          .statusCode
      )
    expect(codes.slice(0, 20).every((c) => c === 401)).toBe(true)
    expect(codes.slice(20).every((c) => c === 429)).toBe(true)
    expect(counts.get('rl:hook::203.0.113.9')).toBe(25)
    const good = await send(conn.secret)
    await Promise.all(background.runs)
    expect(good.statusCode).toBe(200)
    expect(counts.get('rl:hook::203.0.113.9')).toBe(25) // a good delivery is not counted
    await app.close()
  })

  it('checks the token before reading the body', async () => {
    const app = await hookApp()
    const res = await app.inject({
      method: 'POST',
      url: '/api/tracker-hooks/gitlab/1',
      payload: '{ not json',
      headers: { 'content-type': 'application/json', 'x-gitlab-token': 'wrong' }
    })
    expect(res.statusCode).toBe(401)
    expect(res.json()).toEqual({ error: 'Unauthorized' })
    await app.close()
  })

  it('close resolves all members (webhook, activity names the GitLab user)', async () => {
    t('nivaro_tracker_connections').push({ id: 1 })
    seed({ statuses: ['open', 'in_progress', 'closed'] })
    const app = await hookApp()
    const res = await post(app, issueHook({ state: 'closed', action: 'close' }), {
      'x-gitlab-event-uuid': 'u-1'
    })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ok: true })
    expect([statusOf(100), statusOf(101), statusOf(102)]).toEqual([
      'resolved',
      'resolved',
      'closed'
    ])
    expect(issueUpdates()).toHaveLength(2)
    expect(issueUpdates()[0]).toMatchObject({
      action: 'update',
      user: 'GITLAB-BOT',
      origin: 'integration',
      comment: 'GitLab: closed by @jdoe'
    })
    expect(funnel.writes).toEqual([
      [100, 'changed'],
      [101, 'changed']
    ])
    const link = t('nivaro_tracker_links')[0]
    expect(link.remote_state).toBe('closed')
    expect(link.remote_updated_at).toEqual(new Date('2026-11-17T11:00:00Z'))
    const [event] = t('nivaro_tracker_events')
    expect(event).toMatchObject({ event_uuid: 'u-1', status: 'applied', external_iid: IID })
    expect(t('nivaro_tracker_connections')[0].last_webhook_at).toBeInstanceOf(Date)
    await app.close()
  })

  it('closes to "closed" when the status map says so', async () => {
    setConnection({ status_map: { closed: 'closed' } })
    seed()
    await applyIssueEvent(1, remote({ state: 'closed' }), 'jdoe', { stateChanged: true })
    expect([statusOf(100), statusOf(101)]).toEqual(['closed', 'closed'])
  })

  it('duplicate event uuid ignored', async () => {
    seed()
    const app = await hookApp()
    const payload = issueHook({ state: 'closed', action: 'close' })
    await post(app, payload, { 'x-gitlab-event-uuid': 'same' })
    t('nivaro_issues')[0].status = 'open' // someone reopened in Nivaro meanwhile
    const again = await post(app, payload, { 'x-gitlab-event-uuid': 'same' })
    expect(again.statusCode).toBe(200)
    expect(again.json()).toEqual({ ok: true, duplicate: true })
    expect(t('nivaro_tracker_events')).toHaveLength(1)
    expect(statusOf(100)).toBe('open')
    await app.close()
  })

  it('unknown iid ignored and logged', async () => {
    seed()
    const app = await hookApp()
    await post(app, issueHook({ iid: 999, state: 'closed', action: 'close' }), {
      'x-gitlab-event-uuid': 'u-2'
    })
    const [event] = t('nivaro_tracker_events')
    expect(event.status).toBe('ignored')
    expect(event.reason).toMatch(/#999 is not linked/)
    expect(event.external_iid).toBe(999)
    expect(statusOf(100)).toBe('open')
    await app.close()
  })

  it('records other event kinds as ignored', async () => {
    const app = await hookApp()
    const res = await post(app, { object_kind: 'push' }, { 'x-gitlab-event': 'Push Hook' })
    expect(res.statusCode).toBe(200)
    expect(t('nivaro_tracker_events')[0]).toMatchObject({ status: 'ignored', kind: 'Push Hook' })
    await app.close()
  })

  it('mirrors a GitLab comment through the Note Hook, once', async () => {
    seed()
    const app = await hookApp()
    const hook = {
      object_kind: 'note',
      user: { username: 'jdoe', name: 'Jane Doe' },
      project: { id: PROJECT },
      issue: { iid: IID },
      object_attributes: {
        id: 777,
        note: 'Fixed in **main**',
        noteable_type: 'Issue',
        created_at: '2026-11-17 11:05:00 UTC'
      }
    }
    await post(app, hook, { 'x-gitlab-event': 'Note Hook', 'x-gitlab-event-uuid': 'n-1' })
    await post(app, hook, { 'x-gitlab-event': 'Note Hook', 'x-gitlab-event-uuid': 'n-2' })
    const comments = t('nivaro_comments')
    expect(comments.map((c) => c.item)).toEqual(['100', '101'])
    expect(comments[0]).toMatchObject({
      collection: 'nivaro_issues',
      user: 'GITLAB-BOT',
      text: 'Fixed in **main**'
    })
    expect(JSON.parse(comments[0].meta)).toEqual({
      tracker: { link: 10, note_id: 777, author: 'Jane Doe (@jdoe)' }
    })
    expect(t('nivaro_tracker_events').map((e) => e.status)).toEqual(['applied', 'ignored'])
    expect(realtime.aspects).toContainEqual(['nivaro_issues', 100, '$comments'])
    expect(realtime.events).toContainEqual([
      'nivaro_issues',
      101,
      'record:comment',
      { user: 'GITLAB-BOT' }
    ])
    await app.close()
  })
})

// ── Issue applier ─────────────────────────────────────────────────────────────

describe('applyIssueEvent', () => {
  it('skips state change echo', async () => {
    seed({ statuses: ['resolved', 'closed'], link: { remote_state: 'closed' } })
    // Our own close came back: every member is already done (a 'closed' one is not downgraded).
    expect(
      await applyIssueEvent(1, remote({ state: 'closed' }), 'jdoe', { stateChanged: true })
    ).toBe('ignored')
    expect([statusOf(100), statusOf(101)]).toEqual(['resolved', 'closed'])
    expect(issueUpdates()).toHaveLength(0)
    expect(funnel.writes).toHaveLength(0)
  })

  it('reopen opens resolved members', async () => {
    seed({ statuses: ['resolved', 'closed', 'in_progress'], link: { remote_state: 'closed' } })
    expect(await applyIssueEvent(1, remote({ state: 'opened' }), 'jdoe')).toBe('applied')
    expect([statusOf(100), statusOf(101), statusOf(102)]).toEqual(['open', 'open', 'in_progress'])
    expect(issueUpdates().map((r) => r.comment)).toEqual([
      'GitLab: reopened by @jdoe',
      'GitLab: reopened by @jdoe'
    ])
  })

  it('ignores an event older than the stored remote_updated_at', async () => {
    seed()
    expect(
      await applyIssueEvent(
        1,
        remote({ state: 'closed', updated_at: '2026-11-17T09:00:00Z' }),
        'x',
        {
          stateChanged: true
        }
      )
    ).toBe('ignored')
    expect(statusOf(100)).toBe('open')
    expect(t('nivaro_tracker_links')[0].remote_state).toBe('opened')
  })

  it('lane label moves Nivaro status', async () => {
    setConnection({ lane_map: { in_progress: 'workflow::doing', open: 'workflow::to do' } })
    seed({ statuses: ['open', 'open'], link: { remote_labels: '["workflow::to do"]' } })
    expect(
      await applyIssueEvent(1, remote({ labels: ['workflow::doing', 'bug'] }), 'jdoe', {
        labelsPrevious: ['workflow::to do']
      })
    ).toBe('applied')
    expect([statusOf(100), statusOf(101)]).toEqual(['in_progress', 'in_progress'])
    expect(issueUpdates()[0].comment).toBe(
      'GitLab: moved to workflow::doing (in progress) by @jdoe'
    )
    expect(JSON.parse(t('nivaro_tracker_links')[0].remote_labels)).toEqual([
      'workflow::doing',
      'bug'
    ])
  })

  it('a state change in the same event wins over a lane label', async () => {
    setConnection({ lane_map: { in_progress: 'workflow::doing' } })
    seed({ statuses: ['open'] })
    await applyIssueEvent(1, remote({ state: 'closed', labels: ['workflow::doing'] }), 'jdoe', {
      labelsPrevious: [],
      stateChanged: true
    })
    expect(statusOf(100)).toBe('resolved')
  })

  it('leaves lanes alone when lanes_two_way is off', async () => {
    setConnection({ lane_map: { in_progress: 'workflow::doing' }, lanes_two_way: false })
    seed({ statuses: ['open'] })
    expect(
      await applyIssueEvent(1, remote({ labels: ['workflow::doing'] }), 'jdoe', {
        labelsPrevious: []
      })
    ).toBe('ignored')
    expect(statusOf(100)).toBe('open')
  })

  it('priority label sets severity on all members', async () => {
    setConnection({ priority_map: { critical: 'priority::1', high: 'priority::2' } })
    seed({ statuses: ['open', 'resolved', 'open'], severities: ['medium', 'low', 'critical'] })
    expect(
      await applyIssueEvent(1, remote({ labels: ['priority::1'] }), 'jdoe', { labelsPrevious: [] })
    ).toBe('applied')
    expect([severityOf(100), severityOf(101), severityOf(102)]).toEqual([
      'critical',
      'critical',
      'critical'
    ])
    // the member already critical is not written again
    expect(issueUpdates()).toHaveLength(2)
    expect(issueUpdates()[0].comment).toBe('GitLab: priority critical (priority::1) by @jdoe')
  })

  it('own label swap is not echoed', async () => {
    setConnection({ priority_map: { high: 'priority::2', low: 'priority::4' } })
    seed({ statuses: ['open'], severities: ['low'] })
    // Nivaro just swapped priority::2 → priority::4 (outbox, done 10 s ago)…
    t('nivaro_tracker_outbox').push({
      id: 1,
      link: 10,
      op: 'labels',
      status: 'done',
      created_at: new Date(Date.now() - 12_000),
      done_at: new Date(Date.now() - 10_000),
      payload: JSON.stringify({ add_labels: ['priority::4'], remove_labels: ['priority::2'] })
    })
    // …while a stale view still read high; the echo of our swap must not set it back.
    t('nivaro_issues')[0].severity = 'high'
    expect(
      await applyIssueEvent(1, remote({ labels: ['priority::4'] }), 'jdoe', {
        labelsPrevious: ['priority::2']
      })
    ).toBe('ignored')
    expect(severityOf(100)).toBe('high')

    // the same label change long after our op is a real change
    t('nivaro_tracker_outbox')[0].done_at = new Date(Date.now() - 120_000)
    t('nivaro_tracker_outbox')[0].created_at = new Date(Date.now() - 121_000)
    expect(
      await applyIssueEvent(
        1,
        remote({ labels: ['priority::4'], updated_at: '2026-11-17T12:00:00Z' }),
        'jdoe',
        { labelsPrevious: ['priority::2'] }
      )
    ).toBe('applied')
    expect(severityOf(100)).toBe('low')
  })

  it('puts the mirror back when a member write fails', async () => {
    seed({ statuses: ['open'] })
    const realUpdate = t('nivaro_issues')
    Object.defineProperty(realUpdate[0], 'status', {
      configurable: true,
      get: () => 'open',
      set: () => {
        throw new Error('deadlock')
      }
    })
    await expect(
      applyIssueEvent(1, remote({ state: 'closed' }), 'jdoe', { stateChanged: true })
    ).rejects.toThrow('deadlock')
    const link = t('nivaro_tracker_links')[0]
    expect(link.remote_state).toBe('opened')
    expect(link.remote_updated_at).toEqual(new Date('2026-11-17T10:00:00Z'))
  })
})

// ── Note applier ──────────────────────────────────────────────────────────────

describe('applyNoteEvent', () => {
  it('skips its own note', async () => {
    seed()
    const own = `**Rob Lee** (Nivaro): hi\n\n<!-- nivaro:comment:0f8fad5b-d9cb-469f-a165-70867728950e -->\n`
    expect(OWN_COMMENT_MARKER.test(own)).toBe(true)
    expect(await applyNoteEvent(1, PROJECT, IID, note({ body: own }))).toBe('ignored')
    expect(
      await applyNoteEvent(
        1,
        PROJECT,
        IID,
        note({ body: 'Seen again\n<!-- nivaro:example:123 -->' })
      )
    ).toBe('ignored')
    expect(
      await applyNoteEvent(
        1,
        PROJECT,
        IID,
        note({ body: '**Seen again** — Nivaro issue 5\n\n<!-- nivaro:seen:9 -->\n' })
      )
    ).toBe('ignored')
    expect(await applyNoteEvent(1, PROJECT, IID, note({ system: true }))).toBe('ignored')
    expect(await applyNoteEvent(1, PROJECT, IID, note({ internal: true }))).toBe('ignored')
    expect(t('nivaro_comments')).toHaveLength(0)
    expect(isOwnNote('Seen again\n<!-- nivaro:seen:12 -->')).toBe(true)
    expect(isOwnNote('**More examples** — 7 more\n\n<!-- nivaro:rollup:9 -->\n')).toBe(true)
    expect(isOwnNote('<!-- nivaro:rollup:9 -->\nnot ours')).toBe(false)
    expect(isOwnNote('<!-- nivaro:seen:12 -->\nWhy is this back?')).toBe(false)
    // a marker quoted mid-note (not the last line) is someone else's comment
    expect(
      isOwnNote('<!-- nivaro:comment:0f8fad5b-d9cb-469f-a165-70867728950e -->\nI disagree')
    ).toBe(false)
  })

  it('stores nothing when comment sync is off or the issue is not linked', async () => {
    seed()
    expect(await applyNoteEvent(1, PROJECT, 999, note())).toBe('ignored')
    setConnection({ comments: false })
    expect(await applyNoteEvent(1, PROJECT, IID, note())).toBe('ignored')
    expect(t('nivaro_comments')).toHaveLength(0)
  })

  it('a note already stored is not stored twice', async () => {
    seed()
    expect(await applyNoteEvent(1, PROJECT, IID, note())).toBe('applied')
    expect(await applyNoteEvent(1, PROJECT, IID, note())).toBe('ignored')
    expect(t('nivaro_comments')).toHaveLength(2) // one per member
    // a different note id on the same link is new (note 5550 must not match 555's prefix)
    expect(await applyNoteEvent(1, PROJECT, IID, note({ id: 5550 }))).toBe('applied')
  })

  // final review: the dedupe is per thread (collection + item), not per collection
  it('a member that joined later still gets a note the others already have', async () => {
    seed()
    expect(await applyNoteEvent(1, PROJECT, IID, note())).toBe('applied')
    const before = t('nivaro_comments').length
    const first = t('nivaro_tracker_link_members')[0]
    t('nivaro_issues').push({ id: 777, status: 'open', severity: 'medium' })
    t('nivaro_tracker_link_members').push({
      ...first,
      id: 99,
      source_id: '777'
    })
    expect(await applyNoteEvent(1, PROJECT, IID, note())).toBe('applied')
    const added = t('nivaro_comments').slice(before)
    expect(added.map((c) => String(c.item))).toEqual(['777'])
    expect(await applyNoteEvent(1, PROJECT, IID, note())).toBe('ignored')
  })

  // security review: the per-note lock is a Redis lock (never a held DB connection)
  it('two concurrent deliveries of the same note store it once (Redis lock)', async () => {
    seed()
    const store = new Map<string, string>()
    const redis = {
      set: vi.fn(async (k: string, v: string, _px: string, _ms: number, _nx: string) => {
        if (store.has(k)) return null
        store.set(k, v)
        return 'OK'
      }),
      eval: vi.fn(async (_script: string, _n: number, k: string, v: string) => {
        if (store.get(k) !== v) return 0
        store.delete(k)
        return 1
      })
    }
    setTrackerRedis(redis)
    try {
      const both = await Promise.all([
        applyNoteEvent(1, PROJECT, IID, note({ id: 700 })),
        applyNoteEvent(1, PROJECT, IID, note({ id: 700 }))
      ])
      expect(both.sort()).toEqual(['applied', 'ignored'])
      expect(t('nivaro_comments')).toHaveLength(2) // one per member, once
      expect(redis.set.mock.calls[0][0]).toBe(':tracker-note:10:700')
      expect(store.size).toBe(0) // released
    } finally {
      setTrackerRedis(null)
    }
  })

  it('Redis down: the note is still stored once when deliveries come one after another', async () => {
    seed()
    setTrackerRedis({
      set: async () => {
        throw new Error('ECONNREFUSED')
      },
      eval: async () => {
        throw new Error('ECONNREFUSED')
      }
    })
    try {
      expect(await applyNoteEvent(1, PROJECT, IID, note({ id: 701 }))).toBe('applied')
      expect(await applyNoteEvent(1, PROJECT, IID, note({ id: 701 }))).toBe('ignored')
      expect(t('nivaro_comments')).toHaveLength(2)
    } finally {
      setTrackerRedis(null)
    }
  })

  // final review X4
  it('stores relative GitLab links as absolute URLs', async () => {
    seed()
    const body =
      'See ![shot](/uploads/abc/shot.png) and [log](uploads/def/log.txt), ' +
      '[other](/g/p/-/issues/3), [ext](https://x.test/a), [here](#note_1) <img src="/uploads/z/a.png">'
    t('nivaro_tracker_links')[0].web_url = 'https://gitlab.example.com/g/p/-/issues/42'
    expect(await applyNoteEvent(1, PROJECT, IID, note({ id: 600, body }))).toBe('applied')
    const text = String(t('nivaro_comments').at(-1)?.text)
    expect(text).toContain('](https://gitlab.example.com/g/p/uploads/abc/shot.png)')
    expect(text).toContain('](https://gitlab.example.com/g/p/uploads/def/log.txt)')
    expect(text).toContain('](https://gitlab.example.com/g/p/-/issues/3)')
    expect(text).toContain('](https://x.test/a)')
    expect(text).toContain('](#note_1)')
    expect(text).toContain('src="https://gitlab.example.com/g/p/uploads/z/a.png"')
  })
})

describe('absoluteGitlabLinks / projectWebUrl', () => {
  it('derives the project page from the link, else the connection + project path', () => {
    expect(
      projectWebUrl({ web_url: 'https://git.x/a/b/-/issues/4' }, { base_url: 'https://y' })
    ).toBe('https://git.x/a/b')
    expect(
      projectWebUrl({ web_url: '', project_path: 'g/p' }, { base_url: 'https://git.x/' })
    ).toBe('https://git.x/g/p')
    expect(absoluteGitlabLinks('[a](/x)', '')).toBe('[a](/x)')
    expect(absoluteGitlabLinks('[m](mailto:a@b.c) [p](./doc.md)', 'https://git.x/g/p')).toBe(
      '[m](mailto:a@b.c) [p](https://git.x/g/p/doc.md)'
    )
  })
})

// ── Reconcile ─────────────────────────────────────────────────────────────────

describe('reconcileConnection', () => {
  it('reconcile applies remote change newer than remote_updated_at only', async () => {
    t('nivaro_tracker_connections').push({ id: 1 })
    setConnection({}, { last_reconcile_at: '2026-11-17T09:00:00.000Z' })
    seed()
    t('nivaro_tracker_links').push({
      id: 11,
      connection: 1,
      project_id: PROJECT,
      external_iid: 43,
      remote_state: 'opened',
      remote_labels: '[]',
      remote_updated_at: new Date('2026-11-17T12:00:00Z'),
      last_synced_at: new Date(),
      created_at: new Date()
    })
    t('nivaro_issues').push({ id: 200, status: 'open', severity: 'medium' })
    t('nivaro_tracker_link_members').push({
      id: 9,
      link: 11,
      connection: 1,
      source_kind: 'issue',
      source_id: '200'
    })
    provider.updatedIssues.mockResolvedValue([
      remote({ state: 'closed', updated_at: '2026-11-17T11:00:00Z' }), // newer than 10:00
      remote({ iid: 43, state: 'closed', updated_at: '2026-11-17T12:00:00Z' }), // not newer
      remote({ iid: 77, state: 'closed', updated_at: '2026-11-17T12:30:00Z' }) // not linked
    ])
    provider.notes.mockResolvedValue([note({ id: 900 })])

    const out = await reconcileConnection(1)
    expect(provider.updatedIssues).toHaveBeenCalledWith(PROJECT, new Date('2026-11-17T09:00:00Z'))
    expect([statusOf(100), statusOf(101), statusOf(200)]).toEqual(['resolved', 'resolved', 'open'])
    expect(issueUpdates()[0].comment).toBe('GitLab (sync): closed')
    // notes are read for the linked issues only, from the same point
    expect(provider.notes.mock.calls.map((c) => c[1])).toEqual([IID, 43])
    expect(provider.notes.mock.calls[0][2]).toEqual(new Date('2026-11-17T09:00:00Z'))
    expect(out.checked).toBe(3)
    expect(out.applied).toBe(3) // one issue event + note 900 on two links
    // advanced to the newest GitLab time seen, not now
    expect(t('nivaro_tracker_connections')[0].last_reconcile_at).toEqual(
      new Date('2026-11-17T12:30:00Z')
    )
  })

  it('advances last_reconcile_at to the newest updated_at, never past a capped project', async () => {
    t('nivaro_tracker_connections').push({ id: 1 })
    setConnection({}, { last_reconcile_at: '2026-11-17T09:00:00.000Z' })
    seed()
    provider.updatedIssues.mockResolvedValue([
      remote({ iid: 5, updated_at: '2026-11-17T09:30:00Z' }),
      remote({ iid: 6, updated_at: '2026-11-17T09:45:00Z' })
    ])
    await reconcileConnection(1)
    expect(t('nivaro_tracker_connections')[0].last_reconcile_at).toEqual(
      new Date('2026-11-17T09:45:00Z')
    )

    const many = Array.from({ length: 500 }, (_, i) =>
      remote({
        iid: 1000 + i,
        updated_at: new Date(Date.UTC(2026, 10, 17, 10, 0, i)).toISOString()
      })
    )
    // a second project with a newer change: the capped project bounds the advance
    t('nivaro_tracker_links').push({
      id: 12,
      connection: 1,
      project_id: 8,
      external_iid: 1,
      remote_state: 'opened',
      remote_labels: '[]',
      last_synced_at: new Date(),
      created_at: new Date()
    })
    provider.updatedIssues.mockImplementation(async (project: number) =>
      project === PROJECT
        ? many
        : [remote({ project_id: 8, iid: 2, updated_at: '2026-11-17T11:00:00Z' })]
    )
    setConnection({}, { last_reconcile_at: '2026-11-17T09:45:00.000Z' })
    await reconcileConnection(1)
    expect(provider.updatedIssues).toHaveBeenCalledWith(8, new Date('2026-11-17T09:45:00Z'))
    expect(t('nivaro_tracker_connections')[0].last_reconcile_at).toEqual(
      new Date(Date.UTC(2026, 10, 17, 10, 0, 499))
    )
  })

  it('does nothing when the feature is off, the connection is broken or the project failed', async () => {
    t('nivaro_tracker_connections').push({ id: 1 })
    seed()
    feature.on = false
    expect(await reconcileConnection(1)).toEqual({ checked: 0, applied: 0 })
    feature.on = true
    setConnection({}, { status: 'broken' })
    expect(await reconcileConnection(1)).toEqual({ checked: 0, applied: 0 })
    expect(provider.updatedIssues).not.toHaveBeenCalled()
    setConnection()
    provider.updatedIssues.mockRejectedValue(new Error('502'))
    await reconcileConnection(1)
    expect(t('nivaro_tracker_connections')[0].last_reconcile_at).toBeUndefined()
  })

  it('skips projects whose links are old, closed and have no open member', async () => {
    seed({
      statuses: ['resolved'],
      link: {
        remote_state: 'closed',
        last_synced_at: new Date('2026-01-01T00:00:00Z'),
        created_at: new Date('2026-01-01T00:00:00Z')
      }
    })
    provider.updatedIssues.mockResolvedValue([])
    await reconcileConnection(1)
    expect(provider.updatedIssues).not.toHaveBeenCalled()
    t('nivaro_issues')[0].status = 'open'
    await reconcileConnection(1)
    expect(provider.updatedIssues).toHaveBeenCalledTimes(1)
  })

  it('a deleted project does not freeze the cursor and sets last_error', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    t('nivaro_tracker_connections').push({ id: 1 })
    setConnection({}, { last_reconcile_at: '2026-11-17T09:00:00.000Z', last_error: null })
    seed()
    t('nivaro_tracker_links').push({
      id: 12,
      connection: 1,
      project_id: 8,
      project_path: 'g/gone',
      external_iid: 1,
      remote_state: 'opened',
      remote_labels: '[]',
      last_synced_at: new Date(),
      created_at: new Date()
    })
    provider.updatedIssues.mockImplementation(async (project: number) => {
      if (project === 8) throw new TrackerError('404 Project Not Found', 404, 'not_found')
      return [remote({ iid: 5, updated_at: '2026-11-17T09:30:00Z' })]
    })
    await reconcileConnection(1)
    const row = t('nivaro_tracker_connections')[0]
    expect(row.last_reconcile_at).toEqual(new Date('2026-11-17T09:30:00Z'))
    expect(row.last_error).toBe('GitLab project g/gone could not be read: 404 Project Not Found')
    expect(markBroken).not.toHaveBeenCalled()
    expect(warn).toHaveBeenCalledTimes(1)
    // the same refusal next run: still skipped, not logged again
    setConnection({}, { last_reconcile_at: row.last_reconcile_at, last_error: row.last_error })
    await reconcileConnection(1)
    expect(warn).toHaveBeenCalledTimes(1)

    // a passing failure (GitLab 502) still holds the cursor
    provider.updatedIssues.mockImplementation(async (project: number) => {
      if (project === 8) throw new TrackerError('Bad gateway', 502, 'server')
      return [remote({ iid: 5, updated_at: '2026-11-17T10:30:00Z' })]
    })
    await reconcileConnection(1)
    expect(row.last_reconcile_at).toEqual(new Date('2026-11-17T09:30:00Z'))
  })

  it('an issue that keeps failing stops holding the cursor after 3 runs', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    t('nivaro_tracker_connections').push({ id: 1 })
    seed({ statuses: ['open'], link: { project_path: 'g/p' } })
    Object.defineProperty(t('nivaro_issues')[0], 'status', {
      configurable: true,
      get: () => 'open',
      set: () => {
        throw new Error('deadlock')
      }
    })
    provider.updatedIssues.mockResolvedValue([
      remote({ state: 'closed', updated_at: '2026-11-17T11:00:00Z' }), // fails every time
      remote({ iid: 77, updated_at: '2026-11-17T11:10:00Z' })
    ])
    const row = t('nivaro_tracker_connections')[0]
    const run = async () => {
      setConnection(
        {},
        { last_reconcile_at: row.last_reconcile_at ?? '2026-11-17T10:30:00.000Z', last_error: null }
      )
      await reconcileConnection(1)
    }
    const justBefore = new Date(Date.parse('2026-11-17T11:00:00Z') - 1)
    for (let i = 0; i < 3; i++) {
      await run()
      expect(row.last_reconcile_at).toEqual(justBefore)
    }
    expect(row.last_error).toBeUndefined()
    await run()
    expect(row.last_reconcile_at).toEqual(new Date('2026-11-17T11:10:00Z'))
    expect(row.last_error).toMatch(/GitLab issue #42 in project g\/p could not be applied 4 times/)
    expect(row.last_error).toMatch(/deadlock/)
    expect(warn).toHaveBeenCalledTimes(1)
  })

  it('logs reconcile failures at most once per 10 minutes', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t0 = 1_000_000
    noteReconcileFailure(1, new Error('boom'), t0)
    noteReconcileFailure(1, new Error('boom'), t0 + 60_000)
    noteReconcileFailure(2, new Error('boom'), t0 + 9 * 60_000)
    expect(warn).toHaveBeenCalledTimes(1)
    noteReconcileFailure(1, new Error('again'), t0 + 11 * 60_000)
    expect(warn).toHaveBeenCalledTimes(2)
    expect(String(warn.mock.calls[1][0])).toMatch(/3 failures since the last report.*again/)
  })
})

// ── Bringing in issues opened in GitLab (import.ts) ──────────────────────────

describe('bringing in new GitLab issues', () => {
  const SINCE = '2026-11-18T09:00:00.000Z'
  const NEW_IID = 50

  function importing(sync: Record<string, unknown> = {}, extra: Row = {}) {
    t('nivaro_tracker_connections').push({ id: 1 })
    setConnection(
      { import_new_issues: true, import_since: SINCE, ...sync },
      { default_project_id: PROJECT, ...extra }
    )
  }

  function openHook(attrs: Row = {}, extra: Row = {}) {
    return issueHook(
      {
        id: 9050,
        iid: NEW_IID,
        title: 'Export button does nothing',
        description: 'Click **Export** on the list.\n\n![shot](/uploads/abc/shot.png)',
        action: 'open',
        author_id: 55,
        created_at: '2026-11-18 10:00:00 UTC',
        updated_at: '2026-11-18 10:00:00 UTC',
        url: `https://gitlab.example.com/g/p/-/issues/${NEW_IID}`,
        ...attrs
      },
      { user: { id: 55, username: 'jdoe', name: 'Jane Doe' }, ...extra }
    )
  }

  const imported = () => t('nivaro_issues').filter((r) => r.source === 'gitlab')
  const lastEvent = () => t('nivaro_tracker_events').at(-1)

  it('an issue opened in GitLab becomes a linked issue-log entry', async () => {
    importing({ priority_map: { high: 'P2' } })
    const app = await hookApp()
    await post(app, openHook({}, { labels: [{ title: 'P2' }, { title: 'bug' }] }))
    expect(imported()).toHaveLength(1)
    const issue = imported()[0]
    expect(issue).toMatchObject({
      title: 'Export button does nothing',
      status: 'open',
      severity: 'high',
      raised_by: 'GITLAB-BOT',
      occurrence_count: 1
    })
    expect(issue.details).toBe(
      'Opened in GitLab by Jane Doe (@jdoe)\n' +
        `GitLab issue: https://gitlab.example.com/g/p/-/issues/${NEW_IID}\n\n` +
        'Click **Export** on the list.\n\n' +
        '![shot](https://gitlab.example.com/g/p/uploads/abc/shot.png)'
    )
    const link = t('nivaro_tracker_links')[0]
    expect(link).toMatchObject({
      connection: 1,
      project_id: PROJECT,
      external_iid: NEW_IID,
      created_via: 'imported',
      project_path: 'g/p',
      remote_state: 'opened'
    })
    expect(t('nivaro_tracker_link_members')).toEqual([
      expect.objectContaining({
        link: link.id,
        source_kind: 'issue',
        source_id: String(issue.id),
        joined_via: 'lead'
      })
    ])
    expect(funnel.writes).toEqual([[issue.id, 'raised']])
    expect(activity.rows).toContainEqual(
      expect.objectContaining({
        action: 'create',
        user: 'GITLAB-BOT',
        collection: 'nivaro_issues',
        item: String(issue.id),
        origin: 'integration'
      })
    )
    expect(lastEvent()).toMatchObject({
      status: 'applied',
      reason: `Brought in as issue #${issue.id}`
    })
    await app.close()
  })

  it('does nothing while the option is off (the default)', async () => {
    t('nivaro_tracker_connections').push({ id: 1 })
    setConnection({}, { default_project_id: PROJECT })
    const app = await hookApp()
    await post(app, openHook())
    expect(imported()).toHaveLength(0)
    expect(t('nivaro_tracker_links')).toHaveLength(0)
    expect(lastEvent()).toMatchObject({
      status: 'ignored',
      reason: `GitLab issue #${NEW_IID} is not linked`
    })
    // nor when the issue log is switched off on the connection
    importing({ sources: { issue: false } })
    await post(app, openHook())
    expect(imported()).toHaveLength(0)
    await app.close()
  })

  it("only the connection's projects, only open and not confidential issues", async () => {
    importing()
    const app = await hookApp()
    await post(app, openHook({}, { project: { id: 999 } }))
    expect(lastEvent()?.reason).toMatch(/its project is not one of this connection's projects/)
    await post(app, openHook({ confidential: true }))
    expect(lastEvent()?.reason).toMatch(/confidential/)
    await post(app, openHook({ state: 'closed' }))
    expect(lastEvent()?.reason).toMatch(/closed/)
    expect(imported()).toHaveLength(0)
    // a ticket rule's project is not one of them
    t('nivaro_tracker_rules').push({
      id: 2,
      connection: 1,
      enabled: true,
      paused_reason: null,
      applies_to: 'ticket',
      action: JSON.stringify({ connection: 1, project_id: 999 })
    })
    await post(app, openHook({}, { project: { id: 999 } }))
    expect(imported()).toHaveLength(0)
    // a project an enabled issue rule creates in counts as the connection's
    t('nivaro_tracker_rules').push({
      id: 1,
      connection: 1,
      enabled: true,
      paused_reason: null,
      action: JSON.stringify({ connection: 1, project_id: 999 })
    })
    await post(app, openHook({}, { project: { id: 999 } }))
    expect(imported()).toHaveLength(1)
    await app.close()
  })

  it('with a label set, only labelled issues; adding the label later brings an older one in', async () => {
    importing({ import_label: 'nivaro' })
    const app = await hookApp()
    await post(app, openHook())
    expect(lastEvent()?.reason).toMatch(/does not carry the "nivaro" label/)
    expect(imported()).toHaveLength(0)

    // an issue opened BEFORE the switch-on gets the label now: brought in
    const old = openHook(
      { action: 'update', created_at: '2026-11-01 08:00:00 UTC', iid: 51, id: 9051 },
      {
        labels: [{ title: 'nivaro' }],
        changes: { labels: { previous: [], current: [{ title: 'nivaro' }] } }
      }
    )
    await post(app, old)
    expect(imported()).toHaveLength(1)
    // an older issue that merely carries it (no label change in the event): not brought in
    await post(
      app,
      openHook(
        { action: 'update', created_at: '2026-11-01 08:00:00 UTC', iid: 52, id: 9052 },
        { labels: [{ title: 'nivaro' }] }
      )
    )
    expect(lastEvent()?.reason).toMatch(/opened before bringing in new issues was switched on/)
    // a new labelled issue: brought in
    await post(app, openHook({ iid: 53, id: 9053 }, { labels: [{ title: 'Nivaro' }] }))
    expect(imported()).toHaveLength(2)
    await app.close()
  })

  it('never brings in an issue Nivaro opened itself; a queued same-titled create means later', async () => {
    importing({}, { last_reconcile_at: '2026-11-18T08:00:00.000Z' })
    const app = await hookApp()
    // 1. the description carries a Nivaro create marker (edited text above it)
    await post(
      app,
      openHook({ description: 'Crash\n\n<!-- nivaro:issue:100 -->\n\nedited by a person' })
    )
    expect(lastEvent()?.reason).toMatch(/Nivaro opened it/)
    // 2. a create for the same project + title is queued or being sent right now: not now
    t('nivaro_tracker_outbox').push({
      id: 1,
      connection: 1,
      op: 'create',
      status: 'sending',
      payload: JSON.stringify({
        project_id: PROJECT,
        issue: 100,
        input: { title: 'Export button does nothing' }
      })
    })
    await post(app, openHook({ description: '' }))
    expect(lastEvent()?.reason).toMatch(/read again on the next reconcile/)
    expect(imported()).toHaveLength(0)
    // … and the reconcile pass keeps its cursor on it (no failure shown) instead of moving past
    provider.updatedIssues.mockResolvedValue([
      remote({
        iid: NEW_IID,
        title: 'Export button does nothing',
        created_at: '2026-11-18T10:00:00Z',
        updated_at: '2026-11-18T10:00:00Z'
      })
    ])
    for (let run = 0; run < 5; run++) await reconcileConnection(1)
    expect(imported()).toHaveLength(0)
    // the cursor never passes the issue (it is read again each pass)
    expect(t('nivaro_tracker_connections')[0].last_reconcile_at.getTime()).toBeLessThan(
      Date.parse('2026-11-18T10:00:00Z')
    )
    expect(conn.view?.last_error ?? null).toBeNull()
    // the create is gone (it was another issue): the next pass brings it in
    t('nivaro_tracker_outbox').length = 0
    await reconcileConnection(1)
    expect(imported()).toHaveLength(1)
    await app.close()
  })

  it("an admin's own issue comes in even when the connection uses their personal token", async () => {
    importing()
    const app = await hookApp()
    await post(
      app,
      openHook(
        { description: 'Found while testing', author_id: 1 },
        { user: { id: 1, username: 'rob' } }
      )
    )
    expect(imported()).toHaveLength(1)
    await app.close()
  })

  it("Nivaro's own create answered by the webhook before its link is stored: one issue", async () => {
    importing()
    t('nivaro_issues').push({ id: 100, status: 'open', severity: 'high', source: 'server' })
    t('nivaro_tracker_outbox').push({
      id: 1,
      connection: 1,
      op: 'create',
      status: 'sending',
      payload: JSON.stringify({ project_id: PROJECT, issue: 100, input: { title: 'Crash' } })
    })
    const app = await hookApp()
    // GitLab's webhook for the issue Nivaro is creating arrives first …
    const created = remote({
      iid: NEW_IID,
      title: 'Crash',
      description: 'Server error\n\n<!-- nivaro:issue:100 -->',
      web_url: `https://gitlab.example.com/g/p/-/issues/${NEW_IID}`
    })
    await post(
      app,
      openHook(
        { title: 'Crash', description: created.description, author_id: 1 },
        { user: { id: 1, username: 'nivaro-bot', name: 'Nivaro' } }
      )
    )
    expect(t('nivaro_tracker_links')).toHaveLength(0)
    // … then the outbox stores the link + member (outbox.ts sendCreate)
    const linkId = await upsertLinkFromRemote(1, created, {
      project_path: 'g/p',
      created_via: 'rule'
    })
    await addMember(linkId, 1, 100, 'lead')
    // a redelivery of the open event now finds the link: nothing new either
    await post(app, openHook({ title: 'Crash', description: created.description, author_id: 1 }))
    expect(imported()).toHaveLength(0)
    expect(t('nivaro_issues')).toHaveLength(1)
    expect(t('nivaro_tracker_link_members').map((m) => m.source_id)).toEqual(['100'])
    await app.close()
  })

  it('a redelivered or doubled event brings the issue in once', async () => {
    importing()
    const app = await hookApp()
    await post(app, openHook(), { 'x-gitlab-event-uuid': 'a-1' })
    await post(app, openHook(), { 'x-gitlab-event-uuid': 'a-2' })
    await post(app, openHook(), { 'x-gitlab-event-uuid': 'a-1' })
    expect(imported()).toHaveLength(1)
    // webhook and reconcile at the same moment: the link insert is the claim
    t('nivaro_tracker_links').length = 0
    t('nivaro_tracker_link_members').length = 0
    tables.nivaro_issues = []
    const issue = remote({
      iid: 60,
      created_at: '2026-11-18T10:00:00Z',
      author: { id: 55, username: 'jdoe' }
    })
    const [a, b] = await Promise.all([
      applyIssueEvent(1, issue, null, { source: 'webhook' }),
      applyIssueEvent(1, issue, null, { source: 'reconcile' })
    ])
    expect([a, b].sort()).toEqual(['applied', 'ignored'])
    expect(imported()).toHaveLength(1)
    expect(t('nivaro_tracker_links')).toHaveLength(1)
    await app.close()
  })

  it('a failure after the claim removes it, so the next delivery tries again', async () => {
    importing()
    // the member write fails once (a stray row already holds the new issue's key)
    t('nivaro_tracker_link_members').push({
      id: 99,
      link: 999,
      connection: 1,
      source_kind: 'issue',
      source_id: '1'
    })
    const app = await hookApp()
    await post(app, openHook())
    expect(lastEvent()).toMatchObject({ status: 'failed' })
    expect(t('nivaro_tracker_links')).toHaveLength(0)
    expect(imported()).toHaveLength(0)
    await post(app, openHook())
    expect(imported()).toHaveLength(1)
    await app.close()
  })

  it('reconcile picks up missed issues opened after the switch-on time only', async () => {
    importing({}, { last_reconcile_at: '2026-11-18T08:00:00.000Z' })
    provider.updatedIssues.mockResolvedValue([
      remote({
        iid: 70,
        title: 'Old one',
        created_at: '2026-11-10T08:00:00Z',
        updated_at: '2026-11-18T09:30:00Z',
        author: { id: 55, username: 'jdoe', name: 'Jane Doe' }
      }),
      remote({
        iid: 71,
        title: 'Missed one',
        created_at: '2026-11-18T09:40:00Z',
        updated_at: '2026-11-18T09:40:00Z',
        author: { id: 55, username: 'jdoe', name: 'Jane Doe' }
      })
    ])
    const out = await reconcileConnection(1)
    // the connection's project is read although no link lives there yet
    expect(provider.updatedIssues).toHaveBeenCalledWith(PROJECT, new Date('2026-11-18T08:00:00Z'))
    expect(imported().map((i) => i.title)).toEqual(['Missed one'])
    expect(imported()[0].details).toMatch(/^Opened in GitLab by Jane Doe \(@jdoe\)/)
    expect(out.applied).toBe(1)
    // its comments since the last pass are read at once
    expect(provider.notes.mock.calls.map((c) => c[1])).toEqual([71])
  })

  it('an imported issue then syncs close and comments like any linked one', async () => {
    importing()
    const app = await hookApp()
    await post(app, openHook())
    const id = imported()[0].id
    await post(
      app,
      openHook({ action: 'close', state: 'closed', updated_at: '2026-11-18 11:00:00 UTC' })
    )
    expect(statusOf(id)).toBe('resolved')
    await post(
      app,
      {
        object_kind: 'note',
        user: { username: 'jdoe', name: 'Jane Doe' },
        project: { id: PROJECT },
        issue: { iid: NEW_IID },
        object_attributes: {
          id: 801,
          note: 'Shipped in 1.2',
          noteable_type: 'Issue',
          created_at: '2026-11-18 11:05:00 UTC'
        }
      },
      { 'x-gitlab-event': 'Note Hook' }
    )
    expect(t('nivaro_comments')).toEqual([
      expect.objectContaining({ item: String(id), text: 'Shipped in 1.2' })
    ])
    await app.close()
  })
  it('the delivery that loses the claim waits, then applies its own change to the issue', async () => {
    importing({ lane_map: { in_progress: 'doing' } })
    const opened = remote({ iid: 61, created_at: '2026-11-18T10:00:00Z' })
    const moved = remote({
      iid: 61,
      created_at: '2026-11-18T10:00:00Z',
      labels: ['doing'],
      updated_at: '2026-11-18T11:30:00Z'
    })
    const [a, b] = await Promise.all([
      applyIssueEvent(1, opened, null, { source: 'webhook' }),
      applyIssueEvent(1, moved, 'jdoe', { source: 'webhook', labelsPrevious: [] })
    ])
    expect(imported()).toHaveLength(1)
    // the loser's lane move was applied to the issue the winner brought in
    expect([a, b]).toEqual(['applied', 'applied'])
    expect(imported()[0].status).toBe('in_progress')
  })

  it('a claim whose issue never comes: reconcile keeps its cursor, the sweep clears it', async () => {
    importing({}, { last_reconcile_at: '2026-11-18T08:00:00.000Z' })
    const stuckAt = new Date(Date.now() - STUCK_CLAIM_MS - 60_000)
    t('nivaro_tracker_links').push(
      {
        id: 70,
        connection: 1,
        project_id: PROJECT,
        external_iid: 62,
        created_via: 'imported',
        created_at: new Date()
      },
      // an older stuck claim, and a declined tombstone the sweep must keep
      {
        id: 71,
        connection: 1,
        project_id: PROJECT,
        external_iid: 63,
        created_via: 'imported',
        created_at: stuckAt
      },
      {
        id: 72,
        connection: 1,
        project_id: PROJECT,
        external_iid: 64,
        created_via: 'declined',
        created_at: stuckAt
      }
    )
    // a webhook while the claim is held: answered, read again later
    const app = await hookApp()
    await post(app, openHook({ iid: 62, id: 9062 }))
    expect(lastEvent()?.reason).toMatch(/still being brought in/)
    await app.close()
    expect(await sweepStuckImports()).toBe(1)
    expect(t('nivaro_tracker_links').map((l) => l.id)).toEqual([70, 72])
    // the next delivery of #63 brings it in; #64 (declined) never comes back
    await applyIssueEvent(1, remote({ iid: 63, created_at: '2026-11-18T10:00:00Z' }), null, {
      source: 'webhook'
    })
    await applyIssueEvent(1, remote({ iid: 64, created_at: '2026-11-18T10:00:00Z' }), null, {
      source: 'webhook'
    })
    expect(imported()).toHaveLength(1)
  })
})
