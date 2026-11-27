import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { idParam, isAppOwner, listApps } from '../services/hub/apps.js'
import { hubModeEnabled } from '../services/hub/mode.js'
import {
  BINDING_TARGETS,
  BindingError,
  type BindingInput,
  type BindingTarget,
  bindingsView,
  outputsView,
  schedulePush,
  setBindings
} from '../services/hub/providers/engine/bindings.js'
import {
  createNotifyRoute,
  deleteNotifyRoute,
  HUB_NOTIFY_EVENTS,
  listNotifyRoutes,
  mayEditRoute,
  NOTIFY_EVENT_LABELS,
  NOTIFY_ROUTES,
  NotifyRouteError,
  type NotifyRouteInput,
  type NotifyRouteRow,
  readNotifyRoute,
  testNotifyRoute,
  updateNotifyRoute
} from '../services/hub/providers/notify.js'
import { type HubResourceRow, readResource } from '../services/hub/providers/store.js'
import { appSettingChoices } from '../services/hub-link/settings-allow.js'

/**
 * Hub providers, Wave 2 framework (Task 13; HUB=on only, /api/hub, behind the Hub credential gate):
 *
 *   GET  /resources/:id/bindings        owner | admin  the resource's outputs (key, fingerprint,
 *                                                      when — never a value) + its bindings
 *   PUT  /resources/:id/bindings        owner | admin  {bindings: [{output_key, environment_id,
 *                                                      target, target_key}]} replaces the list,
 *                                                      then pushes the stored values (background)
 *   GET  /notify-routes                 owner | admin  admins: every route; owners: their apps'
 *   POST /notify-routes                 owner | admin  {name?, scope hub|app, app_id?, events,
 *                                                      resource_id, enabled?}
 *   PATCH  /notify-routes/:id           owner | admin  same fields, only those sent change
 *   DELETE /notify-routes/:id           owner | admin
 *   POST /notify-routes/:id/test        owner | admin  one test message now; answers the outcome
 *
 * Owners: an app resource of an app they own, that app's environments (production only when the
 * app lets owners deploy production), app routes of their apps through their app's resources.
 * Shared resources and Hub-wide routes are the administrators'. Every write is logged (keys and
 * ids, never a value).
 */

type Body = Record<string, unknown>

function fail(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({ statusCode: status, error: message, message, code })
}

const userId = (req: FastifyRequest) => String(req.user?.id ?? '')
const actor = (req: FastifyRequest) => ({ id: userId(req), isAdmin: req.isAdmin === true })

function body(req: FastifyRequest): Body {
  const b = req.body
  return b && typeof b === 'object' && !Array.isArray(b) ? (b as Body) : {}
}

async function guarded(reply: FastifyReply, run: () => Promise<unknown>) {
  try {
    return await run()
  } catch (err) {
    if (err instanceof BindingError || err instanceof NotifyRouteError)
      return fail(reply, err.status, err.code, err.message)
    throw err
  }
}

/** The resource when the caller may see it (an owner never learns another app's row exists). */
async function visibleResource(req: FastifyRequest): Promise<HubResourceRow | null> {
  const id = idParam((req.params as { id: string }).id)
  const row = id === null ? null : await readResource(id)
  if (!row || row.deleted_at) return null
  if (req.isAdmin) return row
  if (row.scope !== 'app' || row.app_id == null) return null
  return (await isAppOwner(row.app_id, userId(req))) ? row : null
}

function bindingsOf(raw: unknown): BindingInput[] | string {
  if (!Array.isArray(raw)) return 'bindings must be a list.'
  const out: BindingInput[] = []
  for (const x of raw) {
    const o = x && typeof x === 'object' && !Array.isArray(x) ? (x as Body) : null
    if (!o) return 'Every binding is an object.'
    const env = idParam(o.environment_id)
    if (typeof o.output_key !== 'string' || !o.output_key) return 'output_key is required.'
    if (env === null) return 'environment_id must be an id.'
    if (typeof o.target !== 'string' || !BINDING_TARGETS.includes(o.target as BindingTarget))
      return 'target must be stack_setting, stack_secret or app_setting.'
    if (typeof o.target_key !== 'string' || !o.target_key.trim() || o.target_key.length > 128)
      return 'target_key is required (up to 128 characters).'
    out.push({
      output_key: o.output_key,
      environment_id: env,
      target: o.target as BindingTarget,
      target_key: o.target_key.trim()
    })
  }
  return out
}

function routeOut(r: NotifyRouteRow) {
  return r
}

function routeInputOf(b: Body, partial: boolean): Partial<NotifyRouteInput> | string {
  const out: Partial<NotifyRouteInput> = {}
  if (b.name !== undefined) {
    if (b.name !== null && typeof b.name !== 'string') return 'name must be text.'
    out.name = b.name as string | null
  }
  if (b.scope !== undefined || !partial) {
    if (b.scope !== 'hub' && b.scope !== 'app') return 'scope must be hub or app.'
    out.scope = b.scope
  }
  if (b.app_id !== undefined) {
    if (b.app_id === null) out.appId = null
    else {
      const id = idParam(b.app_id)
      if (id === null) return 'app_id must be an id.'
      out.appId = id
    }
  } else if (!partial) out.appId = null
  if (b.events !== undefined || !partial) {
    if (!Array.isArray(b.events) || !b.events.every((e) => typeof e === 'string'))
      return 'events must be a list of event names.'
    out.events = b.events as string[]
  }
  if (b.resource_id !== undefined || !partial) {
    const id = idParam(b.resource_id)
    if (id === null) return 'resource_id must be an id.'
    out.resourceId = id
  }
  if (b.enabled !== undefined) {
    if (typeof b.enabled !== 'boolean') return 'enabled must be true or false.'
    out.enabled = b.enabled
  }
  return out
}

