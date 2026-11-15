// api/src/services/sql-checks/announce-fix.ts
/**
 * The proposed fix for `write-unannounced` (realtime): a procedure that writes registered
 * collections tells open screens which records it changed, through `nivaro_announce_writes`
 * (migration 427) — pure: definition text in, edits out (propose.ts turns them into a proposal).
 *
 * The shape of the change:
 *
 *  1. One table variable at the top of the body:
 *       DECLARE @nvr_announced TABLE (c TINYINT NOT NULL, a CHAR(1) NOT NULL, id NVARCHAR(255) NULL);
 *  2. Each write statement that can carry it gets an OUTPUT clause that records the ids it
 *     touched there (`c` = which collection, `a` = I / U / D):
 *       UPDATE … SET … OUTPUT 1, 'U', CAST(inserted.[id] AS NVARCHAR(255)) INTO @nvr_announced (c, a, id) FROM … WHERE …
 *     An OUTPUT clause lives INSIDE its statement, so `IF x UPDATE …` keeps its shape — nothing is
 *     added between statements. A table variable keeps its rows through a ROLLBACK, so the worst
 *     case is one announcement too many (screens re-read and find nothing new).
 *  3. One block at the end of the body (before a trailing RETURN) announces each collection:
 *     the ids when there are 1–100 of them, "many rows changed" (@Ids = NULL → a collection-wide
 *     event clients answer by re-reading the rows they show) past that.
 *     The block never makes the procedure fail: it is skipped when the transaction is already
 *     doomed (XACT_STATE() = -1) or the announcer procedure is missing, runs with XACT_ABORT OFF
 *     (an error in it cannot doom the caller's transaction; the setting is put back as found)
 *     and swallows its own errors in TRY/CATCH. Inside a caller's transaction the announcement
 *     commits — or rolls back — with the work it describes.
 *
 * A statement that cannot carry an OUTPUT clause (INSERT … EXEC, TRUNCATE, one that already has
 * OUTPUT, a table without a one-column primary key) makes its collection announce "many rows
 * changed" on every run instead (the notes say which). Writes inside dynamic SQL are not seen; the
 * outside-write watcher (services/outside-write-watch.ts) is the safety net for those.
 */
import {
  ANNOUNCE_BEGIN,
  ANNOUNCE_END,
  type Catalog,
  type FoundWrite,
  statementEnd,
  type UnannouncedGroup,
  unannouncedWriteGroups
} from './checkers.js'
import { depthMap, lineAt, maskSql, matchParen } from './tokenizer.js'

export interface AnnounceEdit {
  at: number
  remove: number
  insert: string
}

export type AnnounceMode = 'ids' | 'whole'

export interface AnnouncePlanStatement {
  verb: FoundWrite['verb']
  line: number
  mode: AnnounceMode
  /** Why the ids cannot be captured (mode 'whole'). */
  why?: string
}

export interface AnnouncePlanItem {
  collection: string
  statements: AnnouncePlanStatement[]
  /** Ids are announced (some statement captures them). */
  ids: boolean
  /** "Many rows changed" on every run (some statement cannot capture ids). */
  whole: boolean
}

export interface AnnounceProposal {
  ok: boolean
  manual_reason?: string
  edits: AnnounceEdit[]
  plan: AnnouncePlanItem[]
  notes: string[]
}

export const ANNOUNCE_TABLE = '@nvr_announced'
/** Up to this many ids go out as a list; past it, "many rows changed" (the announcer's BULK_CAP). */
export const ANNOUNCE_ID_CAP = 100

const ACTION_OF: Record<string, { a: string; action: string; word: string }> = {
  I: { a: 'I', action: 'create', word: 'added' },
  U: { a: 'U', action: 'update', word: 'changed' },
  D: { a: 'D', action: 'delete', word: 'deleted' }
}

const bracket = (s: string) => `[${s.replace(/]/g, ']]')}]`
const nlit = (s: string) => `N'${s.replace(/'/g, "''")}'`

/** Leading whitespace of the line holding `offset`. */
function indentAt(sql: string, offset: number): string {
  const lineStart = sql.lastIndexOf('\n', offset - 1) + 1
  const m = /^[ \t]*/.exec(sql.slice(lineStart))
  return m ? m[0] : ''
}

function nextCode(masked: string, pos: number): number {
  while (pos < masked.length && /\s/.test(masked[pos])) pos++
  return pos
}

/** Offset just after the last non-space character before `pos`. */
function trimBack(masked: string, pos: number): number {
  while (pos > 0 && /\s/.test(masked[pos - 1])) pos--
  return pos
}

