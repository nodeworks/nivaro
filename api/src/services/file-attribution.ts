import { db } from '../db/index.js'
import { runInBackgroundPool } from '../db/pool-context.js'
import {
  CONFIG_FILE_TABLES,
  extractFileIds,
  type FileRefMeta,
  fileRefSources,
  fileRefTables
} from './config-review/pure.js'
import { isSystemCollection } from './system-collections.js'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * Where a file is used WITHOUT a foreign key, and so whose say decides who may
 * read it (army v3 round 2). file-access.ts asks this module only for files no
 * FK-linked record grants; a file nothing here names either reads for its
 * uploader and administrators only.
 *
 *  - a chat message's attachments (not deleted) → the room (canSeeRoom)
 *  - a support ticket's attachments → the ticket (canSeeTicket)
 *  - an addendum's attachments → its parent record
 *  - a comment that links the file → its record
 *  - a screen clip's poster (`poster:<id>` tag on the clip file) → the clip
 *  - rich text, legacy file columns and `*file*` uuid columns on registered
 *    business collections → that record (a junction leg → its parent record)
 *  - configuration (settings, pages, dashboards, widgets, templates, forms,
 *    layouts …) and a person's own avatar → anyone signed in, as before
 *
 * A use is only as good as whoever wrote it — anyone can paste a file id into
 * their own comment, rich text or avatar. Write paths refuse an id the writer
 * cannot read (file-access.ts unreadableFileIds); as defence in depth each use
 * here also carries `by` — the row's LAST writer (user_updated / updated_by /
 * changed_by / modified_by when the table has one, else its creator) — and a
 * `trust`: `table` (a table only administrators write: counts as is),
 * `author` (counts when `by` uploaded the file, or when every id in `adminIf`
 * is an administrator — set only where no non-admin can have edited the row
 * since) or `owner` (an avatar: only when that person uploaded the file). A
 * use whose writer is unknown never counts. file-access.ts applies that, and
 * asks here only for files with no FK reference at all.
 *
 * Two per-tenant indexes answer this without a scan per request: `live` (the
 * JSON attachment lists, comments and clip posters) and `content` (rich text,
 * business file columns and configuration — a few seconds to build). Both are
 * served stale while a rebuild runs (5 minutes), built on the background pool.
 * A file uploaded after an index was built may be missing from it, so for
 * such a file the live sources are asked directly (one LIKE per source, for
 * that file) and the content index is rebuilt once (at most every 30 s).
 */

export type AttributionTrust = 'table' | 'author' | 'owner'

export type FileAttribution = (
  | { kind: 'record'; collection: string; id: string }
  | { kind: 'room'; room: string }
  | { kind: 'ticket'; id: number }
  | { kind: 'poster'; of: string }
  | { kind: 'shared' }
) & {
  /** Upper-cased user id of whoever last wrote the use (null = unknown). */
  by: string | null
  trust: AttributionTrust
  /** The writers who must ALL be administrators for an admin's use to count
   *  (null = that can't be told, so it never counts on admin trust alone). */
  adminIf: string[] | null
}

/** Upper-cased file id → where it is used; `failed` names sources that could
 *  not be read (so what they would have said is unknown). */
type Index = Map<string, FileAttribution[]> & { failed?: Set<string> }

/** fileAttributions' answer: `incomplete` names sources that could not be read. */
export type FileAttributionMap = Map<string, FileAttribution[]> & { incomplete: Set<string> }

interface Unit {
  index: Index | null
  /** When the build behind `index` started (ms). */
  started: number
  building: Promise<void> | null
}

const TTL_MS = 5 * 60_000
/** A file uploaded this long before a build started may still be missing from it. */
const RECENT_SLACK_MS = 2 * 60_000
const CONTENT_REBUILD_GAP_MS = 30_000
const LOOKUP_TTL_MS = 20_000
const LOOKUP_CHUNK = 10
const MAX_TENANTS = 200

interface TenantState {
  live: Unit
  content: Unit
  lookups: Map<string, { at: number; attrs: FileAttribution[] }>
  admins: Map<string, { at: number; admin: boolean }>
  touched: number
}

const tenants = new Map<string, TenantState>()

