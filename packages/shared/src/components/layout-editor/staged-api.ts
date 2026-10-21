import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useMemo } from 'react'
import { useNivaroClient } from '../../context'
import { get, post } from '../../lib/commands'
import type { LayoutOp } from '../../lib/layout-ops'
import type { UnsavedStep } from './useLayoutDraft'

// Staged layout edits (#2589): the server's copy of a person's unsaved steps
// on a layout, and who else has one. Routes: api/src/routes/layout-staged.ts.
// The draft-recovery hook reads and writes it; StagedByOthers shows the rest.

export const stagedKeys = {
  mine: (layoutId: number) => ['layout-editor', 'staged', layoutId] as const
}

export interface StagedServerDraft {
  steps: UnsavedStep[]
  base_rev: string
  saved_at: string
}

export interface StagedOther {
  user_id: string
  name: string
  step_count: number
  op_count: number
  saved_at: string
}

export interface StagedAnswer {
  data: StagedServerDraft | null
  others: StagedOther[]
  /** false = the server keeps no drafts (table missing); the browser copy is all there is. */
  available: boolean
}

const isStep = (s: unknown): s is UnsavedStep => {
  const x = s as { label?: unknown; ops?: unknown } | null
  return !!x && typeof x.label === 'string' && Array.isArray(x.ops)
}

/** The server's answer, however it was shaped (a stub client answers `{data: []}`). */
export function parseStagedAnswer(res: unknown): StagedAnswer {
  const r = (res ?? {}) as { data?: unknown; others?: unknown; available?: unknown }
  const d = r.data as { steps?: unknown; base_rev?: unknown; saved_at?: unknown } | null
  const draft =
    d &&
    typeof d === 'object' &&
    !Array.isArray(d) &&
    typeof d.base_rev === 'string' &&
    Array.isArray(d.steps) &&
    d.steps.length > 0 &&
    d.steps.every(isStep)
      ? {
          steps: d.steps as UnsavedStep[],
          base_rev: d.base_rev,
          saved_at: typeof d.saved_at === 'string' ? d.saved_at : new Date().toISOString()
        }
      : null
  const others = Array.isArray(r.others)
    ? (r.others as unknown[]).filter((o): o is StagedOther => {
        const x = o as Partial<StagedOther> | null
        return !!x && typeof x.user_id === 'string' && typeof x.name === 'string'
      })
    : []
  return { data: draft, others, available: r.available !== false }
}

/** My staged draft + who else has one; one read per opened layout (the writer keeps it current). */
export function useStagedDraft(layoutId: number, enabled = true) {
  const client = useNivaroClient()
  return useQuery<StagedAnswer>({
    queryKey: stagedKeys.mine(layoutId),
    queryFn: () =>
      client
        .request<unknown>(get(`/collection-layouts/${layoutId}/staged`))
        .then(parseStagedAnswer),
    enabled,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    retry: false
  })
}

export interface StagedWriter {
  write(layoutId: number, d: { steps: UnsavedStep[]; baseRev: string }): Promise<void>
  clear(layoutId: number): Promise<void>
}

/** Keep / drop my staged draft on the server. Failures are the caller's to swallow. */
export function useStagedWriter(): StagedWriter {
  const client = useNivaroClient()
  const qc = useQueryClient()
  const write = useCallback(
    async (layoutId: number, d: { steps: UnsavedStep[]; baseRev: string }) => {
      await client.request(
        post(`/collection-layouts/${layoutId}/staged`, {
          steps: d.steps.map((s) => ({ label: s.label, ops: s.ops as LayoutOp[] })),
          base_rev: d.baseRev
        })
      )
      qc.setQueryData<StagedAnswer>(stagedKeys.mine(layoutId), (old) => ({
        data: { steps: d.steps, base_rev: d.baseRev, saved_at: new Date().toISOString() },
        others: old?.others ?? [],
        available: true
      }))
    },
    [client, qc]
  )
  const clear = useCallback(
    async (layoutId: number) => {
      await client.request(post(`/collection-layouts/${layoutId}/staged/clear`))
      qc.setQueryData<StagedAnswer>(stagedKeys.mine(layoutId), (old) =>
        old ? { ...old, data: null } : old
      )
    },
    [client, qc]
  )
  return useMemo(() => ({ write, clear }), [write, clear])
}
