import { viewAsAdminOf } from './view-as-attribution.js'

/**
 * The columns a "mark read" writes. A View-as tab moves the person's inbox like they would, but
 * stamps no read_at: an administrator looking as someone is never that person reading it —
 * mention read receipts, "Seen by" and mention delivery all read read_at (realtime round 7).
 * Every route that marks a notification read (read, read-all, mark-read, bulk, acknowledge)
 * writes through this.
 */
export function readMark(req: unknown): { status: 'read'; read_at?: Date } {
  return viewAsAdminOf(req) ? { status: 'read' } : { status: 'read', read_at: new Date() }
}
