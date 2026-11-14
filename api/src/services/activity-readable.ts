import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'
import type { User } from '../types.js'
import {
  type ActivityApproval,
  type ActivityChange,
  type ActivityEntryInput,
  type ActivityJunctionLabel,
  type ActivityLabels,
  activityWhy,
  actorOf,
  choiceText,
  collectionNouns,
  renderActivitySentence
} from './activity-sentence.js'
import { selectInChunks } from './db-batch.js'
import { type JunctionInfo, loadJunctionMap } from './junction-map.js'

/**
 * The read side of the readable audit trail (migration 516): the extra columns a page of
 * activity rows selects (column-probed), what each row gains (changes, actor, why, badge),
 * and the labels a reader may see (POST /api/activity/labels).
 *
 * Cost: the page's own select gains its optional columns, the API key name (join) and the
 * update delta (join on the revision's activity index) — no extra round trip. The only extra
 * read is the linked approvals, one query per page and only when the page holds a transition
 * or an approval decision.
 */

/** Optional nivaro_activity columns, newest migration last; each probed per tenant. */
const OPTIONAL = [
  'origin',
  'chain_parent',
  'auth_method',
  'api_key_id',
  'mcp_conn',
  'via_app',
  'group_key',
  'actor'
] as const

export async function optionalActivityColumns(): Promise<Set<string>> {
  const have = await Promise.all(
    OPTIONAL.map((c) => hasColumn('nivaro_activity', c).catch(() => false))
  )
  return new Set(OPTIONAL.filter((_, i) => have[i]))
}

const SECRET_FIELD = /pass(word)?|secret|token|api_?key|totp|hash|salt/i
const MAX_CHANGES = 6

/** A revision delta → at most six field changes, values short and secrets dropped. */
export function changesFromDelta(delta: unknown): ActivityChange[] | null {
  let d: unknown = delta
  if (typeof delta === 'string') {
    try {
      d = JSON.parse(delta)
    } catch {
      return null
    }
  }
  if (!d || typeof d !== 'object' || Array.isArray(d)) return null
  const out: ActivityChange[] = []
  for (const [field, raw] of Object.entries(d as Record<string, unknown>)) {
    if (['updated_at', 'date_updated', 'user_updated', 'changed'].includes(field)) continue
    if (SECRET_FIELD.test(field)) {
      out.push({ field })
    } else if (raw == null || typeof raw !== 'object') {
      const v = typeof raw === 'string' && raw.length > 120 ? `${raw.slice(0, 117)}…` : raw
      out.push({ field, value: v ?? null })
    } else {
      out.push({ field })
    }
    if (out.length >= MAX_CHANGES) break
  }
  return out
}

type Row = Record<string, unknown> & ActivityEntryInput

/**
 * What every listed row gains: `changes` (from the update's revision delta), `actor` (stored
 * or derived), `why` (change reason / transition note / linked approval) and the agent badge.
 * Internal columns used only to derive them (delta, the badge source) are dropped.
 */
export function enrichActivityRow(
  row: Row,
  extras: { badge?: (viaApp: string | null) => string | null; approval?: ActivityApproval | null }
): Row {
  const { delta, ...rest } = row as Row & { delta?: unknown }
  const out: Row = { ...rest }
  if (rest.action === 'update' && delta != null) out.changes = changesFromDelta(delta)
  out.actor = actorOf(out)
  const why = activityWhy({ ...out, why: extras.approval ? { approval: extras.approval } : null })
  out.why = { reason: why.reason, note: why.note, approval: extras.approval ?? null }
  if (extras.badge && (out.mcp_conn || out.via_app))
    out.via_agent = extras.badge((out.via_app as string | null) ?? null)
  return out
}

const TRANSITION_ACTIONS = new Set(['transition', 'pipeline-transition'])
const MATCH_MS = 120_000

/** Linked approval decisions for a page: one query, matched by person + record + time. */
export async function approvalsForRows(rows: Row[]): Promise<Map<string, ActivityApproval>> {
  const out = new Map<string, ActivityApproval>()
  const instanceIds = new Set<number>()
  const pairs = new Map<string, { collection: string; item: string }>()
  let lo = Number.POSITIVE_INFINITY
  let hi = Number.NEGATIVE_INFINITY
  for (const r of rows) {
    const c = String(r.collection ?? '')
    const item = String(r.item ?? '')
    if (!c || !item) continue
    const isDecision = c === 'nivaro_approval_instances' && r.action === 'update'
    if (!isDecision && !TRANSITION_ACTIONS.has(String(r.action ?? ''))) continue
    if (isDecision && /^\d+$/.test(item)) instanceIds.add(Number(item))
    else if (!isDecision) pairs.set(`${c}\u0000${item}`, { collection: c, item })
    const t = r.timestamp ? new Date(r.timestamp).getTime() : Number.NaN
    if (Number.isFinite(t)) {
      lo = Math.min(lo, t)
      hi = Math.max(hi, t)
    }
  }
  if ((instanceIds.size === 0 && pairs.size === 0) || !Number.isFinite(lo)) return out
  let decisions: Array<Record<string, unknown>> = []
  try {
    // A day either side: decided_at is written as JS UTC, but older rows may hold the
    // server's local GETDATE() — the person + 2-minute match below is the real filter.
    const from = new Date(lo - 86_400_000)
    const to = new Date(hi + 86_400_000)
    const pairList = [...pairs.values()].slice(0, 200)
    decisions = (await db('nivaro_approval_decisions as d')
      .join('nivaro_approval_instances as i', 'i.id', 'd.instance')
      .leftJoin('nivaro_approval_chains as c', 'c.id', 'i.chain')
      .whereBetween('d.decided_at', [from, to])
      .where((q) => {
        if (instanceIds.size) q.orWhereIn('d.instance', [...instanceIds].slice(0, 500))
        for (const p of pairList)
          q.orWhere((w) => w.where('i.collection', p.collection).andWhere('i.item', p.item))
      })
      .select(
        'd.instance',
        'd.step_order',
        'd.user',
        'd.decision',
        'd.comment',
        'd.decided_at',
        'i.collection',
        'i.item',
        'c.name as chain_name'
      )
      .limit(1000)) as Array<Record<string, unknown>>
  } catch {
    return out
  }
  for (const r of rows) {
    const t = r.timestamp ? new Date(r.timestamp).getTime() : Number.NaN
    if (!Number.isFinite(t) || r.id == null) continue
    const c = String(r.collection ?? '')
    const item = String(r.item ?? '')
    const user = String(r.user ?? '').toUpperCase()
    const isDecision = c === 'nivaro_approval_instances'
    let best: Record<string, unknown> | null = null
    let bestGap = MATCH_MS + 1
    for (const d of decisions) {
      const same = isDecision
        ? String(d.instance) === item
        : String(d.collection) === c && String(d.item) === item
      if (!same || String(d.user ?? '').toUpperCase() !== user) continue
      const gap = Math.abs(new Date(d.decided_at as string).getTime() - t)
      if (gap < bestGap) {
        best = d
        bestGap = gap
      }
    }
    if (!best) continue
    out.set(String(r.id), {
      decision: String(best.decision ?? ''),
      comment: (best.comment as string | null) ?? null,
      chain: (best.chain_name as string | null) ?? null,
      step: best.step_order == null ? null : Number(best.step_order) + 1,
      collection: String(best.collection ?? ''),
      item: String(best.item ?? '')
    })
  }
  return out
}

