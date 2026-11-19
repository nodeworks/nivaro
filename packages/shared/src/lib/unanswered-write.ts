/**
 * rt-fix C (L4): a keyed write whose first try never answered.
 *
 * The server holds an Idempotency-Key as "pending" for 15 minutes while its first try runs. A
 * process stopped between the commit and its answer (a SIGKILL inside the drain) leaves the
 * claim pending: every retry gets 409 IDEMPOTENCY_IN_PROGRESS until the client's recovery
 * budget runs out, and the realtime notice that write would have sent never went out. The
 * change may well be stored — so the client re-reads the record (now, and once more a little
 * later) instead of telling the person it failed, and they see whether it landed before they
 * try again.
 */

const ITEM_WRITE = /^\/items\/([A-Za-z_][\w]{0,254})\/([^/?#]{1,255})$/
const TRANSITION = /^\/pipelines\/instance\/([A-Za-z_][\w]{0,254})\/([^/?#]{1,255})\/transition$/

/** The record a keyed write was about (`PATCH|DELETE /items/:c/:id`, a pipeline move), or null. */
export function recordOfWritePath(path: string): { collection: string; id: string } | null {
  const bare = path.split('?')[0].replace(/^\/api(?=\/)/, '')
  const m = ITEM_WRITE.exec(bare) ?? TRANSITION.exec(bare)
  if (!m) return null
  let id: string
  try {
    id = decodeURIComponent(m[2])
  } catch {
    return null
  }
  return { collection: m[1], id }
}

/** True for a `gave-up` recovery event whose write may have been stored after all. */
export function isUnansweredWrite(e: { type: string; write?: boolean; code?: string }): boolean {
  return e.type === 'gave-up' && !!e.write && e.code === 'IDEMPOTENCY_IN_PROGRESS'
}

/** The second re-read: by then a replica that finished the write late has answered. */
export const UNANSWERED_REREAD_MS = 20_000
