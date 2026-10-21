import type { FastifyInstance } from 'fastify'
import { adminBaseUrl } from '../admin-base.js'
import { db } from '../db/index.js'
import { runInBackgroundPool } from '../db/pool-context.js'
import { emitTrigger } from '../flows/registry.js'
import { hashSnapshot, layoutStateHash, type Snapshot } from './layout-versions.js'
import {
  diffForPeople,
  pickBaseVersion,
  summarizeOps,
  whatsNewCount,
  whatsNewLines
} from './layout-whats-new.js'
import { notifyUser } from './notification-channels.js'

/**
 * Layout watch, owner, "what's new" and the layout.updated trigger (#2655 #2656 #2657 #2667).
 *
 * No migration (DB freeze): a watch is a nivaro_notification_subscriptions row on the
 * collection 'nivaro_collection_layouts' with event_type 'layout_updated' and
 * filter_value = the layout id (that event type is never an item event, so the item
 * subscription hook never matches it, and it shows on the person's own subscriptions list).
 * The owner is nivaro_extension_settings ('nivaro-core', 'layout_owner:<id>'), the core
 * key/value home config-review and issue-groups use. What a person last saw of each form is
 * nivaro_users.preferences.layout_seen { <layout id>: { rev, at } }.
 */

export const LAYOUT_WATCH = {
  collection: 'nivaro_collection_layouts',
  event_type: 'layout_updated',
  filter_field: 'layout_id'
} as const

const CORE_EXT = 'nivaro-core'
const ownerKey = (layoutId: number) => `layout_owner:${layoutId}`
const OWNER_PREFIX = 'layout_owner:'

// ─── People ──────────────────────────────────────────────────────────────────

export interface PersonRef {
  id: string
  name: string
}

const same = (a: unknown, b: unknown) =>
  String(a ?? '').toUpperCase() === String(b ?? '').toUpperCase()