// ─── Labels, read as the reader ─────────────────────────────────────────────

export const LABEL_LIMITS = { refs: 200, users: 200, fields: 200, collections: 100 }
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/

export interface LabelsRequest {
  refs?: Array<{ collection?: unknown; id?: unknown }>
  users?: unknown[]
  fields?: Array<{ collection?: unknown; field?: unknown }>
  collections?: unknown[]
}

export interface LabelDeps {
  canRead(user: User, collection: string): Promise<boolean>
  /** Ids among `ids` the reader may see (User Scopes, row filters, policies). */
  visibleIds(user: User, collection: string, ids: string[]): Promise<Set<string>>
  /** `collection:id` → label for records the reader may read. */
  recordLabels(
    user: User,
    refs: Array<{ collection: string; id: string }>
  ): Promise<Record<string, string>>
  people(ids: string[]): Promise<
    Array<{
      id: string
      first_name: string | null
      last_name: string | null
      is_redacted?: unknown
    }>
  >
  collections(
    names: string[]
  ): Promise<Array<{ collection: string; display_name: string | null; singular: string | null }>>
  fields(
    collections: string[]
  ): Promise<Array<{ collection: string; field: string; label: string | null; options: unknown }>>
  links(
    collections: string[]
  ): Promise<Array<{ many_collection: string; many_field: string; one_collection: string | null }>>
  /** Link (junction) tables → their parent and other leg. */
  junctions?(): Promise<Map<string, JunctionInfo>>
  /** `junction:id` → the row's parent id and linked id: the live row, else its newest
   *  revision snapshot (what was stored when it was removed). */
  junctionRows?(
    junctions: Map<string, JunctionInfo>,
    refs: Array<{ collection: string; id: string }>
  ): Promise<Map<string, JunctionRow>>
  /** File id → its title / file name. */
  fileNames?(ids: string[]): Promise<Map<string, string>>
  /** Addendums by id: title and the record each amends. */
  addendums?(ids: string[]): Promise<
    Array<{
      id: string
      title: string | null
      parent_collection: string | null
      parent_id: string | null
    }>
  >
  /** Notifications by id: subject and recipient. */
  notifications?(
    ids: string[]
  ): Promise<Array<{ id: string; subject: string | null; recipient: string | null }>>
  /** System rows by id, only `columns` (those that exist): the live row, else the newest
   *  revision snapshot of a deleted one. Never more columns than asked for. */
  systemRows?(
    table: string,
    ids: string[],
    columns: string[]
  ): Promise<Array<Record<string, unknown> & { id: unknown }>>
  /** Files the reader may open (services/file-access.ts): lower-cased id → title. */
  readableFiles?(user: User, isAdmin: boolean, ids: string[]): Promise<Map<string, string>>
  /** Chat channels the reader may see (canSeeRoom, admins included): key → name. */
  chatChannels?(user: User, keys: string[]): Promise<Map<string, string>>
}

export interface JunctionRow {
  parent: string | null
  target: string | null
  target_collection: string | null
}

const FILE_TABLES = new Set(['nivaro_files', 'directus_files'])

function snapshotKey(v: unknown): string | null {
  if (v == null) return null
  if (typeof v === 'object') {
    const id = (v as { id?: unknown }).id
    return id == null || typeof id === 'object' ? null : String(id)
  }
  return String(v)
}

async function readJunctionRows(
  junctions: Map<string, JunctionInfo>,
  refs: Array<{ collection: string; id: string }>
): Promise<Map<string, JunctionRow>> {
  const out = new Map<string, JunctionRow>()
  const by = new Map<string, string[]>()
  for (const r of refs) by.set(r.collection, [...(by.get(r.collection) ?? []), r.id])
  await Promise.all(
    [...by].map(async ([junction, ids]) => {
      const j = junctions.get(junction)
      if (!j) return
      const cols = [
        ...new Set(['id', j.parentFk, j.targetFk, j.discriminator].filter(Boolean))
      ] as string[]
      const take = (row: Record<string, unknown>, id: string) => {
        const tc = j.discriminator ? snapshotKey(row[j.discriminator]) : j.target
        out.set(`${junction}:${id}`, {
          parent: snapshotKey(row[j.parentFk]),
          target: j.targetFk ? snapshotKey(row[j.targetFk]) : null,
          target_collection: tc === 'directus_users' ? 'nivaro_users' : tc
        })
      }
      try {
        const live = (await db(junction)
          .whereIn('id', ids)
          .select(...cols)) as Array<Record<string, unknown>>
        for (const row of live) take(row, String(row.id))
      } catch {
        /* table gone: the snapshots below */
      }
      const missing = ids.filter((id) => !out.has(`${junction}:${id}`))
      if (!missing.length) return
      try {
        const snaps = (await db('nivaro_revisions')
          .where('collection', junction)
          .whereIn('item', missing)
          .whereNotNull('data')
          .orderBy('id', 'desc')
          .select('item', 'data')) as Array<{ item: string; data: string }>
        for (const s of snaps) {
          const id = String(s.item)
          if (out.has(`${junction}:${id}`)) continue
          try {
            take(JSON.parse(s.data) as Record<string, unknown>, id)
          } catch {
            /* unreadable snapshot */
          }
        }
      } catch {
        /* no snapshots: the sentence says "a Division" */
      }
    })
  )
  return out
}

