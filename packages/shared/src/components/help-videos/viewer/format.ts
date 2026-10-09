import { sourceToEdited } from '../edits'
import type { HelpVideoDto, VideoEdits } from '../types'

export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '—'
  const total = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const ss = String(s).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

export function progressLabel(v: Pick<HelpVideoDto, 'my_progress' | 'required'>): {
  text: string
  done: boolean
} {
  const p = v.my_progress
  if (p?.completed) return { text: 'Watched', done: true }
  if (!p || p.percent === 0) {
    return { text: v.required ? 'Required — not watched' : 'Not watched', done: false }
  }
  return { text: `${p.percent}% watched`, done: false }
}

/** The published cut is still being prepared (the stream would answer 409
 *  HELP_VIDEO_PROCESSING). Every list says so instead of showing a duration
 *  that will not play. */
export function isGettingReady(v: Pick<HelpVideoDto, 'published'>): boolean {
  return v.published?.playable === false
}

/** The second line of a list row. A video that is not ready yet is never
 *  "overdue": the person cannot watch it, so nothing blames them. */
export function listMeta(
  v: Pick<HelpVideoDto, 'published' | 'duration_ms' | 'my_progress' | 'required'>
): { text: string; overdue: boolean } {
  if (isGettingReady(v)) return { text: 'Getting ready', overdue: false }
  const p = progressLabel(v)
  return {
    text: `${formatDuration(v.published ? v.duration_ms : null)} · ${p.text}`,
    overdue: v.required && !p.done
  }
}

export function visibleChapters(
  edits: VideoEdits
): Array<{ id: string; title: string; source_ms: number; edited_ms: number }> {
  return edits.chapters
    .map((c) => ({
      id: c.id,
      title: c.title,
      source_ms: c.at_ms,
      edited_ms: sourceToEdited(edits, c.at_ms)
    }))
    .filter(
      (c): c is { id: string; title: string; source_ms: number; edited_ms: number } =>
        c.edited_ms != null
    )
    .sort((a, b) => a.edited_ms - b.edited_ms)
}

export function showButton(count: number, canAuthor: boolean): boolean {
  return count > 0 || canAuthor
}

/** The record form's own Videos button: only for a saved record, and not when the host hides it. */
export function showFormVideosButton(itemId: string | undefined, hide: boolean): boolean {
  return !!itemId && !hide
}

/** "Showing 24 of 61", only when there is more than what is on screen. */
export function showingLabel(shown: number, total: number): string | null {
  return total > shown ? `Showing ${shown} of ${total}` : null
}

/** What an empty library says, by why it is empty. `offerRecord` is true only
 *  where recording a video is the way out. */
export function emptyCopy(f: {
  search: string
  category?: string
  status: 'published' | 'draft' | 'archived'
  canAuthor: boolean
}): { text: string; offerRecord: boolean } {
  if (f.search) return { text: 'No videos match that search.', offerRecord: false }
  if (f.category) {
    return {
      text: `No ${f.status === 'published' ? '' : `${f.status} `}videos in ${f.category}.`,
      offerRecord: false
    }
  }
  if (f.status === 'draft') {
    return {
      text: 'No drafts. A video you record stays here until you publish it.',
      offerRecord: f.canAuthor
    }
  }
  if (f.status === 'archived') return { text: 'Nothing is archived.', offerRecord: false }
  return f.canAuthor
    ? { text: 'No videos yet. Record one to show people how a screen works.', offerRecord: true }
    : { text: 'No videos yet.', offerRecord: false }
}
