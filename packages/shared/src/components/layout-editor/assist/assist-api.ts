import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { useNivaroClient } from '../../../context'
import { get, post } from '../../../lib/commands'
import type { LayoutBundle, LayoutOp } from '../../../lib/layout-ops'

/**
 * Reads behind the layout AI helpers (admin only, /ai-design/layouts):
 * proposals from connected assistants (#2694), ask about this form (#2695),
 * the AI half of find a setting (#2676) and why two forms differ (#2693).
 * Every answer is a proposal or an explanation: nothing here writes a layout.
 */

export const assistKeys = {
  proposals: (layoutId: number) => ['layout-editor', 'proposals', layoutId] as const
}

export interface LayoutProposal {
  id: string
  layout_id: number
  note: string | null
  status: 'proposed' | 'applied' | 'rejected' | 'expired'
  created_at: string
  proposer: { name: string; via: string }
  ops: LayoutOp[]
  sentences: string[]
  dropped: string[]
  conflict: string | null
}

/** Open proposals for the layout. Off for non-admins (the route is admin-only). */
export function useLayoutProposals(layoutId: number, enabled: boolean) {
  const client = useNivaroClient()
  return useQuery<LayoutProposal[]>({
    queryKey: assistKeys.proposals(layoutId),
    queryFn: () =>
      client
        .request<{ data: LayoutProposal[] }>(get(`/ai-design/layouts/${layoutId}/proposals`))
        .then((r) => (Array.isArray(r?.data) ? r.data : [])),
    enabled,
    staleTime: 30_000,
    refetchInterval: enabled ? 120_000 : false,
    retry: false
  })
}

export function useResolveProposal(layoutId: number) {
  const client = useNivaroClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: { id: string; outcome: 'applied' | 'rejected' }) =>
      client.request(
        post(`/ai-design/layouts/${layoutId}/proposals/${v.id}/resolve`, { outcome: v.outcome })
      ),
    onSettled: () => qc.invalidateQueries({ queryKey: assistKeys.proposals(layoutId) })
  })
}

// ── Ask about this form ──────────────────────────────────────────────────────

export type AskCite =
  | { kind: 'field'; field: string; label: string }
  | { kind: 'record'; id: string }
  | { kind: 'layout'; id: number; name: string }

export interface AskAnswer {
  answer: string
  cites: AskCite[]
  tools: Array<{ tool: string; ok: boolean }>
}

/** A setting the finder placed (deterministic or AI). */
export interface FoundSetting {
  key: string
  label: string
  where: string
}

export type AskTurn =
  | { id: number; role: 'user'; text: string }
  | { id: number; role: 'assistant'; text: string; cites: AskCite[] }
  | {
      id: number
      role: 'found'
      found: FoundSetting[]
      source: 'search' | 'ai'
      text: string | null
    }
  | { id: number; role: 'error'; text: string }

/** The conversation lives in the editor, so it survives a jump to another panel. */
export function useAskThread() {
  return useState<AskTurn[]>([])
}

/** The draft, as the server's facts expect it (only what describes the layout). */
export function draftPayload(bundle: LayoutBundle | null) {
  if (!bundle) return undefined
  return {
    layout: bundle.layout,
    groups: bundle.groups,
    placements: bundle.placements,
    rev: bundle.rev
  }
}

export function askLayout(
  client: ReturnType<typeof useNivaroClient>,
  layoutId: number,
  body: {
    question: string
    history: Array<{ role: 'user' | 'assistant'; content: string }>
    draft?: unknown
  }
) {
  return client
    .request<{ data: AskAnswer }>(post(`/ai-design/layouts/${layoutId}/ask`, body))
    .then((r) => r.data)
}

export function findSettingAi(
  client: ReturnType<typeof useNivaroClient>,
  body: { question: string; candidates: Array<{ key: string; label: string; where: string }> }
) {
  return client
    .request<{ data: { keys: string[]; explanation: string | null } }>(
      post('/ai-design/layouts/find-setting', body)
    )
    .then((r) => r.data)
}

// ── Why two forms differ ─────────────────────────────────────────────────────

export interface DiffSide {
  layout_id: number
  /** A version id, 'newest', or omitted / 'current' for the layout as it is now. */
  version?: number | 'newest' | 'current' | null
}

export interface LayoutDiffExplanation {
  a: { layout_id: number; title: string; name: string; version: number | null }
  b: { layout_id: number; title: string; name: string; version: number | null }
  sentences: string[]
  counts: {
    only_a: number
    only_b: number
    moved: number
    changed: number
    sections: number
    settings: number
  }
  notes: Array<{
    layout_id: number
    version: number
    note: string
    at: string | null
    by: string | null
    /** Consecutive saves with this same note. */
    times?: number
  }>
  summary: string | null
  points: string[]
  ai_configured: boolean
  ai_error: string | null
}

/**
 * Explain the differences between two layouts, or two versions of one, in
 * plain words. Compare two forms (#2659) and Merge two forms (#2661) call it
 * with two layout ids; History compare with a version and the layout now.
 * `ai: false` returns the exact differences only.
 */
export function useExplainLayoutDiff() {
  const client = useNivaroClient()
  return useMutation({
    mutationFn: (body: { a: DiffSide; b: DiffSide; ai?: boolean; draft?: unknown }) =>
      client
        .request<{ data: LayoutDiffExplanation }>(post('/ai-design/layouts/explain-diff', body))
        .then((r) => r.data)
  })
}