function activityLog(
  req: FastifyRequest,
  action: string,
  collection: string,
  item: number,
  comment: string
) {
  return logActivity({
    action,
    user: userId(req),
    collection,
    item: String(item),
    comment: comment.slice(0, 400),
    req
  })
}

export async function hubProviderOutputRoutes(app: FastifyInstance) {
  if (!hubModeEnabled()) return

  // ── Outputs + bindings ──

  app.get('/resources/:id/bindings', { preHandler: requireAuth }, async (req, reply) =>
    guarded(reply, async () => {
      const row = await visibleResource(req)
      if (!row) return fail(reply, 404, 'NOT_FOUND', 'No such resource.')
      return {
        data: {
          outputs: await outputsView(row),
          bindings: await bindingsView(row),
          targets: BINDING_TARGETS,
          app_settings: appSettingChoices()
        }
      }
    })
  )

  app.put('/resources/:id/bindings', { preHandler: requireAuth }, async (req, reply) =>
    guarded(reply, async () => {
      const row = await visibleResource(req)
      if (!row) return fail(reply, 404, 'NOT_FOUND', 'No such resource.')
      const list = bindingsOf(body(req).bindings)
      if (typeof list === 'string') return fail(reply, 400, 'INVALID_FIELDS', list)
      const saved = await setBindings(row, list, actor(req))
      await activityLog(
        req,
        'hub-resource-bindings',
        'nivaro_hub_resource_bindings',
        row.id,
        saved
          .map((b) => `${b.output_key} → ${b.target}:${b.target_key} (env ${b.environment_id})`)
          .join(', ') || 'no bindings'
      )
      if (saved.length) schedulePush(row.id, { actorId: userId(req) })
      return { data: { outputs: await outputsView(row), bindings: await bindingsView(row) } }
    })
  )

  // ── Notify routes ──

  app.get('/notify-routes', { preHandler: requireAuth }, async (req, reply) =>
    guarded(reply, async () => {
      const rows = req.isAdmin
        ? await listNotifyRoutes()
        : await listNotifyRoutes({ appIds: (await listApps(userId(req), false)).map((a) => a.id) })
      return {
        data: {
          routes: rows.map(routeOut),
          events: HUB_NOTIFY_EVENTS.map((key) => ({ key, label: NOTIFY_EVENT_LABELS[key] }))
        }
      }
    })
  )

  app.post('/notify-routes', { preHandler: requireAuth }, async (req, reply) =>
    guarded(reply, async () => {
      const input = routeInputOf(body(req), false)
      if (typeof input === 'string') return fail(reply, 400, 'INVALID_FIELDS', input)
      const row = await createNotifyRoute(input as NotifyRouteInput, actor(req))
      await activityLog(
        req,
        'hub-notify-route-create',
        NOTIFY_ROUTES,
        row.id,
        `${row.scope}${row.app_id ? ` app ${row.app_id}` : ''} · resource ${row.resource_id} · ${row.events.join(', ')}`
      )
      return reply.code(201).send({ data: routeOut(row) })
    })
  )

  const editable = async (req: FastifyRequest, reply: FastifyReply) => {
    const id = idParam((req.params as { id: string }).id)
    const row = id === null ? null : await readNotifyRoute(id)
    if (!row || !(await mayEditRoute(row, actor(req)))) {
      fail(reply, 404, 'NOT_FOUND', 'No such notify route.')
      return null
    }
    return row
  }

  app.patch('/notify-routes/:id', { preHandler: requireAuth }, async (req, reply) =>
    guarded(reply, async () => {
      const row = await editable(req, reply)
      if (!row) return reply
      const input = routeInputOf(body(req), true)
      if (typeof input === 'string') return fail(reply, 400, 'INVALID_FIELDS', input)
      const next = await updateNotifyRoute(row, input, actor(req))
      await activityLog(
        req,
        'hub-notify-route-update',
        NOTIFY_ROUTES,
        row.id,
        Object.keys(body(req)).join(', ') || 'no change'
      )
      return { data: routeOut(next) }
    })
  )

  app.delete('/notify-routes/:id', { preHandler: requireAuth }, async (req, reply) =>
    guarded(reply, async () => {
      const row = await editable(req, reply)
      if (!row) return reply
      await deleteNotifyRoute(row.id)
      await activityLog(
        req,
        'hub-notify-route-delete',
        NOTIFY_ROUTES,
        row.id,
        `resource ${row.resource_id}`
      )
      return { data: { deleted: row.id } }
    })
  )

  app.post('/notify-routes/:id/test', { preHandler: requireAuth }, async (req, reply) =>
    guarded(reply, async () => {
      const row = await editable(req, reply)
      if (!row) return reply
      const out = await testNotifyRoute(row)
      await activityLog(
        req,
        'hub-notify-route-test',
        NOTIFY_ROUTES,
        row.id,
        out.ok ? 'sent' : `failed: ${out.code ?? 'error'}`
      )
      return { data: { ...out, route: routeOut((await readNotifyRoute(row.id)) ?? row) } }
    })
  )
}
