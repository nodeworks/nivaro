/**
 * An import run's log, read into parts a person can scan.
 *
 * The log is plain text (it also rides notifications). A finished run writes a
 * headline and one indented line per fact:
 *
 *   Lines: 3 new, 42 updated, 348 unchanged · 10.7s
 *     compared 398 file rows with live data in 0.3s
 *     no match for 31 vendor value(s) on 513 rows (the stored value is kept): A | B | C
 *     new lines: 3 written in 2.5s
 *
 * A failed run writes what stopped it, usually `<what ran> - <the reason>`.
 * Shown as-is in a monospace block it wraps mid-value and nothing lines up.
 */

export interface ImportLogFigure {
  value: string
  word: string
}

export interface ImportLogHeadlinePart {
  label: string | null
  figures: ImportLogFigure[]
  /** Set when the part is a sentence, not a list of figures. */
  text: string | null
}

export interface ImportLogLine {
  /** What the line is about, first letter capitalised. */
  label: string
  /** The sentence after the label, when it is not a list of values. */
  detail: string | null
  /** An aside the log wrote in parentheses. */
  note: string | null
  /** A `a | b | c` list, split. */
  values: string[]
  /** Values the log counted and did not list: a number, 'some' when the
   *  count was open-ended ('50+'), null when every value is listed. */
  more: number | 'some' | null
  /** A trailing duration ('3.8s'), pulled to the side. */
  time: string | null
  /** The line reports something that went wrong. */
  problem: boolean
  /** The label is a name from the database and keeps the monospace face. */
  code: boolean
}

export interface ImportLogError {
  /** What was running when it stopped — a procedure name, or the file load. */
  source: string | null
  /** The statement that failed, when the log carries one. */
  statement: string | null
  message: string
  /** `Duplicate keys: a,a,b` → the label and each value once, with its count. */
  list_label: string | null
  values: Array<{ value: string; count: number }>
  /** The list ends mid-value: the message was longer than the log keeps. */
  cut_off: boolean
}

export interface ImportLog {
  headline: ImportLogHeadlinePart[]
  /** How long the run took, when the headline says. */
  time: string | null
  lines: ImportLogLine[]
  error: ImportLogError | null
}

const DURATION = /^(?:\d+m\s)?\d[\d.,]*\s?(?:ms|s)$/
const TRAILING_TIME = /(?:^|\s)((?:\d+m\s)?\d[\d.,]*\s?(?:ms|s))$/
const NAME = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/
const FIGURE = /^(\d[\d,.]*\+?)\s+(\S.*)$/
const TRAILING_NOTE = /\s*\(([^()]{3,})\)$/

const capital = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s)

