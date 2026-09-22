/**
 * The record Notes thread (GET /comments/related) — every place someone WROTE
 * something about a record, merged into one time-ordered list (#517).
 *
 * Sources: workflow transition comments, the record's own change reasons,
 * child rows' change reasons, addendum reasons, convention-named note tables,
 * comments on child rows, import runs, extension sources (relatedNoteRegistry)
 * and anything registered with `registerNoteSource`. A new kind of note is one
 * registration; it no longer means editing this merge.
 *
 * Who wrote an entry is STRUCTURAL now (#518): rows carry `origin` (person |
 * machine | import | integration) and only people's entries reach the thread
 * from human sources. Historic rows without an origin fall back to the writer's
 * account kind, legacy provenance and the registered text markers.
 */
import { db } from '../db/index.js'
import { relatedNoteRegistry } from '../extensions/related-notes.js'
import { accountKindOf } from './machine-accounts.js'
import { originOfRow } from './note-authorship.js'

export interface NoteEntry {
  id: string
  source: 'transition' | 'change_reason' | 'addendum' | 'note' | 'external' | 'import'
  label: string
  text: string
  user: string | null
  created_at: string | Date
  context: string | null
  link?: { collection: string; item_id: string }
  comment_id?: string
  reactions?: Array<{ emoji: string; count: number; mine: boolean }>
  /** External entries: which provider wrote it, and whether it can be replayed (#29). */
  provider?: string
  replayable?: boolean
  status?: 'ok' | 'error' | 'info' | null
  /** Import entries (#60): the run or file behind the write. */
  import?: {
    label: string
    file_id: string | null
    file_name: string | null
    run_id: number | null
    rows: number
    action: 'create' | 'update'
  }
  /** Who wrote it (#518) — only 'person' entries come from human sources. */
  origin?: 'person' | 'machine' | 'import' | 'integration'
}

export interface NoteSourceCtx {
  collection: string
  item: string
  viewerId: string
  cap: number
}

export interface NoteSource {
  key: string
  /** Machine sources (integration events, import runs) skip the person filter. */
  machine?: boolean
  load(ctx: NoteSourceCtx): Promise<NoteEntry[]>
}

const noteSources = new Map<string, NoteSource>()

/** Add a source to every record's Notes thread. Re-registering a key replaces it. */
export function registerNoteSource(source: NoteSource): void {
  noteSources.set(source.key, source)
}

/** The sources a thread is assembled from, core first. */
export function listNoteSources(): string[] {
  return [
    'transitions',
    'change-reasons',
    'child-change-reasons',
    'addendums',
    'note-tables',
    'line-comments',
    'imports',
    'external',
    ...noteSources.keys()
  ]
}

const colCache = new Map<string, Promise<boolean>>()
function hasColumn(table: string, col: string): Promise<boolean> {
  const k = `${table}.${col}`
  let p = colCache.get(k)
  if (!p) {
    p = db.schema.hasColumn(table, col).catch(() => false)
    colCache.set(k, p)
  }
  return p
}

/**
 * Keep the entries a person wrote. Rows with a stored origin are judged by it;
 * the rest by the writer's account kind, legacy provenance, then text markers.
 */
async function keepPersonEntries(
  list: Array<NoteEntry & { _origin?: unknown; _legacy?: boolean }>
): Promise<NoteEntry[]> {
  const ids = [
    ...new Set(
      list.filter((e) => e._origin == null && e.user).map((e) => String(e.user).toUpperCase())
    )
  ]
  const kinds = new Map<string, string | null>()
  for (let i = 0; i < ids.length; i += 500) {
    const rows = (await db('nivaro_users')
      .whereIn('id', ids.slice(i, i + 500))
      .select('id', 'email', 'account_kind')
      .catch(() => [])) as Array<{ id: string; email: string | null; account_kind: string | null }>
    for (const u of rows) kinds.set(String(u.id).toUpperCase(), accountKindOf(u))
  }
  const out: NoteEntry[] = []
  for (const e of list) {
    if (String(e.text ?? '').trim() === '') continue
    const origin = originOfRow({
      origin: e._origin,
      comment: e.text,
      legacy: e._legacy,
      actorKind: e.user ? (kinds.get(String(e.user).toUpperCase()) ?? null) : null
    })
    if (origin !== 'person') continue
    const { _origin: _o, _legacy: _l, ...rest } = e
    out.push({ ...rest, origin })
  }
  return out
}

