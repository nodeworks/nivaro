import { useQuery } from '@tanstack/react-query'
import { useNivaroClient } from '../../../context'
import { get } from '../../../lib/commands'
import { titleCase } from '../../../lib/utils'
import { useOverviewFields } from '../overview/overview-api'

/** The field-config columns Form settings reads (same query + cache as the overview). */
export interface SettingsField {
  field: string
  label?: string | null
  type?: string | null
  interface?: string | null
  options?: unknown
  hidden?: boolean
  required?: boolean
  dependency_config?: unknown
}

export interface SettingsRelation {
  many_collection: string | null
  many_field: string | null
  one_collection: string | null
  one_field: string | null
  junction_field: string | null
}

export interface LayoutListRow {
  id: number
  name: string
  layout_type?: string | null
  parent_layout_id?: number | null
  is_active?: boolean | number | null
}

export const settingsKeys = {
  relations: (c: string) => ['layout-editor', 'relations', c] as const,
  layouts: (c: string, type?: string) => ['layout-editor', 'layouts', c, type ?? 'all'] as const,
  pipelines: () => ['layout-editor', 'pipelines'] as const,
  pdfTemplates: (c: string) => ['layout-editor', 'pdf-templates', c] as const,
  rolePreview: (c: string, role: string) => ['layout-editor', 'role-preview', c, role] as const
}

const rows = <T>(r: { data?: T[] } | null | undefined): T[] =>
  Array.isArray(r?.data) ? (r?.data as T[]) : []

export function useSettingsFields(collection: string) {
  const q = useOverviewFields(collection)
  return (q.data ?? []) as SettingsField[]
}

export function useSettingsRelations(collection: string) {
  const client = useNivaroClient()
  return (
    useQuery<SettingsRelation[]>({
      queryKey: settingsKeys.relations(collection),
      queryFn: () =>
        client
          .request<{ data: SettingsRelation[] }>(get(`/data-model/relations/for/${collection}`))
          .then(rows),
      staleTime: 60_000
    }).data ?? []
  )
}

export function useCollectionLayoutList(collection: string, layoutType?: string) {
  const client = useNivaroClient()
  return (
    useQuery<LayoutListRow[]>({
      queryKey: settingsKeys.layouts(collection, layoutType),
      queryFn: () =>
        client
          .request<{ data: LayoutListRow[] }>(
            get('/collection-layouts', {
              collection,
              ...(layoutType ? { layout_type: layoutType } : {})
            })
          )
          .then((r) => rows(r).filter((l) => !layoutType || l.layout_type === layoutType)),
      staleTime: 15_000
    }).data ?? []
  )
}

export function useWorkflowTemplates(enabled: boolean) {
  const client = useNivaroClient()
  return (
    useQuery<Array<{ id: string; name: string }>>({
      queryKey: settingsKeys.pipelines(),
      queryFn: () =>
        client
          .request<{ data: Array<{ id: unknown; name: unknown }> }>(get('/pipelines'))
          .then((r) => rows(r).map((p) => ({ id: String(p.id), name: String(p.name) }))),
      enabled,
      staleTime: 5 * 60_000
    }).data ?? []
  )
}

export function usePdfTemplates(collection: string, enabled: boolean) {
  const client = useNivaroClient()
  return (
    useQuery<Array<{ id: number; name: string }>>({
      queryKey: settingsKeys.pdfTemplates(collection),
      queryFn: () =>
        client
          .request<{ data: Array<{ id: unknown; name: unknown }> }>(
            get('/pdf-templates', { collection })
          )
          .then((r) => rows(r).map((t) => ({ id: Number(t.id), name: String(t.name) }))),
      enabled,
      staleTime: 60_000
    }).data ?? []
  )
}

/** GET /collection-layouts/preview-as-role — the live resolution path for one role. */
export interface RolePreview {
  role: { id?: string; name: string; admin_access: boolean }
  can_read: boolean
  can_update: boolean
  layout: { id: number; name: string; is_active: boolean; slug?: string | null } | null
  hidden_fields: string[]
  readonly_fields: string[]
  record_conditional_layouts: string[]
  note: string | null
}

export function useRolePreview(collection: string, roleId: string | null) {
  const client = useNivaroClient()
  return useQuery<RolePreview | null>({
    queryKey: settingsKeys.rolePreview(collection, roleId ?? ''),
    queryFn: () =>
      client
        .request<{ data: RolePreview }>(
          get('/collection-layouts/preview-as-role', { collection, role_id: roleId })
        )
        .then((r) => r?.data ?? null),
    enabled: !!roleId,
    staleTime: 15_000
  })
}

export function fieldLabel(fields: SettingsField[], name: string): string {
  const label = fields.find((f) => f.field === name)?.label
  return label?.trim() ? label.trim() : titleCase(name)
}

const NUMERIC = new Set(['integer', 'biginteger', 'bigint', 'decimal', 'float', 'double'])
export const isNumericField = (f: SettingsField) => NUMERIC.has(String(f.type ?? '').toLowerCase())

/** Columns stored on the record (relation aliases have no column). */
export const isStoredField = (f: SettingsField) =>
  !String(f.type ?? '')
    .toLowerCase()
    .startsWith('alias') &&
  f.type !== 'o2m' &&
  f.type !== 'm2m' &&
  !f.field.includes('.')

export function parseFieldOptions(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object') return raw as Record<string, unknown>
  if (typeof raw !== 'string') return {}
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}
