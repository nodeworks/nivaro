import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── In-memory stand-in for the tables this module reads and writes ─────────────
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
  if (a == null || b == null) return a == null && b == null ? 0 : a == null ? -1 : 1
  const x = a instanceof Date ? a.getTime() : a
  const y = b instanceof Date ? b.getTime() : b
  return x < y ? -1 : x > y ? 1 : 0
}
const OPS: Record<string, (a: any, b: any) => boolean> = {
  '=': (a, b) => cmp(a, b) === 0,
  '<': (a, b) => a != null && cmp(a, b) < 0,
  '<=': (a, b) => a != null && cmp(a, b) <= 0,
  '>': (a, b) => a != null && cmp(a, b) > 0,
  '>=': (a, b) => a != null && cmp(a, b) >= 0,
  like: (a, b) =>
    typeof a === 'string' &&
    new RegExp(
      `^${String(b)
        .split('%')
        .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .join('.*')}$`
    ).test(a)
}

function builder(name: string) {
  const preds: Array<(r: Row) => boolean> = []
  const orders: Array<[string, string]> = []
  let lim: number | null = null
  let counting = false
  const rows = () => {
    let out = t(name).filter((r) => preds.every((p) => p(r)))
    for (const [col, dir] of [...orders].reverse())
      out = [...out].sort((a, b) => cmp(a[col], b[col]) * (dir === 'desc' ? -1 : 1))
    if (lim != null) out = out.slice(0, lim)
    return out
  }
  const b: any = {}
  b.where = (a: any, op?: any, v?: any) => {
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
    orders.push([col, dir])
    return b
  }
  b.limit = (n: number) => {
    lim = n
    return b
  }
  b.select = () => b
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

vi.mock('../../db/index.js', () => ({ db: (name: string) => builder(name) }))
const feature = vi.hoisted(() => ({ on: true }))
vi.mock('./feature.js', () => ({ trackersEnabled: async () => feature.on }))

const provider = {
  searchOpenIssues: vi.fn<(...args: any[]) => any>(),
  getIssue: vi.fn<(...args: any[]) => any>()
}
const conn = vi.hoisted(() => ({ sync: {} as Record<string, unknown> }))
vi.mock('./connections.js', async () => {
  const actual = await vi.importActual<typeof import('./connections.js')>('./connections.js')
  return {
    ...actual,
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
            is_active: true,
            sync: actual.normalizeSync(conn.sync)
          }
        : null
  }
})
vi.mock('../issue-raise.js', () => ({
  noteIssueWrite: () => {},
  hitCounts: async () => ({ hits: 4, people: 2 }),
  hitKey: (i: { id: number; fingerprint?: string | null }) => i.fingerprint ?? `issue:${i.id}`
}))
vi.mock('../app-links.js', () => ({ linkTo: async () => 'https://nivaro.test/issues' }))

// Embeddings: each test says which text gets which score against the source (cos θ in 2-D).
const scores = vi.hoisted(() => ({
  map: [] as Array<[RegExp, number]>,
  fail: null as RegExp | null
}))
vi.mock('../embeddings.js', () => ({
  embedText: async (text: string) => {
    if (scores.fail?.test(text)) throw new Error('embedder down')
    if (/^checkout fails/.test(text)) return [1, 0]
    const hit = scores.map.find(([re]) => re.test(text))
    const s = hit ? hit[1] : 0
    return [s, Math.sqrt(Math.max(0, 1 - s * s))]
  },
  cosineSim: (a: number[], b: number[]) => {
    let dot = 0
    let na = 0
    let nb = 0
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i]
      na += a[i] * a[i]
      nb += b[i] * b[i]
    }
    return na && nb ? dot / Math.sqrt(na * nb) : 0
  }
}))
const groups = vi.hoisted(() => ({ list: [] as any[] }))
vi.mock('../issue-groups.js', () => ({ groupSimilarIssues: async () => groups.list }))

import { rollupNoteBody } from './examples.js'
import { setAutoSend } from './outbox.js'
import {
  exampleNoteBody,
  findHome,
  findSimilar,
  joinAsExample,
  normalizeForSimilarity
} from './similar.js'

