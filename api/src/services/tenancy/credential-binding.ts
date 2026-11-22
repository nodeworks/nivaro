import { getTenantId } from '../../db/tenant-context.js'
import { tenantSource } from '../deployment-mode.js'

// ─── One app per credential on a Hub shared deployment (Hub phase 6 Task 12) ─────────────────
// A shared deployment serves many apps from one process, one Redis and one SESSION_SECRET, and
// its apps are often copies of each other (dev, staging and production share user ids and row
// ids). A ticket or token minted while app A is serving must therefore never work for app B:
// a Redis-stored value carries the app (`t`) and the reader refuses another app's (or none);
// a value signed with the shared key has the app in its HMAC input. Same pattern as the session
// app stamp (auth/session.ts, ruling P5-16).
//
// Only on the Hub source (ruling R13): Nivaro Cloud and self-hosted mint and accept exactly what
// they did before, so tokens issued before this change stay valid there.

/** The app a credential minted now belongs to: the current app on a Hub shared deployment
 *  ('' outside one), undefined anywhere else (nothing to stamp). */
export function appCredentialTag(): string | undefined {
  if (tenantSource() !== 'hub') return undefined
  return getTenantId() ?? ''
}

/** True when a stored credential's `t` must not be used here: on a Hub shared deployment, one
 *  of another app, one with no app, or a request with no app. Always false elsewhere. */
export function appCredentialRefused(t: unknown): boolean {
  if (tenantSource() !== 'hub') return false
  const here = getTenantId() ?? ''
  return !here || typeof t !== 'string' || t !== here
}

/** An HMAC input bound to the current app on a Hub shared deployment (unchanged elsewhere): a
 *  value signed while app A is serving does not verify while app B is. */
export function appBoundSigInput(input: string): string {
  if (tenantSource() !== 'hub') return input
  return `${input}|app:${getTenantId() ?? ''}`
}

/** A Redis key part that names the current app on a Hub shared deployment ('' elsewhere, so
 *  keys in Nivaro Cloud and self-hosted stay exactly as they were). */
export function appKeyPart(): string {
  if (tenantSource() !== 'hub') return ''
  return `app:${getTenantId() ?? '-'}:`
}
