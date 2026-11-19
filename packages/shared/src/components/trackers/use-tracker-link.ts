import type { NivaroClient } from '@nivaro/sdk'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useItemEditAuth, useNivaroClient, useOptionalNivaroClient } from '../../context'
import { get } from '../../lib/commands'
import { useLiveOps } from '../../lib/live-ops'
import {
  deadCreatesFor,
  shownTrackers,
  type TrackerAny,
  type TrackerChipData,
  type TrackerConnectionInfo,
  type TrackerLink,
  type TrackerOutboxRow,
  type TrackerPending,
  type TrackerSourceKind,
  type TrackerSourceRef
} from './tracker-model'

/**
 * GitLab sync reads for the shared screens. Every key lives under ['trackers', …] — the same root
 * the admin Issue trackers tab invalidates — and each holds ONE shape (lib/query-keys.ts rules):
 *
 *   ['trackers', 'feature', 'public']          boolean            GET /trackers/feature/public
 *   ['trackers', 'connections']                connection list    GET /trackers (admins)
 *   ['trackers', 'creatable', kind, id]        connection list    GET /trackers/creatable (source_id)
 *   ['trackers', 'links-for', kind, id]        chip list          GET /trackers/links/for
 *   ['trackers', 'source-links', kind, id]     LinkView list      GET /trackers/links/source/… (admins)
 *   ['trackers', 'dead-outbox']                outbox row list    GET /trackers/outbox?status=dead (admins)
 */
