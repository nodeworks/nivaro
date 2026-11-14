/**
 * Likely duplicates for a record being created (Rob 2026-11-13).
 *
 * Reference lists (unit types, vendors, categories, project types…) grow copies because
 * nobody sees that "MX480" already exists while typing "mx480 ". The new-record form asks
 * here as the person types; the import preview asks for every row it would create.
 *
 * Which fields are compared — `nivaro_collections.browser_config.duplicate_check`:
 *
 *   { mode?: 'on' | 'off', fields?: string[], block_exact?: boolean }
 *
 * - no setting (auto): ON for a small reference list — the display template names exactly
 *   one plain string field (not computed, not a generated id) and the table holds at most
 *   AUTO_ROW_LIMIT rows. Everything else (transactional tables, multi-field labels, system
 *   tables) is OFF unless configured.
 * - `on`: the listed `fields` (else the display template's text fields), any table size.
 * - `off`: never.
 * - `block_exact`: a create whose value equals an existing record's (case and spacing
 *   ignored) is refused by the items service (`enforceDuplicateBlock`, code DUPLICATE_RECORD).
 *
 * Matching is judged AS THE CALLER: candidate statements carry the caller's read gate
 * (searchAccessClause: row filter + User Scopes) and every candidate is read again through
 * the items service as the caller, so a record the person may not read never shows — and
 * a field they may not read is never compared. Three bounded passes per field, under one
 * time budget: exact (`col = ?`, seeks an index), folded (spaces/punctuation/case removed;
 * tables up to CLOSE_ROW_LIMIT rows) and a typo pass (the global-search trigram statement,
 * same limit). The JS classifier then decides exact vs close and drops weak candidates.
 */
