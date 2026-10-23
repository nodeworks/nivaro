/**
 * Open tabs by build across EVERY API replica (#1048 follow-up).
 *
 * Each socket's build report (client:hello) used to live only in the memory of the process the
 * socket connected to, so /realtime's versions list, the "Old versions" force refresh and the
 * "current build" judgement saw one replica's tabs. A replica whose tabs were all old would even
 * call the old build current. The report now also rides `socket.data.nvrClient`, which the Redis
 * adapter's fetchSockets() returns from every replica, so all three read the whole cluster.
 *
 * fetchSockets asks every replica and waits for each answer; a replica that does not answer in
 * time fails the whole call. Then this process's own sockets are used and the result says
 * `partial: true` so the page can say so rather than under-count quietly.
 *
 * Which build is current (makeBuildJudge) must survive a rolling deploy, when old and new copies
 * serve pages side by side and the newest page load can come from the old copy:
 *   - admin is served by the API itself, so once the instance roster shows ONE version and some
 *     admin tab reports it, that version is current (whatever loaded last);
 *   - while the roster shows two versions, admin is settling between those two and the "loaded
 *     against an older API" reason is off;
 *   - any other app (a headless frontend with its own replicas) takes its newest page load, but
 *     while two of its builds have loaded within SETTLE_MS the app is settling between them.
 * Settling shields only the contested builds (the ones being served right now): a tab on one of
 * them is never called old — no badge, and "Old versions" leaves it alone. A tab on any OTHER
 * build of a settling app is older than both and is judged old straight away.
 *
 * Admin routes only (and the admin-only presence badge). Never throws into a request.
 */
import type { Server as SocketIOServer } from 'socket.io'
import { NIVARO_VERSION } from '../version.js'
import { type ClientVersion, judgeable } from './client-version.js'
import { listInstances } from './instance-roster.js'
import { tenantScopedRoom } from './tenant-rooms.js'

/** What a socket publishes about itself on `socket.data` (small: it crosses Redis). */
export interface ClientData {
  app: string | null
  version: ClientVersion | null
  user: { id: string; name: string } | null
  /** The API process the socket is connected to (instance roster id). */
  node: string | null
}

export const CLIENT_DATA_KEY = 'nvrClient'

/** The app id the admin SPA reports — the one front end served by the API itself. */
export const API_SERVED_APP = 'admin'

/** Two builds of one app loaded within this window = a deploy is still rolling. */
export const SETTLE_MS = 10 * 60_000

/** One open socket anywhere in the cluster, with a way to reach it. */
export interface ClusterClient extends ClientData {
  id: string
  tenant: string | null
  emit: (event: string, payload: unknown) => void
}

export interface ClusterClients {
  clients: ClusterClient[]
  /** API processes that reported at least one signed-in socket. */
  nodes: number
  /** True when another replica did not answer and only this process's sockets are counted. */
  partial: boolean
  /** Distinct API versions in the instance roster (empty = no roster / no Redis). */
  roster: string[]
}

const FETCH_TIMEOUT_MS = 2500

interface SocketLike {
  id: string
  data?: Record<string, unknown>
  emit: (event: string, ...args: unknown[]) => unknown
}

function toClient(s: SocketLike): ClusterClient | null {
  const d = s.data?.[CLIENT_DATA_KEY] as ClientData | undefined
  if (!d?.user) return null
  const tenant = s.data?.nvrTenantKey
  return {
    id: s.id,
    app: d.app ?? null,
    version: d.version ?? null,
    user: d.user,
    node: d.node ?? null,
    tenant: typeof tenant === 'string' ? tenant : null,
    emit: (event, payload) => void s.emit(event, payload)
  }
}

function countNodes(clients: ClusterClient[]): number {
  return new Set(clients.map((c) => c.node ?? '?')).size
}

/** Distinct versions the API replicas are serving right now (instance roster, #297). */
export async function rosterVersions(): Promise<string[]> {
  const rows = await listInstances().catch(() => [])
  return [...new Set(rows.map((r) => String(r.version ?? '')).filter(judgeable))]
}

/**
 * Every signed-in socket of `tenant` (null = self-hosted, every socket) on every replica.
 * Falls back to this process's sockets when the cluster read fails or times out.
 */
export async function listClusterClients(
  io: SocketIOServer | null,
  tenant: string | null,
  timeoutMs = FETCH_TIMEOUT_MS,
  loadRoster: () => Promise<string[]> = rosterVersions
): Promise<ClusterClients> {
  const roster = await loadRoster().catch(() => [])
  if (!io) return { clients: [], nodes: 0, partial: false, roster }
  const keep = (c: ClusterClient | null): c is ClusterClient =>
    !!c && (tenant == null || c.tenant === tenant)
  try {
    // Cloud: only the tenant's own room is asked, so a replica answers with that tenant's
    // sockets, not every tenant's.
    const target = tenant != null ? io.in(tenantScopedRoom('all', tenant)) : io
    let timer: ReturnType<typeof setTimeout> | undefined
    const sockets = await Promise.race([
      target.fetchSockets(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('fetchSockets timed out')), timeoutMs)
      })
    ]).finally(() => clearTimeout(timer))
    const clients = (sockets as unknown as SocketLike[]).map(toClient).filter(keep)
    return { clients, nodes: countNodes(clients), partial: false, roster }
  } catch {
    const local = [...io.sockets.sockets.values()]
      .map((s) => toClient(s as unknown as SocketLike))
      .filter(keep)
    return { clients: local, nodes: countNodes(local), partial: true, roster }
  }
}

