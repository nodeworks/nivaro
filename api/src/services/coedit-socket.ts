import type { Server, Socket } from 'socket.io'
import type { User } from '../types.js'
import {
  type CoeditStore,
  type CoeditTarget,
  cleanClientId,
  cleanDoc,
  cleanSteps,
  cleanTarget,
  memoryCoeditStore,
  redisCoeditStore,
  type SessionState,
  sessionKey
} from './coedit.js'
import { inSocketTenant } from './socket-tenant.js'

/**
 * Co-editing long text (realtime round 3, item 8) — the socket side.
 *
 * Two rooms per field of a record, beside the record's own room and under the same record read
 * gate (the record:join answer):
 *
 *   coedit:r:<field>:<collection>:<item>   everyone who may READ the field — the live text
 *   coedit:w:<field>:<collection>:<item>   everyone who may also WRITE it — cursors too
 *
 * A person who may not read the field joins neither and hears nothing about it (not even that
 * someone is typing there): the text goes only to readers, as field:change value relays do.
 * Read-only readers watch the text change without cursors. Typing needs the field's update
 * permission, the record's (row filters, user scopes) and no live edit lock held by someone
 * else, judged when a writer opens the session.
 *
 * Client → server:
 *   coedit:watch   {collection, item, field}               join (gated); answers coedit:state
 *   coedit:unwatch {collection, item, field}
 *   coedit:open    {…, clientID, doc}                       start or join the session (writers)
 *   coedit:steps   {…, clientID, version, steps}            a batch made against `version`
 *   coedit:sync    {…, version}                             the steps since `version`
 *   coedit:cursor  {…, clientID, version, anchor, head} | {…, clientID, clear: true}
 *   coedit:close   {…, clientID}                            this editor left the session
 * Server → client:
 *   coedit:state   {…, write, session}                      to the asking socket
 *   coedit:active  {…, session}                             a session started (room)
 *   coedit:steps   {…, version, steps, clientIDs}           accepted steps (room) / catch-up
 *   coedit:cursor  {…, clientID, version, anchor, head, user} | {…, clientID, clear}
 *   coedit:ended   {…, reason}                              nobody is left / it was full
 *
 * Every payload names its record and field (the shared worker routes on it).
 */

export interface CoeditDeps {
  store: CoeditStore
  /** Is this a field whose typed text may travel to other people: a plain rich-text field of
   *  the collection (never encrypted, a credential, a password/hash/conceal interface, a
   *  computed or alias field) — the field:change relay's rule. */
  fieldMayTravel(collection: string, field: string): Promise<boolean>
  /** The record read gate (role, row filter, user scopes). */
  canSeeRecord(user: User, collection: string, item: string): Promise<boolean>
  /** May this person read the field? */
  /** Would the typed-value relay (field-change-relay fieldChangeDelivery) send this socket the
   *  field's value? `kind` = what signed the socket in. Co-edit text is never looser. */
  mayRead(user: User, collection: string, field: string, kind?: string): Promise<boolean>
  /** May this person change the field on this record (field + record update gates)? */
  mayWrite(user: User, collection: string, item: string, field: string): Promise<boolean>
  /** A write of this field on this record is refused right now: someone else's live edit lock
   *  (their form owns the record) or the step's own edit lock (post-approval, admin-only). */
  writeRefused(user: User, collection: string, item: string, field: string): Promise<boolean>
  now(): number
}

export interface CoeditScope {
  /** The room name in the socket's tenant (cloud), or null before it resolves. */
  scopedRoom(room: string): Promise<string | null>
  /** The socket's tenant key ('' self-hosted), or null before it resolves. */
  tenantNow(): string | null
}

/** Sign-in kinds that take part (a person at a screen); API keys and unknown kinds never. */
const SCREEN_BINDS = new Set(['session', 'masq', 'token', 'device'])