export async function peopleByIds(ids: string[]): Promise<Map<string, PersonRef>> {
  const out = new Map<string, PersonRef>()
  const unique = [...new Set(ids.filter(Boolean).map((i) => String(i).toUpperCase()))]
  if (unique.length === 0) return out
  const rows = (await db('nivaro_users')
    .whereIn('id', unique)
    .select('id', 'first_name', 'last_name', 'email')) as Array<{
    id: string
    first_name: string | null
    last_name: string | null
    email: string | null
  }>
  for (const r of rows) {
    const name = `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() || r.email || 'Someone'
    out.set(String(r.id).toUpperCase(), { id: String(r.id), name })
  }
  return out
}

// ─── Owner (#2656) ───────────────────────────────────────────────────────────

export async function getLayoutOwnerId(layoutId: number): Promise<string | null> {
  const row = (await db('nivaro_extension_settings')
    .where({ extension_id: CORE_EXT, key: ownerKey(layoutId) })
    .first('value')) as { value: string | null } | undefined
  return row?.value ? String(row.value) : null
}

export async function setLayoutOwnerId(layoutId: number, userId: string | null): Promise<void> {
  const key = ownerKey(layoutId)
  if (!userId) {
    await db('nivaro_extension_settings').where({ extension_id: CORE_EXT, key }).delete()
    return
  }
  const existing = (await db('nivaro_extension_settings')
    .where({ extension_id: CORE_EXT, key })
    .first('id')) as { id: number } | undefined
  if (existing)
    await db('nivaro_extension_settings')
      .where({ id: existing.id })
      .update({ value: userId, updated_at: new Date() })
  else
    await db('nivaro_extension_settings').insert({
      extension_id: CORE_EXT,
      key,
      value: userId,
      updated_at: new Date()
    })
}

/** Every named owner: layout id → owner user id. */
export async function listLayoutOwnerIds(): Promise<Map<number, string>> {
  const rows = (await db('nivaro_extension_settings')
    .where({ extension_id: CORE_EXT })
    .where('key', 'like', `${OWNER_PREFIX}%`)
    .select('key', 'value')) as Array<{ key: string; value: string | null }>
  const out = new Map<number, string>()
  for (const r of rows) {
    const id = Number(r.key.slice(OWNER_PREFIX.length))
    if (Number.isInteger(id) && r.value) out.set(id, String(r.value))
  }
  return out
}

// ─── Watch (#2655) ───────────────────────────────────────────────────────────

export async function layoutWatcherIds(layoutId: number): Promise<string[]> {
  const rows = (await db('nivaro_notification_subscriptions')
    .where({
      collection: LAYOUT_WATCH.collection,
      event_type: LAYOUT_WATCH.event_type,
      filter_field: LAYOUT_WATCH.filter_field,
      filter_value: String(layoutId),
      is_active: true
    })
    .select('user')) as Array<{ user: string }>
  return [...new Set(rows.map((r) => String(r.user)))]
}

export async function setLayoutWatch(
  layoutId: number,
  userId: string,
  on: boolean,
  label: string
): Promise<void> {
  const where = {
    user: userId,
    collection: LAYOUT_WATCH.collection,
    event_type: LAYOUT_WATCH.event_type,
    filter_field: LAYOUT_WATCH.filter_field,
    filter_value: String(layoutId)
  }
  if (!on) {
    await db('nivaro_notification_subscriptions').where(where).delete()
    return
  }
  const existing = (await db('nivaro_notification_subscriptions').where(where).first('id')) as
    | { id: number }
    | undefined
  if (existing) {
    await db('nivaro_notification_subscriptions')
      .where({ id: existing.id })
      .update({ is_active: true })
    return
  }
  await db('nivaro_notification_subscriptions').insert({
    ...where,
    label: label.slice(0, 255),
    is_active: true,
    digest_frequency: 'instant',
    notify_inapp: true,
    notify_email: false,
    created_at: new Date()
  })
}

/**
 * Who hears about a change to a form, owner first (#2656): the owner, then every watcher,
 * each once, never `exclude` (the person who made the change). Also the order #2609 change
 * requests use.
 */
export function ownerFirst(
  ownerId: string | null,
  watcherIds: string[],
  exclude?: string | null
): Array<{ userId: string; why: 'owner' | 'watch' }> {
  const out: Array<{ userId: string; why: 'owner' | 'watch' }> = []
  const seen = new Set<string>()
  const add = (id: string | null, why: 'owner' | 'watch') => {
    if (!id) return
    const k = id.toUpperCase()
    if (seen.has(k) || (exclude && same(id, exclude))) return
    seen.add(k)
    out.push({ userId: id, why })
  }
  add(ownerId, 'owner')
  for (const w of watcherIds) add(w, 'watch')
  return out
}

export async function layoutRecipients(
  layoutId: number,
  exclude?: string | null
): Promise<Array<{ userId: string; why: 'owner' | 'watch' }>> {
  const [owner, watchers] = await Promise.all([
    getLayoutOwnerId(layoutId),
    layoutWatcherIds(layoutId)
  ])
  return ownerFirst(owner, watchers, exclude)
}

/** The editor on this layout with History open — where a save notice lands. */
export function layoutHistoryUrl(collection: string, layoutId: number): string | null {
  const base = adminBaseUrl()
  if (!base) return null
  return `${base}/data-model/${encodeURIComponent(collection)}?tab=groups&layout=${layoutId}&history=1`
}

// ─── What a person last saw (#2657) ──────────────────────────────────────────

interface SeenEntry {
  rev: string
  at: string
}
const SEEN_KEY = 'layout_seen'
const SEEN_MAX = 200

function parsePrefs(raw: unknown): Record<string, unknown> {
  if (!raw) return {}
  if (typeof raw === 'object') return { ...(raw as Record<string, unknown>) }
  try {
    const v = JSON.parse(String(raw))
    return v && typeof v === 'object' ? v : {}
  } catch {
    return {}
  }
}

export async function readSeen(userId: string, layoutId: number): Promise<SeenEntry | null> {
  const row = (await db('nivaro_users').where({ id: userId }).first('preferences')) as
    | { preferences?: unknown }
    | undefined
  const map = parsePrefs(row?.preferences)[SEEN_KEY] as Record<string, SeenEntry> | undefined
  const e = map?.[String(layoutId)]
  return e && typeof e.rev === 'string' ? e : null
}

/** Fresh read, change, write; the newest SEEN_MAX forms are kept. */
export async function markSeen(userId: string, layoutId: number, rev: string): Promise<void> {
  const row = (await db('nivaro_users').where({ id: userId }).first('preferences')) as
    | { preferences?: unknown }
    | undefined
  if (!row) return
  const prefs = parsePrefs(row.preferences)
  const map = { ...((prefs[SEEN_KEY] as Record<string, SeenEntry> | undefined) ?? {}) }
  delete map[String(layoutId)]
  map[String(layoutId)] = { rev, at: new Date().toISOString() }
  const keys = Object.keys(map)
  for (const k of keys.slice(0, Math.max(0, keys.length - SEEN_MAX))) delete map[k]
  prefs[SEEN_KEY] = map
  await db('nivaro_users')
    .where({ id: userId })
    .update({ preferences: JSON.stringify(prefs) })
}

// The record page asks on every open; the layout's state hash is three small reads, kept
// for a few seconds so a burst of opens of one form shares them.
const revCache = new Map<number, { rev: string | null; at: number }>()
const REV_TTL_MS = 10_000

export async function currentLayoutRev(layoutId: number): Promise<string | null> {
  const hit = revCache.get(layoutId)
  if (hit && Date.now() - hit.at < REV_TTL_MS) return hit.rev
  const rev = await layoutStateHash(layoutId)
  if (revCache.size > 2000) revCache.clear()
  revCache.set(layoutId, { rev, at: Date.now() })
  return rev
}

export function forgetLayoutRev(layoutId: number): void {
  revCache.delete(layoutId)
}

export interface WhatsNewAnswer {
  rev: string | null
  /** Sentences for the note; null = nothing to show. */
  lines: string[] | null
  /** The client should record `rev` as seen without showing anything. */
  mark: boolean
  changed_at?: string | null
  changed_by?: string | null
}

async function currentSnapshot(layoutId: number): Promise<Snapshot | null> {
  const layout = (await db('nivaro_collection_layouts').where({ id: layoutId }).first()) as
    | Record<string, unknown>
    | undefined
  if (!layout) return null
  const groups = (await db('nivaro_field_groups')
    .where({ layout_id: layoutId })
    .orderBy([{ column: 'sort' }, { column: 'id' }])) as Array<Record<string, unknown>>
  const assignments = (await db('nivaro_layout_field_assignments')
    .where({ layout_id: layoutId })
    .orderBy([{ column: 'sort' }, { column: 'id' }])) as Array<Record<string, unknown>>
  return { layout, groups, assignments }
}

async function fieldLabels(collection: string): Promise<Map<string, string>> {
  const rows = (await db('nivaro_fields').where({ collection }).select('field', 'label')) as Array<{
    field: string
    label: string | null
  }>
  return new Map(rows.map((r) => [r.field, r.label ? String(r.label) : '']))
}

const humanize = (field: string) => field.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase())

/**
 * The note for a person opening a form: what moved, was added or removed since the state
 * they last saw. `mayRead` drops fields they cannot read.
 */
export async function whatsNewFor(
  userId: string,
  layoutId: number,
  mayRead: (field: string) => boolean
): Promise<WhatsNewAnswer> {
  const rev = await currentLayoutRev(layoutId)
  if (!rev) return { rev: null, lines: null, mark: false }
  const seen = await readSeen(userId, layoutId)
  // First open ever: nothing to compare with — remember this state quietly.
  if (!seen) return { rev, lines: null, mark: true }
  if (seen.rev === rev) return { rev, lines: null, mark: false }

  const rows = (await db('nivaro_layout_versions')
    .where({ layout_id: layoutId })
    .orderBy('version', 'asc')
    .select('id', 'snapshot', 'created_at', 'created_by')) as Array<{
    id: number
    snapshot: string
    created_at: Date | string | null
    created_by: string | null
  }>
  const versions = rows.flatMap((r) => {
    try {
      const snap = JSON.parse(r.snapshot) as Snapshot
      return [{ ...r, snap, hash: hashSnapshot(snap) }]
    } catch {
      return []
    }
  })
  const base = pickBaseVersion(versions, seen)
  const current = base ? await currentSnapshot(layoutId) : null
  if (!base || !current) return { rev, lines: null, mark: true }

  const labels = await fieldLabels(String(current.layout.collection ?? ''))
  const diff = diffForPeople(base.snap, current, {
    label: (field, p) =>
      (typeof p.label_override === 'string' && p.label_override.trim()) ||
      labels.get(field) ||
      humanize(field),
    mayRead
  })
  if (whatsNewCount(diff) === 0) return { rev, lines: null, mark: true }
  // Who and when: the newest save after the base (its own before-image's author).
  const after = versions.filter((v) => v.id >= base.id)
  const last = after[after.length - 1]
  const by = last?.created_by
    ? (await peopleByIds([last.created_by])).get(last.created_by.toUpperCase())
    : null
  return {
    rev,
    lines: whatsNewLines(diff),
    mark: false,
    changed_at: last?.created_at ? new Date(last.created_at).toISOString() : null,
    changed_by: by?.name ?? null
  }
}

// ─── After a save: notices, trigger, webhook (#2655 #2656 #2667) ─────────────

export interface LayoutSavedInput {
  layoutId: number
  userId: string | null | undefined
  /** The ops batch (a save) — summarised in counts. */
  ops?: unknown[]
  /** The person's version note, when they wrote one. */
  note?: string | null
  /** A summary that replaces the ops count (a version restore). */
  summary?: string
}

/** The flow trigger's payload (also the webhook body's data). */
export interface LayoutUpdatedPayload {
  layout_id: number
  layout_name: string
  collection: string
  op_summary: string
  op_count: number
  note: string | null
  user_id: string | null
  user_name: string | null
  history_url: string | null
}

export async function buildLayoutUpdatedPayload(
  input: LayoutSavedInput
): Promise<LayoutUpdatedPayload | null> {
  const layout = (await db('nivaro_collection_layouts')
    .where({ id: input.layoutId })
    .first('id', 'name', 'collection')) as
    | { id: number; name: string; collection: string }
    | undefined
  if (!layout) return null
  const saver = input.userId
    ? (await peopleByIds([input.userId])).get(input.userId.toUpperCase())
    : null
  const note = input.note?.trim() ? input.note.trim().slice(0, 255) : null
  return {
    layout_id: Number(layout.id),
    layout_name: String(layout.name),
    collection: String(layout.collection),
    op_summary: input.summary ?? summarizeOps(input.ops ?? []),
    op_count: input.ops?.length ?? 0,
    note,
    user_id: input.userId ?? null,
    user_name: saver?.name ?? null,
    history_url: layoutHistoryUrl(String(layout.collection), Number(layout.id))
  }
}

/** The notice one recipient gets. */
export function layoutSavedNotice(
  p: LayoutUpdatedPayload,
  why: 'owner' | 'watch'
): {
  subject: string
  message: string
  why: string
} {
  const who = p.user_name ?? 'Someone'
  const subject = `${who} changed the form “${p.layout_name}”`
  const message = `${p.op_summary}${p.note ? ` — “${p.note}”` : ''}. Open History to see what changed.`
  return {
    subject,
    message,
    why: why === 'owner' ? 'You own this form.' : 'You watch this form.'
  }
}

/**
 * Everything that follows a saved layout change, in the background: the saver's own
 * "what's new" is marked seen (they made the change), the owner and watchers are told
 * through notifyUser (owner first, never the saver), flows on `layout.updated` run, and
 * webhooks that name the Form layouts source are called. Never throws, never blocks the save.
 */
export function afterLayoutSaved(app: FastifyInstance, input: LayoutSavedInput): void {
  forgetLayoutRev(input.layoutId)
  void runInBackgroundPool(async () => {
    const payload = await buildLayoutUpdatedPayload(input)
    if (!payload) return
    if (input.userId) {
      const rev = await layoutStateHash(input.layoutId)
      if (rev) await markSeen(input.userId, input.layoutId, rev).catch(() => undefined)
    }
    const recipients = await layoutRecipients(input.layoutId, input.userId ?? null)
    for (const r of recipients) {
      const n = layoutSavedNotice(payload, r.why)
      await notifyUser(app, r.userId, {
        subject: n.subject,
        message: n.message,
        category: 'watch',
        sender: input.userId ?? null,
        why: n.why,
        source: { kind: 'layout-watch', label: payload.layout_name, id: payload.layout_id },
        target: payload.history_url ? { kind: 'external', url: payload.history_url } : null
      }).catch((err: unknown) =>
        app.log.warn({ err, layoutId: input.layoutId }, 'layout notice failed')
      )
    }
    emitTrigger('layout.updated', { ...payload }, app.log, input.userId ?? undefined)
    const { fireWebhooks } = await import('./webhook-dispatch.js')
    await fireWebhooks(
      LAYOUT_WATCH.collection,
      'update',
      { id: payload.layout_id, ...payload, event: 'layout.updated' },
      { origin: 'person', changed_fields: [], explicitOnly: true }
    )
  }).catch((err: unknown) =>
    app.log.warn({ err, layoutId: input.layoutId }, 'after layout save failed')
  )
}
