import { db } from '../db/index.js'
import { selectInChunks, whereInList } from './db-batch.js'
import { PRESENCE_ONLINE_WINDOW_MS } from './presence-sockets.js'
import { presenceOverrideAway } from './presence-stuck.js'

/**
 * "Is this person online right now?" for server decisions — @here, support auto-assignment,
 * "who can act now" (realtime audit M8, 2026-11-18). The Online list's own rules, in one place:
 *
 *  - a presence row seen inside the online window (70 s), AND
 *  - `is_online` not false, OR a live socket says so — a closing tab's pagehide beacon writes
 *    is_online=false for the whole person while their other tabs are still open (the same
 *    rescue /presence/online does, onlineByRowOrSocket), AND
 *  - not a machine account (integration, bot, service), AND
 *  - not using "Appear away".
 *
 * Returns upper-cased ids. Never throws: no presence = nobody reads as online.
 */
export interface OnlineNowDeps {
  rows?: (ids: string[], since: Date) => Promise<Array<{ user_id: unknown; is_online: unknown }>>
  connected?: (userId: string) => boolean | null
  people?: (
    ids: string[]
  ) => Promise<Array<{ id: unknown; account_kind?: unknown; preferences?: unknown }>>
}

const up = (v: unknown) => String(v ?? '').toUpperCase()

export async function onlineNow(
  ids: ReadonlyArray<string>,
  now: Date = new Date(),
  deps: OnlineNowDeps = {}
): Promise<Set<string>> {
  const wanted = [...new Set(ids.map(String).filter(Boolean))]
  if (wanted.length === 0) return new Set()
  const since = new Date(now.getTime() - PRESENCE_ONLINE_WINDOW_MS)
  let rows: Array<{ user_id: unknown; is_online: unknown }>
  try {
    rows = await (deps.rows ?? readPresenceRows)(wanted, since)
  } catch {
    return new Set()
  }
  const connected =
    deps.connected ??
    (await import('../plugins/socketio.js').then((m) => m.isUserConnected).catch(() => undefined))
  const online = new Set<string>()
  for (const r of rows) {
    const flag = r.is_online
    let live = flag !== false && flag !== 0
    if (!live) {
      try {
        live = connected?.(String(r.user_id ?? '')) === true
      } catch {
        live = false
      }
    }
    if (live) online.add(up(r.user_id))
  }
  if (online.size === 0) return online
  let people: Array<{ id: unknown; account_kind?: unknown; preferences?: unknown }> = []
  try {
    people = await (deps.people ?? readPeople)([...online])
  } catch {
    return online // decoration only: keep the presence answer
  }
  for (const p of people) {
    const kind = p.account_kind
    const machine = typeof kind === 'string' && kind !== '' && kind !== 'placeholder'
    if (machine || presenceOverrideAway(parsePrefs(p.preferences))) online.delete(up(p.id))
  }
  return online
}

function parsePrefs(raw: unknown): Record<string, unknown> {
  if (!raw) return {}
  if (typeof raw === 'object') return raw as Record<string, unknown>
  try {
    const v = JSON.parse(String(raw))
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function readPresenceRows(ids: string[], since: Date) {
  return selectInChunks(
    ids,
    1000,
    (chunk) =>
      whereInList(db('user_presence'), 'user_id', chunk)
        .where('last_seen', '>=', since)
        .select('user_id', 'is_online') as Promise<Array<{ user_id: unknown; is_online: unknown }>>
  )
}

async function readPeople(ids: string[]) {
  const prefs = (await selectInChunks(
    ids,
    1000,
    (chunk) =>
      whereInList(db('nivaro_users'), 'id', chunk).select('id', 'preferences') as Promise<
        Array<{ id: unknown; preferences?: unknown }>
      >
  )) as Array<{ id: unknown; account_kind?: unknown; preferences?: unknown }>
  // Read on its own so a database without the column keeps every person.
  const machines = new Set((await machineAccountIds(ids).catch(() => [])).map(up))
  for (const p of prefs) if (machines.has(up(p.id))) p.account_kind = 'machine'
  return prefs
}

/** Of these user ids, the machine accounts (account_kind set, not a placeholder). */
export async function machineAccountIds(ids: string[]): Promise<string[]> {
  if (ids.length === 0) return []
  const found = await selectInChunks(
    ids,
    1000,
    (chunk) =>
      whereInList(db('nivaro_users'), 'id', chunk)
        .whereNotNull('account_kind')
        .whereNotIn('account_kind', ['', 'placeholder'])
        .select('id') as Promise<Array<{ id: string }>>
  )
  return found.map((r) => String(r.id))
}
