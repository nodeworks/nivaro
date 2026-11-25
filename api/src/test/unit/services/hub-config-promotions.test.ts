import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub config promotion (idea 30), Hub side, against real SQLite rows: plan → apply → undo, and
// every gate an apply or undo meets — typed confirm (production for an apply, always for an undo),
// freezes / deploy windows and the checklist judged UNDER the lock, an open move, the lock itself,
// a plan that went stale, Changed-here hits, expiry, a lost answer (never "nothing written"
// without the target's word) and undo of the newest promotion only. The two apps are fakes behind
// the channel seam: the test proves what the Hub sends them.

vi.mock('../../../db/index.js', async () => {
  const knex = (await import('knex')).default
  const { sqliteAfterCreate, sqliteCompat } = await import('../../../db/sqlite.js')
  sqliteCompat()
  const db = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: { min: 1, max: 1, afterCreate: sqliteAfterCreate }
  })
  return { db }
})

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const m542 = await import('../../../db/migrations/542_hub_tables.js')
const m575 = await import('../../../db/migrations/575_hub_config_promotions.js')
const { memoryPromoteLock } = await import('../../../services/hub/promote-lock.js')
const P = await import('../../../services/hub/config/promotions.js')
const { ConfigPromotionError, PROMOTIONS } = await import('../../../services/hub/config/types.js')
type Deps = import('../../../services/hub/config/promotions.js').ConfigDeps

const H = (c: string) => c.repeat(64)
const PLAN = H('a')
const UNDO = H('b')

const calls: Array<{ env: number; name: string; body: Record<string, unknown> }> = []
const app = {
  applyError: null as InstanceType<typeof ConfigPromotionError> | null,
  undoError: null as InstanceType<typeof ConfigPromotionError> | null,
  status: 'applied' as 'applied' | 'not_applied' | 'unreachable',
  /** When set, each status call takes the next state (the last one repeats). */
  states: [] as string[],
  /** Run on each status call (the lock is checked while the Hub waits). */
  onStatus: null as null | (() => Promise<void>),
  prodOnly: false
}

function preview(hash: string) {
  return {
    plan_hash: hash,
    totals: { inserts: 1, updates: 1, deletes: 0, tables: 1, skipped_inactive_user: 0 },
    tables: [
      {
        table: 'nivaro_roles',
        inserts: 1,
        updates: 1,
        deletes: 0,
        unchanged: 3,
        more: 0,
        dropped_columns: [],
        rows: [
          {
            key: '7',
            op: 'update',
            label: 'Editor',
            fields: [{ field: 'description', now: 'old', was: 'new' }]
          }
        ]
      }
    ],
    cascade: [],
    over_cap: false,
    cap: 2000
  }
}

const applied = {
  run_key: 'x',
  result: {
    pre_restore_id: 91,
    totals: { inserted: 1, updated: 1, deleted: 0 },
    tables: [{ table: 'nivaro_roles', inserted: 1, updated: 1, deleted: 0 }]
  },
  procedures: [{ name: 'usp_x', ok: false }],
  needs_setup: [{ flow: 'Order submitted', step: 'Notify partner', reason: 'Set url' }],
  baseline: 'moved'
}

const channel = async (env: number) => ({
  kind: 'dedicated' as const,
  async call(name: string, body: unknown) {
    calls.push({ env, name, body: body as Record<string, unknown> })
    if (name === 'snapshot')
      return {
        version: '0.3.215',
        snapshot: { format: 1, tables: {} },
        refs: { external_api: { '3': 'MDSi' } },
        stripped: { nivaro_flow_operations: { o: ['url'] } }
      }
    if (name === 'plan')
      return {
        version: '0.3.215',
        preview: preview(PLAN),
        engine_hash: H('e'),
        procs_hash: H('f'),
        refused: [],
        kept: [],
        held: [],
        switched_off: [],
        needs_setup: [],
        prod_only_changes: app.prodOnly ? [{ id: 'x' }] : [],
        prod_only_lines: app.prodOnly ? ['nivaro_roles #7 changed here'] : [],
        prod_only_refuse: app.prodOnly,
        warnings: []
      }
    if (name === 'apply') {
      if (app.applyError) throw app.applyError
      return applied
    }
    if (name === 'status') {
      await app.onStatus?.()
      if (app.states.length) {
        const state = app.states.length > 1 ? app.states.shift() : app.states[0]
        return {
          state,
          running: state === 'applying' || state === 'deploying',
          stalled: false,
          answer: state === 'applied' ? applied : null,
          error: state === 'failed' ? 'refused at the door' : null,
          newest: state === 'applied'
        }
      }
      if (app.status === 'unreachable') throw new ConfigPromotionError('APP_UNREACHABLE', 'no', 502)
      return app.status === 'applied'
        ? { state: 'applied', answer: applied, newest: true }
        : { state: 'not_applied', answer: null, newest: false }
    }
    if (name === 'undo') {
      if (app.undoError) throw app.undoError
      const b = body as { mode: string }
      if (b.mode === 'preview')
        return { mode: 'preview', preview: preview(UNDO), engine_hash: H('c'), procs_hash: H('d') }
      return {
        mode: 'apply',
        result: { totals: { inserted: 0, updated: 1, deleted: 1 } },
        procedures: []
      }
    }
    throw new Error(`unexpected ${name}`)
  }
})

