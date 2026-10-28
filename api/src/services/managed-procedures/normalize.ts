import { createHash } from 'node:crypto'

/**
 * The one normal form of a stored-procedure body, shared by every writer that compares a body
 * with what a database holds (config deploy by hash, adoption's golden check, drift readiness).
 * It is deploy-procedures' `norm`, verbatim: drop a leading `-- @app-managed…` line, fold the
 * first `create [or alter] proc[edure]` to `create proc`, collapse whitespace, trim, lowercase.
 * So a body deployed as CREATE OR ALTER compares equal to the CREATE text sys.sql_modules
 * keeps. Comments other than the marker are part of the body and stay.
 */

/** The first line a vendored file carries when its body is owned by app config. */
export const APP_MANAGED_MARKER = '-- @app-managed'

/** The body without a leading `-- @app-managed…` line (any other text is returned as is). */
export function stripAppManagedMarker(s: string): string {
  return s.startsWith(APP_MANAGED_MARKER) ? s.slice(s.indexOf('\n') + 1) : s
}

/** The normal form two bodies are compared in. */
export function normalizeProcBody(s: string): string {
  return stripAppManagedMarker(s)
    .replace(/create\s+(or\s+alter\s+)?proc(edure)?/i, 'create proc')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** sha256 hex of the normal form — `body_hash` / `deployed_hash`. */
export function procBodyHash(s: string): string {
  return createHash('sha256').update(normalizeProcBody(s)).digest('hex')
}
