import type { QueryClient } from '@tanstack/react-query'

/**
 * Refresh a record's Tasks slot after something created, finished or removed
 * one of its tasks — from the slot itself, a note ("Make this a task"), a chat
 * message, a support request or the new-record save. The slot keys its list on
 * ['tasks', collection, item]; the id is compared as text because callers hold
 * it as a number or a string.
 */
export function invalidateRecordTasks(
  qc: QueryClient,
  collection: string | null | undefined,
  item: string | number | null | undefined
): void {
  if (!collection || item == null) return
  void qc.invalidateQueries({
    predicate: (q) =>
      q.queryKey[0] === 'tasks' &&
      q.queryKey[1] === collection &&
      String(q.queryKey[2]) === String(item)
  })
}

/** Task statuses that still need doing (a picked-up support request is in_progress). */
export const OPEN_TASK_STATUSES = new Set(['open', 'in_progress'])
