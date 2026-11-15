import type { FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import type { CMSField, CMSRelation, User } from '../types.js'
import { logActivity } from './activity.js'
import { getCollection, getFields, getRelations } from './collections.js'
import { selectInChunks, whereInList } from './db-batch.js'
import {
  assertNotEditLocked,
  EDIT_LOCKED,
  EditLockedError,
  recordWriteRefusal
} from './edit-lock.js'
import { can, getAllowedFields } from './permissions.js'

/**
 * Split a record's lines into a new record (idea 4, 2026-11-14).
 *
 * A person ticks some lines of a record's line grid and chooses "Move to a new
 * record": a new record of the same collection is created with the header
 * copied (the same copy rules as More → Duplicate), the ticked lines are MOVED
 * onto it (re-parented, not copied — each line keeps its id and its history)
 * and both records name each other in their Notes thread and history.
 *
 * Off everywhere until an admin turns it on per collection, in
 * `nivaro_collections.browser_config.line_split` (Data Model → Settings →
 * Split lines; the browser_config bag keeps keys other cards do not edit):
 *
 *   { enabled: true,
 *     relations: ['<child collection>.<link field>'],   // the line grids that may split
 *     skip_fields?: ['partner_status'],                 // header fields that never copy
 *     link_field?: 'split_from',                        // a link on the record set to the source
 *     copy_links?: true }                               // copy many-to-many link sets (default)
 *
 * One request: the new record is created with its lines in the same write
 * (`{<lines alias>: {move: [ids]}}` — the nested one-to-many write in
 * services/items.ts), so a refused line undoes the whole thing and nothing is
 * left behind. The record starts its pipeline like any create (the after-create
 * hooks run once the lines are on it).
 */

export const SPLIT_OUT = 'split-out'
export const SPLIT_IN = 'split-in'
/** Most lines one split may move (the nested-write row cap). */
export const SPLIT_MAX_LINES = 500

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/
const RELATION_KEY = /^[A-Za-z_][A-Za-z0-9_]*\.[A-Za-z_][A-Za-z0-9_]*$/

export interface LineSplitConfig {
  /** `<child collection>.<link field>` keys of the line relations that may split. */
  relations: string[]
  /** Header fields that never copy (partner statuses, external numbers). */
  skip_fields: string[]
  /** A link field on the collection set to the source record on the new one. */
  link_field: string | null
  /** Copy many-to-many link sets (zones, years, people). Default true. */
  copy_links: boolean
}

function parseObj(raw: unknown): Record<string, unknown> | null {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>
  if (typeof raw !== 'string' || raw.trim() === '') return null
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function identList(raw: unknown, re: RegExp, cap: number): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const v of raw) {
    const s = typeof v === 'string' ? v.trim() : ''
    if (re.test(s) && !out.includes(s)) out.push(s)
    if (out.length >= cap) break
  }
  return out
}

/** The collection's split config, or null when splitting is off (the default). */
export function parseLineSplitConfig(browserConfig: unknown): LineSplitConfig | null {
  const bc = parseObj(browserConfig)
  const raw = parseObj(bc?.line_split)
  if (raw?.enabled !== true) return null
  const relations = identList(raw.relations, RELATION_KEY, 10)
  if (relations.length === 0) return null
  const link = typeof raw.link_field === 'string' ? raw.link_field.trim() : ''
  return {
    relations,
    skip_fields: identList(raw.skip_fields, IDENT, 100),
    link_field: IDENT.test(link) && link !== 'id' ? link : null,
    copy_links: raw.copy_links !== false
  }
}

/** Audit / identity columns a copy never carries (the Duplicate twin's AUDIT set). */
export const SPLIT_AUDIT_FIELDS = new Set([
  'id',
  'user_created',
  'date_created',
  'user_updated',
  'date_updated',
  'created_at',
  'updated_at',
  'created',
  'changed',
  'creator',
  'last_state_change'
])

const AUDIT_SPECIALS = new Set(['user-created', 'date-created', 'user-updated', 'date-updated'])
const ALIAS_SPECIALS = new Set(['o2m', 'm2m', 'm2a', 'files', 'file', 'alias', 'translations'])

type FieldMeta = Pick<CMSField, 'field'> &
  Partial<Pick<CMSField, 'hidden' | 'readonly' | 'special' | 'options' | 'computed_type' | 'type'>>

