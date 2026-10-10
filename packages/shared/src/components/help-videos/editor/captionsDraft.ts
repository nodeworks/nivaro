import { EDIT_LIMITS, newId } from '../edits'
import type { Caption, VideoEdits } from '../types'

/**
 * Putting a generated caption set (#1520) into the draft. `replace` drops
 * every caption the video has and keeps the generated lines; `merge` keeps
 * the author's own captions and adds only the generated lines that do not
 * overlap one of them. Either way the lines get fresh ids (the pending set
 * may be used on more than one draft), are sorted and capped at the limit,
 * and nothing shorter than the minimum item length is kept.
 */
export type CaptionsUse = 'replace' | 'merge'

export function applyGeneratedCaptions(
  edits: VideoEdits,
  generated: Caption[],
  how: CaptionsUse,
  sourceMs: number
): { edits: VideoEdits; added: number; skipped: number } {
  const kept = how === 'replace' ? [] : edits.captions
  let skipped = 0
  const fresh: Caption[] = []
  for (const g of generated) {
    const start = Math.round(Math.max(0, Math.min(g.start_ms, sourceMs)))
    const end = Math.round(Math.max(0, Math.min(g.end_ms, sourceMs)))
    const text = String(g.text ?? '')
      .trim()
      .slice(0, EDIT_LIMITS.text)
    if (!text || end - start < EDIT_LIMITS.minItemMs) {
      skipped++
      continue
    }
    if (kept.some((c) => start < c.end_ms && end > c.start_ms)) {
      skipped++
      continue
    }
    fresh.push({ id: newId(), start_ms: start, end_ms: end, text })
  }
  const all = [...kept, ...fresh].sort((a, b) => a.start_ms - b.start_ms)
  const over = Math.max(0, all.length - EDIT_LIMITS.captions)
  const captions = over ? all.slice(0, EDIT_LIMITS.captions) : all
  const added = fresh.length - Math.min(fresh.length, over)
  return { edits: { ...edits, captions }, added, skipped: skipped + (fresh.length - added) }
}

/** How a running job reads in the panel. */
export function captionJobLabel(job: {
  status: 'queued' | 'running' | 'done' | 'failed'
  phase?: 'extracting' | 'transcribing' | 'grouping'
  captions?: Caption[]
  error?: string
}): string {
  if (job.status === 'queued') return 'Waiting for the server…'
  if (job.status === 'running') {
    if (job.phase === 'extracting') return 'Reading the sound…'
    if (job.phase === 'grouping') return 'Making caption lines…'
    return 'Transcribing…'
  }
  if (job.status === 'failed') return job.error || 'The captions could not be generated.'
  const n = job.captions?.length ?? 0
  return n
    ? `${n} caption line${n === 1 ? '' : 's'} ready to review`
    : 'Nothing was heard in the recording.'
}
