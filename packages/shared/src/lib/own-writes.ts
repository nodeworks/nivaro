/**
 * Own-write registry for the live hooks (lib/live.ts). Dependency-free so the
 * transport wrapper (request-gate.ts) can feed it without an import cycle.
 */

const OWN_WRITE_TTL_MS = 6000
const ownWrites = new Map<string, number>()

function ownKey(collection: string, item: string | number | null | undefined): string {
  return `${collection}:${item == null ? '*' : String(item)}`
}

/** Mark a record as just written by this tab; matching events within the TTL count as own. */
export function noteOwnWrite(
  collection: string,
  item?: string | number | null,
  ttlMs = OWN_WRITE_TTL_MS
): void {
  if (!collection) return
  const now = Date.now()
  ownWrites.set(ownKey(collection, item), now + ttlMs)
  if (ownWrites.size > 200) {
    for (const [k, exp] of ownWrites) if (exp < now) ownWrites.delete(k)
  }
}

export function isOwnWrite(collection: string, item: string | number | null | undefined): boolean {
  const now = Date.now()
  const exact = ownWrites.get(ownKey(collection, item))
  return exact != null && exact >= now
}

const ITEM_WRITE = /^\/items\/([A-Za-z_][A-Za-z0-9_]*)(?:\/([^/?#]+))?/
const INSTANCE_WRITE = /^\/pipelines\/instance\/([A-Za-z_][A-Za-z0-9_]*)\/([^/?#]+)/
const ADDENDUM_WRITE = /^\/addendums\/([A-Za-z_][A-Za-z0-9_]*)\/([^/?#]+)/

/**
 * Note the record(s) a write command touches. Called by `withGetCoalescing`
 * for every non-GET (before sending, and again with the response so a
 * create's new id counts too). Unknown paths fall back to a body that names
 * `collection` + `item`/`parent_collection` + `parent_id` (comments, tasks,
 * addendums).
 */
export function noteOwnWriteFromCommand(
  method: string | undefined,
  path: string | undefined,
  body?: unknown,
  response?: unknown
): void {
  const m = (method ?? 'GET').toUpperCase()
  if (m === 'GET' || !path) return
  const p = path.split('?')[0]
  const item = ITEM_WRITE.exec(p)
  if (item) {
    const [, collection, id] = item
    if (id && !['batch', 'bulk', 'batch-read', 'aggregate', 'export'].includes(id))
      noteOwnWrite(collection, decodeURIComponent(id))
    const created = (response as { data?: { id?: unknown } } | undefined)?.data?.id
    if (created != null) noteOwnWrite(collection, created as string)
  }
  const inst = INSTANCE_WRITE.exec(p) ?? ADDENDUM_WRITE.exec(p)
  if (inst) noteOwnWrite(inst[1], decodeURIComponent(inst[2]))
  if (body && typeof body === 'object') {
    const b = body as Record<string, unknown>
    if (typeof b.collection === 'string' && b.item != null)
      noteOwnWrite(b.collection, b.item as string)
    if (typeof b.parent_collection === 'string' && b.parent_id != null)
      noteOwnWrite(b.parent_collection, b.parent_id as string)
  }
}
