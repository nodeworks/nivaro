// api/src/routes/traffic-map-extras/topology.ts
/**
 * Topology routes (Traffic Map group C): detail for the source nodes (cron jobs, flows, the import
 * worker, browser sockets) and the downstream nodes this group adds (email/SMS/push/Teams, AI
 * provider, webhooks, extension-declared nodes), plus the 1h/6h/24h history providers for the
 * down nodes with a log behind them. Mounted under /api/traffic-map (admin only, 404 in cloud).
 *
 * Importing this module registers every topology tap (services/traffic-taps/index.ts).
 */
import type { FastifyInstance } from 'fastify'
import { db } from '../../db/index.js'
import { getRealtimeStats } from '../../plugins/socketio.js'
import { getChannelTestConfig } from '../../services/channel-test-mode.js'
import {
  DOWN_HISTORY_ROW_CAP,
  type DownHistoryRow,
  registerDownHistory,
  summarizeDownRows
} from '../../services/traffic-down-history.js'
import '../../services/traffic-taps/index.js'
import { currentTrafficSec } from '../../services/traffic-map.js'
import { AI_TAP } from '../../services/traffic-taps/ai.js'
import { CHANNELS_TAP } from '../../services/traffic-taps/channels.js'
import {
  describeTrafficNode,
  listTrafficNodes,
  trafficNodeTester
} from '../../services/traffic-taps/nodes.js'
import { PARTNERS_TAP } from '../../services/traffic-taps/partners.js'
import { POOL_TAP } from '../../services/traffic-taps/pool.js'
import { REDIS_TAP } from '../../services/traffic-taps/redis.js'
import { SOURCES_TAP } from '../../services/traffic-taps/sources.js'
import { WEBHOOKS_TAP } from '../../services/traffic-taps/webhooks.js'
import { trafficTaps } from '../../services/traffic-taps.js'

const SOURCE_ID = /^(cron|flow|import|socket):[A-Za-z0-9_.:-]{1,160}$/
const DOWN_ID =
  /^(mail|sms|push|teams|ai:[a-z0-9-]{1,40}|webhook:\d{1,12}|x:[A-Za-z0-9_.-]{1,160})$/
const sinceOf = (hours: number) => new Date(Date.now() - hours * 3600_000)
const bit = (v: unknown) => v === true || v === 1 || v === '1'
const envOn = (v: string | undefined) => /^(1|true|yes|on)$/i.test(String(v ?? '').trim())
const clip = (v: unknown, n = 300) => (v == null ? null : String(v).slice(0, n))

