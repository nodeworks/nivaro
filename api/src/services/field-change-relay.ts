import { db } from '../db/index.js'
import type { User } from '../types.js'
import { getFields, getRelations } from './collections.js'
import { getEncryptedFields } from './encryption.js'
import { getAllowedFields } from './permissions.js'
import { isInternalCollection, isSecretColumn, sensitiveColumns } from './system-collections.js'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * Live co-editing keystrokes (`field:change` → `field:changed`) carry the typed value to the
 * other people viewing the record. Realtime payloads carry names, never values, unless each
 * recipient is judged — so the value goes out only:
 *
 *  - for a field whose value may travel at all (`valueFields`): a real, plain field of a business
 *    collection — never a system/internal collection, an encrypted field, a credential column,
 *    a hash/concealed field, a to-many alias (its "value" is another collection's row) or a name
 *    the collection does not have (`row:<id>` marks, made-up names);
 *  - to the SOCKETS in the record room whose person may read that field: the same field list
 *    the record read (`readOne`) projects with, `getAllowedFields(user, 'read', collection)`.
 *    A View-as socket is signed in as the viewed person, so it is judged as that person.
 *    A socket signed in with an API key is never sent the value (its key may narrow what the
 *    person reads, and that narrowing is not re-judged here), and neither is a socket whose
 *    sign-in kind is not known — sockets on other processes carry the kind their process
 *    published on the realtime board; an older process publishes none (fail closed).
 *
 * Everyone else in the room gets the same event without `value` ("Beth is editing Amount").
 * Answers are sent to socket ids, never to `user:` rooms — a person's other tabs and devices
 * that are not on the record get nothing.
 *
 * Keystrokes are throttled by the client to ~4 a second per editor, so both answers are cached
 * briefly (TTL_MS) per tenant + person + collection and per tenant + collection.
 */

const TTL_MS = 30_000
const CACHE_MAX = 5_000

interface Cached<T> {
  value: T
  expires: number
}

/** Person → their readable field list (null = every field). */
const readCache = new Map<string, Cached<Set<string> | null>>()
/** Collection → the fields whose typed value may travel at all. */
const valueFieldCache = new Map<string, Cached<Set<string>>>()

export interface RelayDeps {
  loadUser: (id: string) => Promise<User | null>
  allowedFields: (user: User, collection: string) => Promise<string[] | null>
  /** The fields of `collection` whose typed value may be relayed to anyone. */
  valueFields: (collection: string) => Promise<Set<string>>
  now: () => number
  /** Keeps a different `valueFields` list in its own cache slot (rt9 upload names). */
  cacheTag?: string
}

/** A socket viewing the record. `kind` = what signed it in (SocketBind kind), when known. */
export interface RelayViewer {
  socket: string
  id: string
  kind?: string
}

/**
 * Sign-in kinds whose socket is exactly its person, so the person's field list decides.
 * `apikey` is left out (a key may narrow what the person reads); a missing or unknown kind —
 * a board entry from an older process, a socket not yet bound — is never sent a value.
 */
const VALUE_KINDS = new Set(['session', 'masq', 'token', 'device'])

/**
 * The sockets viewing one record room: this process's (`local`, kind read from the socket) and
 * the other processes' from the realtime board (`peers`, kind as that process published it).
 */
export function relayViewers(
  local: Iterable<[string, { id: string }]>,
  localKind: (socketId: string) => string | undefined,
  peers: ReadonlyArray<{ socket: string; id: string; kind?: string }>
): RelayViewer[] {
  const out: RelayViewer[] = []
  for (const [sid, v] of local)
    if (sid) out.push({ socket: sid, id: String(v.id), kind: localKind(sid) })
  for (const p of peers)
    if (p?.socket)
      out.push({
        socket: String(p.socket),
        id: String(p.id),
        kind: typeof p.kind === 'string' ? p.kind : undefined
      })
  return out
}

const MASKING_SPECIAL = new Set(['hash', 'conceal', 'password', 'secret'])

/** Is this field's value hidden by its own definition (password/hash inputs, concealed)? */
function maskedByDefinition(f: { interface?: string | null; special?: unknown }): boolean {
  if (/password|hash|secret|conceal/i.test(String(f.interface ?? ''))) return true
  const special = Array.isArray(f.special) ? f.special : []
  return special.some((s) => MASKING_SPECIAL.has(String(s).toLowerCase()))
}

async function loadValueFields(collection: string): Promise<Set<string>> {
  if (isInternalCollection(collection)) return new Set()
  const [fields, encrypted, relations] = await Promise.all([
    getFields(collection),
    getEncryptedFields(collection),
    getRelations(collection)
  ])
  const blocked = new Set(
    [...encrypted, ...sensitiveColumns(collection)].map((f) => String(f).toLowerCase())
  )
  // To-many aliases (O2M / M2M / M2A on the parent): the "value" is another collection's rows.
  for (const r of relations)
    if (r.one_collection === collection && r.one_field) blocked.add(r.one_field.toLowerCase())
  const out = new Set<string>()
  for (const f of fields) {
    const name = String(f.field)
    if (blocked.has(name.toLowerCase()) || isSecretColumn(name) || maskedByDefinition(f)) continue
    out.add(name)
  }
  return out
}

const defaultDeps: RelayDeps = {
  loadUser: async (id) =>
    ((await db<User>('nivaro_users').where({ id, status: 'active' }).first()) as
      | User
      | undefined) ?? null,
  allowedFields: (user, collection) => getAllowedFields(user, 'read', collection),
  valueFields: loadValueFields,
  now: Date.now
}

function remember<T>(cache: Map<string, Cached<T>>, key: string, value: T, now: number): T {
  if (cache.size >= CACHE_MAX) cache.clear()
  cache.set(key, { value, expires: now + TTL_MS })
  return value
}

async function valueFieldsOf(collection: string, deps: RelayDeps): Promise<Set<string>> {
  const key = `${currentTenantKey()}|${deps.cacheTag ?? ''}|${collection}`
  const t = deps.now()
  const hit = valueFieldCache.get(key)
  if (hit && hit.expires > t) return hit.value
  return remember(valueFieldCache, key, await deps.valueFields(collection), t)
}

/** false = no such active person (never sent a value). */
async function readableFields(
  userId: string,
  collection: string,
  deps: RelayDeps
): Promise<Set<string> | null | false> {
  const key = `${currentTenantKey()}|${userId.toLowerCase()}|${collection}`
  const hit = readCache.get(key)
  const t = deps.now()
  if (hit && hit.expires > t) return hit.value
  const user = await deps.loadUser(userId)
  if (!user) return false
  const list = await deps.allowedFields(user, collection)
  const fields = list === null || list.includes('*') ? null : new Set(list)
  return remember(readCache, key, fields, t)
}

/** May the typed value of this payload travel at all (before any recipient is judged)? */
export function relayableValue(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  )
}

