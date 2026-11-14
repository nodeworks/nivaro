/**
 * "As this person" preview of a record's pipeline panel (Rob 2026-11-13):
 * `GET /pipelines/instance/:c/:i?as_user=<userId>` answers the moves exactly
 * as that person would get them — their role, their admin access, their
 * ownership of the current step, the edit lock as them — so an administrator
 * can see "Only the owner of Warehouse Submission can make this move" where
 * the person sees it. The role-only preview (`?as_role=`) has no person and
 * cannot judge owners.
 *
 * Read only: it is a GET, nothing is written as the person (the one write is
 * the administrator's own activity row, at most once per person and record
 * every 10 minutes). Only an administrator signed in as themselves may ask —
 * never from inside a View-as tab, an API key, a run-as-key or a connected
 * app, whose answer would be judged and logged as someone else.
 */
import type { FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { credentialMintRefusal } from '../middleware/authenticate.js'
import type { User } from '../types.js'
import { logActivityThrottled } from './activity.js'
import { currentTenantKey } from './tenant-rooms.js'

export interface PreviewPerson {
  user: User
  /** The person's own administrator test (their role's admin_access). */
  isAdmin: boolean
  /** The person's role id, or null. */
  role: string | null
  name: string
}

export type PreviewPersonAnswer =
  | { person: PreviewPerson }
  | { status: number; body: { error: string; code: string } }

const UUIDISH = /^[0-9a-z-]{1,64}$/i

/** Resolve `?as_user=` for the caller, or the refusal to send. */
export async function previewPersonFor(
  req: FastifyRequest,
  raw: unknown
): Promise<PreviewPersonAnswer> {
  if (!req.isAdmin || !req.user)
    return {
      status: 403,
      body: { error: 'Only administrators can preview a record as someone else', code: 'FORBIDDEN' }
    }
  // An admin signed in as themselves only: inside a View-as tab the caller is
  // already someone else, and a key or connected app is not a person.
  const refusal = credentialMintRefusal(req)
  if (refusal)
    return {
      status: 403,
      body: {
        error: 'Sign in as yourself to preview a record as someone else',
        code: refusal.code
      }
    }
  const id = typeof raw === 'string' ? raw.trim() : ''
  if (!id || !UUIDISH.test(id))
    return { status: 400, body: { error: 'as_user must be a person id', code: 'BAD_AS_USER' } }
  const user = (await db<User>('nivaro_users').where({ id, status: 'active' }).first()) as
    | User
    | undefined
  if (!user)
    return {
      status: 404,
      body: { error: 'That person was not found or is not active', code: 'AS_USER_NOT_FOUND' }
    }
  const roleId = (user as { role?: string | null }).role ?? null
  const role = roleId
    ? ((await db('nivaro_roles').where({ id: roleId }).first('id', 'admin_access')) as
        | { admin_access?: boolean | number | null }
        | undefined)
    : undefined
  const name =
    [user.first_name, user.last_name].filter(Boolean).join(' ').trim() ||
    String((user as { email?: string }).email ?? 'This person')
  return {
    person: {
      user,
      isAdmin: !!role?.admin_access,
      role: roleId ? String(roleId) : null,
      name
    }
  }
}

/** The administrator looked at a record as this person: one activity row per
 *  admin, person and record every 10 minutes (the panel refetches often). */
export function notePreviewRead(
  req: FastifyRequest,
  redis: Parameters<typeof logActivityThrottled>[0],
  person: PreviewPerson,
  collection: string,
  item: string
): void {
  const adminId = String(req.user?.id ?? '')
  const key = `pipeline-as-user:${currentTenantKey()}:${adminId}:${String(person.user.id)}:${collection}:${item}`
  void logActivityThrottled(redis, key.toLowerCase(), 600, {
    action: 'view-as-preview',
    user: adminId,
    collection,
    item,
    comment: JSON.stringify({ as_user: String(person.user.id), name: person.name }),
    req
  }).catch(() => undefined)
}