import type { FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { fuzzyStatement } from '../routes/global-search.js'
import type { ItemsQuery, User } from '../types.js'
import { getCollection, getFields } from './collections.js'
import { resolveDisplayValue } from './display-value.js'
import { getAllowedFields } from './permissions.js'
import { tableFacts } from './picker-typo.js'
import { type AccessClause, andAccess, onIdExpr, searchAccessClause } from './search-access.js'
import { SearchBudget } from './search-budget.js'
import { BINARY_COLLATION, onMssql, type TextKind, typedEquals } from './search-like.js'

/** Auto mode applies to tables up to this many rows (reference lists, not transactions). */
export const AUTO_ROW_LIMIT = 50_000
/** The folded and typo passes scan; tables above this get the exact (seekable) pass only. */
export const CLOSE_ROW_LIMIT = 50_000
/** Matches answered per field. */
export const MAX_MATCHES = 5
/** Candidates each statement keeps. */
const CANDIDATES = 10
/** The whole lookup's time budget (the form asks while someone types). */
export const DUPLICATE_BUDGET_MS = 1500
/** Values shorter than this (after trimming) are not looked up. */
export const MIN_VALUE_LENGTH = 2
/** Values longer than this are not labels. */
export const MAX_VALUE_LENGTH = 200

const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/
const SYSTEM = /^(nivaro_|directus_)/i
const NEVER = /password|token|secret|totp/i
const PLAIN_ASCII = /^[\x20-\x7e]*$/

// ─── Setting ────────────────────────────────────────────────────────────────

export type DuplicateMode = 'auto' | 'on' | 'off'

export interface DuplicateCheckSetting {
  mode: DuplicateMode
  fields: string[] | null
  block_exact: boolean
}

/** `browser_config.duplicate_check` (JSON text or an object); anything malformed = auto. */
export function parseDuplicateCheck(browserConfig: unknown): DuplicateCheckSetting {
  let bc: unknown = browserConfig
  if (typeof bc === 'string') {
    try {
      bc = JSON.parse(bc)
    } catch {
      bc = null
    }
  }
  const raw =
    bc && typeof bc === 'object' ? (bc as { duplicate_check?: unknown }).duplicate_check : null
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    return { mode: 'auto', fields: null, block_exact: false }
  const r = raw as { mode?: unknown; fields?: unknown; block_exact?: unknown }
  const mode: DuplicateMode = r.mode === 'on' || r.mode === 'off' ? r.mode : 'auto'
  const fields = Array.isArray(r.fields)
    ? [...new Set(r.fields.map((f) => String(f ?? '').trim()).filter((f) => IDENT.test(f)))]
    : []
  return { mode, fields: fields.length ? fields : null, block_exact: r.block_exact === true }
}

export function templateFields(template: string | null | undefined): string[] {
  const out: string[] = []
  for (const m of String(template ?? '').matchAll(/\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g))
    if (!out.includes(m[1])) out.push(m[1])
  return out
}

export interface DuplicateFieldMeta {
  field: string
  type?: string | null
  computed_type?: string | null
  options?: Record<string, unknown> | null
}

export interface ResolvedDuplicateCheck {
  enabled: boolean
  /** The compared fields (before the caller's own read access narrows them). */
  fields: string[]
  block_exact: boolean
  /** Whether the folded + typo passes run (table small enough). */
  close: boolean
  source: 'auto' | 'configured' | 'off'
  /** Why it is off (for the settings card). */
  reason?: string
  rows: number | null
}

const isGenerated = (f: DuplicateFieldMeta | undefined) =>
  !!f &&
  (!!f.computed_type ||
    !!(f.options && typeof f.options === 'object' && 'auto_id' in f.options && f.options.auto_id))

/** Which fields a collection compares (pure; exported for tests). */
export function resolveDuplicateFields(args: {
  collection: string
  setting: DuplicateCheckSetting
  template: string | null | undefined
  kinds: Record<string, TextKind>
  fields: DuplicateFieldMeta[]
  rows: number | null
}): ResolvedDuplicateCheck {
  const { setting, kinds, rows } = args
  const close = rows != null && rows <= CLOSE_ROW_LIMIT
  const off = (source: ResolvedDuplicateCheck['source'], reason: string) => ({
    enabled: false,
    fields: [],
    block_exact: false,
    close,
    source,
    reason,
    rows
  })
  if (SYSTEM.test(args.collection)) return off('off', 'System tables are never checked')
  if (setting.mode === 'off') return off('off', 'Turned off for this collection')
  const meta = new Map(args.fields.map((f) => [f.field, f]))
  const comparable = (f: string) =>
    IDENT.test(f) &&
    f !== 'id' &&
    !NEVER.test(f) &&
    (kinds[f] === 'unicode' || kinds[f] === 'ansi') &&
    !isGenerated(meta.get(f))
  const fromTemplate = templateFields(args.template)
  if (setting.mode === 'on') {
    const wanted = (setting.fields ?? fromTemplate).filter(comparable)
    if (!wanted.length)
      return off('configured', 'None of the chosen fields is a text field that can be compared')
    return {
      enabled: true,
      fields: wanted,
      block_exact: setting.block_exact,
      close,
      source: 'configured',
      rows
    }
  }
  // auto
  if (fromTemplate.length !== 1)
    return off(
      'auto',
      fromTemplate.length === 0
        ? 'The collection has no display template'
        : 'The label is built from several fields — choose the fields to compare'
    )
  const only = fromTemplate[0]
  if (!comparable(only) || (meta.get(only)?.type && meta.get(only)?.type !== 'string'))
    return off('auto', 'The label is not a plain text field')
  if (rows == null || rows > AUTO_ROW_LIMIT)
    return off(
      'auto',
      rows == null
        ? 'The table size is unknown'
        : `More than ${AUTO_ROW_LIMIT.toLocaleString('en-US')} records — turn it on to check anyway`
    )
  // block_exact may be set without a mode (an admin who only ticked "block").
  return {
    enabled: true,
    fields: [only],
    block_exact: setting.block_exact,
    close,
    source: 'auto',
    rows
  }
}

export interface DuplicateConfig extends ResolvedDuplicateCheck {
  kinds: Record<string, TextKind>
  template: string | null
  label: string
}

/** The collection's resolved setting (metadata + table facts are cached). */
export async function duplicateConfig(collection: string): Promise<DuplicateConfig | null> {
  if (!IDENT.test(collection)) return null
  const col = (await getCollection(collection).catch(() => null)) as
    | ({ browser_config?: unknown; display_template?: string | null } & Record<string, unknown>)
    | null
    | undefined
  if (!col) return null
  const [facts, fields] = await Promise.all([
    tableFacts(collection).catch(() => null),
    getFields(collection).catch(() => [])
  ])
  const resolved = resolveDuplicateFields({
    collection,
    setting: parseDuplicateCheck(col.browser_config),
    template: col.display_template ?? null,
    kinds: facts?.kinds ?? {},
    fields: fields as DuplicateFieldMeta[],
    rows: facts ? facts.rows : null
  })
  const label =
    String(col.singular ?? '').trim() ||
    String(col.display_name ?? '').trim() ||
    collection.replace(/_/g, ' ')
  return {
    ...resolved,
    kinds: facts?.kinds ?? {},
    template: col.display_template ?? null,
    label
  }
}

// ─── Matching (pure) ───────────────────────────────────────────────────────

/** Exact identity: case, outer spaces and repeated inner spaces ignored. */
export function exactKey(s: string): string {
  return s.normalize('NFC').trim().replace(/\s+/g, ' ').toLowerCase()
}

/** Folded identity: accents, case, spaces and punctuation removed ("MX-480 " = "mx480"). */
export function foldKey(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^\p{L}\p{N}]/gu, '')
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++)
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = cur
  }
  return prev[b.length]
}