const notices: Array<{ kind: string; text?: { subject: string; message: string } | null }> = []
const gateCalls: string[] = []
let production = false
let frozen = false
let windowShut = false
let moving = false
let checklistNeeded = false
let switchOn = true
let now = Date.parse('2026-11-25T12:00:00Z')
const lock = memoryPromoteLock
const links: Array<[string, number]> = []
let released = 0

const deps = (): Deps => ({
  channel,
  lock,
  production: async () => production,
  window: async (_e, action, o) => {
    gateCalls.push(`window:${action}:${o.skipWindows ? 'skip' : 'judge'}`)
    if (action === 'config_undo') return null
    if (frozen) return { status: 409, code: 'FROZEN', message: 'Promotions are frozen' }
    if (windowShut && !o.skipWindows)
      return { status: 409, code: 'OUTSIDE_WINDOW', message: 'Outside the window' }
    return null
  },
  moveOpen: async () => {
    gateCalls.push(`move:${(await lock.held(11)) ? 'locked' : 'free'}`)
    return moving ? { status: 409, code: 'MOVE_OPEN', message: 'A move is open' } : null
  },
  checklist: async (_e, _id, runId) => {
    if (!checklistNeeded) return null
    if (runId !== 5)
      throw Object.assign(new Error('Tick it'), { code: 'CHECKLIST_REQUIRED', status: 409 })
    return {
      runId: 5,
      link: async (kind: string, id: number) => {
        links.push([kind, id])
      },
      release: async () => {
        released++
      }
    }
  },
  outsideWindow: async () => {
    gateCalls.push('outside-recorded')
  },
  notify: (e) => notices.push(e as never),
  enabled: async () => switchOn,
  now: () => now,
  // The Hub's wait after a lost answer: each poll moves the clock on (no real sleeping).
  sleep: async (ms) => {
    now += ms
  },
  pollMs: 5_000,
  pollDeadlineMs: 15 * 60_000,
  notAppliedWindowMs: 2 * 60_000
})

beforeAll(async () => {
  await m542.up(db)
  await m575.up(db)
  await m575.up(db) // guarded: a second run changes nothing
  await db('nivaro_hub_apps').insert({ id: 1, key: 'efp', name: 'EFP' })
  await db('nivaro_hub_apps').insert({ id: 2, key: 'other', name: 'Other' })
  await db('nivaro_hub_environments').insert([
    {
      id: 10,
      app_id: 1,
      key: 'staging',
      position: 1,
      base_url: 'https://s.test',
      status: 'active'
    },
    {
      id: 11,
      app_id: 1,
      key: 'production',
      position: 2,
      base_url: 'https://p.test',
      status: 'active'
    },
    { id: 12, app_id: 2, key: 'dev', position: 1, base_url: 'https://o.test', status: 'active' },
    { id: 13, app_id: 1, key: 'old', position: 3, base_url: 'https://x.test', status: 'archived' }
  ])
})
afterAll(async () => {
  await db.destroy()
})
beforeEach(async () => {
  await db(PROMOTIONS).del()
  calls.length = 0
  notices.length = 0
  gateCalls.length = 0
  links.length = 0
  released = 0
  production = false
  frozen = false
  windowShut = false
  moving = false
  checklistNeeded = false
  switchOn = true
  app.applyError = null
  app.undoError = null
  app.status = 'applied'
  app.states = []
  app.onStatus = null
  app.prodOnly = false
  now = Date.parse('2026-11-25T12:00:00Z')
})

