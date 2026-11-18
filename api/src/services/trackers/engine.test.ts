import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── In-memory stand-in for the tables the engine reads and writes ────────────────
type Row = Record<string, any>
const tables: Record<string, Row[]> = {}
const ids: Record<string, number> = {}
const t = (name: string) => {
  tables[name] ??= []
  return tables[name]
}
const val = (x: any) => (x instanceof Date ? x.getTime() : x)
const cmp = (a: any, b: any) => {
  const x = val(a)
  const y = val(b)
  return x < y ? -1 : x > y ? 1 : 0
}
const OPS: Record<string, (a: any, b: any) => boolean> = {
  '=': (a, b) => cmp(a, b) === 0,
  '<>': (a, b) => cmp(a, b) !== 0,
  '<': (a, b) => a != null && cmp(a, b) < 0,
  '<=': (a, b) => a != null && cmp(a, b) <= 0,
  '>': (a, b) => a != null && cmp(a, b) > 0,
  '>=': (a, b) => a != null && cmp(a, b) >= 0
}
type Pred = (r: Row) => boolean
function predOf(a: any, op?: any, v?: any): Pred {
  if (typeof a === 'object') {
    const entries = Object.entries(a)
    return (r) => entries.every(([k, x]) => cmp(r[k], x) === 0)
  }
  if (v === undefined) return (r) => cmp(r[a], op) === 0
  return (r) => OPS[op](r[a], v)
}
/** where(fn): a group of where / orWhere clauses folded left. */
function groupOf(fn: (q: any) => void): Pred {
  const clauses: Array<{ or: boolean; p: Pred }> = []
  const q: any = {
    where: (a: any, op?: any, v?: any) => {
      clauses.push({ or: false, p: predOf(a, op, v) })
      return q
    },
    orWhere: (a: any, op?: any, v?: any) => {
      clauses.push({ or: true, p: predOf(a, op, v) })
      return q
    }
  }
  fn(q)
  return (r) =>
    clauses.reduce<boolean | null>(
      (acc, c) => (acc === null ? c.p(r) : c.or ? acc || c.p(r) : acc && c.p(r)),
      null
    ) ?? true
}

