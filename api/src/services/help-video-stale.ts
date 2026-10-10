import { adminBaseUrl } from '../admin-base.js'
import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'
import type { User } from '../types.js'
import { logActivity } from './activity.js'
import type { RecordedClick } from './help-video-walk.js'
import { getApp } from './io-holder.js'

// Videos that may be out of date (#1495). A nightly check (server.ts,
// help-video-stale-check) looks at every published video and marks it when,
// since its published version was created:
//   (a) a layout of a collection it shows on got a new version,
//   (b) a pipeline step it covers (a context's state_key) was renamed or
//       removed, judged from the template's version snapshots, or
//   (c) a click label the recording carries is no longer among the labels
//       the client reported for that page key (POST /help-videos/pages with
//       `labels`), for pages reported in the last LABEL_WINDOW_DAYS days.
// The judgement itself (judgeStale) is pure; small loaders feed it. The flag
// lives on nivaro_help_videos.stale_reason (JSON {kind, detail, since}) and
// stale_dismissed_at (migration 415). The author is told once; the flag
// stands until someone publishes again (publishVideo clears it) or dismisses
// it (POST /help-videos/:id/stale/dismiss, authors). A dismissed reason is not
// raised again for the same change.

export type StaleKind = 'layout' | 'state' | 'label'
export interface StaleReason {
  kind: StaleKind
  /** One plain sentence naming the change (no trailing full stop). */
  detail: string
  /** When the change happened (ISO). */
  since: string
}

export const LABEL_WINDOW_DAYS = 14
export const LABEL_LIMITS = { labels: 300, label: 80 }

export interface StaleFacts {
  published_at: Date
  contexts: Array<{ kind: 'collection' | 'page'; key: string; state_key: string | null }>
  clicks: RecordedClick[] | null
}
export interface StaleWorld {
  /** Layout versions created after the earliest published_at in play. */
  layouts: Array<{ collection: string; name: string; changed_at: Date }>
  /** Current pipeline steps of every collection in play that has a template. */
  states: Array<{ collection: string; key: string; label: string }>
  /** Template version snapshots (the steps as they were right before a
   *  change) created after the earliest published_at in play. */
  snapshots: Array<{ collection: string; at: Date; states: Array<{ key: string; label: string }> }>
  /** Pages with a labels report inside the window. */
  pages: Array<{ key: string; label: string; labels: string[]; labels_at: Date }>
  now: Date
}

const collapse = (s: string) => s.replace(/\s+/g, ' ').trim()
const norm = (s: string) => collapse(s).toLowerCase()

/** The labels a client reported as stored: strings, collapsed, cut to 80
 *  characters, deduplicated (case and spacing ignored), at most 300. Null
 *  when nothing usable was sent. */
export function normalizeLabels(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null
  const out: string[] = []
  const seen = new Set<string>()
  for (const v of raw) {
    if (typeof v !== 'string') continue
    let t = collapse(v)
    if (!t) continue
    if (t.length > LABEL_LIMITS.label) t = t.slice(0, LABEL_LIMITS.label).trimEnd()
    const key = norm(t)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(t)
    if (out.length >= LABEL_LIMITS.labels) break
  }
  return out.length ? out : null
}

/** A recorded label is "on the page" when a reported label equals it, or
 *  starts with it when the recording cut it at the limit. */
export function labelOnPage(label: string, reported: string[]): boolean {
  const want = norm(label)
  if (!want) return true
  for (const r of reported) {
    const n = norm(r)
    if (n === want) return true
    if (want.length >= LABEL_LIMITS.label - 2 && n.startsWith(want)) return true
  }
  return false
}

/**
 * Every reason the video may be out of date, earliest change first. Pure:
 * the caller loads the facts and the world.
 */