// ─── System rows by name (Rob 2026-11-13: no activity line shows an internal id) ──

/**
 * How a system row (`nivaro_*`) is named in activity, and who may see that name.
 *
 * - No `owners` and no `parent`: configuration — administrators only.
 * - `owners`: a personal row — the people in those columns (and administrators).
 * - `parent`: a row that hangs off a record (comment, task, share link) — anyone who may
 *   see that record, read as the reader (the addendum rule); administrators always.
 *
 * Everyone else reads the generic phrase ("a saved view"), never the id. A table not
 * listed here is configuration named by the first of DEFAULT_NAME_COLUMNS it has.
 */
export interface SystemLabelSpec {
  /** Columns that name the row, first non-empty wins; a missing column is skipped. */
  name?: string[]
  /** Builds the name when no single column does (reads only `columns`). */
  compose?: (row: Record<string, unknown>) => string | null
  columns?: string[]
  /** People the row belongs to. */
  owners?: string[]
  /** The record the row hangs off: its collection column (or a fixed collection) + id column. */
  parent?: { collection?: string; fixedCollection?: string; item: string }
  /** Rows that are private to their own people + admins even though they hang off a record
   *  (support tickets in nivaro_tasks): the parent's visibility never names them. */
  privateWhen?: { column: string; values: string[] }
}

const DEFAULT_NAME_COLUMNS = ['name', 'title', 'label', 'subject', 'key', 'slug']

export const SYSTEM_LABELS: Record<string, SystemLabelSpec> = {
  // Personal rows: the owner and administrators.
  nivaro_saved_views: { name: ['name'], owners: ['user'] },
  nivaro_activity_views: { name: ['name'], owners: ['owner'] },
  nivaro_api_keys: { name: ['name'], owners: ['user'] },
  nivaro_notification_subscriptions: { name: ['label'], owners: ['user'] },
  nivaro_dashboards: { name: ['name'], owners: ['user'] },
  nivaro_report_defs: { name: ['name'], owners: ['owner'] },
  nivaro_queue_views: { name: ['name'], owners: ['user'] },
  nivaro_report_filter_presets: { name: ['name'], owners: ['user'] },
  nivaro_collection_presets: { name: ['name'], owners: ['user_id'] },
  nivaro_ai_conversations: { name: ['title'], owners: ['owner'] },
  nivaro_ai_proposals: { name: [], owners: ['user'] },
  nivaro_session_recordings: { name: [], owners: ['user'] },
  nivaro_replay_shares: { name: [], owners: ['shared_by', 'user_id'] },
  nivaro_replay_clips: { name: ['name'], owners: ['saved_by'] },
  nivaro_record_templates: { name: ['name'], owners: ['created_by'] },
  nivaro_drafts: { name: [], owners: ['user'] },
  nivaro_agent_triggers: { name: ['name'], owners: ['owner'] },
  nivaro_field_watches: { name: ['name'], owners: ['created_by'] },
  nivaro_help_videos: { name: ['title'], owners: ['created_by'] },
  nivaro_issues: { name: ['title'], owners: ['raised_by', 'assigned_to'] },
  // Rows on a record: as visible as that record (plus their own people).
  nivaro_tasks: {
    name: ['title'],
    owners: ['assignee', 'created_by'],
    parent: { collection: 'collection', item: 'item' },
    // A support ticket is the requester's and the desk's, not everyone's who reads the record
    // (security review 2026-11-13): named only for its own people and administrators.
    privateWhen: { column: 'kind', values: ['support'] }
  },
  nivaro_comments: {
    name: [],
    owners: ['user'],
    parent: { collection: 'collection', item: 'item' }
  },
  nivaro_agent_questions: {
    name: [],
    owners: ['asker', 'recipient'],
    parent: { collection: 'collection', item: 'item' }
  },
  nivaro_erp_submissions: { name: [], parent: { collection: 'collection', item: 'item' } },
  nivaro_workflow_instances: { name: [], parent: { collection: 'collection', item: 'item' } },
  nivaro_approval_instances: {
    name: [],
    owners: ['started_by'],
    parent: { collection: 'collection', item: 'item' }
  },
  nivaro_share_links: {
    name: [],
    owners: ['created_by'],
    parent: { collection: 'collection', item: 'item' }
  },
  nivaro_queue_claims: {
    name: [],
    owners: ['claimed_by'],
    parent: { collection: 'source_collection', item: 'item_id' }
  },
  // Configuration with no single name column.
  nivaro_policies: {
    columns: ['action', 'collection'],
    compose: (r) => {
      const a = String(r.action ?? '').trim()
      const c = String(r.collection ?? '').trim()
      return a && c ? `${a} on ${c}` : null
    }
  },
  nivaro_workflow_states: { name: ['label', 'key'] },
  nivaro_workflow_transitions: { name: ['label', 'group_label'] },
  nivaro_field_groups: { name: ['label', 'key'] },
  nivaro_import_definitions: { name: ['label', 'key'] },
  nivaro_inbound_mappings: { name: ['label', 'key'] },
  nivaro_payload_templates: { name: ['label', 'key'] },
  nivaro_import_queue: { name: [] },
  nivaro_activity: { name: [] },
  nivaro_api_logs: { name: [] },
  nivaro_settings: { name: [] }
}

