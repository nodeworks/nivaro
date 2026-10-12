/**
 * System tables (`nivaro_*`, and the legacy `directus_*` copies) are never
 * business collections. Through the generic items API a non-admin reads one
 * of them only when it is listed here, and only the columns listed — a `*`
 * policy never reaches them, and no non-admin writes one.
 *
 * Before this, a role holding a `*` policy (Workflow Creator / Approver) read
 * every column of nivaro_users through /items — static_token included — and
 * could PATCH any user's role or token.
 */
import { DIRECTORY_USER_COLS } from './user-directory-cols.js'

const SYSTEM_COLLECTION = /^(nivaro_|directus_)/i

export function isSystemCollection(collection: string): boolean {
  return SYSTEM_COLLECTION.test(collection)
}

/** System collections a non-admin may READ through the items API, and the
 *  columns they may read: the person directory (what GET /users gives a
 *  non-admin) plus what pickers and avatars show. */
const SYSTEM_READABLE: Record<string, readonly string[]> = {
  nivaro_users: [
    ...DIRECTORY_USER_COLS,
    'avatar',
    'avatar_updated_at',
    'is_redacted',
    'account_kind',
    'manager_id'
  ]
}

/** The columns a non-admin may read on a system collection; null = none. */
export function systemReadableColumns(collection: string): readonly string[] | null {
  return SYSTEM_READABLE[collection.toLowerCase()] ?? null
}

/**
 * Credential and identity columns on system tables. Never returned, filtered,
 * sorted, searched or grouped through the items API — whoever asks, admins
 * included.
 */
const SYSTEM_SENSITIVE: Record<string, readonly string[]> = {
  nivaro_users: ['password_hash', 'totp_secret', 'static_token', 'external_id']
}

export function sensitiveColumns(collection: string): readonly string[] {
  return SYSTEM_SENSITIVE[collection.toLowerCase()] ?? []
}

/** Credentials by NAME: refused as any segment of a filter, sort or relation
 *  path, since a relation path reaches nivaro_users from any business record
 *  (`created_by.static_token`). */
const SECRET_COLUMNS = new Set(['password_hash', 'totp_secret', 'static_token', 'external_id'])

export function isSecretColumn(name: string): boolean {
  return SECRET_COLUMNS.has(name.toLowerCase())
}
