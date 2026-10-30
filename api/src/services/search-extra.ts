import type { FastifyRequest } from 'fastify'
import type { Knex } from 'knex'
import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'
import type { User } from '../types.js'
import { hasFieldCommentColumns, recordCommentsOnly } from './field-comments.js'
import { excerpt, searchTerms } from './help-video-search-rank.js'
import { stripHtmlToText } from './latest-comment.js'
import { safeRecordLabel } from './record-label-fallback.js'
import type { SearchBudget } from './search-budget.js'
import { fastLike, onMssql, type TextKind, textKindOf } from './search-like.js'

/**
 * Global search's extra result kinds (search program 2026-10-28, items 15/17/18):
 * comments + record notes, file names, help videos, docs sections, chat
 * channels and — administrators only — configuration by name. Plus the people
 * extras (role, zones, title; "planners zone 3").
 *
 * Every hit is judged AS THE CALLER, by the gate its kind already has:
 * - comments / notes: the parent record (visibleRecordIds — role read, row
 *   filter, User Scopes); a hit on a record the caller cannot open is dropped.
 * - files: services/file-access.ts readableFileIds (a file follows where it
 *   is used) plus the private-render marker; help-video files never appear.
 * - help videos: searchHelpVideos (published + the library's visibility rule).
 * - docs: the docs index audience (admin sections for admins only).
 * - chat: canSeeRoom on the channel's room; channel NAMES only (never message
 *   text, never DMs or group DMs).
 * - config: admin-only config for administrators only (services/config-search);
 *   personal screens (Profile, subscriptions) for everyone.
 *
 * Bounded: each kind is a TOP-N query, gates run once per collection / per
 * batch, each kind is capped at EXTRA_CAP, and a failing kind is left out.
 */

export interface ExtraHit {
  kind: string
  id: string
  label: string
  snippet?: string
  /** efp-new path (`/records/:collection/:id…`). */
  href: string
  /** Admin path (`/collections/:collection/:id…`). */
  admin_href?: string
  collection?: string
  item?: string
}

export interface SearchExtra {
  comments?: ExtraHit[]
  files?: ExtraHit[]
  videos?: ExtraHit[]
  docs?: ExtraHit[]
  chat?: ExtraHit[]
  config?: ExtraHit[]
}

export type Caller = Pick<FastifyRequest, 'user' | 'isAdmin' | 'workspaceId'>

export const EXTRA_CAP = 8
/** Shorter queries match too much free text to be worth the scans. */
export const EXTRA_MIN_CHARS = 3
const RAW_CAP = 40

