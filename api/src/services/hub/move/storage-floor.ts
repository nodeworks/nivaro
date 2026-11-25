import { compareVersions } from '../promote-plan.js'

/**
 * From this version a move copies every stored object of the app (pure, no I/O):
 *  - objects an env-driven S3 or Azure provider (STORAGE_PROVIDER) stored, on either side, re-keyed
 *    between the bucket root (dedicated) and apps/<tenantId>/ (shared): streamed through the
 *    target, or copied by the bucket itself when both sides use the same bucket;
 *  - the cold objects of session replays (a hot replay lives in the database the move keeps).
 * Both sides must run it: the source serves the new route and headers
 * (routes/hub-transfer.ts), the target pulls them (services/hub-transfer/pull.ts). A move never
 * changes the version, so the plan's version is both sides' (VERSION_DIFFERS otherwise).
 */
export const STORAGE_COPY_SINCE = '0.3.215'

/**
 * `version` is STORAGE_COPY_SINCE or later. A version the Hub cannot read (none, not x.y.z) is
 * taken as older, and so is a pre-release of that version: the safe side keeps the blocker.
 */
export function runsStorageCopy(version: string | null | undefined): boolean {
  const m = /^v?(\d+\.\d+\.\d+)(.*)$/.exec((version ?? '').trim())
  if (!m) return false
  const c = compareVersions(m[1], STORAGE_COPY_SINCE)
  return c > 0 || (c === 0 && !m[2].startsWith('-'))
}
