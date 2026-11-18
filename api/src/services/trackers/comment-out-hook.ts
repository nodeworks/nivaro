/**
 * Every place that stores a person's comment calls this right after its insert: a whole-issue
 * comment (collection `nivaro_issues`, no `field`) is handed to GitLab sync, which sends it to the
 * linked GitLab issues on the background pool. Loaded lazily so writers do not pull in the tracker
 * graph; never throws, never slows the writer (callers do not await it; tests may).
 */
export function commentWritten(
  commentId: string,
  collection: string,
  field?: string | null
): Promise<void> {
  if (collection !== 'nivaro_issues' || (field != null && field !== '')) return Promise.resolve()
  return import('./outbound-sync.js').then((m) => m.scheduleCommentOut(commentId)).catch(() => {})
}