export type MatchKind = 'exact' | 'close'

/**
 * How `existing` compares to the typed `draft`; null = not a likely duplicate.
 * - exact: same text ignoring case and spacing.
 * - close: same letters and digits ignoring punctuation/accents ("MX-480" vs "MX480"),
 *   one is the start of the other ("Acme Corp" vs "Acme Corporation"), or one or two
 *   typos in a longer value (edit similarity ≥ 0.85 on 6+ characters).
 */
export function classifyMatch(
  draft: string,
  existing: string
): { match: MatchKind; score: number } | null {
  if (!draft.trim() || !existing.trim()) return null
  if (exactKey(draft) === exactKey(existing)) return { match: 'exact', score: 1 }
  const a = foldKey(draft)
  const b = foldKey(existing)
  if (!a || !b) return null
  if (a === b) return { match: 'close', score: 0.95 }
  const short = a.length <= b.length ? a : b
  const long = a.length <= b.length ? b : a
  if (short.length >= 4 && long.startsWith(short) && short.length / long.length >= 0.5)
    return {
      match: 'close',
      score: Math.round((0.6 + 0.3 * (short.length / long.length)) * 100) / 100
    }
  if (long.length >= 6) {
    const ratio = 1 - levenshtein(a, b) / long.length
    if (ratio >= 0.85) return { match: 'close', score: Math.round(ratio * 90) / 100 }
  }
  return null
}

// ─── Candidate statements (pure) ───────────────────────────────────────────

/** Characters the folded SQL pass removes (the JS foldKey removes these and more). */
const FOLD_CHARS = [' ', '-', '_', '.', ',', '/', '\\', '(', ')', "'", '"', '&', '+', '#', ':', ';']

/** `col` with FOLD_CHARS removed (nested REPLACE; tabs too). */
export function foldSqlExpr(colSql: string): string {
  let e = `REPLACE(${colSql}, CHAR(9), '')`
  for (const ch of FOLD_CHARS) e = `REPLACE(${e}, N'${ch === "'" ? "''" : ch}', '')`
  return e
}

/** The bound side of the folded pass: the same characters removed, upper-cased. */
export function sqlFoldValue(s: string): string {
  let out = s.replace(/\t/g, '')
  for (const ch of FOLD_CHARS) out = out.split(ch).join('')
  return out.toUpperCase()
}

export interface Stmt {
  sql: string
  bindings: unknown[]
}

const head = (collection: string) =>
  `SELECT TOP ${CANDIDATES} CAST(t.[id] AS nvarchar(64)) AS id FROM [${collection}] AS t WHERE `

/** Rows whose `field` equals `value` (the database's case-insensitive collation; seeks an index). */
export function exactStatement(
  collection: string,
  field: string,
  value: string,
  kind: TextKind,
  access: AccessClause | null,
  mssql = onMssql()
): Stmt {
  const eq = typedEquals(`t.[${field}]`, value.trim(), kind, { mssql })
  const gate = andAccess(onIdExpr(access, 't.[id]'))
  return {
    sql: `${head(collection)}${eq.sql}${gate.sql}`,
    bindings: [...eq.bindings, ...gate.bindings]
  }
}

