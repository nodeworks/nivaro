import { onPeopleWrite, type PeopleWriteKind } from '../db/people-signal.js'
import { noteCollectionWrite } from './read-caches.js'
import { emitToSignedIn } from './record-events.js'
import { currentRequestHint, currentTraceMeta } from './request-trace.js'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * People directory live (rt2 #19). A person added, renamed, given a new title or photo,
 * suspended, back from out of office… reaches every open picker, mention list and avatar
 * without a reload:
 *
 *   people:changed {at, user_ids?, created?}
 *
 * to every FULLY signed-in socket of the tenant (it names people ids, like presence:changed —
 * never an anonymous or access-pending socket). `user_ids` (≤ PEOPLE_IDS_MAX) when every write
 * in the window named its person; absent = "anyone" (a bulk write, a directory sync). Ids only:
 * never a name, a value or a credential — each tab refetches through its own permission-checked
 * reads (packages/shared lib/user-sync.ts).
 *
 * Coalesced per tenant: the first write is announced PEOPLE_SETTLE_MS later (a surrounding
 * transaction has committed by then) and never sooner than PEOPLE_GAP_MS after the previous
 * announcement — a directory sync of 500 people is one notice.
 */

export const PEOPLE_SETTLE_MS = 1000
export const PEOPLE_GAP_MS = 3000
export const PEOPLE_IDS_MAX = 50

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const PERSON_URL = new RegExp(
  `^/api/(?:users|items/nivaro_users|offboarding|user-scopes)/(${UUID}|me)(?:[/?]|$)`,
  'i'
)

/**
 * The person a write inside a request is about, from its URL; null = unknown (anyone).
 * `/users/me…` is the caller. Exported for tests.
 */
export function personOfRequest(url: string | null, callerId: string | null): string | null {
  if (!url) return null
  const m = PERSON_URL.exec(url.split('#')[0])
  if (!m) return null
  if (m[1].toLowerCase() === 'me') return callerId
  return m[1]
}

/** Sign-in writes the person's row on every sign-in (names, last access); the sign-in path
 *  announces a real change itself (notePeopleChanged), so these are not a directory change. */
export function isSignInRequest(url: string | null): boolean {
  return !!url && /^\/api\/auth\//i.test(url)
}

/**
 * Did a sign-in's rewrite of a person's row change something the directory shows? Values are
 * compared here, in the sign-in path; nothing about them leaves it. Exported for tests.
 */
export function signInChangedDirectory(
  before: Record<string, unknown>,
  updates: Record<string, unknown>
): boolean {
  const same = (a: unknown, b: unknown) =>
    String(a ?? '').toUpperCase() === String(b ?? '').toUpperCase()
  for (const col of [
    'first_name',
    'last_name',
    'title',
    'department',
    'company',
    'office_location',
    'role'
  ]) {
    if (col in updates && !same(before[col], updates[col])) return true
  }
  if ('avatar' in updates && (before.avatar ?? null) !== (updates.avatar ?? null)) return true
  return false
}

interface Pending {
  ids: Set<string>
  any: boolean
  created: boolean
  timer: ReturnType<typeof setTimeout> | null
  lastAt: number
}

const pending = new Map<string, Pending>()

/** The notice payload for one window. Exported for tests: ids and flags only. */
export function peopleChangedPayload(
  p: { ids: Iterable<string>; any: boolean; created: boolean },
  now = Date.now()
): { at: number; user_ids?: string[]; created?: true } {
  const ids = [...new Set([...p.ids].map((x) => String(x)))]
  const out: { at: number; user_ids?: string[]; created?: true } = { at: now }
  if (!p.any && ids.length > 0 && ids.length <= PEOPLE_IDS_MAX) out.user_ids = ids
  if (p.created) out.created = true
  return out
}

type Emit = (tenant: string, event: string, payload: Record<string, unknown>) => void
let emit: Emit = emitToSignedIn

/** Tests: capture what would be emitted. */
export function setPeopleEmitterForTests(fn: Emit | null): void {
  emit = fn ?? emitToSignedIn
}

/**
 * Announce that people changed. `ids` = whom (omit = anyone); `created` = someone new. The
 * driver-seam listener calls it for every directory write; code that knows better (sign-in)
 * calls it directly.
 */
export function notePeopleChanged(
  ids: Array<string | null | undefined> | null,
  opts: { created?: boolean; tenant?: string } = {}
): void {
  const tenant = opts.tenant ?? currentTenantKey()
  // rt4 #9: a cached global search (its people part) is stale from now on in this process.
  noteCollectionWrite('nivaro_users', tenant)
  let p = pending.get(tenant)
  if (!p) {
    p = { ids: new Set(), any: false, created: false, timer: null, lastAt: 0 }
    pending.set(tenant, p)
  }
  const named = (ids ?? []).filter((x): x is string => typeof x === 'string' && x.length > 0)
  if (named.length === 0) p.any = true
  for (const id of named) p.ids.add(id.toUpperCase())
  if (opts.created) p.created = true
  if (p.timer) return
  const wait = Math.max(PEOPLE_SETTLE_MS, p.lastAt + PEOPLE_GAP_MS - Date.now())
  const state = p
  state.timer = setTimeout(() => {
    state.timer = null
    state.lastAt = Date.now()
    const payload = peopleChangedPayload(state)
    state.ids.clear()
    state.any = false
    state.created = false
    try {
      emit(tenant, 'people:changed', payload)
    } catch {
      /* best-effort */
    }
  }, wait)
  state.timer.unref?.()
}

/** Tests: drop every pending window. */
export function resetPeopleLiveForTests(): void {
  for (const p of pending.values()) if (p.timer) clearTimeout(p.timer)
  pending.clear()
}

/** The seam listener: one directory write → its person (from the request) or anyone. */
export function onDirectoryWrite(kind: PeopleWriteKind): void {
  const url = currentRequestHint()
  if (isSignInRequest(url)) return
  const caller = currentTraceMeta()?.userId ?? null
  // A new person cannot be named by the creating request's URL: "anyone" refreshes lists.
  const who = kind === 'created' ? null : personOfRequest(url, caller)
  notePeopleChanged(who ? [who] : null, { created: kind === 'created' })
}

let wired = false
/** Hook the driver-seam signal. Idempotent; called once at boot. */
export function wirePeopleLive(): void {
  if (wired) return
  wired = true
  onPeopleWrite(onDirectoryWrite)
}