function state(): TenantState {
  const key = currentTenantKey()
  let s = tenants.get(key)
  if (!s) {
    if (tenants.size >= MAX_TENANTS) {
      const oldest = [...tenants.entries()].sort((a, b) => a[1].touched - b[1].touched)[0]
      if (oldest) tenants.delete(oldest[0])
    }
    s = {
      live: { index: null, started: 0, building: null },
      content: { index: null, started: 0, building: null },
      lookups: new Map(),
      admins: new Map(),
      touched: Date.now()
    }
    tenants.set(key, s)
  }
  s.touched = Date.now()
  return s
}

/** Test seam: forget every index. */
export function forgetFileAttributions(): void {
  tenants.clear()
}

const authorOf = (v: unknown): string | null =>
  v == null || v === '' ? null : String(v).toUpperCase()
/** A row only its author (or an administrator) can have written. */
const byAuthor = (v: unknown) => {
  const by = authorOf(v)
  return { by, trust: 'author' as const, adminIf: by ? [by] : null }
}

function same(a: FileAttribution, b: FileAttribution): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function addTo(index: Index, fileId: string, attr: FileAttribution): void {
  const k = fileId.toUpperCase()
  const list = index.get(k) ?? []
  if (!list.some((x) => same(x, attr))) list.push(attr)
  index.set(k, list)
}

/** Every file id a value names (JSON list, URL, bare id). */
function idsIn(value: unknown): string[] {
  return [...extractFileIds(value)]
}

/** A table or column this tenant has not migrated: nothing is stored there. */
const NOT_THERE = /invalid (object|column) name|no such (table|column)|does not exist/i

/**
 * Run one read. Building the query happens inside the guard too, so nothing
 * here ever throws: a table or column this tenant has not migrated reads as
 * empty, and any other failure reads as empty AND is reported through
 * `onFail` (the caller then treats that source as unknown, never as clean).
 */
async function rows<T>(build: () => unknown, onFail?: () => void): Promise<T[]> {
  try {
    const out = await build()
    return Array.isArray(out) ? (out as T[]) : []
  } catch (err) {
    if (!NOT_THERE.test(String((err as Error)?.message ?? ''))) onFail?.()
    return []
  }
}

// ─── live: attachment lists, comments, clip posters ─────────────────────────

type LiveRow = Record<string, unknown>

/** Narrow a live query to rows naming one of `only` (the per-file lookup). */
function naming(q: any, column: string, only: string[] | undefined, prefix = '') {
  if (!only) return q
  return q.where((w: any) => {
    for (const id of only) w.orWhere(column, 'like', `%${prefix}${id}%`)
  })
}

/** The live sources (built lazily); with `only`, just the rows naming those file ids. */
function liveQueries(only?: string[]) {
  return {
    chat: () =>
      naming(
        db('chat_messages').whereNotNull('attachments').whereNull('deleted_at'),
        'attachments',
        only
      ).select('room', 'sender', 'attachments'),
    tickets: () =>
      naming(db('nivaro_tasks').whereNotNull('attachments'), 'attachments', only).select(
        'id',
        'created_by',
        'attachments'
      ),
    addendums: () =>
      naming(db('nivaro_addendums').whereNotNull('attachments'), 'attachments', only).select(
        'parent_collection',
        'parent_id',
        'created_by',
        'attachments'
      ),
    comments: () =>
      naming(
        db('nivaro_comments')
          .whereNull('deleted_at')
          .where((w: any) =>
            w.where('text', 'like', '%files/%').orWhere('text', 'like', '%assets/%')
          ),
        'text',
        only
      ).select('collection', 'item', 'user', 'text'),
    posters: () =>
      naming(db('nivaro_files').where('tags', 'like', '%poster:%'), 'tags', only, 'poster:').select(
        'id',
        'uploaded_by',
        'tags'
      )
  }
}

