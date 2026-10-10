// Typing and idle stretches on the recorded tab (#1518).
//
// The recorder notes WHEN the author typed in a text field and when they
// touched nothing at all, so the editor can offer to speed typing up (4×) and
// cut idle stretches out. Never what was typed, which key, or where: only that
// typing happened. Keys pressed inside `.nvr-no-record` (the session-replay
// mask), the recorder's own bar or the walk overlay are not typing; they still
// count as input (so the stretch is not idle). The server re-checks the spans
// (api/src/services/help-video-walk.ts normalizeActivity — keep the limits in
// step).

import type { ActivitySpan } from '../types'

export type { ActivitySpan }

/** No pointer, wheel or key input for this long is an idle stretch. */
export const IDLE_MIN_MS = 3000
/** Keystrokes closer together than this are one typing stretch. */
export const TYPING_GAP_MS = 1500
/** A typing stretch ends a little after its last key (the field updates). */
export const TYPING_TAIL_MS = 400
/** Shorter typing (a key or two) is not worth a suggestion. */
export const TYPING_MIN_MS = 1000
/** Spans kept per recording (the earliest win). */
export const MAX_SPANS = 1000

const MASKED = '.nvr-no-record, [data-nvr-no-record], [data-hv-recorder-bar], [data-hv-walk]'
const TEXT_TYPES = new Set(['', 'text', 'search', 'email', 'url', 'tel', 'password', 'number'])

/** The event happened inside a masked area (.nvr-no-record, the recorder's
 *  own bar, the walk overlay): nothing about it is kept beyond the moment. */
export function isMaskedTarget(target: EventTarget | null): boolean {
  const el = target as Element | null
  return !!el && typeof el.closest === 'function' && !!el.closest(MASKED)
}

/** The key went to a text field the tutorial is about (not a masked one). */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as (Element & { isContentEditable?: boolean }) | null
  if (!el || typeof el.closest !== 'function') return false
  if (isMaskedTarget(el)) return false
  const tag = el.tagName
  if (tag === 'TEXTAREA') return true
  if (tag === 'INPUT') return TEXT_TYPES.has(((el as HTMLInputElement).type ?? '').toLowerCase())
  return el.isContentEditable === true
}

/**
 * Turns input moments (recording time, pauses excluded) into spans. `input`
 * for any pointer, wheel or key event; `key(at, true)` for a key typed into a
 * text field. `spans(endMs)` closes what is still open without changing the
 * tracker, so it can be read more than once.
 */
export function createActivityTracker() {
  const done: ActivitySpan[] = []
  let lastInput = 0
  let typingStart: number | null = null
  let lastKey = 0

  const push = (s: ActivitySpan) => {
    if (done.length < MAX_SPANS) done.push(s)
  }
  const typingSpan = (start: number, last: number): ActivitySpan | null =>
    last + TYPING_TAIL_MS - start >= TYPING_MIN_MS
      ? { kind: 'typing', start_ms: start, end_ms: last + TYPING_TAIL_MS }
      : null
  const closeTyping = () => {
    if (typingStart == null) return
    const s = typingSpan(typingStart, lastKey)
    if (s) push(s)
    typingStart = null
  }

  function input(at: number) {
    if (at - lastInput >= IDLE_MIN_MS) push({ kind: 'idle', start_ms: lastInput, end_ms: at })
    if (at > lastInput) lastInput = at
    if (typingStart != null && at - lastKey > TYPING_GAP_MS) closeTyping()
  }

  function key(at: number, typing: boolean) {
    // An open typing stretch ends on a long gap (input() closes it) or on a
    // key that is not typing.
    if (!typing) closeTyping()
    input(at)
    if (!typing) return
    if (typingStart == null) typingStart = at
    lastKey = at
  }

  function spans(endMs: number): ActivitySpan[] {
    const out = [...done]
    if (typingStart != null) {
      const s = typingSpan(typingStart, lastKey)
      if (s) out.push({ ...s, end_ms: Math.min(s.end_ms, Math.max(endMs, lastKey)) })
    }
    if (endMs - lastInput >= IDLE_MIN_MS)
      out.push({ kind: 'idle', start_ms: lastInput, end_ms: endMs })
    return out.slice(0, MAX_SPANS).sort((a, b) => a.start_ms - b.start_ms)
  }

  return { input, key, spans }
}
