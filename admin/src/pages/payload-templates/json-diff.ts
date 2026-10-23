// ─── Pure diff helpers for payload bodies (JsonDiff.tsx renders them) ───────
// Bodies are compared as pretty-printed text, line by line, and — when both
// sides are JSON objects/arrays — as a short list of changed paths. Key order
// is kept on purpose: partners can read it, and Convert checks it too.

export type DiffLine = { kind: 'same' | 'add' | 'del'; text: string }

/** A run of the unified view: changed lines, or unchanged lines folded away. */
export type DiffSegment = { kind: 'lines'; lines: DiffLine[] } | { kind: 'fold'; lines: DiffLine[] }

export type PathChange = {
  path: string
  kind: 'added' | 'removed' | 'changed'
  before?: unknown
  after?: unknown
}

/** Most LCS cells the middle of a diff may need (about 16 MB of Uint32). */
const MAX_CELLS = 4_000_000

/** Text for a body: Liquid / plain strings as they are, everything else pretty JSON. */
export function prettyBody(body: unknown): string {
  if (typeof body === 'string') return body
  if (body === undefined) return ''
  try {
    return JSON.stringify(body, null, 2) ?? 'null'
  } catch {
    return String(body)
  }
}

/**
 * Line diff of two texts. The common head and tail are matched first, so a
 * small edit in a long body stays cheap; null when the changed middle is too
 * large to compare here.
 */
export function diffLines(a: string, b: string): DiffLine[] | null {
  const x = a === '' ? [] : a.split('\n')
  const y = b === '' ? [] : b.split('\n')
  let head = 0
  while (head < x.length && head < y.length && x[head] === y[head]) head++
  let tail = 0
  while (
    tail < x.length - head &&
    tail < y.length - head &&
    x[x.length - 1 - tail] === y[y.length - 1 - tail]
  )
    tail++
  const xm = x.slice(head, x.length - tail)
  const ym = y.slice(head, y.length - tail)
  const n = xm.length
  const m = ym.length
  if ((n + 1) * (m + 1) > MAX_CELLS) return null

  const out: DiffLine[] = x.slice(0, head).map((text) => ({ kind: 'same', text }))
  const w = m + 1
  const t = new Uint32Array((n + 1) * w)
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      t[i * w + j] =
        xm[i] === ym[j]
          ? t[(i + 1) * w + j + 1] + 1
          : Math.max(t[(i + 1) * w + j], t[i * w + j + 1])
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (xm[i] === ym[j]) {
      out.push({ kind: 'same', text: xm[i] })
      i++
      j++
    } else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) out.push({ kind: 'del', text: xm[i++] })
    else out.push({ kind: 'add', text: ym[j++] })
  }
  while (i < n) out.push({ kind: 'del', text: xm[i++] })
  while (j < m) out.push({ kind: 'add', text: ym[j++] })
  for (const text of x.slice(x.length - tail)) out.push({ kind: 'same', text })
  return out
}

export function countChanges(lines: DiffLine[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const l of lines) {
    if (l.kind === 'add') added++
    else if (l.kind === 'del') removed++
  }
  return { added, removed }
}

/**
 * Unified view: changed lines with `context` unchanged lines around them;
 * longer unchanged runs fold (the view lets the reader open a fold).
 */
