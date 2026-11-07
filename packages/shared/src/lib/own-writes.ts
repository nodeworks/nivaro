/**
 * Own-write registry for the live hooks (lib/live.ts). Dependency-free so the
 * transport wrapper (request-gate.ts) can feed it without an import cycle.
 *
 * A note says "this tab just wrote these FIELDS of this record": the echo of
 * that write (a `collection:update` naming some of those fields) is dropped,
 * so the tab does not refetch what it already holds. Anything else arriving
 * in the window — someone else's save of other fields, a comment, a lock —
 * goes through. Army 8 b09 H8: a blanket "this record is mine for 6 s" note,
 * opened by every non-GET including the read-only child-summary POST, made
 * the other person's real save in that window vanish.
 */

const OWN_WRITE_TTL_MS = 6000

interface OwnNote {
  exp: number
  /** Field names the write named; null = any field (a create, delete or body-less write). */
  fields: Set<string> | null
}

const ownWrites = new Map<string, OwnNote>()

function ownKey(collection: string, item: string | number | null | undefined): string {
  return `${collection}:${item == null ? '*' : String(item)}`
}

/**
 * Mark a record as just written by this tab; matching events within the TTL
 * count as own. `fields` narrows the match to events naming one of them
 * (null / empty = any event on the record).
 */
export function noteOwnWrite(
  collection: string,
  item?: string | number | null,
  ttlMs = OWN_WRITE_TTL_MS,
  fields?: readonly string[] | null
): void {
  if (!collection) return
  const now = Date.now()
  const key = ownKey(collection, item)
  const named = fields && fields.length > 0 ? new Set(fields) : null
  const cur = ownWrites.get(key)
  const live = cur && cur.exp >= now ? cur : null
  // A second write to the same record widens the note (its fields join), never narrows it.
  const noted =
    !named || (live && !live.fields)
      ? null
      : live?.fields
        ? new Set([...live.fields, ...named])
        : named
  ownWrites.set(key, { exp: now + ttlMs, fields: noted })
  if (ownWrites.size > 200) {
    for (const [k, n] of ownWrites) if (n.exp < now) ownWrites.delete(k)
  }
}

/**
 * Whether an event on this record is the echo of a write this tab made.
 * `changedFields` = the event's field names; an event naming none (a create,
 * a delete, a server that sends no names) matches any live note, a named one
 * only a note that covers at least one of its fields.
 */
export function isOwnWrite(
  collection: string,
  item: string | number | null | undefined,
  changedFields?: readonly string[] | null
): boolean {
  const note = ownWrites.get(ownKey(collection, item))
  if (!note || note.exp < Date.now()) return false
  if (!note.fields || !changedFields || changedFields.length === 0) return true
  return changedFields.some((f) => note.fields?.has(f))
}

/** Tests only. */
export function clearOwnWrites(): void {
  ownWrites.clear()
}