const plan = (over: Partial<Parameters<typeof P.planPromotion>[0]> = {}) =>
  P.planPromotion(
    {
      appId: 1,
      sourceEnvId: 10,
      targetEnvId: 11,
      groups: ['roles'],
      deletes: false,
      allowCascade: false,
      userId: '00000000-0000-0000-0000-000000000001',
      ...over
    },
    deps()
  )

const apply = (id: number, over: Partial<Parameters<typeof P.applyPromotion>[0]> = {}) =>
  P.applyPromotion(
    {
      id,
      planHash: PLAN,
      confirm: 'production',
      overwriteProdChanges: false,
      userId: '00000000-0000-0000-0000-000000000002',
      actor: 'Rob',
      ...over
    },
    deps()
  )

const undo = (id: number, over: Partial<Parameters<typeof P.applyUndo>[0]> = {}) =>
  P.applyUndo(
    {
      id,
      planHash: UNDO,
      confirm: 'production',
      overwriteProdChanges: false,
      userId: null,
      ...over
    },
    deps()
  )

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (e) {
    if (e instanceof ConfigPromotionError) return e.code
    throw e
  }
  return 'NOT_REFUSED'
}

describe('plan', () => {
  it('reads the source, has the target plan it with a run key, stores the field diff', async () => {
    const p = await plan()
    expect(p.status).toBe('planned')
    expect(p.plan_hash).toBe(PLAN)
    expect(p.run_key).toMatch(/^[A-Za-z0-9_-]{24}$/)
    expect(p.tables).toEqual(['nivaro_roles', 'nivaro_policies'])
    expect(calls.map((c) => [c.env, c.name])).toEqual([
      [10, 'snapshot'],
      [11, 'plan']
    ])
    expect(calls[1].body).toMatchObject({
      run_key: p.run_key,
      refs: { external_api: { '3': 'MDSi' } },
      stripped: { nivaro_flow_operations: { o: ['url'] } },
      source_label: 'efp/staging'
    })
    expect(p.plan?.hashes).toEqual({ engine: H('e'), procs: H('f') })
    expect(p.plan?.tables[0].rows[0].fields[0]).toEqual({
      field: 'description',
      current: 'old',
      incoming: 'new'
    })
  })

  it('refuses other apps’ environments, archived ones, the same one, unknown groups', async () => {
    expect(await code(plan({ targetEnvId: 12 }))).toBe('NOT_FOUND')
    expect(await code(plan({ targetEnvId: 13 }))).toBe('ARCHIVED')
    expect(await code(plan({ targetEnvId: 10 }))).toBe('SAME_ENVIRONMENT')
    expect(await code(plan({ groups: ['roles', 'layouts'] }))).toBe('BAD_GROUPS')
    expect(calls).toEqual([])
  })

  it('a newer plan for the same target supersedes the older one', async () => {
    const a = await plan()
    await plan()
    expect((await P.getPromotion(a.id))?.status).toBe('superseded')
    expect(await code(apply(a.id))).toBe('NOT_PLANNED')
  })
})

