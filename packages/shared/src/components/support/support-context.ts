import type { PreparedReplayClip, ReplayLink } from '../../lib/replay-capture'
import { formatReplayTail, getReplayTail, type ReplayTail } from '../../lib/replay-tail'

/**
 * What a support request carries about the moment it was raised (#1377):
 *
 *  - the replay: with error replay on, the recorder's rolling buffer cut into
 *    an app='support-clip' recording (the last ~minute); with full recording
 *    on, the live recording and the moment of asking. The ticket's 'Watch
 *    what they saw' link opens it seeked there.
 *  - a plain-text attachment: the page, the console tail and the last twenty
 *    requests (method, route pattern, status, ms) — no bodies, no query
 *    strings, secrets redacted (replay-context.ts).
 *
 * Every part is best-effort: a request is never refused because its context
 * could not be gathered.
 */

/** The attachment's file — `what-they-saw-2026-10-10T14-03-11.txt`. */
export function supportContextFile(text: string, when = new Date()): File {
  const stamp = when.toISOString().slice(0, 19).replace(/:/g, '-')
  return new File([text], `what-they-saw-${stamp}.txt`, { type: 'text/plain' })
}

export interface SupportContext {
  /** Id of the uploaded text attachment; null when the upload failed. */
  fileId: string | null
  replay: ReplayLink | null
  text: string
}

export async function collectSupportContext(opts: {
  /** Taken when the dialog opened (prepareReplayClip('support')). */
  clip: PreparedReplayClip | null
  route: string
  upload: (file: File) => Promise<{ id: string | number }>
  tail?: ReplayTail
  userAgent?: string | null
  when?: Date
}): Promise<SupportContext> {
  const replay = opts.clip ? await opts.clip.commit().catch(() => null) : null
  const text = formatReplayTail(opts.tail ?? getReplayTail(), {
    route: opts.route,
    when: opts.when,
    userAgent: opts.userAgent ?? null
  })
  let fileId: string | null = null
  try {
    fileId = String((await opts.upload(supportContextFile(text, opts.when))).id)
  } catch {
    fileId = null
  }
  return { fileId, replay, text }
}