/** How a child row identifies itself, for "which forecast was this about". */
const CHILD_LABEL_FIELDS = ['year', 'name', 'title', 'label', 'period', 'month', 'key', 'code']

function childRowLabel(row: Record<string, unknown>): string | null {
  for (const f of CHILD_LABEL_FIELDS) {
    const v = row[f]
    if (v !== null && v !== undefined && String(v).trim() !== '') {
      const text = String(v).trim()
      return text.length > 40 ? `${text.slice(0, 40)}…` : text
    }
  }
  return row.id != null ? `#${row.id}` : null
}

/** The columns a revision actually changed — "february, total" says more about
 *  a forecast edit than the row's name does. */
function changedFieldNames(delta: unknown): string | null {
  let parsed: unknown = delta
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed)
    } catch {
      return null
    }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  const keys = Object.keys(parsed as Record<string, unknown>).filter((k) => !k.startsWith('_'))
  if (keys.length === 0) return null
  const shown = keys.slice(0, 4).map((k) => k.replace(/_/g, ' '))
  return keys.length > 4 ? `${shown.join(', ')} +${keys.length - 4} more` : shown.join(', ')
}

const usd = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  maximumFractionDigits: 0
})

/** What the amendment proposed, in money terms. */
function amountChange(previous: unknown, next: unknown, impact: unknown): string | null {
  const p = Number(previous)
  const n = Number(next)
  if (Number.isFinite(p) && Number.isFinite(n) && p !== n) {
    const diff = n - p
    return `${usd.format(p)} → ${usd.format(n)} (${diff >= 0 ? '+' : '−'}${usd.format(Math.abs(diff))})`
  }
  const i = Number(impact)
  if (Number.isFinite(i) && i !== 0) return `${i >= 0 ? '+' : '−'}${usd.format(Math.abs(i))}`
  return null
}

/**
 * Comment strings written by MACHINERY, not people — a sync script's
 * provenance tag, a proc's marker — are not notes: putting them in the thread
 * buries the handful of real notes under hundreds of identical markers. WHICH
 * strings those are belongs to whoever writes them, so extensions declare
 * theirs (`ctx.notes.registerMachineMarkers`, #10); the one marker core itself
 * writes is the import stamp, which the thread renders as its own source.
 */
export function isHumanNote(text: string | null | undefined): boolean {
  const t = String(text ?? '').trim()
  if (t === '') return false
  if (parseImportStamp(t)) return false
  return !relatedNoteRegistry.isMachineComment(t)
}

/** `import:<label>:<file uuid>` (a file-driven import) or
 *  `import:<label>:run-<id>` (a staged-import run) — the stamp every import
 *  write carries as its change reason. */
export function parseImportStamp(
  comment: string | null | undefined
): { label: string; file_id: string | null; run_id: number | null } | null {
  const t = String(comment ?? '').trim()
  if (!/^import:/i.test(t)) return null
  const rest = t.slice('import:'.length)
  const cut = rest.lastIndexOf(':')
  const label = (cut >= 0 ? rest.slice(0, cut) : rest).trim() || 'a file'
  const ref = cut >= 0 ? rest.slice(cut + 1).trim() : ''
  const run = /^run-(\d+)$/i.exec(ref)
  return {
    label,
    file_id: run || !ref ? null : ref,
    run_id: run ? Number(run[1]) : null
  }
}