/** Rows whose `field` equals `value` once spaces and punctuation are removed (scans). */
export function foldStatement(
  collection: string,
  field: string,
  value: string,
  access: AccessClause | null
): Stmt | null {
  const folded = sqlFoldValue(value.trim())
  if (folded.length < MIN_VALUE_LENGTH) return null
  const expr = foldSqlExpr(`t.[${field}]`)
  const cmp = PLAIN_ASCII.test(folded)
    ? `UPPER(${expr}) COLLATE ${BINARY_COLLATION} = ?`
    : `${expr} = ?`
  const gate = andAccess(onIdExpr(access, 't.[id]'))
  return { sql: `${head(collection)}${cmp}${gate.sql}`, bindings: [folded, ...gate.bindings] }
}

// ─── The lookup ────────────────────────────────────────────────────────────

export interface DuplicateMatch {
  id: string
  /** The record's label (display template, else the compared value). */
  label: string
  /** The compared field's stored value. */
  value: string
  match: MatchKind
  score: number
}

export interface DuplicateAnswer {
  enabled: boolean
  fields: string[]
  block_exact: boolean
  close: boolean
  label: string
  matches: Record<string, DuplicateMatch[]>
  /** A pass ran out of time: the answer may miss a match. */
  partial?: boolean
}

export interface DuplicateRunner {
  run(label: string, sql: string, bindings: readonly unknown[]): Promise<Array<{ id: unknown }>>
  finish(): void
  readonly partial: boolean
}

export interface DuplicateDeps {
  config: (collection: string) => Promise<DuplicateConfig | null>
  allowed: (user: User, collection: string) => Promise<string[] | null>
  access: (user: User, collection: string) => Promise<AccessClause | null>
  runner: () => DuplicateRunner
  read: (
    user: User,
    collection: string,
    query: ItemsQuery,
    req?: FastifyRequest
  ) => Promise<Array<Record<string, unknown>>>
  mssql: () => boolean
}

function budgetRunner(): DuplicateRunner {
  const budget = new SearchBudget(DUPLICATE_BUDGET_MS, 3)
  let cut = false
  return {
    async run(label, sql, bindings) {
      try {
        return await budget.runQuery<{ id: unknown }>(label, sql, bindings)
      } catch {
        cut = true
        return []
      }
    },
    finish: () => {
      cut = cut || budget.timedOut.size > 0
      budget.finish()
    },
    get partial() {
      return cut || budget.timedOut.size > 0
    }
  }
}

export const defaultDuplicateDeps: DuplicateDeps = {
  config: duplicateConfig,
  allowed: (user, collection) => getAllowedFields(user, 'read', collection).catch(() => []),
  access: (user, collection) => searchAccessClause(user, collection).catch(() => null),
  runner: budgetRunner,
  read: async (user, collection, query, req) => {
    const { readItems } = await import('./items.js')
    const res = await readItems(user, collection, query, req)
    return (res?.data ?? []) as Array<Record<string, unknown>>
  },
  mssql: onMssql
}

const readableBy = (allowed: string[] | null) => (f: string) =>
  allowed == null || allowed.includes('*') || allowed.includes(f)

/** The fields `user` gets compared: the config's, narrowed to what they may read. */
export function fieldsFor(cfg: DuplicateConfig, allowed: string[] | null): string[] {
  return cfg.enabled ? cfg.fields.filter(readableBy(allowed)) : []
}

/**
 * Likely duplicates of `values` (field → typed text) in `collection`, as `user` sees the
 * collection. `excludeId` drops the record being edited.
 */