function optionsOf(f: FieldMeta): Record<string, unknown> {
  return parseObj(f.options) ?? {}
}

/** A field marked "do not duplicate" (the Duplicate twin's isNoDuplicate). */
export function isNoDuplicateField(f: FieldMeta): boolean {
  return !!optionsOf(f).no_duplicate
}

/**
 * Why a header field does NOT copy onto the new record, or null when it does.
 * The server twin of More → Duplicate's rules (packages/shared ItemEditForm):
 * only fields people see and type copy — never the id, audit stamps, generated
 * ids (they regenerate), calculated values, hidden columns (integration and
 * system state: external ids, status mirrors), read-only or "do not duplicate"
 * fields, link lists, and whatever the split config or the collection names.
 */
export function splitSkipReason(f: FieldMeta, skip: ReadonlySet<string>): string | null {
  const special = (f.special ?? []).map(String)
  if (SPLIT_AUDIT_FIELDS.has(f.field) || special.some((s) => AUDIT_SPECIALS.has(s))) return 'audit'
  if (skip.has(f.field)) return 'skipped'
  if (special.some((s) => ALIAS_SPECIALS.has(s)) || f.type === 'alias') return 'list'
  if (f.hidden) return 'hidden'
  if (f.readonly) return 'read-only'
  if (f.computed_type) return 'calculated'
  const opts = optionsOf(f)
  if (opts.auto_id) return 'generated'
  if (opts.no_duplicate) return 'do-not-duplicate'
  return null
}

/** The header values a split copies from `row` (plain values only). */
export function splitHeaderValues(
  row: Record<string, unknown>,
  fields: FieldMeta[],
  skip: ReadonlySet<string>
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const f of fields) {
    if (splitSkipReason(f, skip)) continue
    const v = row[f.field]
    if (v === undefined || v === null || v === '') continue
    if (typeof v === 'object' && !(v instanceof Date)) continue
    out[f.field] = v
  }
  return out
}

/**
 * The caller's own header values (a different warehouse on the new record):
 * only fields the copy itself could carry — a person cannot use a split to
 * write a read-only, generated or hidden field.
 */
export function splitOverrideValues(
  values: unknown,
  fields: FieldMeta[],
  skip: ReadonlySet<string>
): Record<string, unknown> {
  const src = parseObj(values)
  if (!src) return {}
  const byName = new Map(fields.map((f) => [f.field, f]))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(src)) {
    const f = byName.get(k)
    if (!f || splitSkipReason(f, skip)) continue
    if (v !== null && typeof v === 'object') continue
    out[k] = v
  }
  return out
}

/** A refusal said in plain words, with the status and code the route answers. */
export class SplitRefusal extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
    public extra: Record<string, unknown> = {}
  ) {
    super(message)
    this.name = 'SplitRefusal'
  }
}

/** The line relation behind a config key, or null when it no longer exists. */
export function findLineRelation(
  rels: CMSRelation[],
  collection: string,
  key: string
): (CMSRelation & { one_field: string }) | null {
  const [child, fk] = key.split('.')
  const r = rels.find(
    (x) =>
      x.one_collection === collection &&
      x.many_collection === child &&
      x.many_field === fk &&
      x.junction_field == null &&
      !!x.one_field
  )
  return (r as (CMSRelation & { one_field: string }) | undefined) ?? null
}

/** Ids as one list: strings or numbers, de-duplicated case-blind, empties dropped. */
export function normalizeLineIds(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const seen = new Map<string, string>()
  for (const v of raw) {
    const id =
      typeof v === 'number' || typeof v === 'string'
        ? String(v).trim()
        : v && typeof v === 'object' && 'id' in v
          ? String((v as { id: unknown }).id ?? '').trim()
          : ''
    if (id && !seen.has(id.toLowerCase())) seen.set(id.toLowerCase(), id)
  }
  return [...seen.values()]
}

/**
 * The lines a split may move: every id is a row of THIS record, and at least
 * one row stays behind. Pure — the route reads the rows.
 */