export function segmentDiff(lines: DiffLine[], context = 3): DiffSegment[] {
  const keep = new Array<boolean>(lines.length).fill(false)
  lines.forEach((l, i) => {
    if (l.kind === 'same') return
    for (let k = Math.max(0, i - context); k <= Math.min(lines.length - 1, i + context); k++)
      keep[k] = true
  })
  const out: DiffSegment[] = []
  let i = 0
  while (i < lines.length) {
    const shown = keep[i]
    let j = i
    while (j < lines.length && keep[j] === shown) j++
    const run = lines.slice(i, j)
    // Folding one or two lines saves nothing; show them.
    if (!shown && run.length > 2) out.push({ kind: 'fold', lines: run })
    else {
      const last = out[out.length - 1]
      if (last?.kind === 'lines') last.lines.push(...run)
      else out.push({ kind: 'lines', lines: run })
    }
    i = j
  }
  return out
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

const SAFE_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/

function join(base: string, key: string | number): string {
  if (typeof key === 'number') return `${base}[${key}]`
  if (SAFE_KEY.test(key)) return base ? `${base}.${key}` : key
  return `${base}[${JSON.stringify(key)}]`
}

/**
 * The paths that differ between two JSON values, in document order, capped
 * at `limit` (the total is returned too). A container that changes type is
 * one change; arrays compare by position.
 */
export function pathChanges(
  before: unknown,
  after: unknown,
  limit = 50
): { changes: PathChange[]; total: number } {
  const changes: PathChange[] = []
  let total = 0
  const push = (c: PathChange) => {
    total++
    if (changes.length < limit) changes.push(c)
  }
  const walk = (a: unknown, b: unknown, path: string) => {
    if (isObj(a) && isObj(b)) {
      // Own keys only (a payload key may be named "toString").
      const inA = new Set(Object.keys(a))
      const inB = new Set(Object.keys(b))
      for (const k of inA) {
        if (!inB.has(k)) push({ path: join(path, k), kind: 'removed', before: a[k] })
        else walk(a[k], b[k], join(path, k))
      }
      for (const k of inB)
        if (!inA.has(k)) push({ path: join(path, k), kind: 'added', after: b[k] })
      return
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      const n = Math.max(a.length, b.length)
      for (let i = 0; i < n; i++) {
        if (i >= b.length) push({ path: join(path, i), kind: 'removed', before: a[i] })
        else if (i >= a.length) push({ path: join(path, i), kind: 'added', after: b[i] })
        else walk(a[i], b[i], join(path, i))
      }
      return
    }
    if (JSON.stringify(a) !== JSON.stringify(b))
      push({ path: path || '(whole body)', kind: 'changed', before: a, after: b })
  }
  walk(before, after, '')
  return { changes, total }
}

/** One row of the change list: identical changes across list items fold into one. */
export type GroupedChange = PathChange & {
  /** How many paths this row stands for (1 = a plain change). */
  count: number
  /** Every path it stands for (tooltip). */
  paths: string[]
  /** The key that changed, for a folded row ("taskNumber"). */
  leaf: string
}

/**
 * Fold changes that differ only by list position and carry the same values —
 * `orderDetails[0].taskNumber`, `[1]`, `[2]` all '1000' → '1100' become one row,
 * "taskNumber on 3 lines". Document order is kept (a group sits where it starts).
 */
export function groupPathChanges(changes: PathChange[]): GroupedChange[] {
  const out: GroupedChange[] = []
  const at = new Map<string, GroupedChange>()
  for (const c of changes) {
    const shape = c.path.replace(/\[\d+\]/g, '[]')
    const sig = `${c.kind}\u0001${shape}\u0001${JSON.stringify(c.before)}\u0001${JSON.stringify(c.after)}`
    const hit = shape !== c.path ? at.get(sig) : undefined
    if (hit) {
      hit.count++
      hit.paths.push(c.path)
      continue
    }
    const leaf =
      c.path
        .split('.')
        .pop()
        ?.replace(/\[\d+\]$/, '') ?? c.path
    const row: GroupedChange = { ...c, count: 1, paths: [c.path], leaf }
    out.push(row)
    if (shape !== c.path) at.set(sig, row)
  }
  return out
}

/** A short one-line rendering of a JSON value for change lists. */
export function shortValue(v: unknown, max = 60): string {
  if (v === undefined) return '—'
  const s = typeof v === 'string' ? JSON.stringify(v) : (JSON.stringify(v) ?? String(v))
  return s.length > max ? `${s.slice(0, max - 1)}…` : s
}

/**
 * Where JSON text first stops being valid JSON (an offset), or null when it
 * parses. A small strict scanner: engines no longer put the position in every
 * JSON.parse message.
 */
export function jsonErrorOffset(text: string): number | null {
  let i = 0
  const ws = () => {
    while (i < text.length && ' \t\n\r'.includes(text[i])) i++
  }
  const fail = (): never => {
    throw i
  }
  const lit = (word: string) => {
    if (text.startsWith(word, i)) i += word.length
    else fail()
  }
  const str = () => {
    i++ // opening quote
    while (i < text.length) {
      const c = text[i]
      if (c === '"') {
        i++
        return
      }
      if (c === '\\') {
        const n = text[i + 1]
        if (n === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) {
            i += 1
            fail()
          }
          i += 6
        } else if (n !== undefined && '"\\/bfnrt'.includes(n)) i += 2
        else {
          i += 1
          fail()
        }
      } else if (c < ' ') fail()
      else i++
    }
    fail()
  }
  const num = () => {
    const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i))
    if (!m) fail()
    else i += m[0].length
  }
  const value = (): void => {
    ws()
    const c = text[i]
    if (c === '{') {
      i++
      ws()
      if (text[i] === '}') {
        i++
        return
      }
      for (;;) {
        ws()
        if (text[i] !== '"') fail()
        str()
        ws()
        if (text[i] !== ':') fail()
        i++
        value()
        ws()
        if (text[i] === ',') {
          i++
          continue
        }
        if (text[i] === '}') {
          i++
          return
        }
        fail()
      }
    }
    if (c === '[') {
      i++
      ws()
      if (text[i] === ']') {
        i++
        return
      }
      for (;;) {
        value()
        ws()
        if (text[i] === ',') {
          i++
          continue
        }
        if (text[i] === ']') {
          i++
          return
        }
        fail()
      }
    }
    if (c === '"') str()
    else if (c === 't') lit('true')
    else if (c === 'f') lit('false')
    else if (c === 'n') lit('null')
    else if (c === '-' || (c >= '0' && c <= '9')) num()
    else fail()
  }
  try {
    value()
    ws()
    return i < text.length ? i : null
  } catch (at) {
    return typeof at === 'number' ? at : 0
  }
}

/** "Line 3, column 5" (1-based) for an offset into a text. */
export function lineColumn(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, Math.min(offset, text.length)).split('\n')
  return { line: before.length, column: before[before.length - 1].length + 1 }
}

/** Where a JSON.parse error sits: the scanner's offset, else the engine's own message. */
export function jsonErrorAt(text: string, err: unknown): { line: number; column: number } | null {
  const at = jsonErrorOffset(text)
  if (at != null) return lineColumn(text, at)
  const msg = err instanceof Error ? err.message : String(err)
  const lc = /line (\d+) column (\d+)/i.exec(msg)
  if (lc) return { line: Number(lc[1]), column: Number(lc[2]) }
  const pos = /position (\d+)/i.exec(msg)
  return pos ? lineColumn(text, Number(pos[1])) : null
}
