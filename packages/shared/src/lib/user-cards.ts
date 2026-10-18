import type { NivaroClient } from '@nivaro/sdk'
import { get, post } from './commands'

/**
 * People cards, batched. Every chip / avatar / name on a list used to read
 * `GET /users/:id/card` (and `GET /users/:id/avatar`) per person — 15 + 22
 * requests for a 25-row list. `loadUserCard` collects the ids asked for in
 * the same ~10 ms window and asks `POST /users/cards` once per 100 of them;
 * each caller still gets its own card (or null for an unknown id), and a
 * failed chunk only fails the callers in that chunk.
 *
 * Callers keep their own react-query keys (`['user-card', id]` holds the
 * single route's exact `data` shape), so a later single read is a cache hit.
 * An API without the batch route (older server) gets one GET per id instead.
 */

export interface UserCardRow {
  id: string
  first_name: string | null
  last_name: string | null
  email: string
  title?: string | null
  phone?: string | null
  department?: string | null
  company?: string | null
  /** 96px data URI or null (redacted accounts never carry one). */
  avatar?: string | null
  status?: string | null
  last_access?: string | null
  is_out_of_office?: boolean
  role_name?: string | null
  manager_name?: string | null
  manager_id?: string | null
  [k: string]: unknown
}

type Requester = Pick<NivaroClient, 'request'>

export const USER_CARD_BATCH_MAX = 100
export const USER_CARD_BATCH_WINDOW_MS = 10

interface Waiter {
  resolve: (card: UserCardRow | null) => void
  reject: (err: unknown) => void
}

interface Loader {
  pending: Map<string, { id: string; waiters: Waiter[] }>
  timer: ReturnType<typeof setTimeout> | null
  /** The server answered 404/405 for the batch route: read one by one from now on. */
  noBatch: boolean
}

const loaders = new WeakMap<object, Loader>()

function loaderFor(client: Requester): Loader {
  let l = loaders.get(client)
  if (!l) {
    l = { pending: new Map(), timer: null, noBatch: false }
    loaders.set(client, l)
  }
  return l
}

function statusOf(err: unknown): number | undefined {
  const e = err as { status?: number; response?: { status?: number } } | null
  return e?.status ?? e?.response?.status
}

async function readOne(client: Requester, id: string): Promise<UserCardRow | null> {
  try {
    const r = await client.request<{ data: UserCardRow | null }>(
      get(`/users/${encodeURIComponent(id)}/card`)
    )
    return r?.data ?? null
  } catch (err) {
    if (statusOf(err) === 404) return null
    throw err
  }
}

function settle(entries: Array<{ id: string; waiters: Waiter[] }>, byId: Map<string, UserCardRow>) {
  for (const e of entries) {
    const card = byId.get(e.id.toUpperCase()) ?? null
    for (const w of e.waiters) w.resolve(card)
  }
}

async function runChunk(
  client: Requester,
  l: Loader,
  entries: Array<{ id: string; waiters: Waiter[] }>
): Promise<void> {
  if (!l.noBatch) {
    try {
      const r = await client.request<{ data: UserCardRow[] }>(
        post('/users/cards', { ids: entries.map((e) => e.id) })
      )
      const byId = new Map<string, UserCardRow>()
      for (const row of r?.data ?? []) {
        if (row?.id != null) byId.set(String(row.id).toUpperCase(), row)
      }
      settle(entries, byId)
      return
    } catch (err) {
      const s = statusOf(err)
      if (s !== 404 && s !== 405) {
        for (const e of entries) for (const w of e.waiters) w.reject(err)
        return
      }
      l.noBatch = true
    }
  }
  await Promise.all(
    entries.map(async (e) => {
      try {
        const card = await readOne(client, e.id)
        for (const w of e.waiters) w.resolve(card)
      } catch (err) {
        for (const w of e.waiters) w.reject(err)
      }
    })
  )
}

function flush(client: Requester, l: Loader): void {
  l.timer = null
  const entries = [...l.pending.values()]
  l.pending.clear()
  for (let i = 0; i < entries.length; i += USER_CARD_BATCH_MAX) {
    void runChunk(client, l, entries.slice(i, i + USER_CARD_BATCH_MAX))
  }
}

/** One person's card through the shared batch (null = no such person). */
export function loadUserCard(
  client: Requester,
  id: string | number | null | undefined
): Promise<UserCardRow | null> {
  if (id == null || id === '') return Promise.resolve(null)
  const sid = String(id)
  const l = loaderFor(client)
  return new Promise<UserCardRow | null>((resolve, reject) => {
    const key = sid.toUpperCase()
    const entry = l.pending.get(key)
    if (entry) entry.waiters.push({ resolve, reject })
    else l.pending.set(key, { id: sid, waiters: [{ resolve, reject }] })
    if (!l.timer) l.timer = setTimeout(() => flush(client, l), USER_CARD_BATCH_WINDOW_MS)
  })
}

/**
 * The react-query options every `['user-card', id]` reader shares, so they
 * all hold the same shape (the card route's `data`, or null).
 */
export function userCardQuery<T = UserCardRow>(
  client: Requester | null | undefined,
  id: string | number | null | undefined
): { queryKey: readonly unknown[]; queryFn: () => Promise<T | null> } {
  return {
    queryKey: ['user-card', id],
    queryFn: () => (client ? loadUserCard(client, id) : Promise.resolve(null)) as Promise<T | null>
  }
}