/** Fields one socket may watch at once (a record page shows a handful of long-text fields). */
export const COEDIT_WATCH_MAX = 60
/** How long a "may still type here" answer is reused while someone types (per field watch). */
export const COEDIT_WRITE_RECHECK_MS = 5_000
/** A heartbeat is written at most this often per editor. */
const SEEN_EVERY_MS = 10_000

export function coeditRoomNames(t: CoeditTarget) {
  const tail = `${t.field}:${t.collection}:${t.item}`
  return { read: `coedit:r:${tail}`, write: `coedit:w:${tail}` }
}

/** `{collection, item, field, write}` of a co-edit room name (tenant prefix already split off). */
export function parseCoeditRoom(room: string): (CoeditTarget & { write: boolean }) | null {
  const m = /^coedit:(r|w):([^:]+):([^:]+):(.+)$/.exec(room)
  if (!m) return null
  return { write: m[1] === 'w', field: m[2], collection: m[3], item: m[4] }
}

interface Watch {
  target: CoeditTarget
  write: boolean
  /** The last "may this person still type here" answer and when it was asked. */
  verdict: { ok: boolean; at: number } | null
  readRoom: string
  writeRoom: string | null
  /** This socket's editors in the session → when their heartbeat was last written. */
  members: Map<string, number>
}

const tkey = (t: CoeditTarget) => `${t.collection}\u0001${t.item}\u0001${t.field}`

