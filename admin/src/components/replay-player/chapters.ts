/**
 * Chapters (#1397) — the pure half. A recording splits at every change of
 * page: the recorder's own `route` stamps (same clock as the frames) and the
 * server's page trail (nivaro_admin_journeys, via the event rail — a second
 * or two of clock skew, and present for recordings made before the recorder
 * stamped routes). One navigation usually shows up in both; they merge.
 */

export interface Chapter {
  /** ms into the recording. */
  start: number
  end: number
  /** The page path, without query string. */
  label: string
}

export interface RouteMark {
  offset: number
  /** A path ('/items/orders?x=1') or a rail label ('/items/orders · 12 s on page'). */
  text: string
}

/** A page-trail row within this of a recorder stamp for the same path is the same navigation. */
export const CHAPTER_MERGE_MS = 3_000
/** A page left within this of arriving (a redirect hop) is not a chapter of its own. */
export const CHAPTER_MIN_MS = 750

/** '/items/orders?x=1#y' and '/items/orders · 12 s on page' → '/items/orders'. */
export function chapterPath(text: string): string {
  return String(text ?? '')
    .split(' · ')[0]
    .split(/[?#]/)[0]
    .trim()
}

/**
 * Chapters from the recorder's route stamps and the page-trail rows. The first
 * chapter starts at 0 (the page the recording opened on); the last ends at
 * `total`.
 */
export function buildChapters(
  recorder: RouteMark[],
  journeys: RouteMark[],
  total: number
): Chapter[] {
  if (!(total > 0)) return []
  const own = recorder
    .map((r) => ({ offset: r.offset, path: chapterPath(r.text) }))
    .filter((r) => r.path)
  const trail = journeys
    .map((r) => ({ offset: r.offset, path: chapterPath(r.text) }))
    .filter(
      (j) =>
        j.path &&
        !own.some((o) => o.path === j.path && Math.abs(o.offset - j.offset) <= CHAPTER_MERGE_MS)
    )
  const marks = [...own, ...trail]
    .map((m) => ({ ...m, offset: Math.min(total, Math.max(0, m.offset)) }))
    .sort((a, b) => a.offset - b.offset)

  // `at`: when the chapter's page was actually reached (the first chapter
  // still starts at 0).
  const out: Array<Chapter & { at: number }> = []
  for (const m of marks) {
    const cur = out[out.length - 1]
    if (cur && cur.label === m.path) continue
    if (cur && m.offset - cur.at < CHAPTER_MIN_MS) {
      // A redirect hop: the page it landed on names the chapter. Merge into
      // the one before when that is the same page.
      const prev = out[out.length - 2]
      if (prev && prev.label === m.path) out.pop()
      else cur.label = m.path
      continue
    }
    out.push({ start: out.length === 0 ? 0 : m.offset, at: m.offset, end: total, label: m.path })
  }
  return out.map((c, i) => ({
    start: c.start,
    end: i + 1 < out.length ? out[i + 1].start : total,
    label: c.label
  }))
}

/** Index of the chapter under the playhead (−1 when there are none). */
export function chapterIndexAt(chapters: Chapter[], time: number): number {
  let found = chapters.length > 0 ? 0 : -1
  for (let i = 0; i < chapters.length; i++) {
    if (chapters[i].start <= time) found = i
    else break
  }
  return found
}

/** Pressing , this far into a chapter goes back to its start; sooner goes to the one before. */
export const CHAPTER_RESTART_MS = 2_000

/**
 * Where `,` (back) and `.` (next) jump to, like a media player's previous /
 * next track. Null = nowhere to go.
 */
export function chapterJump(
  chapters: Chapter[],
  time: number,
  dir: 'prev' | 'next'
): number | null {
  const i = chapterIndexAt(chapters, time)
  if (i < 0) return null
  if (dir === 'next') return i + 1 < chapters.length ? chapters[i + 1].start : null
  if (time - chapters[i].start > CHAPTER_RESTART_MS) return chapters[i].start
  return i > 0 ? chapters[i - 1].start : chapters[i].start
}