// Presence polls every 15 s per open admin panel; one cluster read serves them all for a few
// seconds. Keyed by tenant (module state is shared by every cloud tenant).
const CACHE_MS = 5000
const cache = new Map<string, { at: number; value: Promise<ClusterClients> }>()

export function listClusterClientsCached(
  io: SocketIOServer | null,
  tenant: string | null
): Promise<ClusterClients> {
  const key = tenant ?? ''
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value
  const value = listClusterClients(io, tenant)
  cache.set(key, { at: Date.now(), value })
  if (cache.size > 500) cache.delete(cache.keys().next().value as string)
  return value
}

/** Tests only. */
export function resetClusterClientsCache(): void {
  cache.clear()
}

type Judged = Pick<ClientData, 'app' | 'version' | 'user'>

export interface BuildJudge {
  /** app → its current build (absent = unknown, or settling). */
  current: Map<string, string>
  /** app → why it is not fully judged right now (a deploy is still rolling). */
  settling: Map<string, string>
  /** app → the builds a rolling deploy is serving side by side (shielded while settling). */
  contested: Map<string, Set<string>>
  /** The API version every replica serves; null while replicas disagree (not judged). */
  api: string | null
  /** Why this tab counts as old; null = current, unknown or on a contested build. */
  older(c: Pick<ClientData, 'app' | 'version'>): 'build' | 'api' | null
  /** The settling reason when this tab runs one of its app's contested builds, else null. */
  settlingOf(c: Pick<ClientData, 'app' | 'version'>): string | null
}

/** See the file header for the rules. `roster` = distinct API versions serving now. */
export function makeBuildJudge(
  clients: Judged[],
  opts: { roster: string[]; now?: number; self?: string }
): BuildJudge {
  const now = opts.now ?? Date.now()
  const self = opts.self ?? NIVARO_VERSION
  const mixedApi = opts.roster.length > 1
  const api = mixedApi ? null : (opts.roster[0] ?? (judgeable(self) ? self : null))

  // Per app: the newest load, and every build with a load inside the settle window.
  const byApp = new Map<string, { build: string; loaded: number; recent: Set<string> }>()
  const reported = new Map<string, Set<string>>()
  for (const c of clients) {
    const v = c.version
    if (!c.user || !v || !judgeable(v.build)) continue
    const app = c.app ?? 'app'
    reported.set(app, (reported.get(app) ?? new Set()).add(v.build))
    if (v.loaded == null) continue
    let a = byApp.get(app)
    if (!a) {
      a = { build: v.build, loaded: v.loaded, recent: new Set() }
      byApp.set(app, a)
    }
    if (v.loaded > a.loaded) {
      a.build = v.build
      a.loaded = v.loaded
    }
    if (v.loaded >= now - SETTLE_MS) a.recent.add(v.build)
  }

  const current = new Map<string, string>()
  const settling = new Map<string, string>()
  const contested = new Map<string, Set<string>>()
  for (const app of new Set([...reported.keys(), ...byApp.keys()])) {
    if (app === API_SERVED_APP) {
      // Only when admin's builds are API versions (some tab reports one): otherwise the roster
      // says nothing about admin and the load rule below decides.
      const seen = reported.get(app)
      if (mixedApi && opts.roster.some((v) => seen?.has(v))) {
        settling.set(app, `API replicas serve ${opts.roster.join(' and ')}`)
        contested.set(app, new Set(opts.roster))
        continue
      }
      // Served by the API: the roster's one version is current once a tab reports it.
      if (api && reported.get(app)?.has(api)) {
        current.set(app, api)
        continue
      }
    }
    const a = byApp.get(app)
    if (!a) continue
    if (a.recent.size > 1) {
      settling.set(app, `${[...a.recent].join(' and ')} both loaded in the last 10 minutes`)
      contested.set(app, a.recent)
      continue
    }
    current.set(app, a.build)
  }

  const settlingOf = (c: Pick<ClientData, 'app' | 'version'>): string | null => {
    const app = c.app ?? 'app'
    const why = settling.get(app)
    if (!why) return null
    const build = c.version?.build
    // A tab that never named a judgeable build is not judged either way.
    if (!judgeable(build) || contested.get(app)?.has(build)) return why
    return null
  }

  return {
    current,
    settling,
    contested,
    api,
    settlingOf,
    older(c) {
      const v = c.version
      if (!v) return null
      const app = c.app ?? 'app'
      if (settling.has(app)) {
        // Mid-deploy: the contested builds are shielded; any other build is older than both.
        return settlingOf(c) ? null : 'build'
      }
      const cur = current.get(app)
      if (judgeable(v.build) && cur && v.build !== cur) return 'build'
      if (api && judgeable(v.api) && v.api !== api) return 'api'
      return null
    }
  }
}

