/**
 * Reads and writes for the request group: details through the generic inspect route (same
 * react-query keys as `useInspectDetail`, with polling where a panel waits on something), and the
 * group's own routes (trace-next, capture, compare candidates, statement plans).
 */
import { useQuery } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import { fetchInspect } from '../../inspect/api'
import type { InspectRef } from '../../registry/inspectables'
import { PENDING_GIVE_UP_MS, PENDING_RETRY_MS, shouldRetryPending } from './logic'

export interface RequestRow {
  id: number
  request_id: string | null
  method: string
  path: string
  query: string | null
  status: number
  latency_ms: number
  created_at: string | null
  auth: string | null
  ip: string | null
  user_agent: string | null
  error: string | null
  request_body: string | null
  body_source: 'log' | 'capture' | null
  body_note: string | null
  graphql: {
    operation: string | null
    kind: string | null
    depth: number | null
    selections: number | null
    errors: number | null
    deprecated: string | null
  } | null
  instance: string | null
  chain_id: string | null
  chain_parent: string | null
  user: string | null
  api_key_id: number | null
  caller: { key: string; label: string; kind: 'api_key' | 'user' | 'anonymous' }
  route: string
  entity: string | null
  record: string | null
}

export interface TraceKept {
  kept: true
  total_ms: number
  queries: number
  sql_ms: number
  spans: number
  statements: number
  slowest_phase: { phase: string; ms: number } | null
  unaccounted_ms: number
}
export interface TraceAbsent {
  kept: false
  code: 'fast' | 'other_instance' | 'evicted' | 'unknown'
  reason: string
}

export interface Neighbour {
  request_id: string | null
  method: string
  path: string
  status: number
  latency_ms: number
  created_at: string | null
  route: string
}

export interface RequestDetail {
  rid: string
  node: string
  instance: string
  pending: boolean
  missing: string | null
  matched_by: 'request_id' | 'chain_time' | 'time' | 'chain' | null
  row: RequestRow | null
  trace: TraceKept | TraceAbsent
  neighbours: Neighbour[]
  captured: { arm: string; body: string | null; body_note: string | null } | null
}

export interface TraceStatementRow {
  sql: string
  bindings: unknown[]
  ms: number
  n: number
  index: number
  sha: string
  select: boolean
  truncated: boolean
}

export interface TraceRecordWire {
  id: string
  method: string
  route: string
  url: string
  status: number
  user: string | null
  total_ms: number
  spans: Array<{
    seq: number
    phase: string
    ms: number
    at: number
    detail?: string
    queries?: number
    repeat?: { sql: string; n: number; ms: number }
    wide?: Array<{ table: string; n: number }>
  }>
  ts: string
  queries: number
  sql_ms: number
  top_sql: TraceStatementRow[]
  wide: Array<{ table: string; n: number }>
  unaccounted_ms: number
}

export interface TraceDetail {
  rid: string
  node: string
  instance: string
  config: { slow_ms: number; capacity: number; buffered: number }
  kept: boolean
  trace?: TraceRecordWire
  code?: TraceAbsent['code']
  reason?: string
  route?: string | null
  caller?: RequestRow['caller'] | null
}

export interface PlanResult {
  source: 'cache' | 'estimated'
  plan: string | null
  stats: {
    execution_count: number
    avg_elapsed_ms: number
    last_elapsed_ms: number
    max_elapsed_ms: number
    avg_logical_reads: number
    last_execution_time: string | null
  } | null
}

export interface StatementDetail {
  sha: string
  text: string
  bindings: unknown[]
  truncated: boolean
  traces: number
  calls: number
  avg_ms: number
  max_ms: number
  last_seen: number
  last_rid: string
  routes: Array<{ route: string; entity: string | null; n: number; last_seen: number }>
  node: string
  tables: string[]
  plan: PlanResult | null
  plan_note: string | null
  advice: Array<{
    table: string
    column: string
    rows: number
    reasons: string[]
    create_sql: string
  }> | null
}

