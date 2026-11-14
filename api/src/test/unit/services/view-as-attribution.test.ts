import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import knex from 'knex'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Rob 2026-11-14: a View-as tab (nvm_) acts EXACTLY as the person. The administrator behind it is
// stored beside the write and shown to ADMINISTRATORS ONLY ("Rob Lee as David Pry"); everyone
// else — the person included — reads it exactly as the person's own write.

const probe = vi.hoisted(() => ({ activity: true }))
vi.mock('../../../lib/column-probe.js', () => ({
  hasColumn: vi.fn(async (_t: string, c: string) =>
    c === 'actor' || c === 'auth_method' ? probe.activity : false
  )
}))
const logged = vi.hoisted(() => ({ calls: [] as Array<Record<string, unknown>> }))
vi.mock('../../../services/activity.js', () => ({
  logActivity: vi.fn(async (opts: Record<string, unknown>) => {
    logged.calls.push(opts)
    return 99
  })
}))

import { db } from '../../../db/index.js'
import { activityListSource } from '../../../services/activity-filters.js'
import { resolveActivityStamp } from '../../../services/activity-scope.js'
import { renderActivitySentence } from '../../../services/activity-sentence.js'
import { beginTrace, clearTrace } from '../../../services/request-trace.js'
import {
  currentViewAsAdmin,
  hideViewAsActor,
  noteViewAsHistory,
  recordViewAsHistory,
  VIEW_AS_MOVE_ACTION,
  viewAsAdminOf,
  viewAsCreators,
  viewAsMovesFor
} from '../../../services/view-as-attribution.js'

const ADMIN = 'A0000000-0000-4000-8000-0000000000AD'
const DAVID = 'D0000000-0000-4000-8000-00000000DA71'

const viewAsReq = { authMethod: 'masquerade', masqueradeAdminId: ADMIN, user: { id: DAVID } }
const runAsKeyReq = { authMethod: 'key_sim', masqueradeAdminId: ADMIN }
const ownSession = { authMethod: 'session' }

afterEach(() => {
  probe.activity = true
  logged.calls.length = 0
  vi.mocked(db as unknown as (t: string) => unknown).mockReset()
  clearTrace()
})

type Rows = Record<string, Array<Record<string, unknown>>>
/** A db mock answering each table's rows (filters ignored); records the tables asked. */
function wire(tables: Rows): string[] {
  const asked: string[] = []
  vi.mocked(db as unknown as (t: string) => unknown).mockImplementation((t: string) => {
    asked.push(t)
    const rows = tables[t] ?? []
    const chain: Record<string, unknown> = {}
    for (const m of ['where', 'orWhere', 'whereIn', 'orderBy']) chain[m] = vi.fn(() => chain)
    chain.first = vi.fn(async () => rows[0])
    chain.select = vi.fn(() => {
      const p = Promise.resolve(rows) as Promise<unknown> & { catch: unknown }
      return p
    })
    return chain
  })
  return asked
}

describe('who is behind a request', () => {
  it('names the administrator only for a View-as (nvm_) request', () => {
    expect(viewAsAdminOf(viewAsReq)).toBe(ADMIN)
    expect(viewAsAdminOf(ownSession)).toBeNull()
    // Run-as-key also carries masqueradeAdminId — it is not View-as and stamps nothing.
    expect(viewAsAdminOf(runAsKeyReq)).toBeNull()
    expect(viewAsAdminOf(null)).toBeNull()
  })

  it('reads the request the current trace serves when none is handed in', () => {
    beginTrace('/api/pipelines/instance/x/1/transition', viewAsReq as never)
    expect(currentViewAsAdmin()).toBe(ADMIN)
    beginTrace('/api/pipelines/instance/x/1/transition', ownSession as never)
    expect(currentViewAsAdmin()).toBeNull()
  })
})

