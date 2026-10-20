// api/src/services/sql-checks/propose.ts
/**
 * Proposed fixes for SQL checks findings (#2563) — pure: definition text in, new text + diff out.
 * Only two mechanical classes are rewritten; everything else stays a manual fix:
 *
 *  - `tran-without-xact-abort` (procedures): `SET XACT_ABORT ON;` becomes the first statement of
 *    the body — after `AS` / `AS BEGIN`, after a leading `SET NOCOUNT ON`.
 *  - `merge-null-key`: the MERGE's ON clause, when it is a plain AND of `a.col = b.col` pairs,
 *    gets each pair on a nullable target column made NULL-safe:
 *    `(s.k = t.k OR (s.k IS NULL AND t.k IS NULL))`.
 *
 * Every offset comes from the masked text (tokenizer.ts), so an edit never lands inside a comment
 * or a string literal; the new text is the old one with those spans spliced, nothing else moved.
 */
import { parseMerges } from './checkers.js'
import { depthMap, lineAt, maskSql, normaliseSql, splitName } from './tokenizer.js'

export type FixClass = 'xact-abort' | 'merge-null-safe'
export const FIXABLE_CHECKS = ['tran-without-xact-abort', 'merge-null-key'] as const

export interface Edit {
  /** Offset in the original text. */
  at: number
  /** Characters removed at `at`. */
  remove: number
  insert: string
}

export interface ProposalResult {
  proposable: boolean
  class: FixClass | null
  /** Why no fix can be proposed (proposable = false). */
  manual_reason?: string
  risky: boolean
  reasons: string[]
  /** Worth knowing but not a reason to stop (no extra confirmation). */
  notes: string[]
  edits: Edit[]
  newDefinition: string | null
}

export interface FindingForFix {
  check_key: string
  object_type: string
  line: number | null
  detail: Record<string, unknown> | null
}

const IDENT = String.raw`(?:\[(?:[^\]]|\]\])+\]|[A-Za-z_@#$][\w@#$]*)`
const REF = String.raw`${IDENT}\s*\.\s*${IDENT}`

const manual = (reason: string): ProposalResult => ({
  proposable: false,
  class: null,
  manual_reason: reason,
  risky: false,
  reasons: [],
  notes: [],
  edits: [],
  newDefinition: null
})

/** Apply non-overlapping edits (any order) to `sql`. */
export function applyEdits(sql: string, edits: Edit[]): string {
  let out = sql
  for (const e of [...edits].sort((a, b) => b.at - a.at))
    out = out.slice(0, e.at) + e.insert + out.slice(e.at + e.remove)
  return out
}

// ─── SET XACT_ABORT ON ──────────────────────────────────────────────────────

/** Leading whitespace of the line holding `offset`. */
function indentAt(sql: string, offset: number): string {
  const lineStart = sql.lastIndexOf('\n', offset - 1) + 1
  const m = /^[ \t]*/.exec(sql.slice(lineStart))
  return m ? m[0] : ''
}

/** Offset of the next non-whitespace character of the masked text from `pos`. */
function nextCode(masked: string, pos: number): number {
  while (pos < masked.length && /\s/.test(masked[pos])) pos++
  return pos
}

/**
 * Where the procedure body starts: just past the `AS` that ends the header (parameters and WITH
 * options; `EXECUTE AS …` is an option, not the body). -1 when it isn't a procedure header.
 */