export interface CompareSideWire {
  rid: string
  row: RequestRow | null
  trace: TraceRecordWire | null
  absence: TraceAbsent | null
}

export interface CompareDetail {
  a: CompareSideWire
  b: CompareSideWire
  diff: {
    status: { a: number | null; b: number | null; same: boolean }
    ms: { a: number | null; b: number | null; delta: number | null; pct: number | null }
    phases: Array<{ phase: string; a: number | null; b: number | null; delta: number | null }>
    sql: {
      added: Array<{ sha: string; sql: string; ms: number; n: number }>
      removed: Array<{ sha: string; sql: string; ms: number; n: number }>
      slower: Array<{
        sha: string
        sql: string
        a_ms: number
        b_ms: number
        a_n: number
        b_n: number
      }>
      faster: Array<{
        sha: string
        sql: string
        a_ms: number
        b_ms: number
        a_n: number
        b_n: number
      }>
      comparable: boolean
    }
    params: Array<{
      name: string
      a: string | null
      b: string | null
      change: 'added' | 'removed' | 'changed' | 'same'
    }>
  }
  node: string
}

export interface ArmSpec {
  route: string | null
  caller: string | null
  entity: string | null
}

export interface CaptureEntry {
  rid: string
  at: number
  ms: number
  route: string
  method: string
  path: string
  status: number
  node: string
  query: string | null
  has_body: boolean
  body_bytes: number
  body_note: string | null
}

export interface CaptureDetail {
  id: string
  kind: 'trace' | 'capture'
  spec: ArmSpec
  total: number
  remaining: number
  created_at: number
  expires_at: number
  done: boolean
  entries: CaptureEntry[]
  node: string
}

export interface ArmStatus {
  id: string
  kind: 'trace' | 'capture'
  spec: ArmSpec
  total: number
  remaining: number
  done: boolean
  expires_at: number
  traces: Array<{ rid: string; at: number; ms: number; status: number; path: string; node: string }>
}

export interface CompareCandidate {
  /** A request id — or, for a root /graphql call (logged without one), its chain id. */
  request_id: string
  by_chain: boolean
  path: string
  status: number
  latency_ms: number
  created_at: string | null
  same_caller: boolean
  traced: boolean
}

function detailKey(ref: InspectRef, anchor: number | null, windowSec: number) {
  const at = ref.at ?? anchor ?? null
  return { at, key: ['tm-inspect', ref.kind, ref.id, at, windowSec ?? null] as const }
}

function noRetry4xx(count: number, err: unknown): boolean {
  const s = (err as { response?: { status?: number } })?.response?.status
  if (s === 400 || s === 403 || s === 404) return false
  return count < 2
}

/**
 * When each request was first seen `pending`, by request id. Module-level rather than a ref: a
 * panel remounted within the cache's 30 s (Back from a deeper level, split view, reopened) is
 * served the cached pending answer without a fetch, and must keep counting from the first sight,
 * not start over — or, worse, never poll and never give up.
 */
const firstPending = new Map<string, number>()
const FIRST_PENDING_CAP = 200

function firstPendingAt(id: string, pending: boolean): number | null {
  if (!pending) {
    firstPending.delete(id)
    return null
  }
  let t = firstPending.get(id)
  if (t == null) {
    t = Date.now()
    firstPending.set(id, t)
    while (firstPending.size > FIRST_PENDING_CAP) {
      const oldest = firstPending.keys().next().value
      if (oldest === undefined) break
      firstPending.delete(oldest)
    }
  }
  return t
}

/**
 * A request's detail. A request this fresh may not be in the API log yet (the logger flushes in
 * batches): the server answers `pending` and this polls every 2 s for up to 20 s after the
 * request was first seen pending, then gives up (`gaveUp`).
 */
