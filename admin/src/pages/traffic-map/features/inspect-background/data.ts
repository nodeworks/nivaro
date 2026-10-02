/** Reads the background group adds beyond the generic inspect detail. */
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { AiCallRow, SubmissionRow } from './logic'

export interface RunPick {
  kind: 'job' | 'flow'
  id: string
  covering: boolean
  started_at: string | null
}

/** The job / flow run a background source id (`cron:<job>`, `flow:<id>`) means at a moment. */
export async function fetchRunFor(source: string, at: number | null): Promise<RunPick | null> {
  const params: Record<string, string | number> = { source }
  if (at != null && Number.isFinite(at)) params.at = Math.round(at)
  const res = await api.get('/traffic-map/inspect/job-for', { params })
  return ((res?.data as { data?: RunPick | null })?.data ?? null) as RunPick | null
}

export function useRunFor(source: string | null, at: number | null) {
  return useQuery<RunPick | null>({
    queryKey: ['tm-inspect-run-for', source, at],
    queryFn: () => fetchRunFor(source as string, at),
    enabled: !!source,
    staleTime: 60_000,
    retry: false
  })
}

export async function fetchSubmissionsFor(opts: {
  api?: number | null
  chain?: string | null
  at?: number | null
  window?: number | null
}): Promise<{ rows: SubmissionRow[]; matched_by: 'chain' | 'api-time' | null }> {
  const params: Record<string, string | number> = {}
  if (opts.api != null) params.api = opts.api
  if (opts.chain) params.chain = opts.chain
  if (opts.at != null && Number.isFinite(opts.at)) params.at = Math.round(opts.at)
  if (opts.window != null) params.window = opts.window
  const res = await api.get('/traffic-map/inspect/submissions-for', { params })
  const d = (res?.data as { data?: { rows?: SubmissionRow[]; matched_by?: string | null } })?.data
  return {
    rows: Array.isArray(d?.rows) ? d.rows : [],
    matched_by: (d?.matched_by as 'chain' | 'api-time' | null) ?? null
  }
}

export function useSubmissionsFor(api: number | null, at: number | null, window: number) {
  return useQuery({
    queryKey: ['tm-inspect-submissions-for', api, at, window],
    queryFn: () => fetchSubmissionsFor({ api, at, window }),
    enabled: api != null,
    staleTime: 30_000,
    retry: false
  })
}

export function useAiCallsForRequest(rid: string | null) {
  return useQuery<{ calls: AiCallRow[]; kept_days: number }>({
    queryKey: ['tm-inspect-ai-for', rid],
    queryFn: async () => {
      const res = await api.get(
        `/traffic-map/inspect/ai-for-request/${encodeURIComponent(rid as string)}`
      )
      const d = (res?.data as { data?: { calls?: AiCallRow[]; kept_days?: number } })?.data
      return { calls: Array.isArray(d?.calls) ? d.calls : [], kept_days: d?.kept_days ?? 30 }
    },
    enabled: !!rid,
    staleTime: 30_000,
    retry: false
  })
}
