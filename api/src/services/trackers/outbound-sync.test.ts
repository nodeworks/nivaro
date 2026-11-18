import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── In-memory stand-in for the tables this module reads ─────────────────────────
type Row = Record<string, any>
const tables: Record<string, Row[]> = {}
const t = (name: string) => {
  tables[name] ??= []
  return tables[name]
}
const cmp = (a: any, b: any) => {
  if (a == null || b == null) return a == null && b == null ? 0 : a == null ? -1 : 1
  const x = a instanceof Date ? a.getTime() : a
  const y = b instanceof Date ? b.getTime() : b
  return x < y ? -1 : x > y ? 1 : 0
}

function builder(name: string) {
  const preds: Array<(r: Row) => boolean> = []
  let order: [string, string] | null = null
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
    if (typeof a === 'object')
      preds.push((r) => Object.entries(a).every(([k, val]) => cmp(r[k], val) === 0))
    else if (v === undefined) preds.push((r) => cmp(r[a], op) === 0)
    else throw new Error(`op ${op} not faked`)
    return b
  }
  b.whereIn = (col: string, list: any[]) => {
    preds.push((r) => list.some((x) => cmp(r[col], x) === 0))
    return b
  }
  b.orderBy = (col: string, dir = 'asc') => {
    order = [col, dir]
    return b
  }
  b.select = () => b
  b.first = async () => (rows()[0] ? { ...rows()[0] } : undefined)
  // biome-ignore lint/suspicious/noThenProperty: awaitable like a knex builder
  b.then = (res: any, rej: any) => Promise.resolve(rows().map((r) => ({ ...r }))).then(res, rej)
  return b
}

vi.mock('../../db/index.js', () => ({ db: (name: string) => builder(name) }))
vi.mock('../../db/pool-context.js', () => ({
  runInBackgroundPool: (fn: () => Promise<unknown>) => Promise.resolve().then(fn)
}))
vi.mock('../db-batch.js', () => ({
  selectInChunks: async (list: any[], _n: number, fn: (c: any[]) => Promise<any[]>) =>
    list.length ? fn(list) : [],
  whereInList: (q: any, col: string, list: any[]) => q.whereIn(col, list)
}))
const feature = vi.hoisted(() => ({ on: true }))
vi.mock('./feature.js', () => ({ trackersEnabled: async () => feature.on }))

const queued = vi.hoisted(() => ({ rows: [] as Row[] }))
vi.mock('./outbox.js', () => ({
  OUTBOX: 'nivaro_tracker_outbox',
  enqueue: async (row: Row) => {
    const same = queued.rows.find((r) => r.key === row.key)
    if (same) return same.id
    const id = queued.rows.length + 1
    queued.rows.push({ ...row, id })
    return id
  }
}))

const conn = vi.hoisted(() => ({ views: [] as Row[] }))
vi.mock('./connections.js', async () => {
  const { normalizeSync } =
    await vi.importActual<typeof import('./connections.js')>('./connections.js')
  return {
    normalizeSync,
    getConnection: async (id: number) => conn.views.find((c) => c.id === id) ?? null,
    listConnections: async () => conn.views
  }
})

const joins = vi.hoisted(() => ({ calls: [] as unknown[][] }))
vi.mock('./similar.js', () => ({
  fingerprintLink: async (connection: number, _issue: number, fp: string) => {
    const l = t('nivaro_tracker_links').find(
      (r) => r.connection === connection && r.fingerprint === fp
    )
    return l ? l.id : null
  },
  joinAsExample: async (issue: number, connection: number, target: Row, via: string) => {
    joins.calls.push([issue, connection, target, via])
    t('nivaro_tracker_link_members').push({
      link: target.link_id,
      connection,
      source_kind: 'issue',
      source_id: String(issue)
    })
    return target.link_id
  }
}))
vi.mock('./issue-body.js', () => ({
  loadIssue: async (id: number) => t('nivaro_issues').find((r) => r.id === id) ?? null,
  issueVars: async (issue: Row) => ({
    total_hits: issue.occurrence_count ?? 1,
    hits_24h: 12,
    people_24h: 3,
    route: '/orders/@[x]',
    build: '1.2.3',
    nivaro_url: 'https://nivaro.test/issues/5'
  })
}))