export function useRequestDetail(ref: InspectRef, anchor: number | null, windowSec: number) {
  const { at, key } = detailKey(ref, anchor, windowSec)
  const q = useQuery<RequestDetail>({
    queryKey: key,
    queryFn: () => fetchInspect<RequestDetail>(ref.kind, ref.id, { at, window: windowSec }),
    staleTime: 30_000,
    retry: noRetry4xx,
    refetchInterval: (query) => {
      const d = query.state.data
      if (!d?.pending) return false
      const first = firstPendingAt(ref.id, true)
      return first != null && shouldRetryPending(first, Date.now()) ? PENDING_RETRY_MS : false
    }
  })
  const pending = !!q.data?.pending
  const first = firstPendingAt(ref.id, pending)
  // The last poll schedules nothing, so a timer re-renders once the 20 s are up.
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!pending || first == null) return
    const left = first + PENDING_GIVE_UP_MS - Date.now()
    const t = setTimeout(() => setTick((n) => n + 1), Math.max(0, left) + 50)
    return () => clearTimeout(t)
  }, [pending, first])
  const gaveUp = pending && first != null && !shouldRetryPending(first, Date.now()) && !q.isFetching
  return { ...q, gaveUp }
}

/**
 * A detail that refreshes while something is still happening (captures fill while you watch):
 * `interval(d)` says how often, in ms, or false to stop.
 */
export function useLiveDetail<T>(
  ref: InspectRef,
  anchor: number | null,
  windowSec: number,
  interval: (d: T | undefined) => number | false
) {
  const { at, key } = detailKey(ref, anchor, windowSec)
  return useQuery<T>({
    queryKey: key,
    queryFn: () => fetchInspect<T>(ref.kind, ref.id, { at, window: windowSec }),
    staleTime: 1000,
    retry: noRetry4xx,
    refetchInterval: (query) => interval(query.state.data as T | undefined)
  })
}

export async function armTraceNext(body: {
  route: string
  caller?: string | null
  count?: number
  ttlSec?: number
}): Promise<{ id: string; expires_at: number; total: number }> {
  const res = await api.post('/traffic-map/inspect/trace-next', body)
  return (res.data as { data: { id: string; expires_at: number; total: number } }).data
}

export async function armCapture(body: {
  route?: string | null
  caller?: string | null
  entity?: string | null
  count: number
  ttlSec: number
}): Promise<{ id: string; expires_at: number; total: number }> {
  const res = await api.post('/traffic-map/inspect/capture', body)
  return (res.data as { data: { id: string; expires_at: number; total: number } }).data
}

export async function stopArm(id: string): Promise<void> {
  await api.delete(`/traffic-map/inspect/trace-next/${encodeURIComponent(id)}`)
}

/** A trace-next arm's progress, polled every 2 s while it can still catch something. */
export function useArmStatus(id: string | null) {
  return useQuery<ArmStatus>({
    queryKey: ['tm-inspect-arm', id],
    queryFn: async () =>
      (
        (await api.get(`/traffic-map/inspect/trace-next/${encodeURIComponent(id as string)}`))
          .data as {
          data: ArmStatus
        }
      ).data,
    enabled: !!id,
    retry: noRetry4xx,
    refetchInterval: (query) => {
      const d = query.state.data
      if (query.state.error) return false
      return d && (d.done || d.expires_at <= Date.now()) ? false : 2000
    }
  })
}

export function useCompareCandidates(rid: string, at: number | null, enabled: boolean) {
  return useQuery<{ route: string; candidates: CompareCandidate[] }>({
    queryKey: ['tm-inspect-compare-candidates', rid, at],
    queryFn: async () =>
      (
        (
          await api.get(`/traffic-map/inspect/compare-candidates/${encodeURIComponent(rid)}`, {
            params: at != null ? { at: Math.round(at) } : {}
          })
        ).data as { data: { route: string; candidates: CompareCandidate[] } }
      ).data,
    enabled,
    staleTime: 15_000,
    retry: noRetry4xx
  })
}

/** The plan of one of a trace's statements (POST /traces/:id/explain — plan cache first). */
export async function explainTraceStatement(rid: string, index: number): Promise<PlanResult> {
  const res = await api.post(`/traces/${encodeURIComponent(rid)}/explain`, { index })
  return (res.data as { data: PlanResult }).data
}