export function judgeLineSelection(
  sourceId: string | number,
  picked: string[],
  rows: Array<{ id: unknown; parent: unknown }>,
  totalOnRecord: number
): SplitRefusal | null {
  if (picked.length === 0)
    return new SplitRefusal(400, 'SPLIT_NO_LINES', 'Pick at least one line to move.')
  if (picked.length > SPLIT_MAX_LINES)
    return new SplitRefusal(
      400,
      'SPLIT_TOO_MANY',
      `At most ${SPLIT_MAX_LINES} lines can move in one split.`
    )
  const byId = new Map(rows.map((r) => [String(r.id).toLowerCase(), r]))
  const src = String(sourceId).toLowerCase()
  const foreign = picked.filter((id) => {
    const r = byId.get(id.toLowerCase())
    return !r || String(r.parent ?? '').toLowerCase() !== src
  })
  if (foreign.length > 0)
    return new SplitRefusal(
      422,
      'SPLIT_LINE_NOT_ON_RECORD',
      foreign.length === 1
        ? 'One of the picked lines is no longer on this record. Refresh and try again.'
        : `${foreign.length} of the picked lines are no longer on this record. Refresh and try again.`,
      { lines: foreign }
    )
  if (picked.length >= totalOnRecord)
    return new SplitRefusal(
      422,
      'SPLIT_KEEP_ONE',
      'Leave at least one line on this record. To move every line, duplicate the record instead.'
    )
  return null
}

interface SplitBody {
  relation?: unknown
  line_ids?: unknown
  values?: unknown
}

export interface SplitResult {
  id: string | number
  readable: boolean
  moved: number
  relation: string
  field: string
  link_failures: string[]
}

async function bindingStateFields(collection: string): Promise<string[]> {
  try {
    const rows = (await db('nivaro_workflow_bindings')
      .where({ collection })
      .select('state_field')) as Array<{ state_field: string | null }>
    return rows.map((r) => r.state_field).filter((f): f is string => !!f)
  } catch {
    return []
  }
}

function listOf(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String)
  if (typeof raw === 'string' && raw.trim().startsWith('[')) {
    try {
      const v = JSON.parse(raw)
      return Array.isArray(v) ? v.map(String) : []
    } catch {
      return []
    }
  }
  return []
}

/**
 * The many-to-many link sets the new record starts with (zones, funding years,
 * people), as the alias payload the items service writes. Files never copy, nor
 * a list the caller may not read or the collection marks "do not duplicate".
 */
async function linkSetsToCopy(
  user: User,
  collection: string,
  id: string | number,
  rels: CMSRelation[],
  fields: FieldMeta[],
  skip: ReadonlySet<string>
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  const readable = await getAllowedFields(user, 'read', collection).catch(() => null)
  const mayRead = (f: string) => !readable || readable.includes('*') || readable.includes(f)
  const byName = new Map(fields.map((f) => [f.field, f]))
  for (const r of rels) {
    if (r.one_collection !== collection || !r.one_field || r.junction_field == null) continue
    const alias = r.one_field
    const meta = byName.get(alias)
    if (skip.has(alias) || !mayRead(alias)) continue
    if (meta && (meta.hidden || meta.readonly || isNoDuplicateField(meta))) continue
    if (meta?.special?.some((s) => s === 'files' || s === 'file')) continue
    const jf = String(r.junction_field)
    const companion = rels.find(
      (c) => c.many_collection === r.many_collection && c.many_field === jf && c !== r
    )
    const target = companion?.one_collection ?? null
    if (
      /_files$/i.test(r.many_collection) ||
      target === 'nivaro_files' ||
      target === 'directus_files'
    )
      continue
    if (!IDENT.test(r.many_collection) || !IDENT.test(r.many_field) || !IDENT.test(jf)) continue
    const polymorphic = !!(r.one_allowed_collections ?? companion?.one_allowed_collections)
    const disc = polymorphic
      ? String(r.one_collection_field || companion?.one_collection_field || 'collection')
      : null
    if (disc && !IDENT.test(disc)) continue
    try {
      const rows = (await db(r.many_collection)
        .where(r.many_field, id)
        .whereNotNull(jf)
        .limit(SPLIT_MAX_LINES)
        .select(disc ? [jf, disc] : [jf])) as Array<Record<string, unknown>>
      if (rows.length === 0) continue
      out[alias] = disc
        ? rows.map((x) => ({ collection: String(x[disc] ?? ''), id: x[jf] }))
        : rows.map((x) => x[jf])
    } catch {
      /* a link table that cannot be read just does not copy */
    }
  }
  return out
}

