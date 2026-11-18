import type { User } from '../../../types.js'
import { sanitizeMarkdown } from '../templates.js'
import { addTrackerComment, insertMirroredComment } from './comments.js'
import { parseRecordId, type SourceView, type TrackerSource } from './types.js'

/**
 * Business records (`<collection>:<id>`). No status / priority sync (records have pipelines):
 * a GitLab close / reopen becomes a record comment. Template variables are read AS the person
 * who creates (items service readOne as them — a field they cannot read is absent) and the
 * label is the record label as they see it. Comments land on the record's own thread (never a
 * field comment). Heavy services are loaded lazily so the tracker graph stays light.
 */

const FIELD_VALUE_MAX = 2000
const MAX_FIELDS = 200

type Row = Record<string, unknown>

/** Scalars only, every string markdown-safe on one line (people wrote these values). */
function safeFields(record: Row): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  let n = 0
  for (const [k, v] of Object.entries(record)) {
    if (n >= MAX_FIELDS) break
    if (k.startsWith('$')) continue
    if (v == null) out[k] = null
    else if (typeof v === 'number' || typeof v === 'boolean') out[k] = v
    else if (v instanceof Date) out[k] = v.toISOString()
    else if (typeof v === 'string')
      out[k] = sanitizeMarkdown(v.slice(0, FIELD_VALUE_MAX), { singleLine: true })
    else continue
    n++
  }
  return out
}

export async function recordUrl(collection: string, item: string): Promise<string> {
  const { recordLink } = await import('../../app-links.js')
  return recordLink(collection, item, { app: 'admin' })
}

/** The record as `user` reads it, or null when they cannot see it. */
async function readAs(user: User, collection: string, item: string): Promise<Row | null> {
  const items = await import('../../items.js')
  try {
    const row = (await items.readOne(user, collection, item)) as Row | null
    if (!row || items.isOutOfView(row)) return null
    return row
  } catch (err) {
    const code = (err as { statusCode?: number })?.statusCode
    if (
      err instanceof items.ForbiddenError ||
      err instanceof items.ItemNotFoundError ||
      err instanceof items.CollectionNotFoundError ||
      code === 403 ||
      code === 404 ||
      code === 400
    )
      return null
    throw err
  }
}

async function labelAs(user: User, collection: string, item: string): Promise<string> {
  try {
    const { recordLabelsAsViewer } = await import('../../record-labels-as-viewer.js')
    const labels = await recordLabelsAsViewer(user, [{ collection, id: item }])
    return String(labels[`${collection}:${item}`] ?? '').trim()
  } catch {
    return ''
  }
}

async function collectionName(collection: string): Promise<string> {
  try {
    const { getCollection } = await import('../../collections.js')
    const { collectionTitle } = await import('../../record-label-fallback.js')
    const col = await getCollection(collection)
    return collectionTitle(collection, (col as { display_name?: string | null })?.display_name)
  } catch {
    return collection
  }
}

export const recordSource: TrackerSource = {
  kind: 'record',

  async load(id, opts = {}) {
    const p = parseRecordId(id)
    if (!p) return null
    const url = await recordUrl(p.collection, p.item)
    const title = await collectionName(p.collection)
    let fields: Record<string, unknown> = {}
    let label = ''
    if (opts.asUser) {
      const row = await readAs(opts.asUser, p.collection, p.item)
      if (!row) return null
      fields = safeFields(row)
      label = await labelAs(opts.asUser, p.collection, p.item)
    }
    const name = label || `${title} ${p.item}`
    const view: SourceView = {
      kind: 'record',
      id: `${p.collection}:${p.item}`,
      title: name,
      body: null,
      status: null,
      priority: null,
      url,
      fingerprint: null,
      vars: {
        title: sanitizeMarkdown(name, { singleLine: true }),
        label: sanitizeMarkdown(name, { singleLine: true }),
        collection: p.collection,
        collection_title: sanitizeMarkdown(title, { singleLine: true }),
        item: sanitizeMarkdown(p.item, { singleLine: true }),
        fields,
        nivaro_url: url
      }
    }
    return view
  },

  /**
   * Admins: any record that exists. Others: the gates a write of the record applies (they can
   * see it, update it, and its approval edit lock lets them) — recordWriteRefusal on a request,
   * canUpdateItem without one. Someone else holding the form open does not block it (a GitLab
   * issue does not write the record).
   */
  async canCreate(user, id, isAdmin, req) {
    const p = parseRecordId(id)
    if (!p) return false
    if (isAdmin) return true
    if (req) {
      const { recordWriteRefusal } = await import('../../edit-lock.js')
      return (await recordWriteRefusal(req, p.collection, p.item, { heldLock: false })) === null
    }
    if (!(await readAs(user, p.collection, p.item))) return false
    const { canUpdateItem } = await import('../../items.js')
    return canUpdateItem(user, p.collection, p.item)
  },

  async addComment(id, text, meta) {
    const p = parseRecordId(id)
    if (!p) return
    await addTrackerComment(p.collection, p.item, text, meta)
  },

  ref: (id) => {
    const p = parseRecordId(id)
    return p ? { collection: p.collection, item: p.item } : null
  },
  readers: () => 'everyone-who-can-read'
}

/**
 * A GitLab close / reopen on a record's thread: `GitLab issue <iid> <closed|reopened> by <name>`
 * (no `#` before the number), by the GitLab machine user.
 */
export async function recordStateComment(
  id: string,
  linkId: number,
  iid: number,
  state: 'closed' | 'reopened',
  by: string | null
): Promise<void> {
  const p = parseRecordId(id)
  if (!p) return
  const who = sanitizeMarkdown(String(by ?? '').trim(), { singleLine: true }) || 'GitLab (sync)'
  const text = `GitLab issue ${Math.floor(iid)} ${state} by ${who}`
  const meta = `{"tracker":{"link":${Math.floor(linkId)},"state":"${state}","author":${JSON.stringify(who)}}}`
  await insertMirroredComment(p.collection, p.item, text, meta)
}