export function staleReasons(facts: StaleFacts, world: StaleWorld): StaleReason[] {
  const out: StaleReason[] = []
  const after = facts.published_at.getTime()
  const collections = [
    ...new Set(facts.contexts.filter((c) => c.kind === 'collection').map((c) => c.key))
  ]

  // (a) a layout of the collection changed.
  for (const c of collections) {
    let best: StaleWorld['layouts'][number] | null = null
    for (const l of world.layouts) {
      if (l.collection !== c || l.changed_at.getTime() <= after) continue
      if (!best || l.changed_at > best.changed_at) best = l
    }
    if (best) {
      out.push({
        kind: 'layout',
        detail: `The "${best.name}" layout of ${c} changed`,
        since: best.changed_at.toISOString()
      })
    }
  }

  // (b) a pipeline step it covers was renamed or removed.
  for (const ctx of facts.contexts) {
    if (ctx.kind !== 'collection' || !ctx.state_key) continue
    const current = world.states.filter((s) => s.collection === ctx.key)
    if (!current.length) continue // no pipeline here (or no longer): nothing to judge
    const snaps = world.snapshots
      .filter((s) => s.collection === ctx.key && s.at.getTime() > after)
      .sort((a, b) => a.at.getTime() - b.at.getTime())
    const now = current.find((s) => s.key === ctx.state_key)
    if (!now) {
      // Removed: the latest snapshot after publish that still held it is the
      // moment it went. Without one the removal predates the publish.
      const held = [...snaps].reverse().find((s) => s.states.some((x) => x.key === ctx.state_key))
      if (!held) continue
      const was = held.states.find((x) => x.key === ctx.state_key)
      out.push({
        kind: 'state',
        detail: `The pipeline step "${was?.label ?? ctx.state_key}" of ${ctx.key} was removed`,
        since: held.at.toISOString()
      })
      continue
    }
    // Renamed: the latest snapshot after publish that called it something else.
    const renamed = [...snaps]
      .reverse()
      .find((s) => s.states.some((x) => x.key === ctx.state_key && x.label !== now.label))
    if (renamed) {
      const was = renamed.states.find((x) => x.key === ctx.state_key)
      out.push({
        kind: 'state',
        detail: `The pipeline step "${was?.label ?? ctx.state_key}" of ${ctx.key} is now called "${now.label}"`,
        since: renamed.at.toISOString()
      })
    }
  }

  // (c) a recorded click label is no longer on the page.
  const windowStart = world.now.getTime() - LABEL_WINDOW_DAYS * 86_400_000
  for (const page of world.pages) {
    const at = page.labels_at.getTime()
    if (at <= after || at < windowStart) continue
    const clicks = (facts.clicks ?? []).filter((c) => c.page_key === page.key && c.label)
    const missing = clicks.find((c) => !labelOnPage(String(c.label), page.labels))
    if (!missing) continue
    out.push({
      kind: 'label',
      detail: `"${missing.label}" is no longer on ${page.label || page.key}`,
      since: page.labels_at.toISOString()
    })
  }

  return out.sort((a, b) => a.since.localeCompare(b.since))
}

/** The one reason to show: the earliest change. */
export function judgeStale(facts: StaleFacts, world: StaleWorld): StaleReason | null {
  return staleReasons(facts, world)[0] ?? null
}

/** A dismissed flag is not raised again for the same change: the same
 *  reason, or a layout/state change no newer than the dismissal. */
export function shouldReflag(
  dismissed: StaleReason | null,
  dismissedAt: Date | null,
  next: StaleReason
): boolean {
  if (!dismissedAt) return true
  if (dismissed && dismissed.kind === next.kind && dismissed.detail === next.detail) {
    // The page report moves every visit; the same missing label is the same change.
    if (next.kind === 'label') return false
  }
  return new Date(next.since).getTime() > dismissedAt.getTime()
}

export function parseStaleReason(raw: unknown): StaleReason | null {
  if (raw == null || raw === '') return null
  let v: unknown = raw
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw)
    } catch {
      return null
    }
  }
  const o = v as Record<string, unknown> | null
  if (!o || typeof o !== 'object') return null
  const kind = o.kind
  if (kind !== 'layout' && kind !== 'state' && kind !== 'label') return null
  if (typeof o.detail !== 'string' || typeof o.since !== 'string') return null
  return { kind, detail: o.detail, since: o.since }
}

let staleColumns: { at: number; ok: boolean } | null = null
/** The columns to clear on publish, or nothing before migration 415. */
export async function staleClearPatch(): Promise<Record<string, null>> {
  if (!staleColumns || Date.now() - staleColumns.at > 60_000) {
    const ok = await hasColumn('nivaro_help_videos', 'stale_reason').catch(() => false)
    staleColumns = { at: Date.now(), ok }
  }
  return staleColumns.ok ? { stale_reason: null, stale_dismissed_at: null } : {}
}

/** The flag as the DTO shows it: null once dismissed. */
export function staleForDto(video: Record<string, unknown>): StaleReason | null {
  if (video.stale_dismissed_at) return null
  return parseStaleReason(video.stale_reason)
}

// ── loaders ────────────────────────────────────────────────────────────────

const CHUNK = 300
function chunks<T>(list: T[]): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += CHUNK) out.push(list.slice(i, i + CHUNK))
  return out
}
function parseJson<T>(raw: unknown, fallback: T): T {
  if (raw == null) return fallback
  if (typeof raw !== 'string') return raw as T
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}
const asDate = (v: unknown) => new Date(v as string)