describe('apply', () => {
  it('production needs the key; gates run under the lock; the run key and hashes are sent', async () => {
    production = true
    const p = await plan()
    expect(await code(apply(p.id, { confirm: 'prod' }))).toBe('CONFIRM_REQUIRED')
    calls.length = 0
    gateCalls.length = 0
    const done = await apply(p.id)
    expect(done.status).toBe('applied')
    expect(gateCalls).toEqual(['move:locked', 'window:config_apply:judge'])
    expect(calls.map((c) => c.name)).toEqual(['snapshot', 'apply'])
    expect(calls[1].body).toMatchObject({
      run_key: p.run_key,
      plan_hash: PLAN,
      engine_hash: H('e'),
      procs_hash: H('f'),
      promotion_id: p.id,
      actor: 'Rob'
    })
    expect(done.undo_ready).toBe(true)
    expect((done.result as { procedures: { failed: string[] } }).procedures.failed).toEqual([
      'usp_x'
    ])
    // A procedure that failed and steps to set up are said in the notice.
    expect(notices.at(-1)?.kind).toBe('promote_failed')
    expect(notices.at(-1)?.text?.message).toMatch(/usp_x/)
    expect(notices.at(-1)?.text?.message).toMatch(/Order submitted → Notify partner/)
  })

  it('freezes, windows and open moves refuse; an emergency start skips the windows only', async () => {
    const p = await plan()
    frozen = true
    expect(await code(apply(p.id))).toBe('FROZEN')
    frozen = false
    windowShut = true
    expect(await code(apply(p.id))).toBe('OUTSIDE_WINDOW')
    moving = true
    expect(await code(apply(p.id))).toBe('MOVE_OPEN')
    moving = false
    expect(
      (await apply(p.id, { outsideWindow: { reason: 'Broken login for everyone' } })).status
    ).toBe('applied')
    expect(gateCalls).toContain('window:config_apply:skip')
    expect(gateCalls).toContain('outside-recorded')
  })

  it('the lock, the plan hash and expiry refuse before anything is sent', async () => {
    const p = await plan()
    expect(await code(apply(p.id, { planHash: H('9') }))).toBe('PLAN_CHANGED')
    const token = await lock.take(11, 'promotion')
    expect(await code(apply(p.id))).toBe('PROMOTION_RUNNING')
    if (token) await lock.release(11, token)
    now += P.PLAN_TTL_MS + 1
    expect(await code(apply(p.id))).toBe('PLAN_EXPIRED')
    expect(calls.filter((c) => c.name === 'apply')).toEqual([])
  })

  it('the production checklist is claimed and linked to the promotion', async () => {
    checklistNeeded = true
    const p = await plan()
    expect(await code(apply(p.id))).toBe('CHECKLIST_REQUIRED')
    expect((await P.getPromotion(p.id))?.status).toBe('planned')
    await apply(p.id, { checklistRunId: 5 })
    expect(links).toEqual([['config', p.id]])
  })

  it('Changed-here hits the target refuses need the explicit overwrite', async () => {
    app.prodOnly = true
    const p = await plan()
    expect(await code(apply(p.id))).toBe('PROD_ONLY_CHANGES')
    expect((await apply(p.id, { overwriteProdChanges: true })).status).toBe('applied')
  })

  it('the target answering STALE marks the plan stale; a refusal says it wrote nothing', async () => {
    const p = await plan()
    app.applyError = new ConfigPromotionError('STALE', 'Configuration changed', 409)
    expect(await code(apply(p.id))).toBe('STALE')
    expect((await P.getPromotion(p.id))?.status).toBe('stale')
    expect(notices.at(-1)?.text?.message).toMatch(/wrote nothing/)
    expect(await lock.held(11)).toBe(false)
  })

  it('a busy target keeps the plan (and gives the checklist back)', async () => {
    checklistNeeded = true
    const p = await plan()
    app.applyError = new ConfigPromotionError('BUSY', 'Another config restore is running', 409)
    expect(await code(apply(p.id, { checklistRunId: 5 }))).toBe('BUSY')
    expect((await P.getPromotion(p.id))?.status).toBe('planned')
    expect(released).toBe(1)
  })
})

