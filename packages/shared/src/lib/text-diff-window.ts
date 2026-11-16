/**
 * "Show the part that differs" for an old → new pair of long text values.
 *
 * A plain head cut ("first 60 characters…") makes two values read the same
 * whenever the edit is past the cut (rt2-conflict / rt4-sync 2026-11-16). This
 * trims the common prefix and suffix and keeps a little context on each side,
 * so "…for Nashville CNF, delivered Friday" → "…for Nashville CNF, delivered
 * Monday" shows the words that changed. Short values come back whole.
 */
export interface DiffWindow {
  before: string
  after: string
  /** True when either side was trimmed. */
  trimmed: boolean
}

/** Back up to the start of a word, so the context never begins mid-word. */
function wordStart(s: string, i: number): number {
  if (i <= 0) return 0
  const space = s.lastIndexOf(' ', i)
  return space > 0 && i - space <= 12 ? space + 1 : i
}

/** Run on to the end of a word, so the context never ends mid-word. */
function wordEnd(s: string, i: number): number {
  if (i >= s.length) return s.length
  const space = s.indexOf(' ', i)
  return space >= 0 && space - i <= 12 ? space : i
}

export function diffWindow(
  before: string,
  after: string,
  { max = 60, context = 20 }: { max?: number; context?: number } = {}
): DiffWindow {
  if (before.length <= max && after.length <= max) return { before, after, trimmed: false }
  let pre = 0
  const limit = Math.min(before.length, after.length)
  while (pre < limit && before[pre] === after[pre]) pre++
  let suf = 0
  while (suf < limit - pre && before[before.length - 1 - suf] === after[after.length - 1 - suf])
    suf++
  const cut = (s: string): string => {
    const startRaw = Math.max(0, pre - context)
    const endRaw = Math.min(s.length, s.length - suf + context)
    const start = wordStart(s, startRaw)
    const end = wordEnd(s, endRaw)
    // The changed middle itself may be long: keep its head and tail.
    let body = s.slice(start, end)
    const room = max + context * 2
    if (body.length > room) body = `${body.slice(0, room - 20)}…${body.slice(-19)}`
    return `${start > 0 ? '…' : ''}${body.trim()}${end < s.length ? '…' : ''}`
  }
  return { before: cut(before), after: cut(after), trimmed: true }
}