async function readLive(only?: string[]): Promise<Index> {
  const index: Index = new Map()
  const failed = new Set<string>()
  index.failed = failed
  const q = liveQueries(only)
  const read = (name: keyof typeof q) => rows<LiveRow>(q[name], () => failed.add(name))
  const [chat, tickets, addendums, comments, posters] = await Promise.all([
    read('chat'),
    read('tickets'),
    read('addendums'),
    read('comments'),
    read('posters')
  ])
  for (const r of chat)
    for (const id of idsIn(r.attachments))
      addTo(index, id, { kind: 'room', room: String(r.room), ...byAuthor(r.sender) })
  for (const r of tickets)
    for (const id of idsIn(r.attachments))
      addTo(index, id, { kind: 'ticket', id: Number(r.id), ...byAuthor(r.created_by) })
  for (const r of addendums) {
    const collection = String(r.parent_collection ?? '')
    if (!collection || isSystemCollection(collection) || r.parent_id == null) continue
    for (const id of idsIn(r.attachments))
      addTo(index, id, {
        kind: 'record',
        collection,
        id: String(r.parent_id),
        ...byAuthor(r.created_by)
      })
  }
  for (const r of comments) {
    const collection = String(r.collection ?? '')
    if (!collection || isSystemCollection(collection) || r.item == null) continue
    for (const id of idsIn(r.text))
      addTo(index, id, { kind: 'record', collection, id: String(r.item), ...byAuthor(r.user) })
  }
  for (const r of posters) {
    // Record editors may re-tag a clip, so who wrote the tag can't be told:
    // only the clip's uploader posting their own poster counts.
    for (const tag of String(r.tags ?? '').match(/poster:[0-9a-f-]{36}/gi) ?? [])
      addTo(index, tag.slice(7), {
        kind: 'poster',
        of: String(r.id),
        by: authorOf(r.uploaded_by),
        trust: 'author',
        adminIf: null
      })
  }
  if (only) {
    // A lookup answers for the files asked about, not for every id a matched row names.
    const asked = new Set(only.map((i) => i.toUpperCase()))
    for (const k of [...index.keys()]) if (!asked.has(k)) index.delete(k)
  }
  return index
}

// ─── content: rich text, business file columns, configuration ───────────────

/** Configuration read by everyone signed in (comments are records, not config). */
const SHARED_TABLES = new Set(
  [...CONFIG_FILE_TABLES, 'nivaro_users']
    .filter((t) => t !== 'nivaro_comments')
    .map((t) => t.toLowerCase())
)

/** Configuration only administrators write (every write route is requireAdmin):
 *  a file named there counts as shared as is. Any other table needs an author. */
const ADMIN_ONLY_TABLES = new Set([
  'nivaro_settings',
  'nivaro_settings_overrides',
  'nivaro_pages',
  'nivaro_pdf_templates',
  'nivaro_mail_templates',
  'nivaro_broadcast_templates',
  'nivaro_submission_forms',
  'nivaro_workspaces',
  'nivaro_workspace_templates'
])

/** The columns that say who wrote a row, first match wins. */
const AUTHOR_COLUMNS = ['user_created', 'created_by', 'creator', 'uploaded_by']
/** The columns that say who last changed a row, first match wins. */
const MODIFIER_COLUMNS = ['user_updated', 'updated_by', 'changed_by', 'modified_by']

interface RecordSite {
  /** The collection a matching row stands for, and the column holding its id. */
  record: string
  recordColumn: string
}

type Relation = FileRefMeta['relations'][number]

/** recordSite over relation rows already read (`registered` = collection names). */
function siteFrom(
  table: string,
  column: string,
  registered: (t: string) => boolean,
  relations: Relation[]
): RecordSite | undefined {
  if (isSystemCollection(table) || !registered(table)) return undefined
  const rels = relations.filter((r) => r.many_collection === table)
  const leg = rels.find(
    (r) => String(r.many_field).toLowerCase() === column.toLowerCase() && r.junction_field
  )
  if (!leg) return { record: table, recordColumn: 'id' }
  const parent = rels.find((r) => r.many_field === leg.junction_field)
  if (!parent?.one_collection || isSystemCollection(parent.one_collection)) return undefined
  return { record: parent.one_collection, recordColumn: String(leg.junction_field) }
}

/**
 * The record a row of `table` stands for when `column` names a file: the row
 * itself, or — for a junction leg (nivaro_relations row with junction_field) —
 * the parent record the junction links. Undefined = not a registered business
 * collection (system and extension tables answer nothing here).
 */
export async function recordSite(table: string, column: string): Promise<RecordSite | undefined> {
  if (isSystemCollection(table)) return undefined
  const { getCollection, getRelations } = await import('./collections.js')
  if (!(await getCollection(table).catch(() => undefined))) return undefined
  const rels = (await getRelations(table).catch(() => [])) as Relation[]
  return siteFrom(table, column, () => true, rels)
}

