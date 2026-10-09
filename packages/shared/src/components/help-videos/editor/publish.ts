import type { VersionDto, VideoEdits, Visibility } from '../types'

/** Shown beside Publish, Restore and Re-record when the editor's own save fails first. */
export const UNSAVED_NOTE = "Your latest edits haven't saved yet. Try again once they save."

export function missingForPublish(v: { title: string; contexts: unknown[] }): string[] {
  const m: string[] = []
  if (!v.title.trim()) m.push('title')
  if (!v.contexts.length) m.push('where')
  return m
}

export function describeMissing(m: string[]): string {
  const parts = m.map((x) => (x === 'title' ? 'add a title' : 'choose where it shows'))
  const s = parts.join(' and ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export function renderLabel(v: VersionDto | null | undefined): {
  text: string
  tone: 'neutral' | 'busy' | 'good' | 'bad'
} {
  if (!v) return { text: 'Not published', tone: 'neutral' }
  switch (v.render_status) {
    case 'queued':
      return { text: 'Waiting to render', tone: 'busy' }
    case 'rendering':
      return { text: `Rendering ${v.render_progress ?? 0}%`, tone: 'busy' }
    case 'ready':
      return v.rendered_current
        ? { text: 'Ready', tone: 'good' }
        : { text: 'Older render — re-render to include the latest edits', tone: 'neutral' }
    case 'failed':
      return { text: `Render failed: ${v.render_error ?? 'unknown error'}`, tone: 'bad' }
    case 'unavailable':
      return { text: 'Plays with live edits (no renderer on this server)', tone: 'neutral' }
    default:
      return { text: 'Not rendered yet', tone: 'neutral' }
  }
}

/**
 * Lands the editor's pending save, then runs `action`. When the save fails the
 * action never runs: publishing, restoring or re-recording over edits that did
 * not land would drop them.
 */
export async function whenSaved<T>(
  flush: () => Promise<boolean>,
  action: () => Promise<T>
): Promise<{ ok: true; value: T } | { ok: false }> {
  if (!(await flush())) return { ok: false }
  return { ok: true, value: await action() }
}

/**
 * Roles that must watch a video they cannot see. The server only asks roles
 * that can see it, so these would never be asked. Everyone can see it unless
 * visibility is limited to roles; limited to no roles, only authors can.
 */
export function blindRequiredRoles(visibility: Visibility, required: string[]): string[] {
  if (visibility.mode !== 'roles') return []
  const seen = new Set(visibility.role_ids.map((r) => r.toUpperCase()))
  return required.filter((r) => !seen.has(r.toUpperCase()))
}

/**
 * Client mirror of the server's viewerMayPlaySource (help-video-views.ts —
 * keep the two in step): viewers can't be handed the original recording when
 * the edits hide or cut something, so they wait for the render. Blurs,
 * callouts (opaque panels), boxes (their label can cover a field), a trim or
 * a cut each mean waiting; so does an unknown length.
 */
export function viewersWaitForRender(edits: VideoEdits, sourceMs: number | null): boolean {
  const src = Math.round(Number(sourceMs))
  if (!Number.isFinite(src) || src <= 0) return true
  if (edits.blurs.length) return true
  if (edits.annotations.some((a) => a.type === 'callout' || a.type === 'box')) return true
  const segs = edits.segments
  if (!segs.length) return true
  if (segs[0].start_ms > 0 || segs[segs.length - 1].end_ms < src) return true
  for (let i = 1; i < segs.length; i++) if (segs[i].start_ms > segs[i - 1].end_ms) return true
  return false
}

/** "Supervisors", "Supervisors and Buyers", "A, B and C". */
export function joinNames(names: string[]): string {
  if (names.length < 2) return names.join('')
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}
