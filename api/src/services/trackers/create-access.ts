import type { FastifyRequest } from 'fastify'
import { getConnection } from './connections.js'
import { type SourceKind, sourceFor } from './sources/index.js'

/**
 * May this person create / link a GitLab issue from this source on this connection? Admins: yes
 * (the services refuse a missing source). Others: only a support ticket or a record, only when
 * their role is in the connection's `create_roles`, and only one they can update (tickets: they
 * work it; records: the record's write gates, approval edit lock included).
 */
export async function mayCreateFrom(
  req: Pick<FastifyRequest, 'isAdmin' | 'user'> & Partial<FastifyRequest>,
  kind: SourceKind,
  id: string,
  connection: number
): Promise<{ ok: true } | { ok: false; status: number; code: string; error: string }> {
  if (req.isAdmin) return { ok: true }
  const refuse = {
    ok: false as const,
    status: 403,
    code: 'FORBIDDEN',
    error: 'You cannot send this to GitLab'
  }
  if (kind === 'issue' || !req.user) return refuse
  const conn = await getConnection(connection)
  if (!conn)
    return {
      ok: false,
      status: 404,
      code: 'CONNECTION_NOT_FOUND',
      error: 'Connection not found'
    }
  const role = String(req.user.role ?? '').toLowerCase()
  const roles = (conn.sync.create_roles ?? []).map((r) => String(r).toLowerCase())
  if (!role || !roles.includes(role)) return refuse
  if (!(await sourceFor(kind).canCreate(req.user, id, false, req as FastifyRequest))) return refuse
  return { ok: true }
}