/** Addendum reasons are rich text; the thread shows plain prose. */
function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function titleCase(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export async function loadRecordNotes(
  collection: string,
  item: string,
  viewerId: string
): Promise<Array<NoteEntry & { user_name: string | null }>> {
  const [histOrigin, actOrigin] = await Promise.all([
    hasColumn('nivaro_workflow_history', 'origin'),
    hasColumn('nivaro_activity', 'origin')
  ])
  const CAP = 200

  const instances = (await db('nivaro_workflow_instances')
    .where({ collection, item: String(item) })
    .select('id')) as Array<{ id: string }>

  const [transitions, ownReasons, addendums] = await Promise.all([
    instances.length
      ? (db('nivaro_workflow_history as h')
          .leftJoin('nivaro_workflow_states as fs', 'h.from_state', 'fs.id')
          .leftJoin('nivaro_workflow_states as ts', 'h.to_state', 'ts.id')
          .whereIn(
            'h.instance',
            instances.map((i) => i.id)
          )
          .whereNotNull('h.comment')
          .orderBy('h.timestamp', 'desc')
          .limit(CAP)
          .select(
            'h.id',
            'h.user',
            'h.timestamp',
            'h.comment',
            ...(histOrigin ? ['h.origin'] : []),
            'fs.label as from_label',
            'ts.label as to_label'
          )
          .catch(() => []) as Promise<Array<Record<string, unknown>>>)
      : Promise.resolve([]),
    db('nivaro_activity')
      .where({ collection, item: String(item) })
      .whereNotNull('comment')
      .orderBy('timestamp', 'desc')
      .limit(CAP)
      .select(
        'id',
        'user',
        'timestamp',
        'comment',
        'action',
        'legacy_id',
        ...(actOrigin ? ['origin'] : [])
      )
      .catch(() => []) as Promise<Array<Record<string, unknown>>>,
    // `description` IS the addendum's reason text — there is no `reason`
    // column; rejection_reason is a different thing entirely.
    db('nivaro_addendums')
      .where({ parent_collection: collection, parent_id: String(item) })
      .whereNotNull('description')
      .orderBy('created_at', 'desc')
      .limit(CAP)
      .select(
        'id',
        'title',
        'description',
        'status',
        'created_by',
        'created_at',
        'cost_impact',
        'previous_amount',
        'new_amount'
      )
      .catch(() => [] as Array<Record<string, unknown>>) as Promise<Array<Record<string, unknown>>>
  ])

  // What the record's own reasoned changes actually touched.
  const ownChanged = new Map<string, string>()
  if (ownReasons.length > 0) {
    const revs = (await db('nivaro_revisions')
      .whereIn(
        'activity',
        ownReasons.map((a) => a.id as number)
      )
      .select('activity', 'delta')
      .catch(() => [])) as Array<Record<string, unknown>>
    for (const rev of revs) {
      const fields = changedFieldNames(rev.delta)
      if (fields) ownChanged.set(String(rev.activity), fields)
    }
  }

  // Change reasons written on CHILD rows (a forecast's justification, say).
  // Only collections that actually require a reason are considered, so this
  // is a couple of cheap queries rather than a sweep of every relation.
  const childReasons: Array<Record<string, unknown>> = []
  try {
    const reasonCollections = (await db('nivaro_collections')
      .whereNotNull('change_reason_config')
      .select('collection')) as Array<{ collection: string }>
    for (const rc of reasonCollections) {
      if (rc.collection === collection) continue
      const rels = (await db('nivaro_relations')
        .where({ many_collection: rc.collection, one_collection: collection })
        .select('many_field')) as Array<{ many_field: string }>
      if (rels.length === 0) continue
      const childRows = (await db(rc.collection)
        .where((qb) => {
          for (const r of rels) void qb.orWhere(r.many_field, item)
        })
        .limit(1000)
        .select('*')) as Array<Record<string, unknown>>
      if (childRows.length === 0) continue
      // "Forecasts" alone does not say WHICH forecast — carry whatever the
      // row identifies itself by so a reader can place the note.
      const labelByChildId = new Map(childRows.map((r) => [String(r.id), childRowLabel(r)]))
      const rows = (await db('nivaro_activity')
        .where({ collection: rc.collection })
        .whereIn('item', [...labelByChildId.keys()])
        .whereNotNull('comment')
        .orderBy('timestamp', 'desc')
        .limit(CAP)
        .select(
          'id',
          'user',
          'timestamp',
          'comment',
          'item',
          'legacy_id',
          ...(actOrigin ? ['origin'] : [])
        )) as Array<Record<string, unknown>>
      // What actually changed, from the revision delta written alongside.
      const changedByActivity = new Map<string, string>()
      if (rows.length > 0) {
        const revs = (await db('nivaro_revisions')
          .whereIn(
            'activity',
            rows.map((r) => r.id as number)
          )
          .select('activity', 'delta')
          .catch(() => [])) as Array<Record<string, unknown>>
        for (const rev of revs) {
          const fields = changedFieldNames(rev.delta)
          if (fields) changedByActivity.set(String(rev.activity), fields)
        }
      }
      for (const r of rows) {
        childReasons.push({
          ...r,
          child: rc.collection,
          child_label: labelByChildId.get(String(r.item)) ?? null,
          changed: changedByActivity.get(String(r.id)) ?? null
        })
      }
    }
  } catch {
    // A missing child table or relation must not take down the thread.
  }

  // Note tables. Some deployments keep human notes as their own child
  // collection rather than in nivaro_comments — those are notes about this
  // record by any reasonable definition, and a thread that ignored them
  // showed nothing while the record plainly had commentary on it.
  // Recognised by CONVENTION, not by a hardcoded name: a child collection
  // called notes/comments (singular or plural) carrying a text column.
  const noteRows: Array<Record<string, unknown>> = []
  try {
    const rels = (await db('nivaro_relations')
      .where({ one_collection: collection })
      .whereNotNull('many_collection')
      .select('many_collection', 'many_field')) as Array<{
      many_collection: string
      many_field: string
    }>
    const noteRels = rels.filter(
      (r) => /(^|_)(notes?|comments?)$/i.test(r.many_collection) && !!r.many_field
    )
    for (const rel of noteRels) {
      const cols = (await db('information_schema.columns')
        .where({ table_name: rel.many_collection })
        .select('column_name')) as Array<{ column_name: string }>
      const names = new Set(cols.map((c) => String(c.column_name).toLowerCase()))
      const textCol = ['text', 'note', 'notes', 'comment', 'body', 'message'].find((c) =>
        names.has(c)
      )
      if (!textCol) continue
      const userCol = ['creator', 'user_created', 'created_by', 'user'].find((c) => names.has(c))
      const dateCol = ['created', 'date_created', 'created_at', 'timestamp'].find((c) =>
        names.has(c)
      )
      const rows = (await db(rel.many_collection)
        .where(rel.many_field, item)
        .orderBy(dateCol ?? 'id', 'desc')
        .limit(CAP)
        .select('*')) as Array<Record<string, unknown>>
      for (const r of rows) {
        const text = r[textCol]
        if (text === null || text === undefined || String(text).trim() === '') continue
        noteRows.push({
          id: `note:${rel.many_collection}:${String(r.id)}`,
          text: String(text),
          user: userCol ? (r[userCol] ?? null) : null,
          created_at: dateCol ? r[dateCol] : null,
          // A note stamped with the state it was written in says more than
          // "Note" alone.
          context: r.type ? titleCase(String(r.type)) : null
        })
      }
    }
  } catch {
    // Same posture as the rest of this route: a missing table or column
    // must never take the whole thread down.
  }

  // Comments posted ON CHILD ROWS of this record (line-item comments):
  // "line 7: wrong CIFA" belongs in the record's thread too, with the
  // line named. Only child collections that actually hold comments are
  // walked — one probe query keeps this cheap.
  const lineComments: Array<Record<string, unknown>> = []
  try {
    const childRels = (await db('nivaro_relations')
      .where({ one_collection: collection })
      .whereNotNull('many_collection')
      .select('many_collection', 'many_field')) as Array<{
      many_collection: string
      many_field: string
    }>
    const childCollections = [...new Set(childRels.map((r) => r.many_collection))]
    const commented = childCollections.length
      ? ((await db('nivaro_comments')
          .whereIn('collection', childCollections)
          .distinct('collection')) as Array<{ collection: string }>)
      : []
    for (const cc of commented) {
      const rels = childRels.filter((r) => r.many_collection === cc.collection)
      const childRows = (await db(cc.collection)
        .where((qb) => {
          for (const r of rels) void qb.orWhere(r.many_field, item)
        })
        .limit(1000)
        .select('*')) as Array<Record<string, unknown>>
      if (childRows.length === 0) continue
      const labelByChildId = new Map(childRows.map((r) => [String(r.id), childRowLabel(r)]))
      const rows = (await db('nivaro_comments')
        .where({ collection: cc.collection })
        .whereIn('item', [...labelByChildId.keys()])
        .orderBy('created_at', 'desc')
        .limit(CAP)
        .select('id', 'user', 'text', 'item', 'created_at')) as Array<Record<string, unknown>>
      // Human labels: the collection's display_template first ("CR26-76773 ·
      // Line 7"), the row's own name-ish column second — a bare internal id
      // identifies nothing to a reader.
      let templateLabels: Record<string, string> = {}
      if (rows.length > 0) {
        try {
          const { getLabels } = await import('../services/queues.js')
          templateLabels = await getLabels(
            new Map([[cc.collection, new Set(rows.map((r) => String(r.item)))]])
          )
        } catch {
          /* fall through to the name-column label */
        }
      }
      // Display templates with DOTTED tokens render those tokens empty
      // here (renderTemplateLabels resolves direct columns only), leaving
      // dangling separators ("· Line 4") — trim them.
      const cleanLabel = (v: string | null | undefined): string | null => {
        if (!v) return null
        const cleaned = v
          .replace(/\s*[·\-–|]\s*(?=[·\-–|])/g, '')
          .replace(/^\s*[·\-–|]\s*/, '')
          .replace(/\s*[·\-–|]\s*$/, '')
          .trim()
        return cleaned || null
      }
      // Reactions ride along: a line comment is a real comment, and the
      // thread must offer the same chips the child grid's popover does.
      const reactionRows = rows.length
        ? ((await db('nivaro_comment_reactions')
            .whereIn(
              'comment',
              rows.map((r) => String(r.id))
            )
            .select('comment', 'user', 'emoji')
            .catch(() => [])) as Array<{ comment: string; user: string; emoji: string }>)
        : []
      const reactionsFor = (id: string) => {
        const list: Array<{ emoji: string; count: number; mine: boolean }> = []
        for (const rr of reactionRows) {
          if (String(rr.comment).toUpperCase() !== id.toUpperCase()) continue
          let agg = list.find((a) => a.emoji === rr.emoji)
          if (!agg) {
            agg = { emoji: rr.emoji, count: 0, mine: false }
            list.push(agg)
          }
          agg.count++
          if (String(rr.user).toUpperCase() === String(viewerId).toUpperCase()) agg.mine = true
        }
        return list
      }
      for (const r of rows) {
        lineComments.push({
          ...r,
          child: cc.collection,
          child_label:
            cleanLabel(templateLabels[`${cc.collection}:${r.item}`]) ??
            labelByChildId.get(String(r.item)) ??
            null,
          reactions: reactionsFor(String(r.id)) as Array<{
            emoji: string
            count: number
            mine: boolean
          }>
        })
      }
    }
  } catch {
    // Same posture: a broken child table never takes the thread down.
  }

  // Import history (#60): which import runs touched this record. Every
  // import write carries `import:<label>:<file|run>` as its change reason —
  // on the record itself (a file-driven prefill, a service-mode staged
  // run) and on the child rows an import template created. The child
  // scan is bounded to the collections the record's import templates
  // actually target, and folds one run's rows into a single entry.
  const importEntries: NoteEntry[] = []
  try {
    type Stamped = {
      id: number
      user: string | null
      timestamp: string | Date
      comment: string
      action: string
      collection: string
    }
    const stamped: Stamped[] = ownReasons
      .filter((a) => parseImportStamp(String(a.comment ?? '')))
      .map((a) => ({
        id: Number(a.id),
        user: (a.user as string) ?? null,
        timestamp: a.timestamp as string,
        comment: String(a.comment),
        action: String(a.action ?? ''),
        collection
      }))
    const templates = (await db('nivaro_import_templates')
      .where({ collection })
      .whereNotNull('line_map')
      .select('line_map')
      .catch(() => [])) as Array<{ line_map: unknown }>
    const lineTargets = new Set<string>()
    for (const t of templates) {
      try {
        const lm = typeof t.line_map === 'string' ? JSON.parse(t.line_map) : t.line_map
        const tf = (lm as { target_field?: string } | null)?.target_field
        if (tf) lineTargets.add(tf)
      } catch {
        /* a broken template never breaks the thread */
      }
    }
    if (lineTargets.size > 0) {
      const rels = (await db('nivaro_relations')
        .where({ one_collection: collection })
        .whereIn('one_field', [...lineTargets])
        .whereNotNull('many_collection')
        .select('many_collection', 'many_field')) as Array<{
        many_collection: string
        many_field: string
      }>
      for (const rel of rels) {
        const childIds = (await db(rel.many_collection)
          .where(rel.many_field, item)
          .limit(2000)
          .select('id')
          .catch(() => [])) as Array<{ id: unknown }>
        if (childIds.length === 0) continue
        const rows = (await db('nivaro_activity')
          .where({ collection: rel.many_collection })
          .whereIn(
            'item',
            childIds.map((r) => String(r.id))
          )
          .where('comment', 'like', 'import:%')
          .orderBy('timestamp', 'desc')
          .limit(500)
          .select('id', 'user', 'timestamp', 'comment', 'action')
          .catch(() => [])) as Array<Record<string, unknown>>
        for (const r of rows)
          stamped.push({
            id: Number(r.id),
            user: (r.user as string) ?? null,
            timestamp: r.timestamp as string,
            comment: String(r.comment),
            action: String(r.action ?? ''),
            collection: rel.many_collection
          })
      }
    }
    if (stamped.length > 0) {
      // One entry per (stamp, collection, create|update): "Imported 12
      // lines via Bid Import", not twelve identical lines.
      const groups = new Map<string, Stamped[]>()
      for (const s of stamped) {
        const action = /update/i.test(s.action) ? 'update' : 'create'
        const key = `${s.comment.toLowerCase()}|${s.collection}|${action}`
        groups.set(key, [...(groups.get(key) ?? []), s])
      }
      const fileIds = [
        ...new Set(
          [...groups.values()]
            .map((g) => parseImportStamp(g[0].comment)?.file_id)
            .filter((v): v is string => !!v)
        )
      ]
      const fileNames = new Map<string, string>()
      if (fileIds.length > 0) {
        const files = (await db('nivaro_files')
          .whereIn('id', fileIds)
          .select('id', 'title', 'filename_download')
          .catch(() => [])) as Array<Record<string, unknown>>
        for (const f of files)
          fileNames.set(
            String(f.id).toUpperCase(),
            String(f.title || f.filename_download || '').trim()
          )
      }
      for (const g of groups.values()) {
        const stamp = parseImportStamp(g[0].comment)
        if (!stamp) continue
        const action = /update/i.test(g[0].action) ? 'update' : 'create'
        const onSelf = g[0].collection === collection
        const n = g.length
        const what = onSelf
          ? action === 'create'
            ? 'Created by import'
            : 'Updated by import'
          : `${action === 'create' ? 'Imported' : 'Updated'} ${n} ${titleCase(g[0].collection).toLowerCase()}${n === 1 ? ' row' : ' rows'}`
        const fileName = stamp.file_id ? (fileNames.get(stamp.file_id.toUpperCase()) ?? null) : null
        const newest = g.reduce((a, b) =>
          new Date(a.timestamp).getTime() >= new Date(b.timestamp).getTime() ? a : b
        )
        importEntries.push({
          id: `import:${g[0].collection}:${newest.id}`,
          source: 'import',
          label: 'Import',
          text: `${what} via ${stamp.label}`,
          user: newest.user,
          created_at: newest.timestamp,
          context:
            [fileName, stamp.run_id != null ? `Run #${stamp.run_id}` : null]
              .filter(Boolean)
              .join(' · ') || null,
          import: {
            label: stamp.label,
            file_id: stamp.file_id,
            file_name: fileName,
            run_id: stamp.run_id,
            rows: n,
            action
          }
        })
      }
    }
  } catch {
    /* import history must never take the thread down */
  }

  // Extension-provided history (an integration's shipment/sync events).
  // These are MACHINE events by design, so they bypass the human-note filter
  // that drops importer stamps and transition breadcrumbs.
  const externalEntries: NoteEntry[] = (
    await relatedNoteRegistry.load(collection, String(item)).catch(() => [])
  ).map((e) => ({
    id: `external:${e.id}`,
    source: 'external' as const,
    label: e.label,
    text: e.text,
    user: e.user ?? null,
    created_at: e.created_at,
    context: e.context ?? null,
    link: e.link,
    provider: e.provider,
    replayable: e.replayable === true,
    status: e.status ?? null
  }))

  const candidates = [
    ...lineComments.map((r) => ({
      id: `linecomment:${r.id}`,
      source: 'note' as const,
      label: 'Line comment',
      text: String(r.text ?? ''),
      user: (r.user as string) ?? null,
      created_at: r.created_at as string,
      context: [titleCase(String(r.child)), r.child_label].filter(Boolean).join(' · ') || null,
      link: { collection: String(r.child), item_id: String(r.item) },
      comment_id: String(r.id),
      reactions: r.reactions as Array<{ emoji: string; count: number; mine: boolean }> | undefined
    })),
    ...transitions.map((h) => ({
      id: `transition:${h.id}`,
      source: 'transition' as const,
      label: 'State change',
      text: String(h.comment ?? ''),
      user: (h.user as string) ?? null,
      created_at: h.timestamp as string,
      context: [h.from_label, h.to_label].filter(Boolean).join(' → ') || null,
      _origin: h.origin ?? null,
      _legacy: false
    })),
    // A transition writes its own activity row ("A → B via Approve"); the
    // transition entry above already says that, better.
    ...ownReasons
      .filter(
        (a) =>
          !String(a.action ?? '')
            .toLowerCase()
            .includes('transition')
      )
      .map((a) => ({
        id: `reason:${a.id}`,
        source: 'change_reason' as const,
        label: 'Change reason',
        text: String(a.comment ?? ''),
        user: (a.user as string) ?? null,
        created_at: a.timestamp as string,
        context: ownChanged.get(String(a.id)) ?? null,
        _origin: a.origin ?? null,
        _legacy: a.legacy_id != null
      })),
    ...childReasons.map((a) => ({
      id: `reason:${a.child}:${a.id}`,
      source: 'change_reason' as const,
      label: 'Change reason',
      text: String(a.comment ?? ''),
      user: (a.user as string) ?? null,
      created_at: a.timestamp as string,
      context: [titleCase(String(a.child)), a.child_label, a.changed].filter(Boolean).join(' · '),
      _origin: a.origin ?? null,
      _legacy: a.legacy_id != null
    })),
    ...addendums.map((ad) => ({
      id: `addendum:${ad.id}`,
      source: 'addendum' as const,
      label: 'Addendum',
      text: stripHtml(String(ad.description ?? '')),
      user: (ad.created_by as string) ?? null,
      created_at: ad.created_at as string,
      context:
        [
          String(ad.title ?? '').trim() === stripHtml(String(ad.description ?? '')).trim()
            ? null
            : ad.title,
          ad.status,
          amountChange(ad.previous_amount, ad.new_amount, ad.cost_impact)
        ]
          .filter(Boolean)
          .join(' · ') || null
    })),
    ...noteRows.map((n) => ({
      id: String(n.id),
      source: 'note' as const,
      label: 'Note',
      // These are stored as rich text; the thread renders plain text.
      text: stripHtml(String(n.text ?? '')),
      user: (n.user as string) ?? null,
      created_at: (n.created_at as string) ?? new Date(0).toISOString(),
      context: (n.context as string) ?? null
    }))
  ] as Array<NoteEntry & { _origin?: unknown; _legacy?: boolean }>
  const entries: NoteEntry[] = await keepPersonEntries(candidates)
  entries.push(...externalEntries, ...importEntries)
  // Registered sources (#517): a new kind of note is one registration, not
  // another block in this function.
  for (const src of noteSources.values()) {
    const got = await src
      .load({ collection, item: String(item), viewerId, cap: CAP })
      .catch(() => [] as NoteEntry[])
    entries.push(...(src.machine ? got : await keepPersonEntries(got)))
  }

  // Saving a child with a reason can also stamp the parent with the same
  // text (an edit that changed nothing on the parent row still records the
  // reason). That leaves the same sentence twice — once saying what it was
  // about and once saying nothing. Keep the one that carries context.
  const contextfulKeys = new Set(
    entries
      .filter((e) => !!e.context)
      .map(
        (e) =>
          `${e.user ?? ''}|${e.text.trim()}|${new Date(e.created_at).toISOString().slice(0, 16)}`
      )
  )
  const deduped = entries.filter(
    (e) =>
      !!e.context ||
      !contextfulKeys.has(
        `${e.user ?? ''}|${e.text.trim()}|${new Date(e.created_at).toISOString().slice(0, 16)}`
      )
  )

  // Entry reactions: every recorded note is reactable, not just real
  // comments — fetch this record's entry reactions and attach per entry.
  try {
    const entryReactions = (await db('nivaro_entry_reactions')
      .where({ collection, item: String(item) })
      .select('entry_key', 'user', 'emoji')) as Array<{
      entry_key: string
      user: string
      emoji: string
    }>
    if (entryReactions.length > 0) {
      const byKey = new Map<string, Array<{ emoji: string; count: number; mine: boolean }>>()
      for (const er of entryReactions) {
        const list = byKey.get(er.entry_key) ?? []
        let agg = list.find((a) => a.emoji === er.emoji)
        if (!agg) {
          agg = { emoji: er.emoji, count: 0, mine: false }
          list.push(agg)
        }
        agg.count++
        if (String(er.user).toUpperCase() === String(viewerId).toUpperCase()) agg.mine = true
        byKey.set(er.entry_key, list)
      }
      for (const e of deduped) {
        // Line comments already carry comment-FK reactions — don't clobber.
        if (!e.reactions || e.reactions.length === 0) {
          const list = byKey.get(e.id)
          if (list) e.reactions = list
        }
      }
    }
  } catch {
    /* reactions must never take the thread down */
  }

  const userIds = [...new Set(deduped.map((e) => e.user).filter((u): u is string => !!u))]
  const users = userIds.length
    ? ((await db('nivaro_users')
        .whereIn('id', userIds)
        .select('id', 'first_name', 'last_name', 'email')) as Array<Record<string, unknown>>)
    : []
  const byUser = new Map(users.map((u) => [String(u.id).toUpperCase(), u]))

  deduped.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())

  return deduped.map((e) => {
    const u = e.user ? byUser.get(e.user.toUpperCase()) : null
    return {
      ...e,
      user_name: u
        ? `${u.first_name ?? ''} ${u.last_name ?? ''}`.trim() || String(u.email ?? '')
        : null
    }
  })
}