export function registerCoedit(
  io: Pick<Server, 'to'>,
  socket: Socket,
  getUser: () => User | null,
  scope: CoeditScope,
  deps: CoeditDeps
): void {
  const watches = new Map<string, Watch>()
  const userName = (u: User) =>
    ([u.first_name, u.last_name].filter(Boolean).join(' ').trim() || u.email || 'Someone').slice(
      0,
      80
    )
  const storeKey = (t: CoeditTarget): string | null => {
    const tenant = scope.tenantNow()
    return tenant == null ? null : sessionKey(tenant, t)
  }
  const sessionOut = (s: SessionState | null) =>
    s
      ? { sid: s.sid, version: s.version, baseVersion: s.baseVersion, doc: s.doc, steps: s.steps }
      : null
  /** The socket's watch of a field — while it is still in the field's read room (a room
   *  recheck after a permission change takes it out). */
  const watchOf = (p: unknown): Watch | null => {
    const t = cleanTarget(p)
    const w = t ? watches.get(tkey(t)) : undefined
    return w && socket.rooms.has(w.readRoom) ? w : null
  }
  /** …and may still type there (still in the cursor room). */
  const canType = (w: Watch | null): w is Watch & { writeRoom: string } =>
    !!w?.write && !!w.writeRoom && socket.rooms.has(w.writeRoom)

  const endFor = (w: Watch, reason: string) =>
    io.to(w.readRoom).emit('coedit:ended', { ...w.target, reason })

  /** One editor of this socket leaves the session; the last one out ends it. */
  const leaveMember = async (w: Watch, clientID: string) => {
    if (!w.members.delete(clientID)) return
    if (w.writeRoom)
      io.to(w.writeRoom).emit('coedit:cursor', { ...w.target, clientID, clear: true })
    const key = storeKey(w.target)
    if (!key) return
    try {
      if (await deps.store.leave(key, `${socket.id}:${clientID}`, deps.now())) endFor(w, 'left')
    } catch {
      /* the session lapses on its own TTL */
    }
  }

  const onWatch = async (p: unknown) => {
    const user = getUser()
    const t = cleanTarget(p)
    if (!user || !t) return
    const id = tkey(t)
    if (!watches.has(id) && watches.size >= COEDIT_WATCH_MAX) return
    // A person at a screen only (session, View-as, static token, phone): an API key may narrow
    // what its person reads, so integrations never receive typed text (the field:change rule).
    const kind = (socket.data?.nvrBind as { kind?: string } | undefined)?.kind
    if (!SCREEN_BINDS.has(String(kind))) return
    if (!(await deps.fieldMayTravel(t.collection, t.field))) return
    // Non-readers get nothing — not even a refusal naming the field.
    if (!(await deps.canSeeRecord(user, t.collection, t.item))) return
    if (!(await deps.mayRead(user, t.collection, t.field, kind).catch(() => false))) return
    const write = await deps.mayWrite(user, t.collection, t.item, t.field).catch(() => false)
    const names = coeditRoomNames(t)
    const readRoom = await scope.scopedRoom(names.read)
    const writeRoom = write ? await scope.scopedRoom(names.write) : null
    if (!readRoom || (write && !writeRoom)) return
    const prev = watches.get(id)
    if (prev?.writeRoom && !writeRoom) socket.leave(prev.writeRoom)
    socket.join(readRoom)
    if (writeRoom) socket.join(writeRoom)
    watches.set(id, {
      target: t,
      write,
      verdict: null,
      readRoom,
      writeRoom,
      members: prev?.members ?? new Map()
    })
    const key = storeKey(t)
    const session = key ? await deps.store.read(key).catch(() => null) : null
    socket.emit('coedit:state', { ...t, write, session: sessionOut(session) })
  }

  const onUnwatch = async (p: unknown) => {
    const w = watchOf(p)
    if (!w) return
    watches.delete(tkey(w.target))
    for (const clientID of [...w.members.keys()]) await leaveMember(w, clientID)
    socket.leave(w.readRoom)
    if (w.writeRoom) socket.leave(w.writeRoom)
  }

  const onOpen = async (p: unknown) => {
    const user = getUser()
    const w = watchOf(p)
    const o = (p ?? {}) as Record<string, unknown>
    const clientID = cleanClientId(o.clientID)
    const doc = cleanDoc(o.doc)
    if (!user || !w || !clientID || !doc) return
    const key = storeKey(w.target)
    if (!key) return
    // A writer while nobody else holds the record: someone else's live edit lock means their
    // form owns the record, and everyone else watches the text read-only.
    // Take the editor in at once: its first steps can arrive while the lock check below runs.
    const typing = canType(w)
    if (typing && !w.members.has(clientID)) w.members.set(clientID, 0)
    if (!typing || (await writeRefusedNow(user, w))) {
      w.members.delete(clientID)
      socket.emit('coedit:state', {
        ...w.target,
        write: false,
        session: sessionOut(await deps.store.read(key).catch(() => null))
      })
      return
    }
    const now = deps.now()
    const { created, state } = await deps.store.open(key, doc, `${socket.id}:${clientID}`, now)
    w.members.set(clientID, now)
    const out = { ...w.target, session: sessionOut(state) }
    if (created) io.to(w.readRoom).emit('coedit:active', { ...out, by: clientID })
    else socket.emit('coedit:state', { ...out, write: true })
  }

  /** Refused now? Asked fresh (an open), and at most every few seconds while typing. */
  const writeRefusedNow = async (user: User, w: Watch, cached = false): Promise<boolean> => {
    const now = deps.now()
    if (cached && w.verdict && now - w.verdict.at < COEDIT_WRITE_RECHECK_MS) return !w.verdict.ok
    const t = w.target
    const ok =
      (await deps.mayWrite(user, t.collection, t.item, t.field).catch(() => false)) &&
      !(await deps.writeRefused(user, t.collection, t.item, t.field).catch(() => true))
    w.verdict = { ok, at: now }
    return !ok
  }

  /**
   * This person may no longer type in the field (a lock taken since, the record moved into a
   * locked step, the field's write permission gone): out of the session and the cursor room,
   * told so — they stay a read-only watcher while they may still read the field.
   */
  const demote = async (w: Watch) => {
    for (const clientID of [...w.members.keys()]) await leaveMember(w, clientID)
    if (w.writeRoom) socket.leave(w.writeRoom)
    w.write = false
    await sendState(w)
  }

  const onSteps = async (p: unknown) => {
    const user = getUser()
    const w = watchOf(p)
    const o = (p ?? {}) as Record<string, unknown>
    const clientID = cleanClientId(o.clientID)
    const steps = cleanSteps(o.steps)
    const version = Number(o.version)
    const sid = typeof o.sid === 'string' && o.sid.length <= 40 ? o.sid : null
    if (!user || !w || !clientID || !sid || !steps) return
    if (!Number.isInteger(version) || version < 0) return
    // Only an editor that opened (or rejoined) the session types into it.
    if (!w.members.has(clientID)) return
    if (!canType(w) || (await writeRefusedNow(user, w, true))) {
      await demote(w)
      return
    }
    const key = storeKey(w.target)
    if (!key) return
    const now = deps.now()
    const member = `${socket.id}:${clientID}`
    const r = await deps.store.append(key, sid, version, steps, clientID, member, now)
    if (r.ok) {
      w.members.set(clientID, now)
      io.to(w.readRoom).emit('coedit:steps', {
        ...w.target,
        sid,
        version,
        steps: steps.map((s) => JSON.parse(s)),
        clientIDs: steps.map(() => clientID)
      })
      return
    }
    if (r.reason === 'behind') {
      await sendSince(w, sid, version)
      return
    }
    if (r.reason === 'full') {
      // Everyone starts over: the next typist opens a fresh session from their document.
      await deps.store.drop(key).catch(() => {})
      endFor(w, 'full')
      return
    }
    // Another session (this one ended, or lapsed): tell this editor what there is now.
    w.members.delete(clientID)
    await sendState(w)
  }

  const sendState = async (w: Watch) => {
    const key = storeKey(w.target)
    const state = key ? await deps.store.read(key).catch(() => null) : null
    socket.emit('coedit:state', { ...w.target, write: canType(w), session: sessionOut(state) })
  }

  /** The steps after `version` of session `sid` to this socket, or the whole session when the
   *  socket holds another one (or a version it no longer has). */
  const sendSince = async (w: Watch, sid: string, version: number) => {
    const key = storeKey(w.target)
    if (!key) return
    const since = await deps.store.since(key, version).catch(() => null)
    if (since && since.sid === sid && since.steps.length > 0) {
      socket.emit('coedit:steps', {
        ...w.target,
        sid: since.sid,
        version: since.version,
        steps: since.steps.map((s) => s.s),
        clientIDs: since.steps.map((s) => s.c)
      })
      return
    }
    if (since && since.sid === sid) return
    await sendState(w)
  }

  /** `{sid, version}` = the steps since it; nothing = the whole session (a second tab). */
  const onSync = async (p: unknown) => {
    const w = watchOf(p)
    if (!getUser() || !w) return
    const o = (p ?? {}) as { version?: unknown; sid?: unknown }
    if (o.version == null || typeof o.sid !== 'string') {
      await sendState(w)
      return
    }
    const version = Number(o.version)
    if (!Number.isInteger(version) || version < 0) return
    await sendSince(w, o.sid, version)
  }

  const onCursor = async (p: unknown) => {
    const user = getUser()
    const w = watchOf(p)
    const o = (p ?? {}) as Record<string, unknown>
    const clientID = cleanClientId(o.clientID)
    if (!user || !w || !clientID || !w.members.has(clientID)) return
    if (!canType(w)) {
      await demote(w)
      return
    }
    if (o.clear === true) {
      socket.to(w.writeRoom).emit('coedit:cursor', { ...w.target, clientID, clear: true })
      return
    }
    const version = Number(o.version)
    const anchor = Number(o.anchor)
    const head = Number(o.head)
    if (![version, anchor, head].every((n) => Number.isInteger(n) && n >= 0)) return
    socket.to(w.writeRoom).emit('coedit:cursor', {
      ...w.target,
      clientID,
      version,
      anchor,
      head,
      user: { id: user.id, name: userName(user) }
    })
    // A focused editor's cursor doubles as its heartbeat.
    const now = deps.now()
    if (now - (w.members.get(clientID) ?? 0) >= SEEN_EVERY_MS) {
      w.members.set(clientID, now)
      const key = storeKey(w.target)
      if (key) await deps.store.seen(key, `${socket.id}:${clientID}`, now).catch(() => {})
    }
  }

  const onClose = async (p: unknown) => {
    const w = watchOf(p)
    const clientID = cleanClientId((p as { clientID?: unknown } | null)?.clientID)
    if (!w || !clientID) return
    await leaveMember(w, clientID)
  }

  // Inside the socket's tenant (cloud: the gates read that tenant's database). Never throws:
  // a co-edit event never takes the socket down. Returns the work, for tests to await.
  const guard = (fn: (p: unknown) => Promise<void>) =>
    inSocketTenant(socket, async (payload: unknown) => {
      try {
        await fn(payload)
      } catch {
        /* dropped */
      }
    })
  socket.on('coedit:watch', guard(onWatch))
  socket.on('coedit:unwatch', guard(onUnwatch))
  socket.on('coedit:open', guard(onOpen))
  socket.on('coedit:steps', guard(onSteps))
  socket.on('coedit:sync', guard(onSync))
  socket.on('coedit:cursor', guard(onCursor))
  socket.on('coedit:close', guard(onClose))
  socket.on('disconnect', () => {
    void (async () => {
      for (const w of watches.values())
        for (const clientID of [...w.members.keys()]) await leaveMember(w, clientID)
      watches.clear()
    })()
  })
}

