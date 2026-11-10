import type { Redis } from 'ioredis'
import { currentTenantKey } from './tenant-rooms.js'
import { emitToUserRoom } from './user-sync.js'

/**
 * Sign-out note (2026-11-10, Rob): an administrator signing a person out from
 * their user card or the people page's Admin tools may leave a short message.
 * The person's open tabs get it live (`session:signed-out-note`, sent just
 * before `session:ended`) and keep it on the sign-in page until they sign in
 * again; a person with no tab open sees it once right after their next
 * sign-in (GET /security/my/sign-out-note, then DELETE).
 *
 * Stored per tenant + person in Redis for 14 days. The text goes only to the
 * person's own `user:<id>` room (only their sockets join it) and back to them
 * through their own signed-in read — it is a message TO them.
 */

export const SIGN_OUT_NOTE_EVENT = 'session:signed-out-note'
export const SIGN_OUT_NOTE_MAX = 280
export const SIGN_OUT_NOTE_TTL_S = 14 * 24 * 60 * 60

export interface SignOutNote {
  /** The person signed out — a browser keeps the note only for them (shared devices). */
  user_id: string
  message: string
  /** Who signed them out, as their name reads in the app. */
  by_name: string | null
  /** ISO time of the sign-out. */
  at: string
}

export function signOutNoteKey(userId: string, tenant: string = currentTenantKey()): string {
  return `nvr:signout-note:${tenant || '-'}:${String(userId).toUpperCase()}`
}

/**
 * The request body's optional message: null when absent or blank, the trimmed
 * text when valid, or an error string the route answers with 400.
 */
export function parseSignOutMessage(raw: unknown): { message: string | null } | { error: string } {
  if (raw == null) return { message: null }
  if (typeof raw !== 'string') return { error: 'The message must be text' }
  // One line on the sign-in page: collapse line breaks and runs of spaces.
  const message = raw.replace(/\s+/g, ' ').trim()
  if (!message) return { message: null }
  if (message.length > SIGN_OUT_NOTE_MAX)
    return { error: `The message is too long — ${SIGN_OUT_NOTE_MAX} characters at most` }
  return { message }
}

export function readNote(raw: string | null): SignOutNote | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as Partial<SignOutNote>
    if (typeof v?.message !== 'string' || !v.message || typeof v.at !== 'string') return null
    return {
      user_id: typeof v.user_id === 'string' ? v.user_id : '',
      message: v.message,
      by_name: typeof v.by_name === 'string' && v.by_name ? v.by_name : null,
      at: v.at
    }
  } catch {
    return null
  }
}

/** Store the note for the person's next sign-in, then tell their open tabs. */
export async function leaveSignOutNote(
  redis: Pick<Redis, 'set'>,
  userId: string,
  note: SignOutNote
): Promise<void> {
  await redis.set(signOutNoteKey(userId), JSON.stringify(note), 'EX', SIGN_OUT_NOTE_TTL_S)
  emitToUserRoom(userId, SIGN_OUT_NOTE_EVENT, note)
}

export async function takeSignOutNote(
  redis: Pick<Redis, 'get'>,
  userId: string
): Promise<SignOutNote | null> {
  return readNote(await redis.get(signOutNoteKey(userId)))
}

export async function clearSignOutNote(redis: Pick<Redis, 'del'>, userId: string): Promise<void> {
  await redis.del(signOutNoteKey(userId))
}
