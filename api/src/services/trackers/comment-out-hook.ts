import { parseRecordId } from './sources/types.js'

/**
 * Every place that stores a person's comment calls this right after its insert: a whole-thread
 * comment (no `field`) on an issue (`nivaro_issues`), a support ticket (`nivaro_tasks`) or a
 * business record is handed to GitLab sync, which sends it to the GitLab issues that issue / ticket
 * / record is linked to, on the background pool. Loaded lazily so writers do not pull in the
 * tracker graph; never throws, never slows the writer (callers do not await it; tests may).
 */
export function commentWritten(
  commentId: string,
  collection: string,
  field?: string | null
): Promise<void> {
  if (field != null && field !== '') return Promise.resolve()
  // other system threads (revisions, chat, …) never go to GitLab
  const thread =
    collection === 'nivaro_issues' ||
    collection === 'nivaro_tasks' ||
    parseRecordId(`${collection}:x`) !== null
  if (!thread) return Promise.resolve()
  return import('./outbound-sync.js').then((m) => m.scheduleCommentOut(commentId)).catch(() => {})
}