function builder(name: string) {
  const preds: Pred[] = []
  const sorts: Array<(a: Row, b: Row) => number> = []
  let lim: number | null = null
  let off = 0
  let counting = false
  let distinctCol: string | null = null
  const rows = () => {
    let out = t(name).filter((r) => preds.every((p) => p(r)))
    if (sorts.length) out = [...out].sort((a, b) => sorts.reduce((n, s) => n || s(a, b), 0))
    out = out.slice(off)
    if (lim != null) out = out.slice(0, lim)
    return out
  }
  const b: any = {}
  b.where = (a: any, op?: any, v?: any) => {
    preds.push(typeof a === 'function' ? groupOf(a) : predOf(a, op, v))
    return b
  }
  b.whereIn = (col: string, list: any[]) => {
    preds.push((r) => list.some((x) => cmp(r[col], x) === 0))
    return b
  }
  b.whereNot = (a: Row) => {
    const p = predOf(a)
    preds.push((r) => !p(r))
    return b
  }
  b.whereNotNull = (col: string) => {
    preds.push((r) => r[col] != null)
    return b
  }
  b.orderBy = (col: string, dir = 'asc') => {
    sorts.push((x, y) => cmp(x[col], y[col]) * (dir === 'desc' ? -1 : 1))
    return b
  }
  b.orderByRaw = (_sql: string) => {
    const touched = (r: Row) => Math.max(val(r.updated_at) ?? 0, val(r.last_seen_at) ?? 0)
    sorts.push((x, y) => touched(x) - touched(y))
    return b
  }
  b.limit = (n: number) => {
    lim = n
    return b
  }
  b.offset = (n: number) => {
    off = n
    return b
  }
  b.select = () => b
  b.distinct = (col: string) => {
    distinctCol = col
    return b
  }
  b.count = () => {
    counting = true
    return b
  }
  b.first = async () => (counting ? { n: rows().length } : rows()[0] ? { ...rows()[0] } : undefined)
  b.update = async (patch: Row) => {
    const hit = rows()
    for (const r of hit) {
      for (const [k, v] of Object.entries(patch)) {
        const m = v && typeof v === 'object' && '__raw' in v ? /\+ (\d+)$/.exec(v.__raw) : null
        r[k] = m ? (Number(r[k]) || 0) + Number(m[1]) : v
      }
    }
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
  b.then = (res: any, rej: any) => {
    let out = rows().map((r) => ({ ...r }))
    if (distinctCol) {
      const col = distinctCol
      out = [...new Set(out.map((r) => r[col]))].map((v) => ({ [col]: v }))
    }
    return Promise.resolve(out).then(res, rej)
  }
  return b
}

/** Tables whose next read throws (a failing evaluation). */
const failTables = new Set<string>()

/**
 * The claim statement, emulated: the fake's transactions run one at a time (the per-connection
 * app lock + UPDLOCK/HOLDLOCK in SQL Server), so count-then-insert is atomic here as it is there.
 * Bindings in claimStatement's order.
 */
const claimHook = vi.hoisted(() => ({
  fail: null as string | null,
  locks: [] as unknown[]
}))
function claimRaw(sql: string, b: any[]): Row[] {
  if (/sp_getapplock/.test(sql)) {
    claimHook.locks.push(b[0])
    if (claimHook.fail) throw new Error(claimHook.fail)
    return [{ r: 0 }]
  }
  if (!/^INSERT INTO \[nivaro_tracker_decisions\]/.test(sql))
    throw new Error(`unexpected raw: ${sql}`)
  const [rule, issue, at, detail, conn0, , hourAgo, perHour, , dayAgo, perDay, connection, flow] = b
  const cap = b[15]
  const fired = t('nivaro_tracker_decisions').filter((d) => d.outcome === 'fired')
  const after = (d: Row, since: Date) => cmp(d.at, since) > 0
  const onConn = new Set(
    t('nivaro_tracker_rules')
      .filter((r) => r.connection === connection)
      .map((r) => r.id)
  )
  const counted = (d: Row) => onConn.has(d.rule) || (d.rule === flow && d.connection === connection)
  const ok =
    fired.filter((d) => d.rule === rule && after(d, hourAgo)).length < perHour &&
    fired.filter((d) => d.rule === rule && after(d, dayAgo)).length < perDay &&
    fired.filter((d) => counted(d) && after(d, hourAgo)).length < cap
  if (!ok) return []
  ids.nivaro_tracker_decisions = (ids.nivaro_tracker_decisions ?? 0) + 1
  const id = ids.nivaro_tracker_decisions
  t('nivaro_tracker_decisions').push({
    id,
    rule,
    issue,
    at,
    outcome: 'fired',
    detail,
    connection: conn0
  })
  return [{ id }]
}

vi.mock('../../db/index.js', () => {
  const make = (name: string) => {
    if (failTables.has(name)) throw new Error(`${name} is unreadable`)
    return builder(name)
  }
  const db: any = make
  db.raw = (sql: string) => ({ __raw: sql })
  let chain: Promise<unknown> = Promise.resolve()
  db.transaction = (fn: (trx: any) => Promise<unknown>) => {
    const trx: any = (name: string) => make(name)
    trx.raw = async (sql: string, b: any[]) => claimRaw(sql, b)
    const run = chain.then(() => fn(trx))
    chain = run.catch(() => {})
    return run
  }
  return { db }
})
vi.mock('../../db/dialect.js', () => ({ isMssql: () => true }))
vi.mock('../../version.js', () => ({ NIVARO_VERSION: '1.2.3' }))
const feature = vi.hoisted(() => ({ on: true }))
vi.mock('./feature.js', () => ({ trackersEnabled: async () => feature.on }))
const hits = vi.hoisted(() => ({ hits: 0, people: 0 }))
vi.mock('../issue-raise.js', () => ({
  hitCounts: async () => ({ ...hits }),
  hitKey: (i: { id: number; fingerprint?: string | null }) => i.fingerprint ?? `issue:${i.id}`
}))
vi.mock('../issue-groups.js', () => ({ groupSimilarIssues: async () => [] }))
vi.mock('./link-store.js', () => ({
  LINKS: 'nivaro_tracker_links',
  MEMBERS: 'nivaro_tracker_link_members',
  SOURCE_ISSUE: 'issue'
}))
const conn = vi.hoisted(() => ({
  sync: {
    recur_when_closed: 'reopen' as 'reopen' | 'new',
    reopen_on_recur: true,
    push_to_linked: false,
    similar: { enabled: true, join_at: 0.88, suggest_at: 0.78 }
  }
}))
vi.mock('./connections.js', () => ({
  getConnection: async (id: number) =>
    id === 1 || id === 2
      ? { id, name: `GL${id}`, default_project_id: 7, is_active: true, sync: conn.sync }
      : null
}))
const findHome = vi.fn<(...args: any[]) => any>()
const findHomeForSource = vi.fn<(...args: any[]) => any>()
const joinAsExample = vi.fn<(...args: any[]) => any>()
vi.mock('./similar.js', () => ({
  findHome: (...a: any[]) => findHome(...a),
  joinAsExample: (...a: any[]) => joinAsExample(...a),
  findHomeForSource: (...a: any[]) => findHomeForSource(...a),
  joinSourceAsExample: async () => 0
}))
const requestCreate = vi.fn<(...args: any[]) => any>()
const requestSourceCreate = vi.fn<(...args: any[]) => any>()
vi.mock('./links.js', () => ({
  CONNECTION_CAP_PER_HOUR: 30,
  requestCreate: (...a: any[]) => requestCreate(...a),
  requestSourceCreate: (...a: any[]) => requestSourceCreate(...a)
}))
vi.mock('./sources/index.js', () => ({
  sourceFor: () => ({
    load: async (id: string) => ({ kind: 'ticket', id, title: 't', body: null, vars: {} })
  })
}))
const enqueue = vi.fn<(...args: any[]) => any>()
vi.mock('./outbox.js', () => ({
  OUTBOX: 'nivaro_tracker_outbox',
  enqueue: (...a: any[]) => enqueue(...a)
}))

import {
  CLAIM_DETAIL,
  CLAIM_LOCK,
  claimFlowFire,
  claimStatement,
  DECISIONS,
  evaluateIssue,
  evaluateTicket,
  explainIssue,
  FAILURE_LOG_EVERY_MS,
  KEEP_DECISIONS,
  noteEvaluationFailure,
  previewRule,
  RULES,
  resetFailureLog,
  resetHomeMisses,
  resetSweepFailures,
  SWEEP_EXT,
  SWEEP_KEY,
  SWEEP_RULE,
  sweep
} from './engine.js'
import { type TrackerRule, validateRule } from './rules.js'

let nextRule = 0
function addRule(over: Record<string, any> = {}): number {
  const res = validateRule({
    name: `Rule ${nextRule + 1}`,
    enabled: true,
    mode: 'create',
    match: { sources: ['server'] },
    action: { connection: 1 },
    ...over
  })
  if (!res.ok) throw new Error(JSON.stringify(res.errors))
  nextRule++
  ids[RULES] = nextRule
  const r = res.rule
  t(RULES).push({
    id: nextRule,
    name: r.name,
    enabled: r.enabled,
    mode: r.mode,
    sort: over.sort ?? nextRule * 10,
    continue_after: r.continue_after,
    connection: r.action.connection,
    match: JSON.stringify(r.match),
    threshold: JSON.stringify(r.threshold),
    guards: JSON.stringify(r.guards),
    action: JSON.stringify(r.action),
    fired_count: 0,
    suppressed_count: 0,
    paused_reason: null
  })
  return nextRule
}

function addIssue(over: Record<string, any> = {}): number {
  ids.nivaro_issues = (ids.nivaro_issues ?? 0) + 1
  const id = over.id ?? ids.nivaro_issues
  t('nivaro_issues').push({
    id,
    title: `Boom ${id}`,
    details: 'stack',
    severity: 'high',
    status: 'open',
    source: 'server',
    collection: null,
    item: null,
    fingerprint: null,
    raised_by: null,
    assigned_to: null,
    created_at: new Date('2026-11-10T00:00:00Z'),
    updated_at: new Date('2026-11-10T00:00:00Z'),
    last_seen_at: null,
    occurrence_count: 1,
    recording_id: null,
    tracker_suggested_rule: null,
    has_screenshot: 0,
    ...over
  })
  return id
}

/** Every non-empty table (the fake creates empty ones on first read). */
const snapshot = () => JSON.stringify(Object.entries(tables).filter(([, rows]) => rows.length > 0))
const decisions = (rule?: number) =>
  t(DECISIONS).filter((d) => rule === undefined || d.rule === rule)

beforeEach(() => {
  failTables.clear()
  resetFailureLog()
  resetSweepFailures()
  claimHook.fail = null
  claimHook.locks = []
  for (const k of Object.keys(tables)) delete tables[k]
  for (const k of Object.keys(ids)) delete ids[k]
  nextRule = 0
  vi.resetAllMocks()
  feature.on = true
  hits.hits = 0
  hits.people = 0
  conn.sync.recur_when_closed = 'reopen'
  conn.sync.reopen_on_recur = true
  conn.sync.push_to_linked = false
  conn.sync.similar.enabled = true
  findHome.mockResolvedValue(null)
  findHomeForSource.mockResolvedValue(null)
  resetHomeMisses()
  requestCreate.mockResolvedValue({ outboxId: 1 })
  joinAsExample.mockResolvedValue(9)
  enqueue.mockResolvedValue(1)
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('evaluateIssue', () => {
  it('does nothing while the feature is off, for a missing issue, or for tracker issues', async () => {
    addRule()
    const id = addIssue()
    feature.on = false
    expect(await evaluateIssue(id)).toEqual([])
    feature.on = true
    expect(await evaluateIssue(999)).toEqual([])
    const own = addIssue({ source: 'tracker' })
    addRule({ match: {} })
    expect(await evaluateIssue(own)).toEqual([])
    expect(requestCreate).not.toHaveBeenCalled()
    expect(decisions()).toHaveLength(0)
  })

  it('first firing rule wins unless continue_after', async () => {
    const a = addRule()
    const b = addRule({ action: { connection: 2 } })
    const id = addIssue()
    expect(await evaluateIssue(id)).toEqual([{ rule: a, outcome: 'fired' }])
    expect(requestCreate).toHaveBeenCalledTimes(1)
    expect(requestCreate.mock.calls[0][1]).toMatchObject({ connection: 1, via: 'rule' })
    expect(requestCreate.mock.calls[0][1].rule.id).toBe(a)
    expect(decisions(a)[0]).toMatchObject({ issue: id, outcome: 'fired' })
    expect(t(RULES)[0]).toMatchObject({ fired_count: 1 })
    expect(t(RULES)[0].last_fired_at).toBeInstanceOf(Date)
    expect(decisions(b)).toHaveLength(0)

    // continue_after on the first rule: the second one (another connection) acts too
    t(RULES)[0].continue_after = true
    const id2 = addIssue()
    requestCreate.mockClear()
    expect(await evaluateIssue(id2)).toEqual([
      { rule: a, outcome: 'fired' },
      { rule: b, outcome: 'fired' }
    ])
    expect(requestCreate.mock.calls.map((c) => c[1].connection)).toEqual([1, 2])
  })

  it('a later rule on the same connection sees the issue as linked after a fire', async () => {
    const a = addRule({ continue_after: true })
    const b = addRule()
    const id = addIssue()
    expect(await evaluateIssue(id)).toEqual([
      { rule: a, outcome: 'fired' },
      { rule: b, outcome: 'linked' }
    ])
    expect(requestCreate).toHaveBeenCalledTimes(1)
  })

  it('group guard joins existing link instead of creating', async () => {
    const r = addRule({ guards: { group: true } })
    t('nivaro_tracker_links').push({
      id: 9,
      project_id: 7,
      external_iid: 42,
      web_url: 'https://git.x/g/p/-/issues/42',
      remote_state: 'opened'
    })
    findHome.mockResolvedValue({ via: 'group', link_id: 9 })
    const id = addIssue()
    expect(await evaluateIssue(id)).toEqual([{ rule: r, outcome: 'joined' }])
    expect(findHome).toHaveBeenCalledWith(id, 1, 7, { similar: true })
    expect(joinAsExample).toHaveBeenCalledWith(id, 1, { link_id: 9 }, 'group', undefined)
    expect(requestCreate).not.toHaveBeenCalled()
    expect(decisions(r)[0].detail).toBe('joined #42 via group')

    // group guard off: the group home is ignored and a new GitLab issue is queued
    const off = addRule({ guards: { group: false }, action: { connection: 2 } })
    t(RULES).splice(0, 1)
    const id2 = addIssue()
    joinAsExample.mockClear()
    expect(await evaluateIssue(id2)).toEqual([{ rule: off, outcome: 'fired' }])
    expect(joinAsExample).not.toHaveBeenCalled()
    expect(requestCreate).toHaveBeenCalledTimes(1)
  })

  it('a similar home joins with its score; a closed fingerprint home follows recur_when_closed', async () => {
    const r = addRule()
    findHome.mockResolvedValueOnce({
      via: 'similar',
      link_id: null,
      candidate: { project_id: 7, iid: 55, score: 0.912, link_id: null }
    })
    const id = addIssue()
    await evaluateIssue(id)
    expect(joinAsExample).toHaveBeenCalledWith(id, 1, { project_id: 7, iid: 55 }, 'similar', 0.912)
    expect(decisions(r)[0].detail).toBe('joined #55 via similar (0.91)')

    t('nivaro_tracker_links').push({
      id: 9,
      project_id: 7,
      external_iid: 42,
      web_url: 'https://git.x/g/p/-/issues/42',
      remote_state: 'closed'
    })
    // reopen: join, then queue a reopen of that GitLab issue
    findHome.mockResolvedValueOnce({ via: 'fingerprint', link_id: 9 })
    const id2 = addIssue()
    await evaluateIssue(id2)
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        op: 'state',
        link: 9,
        payload: { project_id: 7, iid: 42, state: 'reopen' }
      })
    )
    // new: no join; a new GitLab issue whose body names the closed one
    conn.sync.recur_when_closed = 'new'
    joinAsExample.mockClear()
    findHome.mockResolvedValueOnce({ via: 'fingerprint', link_id: 9 })
    const id3 = addIssue()
    await evaluateIssue(id3)
    expect(joinAsExample).not.toHaveBeenCalled()
    const opts = requestCreate.mock.calls.at(-1)?.[1]
    expect(opts.rule.action.body_template).toContain('[issue 42](https://git.x/g/p/-/issues/42)')
    expect(opts.rule.action.body_template).not.toMatch(/#42/)
    expect(decisions(r).at(-1)?.detail).toBe('queued a new GitLab issue (#42 is closed)')
  })

  it('engine join reopen honours push_to_linked', async () => {
    addRule()
    t('nivaro_tracker_links').push({
      id: 9,
      project_id: 7,
      external_iid: 42,
      web_url: 'https://git.x/g/p/-/issues/42',
      remote_state: 'closed',
      created_via: 'linked'
    })
    const reopens = () => enqueue.mock.calls.filter((c) => c[0].op === 'state')
    findHome.mockResolvedValue({ via: 'fingerprint', link_id: 9 })
    // a person-wrote-it GitLab issue: joined, not reopened
    await evaluateIssue(addIssue())
    expect(joinAsExample).toHaveBeenCalledTimes(1)
    expect(reopens()).toHaveLength(0)
    // with push_to_linked: reopened, one key per link per hour (a storm reopens once)
    conn.sync.push_to_linked = true
    await evaluateIssue(addIssue())
    await evaluateIssue(addIssue())
    expect(reopens()).toHaveLength(2)
    const keys = reopens().map((c) => c[0].key)
    expect(keys[0]).toMatch(/^state:9:reopen:\d{4}-\d\d-\d\dT\d\d$/)
    expect(new Set(keys).size).toBe(1)
  })

  it('suggest sets tracker_suggested_rule', async () => {
    const r = addRule({ mode: 'suggest' })
    const id = addIssue()
    expect(await evaluateIssue(id)).toEqual([{ rule: r, outcome: 'suggested' }])
    expect(t('nivaro_issues')[0].tracker_suggested_rule).toBe(r)
    expect(requestCreate).not.toHaveBeenCalled()
    expect(decisions(r)).toHaveLength(1)
    expect(decisions(r)[0].outcome).toBe('suggested')
    // already suggested by this rule: nothing new stored
    await evaluateIssue(id)
    expect(decisions(r)).toHaveLength(1)
  })

  it('records held outcomes once per change, never no_match', async () => {
    const r = addRule({ threshold: { hits: { n: 5, window_minutes: 60 } } })
    const miss = addRule({ match: { sources: ['client'] } })
    const id = addIssue()
    hits.hits = 2
    expect(await evaluateIssue(id)).toEqual([
      { rule: r, outcome: 'threshold' },
      { rule: miss, outcome: 'no_match' }
    ])
    await evaluateIssue(id)
    expect(decisions(r)).toHaveLength(1)
    expect(decisions(r)[0].detail).toBe('Seen 2 times in 60 min — needs 5')
    expect(decisions(miss)).toHaveLength(0)
    expect(t(RULES)[0].suppressed_count).toBe(1)
    hits.hits = 5
    expect(await evaluateIssue(id)).toEqual([{ rule: r, outcome: 'fired' }])
  })

  it('caps count fired decisions of the last hour', async () => {
    const r = addRule({ guards: { per_hour: 1 } })
    t(DECISIONS).push({ id: 1, rule: r, issue: 50, at: new Date(), outcome: 'fired' })
    ids[DECISIONS] = 1
    const id = addIssue()
    expect(await evaluateIssue(id)).toEqual([{ rule: r, outcome: 'cap' }])
    expect(requestCreate).not.toHaveBeenCalled()
  })

  it('decisions trimmed to 200', async () => {
    const r = addRule({ threshold: { hits: { n: 5, window_minutes: 60 } } })
    for (let i = 1; i <= 205; i++)
      t(DECISIONS).push({ id: i, rule: r, issue: 1000 + i, at: new Date(), outcome: 'threshold' })
    t(DECISIONS).push({ id: 206, rule: 77, issue: 1, at: new Date(), outcome: 'threshold' })
    ids[DECISIONS] = 206
    const id = addIssue()
    await evaluateIssue(id)
    const mine = decisions(r)
    expect(mine).toHaveLength(KEEP_DECISIONS)
    expect(mine.some((d) => d.issue === id)).toBe(true)
    // 206 rows (205 + the new one): the 6 oldest go
    expect(Math.min(...mine.map((d) => d.id))).toBe(7)
    expect(decisions(77)).toHaveLength(1)
  })
})

describe('sweep', () => {
  it('quiet outcome is retried after its end by sweep', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-17T03:00:00Z'))
    const r = addRule({ guards: { quiet: { from: '02:00', to: '04:00', tz: 'UTC' } } })
    const id = addIssue({ updated_at: new Date('2026-11-17T02:00:00Z') })
    expect(await evaluateIssue(id)).toEqual([{ rule: r, outcome: 'quiet' }])
    expect(decisions(r)[0].detail).toBe('2026-11-17T04:00:00.000Z')
    expect(requestCreate).not.toHaveBeenCalled()
    t('nivaro_extension_settings').push({
      id: 1,
      extension_id: SWEEP_EXT,
      key: SWEEP_KEY,
      value: '2026-11-17T03:00:00.000Z'
    })

    // a sweep before the end leaves it alone
    vi.setSystemTime(new Date('2026-11-17T03:30:00Z'))
    expect(await sweep()).toEqual({ evaluated: 0 })

    vi.setSystemTime(new Date('2026-11-17T04:01:00Z'))
    expect(await sweep()).toEqual({ evaluated: 1 })
    expect(requestCreate).toHaveBeenCalledTimes(1)
    expect(decisions(r).at(-1)?.outcome).toBe('fired')
    expect(t('nivaro_extension_settings')[0].value).toBe('2026-11-17T04:01:00.000Z')

    // the next sweep does not pick the old quiet decision up again
    vi.setSystemTime(new Date('2026-11-17T04:06:00Z'))
    expect(await sweep()).toEqual({ evaluated: 0 })
  })

  it('evaluates issues changed since the mark, oldest first, and stores the mark', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-17T12:00:00Z'))
    addRule({ mode: 'suggest' })
    t('nivaro_extension_settings').push({
      id: 1,
      extension_id: SWEEP_EXT,
      key: SWEEP_KEY,
      value: '2026-11-17T11:00:00.000Z'
    })
    const old = addIssue({ updated_at: new Date('2026-11-17T10:00:00Z') })
    const changed = addIssue({ updated_at: new Date('2026-11-17T11:30:00Z') })
    const seen = addIssue({
      updated_at: new Date('2026-11-17T09:00:00Z'),
      last_seen_at: new Date('2026-11-17T11:10:00Z')
    })
    expect(await sweep()).toEqual({ evaluated: 2 })
    const suggested = t('nivaro_issues')
      .filter((i) => i.tracker_suggested_rule)
      .map((i) => i.id)
    expect(suggested.sort()).toEqual([changed, seen].sort())
    expect(suggested).not.toContain(old)
    expect(t('nivaro_extension_settings')[0].value).toBe('2026-11-17T12:00:00.000Z')
  })
})