import { normalizeSync } from './connections.js'
import { isOwnNote } from './inbound.js'
import {
  afterIssueChange,
  onRecurrence,
  outgoingCommentBody,
  queueCommentOut,
  queueLabelSwap,
  queueSeenNote,
  queueStateOut
} from './outbound-sync.js'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const COMMENT_ID = '0f8fad5b-d9cb-469f-a165-70867728950e'
const BOT = 'BOT-ID'

function setConnection(sync: Row = {}, extra: Row = {}) {
  conn.views = [{ id: 1, is_active: true, status: 'ok', sync: normalizeSync(sync), ...extra }]
}

function seed(opts: { remote_state?: string; created_via?: string; labels?: string[] } = {}) {
  setConnection()
  t('nivaro_users').push(
    { id: 'U1', first_name: 'Jane', last_name: 'Doe', email: 'jane@x.test' },
    { id: BOT, first_name: 'GitLab', email: 'gitlab-sync@nivaro.local' }
  )
  t('nivaro_issues').push(
    { id: 5, status: 'open', severity: 'high', fingerprint: 'fp1', source: 'server' },
    { id: 6, status: 'open', severity: 'low', fingerprint: 'fp1', source: 'server' }
  )
  t('nivaro_tracker_links').push({
    id: 9,
    connection: 1,
    project_id: 7,
    external_iid: 42,
    fingerprint: 'fp1',
    remote_state: opts.remote_state ?? 'opened',
    remote_labels: JSON.stringify(opts.labels ?? []),
    created_via: opts.created_via ?? 'rule',
    last_seen_note_at: null
  })
  t('nivaro_tracker_link_members').push(
    { link: 9, connection: 1, source_kind: 'issue', source_id: '5' },
    { link: 9, connection: 1, source_kind: 'issue', source_id: '6' }
  )
}

function comment(over: Row = {}) {
  t('nivaro_comments').push({
    id: COMMENT_ID,
    collection: 'nivaro_issues',
    item: '5',
    user: 'U1',
    text: 'Looks like @[John Smith] broke it\n/close',
    field: null,
    meta: null,
    ...over
  })
}

const ops = (op: string) => queued.rows.filter((r) => r.op === op)
const flush = () => new Promise((r) => setTimeout(r, 5))

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k]
  queued.rows = []
  joins.calls = []
  conn.views = []
  feature.on = true
})

// ── Comment body ──────────────────────────────────────────────────────────────

describe('outgoingCommentBody', () => {
  it('@[Jane Doe] becomes Jane Doe', () => {
    const body = outgoingCommentBody(
      'Rob Lee',
      'Ping @[Jane Doe] and @[Al](u-1) please',
      COMMENT_ID
    )
    expect(body).toContain('Ping Jane Doe and Al please')
    expect(body.startsWith('**Rob Lee** (Nivaro): ')).toBe(true)
    expect(body.endsWith(`\n\n<!-- nivaro:comment:${COMMENT_ID} -->`)).toBe(true)
    // our own note is recognised on the way back in
    expect(isOwnNote(body)).toBe(true)
  })

  it('sanitises quick actions, bare mentions, forged markers and the author', () => {
    const body = outgoingCommentBody(
      '**Eve**\n/close',
      '/assign @root\n<!-- nivaro:comment:x -->',
      COMMENT_ID
    )
    const lines = body.split('\n')
    expect(lines.some((l) => l.startsWith('/'))).toBe(false)
    expect(body).not.toMatch(/@root/)
    expect(body.match(/<!--/g)).toHaveLength(1)
    expect(lines[0]).not.toContain('\n')
  })
})

// ── Comments out ──────────────────────────────────────────────────────────────