let providersRegistered = false
function registerProviders(): void {
  if (providersRegistered) return
  providersRegistered = true

  registerDownHistory(
    (id) => id === 'mail',
    async (id, hours) => {
      const rows = (await db('nivaro_mail_log')
        .where('created_at', '>=', sinceOf(hours))
        .orderBy('created_at', 'desc')
        .limit(DOWN_HISTORY_ROW_CAP)
        .select('status', 'template', 'created_at')) as Array<{
        status: string
        template: string | null
        created_at: Date
      }>
      return summarizeDownRows(
        id,
        hours,
        rows.map(
          (r): DownHistoryRow => ({
            at: r.created_at,
            ok: r.status !== 'failed',
            code: r.status,
            path: r.template ?? '(no template)'
          })
        )
      )
    }
  )

  registerDownHistory(
    (id) => id.startsWith('ai:'),
    async (id, hours) => {
      const rows = (await db('nivaro_ai_calls')
        .where('provider', id.slice(3))
        .where('created_at', '>=', sinceOf(hours))
        .orderBy('created_at', 'desc')
        .limit(DOWN_HISTORY_ROW_CAP)
        .select('status', 'latency_ms', 'model', 'created_at')) as Array<{
        status: string
        latency_ms: number | null
        model: string | null
        created_at: Date
      }>
      return summarizeDownRows(
        id,
        hours,
        rows.map((r) => ({
          at: r.created_at,
          ok: r.status === 'ok',
          ms: r.latency_ms,
          code: r.status,
          path: r.model
        }))
      )
    }
  )

  registerDownHistory(
    (id) => /^webhook:\d+$/.test(id),
    async (id, hours) => {
      const rows = (await db('nivaro_webhook_deliveries')
        .where('webhook', Number(id.slice(8)))
        .where('created_at', '>=', sinceOf(hours))
        .orderBy('created_at', 'desc')
        .limit(DOWN_HISTORY_ROW_CAP)
        .select('success', 'latency_ms', 'status_code', 'event', 'created_at')) as Array<{
        success: boolean | number
        latency_ms: number | null
        status_code: number | null
        event: string | null
        created_at: Date
      }>
      return summarizeDownRows(
        id,
        hours,
        rows.map((r) => ({
          at: r.created_at,
          ok: bit(r.success),
          ms: r.latency_ms,
          code: String(r.status_code ?? 'network'),
          path: r.event
        }))
      )
    }
  )

  registerDownHistory(
    (id) => id.startsWith('x:'),
    async (id, hours) => {
      const tester = trafficNodeTester(id)
      if (!tester) {
        return {
          key: id,
          hours,
          series: [],
          note: 'This node was declared by an extension that is not loaded on this process.'
        }
      }
      const apis = (await db('nivaro_external_apis').select('id', 'name')) as Array<{
        id: number
        name: string
      }>
      const wanted = tester.apis?.map((a) => a.toLowerCase())
      const ids = apis
        .filter((a) => !wanted || wanted.includes(String(a.name).toLowerCase()))
        .map((a) => a.id)
      const nameOf = new Map(apis.map((a) => [a.id, a.name]))
      if (!ids.length) return summarizeDownRows(id, hours, [])
      const rows = (await db('nivaro_outbound_log')
        .whereIn('api_id', ids.slice(0, 500))
        .where('created_at', '>=', sinceOf(hours))
        .orderBy('created_at', 'desc')
        .limit(DOWN_HISTORY_ROW_CAP)
        .select('api_id', 'method', 'path', 'status', 'ok', 'duration_ms', 'created_at')) as Array<{
        api_id: number
        method: string | null
        path: string | null
        status: number | null
        ok: boolean | number
        duration_ms: number
        created_at: Date
      }>
      const matched = rows.filter((r) =>
        tester.test({
          apiId: r.api_id,
          apiName: String(nameOf.get(r.api_id) ?? ''),
          method: r.method,
          path: r.path
        })
      )
      return summarizeDownRows(
        id,
        hours,
        matched.map((r) => ({
          at: r.created_at,
          ok: bit(r.ok),
          ms: r.duration_ms,
          code: String(r.status ?? 'network'),
          path: `${String(r.method || 'GET').toUpperCase()} ${r.path ?? ''}`
        })),
        new Date(),
        { templatePaths: false, truncated: rows.length >= DOWN_HISTORY_ROW_CAP }
      )
    }
  )

  registerDownHistory(
    (id) => id === 'sms' || id === 'push' || id === 'teams',
    async (id, hours) => ({
      key: id,
      hours,
      series: [],
      note: `${id === 'sms' ? 'SMS' : id === 'push' ? 'Web push' : 'Teams'} sends are not logged, so there is no history beyond the live window.`
    })
  )
}