export function procBodyStart(masked: string): number {
  const head = new RegExp(
    String.raw`\b(?:CREATE|ALTER)\s+(?:OR\s+ALTER\s+)?PROC(?:EDURE)?\s+(${IDENT}(?:\s*\.\s*${IDENT})?)`,
    'i'
  ).exec(masked)
  if (!head) return -1
  const depth = depthMap(masked)
  const re = /\bAS\b/gi
  re.lastIndex = head.index + head[0].length
  for (let m = re.exec(masked); m; m = re.exec(masked)) {
    if (depth[m.index] !== 0) continue
    if (/[@#$\w.]/.test(masked[m.index - 1] ?? '')) continue // a name such as @as
    const before = masked.slice(Math.max(0, m.index - 20), m.index)
    if (/\bEXEC(?:UTE)?\s*$/i.test(before)) continue // WITH EXECUTE AS OWNER
    return m.index + m[0].length
  }
  return -1
}

const HEAD_RE = new RegExp(
  String.raw`\b(?:CREATE|ALTER)\s+(?:OR\s+ALTER\s+)?PROC(?:EDURE)?\s+(${IDENT}(?:\s*\.\s*${IDENT})?)`,
  'i'
)

/** The name a procedure's CREATE / ALTER header carries (offsets in the original text), or null. */
export function procHeaderName(
  sql: string
): { schema: string | null; name: string; start: number; end: number } | null {
  const masked = maskSql(sql)
  const m = HEAD_RE.exec(masked)
  if (!m) return null
  const start = m.index + m[0].length - m[1].length
  const end = m.index + m[0].length
  const { schema, name } = splitName(sql.slice(start, end))
  return { schema, name, start, end }
}

const bracket = (s: string) => `[${s.replace(/]/g, ']]')}]`

/**
 * The definition with its header naming exactly `[schema].[name]`. A procedure renamed with
 * sp_rename keeps its old name in sys.sql_modules, and a header without a schema lands in the
 * login's default schema: deploying either text as written could create or replace ANOTHER
 * object. Null when there is no procedure header to rewrite.
 */
export function withExplicitName(sql: string, schema: string | null, name: string): string | null {
  const h = procHeaderName(sql)
  if (!h) return null
  return `${sql.slice(0, h.start)}${bracket(schema ?? 'dbo')}.${bracket(name)}${sql.slice(h.end)}`
}

/**
 * What changes when XACT_ABORT ON is added to a body that handles its own errors: every error
 * then dooms the transaction (error 3930 on the next write or COMMIT), so a CATCH that commits, or
 * code that reads XACT_STATE() / @@ERROR to carry on, behaves differently.
 */
export function xactAbortRisks(masked: string): string[] {
  const reasons: string[] = []
  for (const m of masked.matchAll(/\bBEGIN\s+CATCH\b([\s\S]*?)\bEND\s+CATCH\b/gi)) {
    if (/\bCOMMIT\b/i.test(m[1])) {
      reasons.push(
        'A CATCH block commits. With XACT_ABORT ON the transaction is already doomed there, so that COMMIT fails (error 3930) instead of keeping the work done so far.'
      )
      break
    }
  }
  if (/\bXACT_STATE\s*\(\s*\)/i.test(masked))
    reasons.push(
      'The procedure checks XACT_STATE(). With XACT_ABORT ON an error leaves it at -1 (doomed) rather than 1, so a branch that carries on when it is 1 no longer runs.'
    )
  if (/@@ERROR\b/i.test(masked))
    reasons.push(
      'The procedure reads @@ERROR to carry on after a failed statement. With XACT_ABORT ON the first error ends the batch and rolls back, so that recovery code never runs.'
    )
  return reasons
}

export function proposeXactAbort(sql: string): ProposalResult {
  const masked = maskSql(sql)
  if (/\bSET\s+XACT_ABORT\s+ON\b/i.test(masked))
    return manual('The procedure already sets XACT_ABORT ON.')
  let at = procBodyStart(masked)
  if (at < 0) return manual('Only procedures can be fixed this way; this is not one.')
  let pos = nextCode(masked, at)
  // AS BEGIN … END wraps the body; BEGIN TRAN / TRY / DISTRIBUTED start a statement instead
  const begin = /^BEGIN\b(?!\s+(?:TRAN|TRANSACTION|TRY|DISTRIBUTED)\b)/i.exec(masked.slice(pos))
  if (begin) {
    at = pos + begin[0].length
    pos = nextCode(masked, at)
  }
  const nocount = /^SET\s+NOCOUNT\s+ON\b\s*;?/i.exec(masked.slice(pos))
  let insertAt = at
  let indent: string
  if (nocount) {
    insertAt = pos + nocount[0].replace(/\s+$/, '').length
    indent = indentAt(sql, pos)
  } else {
    // the first statement's own indentation, or four spaces when it sits on the AS line
    const sameLine = !sql.slice(at, pos).includes('\n')
    indent = sameLine || pos >= sql.length ? `${indentAt(sql, at)}    ` : indentAt(sql, pos)
  }
  const edit: Edit = { at: insertAt, remove: 0, insert: `\n${indent}SET XACT_ABORT ON;` }
  const reasons = xactAbortRisks(masked)
  return {
    proposable: true,
    class: 'xact-abort',
    risky: reasons.length > 0,
    reasons,
    notes: [],
    edits: [edit],
    newDefinition: applyEdits(sql, [edit])
  }
}

// ─── NULL-safe MERGE ON ─────────────────────────────────────────────────────

/** Top-level conjuncts of a masked ON clause (offsets relative to it), or null on a top-level OR. */
export function splitConjuncts(onMasked: string): Array<{ start: number; end: number }> | null {
  const out: Array<{ start: number; end: number }> = []
  let depth = 0
  let from = 0
  const re = /\(|\)|\bAND\b|\bOR\b/gi
  for (let m = re.exec(onMasked); m; m = re.exec(onMasked)) {
    const t = m[0].toUpperCase()
    if (t === '(') depth++
    else if (t === ')') depth--
    else if (depth === 0 && t === 'OR') return null
    else if (depth === 0 && t === 'AND') {
      out.push({ start: from, end: m.index })
      from = m.index + m[0].length
    }
  }
  out.push({ start: from, end: onMasked.length })
  return out
}

/** `alias.column` → lower-cased parts, unbracketed. */
function refParts(ref: string): { alias: string; column: string } {
  const [alias, column] = ref.split('.').map((p) => splitName(p.trim()).name.toLowerCase())
  return { alias, column }
}

export function proposeMergeNullSafe(sql: string, finding: FindingForFix): ProposalResult {
  const d = (finding.detail ?? {}) as {
    target_table?: string
    nullable_columns?: string[]
    extra_rows?: number
    table_rows?: number | null
  }
  const nullable = new Set((d.nullable_columns ?? []).map((c) => c.toLowerCase()))
  if (!d.target_table || !nullable.size)
    return manual('The finding does not say which key columns are nullable.')
  const masked = maskSql(sql)
  const merges = parseMerges(masked, depthMap(masked)).filter(
    (m) => m.target.name.toLowerCase() === String(d.target_table).toLowerCase()
  )
  const merge =
    (finding.line != null ? merges.find((m) => lineAt(sql, m.start) === finding.line) : null) ??
    (merges.length === 1 ? merges[0] : null)
  if (!merge) return manual('The MERGE this finding points at could not be found again.')
  const target = merge.targetAlias.toLowerCase()
  const onMasked = masked.slice(merge.onStart, merge.onEnd)
  const parts = splitConjuncts(onMasked)
  if (!parts) return manual('The ON clause uses OR, so it needs a person to rewrite it.')
  const pairRe = new RegExp(
    String.raw`^(\s*)(?:\(\s*)?(${REF})\s*=\s*(${REF})(?:\s*\))?(\s*)$`,
    'i'
  )
  const edits: Edit[] = []
  const fixed: string[] = []
  for (const p of parts) {
    const text = onMasked.slice(p.start, p.end)
    const m = pairRe.exec(text)
    if (!m)
      return manual(
        'The ON clause is more than column-to-column equalities (functions, literals or ranges), so it needs a person to rewrite it.'
      )
    const a = refParts(m[2])
    const b = refParts(m[3])
    const tgt = a.alias === target ? a : b.alias === target ? b : null
    const other = tgt === a ? b : a
    if (!tgt || other.alias === target)
      return manual('Each ON comparison must pair a target column with a source column.')
    if (!nullable.has(tgt.column)) continue
    // wrap the pair as written (comments inside it stay): ( <pair> OR (l IS NULL AND r IS NULL))
    const base = merge.onStart + p.start
    const spanStart = base + m[1].length
    const spanEnd = merge.onStart + p.end - m[4].length
    const leftAt = text.indexOf(m[2])
    const left = sql.slice(base + leftAt, base + leftAt + m[2].length)
    const rightAt = text.indexOf(m[3], leftAt + m[2].length)
    const right = sql.slice(base + rightAt, base + rightAt + m[3].length)
    edits.push({ at: spanStart, remove: 0, insert: '(' })
    edits.push({
      at: spanEnd,
      remove: 0,
      insert: ` OR (${left} IS NULL AND ${right} IS NULL))`
    })
    fixed.push(tgt.column)
  }
  if (!edits.length) return manual('No nullable key column is compared with a plain equality.')
  const rows = typeof d.table_rows === 'number' ? d.table_rows : null
  const notes = [
    `The OR form can stop SQL Server from seeking an index on ${fixed.join(', ')} and make it scan ${rows != null ? `the ${rows.toLocaleString('en-US')}-row` : 'the'} target instead; on a large table, watch this import's run time after the change.`
  ]
  return {
    proposable: true,
    class: 'merge-null-safe',
    risky: false,
    reasons: [],
    notes,
    edits,
    newDefinition: applyEdits(sql, edits)
  }
}

/**
 * The risk of a NULL-safe ON: rows that never matched start matching. When copies already sit in
 * NULL-key groups, one source row now matches all of them; when the source can repeat a key, SQL
 * Server stops the whole MERGE ("attempted to UPDATE or DELETE the same row more than once").
 */
export function mergeRisks(
  finding: FindingForFix,
  sourceDupes: boolean
): { risky: boolean; reasons: string[] } {
  const extra = Number((finding.detail as { extra_rows?: number } | null)?.extra_rows ?? 0)
  const reasons: string[] = []
  if (extra > 0)
    reasons.push(
      `${extra.toLocaleString('en-US')} ${extra === 1 ? 'row already repeats' : 'rows already repeat'} a key with an empty value. After this change one incoming row matches all of those copies and updates each of them; remove the copies first (keep the newest per key).`
    )
  if (sourceDupes)
    reasons.push(
      'The source of this MERGE may repeat a key. Once empty keys match, two source rows for the same key make SQL Server stop the whole MERGE ("attempted to UPDATE or DELETE the same row more than once"). Take one row per key in the source first, for example ROW_NUMBER() OVER (PARTITION BY <key> ORDER BY <latest first>) = 1.'
    )
  return { risky: reasons.length > 0, reasons }
}

/** The proposal for one finding over the current definition (pure). */
export function proposeFix(
  sql: string,
  finding: FindingForFix,
  opts: { sourceDupes?: boolean } = {}
): ProposalResult {
  const type = finding.object_type
  if (type !== 'procedure' && type !== 'import_definition')
    return manual('Only procedures (and import definitions’ stored procedures) are fixed here.')
  if (finding.check_key === 'tran-without-xact-abort') return proposeXactAbort(sql)
  if (finding.check_key === 'merge-null-key') {
    const p = proposeMergeNullSafe(sql, finding)
    if (!p.proposable) return p
    return { ...p, ...mergeRisks(finding, !!opts.sourceDupes) }
  }
  return manual('This kind of finding needs a person to fix it.')
}

// ─── diff ───────────────────────────────────────────────────────────────────

export interface DiffLine {
  type: ' ' | '-' | '+'
  text: string
  old_no: number | null
  new_no: number | null
}
export interface DiffHunk {
  old_start: number
  new_start: number
  lines: DiffLine[]
}

const lineStarts = (s: string) => {
  const out = [0]
  for (let i = 0; i < s.length; i++) if (s[i] === '\n') out.push(i + 1)
  return out
}

/**
 * Hunks for edits made to `sql` (whole changed lines, `context` lines around each, nearby hunks
 * merged). Built from the edits themselves, so no general diff algorithm is needed.
 */
export function diffForEdits(sql: string, edits: Edit[], context = 2): DiffHunk[] {
  if (!edits.length) return []
  const starts = lineStarts(sql)
  const lines = sql.split('\n')
  const lineOf = (off: number) => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid] <= off) lo = mid
      else hi = mid - 1
    }
    return lo // 0-based
  }
  // changed line ranges (0-based, inclusive), merged when their context overlaps
  const ranges = [...edits]
    .sort((a, b) => a.at - b.at)
    .map((e) => ({ from: lineOf(e.at), to: lineOf(e.at + Math.max(0, e.remove - 1)), edits: [e] }))
  const merged: typeof ranges = []
  for (const r of ranges) {
    const last = merged[merged.length - 1]
    if (last && r.from - last.to <= context * 2 + 1) {
      last.to = Math.max(last.to, r.to)
      last.edits.push(...r.edits)
    } else merged.push({ ...r, edits: [...r.edits] })
  }
  const hunks: DiffHunk[] = []
  let shift = 0 // new-line offset from earlier hunks
  for (const r of merged) {
    const segStart = starts[r.from]
    const segEnd = r.to + 1 < starts.length ? starts[r.to + 1] - 1 : sql.length
    const oldSeg = sql.slice(segStart, segEnd)
    const newSeg = applyEdits(
      oldSeg,
      r.edits.map((e) => ({ ...e, at: e.at - segStart }))
    )
    const oldLines = oldSeg.split('\n')
    const newLines = newSeg.split('\n')
    const ctxFrom = Math.max(0, r.from - context)
    const ctxTo = Math.min(lines.length - 1, r.to + context)
    const out: DiffLine[] = []
    for (let i = ctxFrom; i < r.from; i++)
      out.push({ type: ' ', text: lines[i], old_no: i + 1, new_no: i + 1 + shift })
    for (const [i, t] of oldLines.entries())
      out.push({ type: '-', text: t, old_no: r.from + i + 1, new_no: null })
    for (const [i, t] of newLines.entries())
      out.push({ type: '+', text: t, old_no: null, new_no: r.from + i + 1 + shift })
    const delta = newLines.length - oldLines.length
    for (let i = r.to + 1; i <= ctxTo; i++)
      out.push({ type: ' ', text: lines[i], old_no: i + 1, new_no: i + 1 + shift + delta })
    hunks.push({ old_start: ctxFrom + 1, new_start: ctxFrom + 1 + shift, lines: out })
    shift += delta
  }
  return hunks
}

