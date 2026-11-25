import type { Knex } from 'knex'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

// Hub config promotion (idea 30), Hub side, against real SQLite rows: plan → apply → undo, and
// every gate an apply or undo meets (typed confirm on production, freeze, change-window seam,
// open move, the environment lock, a plan that went stale, Changed-here hits, expiry, heal).
// The two apps are fakes behind the channel seam: the test proves what the Hub sends them.

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

const HASH = 'a'.repeat(64)
const UNDO_HASH = 'b'.repeat(64)

const calls: Array<{ env: number; name: string; body: Record<string, unknown> }> = []
const app = {
  snapshotVersion: 1,
  applyError: null as InstanceType<typeof ConfigPromotionError> | null,
  prodOnly: false
}

function planAnswer(hash = HASH) {
  return {
    version: '0.3.215',
    preview: {
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
    },
    refused: [],
    kept: [],
    held: [],
    switched_off: [],
    prod_only_changes: app.prodOnly ? [{ id: 'x' }] : [],
    prod_only_lines: app.prodOnly ? ['nivaro_roles #7 changed here'] : [],
    prod_only_refuse: app.prodOnly,
    warnings: []
  }
}

const channel = async (env: number) => ({
  kind: 'dedicated' as const,
  async call(name: string, body: unknown) {
    calls.push({ env, name, body: body as Record<string, unknown> })
    if (name === 'snapshot')
      return { version: '0.3.215', snapshot: { format: 1, tables: {}, v: app.snapshotVersion } }
    if (name === 'plan') return planAnswer()
    if (name === 'apply') {
      if (app.applyError) throw app.applyError
      return {
        result: {
          pre_restore_id: 91,
          totals: { inserted: 1, updated: 1, deleted: 0 },
          tables: [{ table: 'nivaro_roles', inserted: 1, updated: 1, deleted: 0 }]
        },
        procedures: null,
        baseline: 'moved'
      }
    }
    if (name === 'undo') {
      const b = body as { mode: string }
      if (b.mode === 'preview') return { preview: { ...planAnswer(UNDO_HASH).preview } }
      return { result: { pre_restore_id: 92, totals: { inserted: 0, updated: 1, deleted: 1 } } }
    }
    throw new Error(`unexpected ${name}`)
  }
})

const notices: Array<{ kind: string; text?: { subject: string } | null }> = []
let production = false
let frozen = false
let windowShut = false
let moving = false
let now = Date.parse('2026-11-25T12:00:00Z')
const lock = memoryPromoteLock

const deps = (): Deps => ({
  channel,
  lock,
  production: async () => production,
  freeze: async (_e, action) =>
    frozen && action === 'config_apply'
      ? { status: 409, code: 'FROZEN', message: 'Promotions are frozen' }
      : null,
  window: async () =>
    windowShut ? { status: 409, code: 'OUTSIDE_WINDOW', message: 'Outside the window' } : null,
  moveOpen: async () =>
    moving ? { status: 409, code: 'MOVE_OPEN', message: 'A move is open' } : null,
  notify: (e) => notices.push(e as never),
  now: () => now
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
  production = false
  frozen = false
  windowShut = false
  moving = false
  app.applyError = null
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
      planHash: HASH,
      confirm: 'production',
      overwriteProdChanges: false,
      userId: '00000000-0000-0000-0000-000000000002',
      actor: 'Rob',
      ...over
    },
    deps()
  )

async function refusedWith(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (e) {
    if (e instanceof ConfigPromotionError) return e.code
    throw e
  }
  return 'NOT_REFUSED'
}