export const trackerQueryKeys = {
  all: ['trackers'] as const,
  featurePublic: () => ['trackers', 'feature', 'public'] as const,
  connections: () => ['trackers', 'connections'] as const,
  creatable: (kind: TrackerSourceKind, id: string) => ['trackers', 'creatable', kind, id] as const,
  deadOutbox: () => ['trackers', 'dead-outbox'] as const,
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
 * The connections this person may create on for one source. Administrators: every active
 * connection that syncs the kind, with its sync options (GET /trackers). Everyone else: GET
 * /trackers/creatable for this source (the connections whose create roles hold their role, and
 * none when they may not create from THIS source — a record they can read but not edit) — never
 * the full list.
 */
export function useTrackerConnections(
  kind: TrackerSourceKind,
  opts: { enabled: boolean; sourceId: string }
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
    queryKey: trackerQueryKeys.creatable(kind, opts.sourceId),
    queryFn: () =>
      client
        .request<{ data: TrackerConnectionInfo[] }>(
          get('/trackers/creatable', { source_kind: kind, source_id: opts.sourceId })
        )
        .then((r) => r.data ?? []),
    enabled: opts.enabled && !isAdmin && kind !== 'issue' && !!opts.sourceId,
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
export const CREATE_POLL_MS = 4_000

export interface CreateWait {
  /** A create was asked for and its GitLab issue has not shown up yet (still asking). */
  creating: boolean
  /** Asked for longer than CREATE_WAIT_MS without an answer: no longer asking on its own. */
  stalled: boolean
  /** Poll interval for the reads that show the new GitLab issue (false = no polling). */
  pollMs: number | false
  markCreating: () => void
  /** Ask again after a stall (Check again): another CREATE_WAIT_MS of asking. */
  checkAgain: () => void
}

/**
 * The wait after a create: ask every 4 s for up to 2 minutes, then stop and say so (the host
 * offers Check again). Ends the moment the GitLab issue shows up (`linked`).
 */
export function useCreateWait(linked: boolean, refresh: () => void): CreateWait {
  const [since, setSince] = useState<number | null>(null)
  const [stalled, setStalled] = useState(false)
  useEffect(() => {
    if (linked) {
      setSince(null)
      setStalled(false)
    }
  }, [linked])
  useEffect(() => {
    if (since == null) return
    const left = Math.max(0, since + CREATE_WAIT_MS - Date.now())
    const t = window.setTimeout(() => {
      setSince(null)
      setStalled(true)
    }, left)
    return () => window.clearTimeout(t)
  }, [since])
  const start = useCallback(() => {
    setStalled(false)
    setSince(Date.now())
    refresh()
  }, [refresh])
  const creating = since != null && !linked
  return {
    creating,
    stalled: stalled && !linked,
    pollMs: creating ? CREATE_POLL_MS : false,
    markCreating: start,
    checkAgain: start
  }
}

export interface SourceTracker {
  /** GitLab sync is on. */
  on: boolean
  isAdmin: boolean
  /** Connections this person may create / link on (empty = they may not). */
  connections: TrackerConnectionInfo[]
  canCreate: boolean
  /** The chips (everyone who can read the source). */
  chips: TrackerChipData[]
  /** What a header shows: every chip, an administrator's whole link (its sync error too) in place
   *  of its own chip. */
  shown: TrackerAny[]
  /** Administrators: the whole link on a connection that syncs this kind. */
  link: TrackerLink | null
  /** Administrators: creates for this source that gave up (dead), with Retry in the panel. */
  failed: TrackerPending[]
  /** A create was asked for and its GitLab issue has not shown up yet. */
  creating: boolean
  /** Asked for over 2 minutes ago and still not there: no longer asking on its own. */
  slow: boolean
  markCreating: () => void
  /** After `slow`: ask again (and re-read the failed creates). */
  checkAgain: () => void
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
  const mayCreate = opts.mayCreate !== false
  const { connections } = useTrackerConnections(kind, {
    enabled: on && mayCreate,
    sourceId: id
  })

  const refresh = useCallback(() => {
    void qc.invalidateQueries({ queryKey: trackerQueryKeys.linksFor(kind, id) })
    void qc.invalidateQueries({ queryKey: trackerQueryKeys.sourceLinks(kind, id) })
    if (isAdmin) void qc.invalidateQueries({ queryKey: trackerQueryKeys.deadOutbox() })
  }, [qc, kind, id, isAdmin])

  // rt-fix C (admin #10): a GitLab close / reopen / relabel, a link made or removed by someone
  // else — the server pokes `trackers` (a write to the link tables, coalesced) and this chip
  // re-reads its own two reads. The joins are reference counted by the host socket.
  useLiveOps(
    on ? 'trackers' : null,
    () => {
      void qc.invalidateQueries({ queryKey: trackerQueryKeys.linksFor(kind, id) })
      void qc.invalidateQueries({ queryKey: trackerQueryKeys.sourceLinks(kind, id) })
    },
    { debounceMs: 1500 }
  )

  // `linked` decides when the wait ends; the reads below poll while it lasts. The wait needs
  // `linked` and the reads need its poll interval: the reads go first with the last interval.
  const [pollMs, setPollMs] = useState<number | false>(false)
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
    refetchInterval: pollMs
  })
  const adminReads = on && isAdmin && kind !== 'issue' && mayCreate
  const links = useQuery({
    queryKey: trackerQueryKeys.sourceLinks(kind, id),
    queryFn: () =>
      client
        .request<{ data: TrackerLink[] }>(
          get(`/trackers/links/source/${kind}/${encodeURIComponent(id)}`)
        )
        .then((r) => r.data ?? []),
    enabled: adminReads,
    staleTime: 30_000,
    retry: false,
    refetchInterval: pollMs
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
  // Creates that gave up reach administrators here (a rule's create too, not only one asked for
  // in this tab). One read of the dead rows serves every ticket and record.
  const dead = useQuery({
    queryKey: trackerQueryKeys.deadOutbox(),
    queryFn: () =>
      client
        .request<{ data: TrackerOutboxRow[] }>(get('/trackers/outbox', { status: 'dead' }))
        .then((r) => r.data ?? []),
    enabled: adminReads && !linked && chips.isSuccess,
    staleTime: 60_000,
    retry: false
  })
  const wait = useCreateWait(linked, refresh)
  useEffect(() => setPollMs(wait.pollMs), [wait.pollMs])
  const failed = useMemo(
    () => (adminReads && !linked ? deadCreatesFor(dead.data, { kind, id }) : []),
    [adminReads, linked, kind, id, dead.data]
  )

  return {
    on,
    isAdmin,
    connections: on ? connections : [],
    canCreate: on && mayCreate && connections.length > 0,
    chips: chipList,
    shown: shownTrackers(chipList, link),
    link,
    failed,
    creating: wait.creating,
    slow: wait.stalled,
    markCreating: wait.markCreating,
    checkAgain: wait.checkAgain,
    refresh
  }
}