export async function findDuplicates(
  user: User,
  collection: string,
  values: Record<string, unknown>,
  opts: { excludeId?: string | number | null; limit?: number; req?: FastifyRequest } = {},
  deps: DuplicateDeps = defaultDuplicateDeps
): Promise<DuplicateAnswer> {
  const cfg = await deps.config(collection)
  const none: DuplicateAnswer = {
    enabled: false,
    fields: [],
    block_exact: false,
    close: false,
    label: cfg?.label ?? collection,
    matches: {}
  }
  if (!cfg?.enabled) return none
  const allowed = await deps.allowed(user, collection)
  const fields = fieldsFor(cfg, allowed)
  const answer: DuplicateAnswer = {
    enabled: fields.length > 0,
    fields,
    block_exact: cfg.block_exact,
    close: cfg.close,
    label: cfg.label,
    matches: {}
  }
  const asked = fields
    .map((f) => ({
      field: f,
      value: typeof values[f] === 'string' ? (values[f] as string).trim() : ''
    }))
    .filter((x) => x.value.length >= MIN_VALUE_LENGTH && x.value.length <= MAX_VALUE_LENGTH)
  if (asked.length === 0) return answer

  const access = await deps.access(user, collection)
  const mssql = deps.mssql()
  const runner = deps.runner()
  const candidates = new Map<string, Set<string>>()
  try {
    await Promise.all(
      asked.map(async ({ field, value }) => {
        const ids = new Set<string>()
        candidates.set(field, ids)
        const stmts: Array<[string, Stmt | null]> = [
          [
            'dup-exact',
            exactStatement(collection, field, value, cfg.kinds[field] ?? 'other', access, mssql)
          ]
        ]
        if (cfg.close) {
          stmts.push(['dup-fold', foldStatement(collection, field, value, access)])
          if (foldKey(value).length >= 5) {
            const fz = fuzzyStatement(
              [{ collection, cols: [field], kinds: cfg.kinds, access }],
              value,
              mssql,
              CANDIDATES
            )
            stmts.push(['dup-typo', fz])
          }
        }
        const results = await Promise.all(
          stmts
            .filter((s): s is [string, Stmt] => s[1] != null)
            .map(([label, s]) => runner.run(label, s.sql, s.bindings))
        )
        for (const rows of results) for (const r of rows) if (r?.id != null) ids.add(String(r.id))
      })
    )
  } finally {
    runner.finish()
  }
  if (runner.partial) answer.partial = true

  const exclude = opts.excludeId == null ? null : String(opts.excludeId)
  const allIds = [...new Set([...candidates.values()].flatMap((s) => [...s]))].filter(
    (id) => id !== exclude
  )
  if (allIds.length === 0) return answer

  // Read again AS THE CALLER: only records (and fields) they may read survive.
  const labelFields = templateFields(cfg.template).filter(
    (f) => IDENT.test(f) && readableBy(allowed)(f)
  )
  let rows: Array<Record<string, unknown>> = []
  try {
    rows = await deps.read(
      user,
      collection,
      {
        filter: { id: { _in: allIds } },
        fields: [...new Set(['id', ...fields, ...labelFields])],
        limit: allIds.length,
        count: false
      } as ItemsQuery,
      opts.req
    )
  } catch {
    return answer
  }
  const limit = Math.max(1, Math.min(MAX_MATCHES, opts.limit ?? MAX_MATCHES))
  for (const { field, value } of asked) {
    const ids = candidates.get(field) ?? new Set<string>()
    const out: DuplicateMatch[] = []
    for (const row of rows) {
      const id = String(row.id)
      if (!ids.has(id) || id === exclude) continue
      const stored = row[field]
      if (stored == null || typeof stored === 'object') continue
      const verdict = classifyMatch(value, String(stored))
      if (!verdict) continue
      const label = cfg.template ? resolveDisplayValue(row, cfg.template) : ''
      out.push({ id, label: label || String(stored), value: String(stored), ...verdict })
    }
    out.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label))
    if (out.length) answer.matches[field] = out.slice(0, limit)
  }
  return answer
}

// ─── Block exact duplicates on create (items service) ─────────────────────

/**
 * Refuses a create whose compared value equals an existing record's when the collection
 * says `block_exact`. Judged against EVERY record (a copy is a copy whoever can see it);
 * the refusal names the existing record only when the caller may read it. One seekable
 * `col = ?` per compared field the payload sets, and only on collections that block —
 * every other create pays nothing beyond the (cached) metadata read. A failing check
 * never blocks a create.
 */