describe('plan', () => {
  it('reads the source, has the target plan it, stores the field diff', async () => {
    const p = await plan()
    expect(p.status).toBe('planned')
    expect(p.plan_hash).toBe(HASH)
    expect(p.tables).toEqual(['nivaro_roles', 'nivaro_policies'])
    expect(calls.map((c) => [c.env, c.name])).toEqual([
      [10, 'snapshot'],
      [11, 'plan']
    ])
    expect(calls[0].body).toEqual({ tables: ['nivaro_roles', 'nivaro_policies'] })
    expect(calls[1].body.source_label).toBe('efp/staging')
    expect(p.plan?.tables[0].group).toBe('roles')
    expect(p.plan?.tables[0].rows[0].fields[0]).toEqual({
      field: 'description',
      current: 'old',
      incoming: 'new'
    })
  })

  it('refuses environments of another app, archived ones, the same one, unknown groups', async () => {
    expect(await refusedWith(plan({ targetEnvId: 12 }))).toBe('NOT_FOUND')
    expect(await refusedWith(plan({ targetEnvId: 13 }))).toBe('ARCHIVED')
    expect(await refusedWith(plan({ targetEnvId: 10 }))).toBe('SAME_ENVIRONMENT')
    expect(await refusedWith(plan({ groups: ['roles', 'schema'] }))).toBe('BAD_GROUPS')
    expect(calls).toEqual([])
  })

  it('refuses while a move of the target is open', async () => {
    moving = true
    expect(await refusedWith(plan())).toBe('MOVE_OPEN')
  })

  it('a newer plan for the same target supersedes the older one', async () => {
    const a = await plan()
    await plan()
    expect((await P.getPromotion(a.id))?.status).toBe('superseded')
    expect(await refusedWith(apply(a.id))).toBe('NOT_PLANNED')
  })
})

describe('apply', () => {
  it('production needs the typed key; then applies bound to the hash, re-reading the source', async () => {
    production = true
    const p = await plan()
    expect(await refusedWith(apply(p.id, { confirm: 'prod' }))).toBe('CONFIRM_REQUIRED')
    calls.length = 0
    const done = await apply(p.id)
    expect(done.status).toBe('applied')
    expect(done.pre_restore_id).toBe(91)
    expect(done.undo_ready).toBe(true)
    expect(calls.map((c) => [c.env, c.name])).toEqual([
      [10, 'snapshot'],
      [11, 'apply']
    ])
    expect(calls[1].body).toMatchObject({
      plan_hash: HASH,
      promotion_id: p.id,
      actor: 'Rob',
      overwrite_prod_changes: false,
      tables: ['nivaro_roles', 'nivaro_policies']
    })
    expect(notices.at(-1)?.kind).toBe('promote_done')
    expect(notices.at(-1)?.text?.subject).toMatch(/Config promoted: efp · production/)
  })

  it('a non-production target needs no typed key', async () => {
    const p = await plan({ sourceEnvId: 11, targetEnvId: 10 })
    expect((await apply(p.id, { confirm: undefined })).status).toBe('applied')
  })

  it('refuses another hash, an expired plan, and every gate', async () => {
    const p = await plan()
    expect(await refusedWith(apply(p.id, { planHash: 'c'.repeat(64) }))).toBe('PLAN_CHANGED')
    frozen = true
    expect(await refusedWith(apply(p.id))).toBe('FROZEN')
    frozen = false
    windowShut = true
    expect(await refusedWith(apply(p.id))).toBe('OUTSIDE_WINDOW')
    windowShut = false
    moving = true
    expect(await refusedWith(apply(p.id))).toBe('MOVE_OPEN')
    moving = false
    const token = await lock.take(11, 'promotion')
    expect(await refusedWith(apply(p.id))).toBe('PROMOTION_RUNNING')
    if (token) await lock.release(11, token)
    now += P.PLAN_TTL_MS + 1
    expect(await refusedWith(apply(p.id))).toBe('PLAN_EXPIRED')
    expect(calls.filter((c) => c.name === 'apply')).toEqual([])
    expect((await P.getPromotion(p.id))?.status).toBe('planned')
  })

  it('Changed-here hits the target refuses need the explicit overwrite', async () => {
    app.prodOnly = true
    const p = await plan()
    expect(p.plan?.prod_only).toMatchObject({ count: 1, refuse: true })
    expect(await refusedWith(apply(p.id))).toBe('PROD_ONLY_CHANGES')
    const done = await apply(p.id, { overwriteProdChanges: true })
    expect(done.status).toBe('applied')
    expect(calls.at(-1)?.body.overwrite_prod_changes).toBe(true)
  })

  it('the target answering STALE marks the plan stale and says so', async () => {
    const p = await plan()
    app.applyError = new ConfigPromotionError('STALE', 'Configuration changed', 409)
    expect(await refusedWith(apply(p.id))).toBe('STALE')
    const after = await P.getPromotion(p.id)
    expect(after?.status).toBe('stale')
    expect(notices.at(-1)?.text?.subject).toMatch(/needs a new plan/)
    expect(await lock.held(11)).toBe(false)
  })

  it('a refusal before any write (the target busy) keeps the plan', async () => {
    const p = await plan()
    app.applyError = new ConfigPromotionError('BUSY', 'Another config restore is running', 409)
    expect(await refusedWith(apply(p.id))).toBe('BUSY')
    expect((await P.getPromotion(p.id))?.status).toBe('planned')
  })

  it('any other failure is failed, urgent', async () => {
    const p = await plan()
    app.applyError = new ConfigPromotionError('FAILED', 'Insert failed', 422)
    expect(await refusedWith(apply(p.id))).toBe('FAILED')
    expect((await P.getPromotion(p.id))?.status).toBe('failed')
    expect(notices.at(-1)?.kind).toBe('promote_failed')
  })
})

