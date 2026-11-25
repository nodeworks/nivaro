import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { withTenant } from '../db/tenant-context.js'
import { failedAuthLimiter } from '../lib/auth-fail-limiter.js'
import { trustedRequestHost } from '../lib/trust-proxy.js'
import { appBox } from '../services/app-state.js'
import { tenantSource } from '../services/deployment-mode.js'
import { isUuid } from '../services/help-video-files.js'
import {
  hubTransferMounted,
  ticketTenant,
  transferTicketFromHeader
} from '../services/hub-transfer/tickets.js'
import { FallbackFolderUnavailable } from '../services/storage/fallback.js'
import { isStoredObjectMissing } from '../services/storage/missing.js'
import {
  openTransferObject,
  probeTransferObject,
  sendOpenedObject
} from '../services/stored-object-stream.js'
import { getTenantRegistry } from '../services/tenancy/registry.js'
import type { TenantRecord } from '../services/tenancy/types.js'

/**
 * File transfer, source side (Hub phase 6, Decision 11).
 *
 *   GET /api/hub-transfer/files/:id     the stored object of the app's nivaro_files row :id
 *   GET /api/hub-transfer/replays/:id   the cold object of session replay :id (0.3.215)
 *
 * 0.3.215: every 200 also says which of the app's stores served it (`X-Nivaro-Transfer-Store:
 * env | settings`) and, for an env S3/Azure object, the bucket's hash and the object's full key
 * (`X-Nivaro-Transfer-Store-Id`, `X-Nivaro-Transfer-Stored-Key`): a target writing to the same
 * bucket copies it server-side. Never a bucket name, an endpoint or a credential. A request with
 * `X-Nivaro-Transfer-Probe: 1` gets only those headers (204, plus `X-Nivaro-Transfer-Size`), and
 * the object is never opened: the target decides on an in-bucket copy without a GET of it.
 *
 * The target of a move pulls every object from here (services/hub-transfer/pull.ts). Auth is a
 * transfer ticket the source minted on the Hub's request, and nothing else — no session, API
 * key, OAuth token or hub-link bearer: `Authorization: Transfer <ticket>` (timing-safe by
 * construction: the ticket is looked up by its sha256). 401 TRANSFER_REFUSED; 20 failures a
 * minute from one address = 429.
 *
 * The ticket decides the app (ruling R16). On a Hub shared deployment the read runs inside the
 * ticket's app (its database, its storage scope apps/<tenantId>/); the request host does not
 * pick the app — a call on the deployment's own link address or an unknown host is fine, and
 * only a host that resolves to a DIFFERENT app answers 401. On a dedicated app the ticket must
 * be one this app minted (no app part).
 *
 * Mounted where the hub link is (HUB_TOKEN on a single-app process) or on a Hub shared
 * deployment; never in Nivaro Cloud. The retire gate and the maintenance freeze let it through
 * (services/hub-link/retire.ts retiredExemptPath, services/maintenance-freeze.ts): a retired or
 * frozen source must still hand over its files.
 *
 * Serves the row's object whatever the file kind. THE ONE EXCEPTION to "help-video files are never
 * served through a file route" (gotchas): Decision 11 moves every object of the app, and this
 * route is machine-only — reachable solely with a ticket the source minted for the Hub, never by a
 * person, a session, an API key or an OAuth token. Do not copy this into any other file route.
 * It serves the object the app itself reads (P6-36): the row's saved-settings driver, then the env
 * provider's file, the FILES_FALLBACK_DIR copy and FILES_FALLBACK_URL, with
 * `X-Nivaro-Filename-Disk` (the key, percent-encoded) and `Content-Length`; never compressed. A
 * missing row, or an object none of them has, is 404 with `X-Nivaro-Transfer-Missing: 1` (the
 * pull counts only that as missing); any other read error is 503 SOURCE_READ_FAILED (with
 * `reason: FALLBACK_FOLDER_UNAVAILABLE` when FILES_FALLBACK_DIR is gone or empty).
 */

export const TRANSFER_REFUSED = 'TRANSFER_REFUSED'

/**
 * Review M-5: the header only this route's own "not found" carries. The pull counts a 404 as
 * `missing` only with it: a proxy's or another route's 404 is a read error, never "missing".
 */
