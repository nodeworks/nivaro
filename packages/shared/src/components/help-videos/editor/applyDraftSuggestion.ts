import { upsertItemChecked } from '../edits'
import type { DraftSuggestion, HelpVideoContext, VideoEdits } from '../types'
import { addCollection, toggleStep } from './contexts'

/**
 * Applying one accepted suggestion of the AI first draft (#1487). Chapters
 * and callouts become a change to the edits (they ride the normal autosave);
 * a title or description is a PATCH of the video; a context is the video's
 * context list with one more entry (PUT /contexts). Nothing here calls the
 * server: the component does, with what this answers.
 */
export type DraftApply =
  | { how: 'edits'; edits: VideoEdits; refused?: undefined }
  | { how: 'refused'; refused: string }
  | { how: 'details'; patch: { title?: string; description?: string } }
  | { how: 'contexts'; contexts: HelpVideoContext[] }

/** Two chapters this close together are one chapter (as ChaptersPanel). */
const SAME_PLACE_MS = 500

export function applyDraftSuggestion(
  s: DraftSuggestion,
  edits: VideoEdits,
  contexts: HelpVideoContext[]
): DraftApply {
  switch (s.kind) {
    case 'chapter': {
      if (edits.chapters.some((c) => Math.abs(c.at_ms - s.chapter.at_ms) < SAME_PLACE_MS))
        return { how: 'refused', refused: 'A chapter already starts here' }
      const r = upsertItemChecked(edits, 'chapters', s.chapter)
      return r.refused ? { how: 'refused', refused: r.refused } : { how: 'edits', edits: r.edits }
    }
    case 'callout': {
      const r = upsertItemChecked(edits, 'annotations', s.annotation)
      return r.refused ? { how: 'refused', refused: r.refused } : { how: 'edits', edits: r.edits }
    }
    case 'title':
      return { how: 'details', patch: { title: s.text } }
    case 'description':
      return { how: 'details', patch: { description: s.text } }
    case 'context':
      return { how: 'contexts', contexts: withContext(contexts, s.context) }
  }
}

/** The context list with one more entry: a page once, a collection (every
 *  step) once, a step added to its collection's chosen steps. */
export function withContext(contexts: HelpVideoContext[], c: HelpVideoContext): HelpVideoContext[] {
  if (c.kind === 'page') {
    return contexts.some((x) => x.kind === 'page' && x.key === c.key)
      ? contexts
      : [...contexts, { kind: 'page', key: c.key, state_key: null }]
  }
  const listed = addCollection(contexts, c.key)
  if (!c.state_key) return listed
  const chosen = listed.some(
    (x) => x.kind === 'collection' && x.key === c.key && x.state_key === c.state_key
  )
  return chosen ? listed : toggleStep(listed, c.key, c.state_key)
}

/** A suggestion already in place reads as done: the author sees only what
 *  is still open. */
export function isSuggestionApplied(
  s: DraftSuggestion,
  edits: VideoEdits,
  video: { title: string; description: string | null; contexts: HelpVideoContext[] }
): boolean {
  switch (s.kind) {
    case 'chapter':
      return edits.chapters.some((c) => Math.abs(c.at_ms - s.chapter.at_ms) < SAME_PLACE_MS)
    case 'callout':
      // The same id, or a callout already sitting on that click (a second
      // draft names the same clicks with fresh ids).
      return edits.annotations.some(
        (a) =>
          a.id === s.annotation.id ||
          (a.type === 'callout' && Math.abs(a.start_ms - s.annotation.start_ms) < SAME_PLACE_MS)
      )
    case 'title':
      return video.title.trim() === s.text
    case 'description':
      return (video.description ?? '').trim() === s.text
    case 'context':
      return video.contexts.some(
        (x) =>
          x.kind === s.context.kind &&
          x.key === s.context.key &&
          (x.state_key ?? null) === (s.context.state_key ?? null)
      )
  }
}

const clock = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** What the row says: the kind, then the content. */
export function describeSuggestion(s: DraftSuggestion): {
  kind: string
  text: string
  at?: number
} {
  switch (s.kind) {
    case 'chapter':
      return { kind: 'Chapter', text: s.chapter.title, at: s.chapter.at_ms }
    case 'callout':
      return {
        kind: 'Callout',
        text: s.annotation.text,
        at: s.annotation.start_ms
      }
    case 'title':
      return { kind: 'Title', text: s.text }
    case 'description':
      return { kind: 'Description', text: s.text }
    case 'context':
      return { kind: s.context.kind === 'page' ? 'Page' : 'Shows on', text: s.label }
  }
}

export { clock as suggestionClock }