describe('queueCommentOut', () => {
  it('queues a prefixed comment on the linked GitLab issue', async () => {
    seed()
    comment()
    await queueCommentOut(COMMENT_ID)
    expect(ops('comment')).toHaveLength(1)
    const row = ops('comment')[0]
    expect(row.key).toBe(`comment:9:${COMMENT_ID}`)
    expect(row.payload).toMatchObject({ project_id: 7, iid: 42 })
    expect(row.payload.body).toMatch(/^\*\*Jane Doe\*\* \(Nivaro\): Looks like John Smith broke it/)
    // idempotent
    await queueCommentOut(COMMENT_ID)
    expect(ops('comment')).toHaveLength(1)
  })

  it('field comment not sent', async () => {
    seed()
    comment({ field: 'title' })
    await queueCommentOut(COMMENT_ID)
    expect(queued.rows).toHaveLength(0)
  })

  it('mirror comment not sent', async () => {
    seed()
    comment({ meta: '{"tracker":{"link":9,"note_id":1,"author":"jdoe"}}', user: BOT })
    await queueCommentOut(COMMENT_ID)
    expect(queued.rows).toHaveLength(0)
    // the machine user's comment without meta stays home too
    tables.nivaro_comments = []
    comment({ user: BOT })
    await queueCommentOut(COMMENT_ID)
    expect(queued.rows).toHaveLength(0)
  })

  it('sends nothing when off, unlinked, comments off, or the connection is broken', async () => {
    seed()
    comment()
    feature.on = false
    await queueCommentOut(COMMENT_ID)
    feature.on = true
    setConnection({ comments: false })
    await queueCommentOut(COMMENT_ID)
    setConnection({}, { status: 'broken' })
    await queueCommentOut(COMMENT_ID)
    setConnection({}, { is_active: false })
    await queueCommentOut(COMMENT_ID)
    setConnection()
    tables.nivaro_tracker_link_members = []
    await queueCommentOut(COMMENT_ID)
    expect(queued.rows).toHaveLength(0)
  })

  it('a person-written GitLab issue still gets comments', async () => {
    seed({ created_via: 'linked' })
    comment()
    await queueCommentOut(COMMENT_ID)
    expect(ops('comment')).toHaveLength(1)
  })
})

// ── State out ─────────────────────────────────────────────────────────────────

describe('queueStateOut', () => {
  it('closes only when every member is resolved or closed', async () => {
    seed()
    t('nivaro_issues')[0].status = 'resolved'
    await queueStateOut(5, 'resolved', { userId: 'U1', via: 'user' })
    expect(ops('state')).toHaveLength(0)
    t('nivaro_issues')[1].status = 'closed'
    await queueStateOut(6, 'closed', { userId: 'U1', via: 'user' })
    expect(ops('state')).toHaveLength(1)
    expect(ops('state')[0].payload).toMatchObject({ project_id: 7, iid: 42, state: 'close' })
    expect(ops('state')[0].key).toMatch(/^state:9:close:\d{4}-\d\d-\d\dT\d\d:\d\d$/)
  })

  it('does not close when close_on_resolve is off', async () => {
    seed()
    setConnection({ close_on_resolve: false })
    for (const i of t('nivaro_issues')) i.status = 'resolved'
    await queueStateOut(5, 'resolved', { userId: 'U1', via: 'user' })
    expect(ops('state')).toHaveLength(0)
  })

  it('reopens a closed GitLab issue when a person reopens a member', async () => {
    seed({ remote_state: 'closed' })
    // a bulk change that did not reach this row (not the caller's) sends nothing
    await queueStateOut(5, 'in_progress', { userId: 'U1', via: 'user' })
    expect(ops('state')).toHaveLength(0)
    t('nivaro_issues')[0].status = 'in_progress'
    await queueStateOut(5, 'in_progress', { userId: 'U1', via: 'user' })
    expect(ops('state')[0]?.payload.state).toBe('reopen')
    // already open on GitLab: nothing
    queued.rows = []
    t('nivaro_tracker_links')[0].remote_state = 'opened'
    await queueStateOut(5, 'open', { userId: 'U1', via: 'user' })
    expect(ops('state')).toHaveLength(0)
  })

  it('a queued close counts: a reopen right after it is sent', async () => {
    seed()
    t('nivaro_tracker_outbox').push({
      id: 1,
      link: 9,
      op: 'state',
      status: 'pending',
      payload: JSON.stringify({ state: 'close' })
    })
    await queueStateOut(5, 'open', { userId: 'U1', via: 'user' })
    expect(ops('state')[0]?.payload.state).toBe('reopen')
  })

  it('never echoes a GitLab change, the machine user, or a person-written issue', async () => {
    seed({ remote_state: 'closed' })
    await queueStateOut(5, 'open', { userId: BOT, via: 'gitlab' })
    await queueStateOut(5, 'open', { userId: BOT, via: 'user' })
    expect(ops('state')).toHaveLength(0)
    tables.nivaro_tracker_links = []
    tables.nivaro_tracker_link_members = []
    tables.nivaro_issues = []
    tables.nivaro_users = []
    seed({ remote_state: 'closed', created_via: 'linked' })
    await queueStateOut(5, 'open', { userId: 'U1', via: 'user' })
    expect(ops('state')).toHaveLength(0)
    setConnection({ push_to_linked: true })
    await queueStateOut(5, 'open', { userId: 'U1', via: 'user' })
    expect(ops('state')).toHaveLength(1)
  })
})

