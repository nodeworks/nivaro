import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── In-memory stand-in for the few tables this module reads and writes ─────────
type Row = Record<string, any>
const tables: Record<string, Row[]> = {}
const ids: Record<string, number> = {}
const UNIQUE: Record<string, string[]> = {
  nivaro_tracker_outbox: ['idempotency_key'],
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
const OPS: Record<string, (a: any, b: any) => boolean> = {
  '=': (a, b) => cmp(a, b) === 0,
  '<': (a, b) => a != null && cmp(a, b) < 0,
  '<=': (a, b) => a != null && cmp(a, b) <= 0,
  '>': (a, b) => a != null && cmp(a, b) > 0,
  '>=': (a, b) => a != null && cmp(a, b) >= 0
}

function builder(name: string) {
  const preds: Array<(r: Row) => boolean> = []
  let order: [string, string] | null = null
  let lim: number | null = null
  let counting = false
  const rows = () => {
    let out = t(name).filter((r) => preds.every((p) => p(r)))
    if (order) {
      const [col, dir] = order
      out = [...out].sort((a, b) => cmp(a[col], b[col]) * (dir === 'desc' ? -1 : 1))
    }
    if (lim != null) out = out.slice(0, lim)
    return out
  }
  const b: any = {}
  b.where = (a: any, op?: any, v?: any) => {
    if (typeof a === 'function') {
      // a grouped (… OR …) clause: where(obj) / orWhereNull(col)
      const ors: Array<(r: Row) => boolean> = []
      const g: any = {
        where: (o: Row) => {
          ors.push((r) => Object.entries(o).every(([k, val]) => r[k] === val))
          return g
        },
        orWhereNull: (col: string) => {
          ors.push((r) => r[col] == null)
          return g
        }
      }
      a(g)
      preds.push((r) => ors.some((f) => f(r)))
      return b
    }
    if (typeof a === 'object') {
      for (const [k, val] of Object.entries(a)) preds.push((r) => cmp(r[k], val) === 0)
    } else if (v === undefined) preds.push((r) => cmp(r[a], op) === 0)
    else preds.push((r) => OPS[op](r[a], v))
    return b
  }
  b.whereIn = (col: string, list: any[]) => {
    preds.push((r) => list.some((x) => cmp(r[col], x) === 0))
    return b
  }
  b.whereNot = (a: Row) => {
    for (const [k, val] of Object.entries(a)) preds.push((r) => cmp(r[k], val) !== 0)
    return b
  }
  b.orderBy = (col: string, dir = 'asc') => {
    order = [col, dir]
    return b
  }
  b.limit = (n: number) => {
    lim = n
    return b
  }
  b.select = () => b
  b.as = () => b
  b.count = () => {
    counting = true
    return b
  }
  b.first = async () => (counting ? { n: rows().length } : rows()[0] ? { ...rows()[0] } : undefined)
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
  b.del = b.delete
  b.insert = (row: Row) => {
    const doIt = () => {
      const keys = UNIQUE[name]
      if (keys && t(name).some((r) => keys.every((k) => cmp(r[k], row[k]) === 0)))
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

vi.mock('../../db/index.js', () => {
  const db: any = (name: string) => builder(name)
  // linkViews' capped member read: FROM (<members> + ROW_NUMBER) WHERE __rn <= cap — the fake
  // returns the inner rows (a test link never reaches the cap)
  db.from = (sub: any) => {
    const w: any = {
      where: () => w,
      select: () => w,
      // biome-ignore lint/suspicious/noThenProperty: awaitable like a knex builder
      then: (res: any, rej: any) => sub.then(res, rej)
    }
    return w
  }
  // The claim statement: UPDATE TOP (n) … SET status='sending', next_attempt_at=<lease> OUTPUT
  // inserted.* WHERE status='pending' AND next_attempt_at <= <now>
  db.raw = (sql: string, bindings: any[]) => {
    // a select expression (linkViews' ROW_NUMBER / COUNT OVER): a marker, never run
    if (/ OVER \(/.test(sql)) return { __raw: sql }
    return claimRaw(sql, bindings)
  }
  const claimRaw = async (sql: string, bindings: any[]) => {
    if (!/UPDATE TOP/.test(sql)) throw new Error(`unexpected raw: ${sql}`)
    const n = Number(/TOP \((\d+)\)/.exec(sql)?.[1])
    const [lease, now] = bindings
    const hit = t('nivaro_tracker_outbox')
      .filter((r) => r.status === 'pending' && cmp(r.next_attempt_at, now) <= 0)
      .sort((a, b) => a.id - b.id)
      .slice(0, n)
    for (const r of hit) Object.assign(r, { status: 'sending', next_attempt_at: lease })
    return hit.map((r) => ({ ...r }))
  }
  return { db }
})
const feature = vi.hoisted(() => ({ on: true }))
vi.mock('./feature.js', () => ({ trackersEnabled: async () => feature.on }))
vi.mock('../../db/dialect.js', () => ({ isMssql: () => true }))

const provider = {
  createIssue: vi.fn<(...args: any[]) => any>(),
  findIssueByMarker: vi.fn<(...args: any[]) => any>(),
  getIssue: vi.fn<(...args: any[]) => any>(),
  project: vi.fn<(...args: any[]) => any>(),
  upload: vi.fn<(...args: any[]) => any>(),
  addNote: vi.fn<(...args: any[]) => any>(),
  setState: vi.fn<(...args: any[]) => any>(),
  setLabels: vi.fn<(...args: any[]) => any>(),
  searchUsers: vi.fn<(...args: any[]) => any>()
}
const connSync = vi.hoisted(() => ({ value: undefined as unknown }))
const markBroken = vi.fn<(...args: any[]) => any>(async () => {})
const markOk = vi.fn<(...args: any[]) => any>(async () => {})
const connActive = vi.hoisted(() => ({ value: true }))
vi.mock('./connections.js', () => ({
  providerFor: async () => provider,
  getConnection: async (id: number) =>
    id === 1
      ? {
          id: 1,
          name: 'GL',
          base_url: 'https://git.x',
          default_project_id: 7,
          default_project_path: 'g/p',
          status: 'ok',
          is_active: connActive.value,
          sync: connSync.value
        }
      : null,
  markBroken: (...a: any[]) => markBroken(...a),
  markOk: (...a: any[]) => markOk(...a)
}))
const noteIssueWrite = vi.fn<(...args: any[]) => any>()
vi.mock('../issue-raise.js', () => ({
  noteIssueWrite: (...a: any[]) => noteIssueWrite(...a),
  hitCounts: async () => ({ hits: 4, people: 2 }),
  hitKey: (i: { id: number; fingerprint?: string | null }) => i.fingerprint ?? `issue:${i.id}`
}))
vi.mock('../app-links.js', () => ({
  linkTo: async () => 'https://nivaro.test/issues'
}))

import { requestedPool } from '../../db/pool-context.js'
import { markerIsLastLine } from './gitlab.js'
import { bulkCreate, LinkError, linkExisting, moveToNew, requestCreate, unlink } from './links.js'
import {
  backoffMs,
  enqueue,
  listOutbox,
  processOutbox,
  pruneOutbox,
  setAutoSend
} from './outbox.js'
import { TrackerError } from './types.js'

const remote = (iid = 12) => ({
  id: 900 + iid,
  iid,
  project_id: 7,
  web_url: `https://git.x/g/p/-/issues/${iid}`,
  title: '[error] Boom',
  state: 'opened',
  labels: ['bug'],
  assignees: [{ id: 3, username: 'ann', name: 'Ann' }],
  milestone: null,
  updated_at: '2026-11-17T12:00:00Z',
  description: '... <!-- nivaro:issue:5 -->'
})

const outbox = () => t('nivaro_tracker_outbox')
const past = () => new Date(Date.now() - 1000)

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k]
  for (const k of Object.keys(ids)) delete ids[k]
  vi.resetAllMocks()
  setAutoSend(false)
  feature.on = true
  connSync.value = undefined
  connActive.value = true
  t('nivaro_issues').push({
    id: 5,
    title: 'Boom',
    severity: 'error',
    status: 'open',
    source: 'server',
    details: 'Error: boom\n  at x',
    fingerprint: 'fp5',
    occurrence_count: 3,
    created_at: new Date('2026-11-16T10:00:00Z'),
    last_seen_at: new Date('2026-11-17T10:00:00Z'),
    screenshot: null
  })
  ids.nivaro_issues = 5
})

describe('tracker outbox', () => {
  it('retries a timed-out create without a duplicate', async () => {
    const { outboxId } = await requestCreate(5, { connection: 1, via: 'manual', userId: 'u1' })
    const row = outbox().find((r) => r.id === outboxId)
    expect(row?.idempotency_key).toBe('create:1:5')
    expect(JSON.parse(row?.payload).input.description).toContain('<!-- nivaro:issue:5 -->')

    // GitLab created the issue, but the answer never arrived.
    provider.findIssueByMarker.mockResolvedValueOnce(null)
    provider.createIssue.mockRejectedValueOnce(new TrackerError('timed out', null, 'network'))
    expect(await processOutbox()).toEqual({ sent: 0, failed: 1, dead: 0 })
    expect(row?.status).toBe('pending')
    expect(row?.attempts).toBe(1)
    expect(row?.next_attempt_at.getTime()).toBeGreaterThan(Date.now() + 25_000)

    // The retry finds it by its marker and links it — no second create.
    provider.findIssueByMarker.mockResolvedValueOnce(remote())
    row!.next_attempt_at = past()
    expect(await processOutbox()).toEqual({ sent: 1, failed: 0, dead: 0 })
    expect(provider.createIssue).toHaveBeenCalledTimes(1)
    expect(provider.findIssueByMarker).toHaveBeenLastCalledWith(7, '<!-- nivaro:issue:5 -->')
    const links = t('nivaro_tracker_links')
    expect(links).toHaveLength(1)
    expect(links[0]).toMatchObject({
      connection: 1,
      project_id: 7,
      project_path: 'g/p',
      external_iid: 12,
      created_via: 'manual',
      fingerprint: 'fp5',
      remote_state: 'opened'
    })
    expect(t('nivaro_tracker_link_members')).toEqual([
      expect.objectContaining({ link: links[0].id, source_id: '5', joined_via: 'lead' })
    ])
    expect(row).toMatchObject({ status: 'done', link: links[0].id })
  })

  it('401 marks connection broken and holds outbox', async () => {
    await requestCreate(5, { connection: 1, via: 'manual' })
    provider.findIssueByMarker.mockRejectedValueOnce(
      new TrackerError('401 Unauthorized', 401, 'auth')
    )
    expect(await processOutbox()).toEqual({ sent: 0, failed: 1, dead: 0 })
    expect(markBroken).toHaveBeenCalledWith(1, '401 Unauthorized')
    const row = outbox()[0]
    expect(row.status).toBe('pending')
    expect(row.attempts).toBe(0)
    expect(row.next_attempt_at.getTime()).toBeGreaterThan(Date.now() + 59 * 60_000)
    expect(provider.createIssue).not.toHaveBeenCalled()
  })

  // final review: a paused connection never sends
  it('a paused connection refuses new creates and holds queued rows without spending an attempt', async () => {
    await requestCreate(5, { connection: 1, via: 'manual' })
    connActive.value = false
    expect(await processOutbox()).toEqual({ sent: 0, failed: 0, dead: 0 })
    const row = outbox()[0]
    expect(row.status).toBe('pending')
    expect(row.attempts ?? 0).toBe(0)
    expect(new Date(row.next_attempt_at).getTime()).toBeGreaterThan(Date.now() + 60_000)
    expect(provider.createIssue).not.toHaveBeenCalled()
    t('nivaro_issues').push({
      id: 6,
      title: 'Other',
      severity: 'high',
      status: 'open',
      source: 'server'
    })
    await expect(requestCreate(6, { connection: 1, via: 'manual' })).rejects.toMatchObject({
      status: 409,
      code: 'CONNECTION_PAUSED'
    })
  })

  it('prunes sent rows after 90 days but keeps creates (their idempotency keys)', async () => {
    const now = new Date('2026-11-17T04:15:00Z')
    const old = new Date(now.getTime() - 91 * 86_400_000)
    const recent = new Date(now.getTime() - 10 * 86_400_000)
    const add = (row: Row) => {
      ids.nivaro_tracker_outbox = (ids.nivaro_tracker_outbox ?? 0) + 1
      t('nivaro_tracker_outbox').push({ id: ids.nivaro_tracker_outbox, connection: 1, ...row })
    }
    add({ op: 'comment', status: 'done', done_at: old })
    add({ op: 'create', status: 'done', done_at: old })
    add({ op: 'labels', status: 'done', done_at: recent })
    add({ op: 'state', status: 'dead', done_at: null, created_at: old })
    expect(await pruneOutbox(now)).toBe(1)
    expect(outbox().map((r) => r.op)).toEqual(['create', 'labels', 'state'])
  })

  // UI contract: one source's rows, without scanning the newest 200
  it('lists the outbox rows of one source', async () => {
    const add = (row: Row) => {
      ids.nivaro_tracker_outbox = (ids.nivaro_tracker_outbox ?? 0) + 1
      t('nivaro_tracker_outbox').push({
        id: ids.nivaro_tracker_outbox,
        connection: 1,
        op: 'create',
        status: 'dead',
        attempts: 10,
        ...row
      })
    }
    add({ source_kind: 'ticket', source_id: '55' })
    add({ source_kind: 'ticket', source_id: '56' })
    add({ source_kind: 'record', source_id: 'orders:55' })
    add({ source_kind: null, source_id: '55' }) // an older issue row
    add({ source_kind: 'issue', source_id: '55' })
    const of = async (kind: string, id: string) =>
      (await listOutbox({ source_kind: kind, source_id: id })).map((r) => r.id)
    expect(await of('ticket', '55')).toEqual([1])
    expect(await of('record', 'orders:55')).toEqual([3])
    expect(await of('issue', '55')).toEqual([5, 4])
    expect((await listOutbox({ status: 'dead' })).length).toBe(5)
  })

  it('422 goes dead immediately with reason', async () => {
    await requestCreate(5, { connection: 1, via: 'manual' })
    provider.findIssueByMarker.mockResolvedValue(null)
    provider.createIssue.mockRejectedValueOnce(
      new TrackerError('title is too long', 422, 'invalid')
    )
    expect(await processOutbox()).toEqual({ sent: 0, failed: 0, dead: 1 })
    const row = outbox()[0]
    expect(row.status).toBe('dead')
    expect(row.last_error).toContain('title is too long')
    // one warning issue per connection per day, through the funnel
    const day = new Date().toISOString().slice(0, 10)
    const warn = t('nivaro_issues').filter((r) => r.fingerprint === `tracker-dead:1:${day}`)
    expect(warn).toHaveLength(1)
    expect(warn[0]).toMatchObject({
      title: 'GitLab sync: a change could not be sent',
      severity: 'warning',
      status: 'open',
      source: 'tracker'
    })
    expect(noteIssueWrite).toHaveBeenCalledWith(warn[0].id, 'raised', {
      fingerprint: `tracker-dead:1:${day}`
    })
    // a second dead row the same day raises nothing new
    await enqueue({
      connection: 1,
      source_id: '5',
      op: 'comment',
      payload: { project_id: 7, iid: 1, body: 'x' },
      key: 'comment:1:9'
    })
    provider.addNote.mockRejectedValueOnce(new TrackerError('gone', 404, 'not_found'))
    expect(await processOutbox()).toEqual({ sent: 0, failed: 0, dead: 1 })
    expect(t('nivaro_issues').filter((r) => r.source === 'tracker')).toHaveLength(1)
  })

  it('10th failure goes dead', async () => {
    const id = await enqueue({
      connection: 1,
      source_id: '5',
      op: 'state',
      payload: { project_id: 7, iid: 3, state: 'close' },
      key: 'state:1:3:close'
    })
    const row = outbox().find((r) => r.id === id)!
    row.attempts = 9
    provider.setState.mockRejectedValueOnce(new TrackerError('502 Bad Gateway', 502, 'server'))
    expect(await processOutbox()).toEqual({ sent: 0, failed: 0, dead: 1 })
    expect(row).toMatchObject({ status: 'dead', attempts: 10 })
  })

  it('backoffMs(0)=30000, (7)=3600000', () => {
    expect(backoffMs(0)).toBe(30_000)
    expect(backoffMs(1)).toBe(60_000)
    expect(backoffMs(7)).toBe(3_600_000)
    expect(backoffMs(20)).toBe(3_600_000)
  })

  it('bulk over 50 refused', async () => {
    const many = Array.from({ length: 51 }, (_, i) => i + 1)
    await expect(bulkCreate(many, { connection: 1 })).rejects.toMatchObject({
      status: 400,
      code: 'TOO_MANY'
    })
    expect(outbox()).toHaveLength(0)
  })

  it('bulk answers per issue and whether it would pass the connection cap', async () => {
    const res = await bulkCreate([5, 404], { connection: 1, userId: 'u1' })
    expect(res.would_pass_cap).toBe(false)
    expect(res.results).toEqual([
      expect.objectContaining({ issue: 5, ok: true }),
      expect.objectContaining({ issue: 404, ok: false, code: 'NOT_FOUND' })
    ])
    for (let i = 0; i < 29; i++)
      t('nivaro_tracker_links').push({ id: 100 + i, connection: 1, created_at: new Date() })
    expect((await bulkCreate([5], { connection: 1, dry_run: true })).would_pass_cap).toBe(false)
    expect((await bulkCreate([5, 6], { connection: 1, dry_run: true })).would_pass_cap).toBe(true)
  })

  it('enqueue twice with same key returns same id', async () => {
    const row = {
      connection: 1,
      source_id: '5',
      op: 'comment' as const,
      payload: { project_id: 7, iid: 1, body: 'hi' },
      key: 'comment:1:42'
    }
    const a = await enqueue(row)
    const b = await enqueue(row)
    expect(a).toBe(b)
    expect(outbox()).toHaveLength(1)
  })

  it('enqueue with notBefore stores the row due then and makes no immediate attempt', async () => {
    setAutoSend(true)
    const later = new Date(Date.now() + 30 * 60_000)
    await enqueue(
      {
        connection: 1,
        source_id: '5',
        op: 'comment',
        payload: { project_id: 7, iid: 1, body: 'later' },
        key: 'comment:1:later'
      },
      { notBefore: later }
    )
    expect(outbox()[0]).toMatchObject({ status: 'pending', next_attempt_at: later })
    await new Promise((r) => setTimeout(r, 20))
    expect(provider.addNote).not.toHaveBeenCalled()
    expect(await processOutbox()).toEqual({ sent: 0, failed: 0, dead: 0 })
    expect(outbox()[0].status).toBe('pending')
  })

  it('requestCreate refuses an issue already linked on that connection', async () => {
    t('nivaro_tracker_link_members').push({
      id: 1,
      link: 1,
      connection: 1,
      source_kind: 'issue',
      source_id: '5',
      joined_via: 'lead'
    })
    await expect(requestCreate(5, { connection: 1, via: 'manual' })).rejects.toMatchObject({
      status: 409,
      code: 'ALREADY_LINKED'
    })
  })

  it('linkExisting refuses a link that is not a GitLab issue URL', async () => {
    const err = await linkExisting(5, 1, 'https://git.x/g/p/-/merge_requests/3', 'u1').catch(
      (e) => e
    )
    expect(err).toBeInstanceOf(LinkError)
    expect(err).toMatchObject({ status: 400, code: 'BAD_ISSUE_URL' })
  })

  it('linkExisting links the GitLab issue, and joins an existing link', async () => {
    provider.project.mockResolvedValue({ id: 7, path_with_namespace: 'g/p', access_level: 30 })
    provider.getIssue.mockResolvedValue(remote(12))
    const view = await linkExisting(5, 1, 'https://git.x/g/p/-/issues/12', 'u1')
    expect(view).toMatchObject({
      iid: 12,
      project_path: 'g/p',
      created_via: 'linked',
      labels: ['bug'],
      assignees: ['ann'],
      members: [5]
    })
    t('nivaro_issues').push({ id: 6, title: 'Boom again', fingerprint: 'fp5' })
    const joined = await linkExisting(6, 1, 'https://git.x/g/p/-/issues/12', 'u1')
    expect(joined.id).toBe(view.id)
    expect(joined.members.sort()).toEqual([5, 6])
    expect(t('nivaro_tracker_links')).toHaveLength(1)
  })

  it('returns a stale sending row to pending and sends it', async () => {
    const id = await enqueue({
      connection: 1,
      source_id: '5',
      op: 'comment',
      payload: { project_id: 7, iid: 1, body: 'hello' },
      key: 'comment:1:7'
    })
    const row = outbox().find((r) => r.id === id)!
    row.status = 'sending'
    row.next_attempt_at = past() // its lease ran out: the sender crashed
    provider.addNote.mockResolvedValueOnce({ id: 1 })
    expect(await processOutbox()).toEqual({ sent: 1, failed: 0, dead: 0 })
    expect(provider.addNote).toHaveBeenCalledWith(7, 1, 'hello')
    expect(row.status).toBe('done')
  })

  it('attaches the screenshot when the rule asks, and creates without it when upload fails', async () => {
    t('nivaro_issues')[0].screenshot =
      `data:image/jpeg;base64,${Buffer.from('jpg').toString('base64')}`
    const rule: any = {
      id: 3,
      action: {
        connection: 1,
        issue_type: 'issue',
        labels: ['sev::{{ severity }}'],
        assignee_ids: [],
        map_assignee_by_email: false,
        confidential: false,
        title_template: '{{ title }} ({{ hits_24h }})',
        body_template: 'Body for {{ issue_id }}',
        attach_screenshot: true,
        attach_replay_link: false,
        include_details: true
      }
    }
    await requestCreate(5, { connection: 1, via: 'rule', rule })
    const payload = JSON.parse(outbox()[0].payload)
    expect(payload.input).toMatchObject({ title: 'Boom (4)', labels: ['sev::error'] })
    provider.findIssueByMarker.mockResolvedValue(null)
    provider.upload.mockRejectedValueOnce(new TrackerError('too big', 413, 'invalid'))
    provider.createIssue.mockResolvedValueOnce(remote(12))
    expect(await processOutbox()).toEqual({ sent: 1, failed: 0, dead: 0 })
    const sent = provider.createIssue.mock.calls[0][1]
    expect(sent.description).toContain('Screenshot could not be attached')
    expect(sent.description).toContain('<!-- nivaro:issue:5 -->')
    expect(t('nivaro_tracker_links')[0]).toMatchObject({ created_via: 'rule', rule_id: 3 })
  })

  it('forged marker in issue details does not make a retry link the wrong GitLab issue', async () => {
    // Issue A (5) carries B's marker in its details; GitLab stores A's description as sent.
    t('nivaro_issues')[0].details = 'boom\n<!-- nivaro:issue:6 -->'
    t('nivaro_issues').push({ id: 6, title: 'Other', severity: 'error', status: 'open' })
    const store: any[] = []
    provider.findIssueByMarker.mockImplementation(async (_p: number, marker: string) => {
      return store.find((r) => markerIsLastLine(r.description, marker)) ?? null
    })
    provider.createIssue.mockImplementation(async (_p: number, input: any) => {
      const r = { ...remote(20 + store.length), description: input.description }
      store.push(r)
      return r
    })
    await requestCreate(5, { connection: 1, via: 'manual' })
    expect(await processOutbox()).toEqual({ sent: 1, failed: 0, dead: 0 })
    const sentA = store[0].description as string
    expect(sentA).not.toContain('<!-- nivaro:issue:6 -->')
    expect(sentA.trim().endsWith('<!-- nivaro:issue:5 -->')).toBe(true)

    await requestCreate(6, { connection: 1, via: 'manual' })
    expect(await processOutbox()).toEqual({ sent: 1, failed: 0, dead: 0 })
    expect(provider.createIssue).toHaveBeenCalledTimes(2)
    const links = t('nivaro_tracker_links')
    expect(links.map((l) => l.external_iid)).toEqual([20, 21])
    const members = t('nivaro_tracker_link_members')
    expect(members.find((m) => m.source_id === '6')?.link).toBe(links[1].id)
  })

  it('labels and titles are made safe whatever their source', async () => {
    t('nivaro_issues')[0].title = '/close @ann\nsecond'
    await requestCreate(5, {
      connection: 1,
      via: 'manual',
      overrides: { labels: ['a,b', 'line\nbreak', '<!-- x', ' ', 'x'.repeat(300)] }
    })
    const input = JSON.parse(outbox()[0].payload).input
    expect(input.labels).toEqual(['a b', 'line break', 'x', 'x'.repeat(255)])
    expect(input.title).not.toMatch(/^\//)
    expect(input.title).not.toMatch(/[\r\n]/)
    expect(input.title).not.toContain('@ann')
  })

  it('create labels = connection, severity, source, priority, lane, rule and manual labels', async () => {
    connSync.value = {
      labels: {
        always: ['nivaro'],
        by_severity: { high: ['sev::high'] },
        by_source: { server: ['backend'] },
        on_example: []
      },
      priority_map: { high: 'priority::2' },
      lane_map: { open: 'workflow::to do' }
    }
    const rule: any = {
      id: 3,
      action: {
        connection: 1,
        issue_type: 'issue',
        labels: ['Backend', 'rule-{{ source }}'],
        assignee_ids: [],
        map_assignee_by_email: false,
        confidential: false,
        title_template: '{{ title }}',
        body_template: 'b',
        attach_screenshot: false,
        attach_replay_link: false,
        include_details: true
      }
    }
    await requestCreate(5, {
      connection: 1,
      via: 'rule',
      rule,
      overrides: { labels: ['manual', 'NIVARO'] }
    })
    expect(JSON.parse(outbox()[0].payload).input.labels).toEqual([
      'nivaro',
      'sev::high',
      'backend',
      'priority::2',
      'workflow::to do',
      'rule-server',
      'manual'
    ])
  })

  it('move to new opens a new GitLab issue, not the old one', async () => {
    // GitLab holds the old issue (gen 1 marker) and whatever new ones get created.
    const store: any[] = []
    provider.findIssueByMarker.mockImplementation(async (_p: number, marker: string) => {
      return store.find((r) => markerIsLastLine(r.description, marker)) ?? null
    })
    provider.createIssue.mockImplementation(async (_p: number, input: any) => {
      const r = { ...remote(20 + store.length), description: input.description }
      store.push(r)
      return r
    })
    await requestCreate(5, { connection: 1, via: 'manual', userId: 'u1' })
    expect(await processOutbox()).toEqual({ sent: 1, failed: 0, dead: 0 })
    const [oldLink] = t('nivaro_tracker_links')
    expect(oldLink.external_iid).toBe(20)

    const moved = await moveToNew(5, 1, 'u1')
    expect(moved.generation).toBe(2)
    const row = outbox().find((r) => r.id === moved.outboxId)
    expect(row?.idempotency_key).toBe('create:1:5:2')
    expect(await processOutbox()).toEqual({ sent: 1, failed: 0, dead: 0 })
    expect(provider.createIssue).toHaveBeenCalledTimes(2)
    expect(provider.findIssueByMarker).toHaveBeenLastCalledWith(7, '<!-- nivaro:issue:5:2 -->')
    expect(store[1].description.trim().endsWith('<!-- nivaro:issue:5:2 -->')).toBe(true)
    // the old link (no members left) is gone; the issue sits on the new GitLab issue
    const links = t('nivaro_tracker_links')
    expect(links.map((l) => l.external_iid)).toEqual([21])
    expect(t('nivaro_tracker_link_members')).toEqual([
      expect.objectContaining({ link: links[0].id, source_id: '5', joined_via: 'lead' })
    ])

    // a third generation after another move
    const again = await moveToNew(5, 1, 'u1')
    expect(again.generation).toBe(3)
    expect(await processOutbox()).toEqual({ sent: 1, failed: 0, dead: 0 })
    expect(t('nivaro_tracker_links').map((l) => l.external_iid)).toEqual([22])
  })

  it('unlink on one connection leaves the other connections alone', async () => {
    for (const [id, c] of [
      [1, 1],
      [2, 2]
    ]) {
      t('nivaro_tracker_links').push({ id, connection: c, project_id: 7, external_iid: id })
      t('nivaro_tracker_link_members').push({
        id,
        link: id,
        connection: c,
        source_kind: 'issue',
        source_id: '5',
        joined_via: 'lead'
      })
    }
    await unlink(5, 1)
    expect(t('nivaro_tracker_links').map((l) => l.id)).toEqual([2])
    expect(t('nivaro_tracker_link_members').map((m) => m.link)).toEqual([2])
  })

  it('unlink, then create again: a new generation, never the old GitLab issue by its marker', async () => {
    const first = await requestCreate(5, { connection: 1, via: 'manual' })
    provider.findIssueByMarker.mockResolvedValueOnce(null)
    provider.createIssue.mockResolvedValueOnce(remote())
    expect(await processOutbox()).toEqual({ sent: 1, failed: 0, dead: 0 })
    await unlink(5, 1)
    const again = await requestCreate(5, { connection: 1, via: 'manual' })
    expect(again.outboxId).not.toBe(first.outboxId)
    const row = outbox().find((r) => r.id === again.outboxId)
    expect(row?.idempotency_key).toBe('create:1:5:2')
    expect(JSON.parse(row?.payload).generation).toBe(2)
    // the first create stays done
    expect(outbox().find((r) => r.id === first.outboxId)?.status).toBe('done')
  })

  it('a labels change is sent with setLabels and mirrored on the link', async () => {
    t('nivaro_tracker_links').push({ id: 9, connection: 1, project_id: 7, external_iid: 3 })
    await enqueue({
      connection: 1,
      link: 9,
      source_id: '5',
      op: 'labels',
      payload: { add_labels: ['workflow::doing'], remove_labels: ['workflow::to do'] },
      key: 'labels:1:9:x'
    })
    provider.setLabels.mockResolvedValueOnce({ ...remote(3), labels: ['bug', 'workflow::doing'] })
    expect(await processOutbox()).toEqual({ sent: 1, failed: 0, dead: 0 })
    expect(provider.setLabels).toHaveBeenCalledWith(7, 3, ['workflow::doing'], ['workflow::to do'])
    expect(JSON.parse(t('nivaro_tracker_links')[0].remote_labels)).toEqual([
      'bug',
      'workflow::doing'
    ])
  })

  it('joining an existing link through a pasted URL queues one example note', async () => {
    provider.project.mockResolvedValue({ id: 7, path_with_namespace: 'g/p', access_level: 30 })
    provider.getIssue.mockResolvedValue(remote(12))
    await linkExisting(5, 1, 'https://git.x/g/p/-/issues/12', 'u1')
    expect(outbox()).toHaveLength(0) // the first issue on a link is its lead, not an example
    t('nivaro_issues').push({ id: 6, title: 'Boom again', fingerprint: 'fp5' })
    const view = await linkExisting(6, 1, 'https://git.x/g/p/-/issues/12', 'u1')
    expect(outbox().map((r) => r.idempotency_key)).toEqual([`example:${view.id}:6`])
  })

  it('the immediate send after enqueue runs on the background pool', async () => {
    setAutoSend(true)
    let pool = ''
    provider.addNote.mockImplementation(async () => {
      pool = requestedPool()
      return { id: 1 }
    })
    await enqueue({
      connection: 1,
      source_id: '5',
      op: 'comment',
      payload: { project_id: 7, iid: 1, body: 'x' },
      key: 'comment:1:pool'
    })
    await vi.waitFor(() => expect(outbox()[0].status).toBe('done'))
    expect(pool).toBe('background')
  })
})

describe('master switch', () => {
  it('processOutbox does nothing when off', async () => {
    outbox().push({
      id: 1,
      connection: 1,
      source_kind: 'issue',
      source_id: '5',
      op: 'comment',
      payload: '{}',
      idempotency_key: 'k',
      status: 'pending',
      attempts: 0,
      next_attempt_at: past()
    })
    feature.on = false
    expect(await processOutbox()).toEqual({ sent: 0, failed: 0, dead: 0 })
    expect(outbox()[0].status).toBe('pending')
  })
})