export async function enforceDuplicateBlock(
  user: User,
  collection: string,
  payload: Record<string, unknown>,
  browserConfig: unknown
): Promise<void> {
  if (SYSTEM.test(collection)) return
  if (!parseDuplicateCheck(browserConfig).block_exact) return
  const cfg = await duplicateConfig(collection).catch(() => null)
  if (!cfg?.enabled || !cfg.block_exact) return
  for (const field of cfg.fields) {
    const v = payload[field]
    if (typeof v !== 'string') continue
    const value = v.trim()
    if (value.length < 1 || value.length > MAX_VALUE_LENGTH) continue
    let hit: { id: string; value: string } | null = null
    try {
      const eq = typedEquals(`[${field}]`, value, cfg.kinds[field] ?? 'other')
      const rows = (await db.raw(
        `SELECT TOP 5 CAST([id] AS nvarchar(64)) AS id, [${field}] AS v FROM [${collection}] WHERE ${eq.sql}`,
        eq.bindings
      )) as Array<{ id: string; v: unknown }>
      const found = (rows ?? []).find(
        (r) => r.v != null && exactKey(String(r.v)) === exactKey(value)
      )
      if (found) hit = { id: String(found.id), value: String(found.v) }
    } catch {
      hit = null
    }
    if (!hit) continue
    let readable = false
    try {
      const { readOne } = await import('./items.js')
      readable = (await readOne(user, collection, hit.id, undefined, ['id'])) != null
    } catch {
      readable = false
    }
    // An unreadable record is named by the caller's own text, never its stored spelling.
    const shown = readable ? hit.value : value
    throw Object.assign(
      new Error(
        `A ${cfg.label} named "${shown}" already exists${readable ? ' — open it instead of creating a copy' : ''}.`
      ),
      {
        statusCode: 400,
        code: 'DUPLICATE_RECORD',
        field,
        value: shown,
        ...(readable ? { existing_id: hit.id } : {})
      }
    )
  }
}

// ─── Import preview: rows that would create a copy ────────────────────────

export interface ImportDuplicateRow {
  /** The file's row number (header = 1). */
  row: number
  field: string
  value: string
  match: MatchKind
  /** The existing record it copies (absent for a repeat inside the file). */
  existing_id?: string
  existing_value?: string
  /** An earlier row of the same file with the same value. */
  first_row?: number
}

export interface ImportDuplicateSummary {
  fields: string[]
  /** Rows that copy an existing record exactly (case and spacing ignored). */
  exact_rows: number
  /** Rows that nearly copy one (punctuation/spacing/accents only). */
  close_rows: number
  /** Rows that repeat an earlier row of the same file. */
  in_file_rows: number
  /** Whether the near-copy pass ran (tables up to CLOSE_ROW_LIMIT rows). */
  close: boolean
  rows: ImportDuplicateRow[]
}

export type ImportDuplicateFetch = (
  field: string,
  pass: 'exact' | 'fold',
  keys: string[]
) => Promise<Array<{ id: unknown; v: unknown }>>

/** Existing rows whose `field` matches one of `keys` (raw reads: the import preview is
 *  administrators only and compares against every record, like the import itself). */
export function dbImportFetch(collection: string): ImportDuplicateFetch {
  return async (field, pass, keys) => {
    const { selectInChunks, whereInList } = await import('./db-batch.js')
    if (pass === 'exact')
      return (await selectInChunks(keys, 1000, (chunk) =>
        whereInList(db(collection).select({ id: 'id', v: field }), field, chunk)
      )) as Array<{ id: unknown; v: unknown }>
    return (await selectInChunks(keys, 1000, async (chunk) => {
      const rows = await db.raw(
        `SELECT CAST([id] AS nvarchar(64)) AS id, [${field}] AS v FROM [${collection}]
          WHERE UPPER(${foldSqlExpr(`[${field}]`)}) COLLATE ${BINARY_COLLATION}
             IN (SELECT [value] COLLATE ${BINARY_COLLATION} FROM OPENJSON(?))`,
        [JSON.stringify(chunk)]
      )
      return (rows ?? []) as Array<{ id: unknown; v: unknown }>
    })) as Array<{ id: unknown; v: unknown }>
  }
}