// ── Labels out ────────────────────────────────────────────────────────────────

describe('queueLabelSwap', () => {
  it('swaps the lane label on a status change', async () => {
    seed({ labels: ['workflow::to do', 'bug'] })
    setConnection({ lane_map: { open: 'workflow::to do', in_progress: 'workflow::doing' } })
    t('nivaro_issues')[0].status = 'in_progress'
    await queueLabelSwap(5, 'lane', { userId: 'U1', via: 'user' })
    expect(ops('labels')).toHaveLength(1)
    expect(ops('labels')[0].payload).toMatchObject({
      project_id: 7,
      iid: 42,
      add_labels: ['workflow::doing'],
      remove_labels: ['workflow::to do']
    })
  })

  it('swaps the priority label on a severity change (aliases normalised)', async () => {
    seed()
    setConnection({ priority_map: { high: 'priority::2', critical: 'priority::1' } })
    t('nivaro_issues')[0].severity = 'error' // legacy alias of high
    await queueLabelSwap(5, 'priority', { userId: 'U1', via: 'user' })
    expect(ops('labels')[0].payload).toMatchObject({
      add_labels: ['priority::2'],
      remove_labels: ['priority::1']
    })
  })

  it('queues nothing with an empty map, a settled mirror, a GitLab change or a linked issue', async () => {
    seed({ labels: ['workflow::to do'] })
    await queueLabelSwap(5, 'lane', { userId: 'U1', via: 'user' })
    setConnection({ lane_map: { open: 'workflow::to do', in_progress: 'workflow::doing' } })
    await queueLabelSwap(5, 'lane', { userId: 'U1', via: 'user' }) // already shows the result
    await queueLabelSwap(5, 'lane', { userId: BOT, via: 'gitlab' })
    t('nivaro_issues')[0].status = 'resolved' // not mapped: the lane label stays
    await queueLabelSwap(5, 'lane', { userId: 'U1', via: 'user' })
    t('nivaro_tracker_links')[0].created_via = 'linked'
    t('nivaro_issues')[0].status = 'in_progress'
    await queueLabelSwap(5, 'lane', { userId: 'U1', via: 'user' })
    expect(ops('labels')).toHaveLength(0)
  })

  it('afterIssueChange sends state + lane for a status and priority for a severity', async () => {
    seed({ remote_state: 'closed' })
    setConnection({ lane_map: { open: 'lane-open' }, priority_map: { low: 'p-low' } })
    t('nivaro_issues')[0].severity = 'low' // the write has landed before the hook runs
    afterIssueChange([5], { status: 'open', severity: 'low' }, { userId: 'U1', via: 'user' })
    await flush()
    await flush()
    expect(ops('state')).toHaveLength(1)
    expect(
      ops('labels')
        .map((r) => r.payload.add_labels[0])
        .sort()
    ).toEqual(['lane-open', 'p-low'])
    queued.rows = []
    afterIssueChange([5], { status: 'open' }, { userId: BOT, via: 'gitlab' })
    await flush()
    expect(queued.rows).toHaveLength(0)
  })
})

// ── Seen again + recurrence ──────────────────────────────────────────────────