/** 2232 → 2,232. A value that already carries separators is left as written. */
function grouped(value: string): string {
  if (!/^\d{4,}$/.test(value)) return value
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/** `31 vendor value(s)` → `31 vendor values`; `1 vendor value(s)` → `1 vendor value`. */
function plurals(text: string): string {
  return text
    .replace(/\b(\d[\d,]*\+?)(\s+[^()|:]*?)\(s\)/g, (_m, n: string, words: string) =>
      n === '1' ? `${n}${words}` : `${n}${words}s`
    )
    .replace(/\(s\)/g, 's')
}

function takeNote(text: string): { rest: string; note: string | null } {
  const m = TRAILING_NOTE.exec(text)
  if (!m) return { rest: text, note: null }
  return { rest: text.slice(0, m.index).trim(), note: m[1].trim() }
}

function takeTime(text: string): { rest: string; time: string | null } {
  const m = TRAILING_TIME.exec(text)
  if (!m) return { rest: text, time: null }
  const rest = text
    .slice(0, m.index)
    .replace(/\s+in$/i, '')
    .trim()
  return { rest, time: m[1].trim() }
}

export function parseImportLogLine(raw: string): ImportLogLine | null {
  const line = plurals(raw.trim())
  if (!line) return null
  const problem = /^failed\b|\bFAILED\b|^could not\b/i.test(line) && !/\b0 failed\b/i.test(line)
  const base = {
    detail: null,
    note: null,
    values: [] as string[],
    more: null,
    time: null,
    problem,
    code: false
  }

  const cut = line.search(/:\s/)
  if (cut <= 0) {
    const noted = takeNote(line)
    const timed = takeTime(noted.rest)
    return { ...base, label: capital(timed.rest), note: noted.note, time: timed.time }
  }

  const head = takeNote(line.slice(0, cut).trim())
  const rest = line.slice(cut + 1).trim()
  const listing = /^no match\b/i.test(head.rest) || rest.includes(' | ')
  if (listing) {
    const values = rest
      .split(' | ')
      .map((v) => v.trim())
      .filter(Boolean)
    const counted = /\b(\d[\d,]*)(\+?)\s/.exec(head.rest)
    let more: ImportLogLine['more'] = null
    if (counted) {
      const n = Number(counted[1].replace(/,/g, ''))
      if (counted[2] === '+') more = 'some'
      else if (Number.isFinite(n) && n > values.length) more = n - values.length
    }
    return { ...base, label: capital(head.rest), note: head.note, values, more }
  }

  const noted = takeNote(rest)
  const timed = takeTime(noted.rest)
  const code = NAME.test(head.rest)
  return {
    ...base,
    label: code ? head.rest : capital(head.rest),
    detail: timed.rest || null,
    note: noted.note ?? head.note,
    time: timed.time,
    code
  }
}

function parseFigures(text: string): ImportLogFigure[] | null {
  const pieces = text.split(', ').map((p) => p.trim())
  const out: ImportLogFigure[] = []
  for (const p of pieces) {
    const m = FIGURE.exec(p)
    if (!m) return null
    out.push({ value: grouped(m[1]), word: m[2] })
  }
  return out.length > 0 ? out : null
}

function parseHeadline(first: string): { parts: ImportLogHeadlinePart[]; time: string | null } {
  const parts: ImportLogHeadlinePart[] = []
  let time: string | null = null
  for (const seg of first
    .split(' · ')
    .map((s) => s.trim())
    .filter(Boolean)) {
    if (DURATION.test(seg)) {
      time = seg
      continue
    }
    const cut = seg.search(/:\s/)
    const label = cut > 0 ? seg.slice(0, cut).trim() : null
    const body = cut > 0 ? seg.slice(cut + 1).trim() : seg
    const figures = parseFigures(body)
    if (figures) parts.push({ label, figures, text: null })
    else parts.push({ label: null, figures: [], text: capital(seg) })
  }
  return { parts, time }
}

export function parseImportError(text: string): ImportLogError {
  const raw = text.trim()
  let source: string | null = null
  let statement: string | null = null
  let message = raw
  const split = /^(.*?)\s-\s?([\s\S]*)$/.exec(raw)
  if (split) {
    const before = split[1].trim()
    if (NAME.test(before) || /^[a-z][a-z0-9_]*$/.test(before)) {
      source = before
      message = split[2].trim()
    } else if (/^(BULK INSERT|INSERT|EXEC|MERGE|UPDATE|DELETE|SELECT)\b/i.test(before)) {
      statement = before
      const table = /^BULK INSERT\s+(\S+)/i.exec(before)
      source = table ? table[1] : null
      message = split[2].trim()
    }
  }
  let list_label: string | null = null
  let values: ImportLogError['values'] = []
  let cut_off = false
  const list = /^([^:]{3,80}):\s*(\S[\s\S]*)$/.exec(message)
  if (list) {
    const tokens = list[2].split(',').map((t) => t.trim())
    if (tokens.length >= 2 && tokens.every((t) => /^[\w.\-/]{1,80}$/.test(t))) {
      // every value the same length and the last one shorter: the message
      // was clipped mid-value, and half a key is not a key
      const last = tokens[tokens.length - 1]
      const lengths = new Set(tokens.slice(0, -1).map((t) => t.length))
      if (tokens.length >= 3 && lengths.size === 1 && last.length < tokens[0].length) {
        tokens.pop()
        cut_off = true
      }
      const counts = new Map<string, number>()
      for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1)
      list_label = list[1].trim()
      values = [...counts].map(([value, count]) => ({ value, count }))
      message = ''
    }
  }
  return { source, statement, message, list_label, values, cut_off }
}

/**
 * @param failed  the run ended in an error — a log with no indented lines is
 *                then read as the reason it stopped
 */
export function parseImportLog(text: string | null | undefined, failed = false): ImportLog {
  const raw = String(text ?? '')
  const all = raw.split(/\r?\n/).filter((l) => l.trim())
  if (all.length === 0) return { headline: [], time: null, lines: [], error: null }
  const structured = all.slice(1).some((l) => /^\s+\S/.test(l))
  if (failed && !structured) {
    return { headline: [], time: null, lines: [], error: parseImportError(raw) }
  }
  const [first, ...rest] = all
  const { parts, time } = parseHeadline(first)
  return {
    headline: parts,
    time,
    lines: rest.map(parseImportLogLine).filter((l): l is ImportLogLine => l !== null),
    error: null
  }
}
