import { cardPhaseAt, EDIT_LIMITS, editedToSource, newId, upsertItemChecked } from '../edits'
import type { VideoEdits } from '../types'
import { typeAlongCaptionChecked } from './tools'

// Answering a question can also put the answer into the video (#1505): a
// chapter or a caption at the moment the question was asked. Questions are
// asked in EDITED time (what the viewer saw); the edits live in source time.

/** One line of a chapter title: the first line of the answer, cut to the
 *  chapter-title limit. */
export function chapterTitleFrom(answer: string): string {
  const line = answer
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean)
  return (line ?? '').slice(0, EDIT_LIMITS.chapterTitle)
}

/** The caption text: whitespace collapsed, cut to the caption limit. */
export function captionTextFrom(answer: string): string {
  return answer.replace(/\s+/g, ' ').trim().slice(0, EDIT_LIMITS.text)
}

/** A chapter at the question's moment, titled with the answer's first line.
 *  Refused with the reason when the moment is inside a cut, a chapter already
 *  starts within half a second, or the chapter limit is reached. */
export function addAnswerAsChapter(
  edits: VideoEdits,
  editedMs: number,
  answer: string
): { edits: VideoEdits; refused?: string } {
  const title = chapterTitleFrom(answer)
  if (!title) return { edits, refused: 'Write the answer first' }
  const at = sourceMomentOf(edits, editedMs)
  if (at === null) return { edits, refused: 'That moment is not in the finished video' }
  if (edits.chapters.some((c) => Math.abs(c.at_ms - at) < 500)) {
    return { edits, refused: 'A chapter already starts here' }
  }
  return upsertItemChecked(edits, 'chapters', { id: newId(), at_ms: at, title })
}

/** A caption at the question's moment that reads the answer (typed-along:
 *  it lasts as long as the text takes to read, up to the next caption). */
export function addAnswerAsCaption(
  edits: VideoEdits,
  editedMs: number,
  answer: string,
  sourceMs?: number
): { edits: VideoEdits; refused?: string } {
  const text = captionTextFrom(answer)
  if (!text) return { edits, refused: 'Write the answer first' }
  const at = sourceMomentOf(edits, editedMs)
  if (at === null) return { edits, refused: 'That moment is not in the finished video' }
  return typeAlongCaptionChecked(edits, at, text, sourceMs)
}

/** The source moment a viewer's edited moment maps to, or null when it falls
 *  on a card (the intro or outro), which has no recording under it. */
export function sourceMomentOf(edits: VideoEdits, editedMs: number): number | null {
  const ms = Math.max(0, Math.round(editedMs))
  if (cardPhaseAt(edits, ms).phase !== 'body') return null
  const last = edits.segments[edits.segments.length - 1]?.end_ms ?? 0
  // The very end of the recording has no frame of its own: step just inside.
  return Math.min(Math.round(editedToSource(edits, ms)), Math.max(0, last - 1))
}