describe('a lost answer (M4)', () => {
  it('the target says it applied → applied, with its own counts', async () => {
    const p = await plan()
    app.applyError = new ConfigPromotionError(
      'APP_UNREACHABLE',
      'The app did not answer in time.',
      502
    )
    const out = await apply(p.id)
    expect(out.status).toBe('applied')
    expect(calls.map((c) => c.name)).toContain('status')
    expect(calls.find((c) => c.name === 'status')?.body).toEqual({
      run_key: p.run_key,
      resume: true
    })
  })

  it('a timeout mid-apply: interrupted while the target runs, then applied — lock held throughout (N1)', async () => {
    const p = await plan()
    app.applyError = new ConfigPromotionError('APP_UNREACHABLE', 'timed out', 502)
    app.states = ['applying', 'applying', 'deploying', 'applied']
    const seen: Array<{ held: boolean; status: string | undefined }> = []
    app.onStatus = async () => {
      seen.push({
        held: !!(await lock.held(11)),
        status: (await db(PROMOTIONS).where({ id: p.id }).first('status'))?.status
      })
    }
    const out = await apply(p.id)
    expect(out.status).toBe('applied')
    expect(seen.length).toBe(4)
    expect(seen.every((x) => x.held)).toBe(true)
    expect(seen.every((x) => x.status === 'interrupted')).toBe(true)
    expect(await lock.held(11)).toBe(false)
    // Polls kept the Hub's heartbeat fresh; the done notice went out once.
    expect(out.heartbeat_at).not.toBeNull()
    expect(
      notices.filter((n) => n.kind === 'promote_failed' || n.kind === 'promote_done')
    ).toHaveLength(1)
  })

  it('not_applied inside the window is not an answer: the request was still on its way (N1)', async () => {
    const p = await plan()
    app.applyError = new ConfigPromotionError('APP_UNREACHABLE', 'timed out', 502)
    app.states = ['not_applied', 'not_applied', 'applying', 'applied']
    const out = await apply(p.id)
    expect(out.status).toBe('applied')
  })

  it('the target answers failed (nothing committed) → failed with its reason', async () => {
    const p = await plan()
    app.applyError = new ConfigPromotionError('APP_UNREACHABLE', 'timed out', 502)
    app.states = ['applying', 'failed']
    const out = await apply(p.id)
    expect(out.status).toBe('failed')
    expect(out.error).toMatch(/confirms it wrote nothing.*refused at the door/)
  })

  it('Check the target while it still runs says so; it never marks failed (N1)', async () => {
    const p = await plan()
    await db(PROMOTIONS).where({ id: p.id }).update({ status: 'interrupted' })
    app.states = ['deploying']
    expect(await code(P.reconcilePromotion(p.id, deps()))).toBe('STILL_RUNNING')
    expect((await P.getPromotion(p.id))?.status).toBe('interrupted')
    expect(calls.at(-1)?.body).toMatchObject({ resume: true })
  })

  it('after an env refresh the check says unknown, never failed; undo is gone', async () => {
    const p = await apply((await plan()).id)
    expect(p.undo_ready).toBe(true)
    app.status = 'not_applied'
    const out = await P.reconcilePromotion(p.id, deps())
    expect(out.status).toBe('applied')
    expect(out.error).toMatch(/Unknown on the target.*refreshed/)
    expect(out.run_key).toBeNull()
    expect(out.undo_ready).toBe(false)
  })

  it('a row whose Hub heartbeat stopped heals to interrupted; a fresh one is left alone', () => {
    const t = Date.parse('2026-11-25T12:00:00Z')
    const started = new Date(t - 60 * 60_000).toISOString()
    expect(
      P.healedStatus(
        {
          status: 'applying',
          started_at: started,
          heartbeat_at: new Date(t - 30_000).toISOString()
        },
        t
      )
    ).toBeNull()
    expect(
      P.healedStatus(
        {
          status: 'applying',
          started_at: started,
          heartbeat_at: new Date(t - 3 * 60_000).toISOString()
        },
        t
      )
    ).toBe('interrupted')
    expect(P.healedStatus({ status: 'undoing', started_at: started, heartbeat_at: null }, t)).toBe(
      'applied'
    )
  })

  it('the target confirms nothing was written → failed, saying so', async () => {
    const p = await plan()
    app.applyError = new ConfigPromotionError('CONFIG_PROMOTE_FAILED', 'x', 502)
    app.status = 'not_applied'
    const out = await apply(p.id)
    expect(out.status).toBe('failed')
    expect(out.error).toMatch(/confirms it wrote nothing/)
  })

  it('no word from the target → interrupted, never “nothing written”; check later', async () => {
    const p = await plan()
    app.applyError = new ConfigPromotionError('APP_UNREACHABLE', 'no', 502)
    app.status = 'unreachable'
    expect(await code(apply(p.id))).toBe('INTERRUPTED')
    const got = await P.getPromotion(p.id)
    expect(got?.status).toBe('interrupted')
    expect(got?.error).toMatch(/may have written/)
    expect(notices.at(-1)?.text?.message).not.toMatch(/nothing/i)
    app.status = 'applied'
    expect((await P.reconcilePromotion(p.id, deps())).status).toBe('applied')
  })
})