/** The permission gates (also what the room recheck asks, socket-access.ts). */
export function coeditGates(): Omit<CoeditDeps, 'store' | 'now'> {
  return {
    async fieldMayTravel(collection, field) {
      const { isSharedTextField } = await import('./coedit-fields.js')
      return isSharedTextField(collection, field)
    },
    async canSeeRecord(user, collection, item) {
      const { canSeeRecordRoom } = await import('./socket-access.js')
      return canSeeRecordRoom(user, collection, item)
    },
    async mayRead(user, collection, field, kind) {
      // The same answer the keystroke relay gives this socket (fix-keystroke): a value field of
      // the collection, the person's read list, and a sign-in kind that is exactly the person.
      const { fieldChangeDelivery } = await import('./field-change-relay.js')
      const { valueTo } = await fieldChangeDelivery(
        [{ socket: 'coedit', id: String(user.id), kind }],
        collection,
        field
      )
      return valueTo.length === 1
    },
    async mayWrite(user, collection, item, field) {
      const { getAllowedFields } = await import('./permissions.js')
      const fields = await getAllowedFields(user, 'update', collection)
      if (fields !== null && !fields.includes('*') && !fields.includes(field)) return false
      const { canUpdateItem } = await import('./items.js')
      return canUpdateItem(user, collection, item)
    },
    async writeRefused(user, collection, item, field) {
      // The PATCH route's own gate (held lock, the record as the caller, the step's edit lock).
      const { recordWriteRefusal } = await import('./edit-lock.js')
      const { isAdminRole } = await import('./permissions.js')
      const req = {
        user,
        isAdmin: await isAdminRole(user),
        authMethod: 'session',
        headers: {}
      } as unknown as Parameters<typeof recordWriteRefusal>[0]
      // Shared text is written together even while someone holds the record lock (Rob,
      // 2026-11-14): the held-lock tier is skipped; the step's own edit lock (post-approval,
      // admin-only) and the record gates still refuse.
      return !!(await recordWriteRefusal(req, collection, item, {
        fields: [field],
        heldLock: false
      }))
    }
  }
}

/** The production wiring: Redis when the app has it (every replica, one session), else memory. */
export function defaultCoeditDeps(app: { redis?: unknown }): CoeditDeps {
  const redis = app.redis as Parameters<typeof redisCoeditStore>[0] | undefined
  const store =
    redis && typeof (redis as { eval?: unknown }).eval === 'function'
      ? redisCoeditStore(redis)
      : memoryCoeditStore()
  return { store, ...coeditGates(), now: Date.now }
}
