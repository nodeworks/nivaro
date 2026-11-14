import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

// Rob 2026-11-14: a View-as tab (nvm_) acts EXACTLY as the person. The administrator behind it is
// stored beside the write and shown to ADMINISTRATORS ONLY ("Rob Lee as David Pry"); everyone
// else — the person included — reads it exactly as the person's own write.

const probe = vi.hoisted(() => ({ has: false, activity: true }))
vi.mock('../../../lib/column-probe.js', () => ({
  hasColumn: vi.fn(async (_t: string, c: string) =>
    c === 'acting_admin' ? probe.has : c === 'actor' || c === 'auth_method' ? probe.activity : false
  )
}))

import { db } from '../../../db/index.js'
import { resolveActivityStamp } from '../../../services/activity-scope.js'
import { renderActivitySentence } from '../../../services/activity-sentence.js'
import { beginTrace, clearTrace } from '../../../services/request-trace.js'
import {
  currentViewAsAdmin,
  hideViewAsActor,
  viewAsAdminOf,
  viewAsColumns,
  viewAsCreators
} from '../../../services/view-as-attribution.js'

const ADMIN = 'A0000000-0000-4000-8000-0000000000AD'
const DAVID = 'D0000000-0000-4000-8000-00000000DA71'

const viewAsReq = { authMethod: 'masquerade', masqueradeAdminId: ADMIN }
const runAsKeyReq = { authMethod: 'key_sim', masqueradeAdminId: ADMIN }
const ownSession = { authMethod: 'session' }

afterEach(() => {
  probe.has = false
  probe.activity = true
  clearTrace()
})

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

describe('viewAsColumns — the history stamp (migration 527, feature-detected)', () => {
  it('stamps acting_admin under View-as once the column exists', async () => {
    probe.has = true
    expect(await viewAsColumns('nivaro_workflow_history', viewAsReq)).toEqual({
      acting_admin: ADMIN
    })
  })

  it('stores nothing (and still works) on a database behind the migration', async () => {
    probe.has = false
    expect(await viewAsColumns('nivaro_workflow_history', viewAsReq)).toEqual({})
  })

  it('stores nothing for the admin’s own session or a run-as-key, column or not', async () => {
    probe.has = true
    expect(await viewAsColumns('nivaro_workflow_history', ownSession)).toEqual({})
    expect(await viewAsColumns('nivaro_workflow_history', runAsKeyReq)).toEqual({})
  })

  it('reads the traced request (services stamp without a request parameter)', async () => {
    probe.has = true
    beginTrace('/api/x', viewAsReq as never)
    expect(await viewAsColumns('nivaro_workflow_history')).toEqual({ acting_admin: ADMIN })
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

describe('guard: every pipeline history insert carries the View-as stamp', () => {
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
  it('chainFields(history) is always followed by viewAsColumns(history)', () => {
    const missing: string[] = []
    let sites = 0
    for (const file of walk(root)) {
      const lines = readFileSync(file, 'utf8').split('\n')
      lines.forEach((line, i) => {
        if (!line.includes("chainFields('nivaro_workflow_history')")) return
        sites++
        const near = lines.slice(i, i + 4).join('\n')
        if (!near.includes("viewAsColumns('nivaro_workflow_history')"))
          missing.push(`${file.slice(root.length + 1)}:${i + 1}`)
      })
    }
    expect(sites).toBeGreaterThanOrEqual(13)
    expect(missing).toEqual([])
  })
})
