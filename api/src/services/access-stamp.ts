import { configEpochNow, onConfigWrite } from '../db/config-epoch.js'
import { onPermissionCacheReset } from './permission-cache.js'

/**
 * A stamp for short-lived realtime verdict caches (security review 2026-11-14: the keystroke
 * relay's field lists, grid presence sender verdicts, list cell-lock visibility, the drag
 * relay's update answer). A cached "may this person see / change X" is only reused while the
 * stamp it was stored under is still current, so a lost permission stops at once instead of
 * when the entry's TTL runs out.
 *
 * The stamp moves when:
 *  - any socket access re-check runs on this process (`forgetJoinVerdicts` → bumpAccessStamp):
 *    a role, policy, scope or channel change on any replica reaches every replica that way;
 *  - this process writes configuration (policies, roles, … — db/config-epoch onConfigWrite);
 *  - the permission cache sees a version move from another process (when it is on);
 *  - the cluster-wide configuration epoch moves (another process or a script wrote config).
 */

let generation = 0
const bumpListeners = new Set<() => void>()

/** Every verdict cached under an older stamp is stale from now on. */
export function bumpAccessStamp(): void {
  generation = (generation + 1) % Number.MAX_SAFE_INTEGER
  for (const fn of bumpListeners) {
    try {
      fn()
    } catch {
      /* one listener never stops the rest */
    }
  }
}

/** Also drop a cache's entries when the stamp moves (keyed entries go stale anyway; this
 *  frees the memory at once). */
export function onAccessStampBump(fn: () => void): void {
  bumpListeners.add(fn)
}

/** The current stamp: this process's generation + the configuration epoch when known. */
export function accessStamp(): string {
  let epoch: number | null = null
  try {
    epoch = configEpochNow()
  } catch {
    epoch = null
  }
  return `${generation}:${epoch ?? '-'}`
}

onConfigWrite(bumpAccessStamp)
onPermissionCacheReset(() => bumpAccessStamp())