describe('a View-as pipeline move — its own attribution activity row (no schema change)', () => {
  const tables: Rows = {
    nivaro_workflow_history: [{ id: 41 }],
    nivaro_workflow_instances: [{ collection: 'inventory_request', item: 37713 }],
    nivaro_workflow_states: [
      { id: 'S-REV', key: 'review' },
      { id: 'S-WH', key: 'warehouse' }
    ]
  }

  it('logs ONE view-as-move row on the history row, naming the record and state keys', async () => {
    wire(tables)
    const id = await recordViewAsHistory(
      { instance: 'i-1', from_state: 'S-REV', to_state: 'S-WH', history_id: 41 },
      viewAsReq
    )
    expect(id).toBe(99)
    expect(logged.calls).toHaveLength(1)
    const row = logged.calls[0]
    expect(row).toMatchObject({
      action: 'view-as-move',
      user: DAVID,
      collection: 'nivaro_workflow_history',
      item: '41'
    })
    expect(JSON.parse(String(row.comment))).toEqual({
      collection: 'inventory_request',
      item: '37713',
      from: 'review',
      to: 'warehouse'
    })
    // logActivity gets the request: its actor is {kind:'view_as', id:<admin>, on_behalf_of:<person>}.
    expect(row.req).toBe(viewAsReq)
    expect(resolveActivityStamp({ req: viewAsReq as never, user: DAVID }).actor).toEqual({
      kind: 'view_as',
      id: ADMIN,
      name: null,
      on_behalf_of: DAVID
    })
  })

  it('finds the history row when the insert did not return its id', async () => {
    wire(tables)
    await recordViewAsHistory({ instance: 'i-1', from_state: null, to_state: 'S-WH' }, viewAsReq)
    expect(logged.calls[0]?.item).toBe('41')
  })

  it('an ordinary move (own session, run-as-key) writes nothing and reads nothing', async () => {
    const asked = wire(tables)
    noteViewAsHistory({ instance: 'i-1', to_state: 'S-WH', history_id: 41 }, ownSession)
    noteViewAsHistory({ instance: 'i-1', to_state: 'S-WH', history_id: 41 }, runAsKeyReq)
    beginTrace('/api/x', ownSession as never)
    noteViewAsHistory({ instance: 'i-1', to_state: 'S-WH', history_id: 41 })
    await new Promise((r) => setTimeout(r, 10))
    expect(asked).toEqual([])
    expect(logged.calls).toEqual([])
  })

  it('under View-as it fires in the background off the traced request', async () => {
    wire(tables)
    beginTrace('/api/pipelines/instance/x/1/transition', viewAsReq as never)
    noteViewAsHistory({ instance: 'i-1', from_state: 'S-REV', to_state: 'S-WH', history_id: 41 })
    for (let i = 0; i < 20 && logged.calls.length === 0; i++)
      await new Promise((r) => setTimeout(r, 5))
    expect(logged.calls.map((c) => c.action)).toEqual(['view-as-move'])
  })

  it('an admin reader finds the administrator behind each move by history id', async () => {
    wire({
      nivaro_activity: [
        { item: '41', actor: JSON.stringify({ kind: 'view_as', id: ADMIN, on_behalf_of: DAVID }) }
      ],
      nivaro_users: [{ id: ADMIN, first_name: 'Rob', last_name: 'Lee', email: 'r@x.test' }]
    })
    const moves = await viewAsMovesFor([41, 42, null])
    expect(moves.get('41')).toEqual({ id: ADMIN, name: 'Rob Lee' })
    expect(moves.has('42')).toBe(false)
  })

  it('activity lists never show the attribution row (no duplicate "moved" entry for anyone)', () => {
    // A real knex compiler, never connected.
    const sql = activityListSource(knex({ client: 'mssql' }), true)
      .select('a.id')
      .toSQL()
    expect(sql.sql).toContain('[a].[action] = ?')
    expect(sql.sql.toLowerCase()).toContain('not')
    expect(sql.bindings).toContain(VIEW_AS_MOVE_ACTION)
  })
})

describe('the activity row a View-as write stores (migration 516 actor)', () => {
  it('records the administrator as a view_as actor for the person', () => {
    const stamp = resolveActivityStamp({ req: viewAsReq as never, user: DAVID })
    expect(stamp.actor).toEqual({ kind: 'view_as', id: ADMIN, name: null, on_behalf_of: DAVID })
  })

  it('the admin’s own session stores no actor (a person acting as themselves)', () => {
    expect(resolveActivityStamp({ req: ownSession as never, user: ADMIN }).actor).toBeNull()
  })
})