export const TRANSFER_MISSING_HEADER = 'X-Nivaro-Transfer-Missing'

function missing(reply: FastifyReply, message: string) {
  reply.header(TRANSFER_MISSING_HEADER, '1')
  return refuse(reply, 404, 'NOT_FOUND', message)
}

function refuse(reply: FastifyReply, status: number, code: string, message: string) {
  return reply
    .code(status)
    .header('Cache-Control', 'no-store')
    .send({ statusCode: status, error: message, message, code })
}

/** A request host without its port, lower case; null when there is none. */
function bareHost(raw: string | null | undefined): string | null {
  const v = String(raw ?? '')
    .trim()
    .toLowerCase()
  if (!v) return null
  if (v.startsWith('[')) {
    const end = v.indexOf(']')
    return end > 0 ? v.slice(0, end + 1) : null
  }
  const colon = v.indexOf(':')
  return colon >= 0 ? v.slice(0, colon) : v
}

type TicketApp = { kind: 'dedicated' } | { kind: 'shared'; tenant: TenantRecord }

declare module 'fastify' {
  interface FastifyRequest {
    hubTransferApp?: TicketApp
  }
}

interface FileRow {
  id: unknown
  filename_disk: string | null
  type: string | null
  /** The row's provider: local, or a saved-settings s3 / azure-blob (P6-31). */
  storage?: string | null
}

// No isHelpVideoFile() check here on purpose (see the header: the one ruled exception).
async function fileRow(id: string): Promise<FileRow | null> {
  if (!isUuid(id)) return null
  const row = (await db('nivaro_files')
    .where('id', id)
    .first('id', 'filename_disk', 'type', 'storage')) as FileRow | undefined
  return row?.filename_disk ? row : null
}

/** The cold object key of a session replay, or null (unknown id, still hot, or no object). */
// Per app: true once the cold-storage columns exist (they never go away); a missing column is
// asked again after a minute (an app behind that migration that then runs it).
const coldColumn = appBox<{ ok: boolean; at: number }>(() => ({ ok: false, at: 0 }))

async function hasColdColumn(): Promise<boolean> {
  const c = coldColumn.value
  if (c.ok || (c.at && Date.now() - c.at < 60_000)) return c.ok
  const ok = await db.schema.hasColumn('nivaro_session_recordings', 'cold_key')
  coldColumn.value = { ok, at: Date.now() }
  return ok
}

async function coldReplayKey(id: string): Promise<string | null> {
  if (!isUuid(id)) return null
  if (!(await hasColdColumn())) return null
  const row = (await db('nivaro_session_recordings')
    .where({ id, cold: true })
    .whereNotNull('cold_key')
    .first('cold_key')) as { cold_key?: string | null } | undefined
  return row?.cold_key ? String(row.cold_key) : null
}

/** A key in a header: percent-encoded, slashes kept. */
function encodeKeyHeader(key: string): string {
  return encodeURIComponent(key).replace(/%2F/gi, '/')
}

/** 0.3.215: which of the app's stores served the object (`env` or `settings`). */
export const TRANSFER_STORE_HEADER = 'X-Nivaro-Transfer-Store'
/** 0.3.215, env S3/Azure only: the hash of the bucket/container (storage storeId()). */
export const TRANSFER_STORE_ID_HEADER = 'X-Nivaro-Transfer-Store-Id'
/** 0.3.215, env S3/Azure only: the object's full key in that bucket (apps/<id>/… on shared). */
export const TRANSFER_STORED_KEY_HEADER = 'X-Nivaro-Transfer-Stored-Key'
/** 0.3.215: a request header asking only where the object is (204, no body, no object opened). */
export const TRANSFER_PROBE_HEADER = 'X-Nivaro-Transfer-Probe'
/** 0.3.215: the probe's answer of the object's size. */
export const TRANSFER_SIZE_HEADER = 'X-Nivaro-Transfer-Size'

