import type { Server as SocketIOServer } from 'socket.io'
import { CLIENT_DATA_KEY, type ClientData } from './client-versions-cluster.js'
import { getIo } from './io-holder.js'
import { socketsServed } from './process-role.js'
import { currentTenantKey, tenantScopedRoom } from './tenant-rooms.js'

/**
 * Who is looking at what, across the cluster (post-mortem 3.3).
 *
 * "Is this person viewing the record" (notification suppression, #269) and "who is on this
 * page" (#42, replay auto-signals #1371, Traffic Map page detail) read the socket state of the
 * process that holds the sockets. A process that serves sockets keeps answering from its own,
 * exactly as before. A process with SOCKETS=off holds none, so it asks the processes that do
 * through the Redis adapter (fetchSockets, time-boxed): record viewers by the record room's
 * members, pages by `socket.data[PAGE_AT_KEY]`, which the socket plugin sets on every page
 * ping. A replica that does not answer in time makes the answer `partial` (never an error).
 */

/** socket.data key the socket plugin writes on every `page:at` ping. */
export const PAGE_AT_KEY = 'nvrPageAt'

export interface PageAtData {
  user: { id: string; name: string }
  path: string
  since: number
  app: string | null
  /** '' self-hosted; the cloud tenant key otherwise. */
  tenant: string
}

interface SocketLike {
  id: string
  data?: Record<string, unknown>
}

type Fetchable = { fetchSockets(): Promise<unknown[]> }

const VIEWING_TIMEOUT_MS = 750
const PAGES_TIMEOUT_MS = 1500
const PAGES_CACHE_MS = 3000

async function fetchTimeBoxed(
  target: Fetchable,
  ms: number
): Promise<{ sockets: SocketLike[]; partial: boolean }> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const sockets = await Promise.race([
      target.fetchSockets(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('fetchSockets timed out')), ms)
      })
    ])
    return { sockets: sockets as SocketLike[], partial: false }
  } catch {
    return { sockets: [], partial: true }
  } finally {
    clearTimeout(timer)
  }
}

export interface ClusterDeps {
  /** Socket.io server (default: the process's, io-holder). */
  io?: Pick<SocketIOServer, 'in' | 'fetchSockets'> | null
  /** Does this process serve sockets (default: socketsServed()). */
  served?: boolean
}

/**
 * Is `userId` viewing the record right now, on any process? This process's own sockets first
 * (the historic answer, and the whole answer where sockets are served here); with SOCKETS=off,
 * the record room's members on the realtime processes. Unknown (timeout) = not viewing, so the
 * notification is delivered rather than swallowed.
 */
export async function isUserViewingAnywhere(
  collection: string,
  item: string,
  userId: string,
  deps: ClusterDeps = {}
): Promise<boolean> {
  const { isUserViewing } = await import('../plugins/socketio.js')
  if (isUserViewing(collection, item, userId)) return true
  if (deps.served ?? socketsServed()) return false
  const io = deps.io === undefined ? getIo() : deps.io
  if (!io) return false
  const room = tenantScopedRoom(`record:${collection}:${item}`)
  const { sockets } = await fetchTimeBoxed(io.in(room), VIEWING_TIMEOUT_MS)
  return sockets.some((s) => {
    const d = s.data?.[CLIENT_DATA_KEY] as ClientData | undefined
    return d?.user?.id === userId
  })
}

const pagesCache = new Map<string, { at: number; value: Promise<ClusterPages> }>()

interface ClusterPages {
  pages: PageAtData[]
  partial: boolean
}

/** Every page ping the realtime processes hold for one tenant (cached 3 s, one flight). */
function clusterPages(io: Fetchable, tenant: string): Promise<ClusterPages> {
  const hit = pagesCache.get(tenant)
  if (hit && Date.now() - hit.at < PAGES_CACHE_MS) return hit.value
  const value = fetchTimeBoxed(io, PAGES_TIMEOUT_MS).then(({ sockets, partial }) => ({
    pages: sockets
      .map((s) => s.data?.[PAGE_AT_KEY] as PageAtData | undefined)
      .filter((p): p is PageAtData => !!p && p.tenant === tenant && !!p.user),
    partial
  }))
  pagesCache.set(tenant, { at: Date.now(), value })
  if (pagesCache.size > 500) pagesCache.delete(pagesCache.keys().next().value as string)
  return value
}

/** Tests only. */
export function resetClusterPagesCache(): void {
  pagesCache.clear()
}

/** Users whose latest page ping is `path` — this process's sockets, or the cluster's. */
export async function usersOnPathAnywhere(
  path: string,
  deps: ClusterDeps = {}
): Promise<{ users: Array<{ id: string; name: string; since: number }>; partial: boolean }> {
  const { usersOnPath } = await import('../plugins/socketio.js')
  if (deps.served ?? socketsServed()) return { users: usersOnPath(path), partial: false }
  const io = deps.io === undefined ? getIo() : deps.io
  if (!io) return { users: [], partial: false }
  const { pages, partial } = await clusterPages(io, currentTenantKey())
  const seen = new Map<string, { id: string; name: string; since: number }>()
  for (const p of pages) {
    if (p.path !== path) continue
    const cur = seen.get(p.user.id)
    if (!cur || p.since < cur.since) seen.set(p.user.id, { ...p.user, since: p.since })
  }
  return { users: [...seen.values()], partial }
}

/** Users whose latest page ping sits under any of `prefixes` (#1371), cluster-wide when needed. */
export async function usersOnPathPrefixAnywhere(
  prefixes: string[],
  deps: ClusterDeps = {}
): Promise<string[]> {
  const { usersOnPathPrefix } = await import('../plugins/socketio.js')
  if (deps.served ?? socketsServed()) return usersOnPathPrefix(prefixes)
  const io = deps.io === undefined ? getIo() : deps.io
  if (!io) return []
  const { pages } = await clusterPages(io, currentTenantKey())
  const ids = new Set<string>()
  for (const p of pages)
    if (
      prefixes.some((x) => p.path === x || p.path.startsWith(`${x}/`) || p.path.startsWith(`${x}?`))
    )
      ids.add(p.user.id)
  return [...ids]
}