describe('previewRule', () => {
  const base = (over: Record<string, any> = {}): Omit<TrackerRule, 'id'> => {
    const res = validateRule({
      name: 'Draft',
      enabled: true,
      mode: 'create',
      match: { sources: ['server'] },
      action: { connection: 1 },
      ...over
    })
    if (!res.ok) throw new Error(JSON.stringify(res.errors))
    return res.rule
  }

  it('preview applies caps in time order', async () => {
    const now = new Date('2026-11-17T12:00:00Z')
    const at = (h: number, m = 0) => new Date(Date.UTC(2026, 10, 16, h, m))
    const a = addIssue({ created_at: at(1) })
    const b = addIssue({ created_at: at(1, 10) })
    const c = addIssue({ created_at: at(3) })
    const d = addIssue({ created_at: at(4) })
    addIssue({ created_at: at(5), source: 'client' }) // never matches
    const before = snapshot()
    const res = await previewRule(base({ guards: { per_hour: 1, per_day: 2 } }), 7, now)
    expect(res.would_open.map((w) => w.issue)).toEqual([a, c])
    expect(res.would_open[0]).toEqual({ issue: a, at: at(1).toISOString(), title: `Boom ${a}` })
    expect(res.held).toEqual([
      { issue: b, reason: expect.stringContaining('last hour') },
      { issue: d, reason: expect.stringContaining('last day') }
    ])
    expect(snapshot()).toBe(before) // read-only
  })

  it('replays hit thresholds hour by hour and retries a capped issue at its next write', async () => {
    const now = new Date('2026-11-17T12:00:00Z')
    const h = (hour: number) => new Date(Date.UTC(2026, 10, 17, hour))
    const a = addIssue({ created_at: h(1), fingerprint: 'fa' })
    const b = addIssue({ created_at: h(1), fingerprint: 'fb' })
    t('nivaro_issue_hits').push(
      { id: 1, key: 'fa', hour: h(2), hits: 3 },
      { id: 2, key: 'fb', hour: h(2), hits: 3 },
      { id: 3, key: 'fb', hour: h(5), hits: 1 }
    )
    const res = await previewRule(
      base({ threshold: { hits: { n: 3, window_minutes: 60 } }, guards: { per_hour: 1 } }),
      7,
      now
    )
    // a reaches 3 hits at the end of hour 2; b too but the hourly cap holds it; at its next write
    // (hour 5) the last-hour count is 1 again — not enough — so it stays held
    expect(res.would_open.map((w) => w.issue)).toEqual([a])
    expect(res.would_open[0].at).toBe(new Date(h(3).getTime() - 1).toISOString())
    expect(res.held).toEqual([{ issue: b, reason: expect.stringContaining('last hour') }])
  })
})