describe('undo', () => {
  it('previews, then puts back the rows bound to its own hash; typed key always', async () => {
    const p = await apply((await plan()).id)
    gateCalls.length = 0
    expect(await code(undo(p.id))).toBe('PLAN_CHANGED')
    const pv = await P.previewUndo(p.id, deps())
    expect(pv.plan_hash).toBe(UNDO)
    expect(calls.at(-1)?.body).toEqual({ mode: 'preview', run_key: p.run_key })
    // Not production, still typed.
    expect(await code(undo(p.id, { confirm: '' }))).toBe('CONFIRM_REQUIRED')
    moving = true
    expect(await code(undo(p.id))).toBe('MOVE_OPEN')
    moving = false
    // A freeze or a closed window never stops an undo.
    frozen = true
    windowShut = true
    const done = await undo(p.id)
    expect(done.status).toBe('undone')
    expect(calls.at(-1)?.body).toMatchObject({
      mode: 'apply',
      run_key: p.run_key,
      plan_hash: UNDO,
      engine_hash: H('c'),
      procs_hash: H('d')
    })
    // The undo judged no freeze and no window.
    expect(gateCalls.filter((g) => g.startsWith('window'))).toEqual([])
  })

  it('only the newest promotion of an environment can be undone', async () => {
    const a = await apply((await plan()).id)
    const b = await apply((await plan()).id)
    expect((await P.getPromotion(a.id))?.undo_ready).toBe(false)
    expect((await P.getPromotion(b.id))?.undo_ready).toBe(true)
    expect(await code(P.previewUndo(a.id, deps()))).toBe('NOT_NEWEST')
  })

  it('a refused undo leaves the promotion applied, saying why', async () => {
    const p = await apply((await plan()).id)
    await P.previewUndo(p.id, deps())
    app.undoError = new ConfigPromotionError('STALE', 'Rows changed since', 409)
    expect(await code(undo(p.id))).toBe('STALE')
    const got = await P.getPromotion(p.id)
    expect(got?.status).toBe('applied')
    expect(got?.error).toMatch(/Rows changed since/)
  })
})

describe('heal', () => {
  it('an apply a stopped server left reads as interrupted after the stuck window', async () => {
    const p = await plan()
    await db(PROMOTIONS)
      .where({ id: p.id })
      .update({ status: 'applying', started_at: new Date(now - P.STUCK_MS - 1000) })
    const got = await P.getPromotion(p.id, now)
    expect(got?.status).toBe('interrupted')
    expect(got?.error).toMatch(/Check the target/)
  })

  it('healedStatus is pure and leaves fresh rows alone', () => {
    const t = '2026-11-25T12:00:00.000Z'
    expect(P.healedStatus({ status: 'undoing', started_at: t }, Date.parse(t) + P.STUCK_MS)).toBe(
      'applied'
    )
    expect(P.healedStatus({ status: 'applying', started_at: t }, Date.parse(t) + 1000)).toBeNull()
  })
})

describe('plan view', () => {
  it('refuses an answer without a hash and caps a huge plan by rows, never counts', () => {
    expect(() => P.planViewOf({ preview: {} })).toThrow(ConfigPromotionError)
    const { view } = P.planViewOf({
      preview: preview(PLAN),
      engine_hash: H('e'),
      procs_hash: H('f')
    })
    const big = {
      ...view,
      tables: [
        { ...view.tables[0], rows: Array.from({ length: 50 }, () => view.tables[0].rows[0]) }
      ]
    }
    const capped = JSON.parse(P.cappedPlan(big, 2_000))
    expect(capped.tables[0].rows.length).toBeLessThan(50)
    expect(capped.tables[0].updates).toBe(1)
  })
})

describe('the off switch (config promotion ships off)', () => {
  it('off: a new plan and an apply answer 409 CONFIG_PROMOTION_OFF in plain words', async () => {
    const p = await plan()
    switchOn = false
    const e = await plan().catch((x) => x)
    expect(e).toMatchObject({ code: 'CONFIG_PROMOTION_OFF', status: 409 })
    expect(e.message).toMatch(/off until it has been tried on a staging pair/)
    expect(await code(apply(p.id))).toBe('CONFIG_PROMOTION_OFF')
    expect((await P.getPromotion(p.id))?.status).toBe('planned')
    expect(calls.filter((c) => c.name === 'apply')).toHaveLength(0)
  })

  it('off: Check the target and undo of a promotion that already ran still work', async () => {
    const p = await apply((await plan()).id)
    switchOn = false
    await db(PROMOTIONS).where({ id: p.id }).update({ status: 'interrupted' })
    expect((await P.reconcilePromotion(p.id, deps())).status).toBe('applied')
    const pv = await P.previewUndo(p.id, deps())
    expect(pv.plan_hash).toBe(UNDO)
    expect((await undo(p.id)).status).toBe('undone')
  })
})
