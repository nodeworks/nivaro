// api/src/routes/traffic-map-extras/tm-actions.ts
/**
 * Traffic Map — actions that change behaviour or reach people (under /api/traffic-map, admin only,
 * 404 in cloud mode):
 *   GET  /blast-radius?node=            what depends on a node, 7 days observed (#2152)
 *   GET  /blast-radius?node=&window=&until=  simulate a dependency down: what breaks (#2841)
 *   GET  /affected-people?node=&screens= who would be told, last hour (#2274)
 *   POST /tell-affected                 a broadcast to them through the announcement service (#2274)
 *   GET|POST /debug-windows, DELETE /debug-windows/:id, GET /debug-windows/:id/traces   (#2215)
 *   GET|POST /temp-caches, DELETE /temp-caches/:id                                      (#2273)
 *   GET|PUT  /detectors                 detector switches + thresholds, this instance  (#2223)
 *   GET  /ext-lenses, GET /ext-lenses/:key?window=   extension lenses and their data    (#2229)
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { db } from '../../db/index.js'
import { logActivity } from '../../services/activity.js'
import { selectInChunks } from '../../services/db-batch.js'
import { instanceKey } from '../../services/instance-key.js'
import {
  affectedPeople,
  blastRadius,
  parseBlastNode,
  parseScreens,
  prefilledMessage
} from '../../services/traffic-actions/blast-radius.js'
import {
  DEBUG_DEFAULT_MIN,
  DEBUG_MAX_MIN,
  DebugWindowError,
  debugWindows,
  debugWindowTraces,
  startDebugWindow,
  stopDebugWindow
} from '../../services/traffic-actions/debug-window.js'
import {
  LensError,
  listExtensionLenses,
  readExtensionLens
} from '../../services/traffic-actions/ext-lenses.js'
import {
  parseDependencyNode,
  parseSimWindow,
  parseUntil,
  simulateDown
} from '../../services/traffic-actions/simulate-down.js'
import {
  CACHE_DEFAULT_MIN,
  CACHE_MAX_MIN,
  cacheableCollection,
  ENTRY_S_DEFAULT,
  ENTRY_S_MAX,
  startTempCache,
  stopTempCache,
  TempCacheError,
  tempCaches
} from '../../services/traffic-actions/temp-cache.js'
import { timedRulesAvailable } from '../../services/traffic-actions/timed-rules.js'
import {
  DETECTORS,
  detectorSettings,
  saveDetectorSettings,
  startDetectorSettings
} from '../../services/traffic-detectors.js'

const ID_RE = /^[0-9a-f-]{36}$/i
const WINDOWS = new Set([60, 300, 900])
/** A broadcast from the map reaches at most this many people (a bigger audience: Broadcasts). */
export const TELL_MAX_PEOPLE = 2000
const SUBJECT_MAX = 200
const MESSAGE_MAX = 2000
/** A banner from the map lifts itself after this long. */
const BANNER_HOURS = 4

type User = {
  id?: string
  first_name?: string | null
  last_name?: string | null
  email?: string | null
}

function fail(reply: FastifyReply, err: unknown) {
  if (err instanceof DebugWindowError || err instanceof TempCacheError)
    return reply.code(err.status).send({ error: err.message, code: err.code })
  throw err
}

function screensParam(raw: unknown) {
  if (Array.isArray(raw)) return parseScreens(raw)
  if (typeof raw !== 'string' || !raw) return []
  try {
    return parseScreens(JSON.parse(raw))
  } catch {
    return []
  }
}

/** The node's human label for messages: `items/workflows` → `workflows`. */
function nodeLabel(node: string, fallback?: string | null): string {
  if (fallback) return fallback
  const cut = node.indexOf('/')
  return cut > 0 ? node.slice(cut + 1) : node
}

export interface TellDeps {
  /** Send through POST /api/announcements as the admin (injected for tests). */
  send(
    req: FastifyRequest,
    body: Record<string, unknown>
  ): Promise<{
    status: number
    body: { data?: { id?: number; delivered?: number }; error?: string }
  }>
}

function injectSend(app: FastifyInstance): TellDeps['send'] {
  return async (req, body) => {
    // As the admin who clicked: their own credential, never a stored one — the announcement route
    // re-checks they are an administrator and writes its own activity row.
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (req.headers.authorization) headers.authorization = String(req.headers.authorization)
    if (req.headers.cookie) headers.cookie = String(req.headers.cookie)
    const res = await app.inject({
      method: 'POST',
      url: '/api/announcements',
      headers,
      payload: body
    })
    let parsed: { data?: { id?: number; delivered?: number }; error?: string } = {}
    try {
      parsed = JSON.parse(res.body)
    } catch {
      parsed = {}
    }
    return { status: res.statusCode, body: parsed }
  }
}