// A write to one record: /items/<collection>/<id> and nothing after the id. A sub-route
// (`/child-summary`, `/clone`, `/resolve-paths`) is a read or writes another record.
const ITEM_ONE = /^\/items\/([A-Za-z_][A-Za-z0-9_]*)\/([^/?#]+)$/
const ITEM_COLLECTION = /^\/items\/([A-Za-z_][A-Za-z0-9_]*)$/
const ITEM_BATCH = /^\/items\/([A-Za-z_][A-Za-z0-9_]*)\/(batch|bulk)$/
const INSTANCE_WRITE = /^\/pipelines\/instance\/([A-Za-z_][A-Za-z0-9_]*)\/([^/?#]+)/
const ADDENDUM_WRITE = /^\/addendums\/([A-Za-z_][A-Za-z0-9_]*)\/([^/?#]+)/
// Ids the item routes reserve for sub-resources, never a record.
const NOT_AN_ID = new Set(['batch', 'bulk', 'batch-read', 'aggregate', 'export', 'auto-id-preview'])

/** What a record-side surface write (a comment, a task, a transition…) is heard as. */
const ASPECT_OF_PATH: Array<[RegExp, string[]]> = [
  [/^\/comments(\/|$)/, ['$comments']],
  [/^\/tasks(\/|$)/, ['$tasks']],
  [/^\/addendums(\/|$)/, ['$addendums']],
  [/^\/pipelines\/instance\//, ['$state', '$owners']]
]

function aspectsOf(path: string): string[] | null {
  for (const [re, fields] of ASPECT_OF_PATH) if (re.test(path)) return fields
  return null
}

/** The field names a write body carries (`_change_reason` and the like are not fields). */
function fieldsOf(body: unknown): string[] | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const names = Object.keys(body as Record<string, unknown>).filter((k) => !k.startsWith('_'))
  return names.length > 0 ? names : null
}

/**
 * A rehearsal (`?dry_run=1` / `_params.dry_run`, e.g. PATCH /items/c/id?dry_run=1):
 * nothing is written and the server broadcasts nothing, so it must open no own-write
 * note — a note would swallow another person's real save to those fields.
 */
export function isRehearsalCommand(path: string | undefined, params?: unknown): boolean {
  const truthy = (v: unknown) => v === true || v === 1 || v === '1' || v === 'true'
  if (params && typeof params === 'object' && truthy((params as { dry_run?: unknown }).dry_run))
    return true
  const qs = path?.split('?')[1]
  if (!qs) return false
  return truthy(new URLSearchParams(qs).get('dry_run'))
}

/**
 * Note the record(s) a write command touches. Called by `withGetCoalescing`
 * for every non-GET before sending, and again with the response — that second
 * call only adds a create's new id (it never re-opens the first note).
 * Unknown paths fall back to a body that names `collection` + `item` /
 * `parent_collection` + `parent_id` (comments, tasks, addendums), noted as the
 * matching `$` aspect so a header save by someone else still comes through.
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
  if (response !== undefined) {
    // The response leg: a create's new id (POST /items/<collection>) and nothing else.
    const coll = ITEM_COLLECTION.exec(p)
    const created = (response as { data?: { id?: unknown } } | undefined)?.data?.id
    if (coll && m === 'POST' && created != null) noteOwnWrite(coll[1], created as string)
    return
  }
  const batch = ITEM_BATCH.exec(p)
  if (batch) {
    const b = body as { update?: unknown; rows?: unknown } | unknown[] | null | undefined
    const rows = Array.isArray(b)
      ? b
      : Array.isArray(b?.update)
        ? b.update
        : Array.isArray(b?.rows)
          ? b.rows
          : []
    for (const row of rows as Array<Record<string, unknown>>) {
      if (row && typeof row === 'object' && row.id != null)
        noteOwnWrite(
          batch[1],
          row.id as string,
          OWN_WRITE_TTL_MS,
          fieldsOf(row)?.filter((f) => f !== 'id') ?? null
        )
    }
    return
  }
  const one = ITEM_ONE.exec(p)
  if (one) {
    const [, collection, id] = one
    if (!NOT_AN_ID.has(id))
      noteOwnWrite(
        collection,
        decodeURIComponent(id),
        OWN_WRITE_TTL_MS,
        m === 'DELETE' ? null : fieldsOf(body)
      )
    return
  }
  const aspects = aspectsOf(p)
  const inst = INSTANCE_WRITE.exec(p) ?? ADDENDUM_WRITE.exec(p)
  if (inst) noteOwnWrite(inst[1], decodeURIComponent(inst[2]), OWN_WRITE_TTL_MS, aspects)
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const b = body as Record<string, unknown>
    if (typeof b.collection === 'string' && b.item != null)
      noteOwnWrite(b.collection, b.item as string, OWN_WRITE_TTL_MS, aspects)
    if (typeof b.parent_collection === 'string' && b.parent_id != null)
      noteOwnWrite(b.parent_collection, b.parent_id as string, OWN_WRITE_TTL_MS, aspects)
  }
}
