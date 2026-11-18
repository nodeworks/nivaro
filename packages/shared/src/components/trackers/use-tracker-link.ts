import type { NivaroClient } from '@nivaro/sdk'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useItemEditAuth, useNivaroClient, useOptionalNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import type {
  TrackerAny,
  TrackerChipData,
  TrackerConnectionInfo,
  TrackerLink,
  TrackerSourceKind,
  TrackerSourceRef
} from './tracker-model'

/**
 * GitLab sync reads for the shared screens. Every key lives under ['trackers', …] — the same root
 * the admin Issue trackers tab invalidates — and each holds ONE shape (lib/query-keys.ts rules):
 *
 *   ['trackers', 'feature', 'public']          boolean            GET /trackers/feature/public
 *   ['trackers', 'connections']                connection list    GET /trackers (admins)
 *   ['trackers', 'creatable', kind]            connection list    GET /trackers/creatable
 *   ['trackers', 'links-for', kind, id]        chip list          GET /trackers/links/for
 *   ['trackers', 'source-links', kind, id]     LinkView list      GET /trackers/links/source/… (admins)
 */
export const trackerQueryKeys = {
  all: ['trackers'] as const,
  featurePublic: () => ['trackers', 'feature', 'public'] as const,
  connections: () => ['trackers', 'connections'] as const,
  creatable: (kind: TrackerSourceKind) => ['trackers', 'creatable', kind] as const,
  linksFor: (kind: TrackerSourceKind, id: string) => ['trackers', 'links-for', kind, id] as const,
  sourceLinks: (kind: TrackerSourceKind, id: string) =>
    ['trackers', 'source-links', kind, id] as const,
  similar: (kind: TrackerSourceKind, id: string, connection: number) =>
    ['trackers', 'similar', kind, id, connection] as const,
  sample: (kind: TrackerSourceKind, id: string) => ['trackers', 'source-sample', kind, id] as const,
  rules: () => ['trackers', 'rules'] as const,
  projects: (connection: number, search: string) =>
    ['trackers', 'projects', connection, search] as const,
  labels: (connection: number, project: number | null) =>
    ['trackers', 'labels', connection, project] as const,
  users: (connection: number, project: number, search: string) =>
    ['trackers', 'users', connection, project, search] as const
}

const statusOf = (err: unknown): number | undefined => {
  const e = err as { status?: number; response?: { status?: number } } | null
  return e?.status ?? e?.response?.status
}

/** GET /trackers/feature/public; a 404 (cloud mode: the routes are not mounted) = off. */
export async function fetchTrackerFeature(client: NivaroClient): Promise<boolean> {
  try {
    const r = await client.request<{ data: { enabled: boolean } }>(get('/trackers/feature/public'))
    return !!r.data?.enabled
  } catch (err) {
    if (statusOf(err) === 404) return false
    throw err
  }
}

/**
 * Is GitLab sync on? Every GitLab piece asks this first and renders nothing while it is off. A
 * screen mounted without a NivaroProvider (an embed, a test) reads it as off.
 */
export function useTrackerFeature(): { on: boolean; loading: boolean } {
  const client = useOptionalNivaroClient()
  const q = useQuery({
    queryKey: trackerQueryKeys.featurePublic(),
    queryFn: () => fetchTrackerFeature(client as NivaroClient),
    enabled: !!client,
    staleTime: 60_000,
    retry: false
  })
  return { on: q.data === true, loading: q.isLoading }
}

/** Active connections whose switch for this kind is on (missing setting = on, like the server). */
export function syncingConnections<T extends TrackerConnectionInfo>(
  all: T[] | undefined,
  kind: TrackerSourceKind
): T[] {
  return (all ?? []).filter((c) => c.is_active !== false && c.sync?.sources?.[kind] !== false)
}

/** GET /trackers — administrators only (the full connection list, sync options included). */
export const fetchTrackerConnections = (client: NivaroClient) =>
  client.request<{ data: TrackerConnectionInfo[] }>(get('/trackers')).then((r) => r.data ?? [])

/**
 * The connections this person may create on for a kind of source. Administrators: every active
 * connection that syncs the kind, with its sync options (GET /trackers). Everyone else: GET
 * /trackers/creatable (the connections whose create roles hold their role) — never the full list.
 */
export function useTrackerConnections(
  kind: TrackerSourceKind,
  opts: { enabled: boolean }
): { connections: TrackerConnectionInfo[]; loading: boolean } {
  const client = useNivaroClient()
  const { isAdmin } = useItemEditAuth()
  const admin = useQuery({
    queryKey: trackerQueryKeys.connections(),
    queryFn: () => fetchTrackerConnections(client),
    enabled: opts.enabled && isAdmin,
    staleTime: 60_000,
    retry: false
  })
  const person = useQuery({
    queryKey: trackerQueryKeys.creatable(kind),
    queryFn: () =>
      client
        .request<{ data: TrackerConnectionInfo[] }>(
          get('/trackers/creatable', { source_kind: kind })
        )
        .then((r) => r.data ?? []),
    enabled: opts.enabled && !isAdmin && kind !== 'issue',
    staleTime: 60_000,
    retry: false
  })
  const connections = useMemo(() => {
    if (!opts.enabled) return []
    return isAdmin ? syncingConnections(admin.data, kind) : (person.data ?? [])
  }, [opts.enabled, isAdmin, admin.data, person.data, kind])
  return { connections, loading: isAdmin ? admin.isLoading : person.isLoading }
}