async function sourceDetail(app: FastifyInstance, id: string): Promise<Record<string, unknown>> {
  const cut = id.indexOf(':')
  const kind = id.slice(0, cut)
  const ref = id.slice(cut + 1)
  if (kind === 'cron') {
    const entry = (
      (
        app as unknown as { cron?: { list?: () => Array<Record<string, unknown>> } }
      ).cron?.list?.() ?? []
    ).find((e) => e.id === ref)
    const since = sinceOf(24)
    const [runs, counts] = await Promise.all([
      db('nivaro_job_runs')
        .where({ kind: 'cron', job_id: ref })
        .orderBy('id', 'desc')
        .limit(8)
        .select('id', 'status', 'started_at', 'finished_at', 'duration_ms', 'error')
        .catch(() => []),
      db('nivaro_job_runs')
        .where({ kind: 'cron', job_id: ref })
        .where('started_at', '>=', since)
        .groupBy('status')
        .select('status')
        .count({ n: '*' })
        .catch(() => [])
    ])
    return {
      kind,
      job: ref,
      description: clip(entry?.description, 300),
      expression: clip(entry?.expression, 80),
      next_run: entry?.nextRun ?? null,
      paused: !!entry?.paused,
      runs: (runs as Array<Record<string, unknown>>).map((r) => ({
        id: r.id,
        status: r.status,
        started_at: r.started_at,
        finished_at: r.finished_at,
        duration_ms: r.duration_ms,
        error: clip(r.error, 240)
      })),
      last_24h: Object.fromEntries(
        (counts as Array<{ status: string; n: number | string }>).map((c) => [
          c.status,
          Number(c.n)
        ])
      )
    }
  }
  if (kind === 'flow') {
    const since = sinceOf(24)
    const [flow, runs, counts] = await Promise.all([
      db('nivaro_flows')
        .where('id', ref)
        .first('id', 'name', 'status', 'trigger')
        .catch(() => null),
      db('nivaro_flow_runs')
        .where('flow', ref)
        .orderBy('started_at', 'desc')
        .limit(8)
        .select('id', 'status', 'trigger', 'started_at', 'duration_ms', 'error_message')
        .catch(() => []),
      db('nivaro_flow_runs')
        .where('flow', ref)
        .where('started_at', '>=', since)
        .groupBy('status')
        .select('status')
        .count({ n: '*' })
        .catch(() => [])
    ])
    return {
      kind,
      flow: flow ?? null,
      runs: (runs as Array<Record<string, unknown>>).map((r) => ({
        id: r.id,
        status: r.status,
        trigger: clip(r.trigger, 80),
        started_at: r.started_at,
        duration_ms: r.duration_ms,
        error: clip(r.error_message, 240)
      })),
      last_24h: Object.fromEntries(
        (counts as Array<{ status: string; n: number | string }>).map((c) => [
          c.status,
          Number(c.n)
        ])
      )
    }
  }
  if (kind === 'import') {
    const [active, recent] = await Promise.all([
      db('nivaro_import_queue')
        .whereIn('status', ['running', 'queued'])
        .orderBy('id', 'asc')
        .limit(10)
        .select('id', 'import_key', 'status', 'row_count', 'started_at', 'created_at')
        .catch(() => []),
      db('nivaro_import_queue')
        .whereIn('status', ['completed', 'error', 'canceled'])
        .orderBy('id', 'desc')
        .limit(8)
        .select('id', 'import_key', 'status', 'row_count', 'duration', 'finished_at')
        .catch(() => [])
    ])
    return { kind, active, recent }
  }
  // socket
  const stats = getRealtimeStats()
  const apps = new Map<string, number>()
  const users = new Set<string>()
  for (const s of stats.sockets) {
    const app = String(s.app ?? 'unknown')
    apps.set(app, (apps.get(app) ?? 0) + 1)
    const u = s.user as { id?: string } | string | null
    const uid = typeof u === 'string' ? u : u?.id
    if (uid) users.add(uid)
  }
  return {
    kind: 'socket',
    sockets: stats.sockets.length,
    users: users.size,
    apps: [...apps].map(([app, n]) => ({ app, n })).sort((a, b) => b.n - a.n)
  }
}