/**
 * The rows of an import that would create a copy of an existing record (or of an
 * earlier row of the same file), on the collection's duplicate-check fields. `rows` are
 * the rows the import would CREATE (row number + mapped values). Null when the
 * collection does not check duplicates or no compared field is mapped. The typo pass
 * does not run here (one statement per row); exact and folded matches only.
 */
export async function importDuplicateScan(
  collection: string,
  rows: Array<{ row: number; values: Record<string, unknown> }>,
  deps: {
    config?: (collection: string) => Promise<DuplicateConfig | null>
    fetch?: ImportDuplicateFetch
  } = {}
): Promise<ImportDuplicateSummary | null> {
  const cfg = await (deps.config ?? duplicateConfig)(collection).catch(() => null)
  if (!cfg?.enabled) return null
  const fields = cfg.fields.filter((f) => rows.some((r) => f in r.values))
  if (fields.length === 0) return null
  const fetch = deps.fetch ?? dbImportFetch(collection)
  const summary: ImportDuplicateSummary = {
    fields,
    exact_rows: 0,
    close_rows: 0,
    in_file_rows: 0,
    close: cfg.close,
    rows: []
  }
  const textOf = (v: unknown) =>
    v == null || typeof v === 'object' ? '' : String(v).trim().slice(0, MAX_VALUE_LENGTH)
  // Per field: existing records by exact key and by folded key.
  const byExact = new Map<string, Map<string, { id: string; v: string }>>()
  const byFold = new Map<string, Map<string, { id: string; v: string }>>()
  for (const field of fields) {
    const values = [...new Set(rows.map((r) => textOf(r.values[field])).filter(Boolean))]
    const ex = new Map<string, { id: string; v: string }>()
    const fo = new Map<string, { id: string; v: string }>()
    byExact.set(field, ex)
    byFold.set(field, fo)
    if (values.length === 0) continue
    try {
      for (const r of await fetch(field, 'exact', values)) {
        if (r.v == null) continue
        const k = exactKey(String(r.v))
        if (!ex.has(k)) ex.set(k, { id: String(r.id), v: String(r.v) })
      }
      if (cfg.close) {
        const keys = [
          ...new Set(values.map(sqlFoldValue).filter((k) => k.length >= MIN_VALUE_LENGTH))
        ]
        if (keys.length)
          for (const r of await fetch(field, 'fold', keys)) {
            if (r.v == null) continue
            const k = foldKey(String(r.v))
            if (!fo.has(k)) fo.set(k, { id: String(r.id), v: String(r.v) })
          }
      }
    } catch {
      // The preview still answers; this field just is not checked.
    }
  }
  const seen = new Map<string, Map<string, { row: number; value: string }>>()
  for (const field of fields) seen.set(field, new Map())
  for (const r of rows) {
    let found: ImportDuplicateRow | null = null
    for (const field of fields) {
      const value = textOf(r.values[field])
      if (!value) continue
      const key = foldKey(value) || exactKey(value)
      const ex = byExact.get(field)?.get(exactKey(value))
      const fo =
        cfg.close && foldKey(value).length >= MIN_VALUE_LENGTH
          ? byFold.get(field)?.get(foldKey(value))
          : undefined
      const prior = seen.get(field)?.get(key)
      if (ex)
        found = {
          row: r.row,
          field,
          value,
          match: 'exact',
          existing_id: ex.id,
          existing_value: ex.v
        }
      else if (fo)
        found = {
          row: r.row,
          field,
          value,
          match: 'close',
          existing_id: fo.id,
          existing_value: fo.v
        }
      else if (prior != null)
        found = {
          row: r.row,
          field,
          value,
          match: exactKey(value) === exactKey(prior.value) ? 'exact' : 'close',
          first_row: prior.row
        }
      if (!seen.get(field)?.has(key)) seen.get(field)?.set(key, { row: r.row, value })
      if (found) break
    }
    if (!found) continue
    if (found.first_row != null) summary.in_file_rows++
    else if (found.match === 'exact') summary.exact_rows++
    else summary.close_rows++
    if (summary.rows.length < 50) summary.rows.push(found)
  }
  return summary
}
