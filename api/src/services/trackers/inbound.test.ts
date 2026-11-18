import Fastify from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── In-memory stand-in for the tables the inbound side reads and writes ──────────
type Row = Record<string, any>
const tables: Record<string, Row[]> = {}
const ids: Record<string, number> = {}
const UNIQUE: Record<string, string[]> = { nivaro_tracker_events: ['event_uuid'] }
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
import {
  applyIssueEvent,
  applyNoteEvent,
  isOwnNote,
  noteReconcileFailure,
  OWN_COMMENT_MARKER,
  reconcileConnection,
  resetReconcileState
} from './inbound.js'
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

  it('answers a bare 404 for an unknown or inactive connection and FEATURE_OFF when off', async () => {
    const app = await hookApp()
    const unknown = await post(app, issueHook(), {}, '/api/tracker-hooks/gitlab/99')
    expect(unknown.statusCode).toBe(404)
    expect(unknown.json()).toEqual({ error: 'Not found' })
    const bad = await post(app, issueHook(), {}, '/api/tracker-hooks/gitlab/1e9')
    expect(bad.statusCode).toBe(404)
    setConnection({}, { is_active: false })
    const inactive = await post(app, issueHook())
    expect(inactive.json()).toEqual({ error: 'Not found' })
    feature.on = false
    setConnection()
    const off = await post(app, issueHook())
    expect(off.statusCode).toBe(404)
    expect(off.json().code).toBe('FEATURE_OFF')
    expect(t('nivaro_tracker_events')).toHaveLength(0)
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
        note({ body: '**Seen again** — Nivaro #5\n\n<!-- nivaro:seen:9 -->\n' })
      )
    ).toBe('ignored')
    expect(await applyNoteEvent(1, PROJECT, IID, note({ system: true }))).toBe('ignored')
    expect(await applyNoteEvent(1, PROJECT, IID, note({ internal: true }))).toBe('ignored')
    expect(t('nivaro_comments')).toHaveLength(0)
    expect(isOwnNote('Seen again\n<!-- nivaro:seen:12 -->')).toBe(true)
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