export async function loadStaleWorld(
  collections: string[],
  pageKeys: string[],
  after: Date,
  now = new Date()
): Promise<StaleWorld> {
  const world: StaleWorld = { layouts: [], states: [], snapshots: [], pages: [], now }
  for (const cs of chunks([...new Set(collections)])) {
    const layouts = (await db('nivaro_layout_versions as lv')
      .join('nivaro_collection_layouts as l', 'l.id', 'lv.layout_id')
      .whereIn('l.collection', cs)
      .where('lv.created_at', '>', after)
      .select('l.collection', 'l.name', 'lv.created_at')) as Array<Record<string, unknown>>
    for (const r of layouts) {
      world.layouts.push({
        collection: String(r.collection),
        name: String(r.name ?? 'Default'),
        changed_at: asDate(r.created_at)
      })
    }
    const states = (await db('nivaro_workflow_bindings as b')
      .join('nivaro_workflow_states as s', 's.template', 'b.template')
      .whereIn('b.collection', cs)
      .select('b.collection', 's.key', 's.label')) as Array<Record<string, unknown>>
    for (const r of states) {
      world.states.push({
        collection: String(r.collection),
        key: String(r.key),
        label: String(r.label ?? r.key)
      })
    }
    const snaps = (await db('nivaro_workflow_template_versions as v')
      .join('nivaro_workflow_bindings as b', 'b.template', 'v.template')
      .whereIn('b.collection', cs)
      .where('v.created_at', '>', after)
      .select('b.collection', 'v.created_at', 'v.snapshot')) as Array<Record<string, unknown>>
    for (const r of snaps) {
      const snap = parseJson<{ states?: Array<Record<string, unknown>> }>(r.snapshot, {})
      world.snapshots.push({
        collection: String(r.collection),
        at: asDate(r.created_at),
        states: (snap.states ?? []).map((s) => ({
          key: String(s.key ?? ''),
          label: String(s.label ?? s.key ?? '')
        }))
      })
    }
  }
  const windowStart = new Date(now.getTime() - LABEL_WINDOW_DAYS * 86_400_000)
  for (const ks of chunks([...new Set(pageKeys)])) {
    const pages = (await db('nivaro_help_video_pages')
      .whereIn('key', ks)
      .whereNotNull('labels_at')
      .where('labels_at', '>', windowStart)
      .select('key', 'label', 'labels', 'labels_at')) as Array<Record<string, unknown>>
    for (const r of pages) {
      const labels = normalizeLabels(parseJson<unknown>(r.labels, null))
      if (!labels) continue
      world.pages.push({
        key: String(r.key),
        label: String(r.label ?? r.key),
        labels,
        labels_at: asDate(r.labels_at)
      })
    }
  }
  return world
}

// ── the nightly check ──────────────────────────────────────────────────────

export function staleNotice(
  title: string,
  reason: StaleReason
): { subject: string; message: string; why: string } {
  const name = title || 'Untitled video'
  return {
    subject: `A video may be out of date: ${name}`.slice(0, 250),
    message: `${reason.detail}. Check the video and publish it again, or dismiss the note in the Videos library.`,
    why: 'You recorded this video.'
  }
}

async function notifyAuthor(videoId: string, title: string, userId: string, reason: StaleReason) {
  const app = getApp()
  if (!app) return
  const { notifyUser } = await import('./notification-channels.js')
  const text = staleNotice(title, reason)
  const base = (adminBaseUrl() ?? '').replace(/\/$/, '')
  await notifyUser(app, userId, {
    subject: text.subject,
    message: text.message,
    category: 'system',
    why: text.why,
    target: base
      ? { kind: 'external', url: `${base}/help-videos?edit=${encodeURIComponent(videoId)}` }
      : { kind: 'home', action: 'open' },
    source: { kind: 'help-video', label: (title || 'Untitled video').slice(0, 250), id: videoId }
  })
}

/** Marks every published video whose screen changed since it was published.
 *  Answers a summary line for the job run. Nothing happens before migration 415. */
