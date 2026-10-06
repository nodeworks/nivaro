/**
 * Writes made BY a transition action (#818) — `create_record`, the
 * `on_success` / `on_failure` writebacks onto the transitioning record, and
 * `on_success_children` — go through the items service, so auto ids,
 * revisions, activity, stored rollups, the integrity check, subscriptions and
 * the auto-transition hooks see them like any other write.
 *
 * WHO WRITES: the person who drove the transition keeps the attribution (the
 * activity row names them) but writes with the administrator role — the write
 * is a system consequence of a transition that was already authorized, and a
 * person who may approve a request rarely holds update rights on the column
 * an integration's answer lands in. An automatic transition (no person) writes
 * as the system: no user id (activity `user` NULL, origin `machine`), the
 * administrator role. Same shape as the cross-collection sync writer
 * (hooks/cross-triggers.ts syncWriter).
 *
 * WHY A RAW FALLBACK: a writeback is the evidence of what the partner said —
 * `mdsi_status = 'error'` is what the failure banner keys off, an order number
 * is what completes the record. When the items service refuses the write (a
 * validation rule, an unregistered collection, a picker rule) the value still
 * lands raw, as it did before this change, and the refusal is logged. A
 * writeback never throws out of an action.
 *
 * This module imports the items service LAZILY: workflow-actions is reached
 * from items → hooks → cross-triggers, and a static import would be a cycle.
 */
import { db } from '../db/index.js'
import type { User } from '../types.js'

/** The change reason every action write carries — registered as a machine
 *  marker (extensions/related-notes.ts) so it never reads as a person's note,
 *  and read as origin `machine` by note-authorship. */
// efp-ops' LinX after-hook matches this exact prefix on ctx.changeReason to
// avoid pushing a transition's write-back a second time — rename both together.
export const ACTION_WRITE_PREFIX = 'transition-action:'

export function actionWriteReason(label: string | null | undefined): string {
  const l = String(label ?? '').trim()
  return `${ACTION_WRITE_PREFIX} ${l || 'automation'}`.slice(0, 255)
}

let adminRoleCache: { id: string | null; at: number } | null = null

/** Tests only — forget the cached administrator role. */
export function resetActionWriterCache(): void {
  adminRoleCache = null
}

async function adminRoleId(): Promise<string | null> {
  if (adminRoleCache && Date.now() - adminRoleCache.at < 60_000) return adminRoleCache.id
  const role = (await db('nivaro_roles').where({ admin_access: true }).orderBy('id').first('id')) as
    | { id: string }
    | undefined
  adminRoleCache = { id: role?.id ?? null, at: Date.now() }
  return adminRoleCache.id
}

/**
 * The identity an action writes as. Pure — the person row (or null for an
 * automatic transition) plus the administrator role id.
 */
export function buildActionWriter(
  person: Record<string, unknown> | null | undefined,
  adminRole: string
): User {
  if (person && person.id) {
    // Never carry an API key's narrowed scopes or sandbox flag into a system
    // consequence: the transition itself was the authorized act.
    const {
      api_key_scopes: _s,
      api_key_scope_restrictions: _r,
      api_key_sandbox: _b,
      ...rest
    } = person
    return { ...(rest as unknown as User), role: adminRole }
  }
  return {
    id: undefined as unknown as string,
    first_name: 'Automatic',
    last_name: null,
    email: '',
    external_id: null,
    role: adminRole,
    status: 'active',
    account_kind: 'service',
    static_token: null,
    last_access: null,
    last_page: null,
    preferences: null,
    current_workspace: null,
    manager_id: null,
    delegate_id: null,
    delegate_expires_at: null,
    is_out_of_office: false,
    created_at: new Date(0),
    updated_at: new Date(0)
  } as unknown as User
}

/** The writer for an action run by `userId` (null = an automatic transition).
 *  Null when the instance has no administrator role at all — callers fall
 *  back to the raw write. */
export async function actionWriter(userId: string | null | undefined): Promise<User | null> {
  const role = await adminRoleId()
  if (!role) return null
  let person: Record<string, unknown> | null = null
  if (userId) {
    try {
      person =
        ((await db('nivaro_users').where({ id: userId }).first()) as
          | Record<string, unknown>
          | undefined) ?? null
    } catch {
      person = null
    }
  }
  return buildActionWriter(person, role)
}

export type ActionWritePath = 'items' | 'raw' | 'failed'

/**
 * Update one row as an action. Items service first; on refusal the raw write
 * (plus the stored-rollup recalc the raw write would otherwise skip). Never
 * throws.
 */
export async function updateAsAction(
  writer: User | null,
  collection: string,
  id: string | number,
  patch: Record<string, unknown>,
  reason: string
): Promise<ActionWritePath> {
  if (Object.keys(patch).length === 0) return 'items'
  if (writer) {
    try {
      const { updateOne } = await import('./items.js')
      await updateOne(writer, collection, id, { ...patch, _change_reason: reason })
      return 'items'
    } catch (err) {
      console.warn(
        `[transition-action] items service refused the write to ${collection}/${id} — writing raw:`,
        err instanceof Error ? err.message : err
      )
    }
  }
  try {
    const before = (await db(collection).where({ id }).first()) as
      | Record<string, unknown>
      | undefined
    await db(collection).where({ id }).update(patch)
    if (before) {
      const { recalcAffectedRollups } = await import('./rollups.js')
      await recalcAffectedRollups(collection, { ...before, ...patch }, before)
    }
    return 'raw'
  } catch (err) {
    console.error({ err, collection, id }, 'transition action writeback failed')
    return 'failed'
  }
}

/**
 * Create one row as an action through the items service. Returns the new
 * row's id. THROWS on refusal — a create the items service refuses is the
 * action failing (its `on_failure` writeback runs), not something to slip in
 * raw past the rules that refused it.
 */
export async function createAsAction(
  writer: User,
  collection: string,
  row: Record<string, unknown>,
  reason: string
): Promise<unknown> {
  const { createOne } = await import('./items.js')
  const created = (await createOne(writer, collection, { ...row, _change_reason: reason })) as
    | Record<string, unknown>
    | null
    | undefined
  const id = created?.id
  // tedious can hand an OBJECT back on raw `.returning` paths — never here,
  // but a caller-shaped id must still come out a scalar.
  if (id && typeof id === 'object' && 'id' in (id as object)) return (id as { id: unknown }).id
  return id ?? null
}