async function loadRefMeta(): Promise<FileRefMeta> {
  const { getFileRefColumns } = await import('./file-usage.js')
  const [fkRefs, relations, fields] = await Promise.all([
    getFileRefColumns().catch(() => []),
    rows<FileRefMeta['relations'][number]>(() =>
      db('nivaro_relations').select(
        'many_collection',
        'many_field',
        'one_collection',
        'one_field',
        'junction_field'
      )
    ),
    rows<FileRefMeta['fields'][number]>(() =>
      db('nivaro_fields').select('collection', 'field', 'interface', 'special')
    )
  ])
  const tables = fileRefTables({ relations, fields })
  const columns: FileRefMeta['columns'] = []
  const push = (list: Array<{ table_name: string; column_name: string; data_type: string }>) => {
    for (const r of list)
      columns.push({ table: r.table_name, column: r.column_name, data_type: r.data_type })
  }
  for (let i = 0; i < tables.length; i += 500)
    push(
      await rows(() =>
        db('information_schema.columns')
          .whereIn('table_name', tables.slice(i, i + 500))
          .select('table_name', 'column_name', 'data_type')
      )
    )
  push(
    await rows(() =>
      db('information_schema.columns')
        .where('data_type', 'uniqueidentifier')
        .where('column_name', 'like', '%file%')
        .select('table_name', 'column_name', 'data_type')
    )
  )
  return { fkRefs, relations, fields, columns }
}

/** Sources the live index (or nobody) answers for — never read as content. */
const LIVE_OR_PRIVATE = new Set([
  'chat_messages',
  'nivaro_chat_scheduled',
  'nivaro_chat_message_history',
  'nivaro_tasks',
  'nivaro_addendums',
  'nivaro_comments',
  'nivaro_import_queue',
  'nivaro_ai_autofill_events'
])

/** Tables read at once while building the content index (background pool). */
const CONTENT_CONCURRENCY = 4

