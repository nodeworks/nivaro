import type { FastifyInstance, FastifyReply } from 'fastify'
import { withTenant } from '../db/tenant-context.js'
import { allKeeps } from '../services/env-refresh/registry.js'
import {
  deleteFilesBackupSet,
  FilesBackupError,
  readFilesBackup,
  startFilesBackup
} from '../services/hub-data-app/files-backup.js'
import { getTenantRegistry } from '../services/tenancy/registry.js'
import type { TenantRecord } from '../services/tenancy/types.js'
import { NIVARO_VERSION } from '../version.js'

/**
 * Hub data care, APP side (0.3.215+): what a Hub may ask of an app for its backups and
 * refreshes. Registered inside the hub link (routes/hub-link.ts, `/api/hub-link/data/*`, a
 * dedicated app) and the deployment link (routes/hub-deployment-link.ts,
 * `/api/hub-deployment/apps/:id/data/*`, one app of a shared deployment), so each inherits that
 * link's bearer check; both are exempt from the maintenance freeze and the retire gate.
 *
 *   GET    refresh-keeps          → {version, keeps}  the env-refresh keep registry (core +
 *                                                     extensions): definitions, never values
 *   POST   files-backup           → 202 {run_id}      copy every stored file to a backup set
 *   GET    files-backup/:runId    → status            counts only
 *   POST   files-backup/delete    → {deleted}         remove one earlier backup set
 *   DELETE files                  → {deleted}         deployment link, rehearsal apps only:
 *                                                     every stored object of a `rh-` app goes
 */

function fail(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({ statusCode: status, error: message, message, code })
}

async function guarded(reply: FastifyReply, fn: () => Promise<unknown>) {
  try {
    return await fn()
  } catch (err) {
    if (err instanceof FilesBackupError) return fail(reply, err.statusCode, err.code, err.message)
    return fail(reply, 500, 'FILES_BACKUP_FAILED', 'The files backup request failed')
  }
}

function dataRoutes(
  app: FastifyInstance,
  prefix: string,
  inApp: <T>(
    id: string | undefined,
    reply: FastifyReply,
    fn: () => Promise<T>
  ) => Promise<T | FastifyReply>
) {
  app.get<{ Params: { id?: string } }>(`${prefix}/refresh-keeps`, async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
    return inApp(req.params.id, reply, async () =>
      reply.send({ version: NIVARO_VERSION, keeps: allKeeps() })
    )
  })

  app.post<{ Params: { id?: string } }>(`${prefix}/files-backup`, async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
    return inApp(req.params.id, reply, () =>
      guarded(reply, async () => reply.code(202).send(await startFilesBackup(req.body)))
    )
  })

  app.post<{ Params: { id?: string } }>(`${prefix}/files-backup/delete`, async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
    return inApp(req.params.id, reply, () =>
      guarded(reply, async () => reply.send(await deleteFilesBackupSet(req.body)))
    )
  })

  app.get<{ Params: { id?: string; runId: string } }>(
    `${prefix}/files-backup/:runId`,
    async (req, reply) => {
      reply.header('Cache-Control', 'no-store')
      return inApp(req.params.id, reply, async () => {
        const s = await readFilesBackup(req.params.runId)
        if (!s) return fail(reply, 404, 'UNKNOWN_RUN', 'No files backup with that id here')
        return reply.send(s)
      })
    }
  )
}

/** Inside routes/hub-link.ts (after its bearer hook): `/api/hub-link/data/*`. */
export function hubLinkDataRoutes(app: FastifyInstance): void {
  dataRoutes(app, '/data', async (_id, _reply, fn) => fn())
}

async function tenantById(id: string): Promise<TenantRecord | null> {
  const registry = getTenantRegistry()
  if (!registry) return null
  if (registry.byId) return registry.byId(id)
  const all = registry.listAll ? await registry.listAll() : await registry.listActive()
  return all.find((t) => t.id === id) ?? null
}

/** Inside routes/hub-deployment-link.ts (after its bearer hook): `/api/hub-deployment/apps/:id/data/*`. */
export function deploymentLinkDataRoutes(app: FastifyInstance): void {
  const inApp = async <T>(
    id: string | undefined,
    reply: FastifyReply,
    fn: () => Promise<T>
  ): Promise<T | FastifyReply> => {
    const t = id ? await tenantById(id) : null
    if (!t) return fail(reply, 404, 'UNKNOWN_APP', 'This deployment does not serve that app')
    return withTenant(t, fn, t.origin)
  }
  dataRoutes(app, '/apps/:id/data', inApp)

  // A move rehearsal's temporary app (`rh-<run>`): every stored object it got from the
  // rehearsal's file copy goes, before the Hub takes it off the list. Refused for any other app.
  app.delete<{ Params: { id: string } }>('/apps/:id/data/files', async (req, reply) => {
    reply.header('Cache-Control', 'no-store')
    if (!/^rh-[1-9][0-9]{0,9}$/.test(req.params.id))
      return fail(reply, 403, 'NOT_A_REHEARSAL', 'Only a rehearsal app’s files can be removed')
    return inApp(req.params.id, reply, async () => {
      const { purgeAppFiles } = await import('../services/hub-data-app/purge.js')
      try {
        return reply.send(await purgeAppFiles())
      } catch {
        return fail(
          reply,
          500,
          'PURGE_FAILED',
          'The rehearsal app’s files could not all be removed'
        )
      }
    })
  })
}
