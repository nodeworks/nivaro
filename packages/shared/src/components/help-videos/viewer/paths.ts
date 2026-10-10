import type { HelpVideoDto, MyLearningPathDto } from '../types'

// Learning paths (#1508) as the cards show them.

/** "3 of 5 watched", "Finished" or "Nothing to watch yet". */
export function pathProgressLabel(p: Pick<MyLearningPathDto, 'progress'>): string {
  const { total, completed, finished } = p.progress
  if (total === 0) return 'Nothing to watch yet'
  if (finished) return 'Finished'
  return `${completed} of ${total} watched`
}

/** The video "Continue" opens: the next unfinished one, else the first. */
export function continueVideo(
  p: Pick<MyLearningPathDto, 'videos' | 'next_video_id'>
): HelpVideoDto | null {
  if (p.next_video_id) {
    const hit = p.videos.find((v) => v.id === p.next_video_id)
    if (hit) return hit
  }
  return p.videos[0] ?? null
}

/** The card's heading. */
export function pathsHeading(paths: Array<Pick<MyLearningPathDto, 'progress'>>): string {
  const open = paths.filter((p) => !p.progress.finished).length
  if (paths.length === 1) return 'Your learning path'
  return open <= 1 ? 'Your learning paths' : `Your learning paths · ${open} to finish`
}

/** Moves the item at `from` to `to` (both indexes inside the list); anything
 *  out of range answers the same list. */
export function moveItem<T>(list: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return list
  const next = [...list]
  const [item] = next.splice(from, 1)
  next.splice(to, 0, item)
  return next
}