const remote = (iid: number, extra: Row = {}) => ({
  id: 900 + iid,
  iid,
  project_id: 7,
  web_url: `https://git.x/g/p/-/issues/${iid}`,
  title: `t${iid}`,
  state: 'opened',
  labels: [],
  assignees: [],
  milestone: null,
  updated_at: '2026-11-17T12:00:00Z',
  description: null,
  ...extra
})

const addLink = (id: number, extra: Row = {}) =>
  t('nivaro_tracker_links').push({
    id,
    connection: 1,
    project_id: 7,
    project_path: 'g/p',
    external_iid: id,
    web_url: `https://git.x/g/p/-/issues/${id}`,
    remote_state: 'opened',
    remote_title: `Link ${id}`,
    created_via: 'manual',
    created_at: new Date(),
    ...extra
  })
const addMemberRow = (link: number, issue: number, via = 'lead') =>
  t('nivaro_tracker_link_members').push({
    id: t('nivaro_tracker_link_members').length + 1,
    link,
    connection: 1,
    source_kind: 'issue',
    source_id: String(issue),
    joined_via: via
  })
const addIssue = (id: number, extra: Row = {}) =>
  t('nivaro_issues').push({
    id,
    title: `Issue ${id}`,
    severity: 'high',
    status: 'open',
    source: 'server',
    details: null,
    fingerprint: null,
    occurrence_count: 1,
    created_at: new Date('2026-11-16T10:00:00Z'),
    ...extra
  })

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k]
  for (const k of Object.keys(ids)) delete ids[k]
  vi.resetAllMocks()
  setAutoSend(false)
  feature.on = true
  conn.sync = {}
  scores.map = []
  scores.fail = null
  groups.list = []
  provider.searchOpenIssues.mockResolvedValue([])
  addIssue(5, {
    title: 'Checkout fails for order 12345',
    details: 'TypeError at cart 9f1c2e4a-1111-2222-3333-444455556666',
    fingerprint: 'fp5'
  })
  ids.nivaro_issues = 100
})

describe('normalizeForSimilarity', () => {
  it('normalizeForSimilarity folds ids and numbers', () => {
    const a = normalizeForSimilarity(
      'Checkout fails for order 12345',
      `Failed for 9f1c2e4a-1111-2222-3333-444455556666 user 'ann' "x" ${'z'.repeat(600)}`
    )
    expect(a).toBe(
      `checkout fails for order <n> failed for <id> user '<x>' "<x>" ${'z'.repeat(
        500 - 'Failed for 9f1c2e4a-1111-2222-3333-444455556666 user \'ann\' "x" '.length
      )}`
    )
    expect(normalizeForSimilarity('Order 1 failed', null)).toBe(
      normalizeForSimilarity('Order 99  failed', '')
    )
  })
})