describe('undo', () => {
  it('previews the pre-apply point, then restores it bound to its own hash', async () => {
    production = true
    const p = await apply((await plan()).id)
    expect(
      await refusedWith(
        P.applyUndo(
          {
            id: p.id,
            planHash: UNDO_HASH,
            confirm: 'production',
            overwriteProdChanges: false,
            userId: null
          },
          deps()
        )
      )
    ).toBe('PLAN_CHANGED')
    const pv = await P.previewUndo(p.id, deps())
    expect(pv.plan_hash).toBe(UNDO_HASH)
    expect(calls.at(-1)?.body).toEqual({ mode: 'preview', restore_id: 91 })
    const undo = (o: Record<string, unknown> = {}) =>
      P.applyUndo(
        {
          id: p.id,
          planHash: UNDO_HASH,
          confirm: 'production',
          overwriteProdChanges: false,
          userId: null,
          ...o
        },
        deps()
      )
    expect(await refusedWith(undo({ confirm: 'nope' }))).toBe('CONFIRM_REQUIRED')
    moving = true
    expect(await refusedWith(undo())).toBe('MOVE_OPEN')
    moving = false
    // A freeze or a shut change window never stops an undo.
    frozen = true
    windowShut = true
    const done = await undo()
    expect(done.status).toBe('undone')
    expect(calls.at(-1)?.body).toMatchObject({
      mode: 'apply',
      restore_id: 91,
      plan_hash: UNDO_HASH
    })
    expect(await refusedWith(P.previewUndo(p.id, deps()))).toBe('NOT_UNDOABLE')
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
    expect(got?.error).toMatch(/restore points/)
  })

  it('healedStatus is pure and leaves fresh rows alone', () => {
    const t = '2026-11-25T12:00:00.000Z'
    expect(P.healedStatus({ status: 'undoing', started_at: t }, Date.parse(t) + P.STUCK_MS)).toBe(
      'applied'
    )
    expect(P.healedStatus({ status: 'applying', started_at: t }, Date.parse(t) + 1000)).toBeNull()
    expect(P.healedStatus({ status: 'planned', started_at: null }, Date.parse(t))).toBeNull()
  })
})

describe('plan view', () => {
  it('refuses an answer without a hash and caps a huge plan by rows, never counts', () => {
    expect(() => P.planViewOf({ preview: {} })).toThrow(ConfigPromotionError)
    const { view } = P.planViewOf(planAnswer())
    const big = {
      ...view,
      tables: [
        { ...view.tables[0], rows: Array.from({ length: 50 }, () => view.tables[0].rows[0]) }
      ]
    }
    const capped = JSON.parse(P.cappedPlan(big, 2_000))
    expect(capped.tables[0].rows.length).toBeLessThan(50)
    expect(capped.tables[0].updates).toBe(1)
    expect(capped.tables[0].more).toBeGreaterThan(0)
  })
})