describe('explainIssue', () => {
  it('lists a live dry run (no_match reasons included) and the stored decisions', async () => {
    const r = addRule({ match: { sources: ['client'] } })
    const id = addIssue()
    t(DECISIONS).push({
      id: 1,
      rule: r,
      issue: id,
      at: new Date('2026-11-17T04:00:00Z'),
      outcome: 'quiet',
      detail: '2026-11-17T05:00:00.000Z'
    })
    const out = await explainIssue(id)
    expect(out[0]).toMatchObject({ rule: r, name: 'Rule 1', outcome: 'no_match', live: true })
    expect(out[1]).toMatchObject({
      rule: r,
      outcome: 'quiet',
      detail: 'Held for quiet hours until 2026-11-17T05:00:00.000Z'
    })
    expect(decisions()).toHaveLength(1) // nothing stored
    expect(requestCreate).not.toHaveBeenCalled()
  })
})

describe('fire claims (caps under concurrency)', () => {
  it('concurrent evaluations of N issues against per_hour 1 fire exactly once', async () => {
    const r = addRule({ guards: { per_hour: 1 } })
    requestCreate.mockImplementation(async () => {
      await new Promise((res) => setTimeout(res, 5))
      return { outboxId: 1 }
    })
    const issues = Array.from({ length: 10 }, () => addIssue())
    const results = await Promise.all(issues.map((id) => evaluateIssue(id)))
    const outcomes = results.map((x) => x[0]?.outcome)
    expect(outcomes.filter((o) => o === 'fired')).toHaveLength(1)
    expect(outcomes.filter((o) => o === 'cap')).toHaveLength(9)
    expect(requestCreate).toHaveBeenCalledTimes(1)
    expect(decisions(r).filter((d) => d.outcome === 'fired')).toHaveLength(1)
    expect(t(RULES)[0].fired_count).toBe(1)
    const cap = decisions(r).find((d) => d.outcome === 'cap')
    expect(cap?.detail).toBe('Rule already opened 1 in the last hour (limit 1)')
  })

  it('the connection cap counts fired decisions of every rule on the connection', async () => {
    const a = addRule({ continue_after: true })
    const b = addRule({ match: { sources: ['client'] } })
    for (let i = 1; i <= 30; i++)
      t(DECISIONS).push({ id: i, rule: b, issue: 500 + i, at: new Date(), outcome: 'fired' })
    ids[DECISIONS] = 30
    const id = addIssue()
    expect(await evaluateIssue(id)).toEqual([
      { rule: a, outcome: 'cap' },
      { rule: b, outcome: 'no_match' }
    ])
    expect(decisions(a)[0].detail).toBe('Connection already sent 30 in the last hour (limit 30)')
    expect(requestCreate).not.toHaveBeenCalled()
  })

  it('a fire that throws turns its claimed row into an error', async () => {
    const r = addRule()
    requestCreate.mockRejectedValue(new Error('Choose a GitLab project'))
    const id = addIssue()
    expect(await evaluateIssue(id)).toEqual([{ rule: r, outcome: 'error' }])
    expect(decisions(r)).toEqual([
      expect.objectContaining({
        outcome: 'error',
        detail: 'Could not act: Choose a GitLab project'
      })
    ])
    expect(t(RULES)[0].fired_count).toBe(0)
  })

  it('claimStatement binds every value and locks the counted ranges on SQL Server', () => {
    const at = new Date('2026-11-17T12:00:00Z')
    const p = { rule: 3, issue: 9, connection: 1, at, perHour: 5, perDay: 20, connectionCap: 30 }
    const { sql, bindings } = claimStatement(p, true)
    expect(sql.match(/WITH \(UPDLOCK, HOLDLOCK\)/g)).toHaveLength(3)
    expect(sql).toContain('OUTPUT inserted.[id]')
    expect(sql).toContain('[rule] = ?')
    expect(sql).not.toMatch(/\b(3|9|5|20|30)\b/)
    expect(sql.match(/\?/g)).toHaveLength(bindings.length)
    const hourAgo = new Date(at.getTime() - 3_600_000)
    const dayAgo = new Date(at.getTime() - 86_400_000)
    expect(bindings).toEqual([
      3,
      9,
      at,
      CLAIM_DETAIL,
      1,
      3,
      hourAgo,
      5,
      3,
      dayAgo,
      20,
      1,
      -1,
      1,
      hourAgo,
      30
    ])
    expect(claimStatement(p, false).sql).not.toContain('UPDLOCK')
  })
})