describe('seen-again note and recurrence', () => {
  it('seen note throttled to 1/hour', async () => {
    seed()
    const c = conn.views[0] as any
    const link = () => ({ ...t('nivaro_tracker_links')[0] })
    const now = new Date('2026-11-17T10:00:00Z')
    expect(await queueSeenNote(link(), c, 5, now)).toBe(true)
    const note = ops('note_seen')[0]
    expect(note.payload.body).toMatch(/\*\*Seen again\*\* — Nivaro #5/)
    expect(note.payload.body).toMatch(/12 in the last 24 hours by 3 people/)
    // the route sits mid-line: no quick action to defuse, the mention still is
    expect(note.payload.body).toContain('Last route: /orders/@\u200b[x]')
    expect(note.payload.body.trim().split('\n').pop()).toBe('<!-- nivaro:seen:9 -->')
    expect(isOwnNote(note.payload.body)).toBe(true)
    // still queued → no second note
    t('nivaro_tracker_outbox').push({ id: 1, link: 9, op: 'note_seen', status: 'pending' })
    expect(await queueSeenNote(link(), c, 5, now)).toBe(false)
    // sent 30 min ago → still held; 61 min ago → a new one
    tables.nivaro_tracker_outbox = []
    t('nivaro_tracker_links')[0].last_seen_note_at = new Date('2026-11-17T09:30:00Z')
    expect(await queueSeenNote(link(), c, 5, now)).toBe(false)
    t('nivaro_tracker_links')[0].last_seen_note_at = new Date('2026-11-17T08:59:00Z')
    expect(await queueSeenNote(link(), c, 5, now)).toBe(true)
    expect(ops('note_seen')).toHaveLength(2)
  })

  it('no seen note when seen_note is off', async () => {
    seed()
    setConnection({ seen_note: false })
    await onRecurrence(5, 'recurred')
    expect(queued.rows).toHaveLength(0)
  })

  it('a member that recurs on an open link gets a seen note', async () => {
    seed()
    await onRecurrence(5, 'recurred')
    expect(ops('note_seen')).toHaveLength(1)
    expect(ops('state')).toHaveLength(0)
  })

  it('a member the engine joined on this write gets no seen note (its example note is enough)', async () => {
    seed()
    for (const m of t('nivaro_tracker_link_members')) m.joined_at = new Date()
    await onRecurrence(5, 'recurred')
    expect(queued.rows).toHaveLength(0)
  })

  it('recurrence on closed link reopens by default', async () => {
    seed({ remote_state: 'closed' })
    t('nivaro_issues').push({ id: 8, status: 'open', fingerprint: 'fp1', source: 'server' })
    await onRecurrence(8, 'raised')
    expect(joins.calls).toEqual([[8, 1, { link_id: 9 }, 'fingerprint']])
    expect(ops('state')).toHaveLength(1)
    expect(ops('state')[0].payload).toMatchObject({ iid: 42, state: 'reopen' })
    // a member recurring on a closed link reopens it too (same minute key: no duplicate)
    await onRecurrence(5, 'recurred')
    expect(ops('state')).toHaveLength(1)
  })

  it('recur_when_closed new leaves the closed link to the rules (no join, no reopen)', async () => {
    seed({ remote_state: 'closed' })
    setConnection({ recur_when_closed: 'new' })
    t('nivaro_issues').push({ id: 8, status: 'open', fingerprint: 'fp1', source: 'server' })
    await onRecurrence(8, 'raised')
    expect(joins.calls).toHaveLength(0)
    expect(queued.rows).toHaveLength(0)
  })

  it('reopen_on_recur off joins but does not reopen', async () => {
    seed({ remote_state: 'closed' })
    setConnection({ reopen_on_recur: false })
    t('nivaro_issues').push({ id: 8, status: 'open', fingerprint: 'fp1', source: 'server' })
    await onRecurrence(8, 'raised')
    expect(joins.calls).toHaveLength(1)
    expect(ops('state')).toHaveLength(0)
  })

  it('a new row on an open link joins as an example; one the engine already joined is left', async () => {
    seed()
    t('nivaro_issues').push({ id: 8, status: 'open', fingerprint: 'fp1', source: 'server' })
    await onRecurrence(8, 'raised')
    expect(joins.calls).toHaveLength(1)
    await onRecurrence(8, 'raised') // now a member: nothing more
    expect(joins.calls).toHaveLength(1)
    expect(queued.rows).toHaveLength(0)
  })

  it('a queued create, no fingerprint match, tracker issues and the switch off do nothing', async () => {
    seed()
    t('nivaro_issues').push(
      { id: 8, status: 'open', fingerprint: 'fp1', source: 'server' },
      { id: 10, status: 'open', fingerprint: 'other', source: 'server' },
      { id: 11, status: 'open', fingerprint: 'fp1', source: 'tracker' }
    )
    t('nivaro_tracker_outbox').push({
      id: 1,
      connection: 1,
      op: 'create',
      source_id: '8',
      status: 'pending'
    })
    await onRecurrence(8, 'raised')
    await onRecurrence(10, 'raised')
    await onRecurrence(11, 'raised')
    feature.on = false
    await onRecurrence(5, 'recurred')
    expect(joins.calls).toHaveLength(0)
    expect(queued.rows).toHaveLength(0)
  })
})
