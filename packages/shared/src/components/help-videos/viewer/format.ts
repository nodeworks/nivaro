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
