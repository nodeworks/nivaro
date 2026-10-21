import { useQuery } from '@tanstack/react-query'
import { useNivaroClient } from '../../../context'
import { get, post } from '../../../lib/commands'

/**
 * Layout operations around the editor: what relies on a layout (#2613),
 * comparing it with another environment's copy (#2593) and the form change
 * requests people send from record pages (#2609). Shapes mirror
 * api/src/routes/layout-dependencies.ts, layout-promote.ts and
 * layout-change-requests.ts.
 */

export type LayoutChange = 'rename' | 'slug' | 'type' | 'delete'

export interface DependencyNode {
  kind: string
  group: string
  id: string | number
  label: string
  by: 'id' | 'slug' | 'id or slug'
  breaks: Array<'slug' | 'type' | 'delete'>
}

export interface LayoutDependencies {
  layout: {
    id: number
    collection: string
    name: string
    slug: string | null
    layout_type: string
  }
  groups: Array<{ id: string; label: string }>
  nodes: DependencyNode[]
  extensions: { declaring: number; note: string }
}

export interface PromoteSource {
  id: number
  name: string
  environment: string | null
  has_token: boolean
}

export interface PromoteChange {
  kind: 'setting' | 'section' | 'field' | 'order'
  action: 'add' | 'remove' | 'change' | 'skip'
  target: string
  where?: string | null
  text: string
  from?: unknown
  to?: unknown
}

export interface PromotePreview {
  source: { label: string; environment: string | null; version: string | null }
  candidates: Array<{ id: number; name: string; slug: string | null; layout_type: string | null }>
  base_rev: string
  theirs: { id: number; name: string; slug: string | null; layout_type: string | null } | null
  plan: { changes: PromoteChange[]; ops: number; exact: boolean } | null
}

/** Where the other copy comes from: a registry API component or an uploaded file. */
export type PromoteFrom = { component_id: number } | { file: unknown }

export interface ChangeRequest {
  id: number
  title: string
  message: string
  layout_id: number | null
  layout_name: string | null
  field: string | null
  field_label: string | null
  status: string
  item: string
  record_label: string
  requester_name: string | null
  created_at: string | null
  completed_at: string | null
}

export const opsKeys = {
  deps: (id: number) => ['layout-editor', 'dependencies', id] as const,
  sources: () => ['layout-editor', 'promote-sources'] as const,
  requests: (collection: string) => ['layout-editor', 'change-requests', collection] as const
}

const unwrap = <T>(r: unknown): T => {
  const body = r as { data?: T } | null
  return (body && typeof body === 'object' && 'data' in body ? body.data : r) as T
}

export function useLayoutDependencies(layoutId: number | null, enabled = true) {
  const client = useNivaroClient()
  return useQuery<LayoutDependencies>({
    queryKey: opsKeys.deps(layoutId ?? 0),
    queryFn: async () => {
      const d = unwrap<LayoutDependencies>(
        await client.request(get(`/collection-layouts/${layoutId}/dependencies`))
      )
      // A shape slip (an older API, a stub) reads as "nothing found", never a crash.
      if (!d || typeof d !== 'object' || !d.layout || !Array.isArray(d.nodes))
        throw new Error('No dependency data')
      return {
        ...d,
        groups: Array.isArray(d.groups) ? d.groups : [],
        extensions: d.extensions ?? { declaring: 0, note: '' }
      }
    },
    enabled: enabled && layoutId != null,
    staleTime: 15_000
  })
}

export function usePromoteSources(enabled = true) {
  const client = useNivaroClient()
  return useQuery<PromoteSource[]>({
    queryKey: opsKeys.sources(),
    queryFn: async () => {
      const d = unwrap<PromoteSource[]>(
        await client.request(get('/collection-layouts/promote/sources'))
      )
      return Array.isArray(d) ? d : []
    },
    enabled,
    staleTime: 60_000
  })
}

export async function previewPromotion(
  client: ReturnType<typeof useNivaroClient>,
  layoutId: number,
  from: PromoteFrom,
  remoteLayoutId?: number | null
): Promise<PromotePreview> {
  return unwrap<PromotePreview>(
    await client.request(
      post(`/collection-layouts/${layoutId}/promote/preview`, {
        ...from,
        ...(remoteLayoutId != null ? { remote_layout_id: remoteLayoutId } : {})
      })
    )
  )
}

export async function applyPromotion(
  client: ReturnType<typeof useNivaroClient>,
  layoutId: number,
  from: PromoteFrom,
  baseRev: string,
  remoteLayoutId?: number | null
): Promise<{ applied: number }> {
  return unwrap<{ applied: number }>(
    await client.request(
      post(`/collection-layouts/${layoutId}/promote/apply`, {
        ...from,
        base_rev: baseRev,
        ...(remoteLayoutId != null ? { remote_layout_id: remoteLayoutId } : {})
      })
    )
  )
}

/** Save this layout as a file another environment can compare against. */
export async function downloadLayout(
  client: ReturnType<typeof useNivaroClient>,
  layoutId: number,
  name: string
): Promise<void> {
  const file = await client.request<unknown>(get(`/collection-layouts/${layoutId}/export`))
  const blob = new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `layout-${name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-') || layoutId}.json`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

/**
 * A picked file, trimmed to what the compare needs: a layout export as it is,
 * a Config Diff snapshot cut down to its three layout tables (snapshots are
 * the whole config layer — far too much to send for one layout).
 */
export function trimUploadedFile(text: string): unknown {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('That file is not JSON')
  }
  const root = (parsed as { data?: unknown })?.data ?? parsed
  const r = root as { format?: unknown; tables?: Record<string, unknown> }
  if (r && r.format === 1 && r.tables && typeof r.tables === 'object') {
    const keep = [
      'nivaro_collection_layouts',
      'nivaro_field_groups',
      'nivaro_layout_field_assignments'
    ]
    return {
      ...r,
      classification: undefined,
      tables: Object.fromEntries(keep.filter((t) => t in r.tables!).map((t) => [t, r.tables![t]]))
    }
  }
  return root
}

export function useChangeRequests(collection: string, enabled = true) {
  const client = useNivaroClient()
  return useQuery<ChangeRequest[]>({
    queryKey: opsKeys.requests(collection),
    queryFn: async () => {
      const d = unwrap<ChangeRequest[]>(
        await client.request(get('/layout-change-requests', { collection }))
      )
      return Array.isArray(d) ? d : []
    },
    enabled: enabled && !!collection,
    staleTime: 30_000
  })
}

/** Open requests per layout id (requests naming no form count under 0). */
export function requestsByLayout(list: ChangeRequest[] | undefined): Map<number, number> {
  const m = new Map<number, number>()
  for (const r of list ?? []) {
    const k = r.layout_id ?? 0
    m.set(k, (m.get(k) ?? 0) + 1)
  }
  return m
}

export async function resolveChangeRequest(
  client: ReturnType<typeof useNivaroClient>,
  id: number,
  decision: 'accept' | 'decline',
  note: string
) {
  return client.request(post(`/layout-change-requests/${id}/resolve`, { decision, note }))
}

export async function sendChangeRequest(
  client: ReturnType<typeof useNivaroClient>,
  body: {
    collection: string
    item: string
    layout_id?: number | null
    field?: string | null
    field_label?: string | null
    message: string
  }
): Promise<{ id: number; title: string }> {
  return unwrap<{ id: number; title: string }>(
    await client.request(post('/layout-change-requests', body))
  )
}