describe('queued creates', () => {
  it('evaluating twice before the create is sent records one fired decision', async () => {
    const r = addRule()
    requestCreate.mockImplementation(async (issue: number, o: { connection: number }) => {
      t('nivaro_tracker_outbox').push({
        id: 1,
        connection: o.connection,
        op: 'create',
        source_kind: 'issue',
        source_id: String(issue),
        status: 'pending'
      })
      return { outboxId: 1 }
    })
    const id = addIssue()
    expect(await evaluateIssue(id)).toEqual([{ rule: r, outcome: 'fired' }])
    expect(await evaluateIssue(id)).toEqual([{ rule: r, outcome: 'linked' }])
    expect(decisions(r).filter((d) => d.outcome === 'fired')).toHaveLength(1)
    expect(requestCreate).toHaveBeenCalledTimes(1)
    expect(t(RULES)[0].fired_count).toBe(1)
    // dead stays linked until an admin retries or discards it; done does not
    t('nivaro_tracker_outbox')[0].status = 'dead'
    expect(await evaluateIssue(id)).toEqual([{ rule: r, outcome: 'linked' }])
    t('nivaro_tracker_outbox')[0].status = 'done'
    expect(await evaluateIssue(id)).toEqual([{ rule: r, outcome: 'fired' }])
  })
})