/** Handled elsewhere: people, addendums and notifications above, files and channels below. */
const SYSTEM_SPECIAL = new Set([
  'nivaro_users',
  'directus_users',
  'nivaro_addendums',
  'nivaro_notifications',
  'nivaro_files',
  'directus_files',
  'nivaro_chat_channels'
])
const SYSTEM_TABLE = /^(nivaro|directus)_/i
const SAFE_COLUMN = /^[a-z_][a-z0-9_]*$/i
const UUID_LIKE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function systemLabelSpec(table: string): SystemLabelSpec {
  return SYSTEM_LABELS[table] ?? { name: DEFAULT_NAME_COLUMNS }
}

/** Every column a spec reads besides id — never a credential. */
function specColumns(spec: SystemLabelSpec): string[] {
  const cols = [
    ...(spec.name ?? []),
    ...(spec.columns ?? []),
    ...(spec.owners ?? []),
    ...(spec.parent?.collection ? [spec.parent.collection] : []),
    ...(spec.parent ? [spec.parent.item] : []),
    ...(spec.privateWhen ? [spec.privateWhen.column] : [])
  ]
  return [...new Set(cols)].filter((c) => SAFE_COLUMN.test(c) && !SECRET_FIELD.test(c))
}

/** A short, quoted name — never an id, never empty. */
function quotedName(raw: unknown, id: string): string | null {
  if (raw == null || typeof raw === 'object') return null
  const s = String(raw).trim()
  if (!s || s.toLowerCase() === id.toLowerCase() || UUID_LIKE.test(s) || /^\d+$/.test(s))
    return null
  return `“${s.length > 120 ? `${s.slice(0, 117)}…` : s}”`
}

function nameOfRow(spec: SystemLabelSpec, row: Record<string, unknown>, id: string): string | null {
  if (spec.compose) return quotedName(spec.compose(row), id)
  for (const c of spec.name ?? []) {
    const n = quotedName(row[c], id)
    if (n) return n
  }
  return null
}

/** The record a row hangs off, as stored on it. */
function parentOf(
  spec: SystemLabelSpec,
  row: Record<string, unknown>
): { collection: string; id: string } | null {
  if (!spec.parent) return null
  const collection = spec.parent.fixedCollection ?? String(row[spec.parent.collection ?? ''] ?? '')
  const raw = row[spec.parent.item]
  const id = raw == null || typeof raw === 'object' ? '' : String(raw).trim()
  if (!collection || !IDENT.test(collection) || !id || id.length > 100) return null
  return { collection, id }
}

async function readSystemRows(
  table: string,
  ids: string[],
  columns: string[]
): Promise<Array<Record<string, unknown> & { id: unknown }>> {
  if (!SYSTEM_TABLE.test(table) || !IDENT.test(table)) return []
  const have = await Promise.all(columns.map((c) => hasColumn(table, c).catch(() => false)))
  const cols = columns.filter((_, i) => have[i])
  const pick = (r: Record<string, unknown>, id: unknown) => {
    const out: Record<string, unknown> & { id: unknown } = { id }
    for (const c of cols) out[c] = r[c]
    return out
  }
  const read = (list: string[]) =>
    selectInChunks(list, 500, (chunk) =>
      Promise.resolve(
        db(table)
          .whereIn('id', chunk)
          .select('id', ...cols)
      )
    ) as Promise<Array<Record<string, unknown>>>
  let live: Array<Record<string, unknown>> = []
  try {
    live = await read(ids)
  } catch {
    // An int id column refuses a uuid: try the numeric ids alone.
    const nums = ids.filter((i) => /^\d+$/.test(i))
    live = nums.length && nums.length < ids.length ? await read(nums).catch(() => []) : []
  }
  const out = live.map((r) => pick(r, r.id))
  const seen = new Set(out.map((r) => String(r.id).toLowerCase()))
  const missing = ids.filter((i) => !seen.has(i.toLowerCase()))
  if (!missing.length) return out
  // Deleted: the newest revision snapshot, when the table keeps them.
  try {
    const snaps = (await db('nivaro_revisions')
      .where('collection', table)
      .whereIn('item', missing.slice(0, 500))
      .whereNotNull('data')
      .orderBy('id', 'desc')
      .select('item', 'data')
      .limit(1000)) as Array<{ item: unknown; data: string }>
    for (const s of snaps) {
      const id = String(s.item)
      if (seen.has(id.toLowerCase())) continue
      try {
        const data = JSON.parse(s.data) as Record<string, unknown>
        // Snapshot columns are not probed: read only the asked names.
        const row: Record<string, unknown> & { id: unknown } = { id }
        for (const c of columns) row[c] = data?.[c]
        out.push(row)
        seen.add(id.toLowerCase())
      } catch {
        /* unreadable snapshot: generic */
      }
    }
  } catch {
    /* no snapshots: generic */
  }
  return out
}

async function readReadableFiles(
  user: User,
  isAdmin: boolean,
  ids: string[]
): Promise<Map<string, string>> {
  const uuids = ids.filter((i) => UUID_LIKE.test(i))
  if (!uuids.length) return new Map()
  const rows = (await selectInChunks(uuids, 500, (chunk) =>
    Promise.resolve(
      db('nivaro_files')
        .whereIn('id', chunk)
        .select('id', 'title', 'filename_download', 'uploaded_by', 'uploaded_on')
    )
  )) as Array<Record<string, unknown> & { id: unknown }>
  if (!rows.length) return new Map()
  const { readableFileIds } = await import('./file-access.js')
  const ok = await readableFileIds(rows, { user, isAdmin, workspaceId: undefined } as never)
  const out = new Map<string, string>()
  for (const r of rows) {
    const id = String(r.id).toLowerCase()
    if (!ok.has(id)) continue
    const name = String(r.title || r.filename_download || '').trim()
    if (name) out.set(id, name)
  }
  return out
}

