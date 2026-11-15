/**
 * Screen-reader notices for live changes. One polite, coalesced `aria-live` region per
 * app shell (components/LiveAnnouncer.tsx); this file is the pure part.
 *
 * What it says is built from what a live event carries — the collection, how many
 * records, the NAMES of the fields that moved, never a value (the socket never carries
 * one). Rules, all of them about not being a nuisance:
 *   - never the person's own writes (the caller drops those before `note`);
 *   - never more than one announcement per `minGapMs` (5 s): changes that arrive inside the
 *     gap are folded into the one that follows it;
 *   - one sentence at most, however big the burst ("12 rows updated");
 *   - `brief` says only that something changed; `off` says nothing.
 */

export type AnnounceVerbosity = 'full' | 'brief' | 'off'

/** The least time between two announcements. */
export const ANNOUNCE_MIN_GAP_MS = 5000
/** The wait before the first sentence of a burst, so its events read as one. */
export const ANNOUNCE_SETTLE_MS = 800

/** One change worth mentioning (what the shell hands over per live event). */
export interface AnnounceNote {
  action?: string | null
  /** Record id; '*' = a bulk write that named none. */
  item?: string | number | null
  /** Number of records a bulk write touched. */
  bulk?: number
  /** Field names the write named (`$` names are surfaces, not columns). */
  fields?: readonly string[] | null
}

/** `status_code` / `statusCode` → "Status code". */
export function humanField(name: string): string {
  const spaced = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
  return spaced ? spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase() : ''
}

const ASPECT_PHRASE: Record<string, string> = {
  $state: 'Status',
  $comments: 'Comments',
  $tasks: 'Tasks',
  $addendums: 'Addendums',
  $owners: 'Owners'
}

/** A phrase for each field name; surfaces nobody reads aloud ($lock, $integrations) drop out. */
function fieldPhrases(fields: readonly string[]): string[] {
  const out: string[] = []
  for (const f of fields) {
    const p = f.startsWith('$') ? ASPECT_PHRASE[f] : humanField(f)
    if (p && !out.includes(p)) out.push(p)
  }
  return out
}

/** Whether an event is worth a sentence at all (a lock or integrations tick is not). */
export function worthAnnouncing(note: AnnounceNote): boolean {
  if (note.action === 'create' || note.action === 'delete') return true
  const f = note.fields
  if (!f || f.length === 0) return true
  return fieldPhrases(f).length > 0
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

/**
 * The sentence for a burst of notes (pure — exported for tests). Empty string = say
 * nothing. `full` names the fields when one record changed; `brief` only counts.
 */
export function composeAnnouncement(
  notes: readonly AnnounceNote[],
  verbosity: AnnounceVerbosity = 'full'
): string {
  if (verbosity === 'off') return ''
  const worth = notes.filter(worthAnnouncing)
  if (worth.length === 0) return ''
  const ids = new Set<string>()
  let bulk = 0
  const created = new Set<string>()
  const deleted = new Set<string>()
  const fields: string[] = []
  let anyUpdate = false
  let n = 0
  for (const note of worth) {
    n++
    const key = note.item == null ? `#${n}` : String(note.item)
    if (note.item === '*') bulk += Math.max(1, note.bulk ?? 1)
    else ids.add(key)
    if (note.action === 'create') created.add(key)
    else if (note.action === 'delete') deleted.add(key)
    else {
      anyUpdate = true
      for (const p of fieldPhrases(note.fields ?? [])) if (!fields.includes(p)) fields.push(p)
    }
  }
  const rows = ids.size + bulk
  if (verbosity === 'brief') return rows <= 1 ? 'Updated' : `${rows} rows updated`
  const parts: string[] = []
  if (rows === 1 && created.size === 0 && deleted.size === 0) {
    // One record changed: say what, by field name, when there are few.
    if (fields.length > 0 && fields.length <= 2) return `${fields.join(' and ')} changed`
    if (fields.length > 2) return `${fields.length} fields changed`
    return 'Record updated'
  }
  const updated = rows - created.size - deleted.size
  if (created.size > 0) parts.push(plural(created.size, 'row added', 'rows added'))
  if (deleted.size > 0) parts.push(plural(deleted.size, 'row removed', 'rows removed'))
  if (anyUpdate && updated > 0) parts.push(plural(updated, 'row updated', 'rows updated'))
  if (parts.length === 0) parts.push(plural(rows, 'row updated', 'rows updated'))
  const sentence = parts.join(', ')
  return sentence.charAt(0).toUpperCase() + sentence.slice(1)
}

export interface Announcer {
  /** Hand over one change. */
  note(note: AnnounceNote): void
  /** Change how much is said (applies to what is waiting too). */
  setVerbosity(v: AnnounceVerbosity): void
  /** Drop what is waiting and stop the timer. */
  dispose(): void
}

export interface AnnouncerOptions {
  say: (message: string) => void
  verbosity?: AnnounceVerbosity
  minGapMs?: number
  /** How long the first note waits for others of the same burst. */
  settleMs?: number
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

/**
 * The coalescing part: notes collect and go out as ONE announcement after a short settle,
 * and never sooner than `minGapMs` after the previous one. Nothing is said for an empty sentence.
 */
export function createAnnouncer(opts: AnnouncerOptions): Announcer {
  const gap = opts.minGapMs ?? ANNOUNCE_MIN_GAP_MS
  const settle = opts.settleMs ?? ANNOUNCE_SETTLE_MS
  const now = opts.now ?? (() => Date.now())
  const setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
  const clearTimer = opts.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>))
  let verbosity: AnnounceVerbosity = opts.verbosity ?? 'full'
  let pending: AnnounceNote[] = []
  let timer: unknown = null
  let lastAt = Number.NEGATIVE_INFINITY

  const flush = () => {
    timer = null
    const batch = pending
    pending = []
    const text = composeAnnouncement(batch, verbosity)
    if (!text) return
    lastAt = now()
    opts.say(text)
  }

  return {
    note(n) {
      if (verbosity === 'off' || !worthAnnouncing(n)) return
      pending.push(n)
      if (timer) return
      // A short settle first, so the events of one burst land in one sentence.
      timer = setTimer(flush, Math.max(settle, lastAt + gap - now()))
    },
    setVerbosity(v) {
      verbosity = v
      if (v === 'off') {
        pending = []
        if (timer) {
          clearTimer(timer)
          timer = null
        }
      }
    },
    dispose() {
      pending = []
      if (timer) clearTimer(timer)
      timer = null
    }
  }
}