describe('evaluation failures', () => {
  it('sweep does not advance past a failed issue', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-11-17T12:00:00Z'))
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    addRule({ mode: 'suggest' })
    t('nivaro_extension_settings').push({
      id: 1,
      extension_id: SWEEP_EXT,
      key: SWEEP_KEY,
      value: '2026-11-17T10:00:00.000Z'
    })
    const a = addIssue({ updated_at: new Date('2026-11-17T10:10:00Z') })
    const b = addIssue({ updated_at: new Date('2026-11-17T10:20:00Z'), raised_by: 'u1' })
    const c = addIssue({ updated_at: new Date('2026-11-17T10:30:00Z') })
    failTables.add('nivaro_users') // b's facts cannot be read
    expect(await sweep()).toEqual({ evaluated: 3 })
    const suggested = () =>
      t('nivaro_issues')
        .filter((i) => i.tracker_suggested_rule)
        .map((i) => i.id)
    expect(suggested()).toEqual([a, c])
    expect(t('nivaro_extension_settings')[0].value).toBe('2026-11-17T10:19:59.999Z')

    failTables.clear()
    vi.setSystemTime(new Date('2026-11-17T12:05:00Z'))
    expect(await sweep()).toEqual({ evaluated: 2 }) // b again (and c, still after the mark)
    expect(suggested()).toEqual([a, b, c])
    expect(t('nivaro_extension_settings')[0].value).toBe('2026-11-17T12:05:00.000Z')
  })

  it('failure logging is rate limited not silenced', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t0 = Date.UTC(2026, 10, 17, 12)
    noteEvaluationFailure(1, new Error('boom'), t0)
    noteEvaluationFailure(2, new Error('boom'), t0 + 60_000)
    noteEvaluationFailure(3, new Error('boom'), t0 + 120_000)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('1 failure since')
    noteEvaluationFailure(4, new Error('later'), t0 + FAILURE_LOG_EVERY_MS)
    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn.mock.calls[1][0]).toContain('issue 4 (3 failures since the last report): later')
    noteEvaluationFailure(5, new Error('x'), t0 + FAILURE_LOG_EVERY_MS + 1000)
    expect(warn).toHaveBeenCalledTimes(2)
  })
})