/**
 * Split `lineIds` of record `id` into a new record. Judged as the caller:
 * they read the record, may change it (update row filter, User Scopes, the
 * person-held edit lock, the approval locks) and may create in the
 * collection; each line is moved through the items service as them.
 */
export async function splitRecord(
  req: FastifyRequest,
  collection: string,
  id: string,
  body: SplitBody
): Promise<SplitResult> {
  const user = req.user
  if (!user) throw new SplitRefusal(401, 'UNAUTHENTICATED', 'Sign in to split a record.')
  if (!IDENT.test(collection) || /^(nivaro_|directus_)/i.test(collection))
    throw new SplitRefusal(404, 'NOT_FOUND', 'Not found')
  const workspaceId = req.workspaceId ?? undefined
  const col = await getCollection(collection)
  if (!col) throw new SplitRefusal(404, 'NOT_FOUND', 'Not found')
  const cfg = parseLineSplitConfig((col as { browser_config?: unknown }).browser_config)
  if (!cfg)
    throw new SplitRefusal(
      404,
      'SPLIT_OFF',
      'Moving lines to a new record is not turned on for this kind of record.'
    )
  const relationKey = typeof body.relation === 'string' ? body.relation.trim() : ''
  if (!cfg.relations.includes(relationKey))
    throw new SplitRefusal(400, 'SPLIT_RELATION', 'These lines cannot be moved to a new record.')
  const rels = await getRelations(collection)
  const rel = findLineRelation(rels, collection, relationKey)
  if (!rel)
    throw new SplitRefusal(
      400,
      'SPLIT_RELATION',
      'These lines cannot be moved to a new record: the line list is no longer set up.'
    )
  const child = rel.many_collection
  const fk = rel.many_field
  const alias = rel.one_field

  // The record, as the caller reads it (invisible = 404, Restrict scopes bind admins too).
  const items = await import('./items.js')
  let source: Record<string, unknown> | null = null
  try {
    source = (await items.readOne(user, collection, id, workspaceId)) as Record<
      string,
      unknown
    > | null
  } catch (err) {
    if (err instanceof items.ForbiddenError)
      throw new SplitRefusal(403, 'FORBIDDEN', 'You do not have access to this record.')
    throw new SplitRefusal(404, 'NOT_FOUND', 'Not found')
  }
  if (!source) throw new SplitRefusal(404, 'NOT_FOUND', 'Not found')

  // Changing it: update row filter, person-held edit lock, approval locks.
  const refused = await recordWriteRefusal(req, collection, id)
  if (refused) {
    const why = refused.body as { error?: string; code?: string }
    throw new SplitRefusal(
      refused.status,
      why.code ?? (refused.status === 404 ? 'NOT_FOUND' : 'FORBIDDEN'),
      refused.status === 403 && !why.code
        ? 'You cannot change this record, so its lines cannot be moved.'
        : (why.error ?? 'This record cannot be changed right now.'),
      refused.body.locked_by ? { locked_by: refused.body.locked_by } : {}
    )
  }
  if (!(await can(user, 'create', collection)))
    throw new SplitRefusal(
      403,
      'FORBIDDEN',
      'You cannot create records here, so lines cannot be moved to a new one.'
    )
  if (!(await can(user, 'update', child)))
    throw new SplitRefusal(403, 'FORBIDDEN', 'You cannot change these lines.')

  // The lines: all of them rows of THIS record, one stays behind.
  const picked = normalizeLineIds(body.line_ids)
  const rows = picked.length
    ? ((await selectInChunks<Record<string, unknown>, string>(picked, 1000, (chunk) =>
        whereInList(db(child), 'id', chunk).select('id', `${fk} as parent`)
      )) as Array<{ id: unknown; parent: unknown }>)
    : []
  const totalRow = (await db(child).where(fk, id).count({ n: '*' }).first()) as
    | { n: number | string }
    | undefined
  const bad = judgeLineSelection(id, picked, rows, Number(totalRow?.n ?? 0))
  if (bad) throw bad
  for (const lineId of picked) {
    if (!(await items.canUpdateItem(user, child, lineId, workspaceId)))
      throw new SplitRefusal(
        403,
        'FORBIDDEN',
        'You cannot change one of the picked lines, so nothing was moved.',
        { line: lineId }
      )
  }
  // The lines' own locks (a record's listed child rows lock with it), said
  // before anything is created.
  try {
    await assertNotEditLocked(user, child, { ids: picked, payload: { [fk]: id } }, req)
  } catch (err) {
    if (err instanceof EditLockedError) throw new SplitRefusal(403, EDIT_LOCKED, err.message)
    const e = err as { statusCode?: number; code?: string; message?: string }
    if (e?.code === 'RECORD_LOCKED')
      throw new SplitRefusal(409, 'RECORD_LOCKED', e.message ?? 'Someone else is editing this.')
    throw err
  }

  // The header, copied by the Duplicate rules.
  const fields = (await getFields(collection)) as FieldMeta[]
  const skip = new Set<string>([
    ...cfg.skip_fields,
    ...(await bindingStateFields(collection)),
    ...listOf((col as { upsert_keys?: unknown }).upsert_keys).map((k) => k.replace(/\?$/, '')),
    ...[(col as { slug_field?: string | null }).slug_field].filter((f): f is string => !!f),
    alias
  ])
  if (cfg.link_field) skip.add(cfg.link_field)
  const header: Record<string, unknown> = {
    ...splitHeaderValues(source, fields, skip),
    ...splitOverrideValues(body.values, fields, skip)
  }
  if (cfg.link_field && fields.some((f) => f.field === cfg.link_field))
    header[cfg.link_field] = source.id ?? id
  const links = cfg.copy_links ? await linkSetsToCopy(user, collection, id, rels, fields, skip) : {}

  // One write: the record, its link sets and the moved lines.
  const outcome: import('./items.js').CreateOutcome = {}
  let created: Record<string, unknown> | null
  try {
    created = (await items.createOne(
      user,
      collection,
      { ...header, ...links, [alias]: { move: picked } },
      req,
      workspaceId,
      { outcome, scopeGuard: true }
    )) as Record<string, unknown> | null
  } catch (err) {
    if (err instanceof items.ForbiddenError)
      throw new SplitRefusal(403, 'FORBIDDEN', 'You cannot create this record.')
    throw err
  }
  const newId = (created?.id as string | number | undefined) ?? outcome.id
  if (newId == null) throw new Error('The new record was created without an id')
  const readable = !!created && !items.isOutOfView(created)

  // Both records name each other (Notes thread + history). The text is built
  // when read, as the reader, so neither record's name leaks into the log.
  const n = picked.length
  await logActivity({
    action: SPLIT_OUT,
    user: user.id,
    collection,
    item: String(id),
    comment: JSON.stringify({ to: String(newId), field: alias, lines: n }),
    origin: 'person',
    req
  })
  await logActivity({
    action: SPLIT_IN,
    user: user.id,
    collection,
    item: String(newId),
    comment: JSON.stringify({ from: String(id), field: alias, lines: n }),
    origin: 'person',
    req
  })

  return {
    id: newId,
    readable,
    moved: n,
    relation: relationKey,
    field: alias,
    link_failures: outcome.linkFailures ?? []
  }
}

/** A split activity row's comment, read back. */
export function parseSplitComment(
  action: string,
  comment: unknown
): { other: string; lines: number; direction: 'out' | 'in' } | null {
  if (action !== SPLIT_OUT && action !== SPLIT_IN) return null
  const c = parseObj(comment)
  if (!c) return null
  const other = String((action === SPLIT_OUT ? c.to : c.from) ?? '').trim()
  if (!other) return null
  const lines = Number(c.lines)
  return {
    other,
    lines: Number.isFinite(lines) && lines > 0 ? Math.floor(lines) : 0,
    direction: action === SPLIT_OUT ? 'out' : 'in'
  }
}

/** The sentence a split says on its record's Notes thread. */
export function splitNoteText(p: { direction: 'out' | 'in'; lines: number }): string {
  const what = p.lines > 0 ? `${p.lines} ${p.lines === 1 ? 'line' : 'lines'}` : 'lines'
  return p.direction === 'out'
    ? `Moved ${what} to a new record`
    : `Created from another record — ${what} moved here`
}