async function readContent(): Promise<Index> {
  const index: Index = new Map()
  const [meta, collections] = await Promise.all([
    loadRefMeta(),
    rows<{ collection: string }>(() => db('nivaro_collections').select('collection'))
  ])
  const registered = new Set(collections.map((c) => String(c.collection).toLowerCase()))
  const isRegistered = (t: string) => registered.has(t.toLowerCase())
  const types = new Map(
    meta.columns.map((c) => [`${c.table}.${c.column}`.toLowerCase(), c.data_type.toLowerCase()])
  )
  const sources = fileRefSources(meta)
  // One read per table: every source column of it, url-only columns filtered.
  const byTable = new Map<string, typeof sources>()
  for (const s of sources) {
    const t = s.table.toLowerCase()
    if (LIVE_OR_PRIVATE.has(t) || /^nivaro_help_video/.test(t)) continue
    byTable.set(s.table, [...(byTable.get(s.table) ?? []), s])
  }
  const readTable = async (table: string, list: typeof sources) => {
    const lower = table.toLowerCase()
    const shared = SHARED_TABLES.has(lower)
    // Who wrote a row: an admin-only table needs no author; an avatar is its
    // own person's; anything else needs an author column, or it counts for nothing.
    const trust: AttributionTrust =
      lower === 'nivaro_users' ? 'owner' : ADMIN_ONLY_TABLES.has(lower) ? 'table' : 'author'
    const authorColumn =
      trust === 'owner'
        ? 'id'
        : trust === 'author'
          ? AUTHOR_COLUMNS.find((c) => types.has(`${lower}.${c}`))
          : undefined
    if (trust !== 'table' && !authorColumn) return
    const modifierColumn =
      trust === 'author' ? MODIFIER_COLUMNS.find((c) => types.has(`${lower}.${c}`)) : undefined
    // Business rows map to a record; a column whose rows map nowhere is skipped.
    const sites = new Map<string, RecordSite>()
    if (!shared) {
      for (const s of list) {
        const site = siteFrom(table, s.column, isRegistered, meta.relations)
        if (site) sites.set(s.column, site)
      }
      if (sites.size === 0) return
    }
    // The author column itself holds a person, not a file.
    const cols = (shared ? list : list.filter((s) => sites.has(s.column))).filter(
      (s) =>
        trust === 'owner' ||
        ![authorColumn, modifierColumn].some((c) => c?.toLowerCase() === s.column.toLowerCase())
    )
    const keyCols = [...new Set([...sites.values()].map((s) => s.recordColumn))]
    const select: Record<string, string> = {}
    cols.forEach((s, i) => {
      select[`v${i}`] = s.column
    })
    keyCols.forEach((k, i) => {
      select[`k${i}`] = k
    })
    if (authorColumn) select.a0 = authorColumn
    if (modifierColumn) select.m0 = modifierColumn
    const found = await rows<Record<string, unknown>>(() =>
      db(table)
        .where((w: any) => {
          for (const s of cols) {
            if (s.urlOnly)
              w.orWhere((u: any) =>
                u.where(s.column, 'like', '%files/%').orWhere(s.column, 'like', '%assets/%')
              )
            else if (
              s.mode === 'id' &&
              types.get(`${table}.${s.column}`.toLowerCase()) !== 'uniqueidentifier'
            )
              // An id column may hold an inline data: URI instead (avatars): never read those.
              w.orWhere((u: any) => u.whereNotNull(s.column).whereNot(s.column, 'like', 'data:%'))
            else w.orWhereNotNull(s.column)
          }
        })
        .select(select)
    )
    for (const row of found) {
      // Credit the last writer; admin trust only when creator and last writer
      // are known (a table with no modifier column can't tell who edited since).
      const creator = authorOf(row.a0)
      const modifier = modifierColumn ? authorOf(row.m0) : null
      const by = trust === 'table' ? null : (modifier ?? creator)
      const adminIf =
        trust === 'author' && modifierColumn && creator
          ? [...new Set([creator, ...(modifier ? [modifier] : [])])]
          : null
      const who = { by, trust, adminIf }
      cols.forEach((s, i) => {
        const ids = idsIn(row[`v${i}`])
        if (ids.length === 0) return
        if (shared) {
          for (const id of ids) addTo(index, id, { kind: 'shared', ...who })
          return
        }
        const site = sites.get(s.column)
        const key = site ? row[`k${keyCols.indexOf(site.recordColumn)}`] : null
        if (!site || key == null) return
        for (const id of ids)
          addTo(index, id, { kind: 'record', collection: site.record, id: String(key), ...who })
      })
    }
  }
  const queue = [...byTable.entries()]
  const worker = async () => {
    for (let next = queue.shift(); next; next = queue.shift()) await readTable(next[0], next[1])
  }
  await Promise.all(Array.from({ length: CONTENT_CONCURRENCY }, worker))
  return index
}

// ─── the indexes ────────────────────────────────────────────────────────────

function rebuild(unit: Unit, read: () => Promise<Index>): Promise<void> {
  if (unit.building) return unit.building
  const started = Date.now()
  unit.building = runInBackgroundPool(async () => {
    try {
      const index = await read()
      unit.index = index
      unit.started = started
    } catch {
      // Keep serving the last index; the next stale read tries again.
    } finally {
      unit.building = null
    }
  })
  return unit.building
}

/** The unit's index: the stored one (rebuilt in the background once stale),
 *  or a fresh build when there is none yet. */
async function current(unit: Unit, read: () => Promise<Index>): Promise<Index> {
  if (!unit.index) await rebuild(unit, read)
  // Stale, or built while a source could not be read: refresh in the background.
  else if (
    Date.now() - unit.started > TTL_MS ||
    (unit.index.failed?.size && Date.now() - unit.started > CONTENT_REBUILD_GAP_MS)
  )
    void rebuild(unit, read)
  return unit.index ?? Object.assign(new Map(), { failed: new Set(['index']) })
}

function uploadedAt(v: unknown): number {
  if (v == null) return 0
  const t = new Date(v as string | Date).getTime()
  return Number.isFinite(t) ? t : 0
}

const isRecent = (file: { uploaded_on?: unknown }, unit: Unit) =>
  uploadedAt(file.uploaded_on) >= unit.started - RECENT_SLACK_MS

/** The live sources asked directly about these files (cached briefly, so a
 *  fresh chat image opened by a whole room costs one lookup). */