/**
 * Split the sockets viewing a record into those that get `field`'s typed value and those that
 * get its name only. Fails closed: a field that cannot be judged, or a viewer whose field list
 * cannot be read (no active account, an error), gets the name only.
 */
export async function fieldChangeDelivery(
  viewers: RelayViewer[],
  collection: string,
  field: string,
  deps: RelayDeps = defaultDeps
): Promise<{ valueTo: string[]; nameTo: string[] }> {
  const sockets = [...new Map(viewers.map((v) => [String(v.socket), v])).values()]
  const all = sockets.map((v) => String(v.socket))
  let travels = false
  try {
    travels = (await valueFieldsOf(collection, deps)).has(field)
  } catch {
    travels = false
  }
  if (!travels) return { valueTo: [], nameTo: all }
  const valueTo: string[] = []
  const nameTo: string[] = []
  await Promise.all(
    sockets.map(async (v) => {
      const sid = String(v.socket)
      if (!v.kind || !VALUE_KINDS.has(v.kind)) {
        nameTo.push(sid)
        return
      }
      try {
        const fields = await readableFields(String(v.id), collection, deps)
        if (fields !== false && (fields === null || fields.has(field))) valueTo.push(sid)
        else nameTo.push(sid)
      } catch {
        nameTo.push(sid)
      }
    })
  )
  return { valueTo, nameTo }
}

/** Tests only. */
export function __resetFieldChangeRelay(): void {
  readCache.clear()
  valueFieldCache.clear()
}

// ─── rt9 #9: what an upload into a file field may say ──────────────────────────

/**
 * The fields of `collection` whose UPLOAD may be named to readers of that field: any real field
 * of a business collection (a single-file link or a to-many files alias alike), never on a
 * system collection, never an encrypted or credential column.
 */
async function loadNameableFields(collection: string): Promise<Set<string>> {
  if (isInternalCollection(collection)) return new Set()
  const [fields, encrypted] = await Promise.all([
    getFields(collection),
    getEncryptedFields(collection)
  ])
  const blocked = new Set(
    [...encrypted, ...sensitiveColumns(collection)].map((f) => String(f).toLowerCase())
  )
  const out = new Set<string>()
  for (const f of fields) {
    const name = String(f.field)
    if (blocked.has(name.toLowerCase()) || isSecretColumn(name) || maskedByDefinition(f)) continue
    out.add(name)
  }
  return out
}

/**
 * Split a record's viewers for "Beth is uploading quote.pdf (60%)": the file NAME goes only to
 * sockets whose person may read `field` on this collection (a file follows where it is used —
 * services/file-access.ts reads a record's files through its fields), everyone else is told an
 * upload is happening without the name. No field, or one that cannot be judged = no name for
 * anyone. Same sign-in-kind rule as typed values (an API-key or unknown socket gets no name).
 */
export function uploadNameDelivery(
  viewers: RelayViewer[],
  collection: string,
  field: string | null | undefined,
  deps: RelayDeps = { ...defaultDeps, valueFields: loadNameableFields }
): Promise<{ valueTo: string[]; nameTo: string[] }> {
  if (!field) {
    const all = [...new Set(viewers.map((v) => String(v.socket)))]
    return Promise.resolve({ valueTo: [], nameTo: all })
  }
  // Its own cache slot: the nameable list is wider than the typed-value one (aliases included).
  return fieldChangeDelivery(viewers, collection, field, { ...deps, cacheTag: 'upload' })
}