/** The hunks as unified diff text (for copying). */
export function unifiedDiff(hunks: DiffHunk[], name: string): string {
  const out = [`--- ${name}`, `+++ ${name} (proposed)`]
  for (const h of hunks) {
    const oldN = h.lines.filter((l) => l.type !== '+').length
    const newN = h.lines.filter((l) => l.type !== '-').length
    out.push(`@@ -${h.old_start},${oldN} +${h.new_start},${newN} @@`)
    for (const l of h.lines) out.push(`${l.type}${l.text}`)
  }
  return out.join('\n')
}

/**
 * Whether a re-check after the fix is clean (pure): no check may report more than before, and the
 * fixed check must report fewer. Counts per check, not fingerprints, since a rewritten statement
 * changes the anchor of every finding on it.
 */
export function recheckVerdict(
  before: Array<{ check_key: string }>,
  after: Array<{ check_key: string }>,
  fixedCheck: string
): { ok: boolean; reason?: string } {
  const count = (list: Array<{ check_key: string }>) => {
    const m = new Map<string, number>()
    for (const f of list) m.set(f.check_key, (m.get(f.check_key) ?? 0) + 1)
    return m
  }
  const b = count(before)
  const a = count(after)
  for (const [k, n] of a)
    if (n > (b.get(k) ?? 0)) return { ok: false, reason: `the change brought a new “${k}” finding` }
  if ((a.get(fixedCheck) ?? 0) >= (b.get(fixedCheck) ?? 0))
    return { ok: false, reason: 'the finding is still there after the change' }
  return { ok: true }
}

/** Normalised text (comments kept as written) — what "the definition changed" compares. */
export const sameDefinition = (a: string, b: string) => normaliseSql(a) === normaliseSql(b)
