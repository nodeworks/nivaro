import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { insertReturningId } from '../db/dialect/ef.js'
import { db } from '../db/index.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { idParam, isAppOwner, listEnvironments, readApp } from '../services/hub/apps.js'
import {
  calendarEvents,
  ENTRIES,
  MAX_RANGE_MS,
  validateEntry
} from '../services/hub/changes/calendar.js'
import {
  ACTIONS,
  type ChecklistAction,
  type ChecklistEntry,
  ChecklistError,
  type ChecklistRun,
  type ChecklistTarget,
  checklistFor,
  createRun,
  findOpenRun,
  ITEMS,
  itemFromRow,
  listItems,
  mayTick,
  missingRequired,
  RUNS,
  readRun,
  runFromRow,
  type Ticker,
  tickRun,
  validateItem,
  voidRun
} from '../services/hub/changes/checklist.js'
import { renderIcs } from '../services/hub/changes/ics.js'
import { envPolicy } from '../services/hub/owner-access.js'
import { personNames } from '../services/hub/releases/person.js'
import { createSchedule } from '../services/hub/releases/schedules.js'
import {
  judgeWindows,
  listWindows,
  validateWindow,
  WINDOWS,
  windowWords
} from '../services/hub/releases/windows.js'

/**
 * Hub change operations (mounted under /api/hub by hubRoutes, hub mode only):
 *   - the change calendar (GET /calendar, /calendar.ics) over the Hub's own rows, plus planned
 *     maintenance entries (/calendar/entries);
 *   - deploy windows (/deploy-windows) — judged by the ONE release-time engine in
 *     services/hub/releases/freeze.ts (freezeRefusal), so promotions, trains and schedules honour
 *     them; a refused promotion can be queued for the next opening (/promote/queue);
 *   - pre-deploy checklists: items per app (/checklist-items), a checklist per start
 *     (/environments/:envId/checklist-runs, /shared/:id/checklist-runs) and its ticks.
 *
 * Reads: admins see everything; an app's owners see their apps (and the Hub-wide rows); anything
 * else answers 404. Item, window and entry writes are admin-only; a checklist is opened and
 * ticked by whoever its items allow (Hub admins, the app's owners, or the people an item names).
 * Every write is logged (logActivity).
 */

type Body = Record<string, unknown>

function body(req: FastifyRequest): Body {
  const b = req.body
  return b && typeof b === 'object' && !Array.isArray(b) ? (b as Body) : {}
}

function fail(reply: FastifyReply, status: number, code: string, error: string, extra = {}) {
  return reply.code(status).send({ error, code, ...extra })
}

const notFound = (reply: FastifyReply) => fail(reply, 404, 'NOT_FOUND', 'Not found')
const userId = (req: FastifyRequest) => String(req.user?.id ?? '')

function personName(req: FastifyRequest): string | null {
  const u = req.user as
    | { first_name?: string | null; last_name?: string | null; email?: string }
    | undefined
  const full = [u?.first_name, u?.last_name]
    .filter((x) => x?.trim())
    .join(' ')
    .trim()
  return full || u?.email || null
}

/** The apps the caller owns. */
async function ownedAppIds(req: FastifyRequest): Promise<number[]> {
  const rows = (await db('nivaro_hub_app_owners')
    .where({ user_id: userId(req) })
    .select('app_id')) as Array<{ app_id: number }>
  return rows.map((r) => Number(r.app_id))
}

/** The apps the caller may read: null = every app (admin). */
async function readableAppIds(req: FastifyRequest): Promise<number[] | null> {
  return req.isAdmin ? null : ownedAppIds(req)
}

async function canReadApp(req: FastifyRequest, appId: number): Promise<boolean> {
  return !!req.isAdmin || (await isAppOwner(appId, userId(req)))
}

