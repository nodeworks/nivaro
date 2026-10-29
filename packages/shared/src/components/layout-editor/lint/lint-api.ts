import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useMemo } from 'react'
import { useNivaroClient } from '../../../context'
import { get, patch } from '../../../lib/commands'
import {
  EMPTY_LINT_CONTEXT,
  type LayoutHealth,
  type LintContext,
  type LintFinding,
  layoutHealth,
  lintLayout,
  mergeInherited
} from '../../../lib/layout-lint'
import type { LayoutBundle } from '../../../lib/layout-ops'
import type { DesignTarget } from '../design-context'

/**
 * Reads behind the layout lint (#2592), health scores (#2612) and record
 * coverage (#2581): GET /collection-layouts/lint-context | health | coverage.
 */

export const lintKeys = {
  context: (collection: string) => ['layout-editor', 'lint-context', collection] as const,
  health: (collection: string) => ['layout-editor', 'health', collection] as const,
  coverage: (collection: string) => ['layout-editor', 'coverage', collection] as const,
  style: ['layout-editor', 'lint-style'] as const
}

function unwrap<T>(res: unknown): T | null {
  if (!res || typeof res !== 'object') return null
  const data = (res as { data?: unknown }).data
  return (data && typeof data === 'object' ? data : res) as T
}

export function useLintContext(collection: string, enabled = true) {
  const client = useNivaroClient()
  return useQuery<LintContext>({
    queryKey: lintKeys.context(collection),
    queryFn: async () => {
      const body = unwrap<Partial<LintContext>>(
        await client.request<unknown>(get('/collection-layouts/lint-context', { collection }))
      )
      return {
        fields: body?.fields ?? [],
        roles: body?.roles ?? [],
        requirements: body?.requirements ?? [],
        style: body?.style ?? null
      }
    },
    enabled,
    staleTime: 60_000,
    retry: false
  })
}

/** The lint of the draft as it is now — recomputed on every edit, no round trip. */
export function useLayoutLint(
  collection: string,
  bundle: LayoutBundle | null,
  parent: LayoutBundle | null = null
): { findings: LintFinding[]; health: LayoutHealth | null; ready: boolean } {
  const { data: ctx, isSuccess, isError } = useLintContext(collection, !!bundle)
  return useMemo(() => {
    if (!bundle) return { findings: [], health: null, ready: false }
    // Without the context (a failed read) the layout-only checks still run.
    const c = ctx ?? EMPTY_LINT_CONTEXT
    const input = mergeInherited(bundle, parent)
    const findings = lintLayout(input, c)
    return { findings, health: layoutHealth(input, findings), ready: isSuccess || isError }
  }, [bundle, parent, ctx, isSuccess, isError])
}

export interface HealthRow {
  layout_id: number
  score: number
  costs: Array<{ label: string; points: number }>
  counts: { error: number; warn: number; info: number }
  unreachable_fields: number
}

export function useLayoutHealth(collection: string, enabled = true) {
  const client = useNivaroClient()
  return useQuery<HealthRow[]>({
    queryKey: lintKeys.health(collection),
    queryFn: async () =>
      unwrap<{ rows?: HealthRow[] }>(
        await client.request<unknown>(get('/collection-layouts/health', { collection }))
      )?.rows ?? [],
    enabled,
    staleTime: 60_000,
    retry: false
  })
}

export interface CoverageRow {
  layout_id: number
  records: number
  rule_matches: number | null
}

export interface CoverageResult {
  sampled: number
  limit: number
  rows: CoverageRow[]
  no_form: number
  rule_error: boolean
  computed_at: string
}

/** Sampled once on demand ("Check coverage"); `fresh` re-samples on the server. */
export async function fetchCoverage(
  client: ReturnType<typeof useNivaroClient>,
  collection: string,
  fresh = false
): Promise<CoverageResult> {
  const body = unwrap<CoverageResult>(
    await client.request<unknown>(
      get('/collection-layouts/coverage', { collection, ...(fresh ? { fresh: '1' } : {}) })
    )
  )
  return {
    sampled: body?.sampled ?? 0,
    limit: body?.limit ?? 500,
    rows: body?.rows ?? [],
    no_form: body?.no_form ?? 0,
    rule_error: !!body?.rule_error,
    computed_at: body?.computed_at ?? new Date().toISOString()
  }
}

/** Where on the canvas a finding points: header items, slots and fields differ. */
export function findingDesignTarget(f: LintFinding): DesignTarget | null {
  const t = f.target
  if (t.kind === 'group') return { kind: 'group', key: t.key }
  if (t.kind !== 'field') return null
  if (t.group_key === '__header__') return { kind: 'header', field: t.field }
  if (/^__.*__$/.test(t.field)) return { kind: 'slot', field: t.field, group_key: t.group_key }
  return { kind: 'field', field: t.field, group_key: t.group_key }
}

// ── Label house style (#3184) ────────────────────────────────────────────────

export interface StoredLintStyle {
  off: string[]
  max_label_length: number | null
  jargon: Array<{ term: string; say: string }>
  allow_words: string[]
}

export const EMPTY_LINT_STYLE: StoredLintStyle = {
  off: [],
  max_label_length: null,
  jargon: [],
  allow_words: []
}

/** This instance's label style: GET /collection-layouts/lint-style (admin). */
export function useLintStyle(enabled = true) {
  const client = useNivaroClient()
  return useQuery<StoredLintStyle>({
    queryKey: lintKeys.style,
    queryFn: async () => ({
      ...EMPTY_LINT_STYLE,
      ...(unwrap<Partial<StoredLintStyle>>(
        await client.request<unknown>(get('/collection-layouts/lint-style'))
      ) ?? {})
    }),
    enabled,
    staleTime: 60_000,
    retry: false
  })
}

/** PATCH the label style; every open lint (each collection's context) re-reads it. */
export function useSaveLintStyle() {
  const client = useNivaroClient()
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (next: Partial<StoredLintStyle>) =>
      unwrap<StoredLintStyle>(
        await client.request<unknown>(patch('/collection-layouts/lint-style', next))
      ) ?? EMPTY_LINT_STYLE,
    onSuccess: (saved) => {
      qc.setQueryData(lintKeys.style, saved)
      void qc.invalidateQueries({ queryKey: ['layout-editor', 'lint-context'] })
      void qc.invalidateQueries({ queryKey: ['layout-editor', 'health'] })
    }
  })
}
