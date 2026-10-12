import { getIo } from './io-holder.js'
import { emitToTenant, keyedThrottle } from './record-events.js'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * Live signals for help videos — ids only, never titles, names or text.
 *
 * - `help-video:changed {video_id, kind}` goes to the tenant: a render landed
 *   or failed, a version was published, the requirement changed, the video was
 *   archived or restored. Every open player, Videos button and library
 *   re-reads through its own permission-checked request, so nobody learns
 *   more than the id of a video that moved.
 * - `help-video:question {video_id, question_id, kind}` goes to named people's
 *   own sockets: the asker when an author answers, the authors when someone
 *   asks. The text is fetched through the questions route (which already
 *   scopes who may see which question).
 *
 * Everything here is best-effort decoration: a failed emit never fails a write.
 */

export type HelpVideoChange = 'render' | 'published' | 'required' | 'archived' | 'restored'

// A publish queues a render and a render reports through the same row: one
// signal per video and kind per second is plenty for a re-read.
const changedThrottle = keyedThrottle(250, 1000, (key) => {
  const [tenant, videoId, kind] = key.split('|')
  emitToTenant(tenant, 'help-video:changed', { video_id: videoId, kind, at: Date.now() })
})

export function announceHelpVideoChanged(videoId: string, kind: HelpVideoChange): void {
  try {
    changedThrottle(`${currentTenantKey()}|${String(videoId).toLowerCase()}|${kind}`)
  } catch {
    /* decoration */
  }
}

export function announceHelpVideoQuestion(
  userIds: string[],
  videoId: string,
  questionId: string,
  kind: 'asked' | 'answered'
): void {
  try {
    const io = getIo()
    if (!io) return
    const payload = {
      video_id: String(videoId).toLowerCase(),
      question_id: String(questionId).toLowerCase(),
      kind,
      at: Date.now()
    }
    for (const id of new Set(userIds)) io.to(`user:${id}`).emit('help-video:question', payload)
  } catch {
    /* decoration */
  }
}