async function readableEnv(req: FastifyRequest) {
  const id = idParam((req.params as { envId?: string }).envId)
  if (id === null) return null
  const row = (await db('nivaro_hub_environments').where({ id }).first()) as
    | Record<string, unknown>
    | undefined
  if (!row || !(await canReadApp(req, Number(row.app_id)))) return null
  return row
}

async function tickerOf(req: FastifyRequest): Promise<Ticker> {
  return { id: userId(req), isAdmin: !!req.isAdmin, owns: new Set(await ownedAppIds(req)) }
}

function refusal(reply: FastifyReply, err: unknown) {
  if (err instanceof ChecklistError)
    return fail(reply, err.status, err.code, err.message, err.extra)
  throw err
}

const actionOf = (v: unknown): ChecklistAction | null =>
  (ACTIONS as readonly string[]).includes(String(v)) ? (v as ChecklistAction) : null

const VERSION_RE = /^\d+\.\d+\.\d+$/

/** The checklist as one person sees it: today's entries, the ticks, what they may tick. */
async function checklistView(
  target: ChecklistTarget,
  action: ChecklistAction,
  run: ChecklistRun | null,
  who: Ticker
) {
  const { entries, production } = await checklistFor(target, action)
  const ticks = run?.ticks ?? {}
  const names = await personNames(entries.flatMap((e) => e.tick_people))
  const missing = missingRequired(entries, ticks)
  return {
    production: production.length > 0,
    required: entries.some((e) => e.required),
    entries: entries.map((e) => ({
      ...e,
      tick_people_names: e.tick_people.map((p) => names.get(p.toLowerCase()) ?? null),
      may_tick: run?.status === 'open' ? mayTick(e, who) : false,
      tick: ticks[e.key] ?? null
    })),
    run: run
      ? {
          id: run.id,
          status: run.status,
          version: run.version,
          action: run.action,
          source: run.source,
          source_id: run.source_id,
          source_step: run.source_step,
          run_kind: run.run_kind,
          run_id: run.run_id,
          created_at: run.created_at,
          used_at: run.used_at
        }
      : null,
    missing: missing.map((e) => e.key),
    ready: missing.length === 0
  }
}

/** Whether the caller may read a checklist: admin, an owner of an app on it, or named on it. */
async function mayReadRun(req: FastifyRequest, run: ChecklistRun): Promise<boolean> {
  if (req.isAdmin) return true
  const target: ChecklistTarget =
    run.target_kind === 'shared'
      ? { kind: 'shared', sharedId: run.target_id }
      : { kind: 'environment', envId: run.target_id }
  const { entries } = await checklistFor(target, run.action)
  const all: ChecklistEntry[] = [...entries, ...run.items]
  const owns = new Set(await ownedAppIds(req))
  const me = userId(req).toLowerCase()
  return all.some((e) => owns.has(e.app_id) || e.tick_people.some((p) => p.toLowerCase() === me))
}

const targetOfRun = (run: ChecklistRun): ChecklistTarget =>
  run.target_kind === 'shared'
    ? { kind: 'shared', sharedId: run.target_id }
    : { kind: 'environment', envId: run.target_id }

function rangeOf(
  q: Record<string, unknown>,
  now = Date.now()
): { from: number; to: number } | { error: string } {
  const from = typeof q.from === 'string' ? Date.parse(q.from) : now - 7 * 86_400_000
  const to = typeof q.to === 'string' ? Date.parse(q.to) : now + 35 * 86_400_000
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from)
    return { error: 'from and to are ISO times, to after from' }
  if (to - from > MAX_RANGE_MS) return { error: 'the range is at most 100 days' }
  return { from, to }
}

