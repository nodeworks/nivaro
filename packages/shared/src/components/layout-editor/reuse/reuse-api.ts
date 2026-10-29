import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'
import { useNivaroClient } from '../../../context'
import { del, get, post } from '../../../lib/commands'
import type { LayoutBundle, LayoutOp } from '../../../lib/layout-ops'

// Reusing layout parts (#2584 copy a section, #2594 templates, #2606 section
// library) — the client half of /collection-layouts/templates, /blocks/plan
// and /:id/copy-section.

export type TemplateKind = 'form' | 'section'
export type FieldMap = Record<string, string | null>

export interface TemplateSummary {
  id: number
  kind: TemplateKind
  name: string
  description: string | null
  source_collection: string | null
  layout_type: string | null
  fields: string[]
  sections: number
  /** #3194: forms that place this section as linked. */
  linked_forms?: number
}

export interface BlockPlanResult {
  /** #3194: the root key a linked drop was planned with. */
  linked_key?: string
  ops: LayoutOp[]
  keys: Record<string, string>
  already: string[]
  unmapped: string[]
  dropped: string[]
  fields: string[]
}

export interface CopyResult {
  bundle: LayoutBundle
  group_key: string | null
  already: string[]
  unmapped: string[]
  dropped: string[]
}

type Client = ReturnType<typeof useNivaroClient>

export const reuseKeys = {
  templates: (kind: TemplateKind) => ['layout-editor', 'templates', kind] as const
}

const listOf = (res: unknown): TemplateSummary[] => {
  const data = (res as { data?: unknown })?.data ?? res
  return Array.isArray(data) ? (data as TemplateSummary[]) : []
}

export function useTemplates(kind: TemplateKind, enabled = true) {
  const client = useNivaroClient()
  return useQuery<TemplateSummary[]>({
    queryKey: reuseKeys.templates(kind),
    queryFn: () =>
      client.request<unknown>(get('/collection-layouts/templates', { kind })).then(listOf),
    enabled,
    staleTime: 30_000
  })
}

export function useRefreshTemplates() {
  const qc = useQueryClient()
  return useCallback(
    (kind: TemplateKind) => void qc.invalidateQueries({ queryKey: reuseKeys.templates(kind) }),
    [qc]
  )
}

/** The editor's bundle as the server reads it: rows only (the layout row is the stored one). */
const shown = (b: LayoutBundle) => ({ groups: b.groups, placements: b.placements })

export function saveTemplate(
  client: Client,
  body: {
    kind: TemplateKind
    name: string
    description?: string | null
    layout_id: number
    group_key?: string
    bundle?: LayoutBundle
  }
) {
  const { bundle, ...rest } = body
  return client.request<{ data: TemplateSummary }>(
    post('/collection-layouts/templates', { ...rest, ...(bundle ? { bundle: shown(bundle) } : {}) })
  )
}

export function deleteTemplate(client: Client, id: number) {
  return client.request(del(`/collection-layouts/templates/${id}`))
}

export function planBlock(
  client: Client,
  body: {
    source:
      | { template_id: number }
      | { layout_id: number; group_key: string; bundle?: LayoutBundle }
    target_collection: string
    target_bundle: LayoutBundle
    field_map?: FieldMap
    index?: number
    /** #3194: plan a library section to place as linked. */
    linked?: boolean
  }
) {
  const source =
    'bundle' in body.source && body.source.bundle
      ? { ...body.source, bundle: shown(body.source.bundle) }
      : body.source
  return client.request<BlockPlanResult>(
    post('/collection-layouts/blocks/plan', {
      ...body,
      source,
      target_bundle: {
        layout: { layout_type: body.target_bundle.layout.layout_type },
        ...shown(body.target_bundle)
      }
    })
  )
}

export function copySection(
  client: Client,
  targetLayoutId: number,
  body: {
    source_layout_id: number
    group_key: string
    source_bundle?: LayoutBundle
    field_map?: FieldMap
  }
) {
  const { source_bundle, ...rest } = body
  return client.request<CopyResult>(
    post(`/collection-layouts/${targetLayoutId}/copy-section`, {
      ...rest,
      ...(source_bundle ? { source_bundle: shown(source_bundle) } : {})
    })
  )
}

/** "3 fields were already on it, 1 had no match" — what a copy or drop left out, in words. */
export function leftOutWords(r: { already?: string[]; unmapped?: string[]; dropped?: string[] }) {
  const parts: string[] = []
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`
  if (r.already?.length)
    parts.push(`${n(r.already.length, 'field was', 'fields were')} already on the form`)
  if (r.unmapped?.length)
    parts.push(`${n(r.unmapped.length, 'field', 'fields')} with no match left out`)
  if (r.dropped?.length) parts.push('conditions written for the other collection were left out')
  return parts.join('; ')
}