export async function hubTransferRoutes(app: FastifyInstance): Promise<void> {
  if (!hubTransferMounted()) return
  const shared = tenantSource() === 'hub'
  const authFails = failedAuthLimiter()

  /** The app the ticket opens here, or null (refused). */
  const appFor = async (req: FastifyRequest): Promise<TicketApp | null> => {
    const ticket = transferTicketFromHeader(req.headers.authorization)
    if (!ticket) return null
    const v = await ticketTenant(ticket)
    if (!v.ok) return null
    if (!shared) return v.tenant === null ? { kind: 'dedicated' } : null
    if (v.tenant === null) return null
    const registry = getTenantRegistry()
    if (!registry) return null
    const tenant = registry.byId
      ? await registry.byId(v.tenant)
      : ((await registry.listActive()).find((t) => t.id === v.tenant) ?? null)
    if (!tenant) return null
    // R16: only a host that names ANOTHER app refuses; the link address or no app is fine.
    const host = bareHost(
      trustedRequestHost(req.headers, req.socket?.remoteAddress) ?? req.hostname
    )
    if (host) {
      const all = registry.listAll ? await registry.listAll() : await registry.listActive()
      const there = all.find((t) => t.hostnames.some((h) => h.toLowerCase() === host))
      if (there && there.id !== tenant.id) return null
    }
    return { kind: 'shared', tenant }
  }

  app.addHook('onRequest', async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
    if (authFails.blocked(req.ip)) return refuse(reply, 429, TRANSFER_REFUSED, 'Too many attempts')
    let found: TicketApp | null = null
    try {
      found = await appFor(req)
    } catch {
      found = null
    }
    if (!found) {
      if (authFails.fail(req.ip))
        app.log.warn({ ip: req.ip }, 'hub transfer: refused transfer ticket')
      return refuse(reply, 401, TRANSFER_REFUSED, 'Unauthorized')
    }
    req.hubTransferApp = found
  })

  /** One stored object, as the app reads it, with the headers the pull checks. */
  const serveObject = async (
    req: FastifyRequest,
    reply: FastifyReply,
    obj: { key: string; storage: string | null | undefined; type: string | null }
  ) => {
    const { key } = obj
    reply.header('X-Nivaro-Filename-Disk', encodeKeyHeader(key))
    // 0.3.215: a header-only probe (a move deciding on an in-bucket copy). 204 either way and no
    // object is opened: `env` + bucket hash + full key + size when the env S3/Azure bucket holds
    // it, else `X-Nivaro-Transfer-Store: none` (the target then asks for the bytes as usual).
    if (req.headers[TRANSFER_PROBE_HEADER.toLowerCase()] === '1') {
      let where: Awaited<ReturnType<typeof probeTransferObject>> = null
      try {
        where = await probeTransferObject(key, obj.storage)
      } catch {
        where = null
      }
      if (!where) return reply.code(204).header(TRANSFER_STORE_HEADER, 'none').send()
      return reply
        .code(204)
        .header(TRANSFER_STORE_HEADER, 'env')
        .header(TRANSFER_STORE_ID_HEADER, where.store_id)
        .header(TRANSFER_STORED_KEY_HEADER, encodeKeyHeader(where.stored_key))
        .header(TRANSFER_SIZE_HEADER, String(where.size))
        .send()
    }
    let opened: Awaited<ReturnType<typeof openTransferObject>>
    try {
      // The object the app itself reads (P6-36): the row's saved-settings driver first
      // (P6-31), then the env chain (env S3/Azure streamed, 0.3.215), FILES_FALLBACK_DIR and
      // FILES_FALLBACK_URL included.
      opened = await openTransferObject(key, obj.storage, req.headers.range)
    } catch (err) {
      reply.removeHeader('X-Nivaro-Filename-Disk')
      // R6-I-1: only a real not-found is "missing" (404, never blocks a move). Any other read
      // error (throttling, a timeout, a refused credential) is a 5xx: the target counts the
      // row as failed, which blocks inside maintenance, so a move never releases without it.
      if (isStoredObjectMissing(err)) return missing(reply, 'Stored object not found')
      req.log.warn(
        {
          err_name: (err as { name?: unknown } | null)?.name ?? null,
          status: (err as { status?: unknown } | null)?.status ?? null
        },
        'hub transfer: a stored object could not be read'
      )
      // C-1: the fallback folder is gone or empty (an unmounted share) — said apart, so the
      // move can name the remedy. Still no path.
      if (err instanceof FallbackFolderUnavailable)
        return reply.code(503).header('Cache-Control', 'no-store').send({
          statusCode: 503,
          error: 'The files fallback folder is not available here',
          message: 'The files fallback folder is not available here',
          code: 'SOURCE_READ_FAILED',
          reason: 'FALLBACK_FOLDER_UNAVAILABLE'
        })
      return refuse(
        reply,
        503,
        'SOURCE_READ_FAILED',
        'The stored object could not be read here right now'
      )
    }
    // 0.3.215: which store holds it, so the target writes it to the same kind of store; for an
    // env S3/Azure object also the bucket's hash and the object's full key, so a target on the
    // same bucket copies it server-side (it then drops this body unread).
    reply.header(TRANSFER_STORE_HEADER, opened.store)
    if (opened.store_id && opened.stored_key) {
      reply.header(TRANSFER_STORE_ID_HEADER, opened.store_id)
      reply.header(TRANSFER_STORED_KEY_HEADER, encodeKeyHeader(opened.stored_key))
    }
    return sendOpenedObject(reply, opened, {
      contentType: obj.type || 'application/octet-stream',
      disposition: 'attachment'
    })
  }

  /** Runs `serve` inside the ticket's app (shared) or as this app (dedicated). */
  const asTicketApp = (req: FastifyRequest, serve: () => Promise<unknown>) => {
    const found = req.hubTransferApp as TicketApp
    return found.kind === 'shared' ? withTenant(found.tenant, serve, found.tenant.origin) : serve()
  }

  app.get<{ Params: { id: string } }>(
    '/files/:id',
    { compress: false, exposeHeadRoute: false },
    async (req, reply) => {
      if (!req.hubTransferApp) return refuse(reply, 401, TRANSFER_REFUSED, 'Unauthorized')
      return asTicketApp(req, async () => {
        const row = await fileRow(req.params.id)
        if (!row?.filename_disk) return missing(reply, 'Not found')
        return serveObject(req, reply, {
          key: row.filename_disk,
          storage: row.storage,
          type: row.type
        })
      })
    }
  )

  // 0.3.215: the cold object of a session replay (nivaro_session_recordings.cold_key), so a move
  // takes replays along. A hot replay lives in the database, which the move keeps.
  app.get<{ Params: { id: string } }>(
    '/replays/:id',
    { compress: false, exposeHeadRoute: false },
    async (req, reply) => {
      if (!req.hubTransferApp) return refuse(reply, 401, TRANSFER_REFUSED, 'Unauthorized')
      return asTicketApp(req, async () => {
        const key = await coldReplayKey(req.params.id)
        if (!key) return missing(reply, 'Not found')
        // Written through the active storage driver (session-replay-storage.ts): asked first.
        return serveObject(req, reply, { key, storage: 'replay', type: 'application/gzip' })
      })
    }
  )

  // Hub gap sqlite (0.3.215): the app's SQLite database file, for a move. Only while the app is
  // proven frozen (409 SOURCE_NOT_FROZEN); the file is frozen and snapshotted, then streamed
  // with Content-Length and X-Nivaro-Sha256 (services/hub-transfer/database.ts).
  app.get('/database', { compress: false, exposeHeadRoute: false }, async (req, reply) => {
    const found = req.hubTransferApp
    if (!found) return refuse(reply, 401, TRANSFER_REFUSED, 'Unauthorized')
    const { databaseSnapshot, snapshotStream, DatabaseTransferError } = await import(
      '../services/hub-transfer/database.js'
    )
    const serve = async () => {
      try {
        const snap = await databaseSnapshot(found.kind === 'shared' ? found.tenant : null)
        return reply
          .header('Content-Type', 'application/octet-stream')
          .header('Content-Length', String(snap.bytes))
          .header('X-Nivaro-Sha256', snap.sha256)
          .send(snapshotStream(snap.path))
      } catch (err) {
        const e = err as { code?: unknown; message?: unknown; statusCode?: unknown }
        if (err instanceof DatabaseTransferError || (e && typeof e.code === 'string'))
          return refuse(
            reply,
            typeof e.statusCode === 'number' ? e.statusCode : 409,
            String(e.code),
            String(e.message)
          )
        throw err
      }
    }
    return found.kind === 'shared' ? withTenant(found.tenant, serve, found.tenant.origin) : serve()
  })
}