/** Whether only whitespace precedes `offset` on its line. */
function startsLine(sql: string, offset: number): boolean {
  const lineStart = sql.lastIndexOf('\n', offset - 1) + 1
  return /^[ \t]*$/.test(sql.slice(lineStart, offset))
}

/** A top-level (same paren depth as `level`) keyword match in [from, to), or -1. */
function topLevelWord(
  masked: string,
  depth: Int16Array,
  re: RegExp,
  from: number,
  to: number,
  level: number
): number {
  const r = new RegExp(re.source, 'gi')
  r.lastIndex = from
  for (let m = r.exec(masked); m && m.index < to; m = r.exec(masked)) {
    if (depth[m.index] === level && !/[@.#$\w]/.test(masked[m.index - 1] ?? '')) return m.index
  }
  return -1
}

/** The `;` that ends a statement at `level` from `from`, or -1. */
function semicolonAt(masked: string, depth: Int16Array, from: number, level: number): number {
  for (let k = from; k < masked.length; k++) {
    if (depth[k] < level) return -1
    if (masked[k] === ';' && depth[k] === level) return k
  }
  return -1
}

/**
 * Where an OUTPUT clause goes in one write statement (an offset in the text), or why it cannot.
 * Offsets come from the masked text, so nothing lands inside a comment or a string literal.
 */
export function outputSlot(
  masked: string,
  depth: Int16Array,
  w: FoundWrite
): { at: number } | { why: string } {
  const level = depth[w.start]
  if (w.verb === 'TRUNCATE') return { why: 'TRUNCATE TABLE cannot report the rows it removes' }
  if (w.verb === 'MERGE') {
    const mg = w.merge
    if (!mg) return { why: 'the MERGE could not be read' }
    const semi = semicolonAt(masked, depth, mg.onEnd, level)
    if (semi < 0) return { why: 'the MERGE has no closing semicolon' }
    if (topLevelWord(masked, depth, /\bOUTPUT\b/, mg.onEnd, semi, level) >= 0)
      return { why: 'the MERGE already has an OUTPUT clause' }
    const option = topLevelWord(masked, depth, /\bOPTION\s*\(/, mg.onEnd, semi, level)
    return { at: option >= 0 ? option : trimBack(masked, semi) }
  }
  if (w.verb === 'INSERT') {
    let pos = nextCode(masked, w.targetEnd)
    if (/^WITH\s*\(/i.test(masked.slice(pos, pos + 12))) {
      const close = matchParen(masked, masked.indexOf('(', pos))
      if (close < 0) return { why: 'the INSERT could not be read' }
      pos = nextCode(masked, close + 1)
    }
    if (masked[pos] === '(' && !/^\(\s*SELECT\b/i.test(masked.slice(pos, pos + 20))) {
      const close = matchParen(masked, pos)
      if (close < 0) return { why: 'the INSERT column list could not be read' }
      pos = nextCode(masked, close + 1)
    }
    const word = /^[A-Za-z_]+/.exec(masked.slice(pos))?.[0]?.toUpperCase() ?? ''
    if (word === 'OUTPUT') return { why: 'the INSERT already has an OUTPUT clause' }
    if (word === 'EXEC' || word === 'EXECUTE')
      return { why: 'INSERT … EXEC cannot carry an OUTPUT clause' }
    if (!['VALUES', 'SELECT', 'DEFAULT', 'WITH'].includes(word) && masked[pos] !== '(')
      return { why: 'the INSERT could not be read' }
    return { at: pos }
  }
  if (w.verb === 'UPDATE') {
    const setM = /\bSET\b/i.exec(masked.slice(w.targetEnd, w.targetEnd + 400))
    if (!setM) return { why: 'the UPDATE could not be read' }
    const setAt = w.targetEnd + setM.index + 3
    const end = statementEnd(masked, depth, setAt)
    if (topLevelWord(masked, depth, /\bOUTPUT\b/, setAt, end, level) >= 0)
      return { why: 'the UPDATE already has an OUTPUT clause' }
    const stop = topLevelWord(masked, depth, /\b(?:FROM|WHERE|OPTION)\b/, setAt, end, level)
    return { at: stop >= 0 ? stop : trimBack(masked, end) }
  }
  // DELETE [TOP (n)] [FROM] target [WITH (hints)] → OUTPUT here → [FROM …] [WHERE …]
  let pos = nextCode(masked, w.targetEnd)
  if (/^WITH\s*\(/i.test(masked.slice(pos, pos + 12))) {
    const close = matchParen(masked, masked.indexOf('(', pos))
    if (close < 0) return { why: 'the DELETE could not be read' }
    pos = close + 1
  }
  const end = statementEnd(masked, depth, pos)
  if (topLevelWord(masked, depth, /\bOUTPUT\b/, pos, end, level) >= 0)
    return { why: 'the DELETE already has an OUTPUT clause' }
  const next = nextCode(masked, pos)
  return { at: next >= end ? trimBack(masked, end) : next }
}

/** The OUTPUT clause that records one statement's ids for collection number `c`. */
export function outputClause(verb: FoundWrite['verb'], c: number, pk: string): string {
  const col = bracket(pk)
  const into = `INTO ${ANNOUNCE_TABLE} (c, a, id)`
  if (verb === 'MERGE')
    return `OUTPUT ${c}, LEFT($action, 1), CAST(COALESCE(inserted.${col}, deleted.${col}) AS NVARCHAR(255)) ${into}`
  if (verb === 'DELETE') return `OUTPUT ${c}, 'D', CAST(deleted.${col} AS NVARCHAR(255)) ${into}`
  const a = verb === 'INSERT' ? 'I' : 'U'
  return `OUTPUT ${c}, '${a}', CAST(inserted.${col} AS NVARCHAR(255)) ${into}`
}

/** Which actions a statement can produce (MERGE: any). */
function actionsOf(verb: FoundWrite['verb']): string[] {
  if (verb === 'INSERT') return ['I']
  if (verb === 'UPDATE') return ['U']
  if (verb === 'DELETE' || verb === 'TRUNCATE') return ['D']
  return ['I', 'U', 'D']
}

/** The announce block (one collection after another), indented with `ind`. */
export function announceBlock(
  ind: string,
  source: string,
  items: Array<{ collection: string; c: number; idActions: string[]; wholeActions: string[] }>
): string {
  const i2 = `${ind}    `
  const i3 = `${i2}    `
  const i4 = `${i3}    `
  const src = nlit(source.slice(0, 120))
  const lines = [
    `${ind}${ANNOUNCE_BEGIN} — tells open screens which records this procedure changed`,
    `${ind}-- (SQL checks: "Writes a registered collection without announcing"). It never fails the procedure.`,
    `${ind}IF XACT_STATE() <> -1 AND OBJECT_ID(N'dbo.nivaro_announce_writes', N'P') IS NOT NULL`,
    `${ind}BEGIN`,
    `${i2}DECLARE @nvr_ann_xa BIT = CASE WHEN @@OPTIONS & 16384 = 16384 THEN 1 ELSE 0 END;`,
    `${i2}DECLARE @nvr_ann_n INT, @nvr_ann_ids NVARCHAR(MAX);`,
    `${i2}SET XACT_ABORT OFF;`,
    `${i2}BEGIN TRY`
  ]
  for (const it of items) {
    const col = nlit(it.collection)
    for (const a of it.idActions) {
      const act = ACTION_OF[a]
      const where = `WHERE c = ${it.c} AND a = '${a}'`
      lines.push(
        `${i3}-- ${it.collection}: records ${act.word}`,
        `${i3}SELECT @nvr_ann_n = COUNT(DISTINCT id), @nvr_ann_ids = NULL FROM ${ANNOUNCE_TABLE} ${where};`,
        `${i3}IF @nvr_ann_n > 0`,
        `${i3}BEGIN`,
        `${i4}IF @nvr_ann_n <= ${ANNOUNCE_ID_CAP}`,
        `${i4}    SELECT @nvr_ann_ids = COALESCE(@nvr_ann_ids + N',', N'') + d.id FROM (SELECT DISTINCT id FROM ${ANNOUNCE_TABLE} ${where} AND id IS NOT NULL) d;`,
        `${i4}EXEC dbo.nivaro_announce_writes @Collection = ${col}, @Ids = @nvr_ann_ids, @Action = N'${act.action}', @Source = ${src};`,
        `${i3}END`
      )
    }
    for (const a of it.wholeActions) {
      const act = ACTION_OF[a]
      lines.push(
        `${i3}-- ${it.collection}: records ${act.word} (the ids cannot be collected: "many records changed")`,
        `${i3}EXEC dbo.nivaro_announce_writes @Collection = ${col}, @Ids = NULL, @Action = N'${act.action}', @Source = ${src};`
      )
    }
  }
  lines.push(
    `${i2}END TRY`,
    `${i2}BEGIN CATCH`,
    `${i3}-- best effort: the procedure's own work stands`,
    `${i2}END CATCH`,
    `${i2}IF @nvr_ann_xa = 1 SET XACT_ABORT ON;`,
    `${ind}END`,
    `${ind}${ANNOUNCE_END}`
  )
  return lines.join('\n')
}

const PROC_HEAD = /\b(?:CREATE|ALTER)\s+(?:OR\s+ALTER\s+)?PROC(?:EDURE)?\b/i

/** Just past the AS that ends a procedure header (see propose.ts procBodyStart). */
function bodyStart(masked: string, depth: Int16Array): number {
  const head = PROC_HEAD.exec(masked)
  if (!head) return -1
  const re = /\bAS\b/gi
  re.lastIndex = head.index + head[0].length
  for (let m = re.exec(masked); m; m = re.exec(masked)) {
    if (depth[m.index] !== 0) continue
    if (/[@#$\w.]/.test(masked[m.index - 1] ?? '')) continue
    if (/\bEXEC(?:UTE)?\s*$/i.test(masked.slice(Math.max(0, m.index - 20), m.index))) continue
    return m.index + m[0].length
  }
  return -1
}

/**
 * The END matching a body-wrapping BEGIN at `begin`, when it is the last word of the text
 * (statements after it would be outside the block); -1 otherwise.
 */
function wrappingEnd(masked: string, begin: number): number {
  const re = /\b(BEGIN|END|CASE)\b/gi
  re.lastIndex = begin
  let balance = 0
  for (let m = re.exec(masked); m; m = re.exec(masked)) {
    if (/[@.#$\w]/.test(masked[m.index - 1] ?? '')) continue
    const w = m[1].toUpperCase()
    if (w === 'BEGIN') {
      // BEGIN TRAN / DISTRIBUTED / DIALOG / CONVERSATION open no block
      if (
        /^BEGIN\s+(?:TRAN|TRANSACTION|DISTRIBUTED|DIALOG|CONVERSATION)\b/i.test(
          masked.slice(m.index, m.index + 40)
        )
      )
        continue
      balance++
    } else if (w === 'CASE') balance++
    else {
      balance--
      if (balance === 0) {
        const rest = masked.slice(m.index + 3).replace(/[\s;]/g, '')
        return rest === '' ? m.index : -1
      }
    }
  }
  return -1
}

/**
 * The announce fix for one procedure definition: the writes `catalog` says are unannounced get
 * their ids collected and announced at the end. `source` is what the announcement says wrote it
 * ("procedure:dbo.usp_x"). Pure.
 */
export function proposeAnnounce(
  sql: string,
  catalog: Catalog,
  opts: { source: string }
): AnnounceProposal {
  const manual = (reason: string): AnnounceProposal => ({
    ok: false,
    manual_reason: reason,
    edits: [],
    plan: [],
    notes: []
  })
  const masked = maskSql(sql)
  const depth = depthMap(masked)
  if (!PROC_HEAD.test(masked))
    return manual('Only procedures can be fixed this way; this is not one.')
  const groups: UnannouncedGroup[] = unannouncedWriteGroups(sql, masked, depth, catalog)
  if (!groups.length) return manual('Every write here already announces its records.')
  if (/@nvr_announced\b/i.test(masked) || sql.toLowerCase().includes(ANNOUNCE_BEGIN))
    return manual(
      'The procedure already has an announce block; a write added since needs to join it by hand.'
    )
  let at = bodyStart(masked, depth)
  if (at < 0) return manual('The procedure header could not be read.')

  // 1. the OUTPUT clauses
  const edits: AnnounceEdit[] = []
  const plan: AnnouncePlanItem[] = []
  const blockItems: Array<{
    collection: string
    c: number
    idActions: string[]
    wholeActions: string[]
  }> = []
  let anyIds = false
  let mergeIds = false
  groups.forEach((g, gi) => {
    const c = gi + 1
    const pk = catalog.primaryKey?.(g.table.schema, g.table.name) ?? []
    const ids = new Set<string>()
    const whole = new Set<string>()
    const statements: AnnouncePlanStatement[] = []
    for (const w of g.writes) {
      const line = lineAt(sql, w.start)
      const slot =
        pk.length === 1
          ? outputSlot(masked, depth, w)
          : {
              why:
                pk.length === 0
                  ? `${g.table.name} has no primary key`
                  : `${g.table.name} has a primary key of ${pk.length} columns`
            }
      if ('why' in slot) {
        for (const a of actionsOf(w.verb)) whole.add(a)
        statements.push({ verb: w.verb, line, mode: 'whole', why: slot.why })
        continue
      }
      const clause = outputClause(w.verb, c, pk[0])
      const onOwnLine = startsLine(sql, slot.at) && slot.at < sql.length
      edits.push({
        at: slot.at,
        remove: 0,
        insert: onOwnLine
          ? `${clause}\n${indentAt(sql, slot.at)}`
          : `${/\s/.test(sql[slot.at - 1] ?? ' ') ? '' : ' '}${clause}${/\s|;/.test(sql[slot.at] ?? '') || slot.at >= sql.length ? '' : ' '}`
      })
      for (const a of actionsOf(w.verb)) ids.add(a)
      if (w.verb === 'MERGE') mergeIds = true
      anyIds = true
      statements.push({ verb: w.verb, line, mode: 'ids' })
    }
    const order = ['I', 'U', 'D']
    blockItems.push({
      collection: g.collection,
      c,
      idActions: order.filter((a) => ids.has(a)),
      wholeActions: order.filter((a) => whole.has(a))
    })
    plan.push({ collection: g.collection, statements, ids: ids.size > 0, whole: whole.size > 0 })
  })

  // 2. the table variable, first thing in the body (after AS [BEGIN], SET NOCOUNT / XACT_ABORT)
  let pos = nextCode(masked, at)
  const begin = /^BEGIN\b(?!\s+(?:TRAN|TRANSACTION|TRY|DISTRIBUTED)\b)/i.exec(masked.slice(pos))
  const beginAt = begin ? pos : -1
  if (begin) {
    at = pos + begin[0].length
    pos = nextCode(masked, at)
  }
  const sameLine = !sql.slice(at, pos).includes('\n')
  const indent = sameLine || pos >= sql.length ? `${indentAt(sql, at)}    ` : indentAt(sql, pos)
  let declAt = at
  for (;;) {
    const set = /^SET\s+(?:NOCOUNT|XACT_ABORT)\s+(?:ON|OFF)\b\s*;?/i.exec(masked.slice(pos))
    if (!set) break
    declAt = pos + set[0].replace(/\s+$/, '').length
    pos = nextCode(masked, declAt)
  }
  if (anyIds)
    edits.push({
      at: declAt,
      remove: 0,
      insert: `\n${indent}DECLARE ${ANNOUNCE_TABLE} TABLE (c TINYINT NOT NULL, a CHAR(1) NOT NULL, id NVARCHAR(255) NULL);`
    })

  // 3. the announce block, at the end of the body (before a trailing RETURN)
  let endAt = trimBack(masked, masked.length)
  if (beginAt >= 0) {
    const end = wrappingEnd(masked, beginAt)
    if (end >= 0) endAt = end
  }
  if (/\bGO\s*;?\s*$/i.test(masked.slice(0, endAt)))
    return manual('The text ends with GO (a script, not one procedure); fix it by hand.')
  const tail = masked.slice(0, endAt)
  const ret = /\bRETURN\b[^;\n]*;?\s*$/i.exec(tail)
  if (ret && startsLine(sql, ret.index)) endAt = ret.index
  const block = announceBlock(indent, opts.source, blockItems)
  if (startsLine(sql, endAt) && endAt < sql.length) {
    const lineStart = sql.lastIndexOf('\n', endAt - 1) + 1
    edits.push({ at: lineStart, remove: 0, insert: `${block}\n` })
  } else {
    const back = trimBack(masked, endAt)
    edits.push({ at: back, remove: 0, insert: `\n${block}${endAt < sql.length ? '\n' : ''}` })
  }

  // 4. what a reviewer should know
  const notes: string[] = []
  for (const p of plan) {
    const wholeOnes = p.statements.filter((s) => s.mode === 'whole')
    if (p.ids)
      notes.push(
        `${p.collection}: the changed ids are announced (more than ${ANNOUNCE_ID_CAP} in one run → "many records changed", and open lists re-read the rows they show).`
      )
    for (const s of wholeOnes)
      notes.push(
        `${p.collection}: ${s.verb} on line ${s.line} cannot collect ids (${s.why}), so every run announces "many records changed" for ${p.collection}.`
      )
  }
  if (mergeIds)
    notes.push(
      'A MERGE now writes one row per record it touches into a table variable; on very large runs that is some extra tempdb work.'
    )
  if (/\bRETURN\b/i.test(masked.slice(at, endAt)))
    notes.push(
      'The procedure can RETURN early; records written before an early RETURN are not announced (the outside-write watcher still catches them where it watches).'
    )
  if (/\bEXEC(?:UTE)?\s*\(|\bsp_executesql\b/i.test(masked))
    notes.push('Writes inside dynamic SQL are not seen by this fix.')
  return { ok: true, edits, plan, notes }
}