export async function runStaleCheck(now = new Date()): Promise<string> {
  if (!(await hasColumn('nivaro_help_videos', 'stale_reason').catch(() => false))) {
    return 'skipped: migration 415 has not run'
  }
  const videos = (await db('nivaro_help_videos')
    .where({ status: 'published' })
    .whereNotNull('published_version_id')
    .select(
      'id',
      'title',
      'created_by',
      'published_version_id',
      'stale_reason',
      'stale_dismissed_at'
    )) as Array<Record<string, unknown>>
  // A flag that stands needs no second look (and no second notification).
  const open = videos.filter((v) => !(v.stale_reason && !v.stale_dismissed_at))
  if (!open.length) return `checked ${videos.length} published videos: nothing new`
  const versions = new Map<string, Record<string, unknown>>()
  const contexts = new Map<string, StaleFacts['contexts']>()
  for (const vs of chunks(open)) {
    const rows = (await db('nivaro_help_video_versions')
      .whereIn(
        'id',
        vs.map((v) => String(v.published_version_id))
      )
      .select('id', 'created_at', 'clicks')) as Array<Record<string, unknown>>
    for (const r of rows) versions.set(String(r.id).toLowerCase(), r)
    const ctx = (await db('nivaro_help_video_contexts')
      .whereIn(
        'video_id',
        vs.map((v) => String(v.id))
      )
      .select('video_id', 'kind', 'key', 'state_key')) as Array<Record<string, unknown>>
    for (const c of ctx) {
      const id = String(c.video_id).toLowerCase()
      const list = contexts.get(id) ?? []
      list.push({
        kind: c.kind as 'collection' | 'page',
        key: String(c.key),
        state_key: c.state_key ? String(c.state_key) : null
      })
      contexts.set(id, list)
    }
  }
  const facts = new Map<string, StaleFacts>()
  let earliest = now.getTime()
  const collections = new Set<string>()
  const pageKeys = new Set<string>()
  for (const v of open) {
    const ver = versions.get(String(v.published_version_id).toLowerCase())
    if (!ver) continue
    const id = String(v.id).toLowerCase()
    const ctx = contexts.get(id) ?? []
    const clicks = parseJson<RecordedClick[] | null>(ver.clicks, null)
    const f: StaleFacts = {
      published_at: asDate(ver.created_at),
      contexts: ctx,
      clicks: Array.isArray(clicks) ? clicks : null
    }
    facts.set(id, f)
    earliest = Math.min(earliest, f.published_at.getTime())
    for (const c of ctx) if (c.kind === 'collection') collections.add(c.key)
    for (const c of f.clicks ?? []) if (c.page_key) pageKeys.add(c.page_key)
  }
  const world = await loadStaleWorld([...collections], [...pageKeys], new Date(earliest), now)
  const counts: Record<StaleKind, number> = { layout: 0, state: 0, label: 0 }
  let flagged = 0
  for (const v of open) {
    const id = String(v.id).toLowerCase()
    const f = facts.get(id)
    if (!f) continue
    const reason = judgeStale(f, world)
    if (!reason) continue
    const dismissedAt = v.stale_dismissed_at ? asDate(v.stale_dismissed_at) : null
    if (!shouldReflag(parseStaleReason(v.stale_reason), dismissedAt, reason)) continue
    await db('nivaro_help_videos')
      .where({ id: v.id })
      .update({ stale_reason: JSON.stringify(reason), stale_dismissed_at: null })
    flagged++
    counts[reason.kind]++
    await logActivity({
      action: 'help-video-stale',
      user: null,
      collection: 'nivaro_help_videos',
      item: id,
      comment: `${reason.kind}: ${reason.detail}`.slice(0, 500),
      origin: 'machine'
    })
    if (v.created_by) {
      await notifyAuthor(id, String(v.title ?? ''), String(v.created_by), reason).catch((err) => {
        getApp()?.log?.warn?.({ err, videoId: id }, 'help video stale notify failed')
      })
    }
  }
  return `checked ${videos.length} published videos: ${flagged} newly flagged (layout ${counts.layout}, pipeline step ${counts.state}, click label ${counts.label})`
}

export class StaleError extends Error {
  statusCode: number
  code: string
  constructor(message: string, statusCode: number, code: string) {
    super(message)
    this.statusCode = statusCode
    this.code = code
  }
}

/** An author dismisses the flag: the note goes, and the same change is not
 *  raised again. 409 HELP_VIDEO_NOT_STALE when there is nothing to dismiss. */
export async function dismissStale(
  video: Record<string, unknown> & { id: string },
  user: User
): Promise<void> {
  if (!staleForDto(video)) {
    throw new StaleError('This video is not flagged as out of date', 409, 'HELP_VIDEO_NOT_STALE')
  }
  await db('nivaro_help_videos')
    .where({ id: video.id })
    .update({ stale_dismissed_at: new Date(), updated_by: user.id, updated_at: new Date() })
  await logActivity({
    action: 'help-video-stale-dismiss',
    user: user.id,
    collection: 'nivaro_help_videos',
    item: String(video.id).toLowerCase(),
    comment: parseStaleReason(video.stale_reason)?.detail?.slice(0, 500)
  })
}