async function readChatChannels(user: User, keys: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const { canSeeRoom, channelsWith } = await import('./chat.js')
  // Chat's own audit rows name the General room this way (routes/chat.ts).
  if (keys.includes('__general__')) out.set('__general__', 'General')
  const wanted = keys.filter((k) => k !== '__general__' && /^[A-Za-z0-9_-]{1,100}$/.test(k))
  if (!wanted.length) return out
  const channels = await channelsWith(wanted)
  const cache = new Map<string, boolean>()
  await Promise.all(
    wanted.map(async (k) => {
      const ch = channels.get(k)
      if (!ch) return
      if (!(await canSeeRoom(user, `ch:${k}`, cache).catch(() => false))) return
      const name = String(ch.name ?? '').trim()
      if (name) out.set(k, name)
    })
  )
  return out
}

const defaultLabelDeps: LabelDeps = {
  systemRows: readSystemRows,
  readableFiles: readReadableFiles,
  chatChannels: readChatChannels,
  async canRead(user, collection) {
    const { can } = await import('./permissions.js')
    return can(user, 'read', collection)
  },
  async visibleIds(user, collection, ids) {
    const { readItems } = await import('./items.js')
    const res = (await readItems(user, collection, {
      filter: { id: { _in: ids } },
      fields: ['id'],
      limit: ids.length,
      count: false
    } as Parameters<typeof readItems>[2])) as unknown as { data?: Array<{ id: unknown }> }
    return new Set((res.data ?? []).map((r) => String(r.id).toLowerCase()))
  },
  async recordLabels(user, refs) {
    const { recordLabelsAsViewer } = await import('./record-labels-as-viewer.js')
    return recordLabelsAsViewer(user, refs)
  },
  async people(ids) {
    return (await selectInChunks(ids, 500, (chunk) =>
      Promise.resolve(
        db('nivaro_users')
          .whereIn('id', chunk)
          .select('id', 'first_name', 'last_name', 'is_redacted')
      )
    )) as Array<{
      id: string
      first_name: string | null
      last_name: string | null
      is_redacted?: unknown
    }>
  },
  async collections(names) {
    if (!names.length) return []
    const singular = await hasColumn('nivaro_collections', 'singular').catch(() => false)
    return (await db('nivaro_collections')
      .whereIn('collection', names)
      .select('collection', 'display_name', ...(singular ? ['singular'] : []))) as Array<{
      collection: string
      display_name: string | null
      singular: string | null
    }>
  },
  async fields(collections) {
    if (!collections.length) return []
    return (await db('nivaro_fields')
      .whereIn('collection', collections)
      .select('collection', 'field', 'label', 'options')) as Array<{
      collection: string
      field: string
      label: string | null
      options: unknown
    }>
  },
  async links(collections) {
    if (!collections.length) return []
    return (await db('nivaro_relations')
      .whereIn('many_collection', collections)
      .whereNotNull('many_field')
      .select('many_collection', 'many_field', 'one_collection')) as Array<{
      many_collection: string
      many_field: string
      one_collection: string | null
    }>
  },
  junctions: () => loadJunctionMap(),
  junctionRows: readJunctionRows,
  async addendums(ids) {
    const rows = (await selectInChunks(ids, 500, (chunk) =>
      Promise.resolve(
        db('nivaro_addendums')
          .whereIn('id', chunk)
          .select('id', 'title', 'parent_collection', 'parent_id')
      )
    )) as Array<{
      id: unknown
      title: string | null
      parent_collection: string | null
      parent_id: unknown
    }>
    return rows.map((r) => ({
      id: String(r.id),
      title: r.title,
      parent_collection: r.parent_collection,
      parent_id: r.parent_id == null ? null : String(r.parent_id)
    }))
  },
  async notifications(ids) {
    const nums = ids.filter((i) => /^\d+$/.test(i))
    if (!nums.length) return []
    const rows = (await selectInChunks(nums, 500, (chunk) =>
      Promise.resolve(
        db('nivaro_notifications').whereIn('id', chunk).select('id', 'subject', 'recipient')
      )
    )) as Array<{ id: unknown; subject: string | null; recipient: unknown }>
    return rows.map((r) => ({
      id: String(r.id),
      subject: r.subject,
      recipient: r.recipient == null ? null : String(r.recipient)
    }))
  },
  async fileNames(ids) {
    const rows = (await selectInChunks(ids, 500, (chunk) =>
      Promise.resolve(
        db('nivaro_files').whereIn('id', chunk).select('id', 'title', 'filename_download')
      )
    )) as Array<{ id: string; title: string | null; filename_download: string | null }>
    return new Map(
      rows.map((r) => [
        String(r.id).toLowerCase(),
        String(r.title || r.filename_download || '').trim()
      ])
    )
  }
}

function choicesOf(options: unknown): Record<string, string> | null {
  let o: unknown = options
  if (typeof options === 'string') {
    try {
      o = JSON.parse(options)
    } catch {
      return null
    }
  }
  if (!o || typeof o !== 'object') return null
  const list = Array.isArray(o)
    ? o
    : ((o as { choices?: unknown; options?: unknown }).choices ??
      (o as { options?: unknown }).options)
  if (!Array.isArray(list)) return null
  const out: Record<string, string> = {}
  for (const c of list as Array<Record<string, unknown>>) {
    if (!c || c.value == null) continue
    out[String(c.value)] = choiceText(String(c.text ?? c.label ?? c.value))
  }
  return Object.keys(out).length ? out : null
}

function titleOf(field: string): string {
  return field
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ')
}

/**
 * Labels for an activity page, read AS `user`. A record the reader cannot see is `null`
 * ("a record you can't see") — never its label, never a hint beyond that. People: first +
 * last name only (directory columns), never a redacted account. Collection, field and
 * choice labels only for collections the reader may read. Never throws.
 */