describe('fix round 2', () => {
  it('a persistently failing issue stops holding the sweep mark after 3 tries', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    addRule({ mode: 'suggest' })
    t('nivaro_extension_settings').push({
      id: 1,
      extension_id: SWEEP_EXT,
      key: SWEEP_KEY,
      value: '2026-11-17T10:00:00.000Z'
    })
    const poison = addIssue({ updated_at: new Date('2026-11-17T10:20:00Z'), raised_by: 'u1' })
    const later = addIssue({ updated_at: new Date('2026-11-17T10:30:00Z') })
    failTables.add('nivaro_users')
    const mark = () => t('nivaro_extension_settings')[0].value
    const sweepErrors = () => decisions(SWEEP_RULE)

    for (const at of ['12:00', '12:05']) {
      vi.setSystemTime(new Date(`2026-11-17T${at}:00Z`))
      await sweep()
      expect(mark()).toBe('2026-11-17T10:19:59.999Z')
    }
    expect(sweepErrors()).toHaveLength(0)

    vi.setSystemTime(new Date('2026-11-17T12:10:00Z'))
    await sweep() // third failed try: the sweep moves on
    expect(mark()).toBe('2026-11-17T12:10:00.000Z')
    expect(sweepErrors()).toEqual([
      expect.objectContaining({
        issue: poison,
        outcome: 'error',
        detail: 'evaluation keeps failing — skipped by the sweep: nivaro_users is unreadable'
      })
    ])
    expect(t('nivaro_issues').find((i) => i.id === later)?.tracker_suggested_rule).toBe(1)

    // a new write of the poison issue is tried again, without holding the mark or another row
    const row = t('nivaro_issues').find((i) => i.id === poison) as Row
    row.updated_at = new Date('2026-11-17T12:12:00Z')
    vi.setSystemTime(new Date('2026-11-17T12:15:00Z'))
    expect(await sweep()).toEqual({ evaluated: 1 })
    expect(mark()).toBe('2026-11-17T12:15:00.000Z')
    expect(sweepErrors()).toHaveLength(1)
  })

  it('a failing issue stops holding the mark an hour after its first failure', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    addRule({ mode: 'suggest' })
    t('nivaro_extension_settings').push({
      id: 1,
      extension_id: SWEEP_EXT,
      key: SWEEP_KEY,
      value: '2026-11-17T10:00:00.000Z'
    })
    addIssue({ updated_at: new Date('2026-11-17T10:20:00Z'), raised_by: 'u1' })
    failTables.add('nivaro_users')
    vi.setSystemTime(new Date('2026-11-17T12:00:00Z'))
    await sweep()
    expect(t('nivaro_extension_settings')[0].value).toBe('2026-11-17T10:19:59.999Z')
    vi.setSystemTime(new Date('2026-11-17T13:00:00Z'))
    await sweep() // second try, but an hour after the first
    expect(t('nivaro_extension_settings')[0].value).toBe('2026-11-17T13:00:00.000Z')
    expect(decisions(SWEEP_RULE)).toHaveLength(1)
  })

  it('trim never removes fired rows inside the cap window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const now = new Date('2026-11-17T12:00:00Z')
    vi.setSystemTime(now)
    const r = addRule({ threshold: { hits: { n: 5, window_minutes: 60 } } })
    const ago = (h: number) => new Date(now.getTime() - h * 3_600_000)
    let id = 0
    const push = (outcome: string, at: Date) =>
      t(DECISIONS).push({ id: ++id, rule: r, issue: 1000 + id, at, outcome, detail: '' })
    for (let i = 0; i < 5; i++) push('fired', ago(30)) // past the cap window
    for (let i = 0; i < 20; i++) push('fired', ago(2)) // inside it
    for (let i = 0; i < 250; i++) push('threshold', ago(1))
    ids[DECISIONS] = id
    await evaluateIssue(addIssue())
    const mine = decisions(r)
    expect(
      mine.filter((d) => d.outcome === 'fired' && d.at.getTime() === ago(2).getTime())
    ).toHaveLength(20)
    expect(mine.filter((d) => d.at.getTime() === ago(30).getTime())).toHaveLength(0)
    // the newest 200 rows are kept, plus the 20 fired rows the caps still count
    expect(mine).toHaveLength(220)
  })
})

describe('fix round 3', () => {
  const openLink = () =>
    t('nivaro_tracker_links').push({
      id: 9,
      project_id: 7,
      external_iid: 42,
      web_url: 'https://git.x/g/p/-/issues/42',
      remote_state: 'opened'
    })

  it('a join does not use a cap slot', async () => {
    const r = addRule({ guards: { per_hour: 1 } })
    openLink()
    findHome.mockResolvedValueOnce({ via: 'group', link_id: 9 })
    expect(await evaluateIssue(addIssue())).toEqual([{ rule: r, outcome: 'joined' }])
    expect(t(RULES)[0].fired_count).toBe(0)
    // the one hourly slot is still free for a new GitLab issue
    expect(await evaluateIssue(addIssue())).toEqual([{ rule: r, outcome: 'fired' }])
    expect(t(RULES)[0].fired_count).toBe(1)
    // the cap is now used: a similar issue still joins, one with no home is held
    findHome.mockResolvedValueOnce({ via: 'fingerprint', link_id: 9 })
    expect(await evaluateIssue(addIssue())).toEqual([{ rule: r, outcome: 'joined' }])
    expect(await evaluateIssue(addIssue())).toEqual([{ rule: r, outcome: 'cap' }])
    expect(requestCreate).toHaveBeenCalledTimes(1)
    expect(joinAsExample).toHaveBeenCalledTimes(2)
    expect(decisions(r).map((d) => d.outcome)).toEqual(['joined', 'fired', 'joined', 'cap'])
    expect(decisions(r)[0].detail).toBe('joined #42 via group')
    expect(t(RULES)[0].suppressed_count).toBe(1)
  })

  it('connection cap ignores joins', async () => {
    const a = addRule()
    const b = addRule({ match: { sources: ['client'] } })
    for (let i = 1; i <= 40; i++)
      t(DECISIONS).push({ id: i, rule: b, issue: 500 + i, at: new Date(), outcome: 'joined' })
    ids[DECISIONS] = 40
    expect(await evaluateIssue(addIssue())).toEqual([{ rule: a, outcome: 'fired' }])
    // at the connection cap (30 opened), joins still go through
    for (let i = 41; i <= 70; i++)
      t(DECISIONS).push({ id: i, rule: b, issue: 500 + i, at: new Date(), outcome: 'fired' })
    ids[DECISIONS] = 70
    openLink()
    findHome.mockResolvedValueOnce({ via: 'group', link_id: 9 })
    expect(await evaluateIssue(addIssue())).toEqual([{ rule: a, outcome: 'joined' }])
    expect(await evaluateIssue(addIssue())).toEqual([
      { rule: a, outcome: 'cap' },
      { rule: b, outcome: 'no_match' }
    ])
  })

  it('a claim that throws records an error decision and evaluation continues', async () => {
    const a = addRule({ continue_after: true })
    const b = addRule({ mode: 'suggest', action: { connection: 2 } })
    claimHook.fail = 'Transaction was deadlocked and has been chosen as the deadlock victim'
    const id = addIssue()
    expect(await evaluateIssue(id)).toEqual([
      { rule: a, outcome: 'error' },
      { rule: b, outcome: 'suggested' }
    ])
    expect(decisions(a)[0]).toMatchObject({
      outcome: 'error',
      detail:
        'Could not claim a slot to open a GitLab issue: Transaction was deadlocked and has been chosen as the deadlock victim'
    })
    expect(requestCreate).not.toHaveBeenCalled()
    expect(t(RULES)[0].fired_count).toBe(0)
  })

  it('every claim takes the one global app lock', async () => {
    addRule({ continue_after: true })
    addRule({ action: { connection: 2 } })
    await evaluateIssue(addIssue())
    expect(claimHook.locks).toEqual([CLAIM_LOCK, CLAIM_LOCK])
    expect(CLAIM_LOCK).toBe('nivaro-tracker-claim')
  })
})