export function hubChangeRoutes(app: FastifyInstance): void {
  // ─── Change calendar ───────────────────────────────────────────────────────

  app.get('/calendar', { preHandler: requireAuth }, async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, unknown>
    const range = rangeOf(q)
    if ('error' in range) return fail(reply, 400, 'BAD_RANGE', range.error)
    let appIds = await readableAppIds(req)
    if (q.app_id != null && q.app_id !== '') {
      const one = idParam(q.app_id)
      if (one === null || !(await canReadApp(req, one))) return notFound(reply)
      appIds = [one]
    }
    return {
      data: {
        from: new Date(range.from).toISOString(),
        to: new Date(range.to).toISOString(),
        events: await calendarEvents({ ...range, appIds }),
        now: new Date().toISOString()
      }
    }
  })

  // .ics of one app, or of the apps one person owns (an admin may name anyone; an owner only
  // themself). The last 30 days and the next 180; deploy windows (allowed times) left out.
  app.get('/calendar.ics', { preHandler: requireAuth }, async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, unknown>
    let appIds: number[] | null
    let name: string
    if (q.app_id != null && q.app_id !== '') {
      const one = idParam(q.app_id)
      const a = one === null ? null : await readApp(one)
      if (!a || one === null || !(await canReadApp(req, one))) return notFound(reply)
      appIds = [one]
      name = `${a.name || a.key} changes`
    } else if (q.owner != null && q.owner !== '') {
      const owner = String(q.owner)
      if (!req.isAdmin && owner.toLowerCase() !== userId(req).toLowerCase()) return notFound(reply)
      const rows = (await db('nivaro_hub_app_owners')
        .where({ user_id: owner })
        .select('app_id')) as Array<{ app_id: number }>
      appIds = rows.map((r) => Number(r.app_id))
      name = 'My apps — changes'
    } else {
      appIds = await readableAppIds(req)
      name = appIds === null ? 'Hub changes' : 'My apps — changes'
    }
    const now = Date.now()
    const events = (
      await Promise.all([
        calendarEvents({ from: now - 30 * 86_400_000, to: now + 70 * 86_400_000, appIds }),
        calendarEvents({ from: now + 70 * 86_400_000, to: now + 140 * 86_400_000, appIds }),
        calendarEvents({ from: now + 140 * 86_400_000, to: now + 180 * 86_400_000, appIds })
      ])
    ).flat()
    const seen = new Set<string>()
    const unique = events.filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)))
    const host = String(req.headers.host ?? 'nivaro-hub').replace(/[^a-z0-9.:-]/gi, '')
    return reply
      .header('content-type', 'text/calendar; charset=utf-8')
      .header('content-disposition', 'attachment; filename="hub-changes.ics"')
      .header('cache-control', 'no-store')
      .send(renderIcs(unique, { name, host: host || 'nivaro-hub', now }))
  })

  app.post('/calendar/entries', { preHandler: requireAdmin }, async (req, reply) => {
    const v = validateEntry(body(req))
    if ('error' in v) return fail(reply, 400, 'BAD_ENTRY', v.error)
    if (v.app_id != null && !(await readApp(v.app_id)))
      return fail(reply, 400, 'BAD_ENTRY', 'app_id names no app')
    const id = Number(
      await insertReturningId(db, ENTRIES, {
        ...v,
        source: null,
        source_key: null,
        created_by: userId(req),
        created_at: new Date(),
        updated_at: new Date()
      })
    )
    await logActivity({
      action: 'hub-calendar-entry-create',
      user: userId(req),
      collection: ENTRIES,
      item: String(id),
      comment: v.title,
      req
    })
    return reply.code(201).send({ data: { id, ...v } })
  })

  app.patch('/calendar/entries/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id)
    // Only a person's own entries are edited here; ones another feature writes are its own.
    if (id === null || !(await db(ENTRIES).where({ id }).whereNull('source').first('id')))
      return notFound(reply)
    const v = validateEntry(body(req))
    if ('error' in v) return fail(reply, 400, 'BAD_ENTRY', v.error)
    await db(ENTRIES)
      .where({ id })
      .update({ ...v, updated_at: new Date() })
    await logActivity({
      action: 'hub-calendar-entry-update',
      user: userId(req),
      collection: ENTRIES,
      item: String(id),
      comment: v.title,
      req
    })
    return { data: { id, ...v } }
  })

  app.delete('/calendar/entries/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id)
    if (id === null) return notFound(reply)
    if (!(await db(ENTRIES).where({ id }).whereNull('source').delete())) return notFound(reply)
    await logActivity({
      action: 'hub-calendar-entry-delete',
      user: userId(req),
      collection: ENTRIES,
      item: String(id),
      req
    })
    return { data: { id } }
  })

  // ─── Overview (the Changes tab) ────────────────────────────────────────────

  app.get('/changes/overview', { preHandler: requireAuth }, async (req) => {
    const ids = await readableAppIds(req)
    const appsQ = db('nivaro_hub_apps').orderBy('key', 'asc').select('id', 'key', 'name')
    if (ids) appsQ.whereIn('id', ids.length ? ids : [-1])
    const apps = (await appsQ) as Array<{ id: number; key: string; name: string }>
    const appIds = apps.map((a) => Number(a.id))
    const now = Date.now()
    const windows = await listWindows({ appIds })
    const environments = (
      await Promise.all(
        apps.map(async (a) =>
          Promise.all(
            (
              await listEnvironments(Number(a.id))
            ).map(async (e) => {
              const production = (await envPolicy(e.id))?.production ?? true
              const j = judgeWindows(windows, Number(a.id), production, now)
              return {
                id: e.id,
                app_id: Number(a.id),
                key: e.key,
                position: e.position,
                on_shared: e.on_shared === true,
                production,
                window: {
                  governed: j.governed,
                  open: j.open,
                  closes_at: j.current ? new Date(j.current.span.end).toISOString() : null,
                  opens_at: j.next ? new Date(j.next.span.start).toISOString() : null,
                  name: (j.current?.window ?? j.next?.window ?? j.windows[0])?.name ?? null
                }
              }
            })
          )
        )
      )
    ).flat()
    const items = await listItems({ appIds })
    // Checklists unattended starts wait for (a person ticks them here).
    const waitingRows = (await db(RUNS)
      .where({ status: 'open' })
      .whereIn('source', ['schedule', 'train'])
      .orderBy('id', 'desc')
      .limit(50)
      .select('*')) as Array<Record<string, unknown>>
    const waiting: Array<Record<string, unknown>> = []
    for (const r of waitingRows) {
      const run = runFromRow(r)
      if (!(await mayReadRun(req, run))) continue
      const env =
        run.target_kind === 'environment'
          ? environments.find((e) => e.id === run.target_id)
          : undefined
      waiting.push({
        id: run.id,
        action: run.action,
        version: run.version,
        source: run.source,
        source_id: run.source_id,
        target_kind: run.target_kind,
        target_id: run.target_id,
        env_key: env?.key ?? null,
        app_id: env?.app_id ?? null,
        created_at: run.created_at
      })
    }
    const names = await personNames(items.flatMap((i) => i.tick_people))
    return {
      data: {
        apps: apps.map((a) => ({ id: Number(a.id), key: String(a.key), name: String(a.name) })),
        environments,
        windows: windows.map((w) => ({
          ...w,
          words: windowWords(w)
        })),
        items: items.map((i) => ({
          ...i,
          tick_people_names: i.tick_people.map((p) => names.get(p.toLowerCase()) ?? null)
        })),
        waiting,
        now: new Date(now).toISOString()
      }
    }
  })

  // ─── Deploy windows ────────────────────────────────────────────────────────

  async function checkWindowApp(reply: FastifyReply, appId: number | null) {
    if (appId != null && !(await readApp(appId))) {
      fail(reply, 400, 'BAD_WINDOW', 'app_id names no app')
      return false
    }
    return true
  }

  app.post('/deploy-windows', { preHandler: requireAdmin }, async (req, reply) => {
    const v = validateWindow(body(req))
    if ('error' in v) return fail(reply, 400, 'BAD_WINDOW', v.error)
    if (!(await checkWindowApp(reply, v.app_id))) return reply
    const id = Number(
      await insertReturningId(db, WINDOWS, {
        ...v,
        created_by: userId(req),
        created_at: new Date(),
        updated_at: new Date()
      })
    )
    await logActivity({
      action: 'hub-deploy-window-create',
      user: userId(req),
      collection: WINDOWS,
      item: String(id),
      comment: v.name,
      req
    })
    return reply.code(201).send({ data: (await listWindows()).find((w) => w.id === id) })
  })

  app.patch('/deploy-windows/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id)
    if (id === null || !(await db(WINDOWS).where({ id }).first('id'))) return notFound(reply)
    const v = validateWindow(body(req))
    if ('error' in v) return fail(reply, 400, 'BAD_WINDOW', v.error)
    if (!(await checkWindowApp(reply, v.app_id))) return reply
    await db(WINDOWS)
      .where({ id })
      .update({ ...v, updated_at: new Date() })
    await logActivity({
      action: 'hub-deploy-window-update',
      user: userId(req),
      collection: WINDOWS,
      item: String(id),
      comment: v.name,
      req
    })
    return { data: (await listWindows()).find((w) => w.id === id) }
  })

  app.delete('/deploy-windows/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id)
    if (id === null) return notFound(reply)
    if (!(await db(WINDOWS).where({ id }).delete())) return notFound(reply)
    await logActivity({
      action: 'hub-deploy-window-delete',
      user: userId(req),
      collection: WINDOWS,
      item: String(id),
      req
    })
    return { data: { id } }
  })

  // Open or closed now for one environment, and the next opening (the Promote panel's notice).
  app.get('/environments/:envId/deploy-window', { preHandler: requireAuth }, async (req, reply) => {
    const env = await readableEnv(req)
    if (!env) return notFound(reply)
    const production = (await envPolicy(Number(env.id)))?.production ?? true
    const j = judgeWindows(await listWindows(), Number(env.app_id), production, Date.now())
    return {
      data: {
        governed: j.governed,
        open: j.open,
        production,
        closes_at: j.current ? new Date(j.current.span.end).toISOString() : null,
        opens_at: j.next ? new Date(j.next.span.start).toISOString() : null,
        windows: j.windows.map((w) => ({ id: w.id, name: w.name, words: windowWords(w) }))
      }
    }
  })

  // Queue a promotion refused for being outside the windows: a scheduled promotion at the next
  // opening (it waits there if a freeze is on then). Admin, like every schedule.
  app.post(
    '/environments/:envId/promote/queue',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const env = await readableEnv(req)
      if (!env) return notFound(reply)
      const b = body(req)
      const version = typeof b.version === 'string' ? b.version.trim() : ''
      if (!VERSION_RE.test(version)) return fail(reply, 400, 'BAD_VERSION', 'version is x.y.z')
      if (typeof b.confirm !== 'string' || b.confirm.trim() !== String(env.key))
        return fail(reply, 400, 'CONFIRM_REQUIRED', `Type ${env.key} to confirm`)
      const appId = Number(env.app_id)
      const listed = (await listEnvironments(appId)).find((e) => e.id === Number(env.id))
      if (listed?.on_shared)
        return fail(
          reply,
          400,
          'ON_SHARED',
          `${env.key} runs on a shared deployment: upgrade the deployment instead`
        )
      const production = (await envPolicy(Number(env.id)))?.production ?? true
      const j = judgeWindows(await listWindows(), appId, production, Date.now())
      if (j.open)
        return fail(reply, 409, 'WINDOW_OPEN', 'A deploy window is open now: start the promotion.')
      if (!j.next)
        return fail(reply, 409, 'NO_WINDOW_SOON', 'No deploy window opens in the next two weeks.')
      const s = await createSchedule({
        app_id: appId,
        environment_id: Number(env.id),
        kind: 'promote',
        version,
        // A minute into the window: never judged a hair before it opens.
        run_at: new Date(j.next.span.start + 60_000),
        on_freeze: 'wait',
        train: null,
        created_by: userId(req)
      })
      await logActivity({
        action: 'hub-schedule-create',
        user: userId(req),
        collection: 'nivaro_hub_schedules',
        item: String(s.id),
        comment: `${env.key} promote ${version} at the next deploy window (${s.run_at})`,
        req
      })
      return reply.code(201).send({ data: s })
    }
  )

  // ─── Pre-deploy checklist items ────────────────────────────────────────────

  async function checkItemTarget(
    reply: FastifyReply,
    v: { app_id: number; environment_id: number | null }
  ) {
    if (!(await readApp(v.app_id))) {
      fail(reply, 400, 'BAD_ITEM', 'app_id names no app')
      return false
    }
    if (
      v.environment_id != null &&
      !(await db('nivaro_hub_environments')
        .where({ id: v.environment_id, app_id: v.app_id })
        .first('id'))
    ) {
      fail(reply, 400, 'BAD_ITEM', 'environment_id names none of the app’s environments')
      return false
    }
    return true
  }

  app.post('/checklist-items', { preHandler: requireAdmin }, async (req, reply) => {
    const v = validateItem(body(req))
    if ('error' in v) return fail(reply, 400, 'BAD_ITEM', v.error)
    if (!(await checkItemTarget(reply, v))) return reply
    const id = Number(
      await insertReturningId(db, ITEMS, {
        ...v,
        created_by: userId(req),
        created_at: new Date(),
        updated_at: new Date()
      })
    )
    await logActivity({
      action: 'hub-checklist-item-create',
      user: userId(req),
      collection: ITEMS,
      item: String(id),
      comment: v.text.slice(0, 200),
      req
    })
    const row = (await db(ITEMS).where({ id }).first()) as Record<string, unknown>
    return reply.code(201).send({ data: itemFromRow(row) })
  })

  app.patch('/checklist-items/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id)
    if (id === null || !(await db(ITEMS).where({ id }).whereNull('archived_at').first('id')))
      return notFound(reply)
    const v = validateItem(body(req))
    if ('error' in v) return fail(reply, 400, 'BAD_ITEM', v.error)
    if (!(await checkItemTarget(reply, v))) return reply
    await db(ITEMS)
      .where({ id })
      .update({ ...v, updated_at: new Date() })
    await logActivity({
      action: 'hub-checklist-item-update',
      user: userId(req),
      collection: ITEMS,
      item: String(id),
      comment: v.text.slice(0, 200),
      req
    })
    const row = (await db(ITEMS).where({ id }).first()) as Record<string, unknown>
    return { data: itemFromRow(row) }
  })

  // Archived, never deleted: a used checklist names its items.
  app.delete('/checklist-items/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id)
    if (id === null) return notFound(reply)
    const n = await db(ITEMS)
      .where({ id })
      .whereNull('archived_at')
      .update({ archived_at: new Date(), updated_at: new Date() })
    if (!n) return notFound(reply)
    await logActivity({
      action: 'hub-checklist-item-archive',
      user: userId(req),
      collection: ITEMS,
      item: String(id),
      req
    })
    return { data: { id } }
  })

  // ─── Checklists (one per start) ────────────────────────────────────────────

  // The checklist a production start of this environment needs, with the open one for the
  // version (if a person opened it) — the Promote and Move panels read this.
  app.get('/environments/:envId/checklist', { preHandler: requireAuth }, async (req, reply) => {
    const env = await readableEnv(req)
    if (!env) return notFound(reply)
    const q = (req.query ?? {}) as Record<string, unknown>
    const action = actionOf(q.action ?? 'promote')
    if (!action || action === 'upgrade')
      return fail(reply, 400, 'BAD_ACTION', 'action is promote or move')
    const version = action === 'move' ? null : typeof q.version === 'string' ? q.version : null
    if (action === 'promote' && (!version || !VERSION_RE.test(version)))
      return fail(reply, 400, 'BAD_VERSION', 'version is x.y.z')
    const target: ChecklistTarget = { kind: 'environment', envId: Number(env.id) }
    const run = await findOpenRun(target, action, version)
    return { data: await checklistView(target, action, run, await tickerOf(req)) }
  })

  app.post(
    '/environments/:envId/checklist-runs',
    { preHandler: requireAuth },
    async (req, reply) => {
      const env = await readableEnv(req)
      if (!env) return notFound(reply)
      const b = body(req)
      const action = actionOf(b.action ?? 'promote')
      if (!action || action === 'upgrade')
        return fail(reply, 400, 'BAD_ACTION', 'action is promote or move')
      const version = action === 'move' ? null : typeof b.version === 'string' ? b.version : null
      if (action === 'promote' && (!version || !VERSION_RE.test(version)))
        return fail(reply, 400, 'BAD_VERSION', 'version is x.y.z')
      const target: ChecklistTarget = { kind: 'environment', envId: Number(env.id) }
      const { entries } = await checklistFor(target, action)
      if (!entries.length)
        return fail(reply, 409, 'NO_CHECKLIST', 'This start needs no pre-deploy checklist.')
      const run =
        (await findOpenRun(target, action, version)) ??
        (await createRun({ target, action, version, userId: userId(req), entries }))
      await logActivity({
        action: 'hub-checklist-open',
        user: userId(req),
        collection: RUNS,
        item: String(run.id),
        comment: `${env.key} ${action}${version ? ` ${version}` : ''}`,
        req
      })
      return reply
        .code(201)
        .send({ data: await checklistView(target, action, run, await tickerOf(req)) })
    }
  )

  app.get('/shared/:id/checklist', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id)
    if (id === null || !(await db('nivaro_hub_shared_deployments').where({ id }).first('id')))
      return notFound(reply)
    const q = (req.query ?? {}) as Record<string, unknown>
    const version = typeof q.version === 'string' ? q.version : ''
    if (!VERSION_RE.test(version)) return fail(reply, 400, 'BAD_VERSION', 'version is x.y.z')
    const target: ChecklistTarget = { kind: 'shared', sharedId: id }
    const run = await findOpenRun(target, 'upgrade', version)
    return { data: await checklistView(target, 'upgrade', run, await tickerOf(req)) }
  })

  app.post('/shared/:id/checklist-runs', { preHandler: requireAdmin }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id)
    if (id === null || !(await db('nivaro_hub_shared_deployments').where({ id }).first('id')))
      return notFound(reply)
    const version = typeof body(req).version === 'string' ? String(body(req).version) : ''
    if (!VERSION_RE.test(version)) return fail(reply, 400, 'BAD_VERSION', 'version is x.y.z')
    const target: ChecklistTarget = { kind: 'shared', sharedId: id }
    const { entries } = await checklistFor(target, 'upgrade')
    if (!entries.length)
      return fail(reply, 409, 'NO_CHECKLIST', 'This upgrade needs no pre-deploy checklist.')
    const run =
      (await findOpenRun(target, 'upgrade', version)) ??
      (await createRun({ target, action: 'upgrade', version, userId: userId(req), entries }))
    await logActivity({
      action: 'hub-checklist-open',
      user: userId(req),
      collection: RUNS,
      item: String(run.id),
      comment: `shared #${id} upgrade ${version}`,
      req
    })
    return reply
      .code(201)
      .send({ data: await checklistView(target, 'upgrade', run, await tickerOf(req)) })
  })

  app.get('/checklist-runs/:id', { preHandler: requireAuth }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id)
    const run = id === null ? null : await readRun(id)
    if (!run || !(await mayReadRun(req, run))) return notFound(reply)
    // A used checklist shows what it was attested against; an open one today's items.
    if (run.status !== 'open') {
      const names = await personNames(run.items.flatMap((e) => e.tick_people))
      return {
        data: {
          production: true,
          required: run.items.some((e) => e.required),
          entries: run.items.map((e) => ({
            ...e,
            tick_people_names: e.tick_people.map((p) => names.get(p.toLowerCase()) ?? null),
            may_tick: false,
            tick: run.ticks[e.key] ?? null
          })),
          run: {
            id: run.id,
            status: run.status,
            version: run.version,
            action: run.action,
            source: run.source,
            source_id: run.source_id,
            source_step: run.source_step,
            run_kind: run.run_kind,
            run_id: run.run_id,
            created_at: run.created_at,
            used_at: run.used_at
          },
          missing: missingRequired(run.items, run.ticks).map((e) => e.key),
          ready: missingRequired(run.items, run.ticks).length === 0
        }
      }
    }
    return { data: await checklistView(targetOfRun(run), run.action, run, await tickerOf(req)) }
  })

  app.post('/checklist-runs/:id/tick', { preHandler: requireAuth }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id)
    const found = id === null ? null : await readRun(id)
    if (!found || id === null || !(await mayReadRun(req, found))) return notFound(reply)
    const b = body(req)
    const key = typeof b.key === 'string' ? b.key : ''
    if (!/^\d+@\d+$/.test(key))
      return fail(reply, 400, 'BAD_TICK', 'key is <item id>@<environment id>')
    const note = typeof b.note === 'string' && b.note.trim() ? b.note.trim() : null
    const ticked = b.ticked !== false
    try {
      const run = await tickRun(id, {
        key,
        ticked,
        note,
        who: await tickerOf(req),
        whoName: personName(req)
      })
      await logActivity({
        action: ticked ? 'hub-checklist-tick' : 'hub-checklist-untick',
        user: userId(req),
        collection: RUNS,
        item: String(id),
        comment: `${key}${note ? `: ${note.slice(0, 200)}` : ''}`,
        req
      })
      return { data: await checklistView(targetOfRun(run), run.action, run, await tickerOf(req)) }
    } catch (err) {
      return refusal(reply, err)
    }
  })

  app.post('/checklist-runs/:id/void', { preHandler: requireAuth }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id)
    const found = id === null ? null : await readRun(id)
    if (!found || id === null || !(await mayReadRun(req, found))) return notFound(reply)
    // Setting a checklist aside is for admins and owners (a named ticker only ticks).
    const owns = new Set(await ownedAppIds(req))
    const apps = found.items.map((e) => e.app_id)
    if (!req.isAdmin && !apps.some((a) => owns.has(a)))
      return fail(
        reply,
        403,
        'NOT_YOURS',
        'Only a Hub administrator or an app owner sets a checklist aside.'
      )
    if (!(await voidRun(id)))
      return fail(reply, 409, 'CHECKLIST_CLOSED', 'This checklist is not open.')
    await logActivity({
      action: 'hub-checklist-void',
      user: userId(req),
      collection: RUNS,
      item: String(id),
      req
    })
    return { data: { id, status: 'void' } }
  })

  // The checklist a past run started with (the history row's "Checklist").
  app.get('/deploys/:id/checklist', { preHandler: requireAuth }, async (req, reply) => {
    const id = idParam((req.params as { id: string }).id)
    if (id === null) return notFound(reply)
    const d = (await db('nivaro_hub_deploys').where({ id }).first('app_id')) as
      | { app_id: number }
      | undefined
    if (!d || !(await canReadApp(req, Number(d.app_id)))) return notFound(reply)
    const row = (await db(RUNS).where({ run_kind: 'deploy', run_id: id }).first()) as
      | Record<string, unknown>
      | undefined
    return { data: row ? runFromRow(row) : null }
  })
}
