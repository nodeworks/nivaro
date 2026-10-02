/**
 * Investigation reads: GET /traffic-map/inspect/:kind/:id (a level's detail) and
 * GET /traffic-map/inspect/:kind/:id/peek (the hover card). Admin only, like every
 * /traffic-map route.
 */
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { InspectRef } from '../registry/inspectables'

export interface InspectPeek {
  title: string
  lines: string[]
  at?: number
}

export interface InspectError {
  status: number | null
  /** INSPECT_NOT_FOUND | INSPECT_KIND_UNKNOWN | INSPECT_ID_INVALID | … */
  code: string | null
  message: string
}

function path(kind: string, id: string): string {
  return `/traffic-map/inspect/${encodeURIComponent(kind)}/${encodeURIComponent(id)}`
}

export async function fetchInspect<T = unknown>(
  kind: string,
  id: string,
  opts: { at?: number | null; window?: number | null } = {}
): Promise<T> {
  const params: Record<string, number> = {}
  if (opts.at != null && Number.isFinite(opts.at)) params.at = Math.round(opts.at)
  if (opts.window != null && Number.isFinite(opts.window)) params.window = Math.round(opts.window)
  const res = await api.get(path(kind, id), { params })
  return (res?.data as { data?: T })?.data as T
}

export async function fetchPeek(kind: string, id: string): Promise<InspectPeek | null> {
  const res = await api.get(`${path(kind, id)}/peek`)
  const d = (res?.data as { data?: InspectPeek | null })?.data
  return d && typeof d.title === 'string'
    ? { ...d, lines: Array.isArray(d.lines) ? d.lines : [] }
    : null
}

export async function fetchInspectKinds(): Promise<string[]> {
  const res = await api.get('/traffic-map/inspect/kinds')
  const d = (res?.data as { data?: unknown })?.data
  return Array.isArray(d) ? d.filter((x): x is string => typeof x === 'string') : []
}

/** Status, server code and message of a failed inspect call. */
export function inspectErrorOf(err: unknown): InspectError {
  const e = err as {
    response?: { status?: number; data?: { error?: string; code?: string } }
    message?: string
  }
  return {
    status: e?.response?.status ?? null,
    code: e?.response?.data?.code ?? null,
    message: e?.response?.data?.error ?? e?.message ?? 'Something went wrong'
  }
}

function noRetryOnClientError(count: number, err: unknown): boolean {
  const s = inspectErrorOf(err).status
  if (s === 400 || s === 404 || s === 403) return false
  return count < 2
}

/**
 * A level's detail. `at` is the ref's own time, else the investigation anchor; `windowSec`
 * rides along so a panel can look wider or narrower around it.
 */
export function useInspectDetail<T = unknown>(
  ref: InspectRef | null,
  anchor: number | null,
  windowSec?: number
) {
  const at = ref?.at ?? anchor ?? null
  return useQuery<T>({
    queryKey: ['tm-inspect', ref?.kind, ref?.id, at, windowSec ?? null],
    queryFn: () =>
      fetchInspect<T>(ref?.kind as string, ref?.id as string, { at, window: windowSec ?? null }),
    enabled: !!ref?.kind && !!ref.id,
    staleTime: 30_000,
    retry: noRetryOnClientError
  })
}

/** The hover card for a ref; fetched only while `enabled` (the card is open). */
export function useInspectPeek(ref: InspectRef | null, enabled = true) {
  return useQuery<InspectPeek | null>({
    queryKey: ['tm-inspect-peek', ref?.kind, ref?.id],
    queryFn: () => fetchPeek(ref?.kind as string, ref?.id as string),
    enabled: enabled && !!ref?.kind && !!ref.id,
    staleTime: 60_000,
    retry: noRetryOnClientError
  })
}

/** Kinds the server can answer for (GET /traffic-map/inspect/kinds). */
export function useInspectKinds() {
  return useQuery<string[]>({
    queryKey: ['tm-inspect-kinds'],
    queryFn: fetchInspectKinds,
    staleTime: 5 * 60_000,
    retry: noRetryOnClientError
  })
}