export async function tmActionsRoutes(
  app: FastifyInstance,
  deps?: Partial<TellDeps>
): Promise<void> {
  startDetectorSettings()
  const send = deps?.send ?? injectSend(app)

  // ── #2152 blast radius ───────────────────────────────────────────────────
  app.get<{ Querystring: { node?: string; fresh?: string; window?: string; until?: string } }>(
    '/blast-radius',
    async (req, reply) => {
      // #2841 simulate down: a window (or a dependency the #2152 view does not take) asks what
      // breaks if the node goes away, worked out from recorded traffic over that window.
      const raw = String(req.query.node ?? '')
      if (req.query.window !== undefined || !parseBlastNode(raw)) {
        const dep = parseDependencyNode(raw)
        const window = parseSimWindow(req.query.window)
        if (!dep)
          return reply.code(400).send({
            error:
              'Simulate down is worked out for a dependency: the database, Redis, file storage, a channel, an AI provider, a partner or the sign-in provider',
            code: 'BLAST_NODE'
          })
        if (!window)
          return reply
            .code(400)
            .send({ error: 'window must be one of 1h, 6h, 24h or 7d', code: 'BLAST_WINDOW' })
        const data = await simulateDown(dep, window, {
          until: parseUntil(req.query.until),
          who: req.user?.id ?? null,
          fresh: req.query.fresh === '1'
        })
        if (!data)
          return reply.code(404).send({ error: 'No such partner', code: 'BLAST_NOT_FOUND' })
        return { data }
      }
      const node = parseBlastNode(raw)
      if (!node)
        return reply.code(400).send({
          error: 'Blast radius is worked out for an endpoint or a partner node',
          code: 'BLAST_NODE'
        })
      const data = await blastRadius(node, req.query.fresh === '1')
      if (!data) return reply.code(404).send({ error: 'No such partner', code: 'BLAST_NOT_FOUND' })
      let label: string | null = null
      if (node.kind === 'down') {
        const api = (await db('nivaro_external_apis').where({ id: node.apiId }).first('name')) as
          | { name?: string }
          | undefined
        label = api?.name ?? null
      }
      return {
        data: { ...data, prefill: prefilledMessage(nodeLabel(node.key, label), data.screens) }
      }
    }
  )

  // ── #2274 tell affected people ───────────────────────────────────────────
  app.get<{ Querystring: { node?: string; screens?: string } }>(
    '/affected-people',
    async (req, reply) => {
      const node = parseBlastNode(String(req.query.node ?? ''))
      if (!node) return reply.code(400).send({ error: 'Pick a node', code: 'BLAST_NODE' })
      const ids = await affectedPeople(node, screensParam(req.query.screens), req.user?.id ?? null)
      const sample = (await selectInChunks(ids.slice(0, 8), 500, (chunk) =>
        db('nivaro_users').whereIn('id', chunk).select('id', 'first_name', 'last_name', 'email')
      )) as Array<Record<string, unknown>>
      return {
        data: {
          count: ids.length,
          over_limit: ids.length > TELL_MAX_PEOPLE,
          max: TELL_MAX_PEOPLE,
          sample: sample.map(
            (u) =>
              `${String(u.first_name ?? '')} ${String(u.last_name ?? '')}`.trim() ||
              String(u.email ?? 'Someone')
          ),
          window_minutes: 60
        }
      }
    }
  )

  app.post<{
    Body: {
      node?: string
      screens?: unknown
      subject?: string
      message?: string
      banner?: boolean
      severity?: string
    }
  }>('/tell-affected', async (req, reply) => {
    const b = req.body ?? {}
    const node = parseBlastNode(String(b.node ?? ''))
    if (!node) return reply.code(400).send({ error: 'Pick a node', code: 'BLAST_NODE' })
    const message = String(b.message ?? '')
      .trim()
      .slice(0, MESSAGE_MAX)
    if (!message) return reply.code(400).send({ error: 'Write a message', code: 'TELL_MESSAGE' })
    const subject =
      String(b.subject ?? '')
        .trim()
        .slice(0, SUBJECT_MAX) || message.slice(0, 120)
    // The audience is worked out here, never taken from the page.
    const ids = await affectedPeople(node, screensParam(b.screens), req.user?.id ?? null)
    if (!ids.length)
      return reply
        .code(400)
        .send({ error: 'Nobody used this in the last hour', code: 'TELL_NOBODY' })
    if (ids.length > TELL_MAX_PEOPLE)
      return reply.code(400).send({
        error: `That is ${ids.length} people — send it from Broadcasts instead`,
        code: 'TELL_TOO_MANY'
      })
    const channels = b.banner === false ? ['message'] : ['message', 'banner']
    const severity = ['info', 'warn', 'critical'].includes(String(b.severity)) ? b.severity : 'warn'
    const res = await send(req, {
      subject,
      message,
      severity,
      channels,
      audience: { user_ids: ids },
      ...(channels.includes('banner')
        ? { ends_at: new Date(Date.now() + BANNER_HOURS * 3600_000).toISOString() }
        : {})
    })
    if (res.status >= 300)
      return reply
        .code(res.status >= 500 ? 502 : res.status)
        .send({ error: res.body.error ?? 'The broadcast was not sent', code: 'TELL_FAILED' })
    await logActivity({
      action: 'traffic-map-tell-affected',
      user: req.user?.id,
      collection: 'nivaro_announcements',
      item: res.body.data?.id != null ? String(res.body.data.id) : undefined,
      comment: `Told ${ids.length} ${ids.length === 1 ? 'person' : 'people'} affected by ${node.key}: ${subject.slice(0, 100)}`,
      req
    })
    return {
      data: {
        announcement: res.body.data?.id ?? null,
        recipients: ids.length,
        delivered: res.body.data?.delivered ?? null
      }
    }
  })

  // ── #2215 debug windows ──────────────────────────────────────────────────
  app.get('/debug-windows', async () => ({
    data: {
      windows: debugWindows(),
      available: timedRulesAvailable(),
      default_minutes: DEBUG_DEFAULT_MIN,
      max_minutes: DEBUG_MAX_MIN
    }
  }))
  app.post<{ Body: { target?: string; minutes?: number } }>(
    '/debug-windows',
    async (req, reply) => {
      try {
        const rule = await startDebugWindow({
          target: String(req.body?.target ?? ''),
          minutes: req.body?.minutes,
          user: (req.user ?? {}) as User,
          req
        })
        return { data: rule }
      } catch (err) {
        return fail(reply, err)
      }
    }
  )
  app.delete<{ Params: { id: string } }>('/debug-windows/:id', async (req, reply) => {
    if (!ID_RE.test(req.params.id)) return reply.code(400).send({ error: 'Bad id' })
    try {
      return { data: { stopped: await stopDebugWindow(req.params.id) } }
    } catch (err) {
      return reply.code(503).send({ error: (err as Error).message, code: 'DEBUG_UNAVAILABLE' })
    }
  })
  app.get<{ Params: { id: string } }>('/debug-windows/:id/traces', async (req, reply) => {
    if (!ID_RE.test(req.params.id)) return reply.code(400).send({ error: 'Bad id' })
    return { data: { traces: debugWindowTraces(req.params.id) } }
  })

  // ── #2273 temporary caches ───────────────────────────────────────────────
  app.get<{ Querystring: { target?: string } }>('/temp-caches', async (req) => {
    const target = req.query.target ? String(req.query.target) : null
    return {
      data: {
        caches: await tempCaches(),
        available: timedRulesAvailable(),
        cacheable: target ? cacheableCollection(target) !== null : null,
        default_minutes: CACHE_DEFAULT_MIN,
        max_minutes: CACHE_MAX_MIN,
        default_entry_s: ENTRY_S_DEFAULT,
        max_entry_s: ENTRY_S_MAX
      }
    }
  })
  app.post<{ Body: { target?: string; minutes?: number; entry_s?: number } }>(
    '/temp-caches',
    async (req, reply) => {
      try {
        const rule = await startTempCache({
          target: String(req.body?.target ?? ''),
          minutes: req.body?.minutes,
          entrySeconds: req.body?.entry_s,
          user: (req.user ?? {}) as User,
          req
        })
        return { data: rule }
      } catch (err) {
        return fail(reply, err)
      }
    }
  )
  app.delete<{ Params: { id: string } }>('/temp-caches/:id', async (req, reply) => {
    if (!ID_RE.test(req.params.id)) return reply.code(400).send({ error: 'Bad id' })
    try {
      return { data: { stopped: await stopTempCache(req.params.id) } }
    } catch (err) {
      return reply.code(503).send({ error: (err as Error).message, code: 'CACHE_UNAVAILABLE' })
    }
  })

  // ── #2223 detector settings ──────────────────────────────────────────────
  app.get('/detectors', async () => ({
    data: { instance_key: instanceKey(), detectors: DETECTORS, settings: detectorSettings() }
  }))
  app.put<{ Body: { settings?: unknown } }>('/detectors', async (req, reply) => {
    const patch = req.body?.settings
    if (!patch || typeof patch !== 'object' || Array.isArray(patch))
      return reply
        .code(400)
        .send({ error: 'settings must be an object', code: 'DETECTORS_INVALID' })
    const { settings, changed } = await saveDetectorSettings(patch)
    if (changed.length)
      await logActivity({
        action: 'traffic-map-detectors-update',
        user: req.user?.id,
        collection: 'nivaro_settings',
        comment: `Traffic Map detectors on ${instanceKey()}: ${changed.join(', ')}`.slice(0, 1000),
        req
      })
    return { data: { instance_key: instanceKey(), detectors: DETECTORS, settings, changed } }
  })

  // ── #2229 extension lenses ───────────────────────────────────────────────
  app.get('/ext-lenses', async () => ({ data: { lenses: listExtensionLenses() } }))
  app.get<{ Params: { key: string }; Querystring: { window?: string } }>(
    '/ext-lenses/:key',
    async (req, reply) => {
      const w = Number(req.query.window ?? 60)
      const win = WINDOWS.has(w) ? w : 60
      try {
        return { data: await readExtensionLens(String(req.params.key), win) }
      } catch (err) {
        if (err instanceof LensError)
          return reply.code(err.status).send({ error: err.message, code: err.code })
        throw err
      }
    }
  )
}
