import { getIo } from './io-holder.js'

/**
 * Tells a person's other tabs and devices that something of theirs changed, so
 * they apply it now instead of on the next poll. Rides the `user:<id>` room,
 * which only that person's own sockets can join (socket-access.ts).
 *
 *   read:changed   {kind: 'notifications' | 'chat', room?}   unread state moved
 *   prefs:changed  {keys: string[]}                          preferences were saved
 *
 * Payloads carry kinds, room keys and preference NAMES — never values; the tab
 * refetches through its own permission-checked routes.
 */

export function emitToUserRoom(userId: string | null | undefined, event: string, payload: object) {
  if (!userId) return
  try {
    getIo()?.to(`user:${userId}`).emit(event, payload)
  } catch {
    /* best-effort: a sync notice never affects the write that caused it */
  }
}

/** The inbox changed state (read, archived, snoozed, removed). */
export function announceNotificationsRead(userId: string | null | undefined) {
  emitToUserRoom(userId, 'read:changed', { kind: 'notifications' })
}

/** A chat room's read marker moved. */
export function announceChatRead(userId: string | null | undefined, room: string) {
  emitToUserRoom(userId, 'read:changed', { kind: 'chat', room: String(room).slice(0, 200) })
}

/** Preferences were saved; `keys` names which. */
export function announcePrefsChanged(userId: string | null | undefined, keys: string[]) {
  emitToUserRoom(userId, 'prefs:changed', { keys: keys.slice(0, 60) })
}

/** Routes under /notifications that move unread state (method + path tail). */
const READ_MOVES = [
  /^POST \/[^/]+\/read$/,
  /^POST \/read-all$/,
  /^POST \/mark-read$/,
  /^POST \/mark-all-read$/,
  /^POST \/[^/]+\/acknowledge$/,
  /^POST \/[^/]+\/snooze$/,
  /^POST \/bulk-action$/,
  /^POST \/archive-read$/,
  /^DELETE \/[^/]+$/
]

export function movesNotificationState(method: string, pathTail: string): boolean {
  const key = `${method.toUpperCase()} ${pathTail.split('?')[0]}`
  return READ_MOVES.some((re) => re.test(key))
}