async function downDetail(id: string): Promise<Record<string, unknown>> {
  if (id.startsWith('webhook:')) {
    const row = (await db('nivaro_webhooks')
      .where('id', Number(id.slice(8)))
      .first()
      .catch(() => null)) as Record<string, unknown> | null
    if (!row) return { kind: 'webhook', found: false }
    let host: string | null = null
    try {
      host = new URL(String(row.url)).host
    } catch {
      host = null
    }
    const failed = await db('nivaro_webhook_deliveries')
      .where({ webhook: row.id, success: false })
      .orderBy('id', 'desc')
      .limit(5)
      .select('status_code', 'latency_ms', 'event', 'created_at')
      .catch(() => [])
    return {
      kind: 'webhook',
      found: true,
      id: row.id,
      name: clip(row.name, 120),
      host,
      enabled: bit(row.enabled ?? true),
      events: clip(row.events, 200),
      collections: clip(row.collections, 200),
      recent_failures: failed
    }
  }
  if (id.startsWith('x:')) return { kind: 'extension-node', node: describeTrafficNode(id) }
  if (id === 'mail' || id === 'sms' || id === 'push' || id === 'teams') {
    const settings = (await db('nivaro_settings')
      .orderBy('id', 'asc')
      .first()
      .catch(() => null)) as Record<string, unknown> | null
    const channel = await getChannelTestConfig().catch(() => null)
    const testMode =
      id === 'mail'
        ? envOn(process.env.MAIL_TEST_MODE) || bit(settings?.mail_test_mode)
        : id === 'sms'
          ? envOn(process.env.SMS_TEST_MODE) || bit(settings?.sms_test_mode)
          : id === 'push'
            ? !!channel?.push.on
            : !!channel?.teams.on
    return { kind: 'channel', channel: id, test_mode: testMode }
  }
  return { kind: id.startsWith('ai:') ? 'ai' : 'service' }
}

const TOPOLOGY_TAPS = new Set([
  SOURCES_TAP,
  PARTNERS_TAP,
  POOL_TAP,
  REDIS_TAP,
  CHANNELS_TAP,
  AI_TAP,
  WEBHOOKS_TAP
])
const WINDOWS = new Set([60, 300, 900])

export async function topologyRoutes(app: FastifyInstance): Promise<void> {
  registerProviders()

  /**
   * The topology taps' window figures, fresh (the page snapshot is only re-read on reconnect or a
   * window change, so the inspector and the canvas overlays poll this instead).
   */
  app.get<{ Querystring: { window?: string } }>('/topology', async (req, reply) => {
    const windowS = Number(req.query.window ?? 60)
    if (!WINDOWS.has(windowS)) {
      return reply
        .code(400)
        .send({ error: 'window must be 60, 300 or 900', code: 'WINDOW_INVALID' })
    }
    const sec = currentTrafficSec()
    const data: Record<string, unknown> = {}
    for (const t of trafficTaps()) {
      if (!TOPOLOGY_TAPS.has(t.id) || !t.snapshot) continue
      try {
        const v = t.snapshot(windowS, sec)
        if (v !== undefined) data[t.id] = v
      } catch (err) {
        req.log.warn({ err, tap: t.id }, 'traffic-map topology tap failed')
      }
    }
    data.nodes = listTrafficNodes()
    return { data, window_s: windowS }
  })

  /** Detail for a source node: last runs from nivaro_job_runs / nivaro_flow_runs / the import queue. */
  app.get<{ Querystring: { id?: string } }>('/source-detail', async (req, reply) => {
    const id = String(req.query.id ?? '')
    if (!SOURCE_ID.test(id)) {
      return reply.code(400).send({ error: 'id is not a source', code: 'SOURCE_ID_INVALID' })
    }
    try {
      return { data: await sourceDetail(app, id) }
    } catch (err) {
      req.log.warn({ err }, 'traffic-map source detail failed')
      return reply.code(503).send({
        error: 'Source detail could not be read right now',
        code: 'SOURCE_DETAIL_UNAVAILABLE'
      })
    }
  })

  /** Detail for a topology down node (webhook config, extension node, channel test mode). */
  app.get<{ Querystring: { id?: string } }>('/down-detail', async (req, reply) => {
    const id = String(req.query.id ?? '')
    if (!DOWN_ID.test(id)) {
      return reply.code(400).send({ error: 'id is not a known down node', code: 'DOWN_ID_INVALID' })
    }
    try {
      return { data: await downDetail(id) }
    } catch (err) {
      req.log.warn({ err }, 'traffic-map down detail failed')
      return reply
        .code(503)
        .send({ error: 'Detail could not be read right now', code: 'DOWN_DETAIL_UNAVAILABLE' })
    }
  })
}