describe('sources (Task 9b)', () => {
  it('source issue switched off: rules skip', async () => {
    const r = addRule()
    const id = addIssue()
    ;(conn.sync as Record<string, unknown>).sources = { issue: false, ticket: true, record: true }
    try {
      expect(await evaluateIssue(id)).toEqual([{ rule: r, outcome: 'no_match' }])
      expect(requestCreate).not.toHaveBeenCalled()
      expect(decisions()).toHaveLength(0)
    } finally {
      delete (conn.sync as Record<string, unknown>).sources
    }
  })

  it('ticket rules run on support tickets only; issue rules never see a ticket', async () => {
    requestSourceCreate.mockResolvedValue({ outboxId: 3 })
    const issueRule = addRule({ match: {} })
    const tr = addRule({ applies_to: 'ticket', match: { priorities: ['urgent'] } })
    t(RULES).find((x) => x.id === tr)!.applies_to = 'ticket'
    t('nivaro_tasks').push({
      id: 55,
      kind: 'support',
      title: 'Payroll export fails',
      description: 'every time',
      status: 'open',
      priority: 'urgent',
      category_id: 3,
      created_by: null,
      assignee: null,
      created_at: new Date('2026-11-10T00:00:00Z')
    })
    expect(await evaluateTicket(55)).toEqual([{ rule: tr, outcome: 'fired' }])
    expect(requestSourceCreate).toHaveBeenCalledTimes(1)
    expect(requestSourceCreate.mock.calls[0].slice(0, 2)).toEqual(['ticket', '55'])
    expect(requestSourceCreate.mock.calls[0][2]).toMatchObject({ connection: 1, via: 'rule' })
    expect(decisions(tr)[0]).toMatchObject({ issue: 55, outcome: 'fired' })
    expect(decisions(issueRule)).toHaveLength(0)
    // an issue with the same number is judged by the issue rule only
    const id = addIssue({ id: 55 })
    expect(await evaluateIssue(id)).toEqual([{ rule: issueRule, outcome: 'fired' }])
    // explain for issue 55 does not list the ticket rule's decision
    const explained = await explainIssue(id)
    expect(explained.some((e) => e.rule === tr)).toBe(false)
  })

  it('a capped issue skips similarity and remembers a miss for 15 minutes (M4)', async () => {
    const r = addRule({ guards: { per_hour: 1 } })
    const now = new Date()
    expect(await evaluateIssue(addIssue(), now)).toEqual([{ rule: r, outcome: 'fired' }])
    expect(findHome.mock.calls[0][3]).toEqual({ similar: true })
    const held = addIssue()
    findHome.mockClear()
    expect(await evaluateIssue(held, now)).toEqual([{ rule: r, outcome: 'cap' }])
    expect(findHome).toHaveBeenCalledTimes(1)
    expect(findHome.mock.calls[0]).toEqual([held, 1, 7, { similar: false }])
    // a storm of re-evaluations inside 15 minutes looks no further
    for (let i = 0; i < 5; i++)
      expect(await evaluateIssue(held, new Date(now.getTime() + i * 60_000))).toEqual([
        { rule: r, outcome: 'cap' }
      ])
    expect(findHome).toHaveBeenCalledTimes(1)
    // after 15 minutes it looks again (still without similarity)
    await evaluateIssue(held, new Date(now.getTime() + 16 * 60_000))
    expect(findHome).toHaveBeenCalledTimes(2)
    expect(findHome.mock.calls[1][3]).toEqual({ similar: false })
  })

  it('a capped issue whose home turns up through the fingerprint still joins (M4)', async () => {
    const r = addRule({ guards: { per_hour: 1 } })
    expect(await evaluateIssue(addIssue())).toEqual([{ rule: r, outcome: 'fired' }])
    t('nivaro_tracker_links').push({
      id: 9,
      project_id: 7,
      external_iid: 42,
      web_url: 'https://git.x/g/p/-/issues/42',
      remote_state: 'opened'
    })
    findHome.mockResolvedValueOnce({ via: 'fingerprint', link_id: 9 })
    expect(await evaluateIssue(addIssue())).toEqual([{ rule: r, outcome: 'joined' }])
  })

  it('a capped ticket rule never searches for a similar GitLab issue (M4)', async () => {
    requestSourceCreate.mockResolvedValue({ outboxId: 3 })
    const tr = addRule({ applies_to: 'ticket', match: {}, guards: { per_hour: 1 } })
    t(RULES).find((x) => x.id === tr)!.applies_to = 'ticket'
    for (const id of [61, 62])
      t('nivaro_tasks').push({
        id,
        kind: 'support',
        title: 'Payroll export fails',
        description: 'every time',
        status: 'open',
        priority: 'urgent',
        category_id: 3,
        created_by: null,
        assignee: null,
        created_at: new Date('2026-11-10T00:00:00Z')
      })
    expect(await evaluateTicket(61)).toEqual([{ rule: tr, outcome: 'fired' }])
    expect(findHomeForSource).toHaveBeenCalledTimes(1)
    expect(await evaluateTicket(62)).toEqual([{ rule: tr, outcome: 'cap' }])
    expect(await evaluateTicket(62)).toEqual([{ rule: tr, outcome: 'cap' }])
    expect(findHomeForSource).toHaveBeenCalledTimes(1)
  })

  it('flow-created GitLab issues count toward the connection cap (rule -1, "Flow")', async () => {
    const id = addIssue()
    const recent = new Date(Date.now() - 60_000)
    for (let i = 0; i < 30; i++)
      t(DECISIONS).push({
        id: 1000 + i,
        rule: -1,
        issue: i === 0 ? id : 0,
        at: recent,
        outcome: 'fired',
        detail: 'Flow: queued a new GitLab issue',
        connection: 1
      })
    const r = addRule()
    expect(await evaluateIssue(id)).toEqual([{ rule: r, outcome: 'cap' }])
    expect(requestCreate).not.toHaveBeenCalled()
    // a flow is held by the same cap; another connection is not
    expect(await claimFlowFire(1, 0)).toMatchObject({
      ok: false,
      detail: expect.stringContaining('limit 30')
    })
    expect(await claimFlowFire(2, 0)).toMatchObject({ ok: true })
    expect(t(DECISIONS).at(-1)).toMatchObject({ rule: -1, connection: 2, outcome: 'fired' })
    // the issue's decisions name the flow
    expect((await explainIssue(id)).some((e) => e.rule === -1 && e.name === 'Flow')).toBe(true)
  })
})
