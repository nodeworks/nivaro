import type { FastifyRequest } from 'fastify'
import { logActivity } from '../activity.js'

/**
 * The activity row every writer of an app-managed procedure leaves: collection `sys.procedures`,
 * item = the procedure name, comment `v<version> · <note>` — the same shape the Procedures
 * routes write, so a procedure's history reads the same whichever writer saved it.
 */
export async function logManagedProcWrite(o: {
  action: string
  name: string
  version: number | null
  note: string
  userId: string | null | undefined
  req?: FastifyRequest
}): Promise<void> {
  await logActivity({
    action: o.action,
    user: o.userId ?? undefined,
    collection: 'sys.procedures',
    item: o.name,
    comment: `${o.version != null ? `v${o.version} · ` : ''}${o.note}`.slice(0, 255),
    req: o.req
  })
}