describe('findSimilar', () => {
  it('findSimilar returns suggest_at..1 sorted', async () => {
    addLink(30, { remote_title: '[high] Checkout broken' })
    addIssue(31, { title: 'Checkout broken on pay', details: 'stack' })
    addMemberRow(30, 31)
    provider.searchOpenIssues.mockResolvedValue([
      remote(40, { title: 'Cart total wrong', description: 'cart total' }),
      remote(41, { title: 'Payment page slow', description: 'payment slow' }),
      remote(42, { title: 'Unrelated', description: 'nothing' }),
      // already linked on this connection: one candidate, marked linked
      remote(30, { title: '[high] Checkout broken', description: 'from gitlab' })
    ])
    scores.map = [
      [/^checkout broken/, 0.9],
      [/^cart total/, 0.95],
      [/^payment page/, 0.8],
      [/^unrelated/, 0.7]
    ]
    const out = await findSimilar(5, 1, 7)
    expect(out.map((c) => [c.iid, Number(c.score.toFixed(2)), c.linked, c.link_id])).toEqual([
      [40, 0.95, false, null],
      [30, 0.9, true, 30],
      [41, 0.8, false, null]
    ])
    expect(out[1]).toMatchObject({ title: '[high] Checkout broken', project_id: 7 })
    // GitLab title search on the 6 longest words of 4+ characters
    expect(provider.searchOpenIssues).toHaveBeenCalledWith(7, 'checkout fails order')
  })

  it('skips the search with no key words, and never throws on provider or embedder trouble', async () => {
    t('nivaro_issues')[0].title = 'Oh no 42'
    expect(await findSimilar(5, 1, 7)).toEqual([])
    expect(provider.searchOpenIssues).not.toHaveBeenCalled()

    t('nivaro_issues')[0].title = 'Checkout fails'
    provider.searchOpenIssues.mockRejectedValue(new Error('GitLab down'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    addLink(30)
    addIssue(31, { title: 'Checkout fails again' })
    addMemberRow(30, 31)
    scores.map = [[/^checkout fails again/, 0.95]]
    expect((await findSimilar(5, 1, 7)).map((c) => c.link_id)).toEqual([30])
    scores.fail = /./
    expect(await findSimilar(5, 1, 7)).toEqual([])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('findSimilar returns [] and never searches when similar is disabled', async () => {
    conn.sync = { similar: { enabled: false } }
    addLink(30, { remote_title: 'Similar checkout failure' })
    scores.map = [[/^similar checkout|^link 30/, 0.99]]
    provider.searchOpenIssues.mockResolvedValue([remote(40, { title: 'Checkout fails' })])
    expect(await findSimilar(5, 1, 7)).toEqual([])
    expect(provider.searchOpenIssues).not.toHaveBeenCalled()
  })

  it('falls back to fewer key words when the full search finds nothing', async () => {
    t('nivaro_issues')[0].title = 'Checkout payment failure during invoice reconciliation export'
    provider.searchOpenIssues.mockImplementation(async (_p: number, q: string) =>
      q.split(' ').length === 3 ? [remote(40, { title: 'Payment reconciliation broke' })] : []
    )
    scores.map = [
      [/^checkout payment/, 1],
      [/^payment reconciliation/, 0.9]
    ]
    const out = await findSimilar(5, 1, 7)
    expect(provider.searchOpenIssues.mock.calls.map((c) => c[1])).toEqual([
      'reconciliation checkout payment failure invoice during',
      'reconciliation checkout payment'
    ])
    expect(out.map((c) => c.iid)).toEqual([40])

    // nothing for 6 or 3 words: the single longest word (6+ chars) is the last try
    provider.searchOpenIssues.mockReset()
    provider.searchOpenIssues.mockResolvedValue([])
    await findSimilar(5, 1, 7)
    expect(provider.searchOpenIssues.mock.calls.map((c) => c[1])).toEqual([
      'reconciliation checkout payment failure invoice during',
      'reconciliation checkout payment',
      'reconciliation'
    ])
  })

  it('stops after the first search with results', async () => {
    t('nivaro_issues')[0].title = 'Checkout payment failure during invoice reconciliation export'
    provider.searchOpenIssues.mockResolvedValue([remote(40, { title: 'Payment broke' })])
    await findSimilar(5, 1, 7)
    expect(provider.searchOpenIssues).toHaveBeenCalledTimes(1)
    // two short words: no single-word try (needs 6+ chars), and 3 words = the same query once
    t('nivaro_issues')[0].title = 'Cart fails'
    provider.searchOpenIssues.mockReset()
    provider.searchOpenIssues.mockResolvedValue([])
    await findSimilar(5, 1, 7)
    expect(provider.searchOpenIssues.mock.calls.map((c) => c[1])).toEqual(['fails cart'])
  })

  it('only open links on the connection from the last 90 days are candidates, 50 at most', async () => {
    const old = new Date(Date.now() - 91 * 86_400_000)
    addLink(30, { remote_title: 'Checkout fails closed', remote_state: 'closed' })
    addLink(31, { remote_title: 'Checkout fails old', created_at: old })
    addLink(32, { remote_title: 'Checkout fails other conn', connection: 2 })
    scores.map = [[/^checkout fails/, 0.99]]
    expect(await findSimilar(5, 1, 7)).toEqual([])
    for (let i = 0; i < 60; i++)
      addLink(100 + i, {
        remote_title: 'Checkout fails new',
        created_at: new Date(Date.now() - i * 1000)
      })
    const out = await findSimilar(5, 1, 7, { limit: 100 })
    // the newest 50 (ids 100..149)
    expect(out.map((c) => c.link_id).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(
      Array.from({ length: 50 }, (_, i) => 100 + i)
    )
  })
})

describe('findHome', () => {
  it('findHome prefers fingerprint over group over similar', async () => {
    addLink(30) // same fingerprint
    t('nivaro_tracker_links')[0].fingerprint = 'fp5'
    addIssue(8, { title: 'Grouped variant' })
    addLink(31) // holds a member of the issue's group
    addMemberRow(31, 8)
    groups.list = [{ lead: { id: 8 }, variants: [{ id: 5 }] }]
    addLink(32, { remote_title: 'Similar checkout failure' })
    scores.map = [[/^similar checkout/, 0.95]]

    expect(await findHome(5, 1, 7)).toMatchObject({ via: 'fingerprint', link_id: 30 })
    tables.nivaro_tracker_links = t('nivaro_tracker_links').filter((l) => l.id !== 30)
    expect(await findHome(5, 1, 7)).toMatchObject({ via: 'group', link_id: 31 })
    groups.list = []
    const home = await findHome(5, 1, 7)
    expect(home).toMatchObject({ via: 'similar', link_id: 32 })
    expect(home?.candidate?.score).toBeCloseTo(0.95)
  })

  it('findHome similar only at or above join_at', async () => {
    addLink(32, { remote_title: 'Similar checkout failure' })
    scores.map = [[/^similar checkout/, 0.87]]
    expect(await findHome(5, 1, 7)).toBeNull()
    scores.map = [[/^similar checkout/, 0.881]]
    expect(await findHome(5, 1, 7)).toMatchObject({ via: 'similar', link_id: 32 })
    conn.sync = { similar: { enabled: false } }
    expect(await findHome(5, 1, 7)).toBeNull()
  })

  it('answers nothing when the feature is off', async () => {
    addLink(30, { fingerprint: 'fp5' })
    feature.on = false
    expect(await findHome(5, 1, 7)).toBeNull()
    expect(await findSimilar(5, 1, 7)).toEqual([])
  })
})

describe('joinAsExample', () => {
  it('joinAsExample on a foreign GitLab issue creates a linked link', async () => {
    conn.sync = { labels: { on_example: ['recurring'] } }
    provider.getIssue.mockResolvedValue(remote(77, { title: 'Someone else wrote this' }))
    const linkId = await joinAsExample(5, 1, { project_id: 7, iid: 77 }, 'similar', 0.91)
    const link = t('nivaro_tracker_links').find((l) => l.id === linkId)
    expect(link).toMatchObject({
      connection: 1,
      project_id: 7,
      external_iid: 77,
      project_path: 'g/p',
      created_via: 'linked',
      fingerprint: 'fp5'
    })
    expect(t('nivaro_tracker_link_members')).toEqual([
      expect.objectContaining({ link: linkId, source_id: '5', joined_via: 'similar' })
    ])
    const rows = t('nivaro_tracker_outbox')
    expect(rows.map((r) => [r.op, r.idempotency_key])).toEqual([
      ['comment', `example:${linkId}:5`],
      ['labels', `example-labels:${linkId}:5`]
    ])
    const note = JSON.parse(rows[0].payload)
    expect(note).toMatchObject({ project_id: 7, iid: 77 })
    expect(note.body).toContain('**Another example** — Nivaro issue 5 (91% similar)')
    // never `#<n>`: GitLab would cross-link an unrelated issue of its project
    expect(note.body).not.toMatch(/#\d/)
    expect(JSON.parse(rows[1].payload)).toEqual({
      project_id: 7,
      iid: 77,
      add_labels: ['recurring'],
      remove_labels: []
    })
  })

  it('joinAsExample twice for the same issue enqueues one example note', async () => {
    addLink(30)
    addIssue(31)
    addMemberRow(30, 31)
    expect(await joinAsExample(5, 1, { link_id: 30 }, 'fingerprint')).toBe(30)
    expect(await joinAsExample(5, 1, { link_id: 30 }, 'fingerprint')).toBe(30)
    expect(await joinAsExample(5, 1, { project_id: 7, iid: 30 }, 'manual')).toBe(30)
    expect(t('nivaro_tracker_outbox').filter((r) => r.op === 'comment')).toHaveLength(1)
    // no on_example labels configured: no labels change
    expect(t('nivaro_tracker_outbox').filter((r) => r.op === 'labels')).toHaveLength(0)
    expect(provider.getIssue).not.toHaveBeenCalled()
  })

  it('a storm of 12 joins posts 5 example notes and one roll-up', async () => {
    conn.sync = { labels: { on_example: ['recurring'] } }
    addLink(30)
    for (let i = 100; i < 112; i++) {
      addIssue(i)
      await joinAsExample(i, 1, { link_id: 30 }, 'similar', 0.9)
    }
    const rows = t('nivaro_tracker_outbox')
    const examples = rows.filter((r) => String(r.idempotency_key).startsWith('example:30:'))
    expect(examples).toHaveLength(5)
    // labels only with the first five (the storm adds nothing new)
    expect(rows.filter((r) => r.op === 'labels')).toHaveLength(5)
    const rollups = rows.filter((r) => String(r.idempotency_key).startsWith('example-rollup:30:'))
    expect(rollups).toHaveLength(1)
    const roll = rollups[0]
    expect(roll.idempotency_key).toMatch(/^example-rollup:30:\d{4}-\d\d-\d\dT\d\d$/)
    expect(roll).toMatchObject({ op: 'comment', status: 'pending', link: 30 })
    // waits for the end of the hour so the whole storm is in one note
    expect(new Date(roll.next_attempt_at).getTime()).toBeGreaterThan(Date.now())
    const body = JSON.parse(roll.payload).body as string
    for (let i = 105; i < 112; i++)
      expect(body).toContain(`[Nivaro issue ${i}](https://nivaro.test/issues/${i})`)
    expect(body).toContain('7 more Nivaro issues')
    expect(body).not.toMatch(/#\d/)
    expect(body.trim().split('\n').pop()).toBe('<!-- nivaro:rollup:30 -->')
    // a repeat join of an issue already rolled up adds nothing
    await joinAsExample(111, 1, { link_id: 30 }, 'similar', 0.9)
    expect(JSON.parse(roll.payload).issues).toHaveLength(7)
  })

  it('a roll-up lists at most 50 issues, then counts', () => {
    const many = Array.from({ length: 53 }, (_, i) => ({
      id: i + 1,
      url: `https://n.test/${i + 1}`
    }))
    const body = rollupNoteBody(4, many)
    expect(body.match(/\[Nivaro issue/g)).toHaveLength(50)
    expect(body).toContain('- +3 more')
  })

  it('refuses a link of another connection and an issue linked elsewhere', async () => {
    addLink(30, { connection: 2 })
    await expect(joinAsExample(5, 1, { link_id: 30 }, 'manual')).rejects.toMatchObject({
      status: 404
    })
    addLink(31)
    addLink(32)
    addMemberRow(31, 5)
    await expect(joinAsExample(5, 1, { link_id: 32 }, 'manual')).rejects.toMatchObject({
      status: 409,
      code: 'ALREADY_LINKED'
    })
  })
})

describe('exampleNoteBody', () => {
  it('exampleNoteBody neutralises /close and @mentions', () => {
    const body = exampleNoteBody({
      issue_id: 5,
      title: '/close @ann\n/assign @bob',
      route: '/items/x @team',
      first_seen: '2026-11-16T10:00:00.000Z',
      hits_24h: 4,
      people_24h: 2,
      details: `/close\n@ann <!-- nivaro:issue:6 -->\n\`\`\`\n${'d'.repeat(2000)}`,
      nivaro_url: 'https://nivaro.test/issues/5',
      score: 0.912
    })
    expect(body).not.toMatch(/^\s*\/(close|assign)/m)
    expect(body).not.toMatch(/@(ann|bob|team)/)
    expect(body).not.toContain('<!-- nivaro:issue:6')
    expect(body).toContain('(91% similar)')
    expect(body).toContain('[Open in Nivaro](https://nivaro.test/issues/5)')
    expect(body).toContain('4 hits by 2 people')
    // details fenced and cut to 1500 characters
    expect(body).toContain('````\n')
    expect(body).not.toContain('d'.repeat(1500))
    const lines = body.trim().split('\n')
    expect(lines[lines.length - 1]).toBe('<!-- nivaro:example:5 -->')
    expect(exampleNoteBody({ ...minimal(), details: null })).not.toContain('```')
  })
})

function minimal() {
  return {
    issue_id: 9,
    title: 'x',
    route: null,
    first_seen: '',
    hits_24h: 0,
    people_24h: 0,
    details: null,
    nivaro_url: 'https://nivaro.test/issues/9'
  }
}