/** How long the screen keeps asking for a GitLab issue it asked to be created (4 s apart). */
export const CREATE_WAIT_MS = 120_000
const CREATE_POLL_MS = 4_000

export interface SourceTracker {
  /** GitLab sync is on. */
  on: boolean
  isAdmin: boolean
  /** Connections this person may create / link on (empty = they may not). */
  connections: TrackerConnectionInfo[]
  canCreate: boolean
  /** The chips (everyone who can read the source). */
  chips: TrackerChipData[]
  /** What a header shows: an administrator's whole link (its sync error too), else the chips. */
  shown: TrackerAny[]
  /** Administrators: the whole link on a connection that syncs this kind. */
  link: TrackerLink | null
  /** A create was asked for and its GitLab issue has not shown up yet. */
  creating: boolean
  /** Still waiting past CREATE_WAIT_MS. */
  slow: boolean
  markCreating: () => void
  refresh: () => void
}

/**
 * Everything a ticket / record GitLab surface needs. Nothing is read while GitLab sync is off;
 * the connection reads run only while `mayCreate` (the host's "may work this" gate) holds.
 */
export function useSourceTracker(
  source: TrackerSourceRef | null,
  opts: { mayCreate?: boolean } = {}
): SourceTracker {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const { isAdmin } = useItemEditAuth()
  const feature = useTrackerFeature()
  const on = feature.on && !!source?.id
  const kind = source?.kind ?? 'record'
  const id = source?.id ?? ''
  const { connections } = useTrackerConnections(kind, {
    enabled: on && opts.mayCreate !== false
  })
  const [creatingSince, setCreatingSince] = useState<number | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const waiting = creatingSince != null && now - creatingSince < CREATE_WAIT_MS
  const chips = useQuery({
    queryKey: trackerQueryKeys.linksFor(kind, id),
    queryFn: () =>
      client
        .request<{ data: TrackerChipData[] }>(
          get('/trackers/links/for', { source_kind: kind, source_id: id })
        )
        .then((r) => r.data ?? []),
    enabled: on,
    staleTime: 30_000,
    retry: false,
    refetchInterval: waiting ? CREATE_POLL_MS : false
  })
  const links = useQuery({
    queryKey: trackerQueryKeys.sourceLinks(kind, id),
    queryFn: () =>
      client
        .request<{ data: TrackerLink[] }>(
          get(`/trackers/links/source/${kind}/${encodeURIComponent(id)}`)
        )
        .then((r) => r.data ?? []),
    enabled: on && isAdmin && kind !== 'issue' && opts.mayCreate !== false,
    staleTime: 30_000,
    retry: false,
    refetchInterval: waiting ? CREATE_POLL_MS : false
  })
  const chipList = on ? (chips.data ?? []) : []
  // An admin's whole link, only on a connection that syncs this kind (the chip's rule).
  const shownConnections = new Set(
    chipList.map((c) => c.connection).filter((n): n is number => n != null)
  )
  const link =
    on && isAdmin
      ? ((links.data ?? []).find(
          (l) =>
            shownConnections.has(l.connection) || connections.some((c) => c.id === l.connection)
        ) ?? null)
      : null
  const linked = chipList.length > 0 || !!link

  // Tick while waiting so `slow` turns on; stop once the GitLab issue shows up.
  useEffect(() => {
    if (creatingSince == null) return
    if (linked) {
      setCreatingSince(null)
      return
    }
    const t = window.setInterval(() => setNow(Date.now()), CREATE_POLL_MS)
    return () => window.clearInterval(t)
  }, [creatingSince, linked])

  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: trackerQueryKeys.linksFor(kind, id) })
    void qc.invalidateQueries({ queryKey: trackerQueryKeys.sourceLinks(kind, id) })
  }, [qc, kind, id])

  const markCreating = useCallback(() => {
    const t = Date.now()
    setNow(t)
    setCreatingSince(t)
    refresh()
  }, [refresh])

  return {
    on,
    isAdmin,
    connections: on ? connections : [],
    canCreate: on && opts.mayCreate !== false && connections.length > 0,
    chips: chipList,
    shown: link ? [link] : chipList,
    link,
    creating: creatingSince != null && !linked,
    slow: creatingSince != null && !linked && !waiting,
    markCreating,
    refresh
  }
}