export async function activityLabelsFor(
  user: User,
  body: LabelsRequest,
  opts: { isAdmin?: boolean } = {},
  deps: LabelDeps = defaultLabelDeps
): Promise<ActivityLabels> {
  const admin = opts.isAdmin === true
  const refs = (Array.isArray(body.refs) ? body.refs : [])
    .map((r) => ({ collection: String(r?.collection ?? ''), id: String(r?.id ?? '').trim() }))
    .filter((r) => IDENT.test(r.collection) && r.id && r.id.length <= 100)
    .slice(0, LABEL_LIMITS.refs)
  // Link rows: what each one links, from the row as stored (live, else its snapshot). The
  // parent and the linked record join the refs and are judged as the reader below.
  const jmap =
    refs.length && deps.junctions
      ? await deps.junctions().catch(() => new Map<string, JunctionInfo>())
      : new Map<string, JunctionInfo>()
  // Only link tables the reader may read: a link row is never read on someone's behalf
  // when its own table is closed to them (security review 2026-11-13).
  const linkTables = [...new Set(refs.map((r) => r.collection).filter((c) => jmap.has(c)))]
  const openLinkTables = new Set<string>()
  await Promise.all(
    linkTables.map(async (c) => {
      if (admin || (await deps.canRead(user, c).catch(() => false))) openLinkTables.add(c)
    })
  )
  const linkRefs = refs.filter((r) => openLinkTables.has(r.collection))
  // Parents and linked records join the refs below; they stay inside a fixed budget.
  const refBudget = LABEL_LIMITS.refs * 3
  const storedLinks =
    linkRefs.length && deps.junctionRows
      ? await deps.junctionRows(jmap, linkRefs).catch(() => new Map<string, JunctionRow>())
      : new Map<string, JunctionRow>()
  const fileIds = new Set<string>()
  const linkCollections = new Set<string>()
  for (const r of linkRefs) {
    const row = storedLinks.get(`${r.collection}:${r.id}`)
    const j = jmap.get(r.collection)!
    if (
      row?.parent &&
      refs.length < refBudget &&
      !refs.some((x) => x.collection === j.parent && x.id === row.parent)
    )
      refs.push({ collection: j.parent, id: row.parent })
    if (row?.target && row.target_collection) {
      if (FILE_TABLES.has(row.target_collection)) fileIds.add(row.target)
      else if (
        refs.length < refBudget &&
        !refs.some((x) => x.collection === row.target_collection && x.id === row.target)
      )
        refs.push({ collection: row.target_collection, id: row.target })
    }
    linkCollections.add(j.parent)
    const tc = row?.target_collection ?? j.target
    if (tc && !FILE_TABLES.has(tc)) linkCollections.add(tc)
  }
  // Addendums and notifications are system rows people still speak of by name (Rob
  // 2026-11-13: "Approved Addendum 867F8CB1-…"). An addendum is named by its title and the
  // record it amends — only as visible as that record; a notification by its subject — only
  // to administrators and its own recipient.
  const addendumRefs = refs.filter((r) => r.collection === 'nivaro_addendums')
  const notificationRefs = refs.filter((r) => r.collection === 'nivaro_notifications')
  const addendumRows =
    addendumRefs.length && deps.addendums
      ? await deps.addendums(addendumRefs.map((r) => r.id)).catch(() => [])
      : []
  const addendumById = new Map(addendumRows.map((a) => [a.id.toLowerCase(), a]))
  for (const a of addendumRows) {
    if (
      a.parent_collection &&
      a.parent_id &&
      IDENT.test(a.parent_collection) &&
      refs.length < refBudget &&
      !refs.some((x) => x.collection === a.parent_collection && x.id === a.parent_id)
    )
      refs.push({ collection: a.parent_collection, id: a.parent_id })
  }
  // Every other system row (saved views, layouts, tasks, comments, …): read once per table,
  // in at most two rounds (a comment on a task needs the task). Business parents join the
  // refs and are judged as the reader below, like an addendum's record.
  const isRegistrySystem = (c: string) =>
    SYSTEM_TABLE.test(c) && !SYSTEM_SPECIAL.has(c) && !jmap.has(c)
  const sysRows = new Map<string, Record<string, unknown>>()
  const sysAsked = new Set<string>()
  let pendingSys = deps.systemRows ? refs.filter((r) => isRegistrySystem(r.collection)) : []
  for (let round = 0; round < 2 && pendingSys.length; round++) {
    const byTable = new Map<string, string[]>()
    for (const r of pendingSys) {
      const k = `${r.collection}:${r.id}`
      if (sysAsked.has(k)) continue
      sysAsked.add(k)
      byTable.set(r.collection, [...(byTable.get(r.collection) ?? []), r.id])
    }
    const next: Array<{ collection: string; id: string }> = []
    await Promise.all(
      [...byTable].map(async ([table, ids]) => {
        const spec = systemLabelSpec(table)
        const rows = await deps.systemRows!(table, ids, specColumns(spec)).catch(() => [])
        for (const row of rows) {
          const id = ids.find((i) => i.toLowerCase() === String(row.id).toLowerCase())
          if (!id) continue
          sysRows.set(`${table}:${id}`, row)
          const p = parentOf(spec, row)
          if (!p) continue
          if (isRegistrySystem(p.collection)) {
            if (!sysAsked.has(`${p.collection}:${p.id}`)) next.push(p)
          } else if (
            !SYSTEM_TABLE.test(p.collection) &&
            refs.length < refBudget &&
            !refs.some((x) => x.collection === p.collection && x.id === p.id)
          )
            refs.push(p)
        }
      })
    )
    pendingSys = next
  }
  const userIds = new Set(
    (Array.isArray(body.users) ? body.users : [])
      .map((u) => String(u ?? '').trim())
      .filter((u) => /^[0-9a-f-]{36}$/i.test(u))
      .slice(0, LABEL_LIMITS.users)
  )
  const fieldAsks = (Array.isArray(body.fields) ? body.fields : [])
    .map((f) => ({ collection: String(f?.collection ?? ''), field: String(f?.field ?? '') }))
    .filter((f) => IDENT.test(f.collection) && IDENT.test(f.field))
    .slice(0, LABEL_LIMITS.fields)
  const collNames = new Set(
    [
      ...(Array.isArray(body.collections) ? body.collections : []).map((c) => String(c ?? '')),
      ...refs.map((r) => r.collection),
      ...linkCollections,
      ...fieldAsks.map((f) => f.collection)
    ].filter((c) => IDENT.test(c))
  )
  const names = [...collNames].slice(0, LABEL_LIMITS.collections)

  // Which collections the reader may read at all — everything below hangs off it.
  const readable = new Set<string>()
  await Promise.all(
    names.map(async (c) => {
      if (c === 'nivaro_users') return
      if (admin || (await deps.canRead(user, c).catch(() => false))) readable.add(c)
    })
  )

  const labels: Required<
    Pick<ActivityLabels, 'users' | 'records' | 'collections' | 'fields' | 'choices' | 'links'>
  > = {
    users: {},
    records: {},
    collections: {},
    fields: {},
    choices: {},
    links: {}
  }

  // Records: visible ids per collection (read as the reader), then their labels.
  const byCollection = new Map<string, string[]>()
  for (const r of refs) {
    if (r.collection === 'nivaro_users' || r.collection === 'directus_users') {
      userIds.add(r.id)
      continue
    }
    // System rows are named below by their own rules, never read as items.
    if (SYSTEM_TABLE.test(r.collection) && !jmap.has(r.collection)) continue
    const list = byCollection.get(r.collection) ?? []
    list.push(r.id)
    byCollection.set(r.collection, list)
  }
  const visible: Array<{ collection: string; id: string }> = []
  await Promise.all(
    [...byCollection].map(async ([collection, ids]) => {
      const seen = readable.has(collection)
        ? await deps.visibleIds(user, collection, ids).catch(() => new Set<string>())
        : new Set<string>()
      for (const id of ids) {
        if (seen.has(id.toLowerCase())) visible.push({ collection, id })
        // Gone (deleted) for an administrator, who could read any row: the id is no secret.
        else labels.records[`${collection}:${id}`] = admin && readable.has(collection) ? id : null
      }
    })
  )
  const found = visible.length
    ? await deps.recordLabels(user, visible).catch(() => ({}) as Record<string, string>)
    : {}

  const [people, colls, fieldRows, linkRows] = await Promise.all([
    userIds.size ? deps.people([...userIds]).catch(() => []) : Promise.resolve([]),
    deps.collections(names).catch(() => []),
    deps.fields([...readable]).catch(() => []),
    deps.links([...readable]).catch(() => [])
  ])
  const collTitle = new Map<string, string>()
  for (const c of colls) {
    if (c.collection !== 'nivaro_users' && !readable.has(c.collection)) continue
    const display = String(c.display_name ?? '').trim()
    const singular = String(c.singular ?? '').trim()
    if (display || singular)
      labels.collections[c.collection] = { singular: singular || null, plural: display || null }
    collTitle.set(c.collection, display || titleOf(c.collection))
  }
  for (const v of visible) {
    const key = `${v.collection}:${v.id}`
    const label = String((found as Record<string, string>)[key] ?? '').trim()
    // recordLabelsAsViewer's last resort is the collection's own name — the id reads better.
    labels.records[key] = !label || label === collTitle.get(v.collection) ? v.id : label
  }
  for (const p of people) {
    if (p.is_redacted === true || p.is_redacted === 1) continue
    const name = [p.first_name, p.last_name].filter(Boolean).join(' ').trim()
    if (name) labels.users[String(p.id).toUpperCase()] = name
  }
  for (const r of addendumRefs) {
    const a = addendumById.get(r.id.toLowerCase())
    const key = `nivaro_addendums:${r.id}`
    if (!a) {
      labels.records[key] = null
      continue
    }
    const parentKey = `${a.parent_collection}:${a.parent_id}`
    const parent = labels.records[parentKey]
    if (parent == null && !admin) {
      labels.records[key] = null
      continue
    }
    const title = String(a.title ?? '').trim()
    const on = parent && parent !== a.parent_id ? parent : null
    labels.records[key] =
      [title ? `“${title}”` : '', on ? `on ${on}` : ''].filter(Boolean).join(' ') || null
  }
  if (notificationRefs.length && deps.notifications) {
    const rows = await deps
      .notifications(notificationRefs.map((r) => r.id))
      .catch(() => [] as Array<{ id: string; subject: string | null; recipient: string | null }>)
    const byId = new Map(rows.map((n) => [n.id, n]))
    for (const r of notificationRefs) {
      const n = byId.get(r.id)
      const mine = !!n?.recipient && n.recipient.toUpperCase() === String(user.id).toUpperCase()
      const subject = String(n?.subject ?? '').trim()
      labels.records[`nivaro_notifications:${r.id}`] =
        n && subject && (admin || mine) ? `“${subject.slice(0, 120)}”` : null
    }
  }
  // A person named as the record ("changed the role of Pat"): the same directory name.
  for (const r of refs) {
    if (r.collection !== 'nivaro_users' && r.collection !== 'directus_users') continue
    const name = labels.users[r.id.toUpperCase()]
    if (name) labels.records[`${r.collection}:${r.id}`] = name
  }
  // Files and chat channels: as the file-access gate and canSeeRoom say.
  const fileRefs = refs.filter((r) => FILE_TABLES.has(r.collection))
  if (fileRefs.length) {
    const names = deps.readableFiles
      ? await deps
          .readableFiles(
            user,
            admin,
            fileRefs.map((r) => r.id)
          )
          .catch(() => new Map<string, string>())
      : new Map<string, string>()
    for (const r of fileRefs)
      labels.records[`${r.collection}:${r.id}`] = quotedName(names.get(r.id.toLowerCase()), r.id)
  }
  const channelRefs = refs.filter((r) => r.collection === 'nivaro_chat_channels')
  if (channelRefs.length) {
    const names = deps.chatChannels
      ? await deps
          .chatChannels(
            user,
            channelRefs.map((r) => r.id)
          )
          .catch(() => new Map<string, string>())
      : new Map<string, string>()
    for (const r of channelRefs) {
      const n = names.get(r.id)
      labels.records[`nivaro_chat_channels:${r.id}`] = n ? `#${n.replace(/^#/, '')}` : null
    }
  }
  // Every other system row: its name only for whom the registry says, else generic.
  const me = String(user.id ?? '').toUpperCase()
  const sysMemo = new Map<string, string | null>()
  const systemLabel = (table: string, id: string, depth: number): string | null => {
    const key = `${table}:${id}`
    if (sysMemo.has(key)) return sysMemo.get(key) ?? null
    sysMemo.set(key, null) // cycle guard
    const row = sysRows.get(key)
    let out: string | null = null
    if (row) {
      const spec = systemLabelSpec(table)
      const mine =
        !!me && (spec.owners ?? []).some((c) => String(row[c] ?? '').toUpperCase() === me)
      const p = parentOf(spec, row)
      let parentText: string | null = null
      let parentVisible = false
      if (p) {
        if (isRegistrySystem(p.collection)) {
          const pl = depth < 2 ? systemLabel(p.collection, p.id, depth + 1) : null
          parentVisible = pl != null
          if (pl) parentText = `${collectionNouns(p.collection, null).singular} ${pl}`
        } else if (!SYSTEM_TABLE.test(p.collection)) {
          const pl = labels.records[`${p.collection}:${p.id}`]
          parentVisible = pl !== null && pl !== undefined
          if (pl && pl !== p.id && !UUID_LIKE.test(pl)) parentText = pl
        }
      }
      const isPrivate =
        !!spec.privateWhen &&
        spec.privateWhen.values.includes(String(row[spec.privateWhen.column] ?? ''))
      if (admin || mine || (parentVisible && !isPrivate)) {
        const name = nameOfRow(spec, row, id)
        out = [name ?? '', parentText ? `on ${parentText}` : ''].filter(Boolean).join(' ') || null
      }
    }
    sysMemo.set(key, out)
    return out
  }
  for (const r of refs) {
    if (!isRegistrySystem(r.collection)) continue
    labels.records[`${r.collection}:${r.id}`] = systemLabel(r.collection, r.id, 0)
  }
  const asked = new Set(fieldAsks.map((f) => `${f.collection}.${f.field}`))
  for (const f of fieldRows) {
    const key = `${f.collection}.${f.field}`
    if (!asked.has(key)) continue
    labels.fields[key] = String(f.label ?? '').trim() || titleOf(f.field)
    const choices = choicesOf(f.options)
    if (choices) labels.choices[key] = choices
  }
  // Asked-for fields without a config row still get a readable label.
  for (const f of fieldAsks)
    if (readable.has(f.collection) && !labels.fields[`${f.collection}.${f.field}`])
      labels.fields[`${f.collection}.${f.field}`] = titleOf(f.field)
  for (const l of linkRows) {
    const key = `${l.many_collection}.${l.many_field}`
    if (asked.has(key)) labels.links[key] = String(l.one_collection ?? '') || 'record'
  }
  // Link rows in words: parent + the linked record's name, each as the reader may see it.
  if (linkRefs.length) {
    const parentVisible = (c: string, id: string) => {
      const v = labels.records[`${c}:${id}`]
      return v !== null && v !== undefined
    }
    const files =
      fileIds.size && deps.fileNames
        ? await deps.fileNames([...fileIds]).catch(() => new Map<string, string>())
        : new Map<string, string>()
    const junctionLabels: Record<string, ActivityJunctionLabel> = {}
    for (const r of linkRefs) {
      const j = jmap.get(r.collection)!
      const row = storedLinks.get(`${r.collection}:${r.id}`)
      const tc = row?.target_collection ?? j.target
      const file = !!tc && FILE_TABLES.has(tc)
      const parentId = row?.parent ?? null
      // Not visible / unknown parent: the sentence says "a workflow record"; a value is then
      // never shown either (a file or a link is only as visible as its record).
      const parentOk = !!parentId && parentVisible(j.parent, parentId)
      let value: string | null = null
      if (row?.target && tc && (parentOk || admin)) {
        if (file) value = files.get(row.target.toLowerCase()) || null
        else if (tc === 'nivaro_users') value = labels.users[row.target.toUpperCase()] ?? null
        else {
          const v = labels.records[`${tc}:${row.target}`]
          value = v && v !== row.target ? v : null
        }
      }
      if (!parentOk && !admin) value = null
      const noun = file
        ? 'file'
        : tc
          ? collectionNouns(tc, { collections: labels.collections }).singular
          : j.alias
            ? collectionNouns(j.alias, null).singular
            : 'link'
      junctionLabels[`${r.collection}:${r.id}`] = {
        parent_collection: j.parent,
        // Which record the link was on is itself private when the reader cannot see it.
        parent_id: parentOk || admin ? parentId : null,
        noun,
        value,
        file
      }
    }
    return { ...labels, junctions: junctionLabels }
  }
  return labels
}

/**
 * Sentences for activity rows as `user` reads them — the email digest's entry point (one
 * labels read for the whole batch, every record judged as the recipient).
 */
export async function activitySentencesFor(
  user: User,
  rows: ActivityEntryInput[],
  opts: { timeZone?: string | null } = {}
): Promise<string[]> {
  const { activityLabelRefs } = await import('./activity-sentence.js')
  const { isAdminRole } = await import('./permissions.js')
  const isAdmin = await isAdminRole(user).catch(() => false)
  const labels = await activityLabelsFor(user, activityLabelRefs(rows), { isAdmin })
  return rows.map((r) => renderActivitySentence(r, { ...labels, timeZone: opts.timeZone ?? null }))
}