function judgeFor(clients: Judged[], judge?: BuildJudge): BuildJudge {
  return judge ?? makeBuildJudge(clients, { roster: [] })
}

export interface VersionGroup {
  app: string | null
  build: string | null
  api: string | null
  sockets: number
  users: number
  current: boolean
  older: 'build' | 'api' | null
  /** Set while a deploy of this app is still rolling: its tabs are not judged. */
  settling: string | null
  newest_load: string | null
  /** Who is on it (first 25 by name), so an admin can see WHO still needs a reload. */
  people: Array<{ id: string; name: string }>
}

const PEOPLE_CAP = 25

/**
 * Tabs grouped per app + build (+ API version), with whether each group is the current build
 * and whether a "reload old tabs" would reach it. Sockets that never said which build group
 * under null.
 */
export function groupClientVersions(clients: Judged[], judge?: BuildJudge): VersionGroup[] {
  const signedIn = clients.filter((c) => c.user)
  const j = judgeFor(signedIn, judge)
  const groups = new Map<
    string,
    Omit<VersionGroup, 'users' | 'people' | 'newest_load'> & {
      people: Map<string, string>
      loaded: number | null
    }
  >()
  for (const c of signedIn) {
    const v = c.version
    const older = j.older(c)
    const key = `${c.app ?? ''}|${v?.build ?? ''}|${v?.api ?? ''}`
    let g = groups.get(key)
    if (!g) {
      g = {
        app: c.app,
        build: v?.build ?? null,
        api: v?.api ?? null,
        sockets: 0,
        current: false,
        older,
        settling: j.settlingOf(c),
        people: new Map(),
        loaded: null
      }
      groups.set(key, g)
    }
    g.sockets++
    const uid = String(c.user!.id).toUpperCase()
    if (!g.people.has(uid)) g.people.set(uid, c.user!.name)
    if (v?.loaded != null && (g.loaded == null || v.loaded > g.loaded)) g.loaded = v.loaded
  }
  return [...groups.values()]
    .map((g) => ({
      app: g.app,
      build: g.build,
      api: g.api,
      sockets: g.sockets,
      users: g.people.size,
      current: !!g.build && j.current.get(g.app ?? 'app') === g.build && !g.older,
      older: g.older,
      settling: g.settling,
      newest_load: g.loaded != null ? new Date(g.loaded).toISOString() : null,
      people: [...g.people.entries()]
        .map(([id, name]) => ({ id, name }))
        .sort((a, b) => a.name.localeCompare(b.name))
        .slice(0, PEOPLE_CAP)
    }))
    .sort((a, b) => (a.app ?? '').localeCompare(b.app ?? '') || b.sockets - a.sockets)
}

/** Socket ids running an older build (or loaded against an older API) than the current one. */
export function olderClientIds(
  clients: Array<Pick<ClusterClient, 'id' | 'app' | 'version' | 'user'>>,
  judge?: BuildJudge
): Set<string> {
  const signedIn = clients.filter((c) => c.user)
  const j = judgeFor(signedIn, judge)
  return new Set(signedIn.filter((c) => j.older(c)).map((c) => c.id))
}

/** One app a person has open on an old build. */
export interface StaleBuild {
  app: string
  /** The build their tab runs (null when it is current but loaded against an older API). */
  build: string | null
  current_build: string | null
  reason: 'build' | 'api'
  tabs: number
}

/**
 * Per person (upper-cased id): the apps they have open on an old build. People whose every
 * tab is current are absent, and so is every app that is still settling.
 */
export function staleBuildsByUser(
  clients: Judged[],
  judge?: BuildJudge
): Map<string, StaleBuild[]> {
  const signedIn = clients.filter((c) => c.user)
  const j = judgeFor(signedIn, judge)
  const out = new Map<string, Map<string, StaleBuild>>()
  for (const c of signedIn) {
    const reason = j.older(c)
    if (!reason) continue
    const uid = String(c.user!.id).toUpperCase()
    const app = c.app ?? 'app'
    const build = judgeable(c.version?.build) ? c.version!.build : null
    const key = `${app}|${build ?? ''}|${reason}`
    let byKey = out.get(uid)
    if (!byKey) {
      byKey = new Map()
      out.set(uid, byKey)
    }
    const prev = byKey.get(key)
    if (prev) prev.tabs++
    else byKey.set(key, { app, build, current_build: j.current.get(app) ?? null, reason, tabs: 1 })
  }
  return new Map([...out].map(([uid, m]) => [uid, [...m.values()]]))
}
