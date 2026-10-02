/** Reads the background group adds beyond the generic inspect detail. */
import { useQuery } from '@tanstack/react-query'
import { api } from '@/lib/api'
import type { AiCallRow, FlowTestStep, SubmissionRow } from './logic'

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

/** Resolves only when the moment is known — the server would otherwise answer for "now". */
export function useRunFor(source: string | null, at: number | null) {
  return useQuery<RunPick | null>({
    queryKey: ['tm-inspect-run-for', source, at],
    queryFn: () => fetchRunFor(source as string, at),
    enabled: !!source && at != null,
    staleTime: 60_000,
    retry: false
  })
}

export interface SubmissionsFound {
  rows: SubmissionRow[]
  matched_by: 'chain' | 'api-time' | null
  /** Why a node resolved to no partner API (extension not loaded here, custom match rule…). */
  reason: string | null
}

export async function fetchSubmissionsFor(opts: {
  node?: string | null
  api?: number | null
  chain?: string | null
  at?: number | null
  window?: number | null
}): Promise<SubmissionsFound> {
  const params: Record<string, string | number> = {}
  if (opts.node) params.node = opts.node
  if (opts.api != null) params.api = opts.api
  if (opts.chain) params.chain = opts.chain
  if (opts.at != null && Number.isFinite(opts.at)) params.at = Math.round(opts.at)
  if (opts.window != null) params.window = opts.window
  const res = await api.get('/traffic-map/inspect/submissions-for', { params })
  const d = (
    res?.data as {
      data?: { rows?: SubmissionRow[]; matched_by?: string | null; reason?: string | null }
    }
  )?.data
  return {
    rows: Array.isArray(d?.rows) ? d.rows : [],
    matched_by: (d?.matched_by as 'chain' | 'api-time' | null) ?? null,
    reason: typeof d?.reason === 'string' ? d.reason : null
  }
}

/** Pushes a partner down node (`ext:<id>` or `x:<extension>.<id>`) received around a moment. */
export function useSubmissionsFor(node: string | null, at: number | null, window: number) {
  return useQuery<SubmissionsFound>({
    queryKey: ['tm-inspect-submissions-for', node, at, window],
    queryFn: () => fetchSubmissionsFor({ node, at, window }),
    enabled: !!node,
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

export interface FlowDryRunAnswer {
  steps: FlowTestStep[]
  output: unknown
  error: string | null
  dry_run: boolean
  /** `stored` = the run's own payload went in; `empty` = it was not an object, so `{}` did. */
  payload_used: 'stored' | 'empty'
}

/**
 * Dry-run a flow run's stored payload through its flow, server-side. Only the run id goes over
 * the wire: the server reads the real stored values itself, so the masked view this panel shows
 * is never what the flow runs on.
 */
export async function postFlowDryRun(runId: string): Promise<FlowDryRunAnswer> {
  const res = await api.post(`/traffic-map/inspect/flow-dry-run/${encodeURIComponent(runId)}`)
  const d = (res?.data as { data?: Partial<FlowDryRunAnswer> })?.data
  return {
    steps: Array.isArray(d?.steps) ? d.steps : [],
    output: d?.output ?? null,
    error: typeof d?.error === 'string' ? d.error : null,
    dry_run: d?.dry_run !== false,
    payload_used: d?.payload_used === 'empty' ? 'empty' : 'stored'
  }
}
