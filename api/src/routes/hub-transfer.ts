import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { withTenant } from '../db/tenant-context.js'
import { failedAuthLimiter } from '../lib/auth-fail-limiter.js'
import { trustedRequestHost } from '../lib/trust-proxy.js'
import { tenantSource } from '../services/deployment-mode.js'
import { isUuid } from '../services/help-video-files.js'
import {
  hubTransferMounted,
  ticketTenant,
  transferTicketFromHeader
} from '../services/hub-transfer/tickets.js'
import { isStoredObjectMissing } from '../services/storage/missing.js'
import { openTransferObject, sendOpenedObject } from '../services/stored-object-stream.js'
import { getTenantRegistry } from '../services/tenancy/registry.js'
import type { TenantRecord } from '../services/tenancy/types.js'

/**
 * File transfer, source side (Hub phase 6, Decision 11).
 *
 *   GET /api/hub-transfer/files/:id   the stored object of the app's nivaro_files row :id
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
 * missing row, or an object none of them has, is 404; any other read error is 503
 * SOURCE_READ_FAILED.
 */

export const TRANSFER_REFUSED = 'TRANSFER_REFUSED'

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

  app.get<{ Params: { id: string } }>(
    '/files/:id',
    { compress: false, exposeHeadRoute: false },
    async (req, reply) => {
      const found = req.hubTransferApp
      if (!found) return refuse(reply, 401, TRANSFER_REFUSED, 'Unauthorized')
      const serve = async () => {
        const row = await fileRow(req.params.id)
        if (!row?.filename_disk) return refuse(reply, 404, 'NOT_FOUND', 'Not found')
        const key = row.filename_disk
        reply.header('X-Nivaro-Filename-Disk', encodeURIComponent(key).replace(/%2F/gi, '/'))
        let opened: Awaited<ReturnType<typeof openTransferObject>>
        try {
          // The object the app itself reads (P6-36): the row's saved-settings driver first
          // (P6-31), then the local chain, FILES_FALLBACK_DIR and FILES_FALLBACK_URL included.
          opened = await openTransferObject(key, row.storage, req.headers.range)
        } catch (err) {
          reply.removeHeader('X-Nivaro-Filename-Disk')
          // R6-I-1: only a real not-found is "missing" (404, never blocks a move). Any other read
          // error (throttling, a timeout, a refused credential) is a 5xx: the target counts the
          // row as failed, which blocks inside maintenance, so a move never releases without it.
          if (isStoredObjectMissing(err))
            return refuse(reply, 404, 'NOT_FOUND', 'Stored object not found')
          req.log.warn(
            {
              err_name: (err as { name?: unknown } | null)?.name ?? null,
              status: (err as { status?: unknown } | null)?.status ?? null
            },
            'hub transfer: a stored object could not be read'
          )
          return refuse(
            reply,
            503,
            'SOURCE_READ_FAILED',
            'The stored object could not be read here right now'
          )
        }
        return sendOpenedObject(reply, opened, {
          contentType: row.type || 'application/octet-stream',
          disposition: 'attachment'
        })
      }
      return found.kind === 'shared'
        ? withTenant(found.tenant, serve, found.tenant.origin)
        : serve()
    }
  )
}