async function lookUpLive(s: TenantState, ids: string[]): Promise<Index> {
  const out: Index = new Map()
  const failed = new Set<string>()
  out.failed = failed
  const now = Date.now()
  const ask: string[] = []
  for (const id of ids) {
    const hit = s.lookups.get(id)
    if (hit && now - hit.at < LOOKUP_TTL_MS) {
      if (hit.attrs.length) out.set(id, hit.attrs)
    } else ask.push(id)
  }
  for (let i = 0; i < ask.length; i += LOOKUP_CHUNK) {
    const chunk = ask.slice(i, i + LOOKUP_CHUNK)
    const found = await readLive(chunk)
    for (const f of found.failed ?? []) failed.add(f)
    for (const id of chunk) {
      const attrs = found.get(id) ?? []
      // A lookup that could not read every source is not remembered.
      if (!found.failed?.size) s.lookups.set(id, { at: now, attrs })
      if (attrs.length) out.set(id, attrs)
    }
  }
  if (s.lookups.size > 5000)
    for (const [k, v] of s.lookups) if (now - v.at >= LOOKUP_TTL_MS) s.lookups.delete(k)
  return out
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Where each of these files is used without a foreign key (upper-cased id →
 * attributions; a file used nowhere is absent).
 */
export async function fileAttributions(
  files: Array<{ id: unknown; uploaded_on?: unknown }>
): Promise<FileAttributionMap> {
  const out: FileAttributionMap = Object.assign(new Map<string, FileAttribution[]>(), {
    incomplete: new Set<string>()
  })
  const list = files.filter((f) => UUID.test(String(f.id)))
  if (list.length === 0) return out
  const s = state()
  const merge = (id: string, attrs: FileAttribution[] | undefined) => {
    if (!attrs?.length) return
    const have = out.get(id) ?? []
    for (const a of attrs) if (!have.some((x) => same(x, a))) have.push(a)
    out.set(id, have)
  }
  const [live, content] = await Promise.all([
    current(s.live, () => readLive()),
    current(s.content, readContent)
  ])
  for (const name of [...(live.failed ?? []), ...(content.failed ?? [])]) out.incomplete.add(name)
  for (const f of list) {
    const id = String(f.id).toUpperCase()
    merge(id, live.get(id))
    merge(id, content.get(id))
  }
  // Files that may postdate the live index: ask its sources directly.
  const liveMiss = list.filter((f) => isRecent(f, s.live)).map((f) => String(f.id).toUpperCase())
  if (liveMiss.length > 0) {
    const looked = await lookUpLive(s, liveMiss)
    for (const name of looked.failed ?? []) out.incomplete.add(name)
    for (const [id, attrs] of looked) merge(id, attrs)
  }
  // A recent file still used nowhere may be in rich text or config saved after
  // the content index was built: rebuild it once (rate-limited) and look again.
  const unknown = list.filter((f) => !out.has(String(f.id).toUpperCase()) && isRecent(f, s.content))
  if (unknown.length > 0 && Date.now() - s.content.started > CONTENT_REBUILD_GAP_MS) {
    await rebuild(s.content, readContent)
    const fresh = s.content.index ?? new Map()
    for (const f of unknown) {
      const id = String(f.id).toUpperCase()
      merge(id, fresh.get(id))
    }
  }
  return out
}

const ADMIN_TTL_MS = 60_000

/** The upper-cased user ids (of those given) whose role has admin access —
 *  an administrator's use of any file counts. Cached per tenant for a minute. */
export async function adminAuthors(ids: string[]): Promise<Set<string>> {
  const out = new Set<string>()
  const s = state()
  const now = Date.now()
  const ask: string[] = []
  for (const id of new Set(ids.map((i) => i.toUpperCase()))) {
    const hit = s.admins.get(id)
    if (hit && now - hit.at < ADMIN_TTL_MS) {
      if (hit.admin) out.add(id)
    } else if (UUID.test(id)) ask.push(id)
  }
  if (ask.length > 0) {
    const found = await rows<{ id: unknown; admin_access: unknown }>(() =>
      db('nivaro_users as u')
        .join('nivaro_roles as r', 'r.id', 'u.role')
        .whereIn('u.id', ask)
        .select('u.id', 'r.admin_access')
    )
    const admins = new Set(
      found.filter((r) => !!r.admin_access).map((r) => String(r.id).toUpperCase())
    )
    for (const id of ask) {
      s.admins.set(id, { at: now, admin: admins.has(id) })
      if (admins.has(id)) out.add(id)
    }
  }
  return out
}