export function escapeLike(v: string): string {
  return v.replace(/[\\%_[]/g, (m) => `\\${m}`)
}

const likeOf = (phrase: string) => `%${escapeLike(phrase)}%`
const LIKE = `LIKE ? ESCAPE '\\'`

/** `col` contains the phrase, in the column's cheap LIKE form (services/search-like.ts). */
function containsRaw(colSql: string, phrase: string, kind: TextKind = 'unicode') {
  const l = fastLike(colSql, likeOf(phrase), kind, { escape: '\\', mssql: onMssql() })
  return { sql: l.sql, bindings: l.bindings }
}

/** How a kind's TOP-N statement runs: as knex runs it, or under a search's time
 *  budget (cancelled on the server at the deadline — global search). */
export type Exec = <T = Record<string, unknown>>(qb: Knex.QueryBuilder) => Promise<T[]>
const directExec: Exec = <T>(qb: Knex.QueryBuilder) => qb as unknown as Promise<T[]>

export function budgetExec(budget: SearchBudget): Exec {
  // Other dialects run as knex runs them (the budget still bounds the kind).
  if (!onMssql()) return directExec
  return <T>(qb: Knex.QueryBuilder) => {
    const n = qb.toSQL().toNative()
    return budget.query<T>(n.sql, n.bindings as unknown[], { native: true })
  }
}
const isSystem = (c: string) => /^(nivaro_|directus_)/i.test(c)

export function recordHref(collection: string, item: string, query = ''): string {
  return `/records/${encodeURIComponent(collection)}/${encodeURIComponent(item)}${query}`
}

export function adminRecordHref(collection: string, item: string, query = ''): string {
  return `/collections/${encodeURIComponent(collection)}/${encodeURIComponent(item)}${query}`
}

// ─── Dependencies (injectable for tests) ─────────────────────────────────────

export interface TextRow {
  /** The hit's own id (comment id, history id, note row id). */
  id: string
  collection: string
  item: string
  text: string
  kind: 'comment' | 'note'
}

export interface FileHitRow {
  id: string
  filename_download: string | null
  title: string | null
  uploaded_by: string | null
  tags?: unknown
}

export interface ExtraDeps {
  commentRows(phrase: string, cap: number, exec?: Exec): Promise<TextRow[]>
  noteRows(user: User, phrase: string, cap: number, exec?: Exec): Promise<TextRow[]>
  visibleIds(user: User, collection: string, ids: string[], isAdmin: boolean): Promise<string[]>
  recordLabels(user: User, byCollection: Map<string, Set<string>>): Promise<Record<string, string>>
  displayNames(collections: string[]): Promise<Map<string, string>>
  fileRows(phrase: string, cap: number, exec?: Exec): Promise<FileHitRow[]>
  readableFiles(files: FileHitRow[], req: Caller): Promise<Set<string>>
  fileRefs(ids: string[]): Promise<Map<string, Array<{ collection: string; id: string }>>>
  videos(user: User, q: string, limit: number): Promise<ExtraHit[]>
  docs(q: string, admin: boolean, limit: number): Promise<ExtraHit[]>
  channelRows(
    phrase: string,
    cap: number
  ): Promise<Array<{ key: string; name: string | null; topic: string | null }>>
  canSeeRoom(user: User, room: string): Promise<boolean>
  /** Admin-only config reaches administrators only (personal screens reach everyone). */
  configHits(phrase: string, cap: number, isAdmin: boolean): Promise<ExtraHit[]>
}

async function commentRows(
  phrase: string,
  cap: number,
  exec: Exec = directExec
): Promise<TextRow[]> {
  const text = containsRaw('[text]', phrase)
  const rows = (await exec(
    db('nivaro_comments')
      .whereNull('deleted_at')
      .modify(recordCommentsOnly(await hasFieldCommentColumns()))
      .whereRaw(text.sql, text.bindings)
      .whereRaw(`[collection] not like 'nivaro\\_%' escape '\\'`)
      .whereRaw(`[collection] not like 'directus\\_%' escape '\\'`)
      .orderBy('created_at', 'desc')
      .limit(cap)
      .select('id', 'collection', 'item', 'text')
  )) as Array<Record<string, unknown>>
  return rows
    .filter((r) => r.item != null && r.item !== '')
    .map((r) => ({
      id: String(r.id),
      collection: String(r.collection),
      item: String(r.item),
      text: String(r.text ?? ''),
      kind: 'comment' as const
    }))
}

/** Transition notes (the record Notes thread's main source) and convention-named
 *  note tables (child collections called notes/comments with a text column —
 *  the same convention services/record-notes.ts recognises). No ORDER BY on the
 *  history scan: TOP stops at the first matches instead of sorting them all. */
// A contains-LIKE is a scan: past this many history rows the transition-note
// arm sits out (the same budget global search keeps for record tables).
const HISTORY_ROW_BUDGET = 500_000
const ROWS_TTL_MS = 10 * 60_000
const rowsCache = new Map<string, { at: number; rows: number }>()

async function tableRows(table: string): Promise<number> {
  const { currentTenantKey } = await import('./tenant-rooms.js')
  const key = `${currentTenantKey()}|${table}`
  const hit = rowsCache.get(key)
  if (hit && Date.now() - hit.at < ROWS_TTL_MS) return hit.rows
  const res = (await db.raw(
    `select sum(p.rows) as n from sys.partitions p join sys.tables t on t.object_id = p.object_id
     where t.name = ? and p.index_id in (0, 1)`,
    [table]
  )) as Array<{ n: number | string | null }>
  const rows = Number(res?.[0]?.n ?? 0)
  rowsCache.set(key, { at: Date.now(), rows })
  return rows
}

async function noteRows(
  user: User,
  phrase: string,
  cap: number,
  exec: Exec = directExec
): Promise<TextRow[]> {
  // Transition notes and the note tables are independent scans: side by side.
  const [hist, tables] = await Promise.all([
    historyNoteRows(phrase, cap, exec).catch(() => [] as TextRow[]),
    tableNoteRows(user, phrase, cap, exec).catch(() => [] as TextRow[])
  ])
  return [...hist, ...tables]
}

async function historyNoteRows(phrase: string, cap: number, exec: Exec): Promise<TextRow[]> {
  if ((await tableRows('nivaro_workflow_history')) > HISTORY_ROW_BUDGET) return []
  const comment = containsRaw('h.[comment]', phrase)
  const hist = (await exec(
    db('nivaro_workflow_history as h')
      .join('nivaro_workflow_instances as i', 'i.id', 'h.instance')
      .whereNotNull('h.comment')
      .whereRaw(comment.sql, comment.bindings)
      .limit(cap)
      .select('h.id', 'h.comment', 'i.collection', 'i.item')
  )) as Array<Record<string, unknown>>
  const out: TextRow[] = []
  for (const r of hist) {
    if (!r.collection || r.item == null || isSystem(String(r.collection))) continue
    out.push({
      id: `history:${String(r.id)}`,
      collection: String(r.collection),
      item: String(r.item),
      text: String(r.comment ?? ''),
      kind: 'note'
    })
  }
  return out
}

async function tableNoteRows(
  user: User,
  phrase: string,
  cap: number,
  exec: Exec
): Promise<TextRow[]> {
  const rels = (
    (await db('nivaro_relations')
      .whereNotNull('many_collection')
      .whereNotNull('one_collection')
      .whereNotNull('many_field')
      .select('many_collection', 'many_field', 'one_collection')) as Array<{
      many_collection: string
      many_field: string
      one_collection: string
    }>
  )
    .filter(
      (r) =>
        /(^|_)(notes?|comments?)$/i.test(r.many_collection) &&
        !isSystem(r.many_collection) &&
        !isSystem(r.one_collection) &&
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(r.many_collection) &&
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(r.many_field)
    )
    .slice(0, 4)
  if (rels.length === 0) return []
  const cols = (await db('information_schema.columns')
    .whereIn(
      'table_name',
      rels.map((r) => r.many_collection)
    )
    .select('table_name', 'column_name', 'data_type')) as Array<{
    table_name: string
    column_name: string
    data_type?: string
  }>
  const parts = await Promise.all(
    rels.map(async (rel) => {
      const mine = cols.filter(
        (c) => c.table_name.toLowerCase() === rel.many_collection.toLowerCase()
      )
      const types = new Map(mine.map((c) => [c.column_name.toLowerCase(), c.data_type]))
      const textCol = ['text', 'note', 'notes', 'comment', 'body', 'message'].find((c) =>
        types.has(c)
      )
      if (!textCol || !types.has('id')) return [] as TextRow[]
      try {
        const text = containsRaw(`[${textCol}]`, phrase, textKindOf(types.get(textCol)))
        const found = (await exec(
          db(rel.many_collection)
            .whereNotNull(rel.many_field)
            .whereRaw(text.sql, text.bindings)
            .limit(cap)
            .select({ id: 'id' })
        )) as Array<{ id: unknown }>
        if (found.length === 0) return [] as TextRow[]
        // The note rows are re-read AS THE CALLER (their own policy, row filter,
        // User Scopes and field list), and the snippet comes only from what that
        // read returned: a note table, or its text column, the caller may not
        // read never shows — nor confirms a match.
        const { readItems } = await import('./items.js')
        const read = (
          await readItems(user, rel.many_collection, {
            filter: { id: { _in: found.map((f) => f.id) } },
            fields: ['id', rel.many_field, textCol],
            limit: found.length,
            count: false
          })
        ).data as Array<Record<string, unknown>>
        return read
          .filter((r) => r[rel.many_field] != null && typeof r[textCol] === 'string')
          .map((r) => ({
            id: `note:${rel.many_collection}:${String(r.id)}`,
            collection: rel.one_collection,
            item: String(r[rel.many_field]),
            text: String(r[textCol] ?? ''),
            kind: 'note' as const
          }))
      } catch {
        /* a stale relation — skip that table */
        return [] as TextRow[]
      }
    })
  )
  return parts.flat()
}

async function fileRows(
  phrase: string,
  cap: number,
  exec: Exec = directExec
): Promise<FileHitRow[]> {
  const { whereNotHelpVideoFile } = await import('./help-video-files.js')
  const name = containsRaw('[filename_download]', phrase)
  const title = containsRaw('[title]', phrase)
  const qb = db('nivaro_files')
    .where((w) => {
      w.whereRaw(name.sql, name.bindings).orWhereRaw(title.sql, title.bindings)
    })
    .orderBy('uploaded_on', 'desc')
    .limit(cap)
    .select('id', 'filename_download', 'title', 'uploaded_by', 'tags')
  whereNotHelpVideoFile(qb, 'nivaro_files.id')
  return ((await exec(qb)) as Array<Record<string, unknown>>).map((r) => ({
    id: String(r.id),
    filename_download: (r.filename_download as string | null) ?? null,
    title: (r.title as string | null) ?? null,
    uploaded_by: (r.uploaded_by as string | null) ?? null,
    tags: r.tags
  }))
}

async function channelRows(phrase: string, cap: number) {
  const like = likeOf(phrase)
  const qb = db('nivaro_chat_channels')
    .where((w) => {
      w.where('is_archived', false).orWhereNull('is_archived')
    })
    .where((w) => {
      w.whereRaw(`[name] ${LIKE}`, [like])
        .orWhereRaw(`[key] ${LIKE}`, [like])
        .orWhereRaw(`[topic] ${LIKE}`, [like])
    })
    .limit(cap)
    .select('key', 'name', 'topic')
  // Group DMs are private channels drawn as conversations: never listed.
  if (await hasColumn('nivaro_chat_channels', 'is_direct').catch(() => true)) {
    qb.where((w) => {
      w.where('is_direct', false).orWhereNull('is_direct')
    })
  }
  return (await qb) as Array<{ key: string; name: string | null; topic: string | null }>
}

/** Config by name (services/config-search): collections, fields, validation,
 *  cascades, layouts, pipelines, flows, field rules, alerts, rules, queues,
 *  dashboards, reports, custom queries, external APIs, payload templates,
 *  imports, webhooks, roles and settings sections, each linked to the exact
 *  screen. Keyword-only here; the plain-words AI rewrite is the /search
 *  page's own call (GET /global-search/config). */
async function configHits(phrase: string, cap: number, isAdmin: boolean): Promise<ExtraHit[]> {
  const { configKeywordHits } = await import('./config-search/index.js')
  return configKeywordHits(phrase, { isAdmin, limit: cap })
}

export const defaultExtraDeps: ExtraDeps = {
  commentRows,
  noteRows,
  async visibleIds(user, collection, ids, isAdmin) {
    const { visibleRecordIds } = await import('./socket-access.js')
    return visibleRecordIds(user, collection, ids, isAdmin)
  },
  async recordLabels(user, byCollection) {
    const { linkLabelsAsUser } = await import('./ai-link-labels.js')
    return linkLabelsAsUser(user, byCollection)
  },
  async displayNames(collections) {
    if (collections.length === 0) return new Map()
    const rows = (await db('nivaro_collections')
      .whereIn('collection', collections)
      .select('collection', 'display_name')) as Array<{
      collection: string
      display_name: string | null
    }>
    return new Map(rows.map((r) => [r.collection, r.display_name || r.collection]))
  },
  fileRows,
  async readableFiles(files, req) {
    const { viewerMaySeeFile } = await import('./private-files.js')
    const { readableFileIds } = await import('./file-access.js')
    const shown = files.filter((f) =>
      viewerMaySeeFile(f, { id: req.user?.id ?? null, isAdmin: req.isAdmin })
    )
    return readableFileIds(shown, req)
  },
  async fileRefs(ids) {
    const { fileRecordRefs } = await import('./file-access.js')
    return fileRecordRefs(ids)
  },
  async videos(user, q, limit) {
    const { searchHelpVideos } = await import('./help-video-search.js')
    const { results } = await searchHelpVideos(user, q, limit)
    return results.map((v) => ({
      kind: 'video',
      id: v.id,
      label: v.title,
      snippet: v.snippet,
      // efp-new hosts the library at /help/videos; admin at /help-videos.
      href: v.path.replace(/^\/help-videos/, '/help/videos'),
      admin_href: v.path
    }))
  },
  async docs(q, admin, limit) {
    const { loadDocsIndex, rankDocs } = await import('./docs-search.js')
    const { hits } = rankDocs(await loadDocsIndex(), q, { admin, limit })
    return hits.map((d) => ({
      kind: 'doc',
      id: d.id,
      label: d.heading ? `${d.label} — ${d.heading}` : d.label,
      snippet: d.snippet.slice(0, 200),
      href: d.path,
      admin_href: d.path
    }))
  },
  channelRows,
  async canSeeRoom(user, room) {
    const { canSeeRoom } = await import('./chat.js')
    return canSeeRoom(user, room)
  },
  configHits
}

// ─── Kinds ───────────────────────────────────────────────────────────────────

/** Comments and notes whose parent record the caller can open, labelled by
 *  that record (read as the caller). Exported for tests. */
export async function searchTextHits(
  user: User,
  q: string,
  isAdmin: boolean,
  deps: ExtraDeps = defaultExtraDeps,
  exec?: Exec
): Promise<ExtraHit[]> {
  const [comments, notes] = await Promise.all([
    deps.commentRows(q, RAW_CAP, exec).catch(() => [] as TextRow[]),
    deps.noteRows(user, q, RAW_CAP, exec).catch(() => [] as TextRow[])
  ])
  const rows = [...comments, ...notes]
  if (rows.length === 0) return []
  const byCollection = new Map<string, Set<string>>()
  for (const r of rows) {
    if (isSystem(r.collection)) continue
    const set = byCollection.get(r.collection) ?? new Set<string>()
    set.add(r.item)
    byCollection.set(r.collection, set)
  }
  // One gate compile + batched read per collection — never per row.
  const visible = new Map<string, Set<string>>()
  await Promise.all(
    [...byCollection].map(async ([collection, ids]) => {
      const ok = await deps.visibleIds(user, collection, [...ids], isAdmin).catch(() => [])
      visible.set(collection, new Set(ok.map((i) => String(i).toLowerCase())))
    })
  )
  const kept = rows.filter((r) => visible.get(r.collection)?.has(r.item.toLowerCase()))
  if (kept.length === 0) return []
  const keptBy = new Map<string, Set<string>>()
  for (const r of kept.slice(0, EXTRA_CAP * 2)) {
    const set = keptBy.get(r.collection) ?? new Set<string>()
    set.add(r.item)
    keptBy.set(r.collection, set)
  }
  const [labels, names] = await Promise.all([
    deps.recordLabels(user, keptBy).catch(() => ({}) as Record<string, string>),
    deps.displayNames([...keptBy.keys()]).catch(() => new Map<string, string>())
  ])
  const terms = searchTerms(q)
  const seen = new Set<string>()
  const out: ExtraHit[] = []
  for (const r of kept) {
    if (out.length >= EXTRA_CAP) break
    if (seen.has(r.id)) continue
    seen.add(r.id)
    // Never the parent's pk: its label as the caller, else the collection's name.
    const recordLabel = safeRecordLabel(labels[`${r.collection}:${r.item}`], {
      collection: r.collection,
      id: r.item,
      display_name: names.get(r.collection)
    })
    const query = r.kind === 'comment' ? `?comment=${encodeURIComponent(r.id)}` : '?tab=notes'
    out.push({
      kind: r.kind,
      id: r.id,
      label: recordLabel.slice(0, 80),
      snippet: excerpt(stripHtmlToText(r.text), terms, 160),
      href: recordHref(r.collection, r.item, query),
      admin_href: adminRecordHref(r.collection, r.item, query),
      collection: r.collection,
      item: r.item
    })
  }
  return out
}

/** File names / titles the caller may read (file-access.ts), each linked to a
 *  record that uses it when the caller can open one. Exported for tests. */
export async function searchFileHits(
  user: User,
  q: string,
  req: Caller,
  deps: ExtraDeps = defaultExtraDeps,
  exec?: Exec
): Promise<ExtraHit[]> {
  const rows = await deps.fileRows(q, 20, exec)
  if (rows.length === 0) return []
  const readable = await deps.readableFiles(rows, req)
  const files = rows.filter((f) => readable.has(f.id.toLowerCase())).slice(0, EXTRA_CAP)
  if (files.length === 0) return []
  const refs = await deps.fileRefs(files.map((f) => f.id)).catch(() => new Map())
  const refBy = new Map<string, Set<string>>()
  for (const f of files) {
    for (const ref of refs.get(f.id.toLowerCase()) ?? []) {
      const set = refBy.get(ref.collection) ?? new Set<string>()
      set.add(ref.id)
      refBy.set(ref.collection, set)
    }
  }
  const openable = new Map<string, Set<string>>()
  await Promise.all(
    [...refBy].map(async ([collection, ids]) => {
      const ok = await deps
        .visibleIds(user, collection, [...ids].slice(0, 100), req.isAdmin === true)
        .catch(() => [])
      openable.set(collection, new Set(ok.map((i) => String(i).toLowerCase())))
    })
  )
  return files.map((f) => {
    const ref = (refs.get(f.id.toLowerCase()) ?? []).find((r: { collection: string; id: string }) =>
      openable.get(r.collection)?.has(r.id.toLowerCase())
    )
    const name = f.title || f.filename_download || 'File'
    const fileQ = `?file=${encodeURIComponent(f.id)}`
    return {
      kind: 'file',
      id: f.id,
      label: String(name).slice(0, 80),
      ...(f.title && f.filename_download && f.title !== f.filename_download
        ? { snippet: f.filename_download }
        : {}),
      href: ref
        ? recordHref(ref.collection, ref.id, fileQ)
        : `/api/files/${encodeURIComponent(f.id)}`,
      admin_href: ref
        ? adminRecordHref(ref.collection, ref.id, fileQ)
        : `/files?file=${encodeURIComponent(f.id)}`,
      ...(ref ? { collection: ref.collection, item: ref.id } : {})
    }
  })
}

/** Chat channels (names only) whose room the caller can see. Exported for tests. */
export async function searchChatHits(
  user: User,
  q: string,
  deps: ExtraDeps = defaultExtraDeps
): Promise<ExtraHit[]> {
  const rows = await deps.channelRows(q, 20)
  const out: ExtraHit[] = []
  for (const r of rows) {
    if (out.length >= EXTRA_CAP) break
    const room = `ch:${r.key}`
    if (!(await deps.canSeeRoom(user, room).catch(() => false))) continue
    const href = `/chat?room=${encodeURIComponent(room)}`
    out.push({
      kind: 'channel',
      id: room,
      label: `#${r.name || r.key}`,
      ...(r.topic ? { snippet: String(r.topic).slice(0, 120) } : {}),
      href,
      admin_href: href,
      item: room
    })
  }
  return out
}

/** Every extra kind for one search, as the caller. Kinds that fail or find
 *  nothing are left out of the answer. */
export async function searchExtra(
  user: User,
  q: string,
  opts: { isAdmin: boolean; req: Caller; deps?: ExtraDeps; budget?: SearchBudget }
): Promise<SearchExtra> {
  const phrase = q.trim()
  if (phrase.length < EXTRA_MIN_CHARS) return {}
  const deps = opts.deps ?? defaultExtraDeps
  // Under a search's time budget (global search) every kind runs side by side and
  // a kind still going at the deadline answers nothing (its scans are cancelled on
  // the server); the budget records which.
  const budget = opts.budget
  const exec = budget ? budgetExec(budget) : undefined
  const kind = (label: string, fn: () => Promise<ExtraHit[]>): Promise<ExtraHit[]> =>
    budget ? budget.run(label, [] as ExtraHit[], fn) : fn()
  const [comments, files, videos, docs, chat, config] = await Promise.allSettled([
    kind('comments', () => searchTextHits(user, phrase, opts.isAdmin, deps, exec)),
    kind('files', () => searchFileHits(user, phrase, opts.req, deps, exec)),
    kind('videos', () => deps.videos(user, phrase, 5)),
    kind('docs', () => deps.docs(phrase, opts.isAdmin, 5)),
    kind('chat', () => searchChatHits(user, phrase, deps)),
    kind('config', () => deps.configHits(phrase, EXTRA_CAP, opts.isAdmin))
  ])
  const out: SearchExtra = {}
  const put = (key: keyof SearchExtra, r: PromiseSettledResult<ExtraHit[]>) => {
    if (r.status === 'fulfilled' && r.value.length > 0) out[key] = r.value.slice(0, EXTRA_CAP)
  }
  put('comments', comments)
  put('files', files)
  put('videos', videos)
  put('docs', docs)
  put('chat', chat)
  put('config', config)
  return out
}

export { searchCommands } from './search-commands.js'
export { searchPeopleExtras } from './search-people.js'