describe('what a reader sees', () => {
  const labels = {
    users: { [ADMIN]: 'Rob Lee', [DAVID]: 'David Pry' },
    records: { 'workflows:85607': 'Workflow 85607' },
    collections: { workflows: { singular: 'Workflow', plural: 'workflows' } }
  }
  const base = {
    id: 1,
    action: 'update',
    user: DAVID,
    first_name: 'David',
    last_name: 'Pry',
    collection: 'workflows',
    item: '85607'
  }
  const viewAsRow = {
    ...base,
    auth_method: 'masquerade',
    actor: { kind: 'view_as' as const, id: ADMIN, name: null, on_behalf_of: DAVID }
  }
  const ownRow = { ...base, auth_method: 'session', actor: null }

  it('an administrator reads "Rob Lee as David Pry"', () => {
    expect(renderActivitySentence(viewAsRow as never, labels as never)).toMatch(
      /^Rob Lee as David Pry /
    )
  })

  it('a non-administrator reads it exactly like David’s own write', () => {
    const hidden = hideViewAsActor(viewAsRow)
    expect(hidden.auth_method).toBeUndefined()
    expect(JSON.stringify(hidden)).not.toContain(ADMIN)
    expect(renderActivitySentence(hidden as never, labels as never)).toBe(
      renderActivitySentence(ownRow as never, labels as never)
    )
  })

  it('an older row (auth_method only, no stored actor) is hidden the same way', () => {
    const old = { ...base, auth_method: 'masquerade', actor: null }
    // The read side derives the actor before hiding (enrichActivityRow / settleActor).
    const derived = { ...old, actor: { kind: 'view_as', id: null, on_behalf_of: DAVID } }
    const hidden = hideViewAsActor(derived)
    expect(renderActivitySentence(hidden as never, labels as never)).toBe(
      renderActivitySentence(ownRow as never, labels as never)
    )
  })

  it('leaves every other actor alone (API key, assistant, person)', () => {
    const key = { ...base, actor: { kind: 'api_key', id: '9', name: 'Sync' } }
    expect(hideViewAsActor(key)).toBe(key)
    expect(hideViewAsActor(ownRow)).toBe(ownRow)
  })
})

describe('viewAsCreators — a comment’s author line for an administrator reader', () => {
  function wire(tables: Record<string, Array<Record<string, unknown>>>) {
    vi.mocked(db as unknown as (t: string) => unknown).mockImplementation((t: string) => {
      const chain: Record<string, unknown> = {}
      for (const m of ['where', 'orWhere', 'whereIn']) chain[m] = vi.fn(() => chain)
      chain.select = vi.fn(async () => tables[t] ?? [])
      return chain
    })
  }

  it('names the administrator behind a comment written in a View-as tab', async () => {
    wire({
      nivaro_activity: [
        { item: 'c-1', actor: JSON.stringify({ kind: 'view_as', id: ADMIN, on_behalf_of: DAVID }) }
      ],
      nivaro_users: [{ id: ADMIN, first_name: 'Rob', last_name: 'Lee', email: 'r@x.test' }]
    })
    const out = await viewAsCreators('nivaro_comments', ['c-1', 'c-2'])
    expect(out.get('C-1')).toEqual({ id: ADMIN, name: 'Rob Lee' })
    expect(out.has('C-2')).toBe(false)
  })

  it('answers nothing on a database without the activity columns', async () => {
    probe.activity = false
    wire({ nivaro_activity: [{ item: 'c-1', actor: '{"kind":"view_as"}' }] })
    expect((await viewAsCreators('nivaro_comments', ['c-1'])).size).toBe(0)
  })

  it('never throws: a failed read answers nothing (the person alone)', async () => {
    vi.mocked(db as unknown as (t: string) => unknown).mockImplementation(() => {
      throw new Error('boom')
    })
    expect((await viewAsCreators('nivaro_comments', ['c-1'])).size).toBe(0)
  })
})

describe('guard: every pipeline history insert notes a View-as move', () => {
  const root = join(__dirname, '../../..')
  function walk(dir: string): string[] {
    const out: string[] = []
    for (const name of readdirSync(dir)) {
      const p = join(dir, name)
      if (name === 'test' || name === 'migrations') continue
      if (statSync(p).isDirectory()) out.push(...walk(p))
      else if (p.endsWith('.ts') && !p.endsWith('.test.ts')) out.push(p)
    }
    return out
  }
  it('every nivaro_workflow_history insert is followed by noteViewAsHistory()', () => {
    const missing: string[] = []
    let sites = 0
    for (const file of walk(root)) {
      const text = readFileSync(file, 'utf8')
      const lines = text.split('\n')
      // One note per insert, never one note covering two inserts.
      const inserts = text.split("chainFields('nivaro_workflow_history')").length - 1
      const notes = text.split('noteViewAsHistory(').length - 1
      if (inserts > 0 && notes < inserts)
        missing.push(`${file.slice(root.length + 1)}: ${inserts} inserts, ${notes} notes`)
      lines.forEach((line, i) => {
        if (!line.includes("chainFields('nivaro_workflow_history')")) return
        sites++
        // The insert's own statement (and, for a returning insert, the id it reads back).
        const near = lines.slice(i, i + 40).join('\n')
        if (!near.includes('noteViewAsHistory('))
          missing.push(`${file.slice(root.length + 1)}:${i + 1}`)
      })
    }
    expect(sites).toBeGreaterThanOrEqual(13)
    expect(missing).toEqual([])
  })
})
