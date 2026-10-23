import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '@/lib/api'
import {
  type DraftBody,
  httpStatus,
  type Problem,
  payloadKeys,
  type RecordOption,
  type TemplateDetail,
  type TemplateMode,
  toDraftBody
} from './api'

// ─── Hooks for the Publish / Check / History / default / Convert surfaces ───
// Kept apart from api.ts (the shell's file). Every key starts with
// 'payload-templates' so a template-wide invalidate reaches them.

export interface VersionSummary {
  id: number
  version: number
  mode: TemplateMode
  note: string
  published_by: string | null
  published_at: string | null
  published_by_name?: string | null
}

export interface VersionDetail extends VersionSummary {
  body: string
}

export interface CheckResult {
  id: string
  label: string
  ok: boolean
  problems: Problem[]
  skipped: string | null
}

/** One body the converter could not reproduce (index −1 = refused before rendering). */
export interface ConvertDiff {
  index: number
  path: string
  map: unknown
  liquid: unknown
  message?: string
}

export const CHECK_LIMIT = 20

export const panelKeys = {
  versions: (key: string) => ['payload-templates', 'versions', key] as const,
  version: (key: string, v: number) => ['payload-templates', 'version', key, v] as const,
  check: (key: string, which: 'draft' | 'published', rev: number) =>
    ['payload-templates', 'check', key, which, rev] as const,
  people: (ids: string[]) => ['payload-templates', 'people', ids] as const,
  pipeline: (id: string) => ['payload-templates', 'pipeline', id] as const
}

const enc = encodeURIComponent

export function useVersions(key: string, enabled = true) {
  return useQuery({
    queryKey: panelKeys.versions(key),
    queryFn: () =>
      api
        .get<{ data: VersionSummary[] }>(`/payload-templates/${enc(key)}/versions`)
        .then((r) => (Array.isArray(r.data.data) ? r.data.data : [])),
    enabled: !!key && enabled
  })
}

export function useVersion(key: string, v: number | null) {
  return useQuery({
    queryKey: panelKeys.version(key, v ?? 0),
    queryFn: () =>
      api
        .get<{ data: VersionDetail }>(`/payload-templates/${enc(key)}/versions/${v}`)
        .then((r) => r.data.data),
    enabled: !!key && v != null,
    // A published version never changes.
    staleTime: Number.POSITIVE_INFINITY
  })
}

export function versionBody(v: Pick<VersionDetail, 'mode' | 'body'>): DraftBody {
  return toDraftBody(v.mode, v.body)
}

/** Render the recent records through the saved draft (or live). `rev` = the saved draft it checks. */
export function useCheck(
  key: string,
  which: 'draft' | 'published',
  rev: number | null,
  enabled = true
) {
  return useQuery({
    queryKey: panelKeys.check(key, which, rev ?? -1),
    queryFn: ({ signal }) =>
      api
        .post<{ results: CheckResult[] }>(
          `/payload-templates/${enc(key)}/check`,
          { which, limit: CHECK_LIMIT },
          { signal }
        )
        .then((r) =>
          (r.data.results ?? []).map((x) => ({
            ...x,
            id: String(x.id),
            label: x.label ? String(x.label) : String(x.id),
            problems: Array.isArray(x.problems) ? x.problems : [],
            skipped: x.skipped ?? null
          }))
        ),
    enabled: !!key && rev != null && enabled,
    staleTime: 60_000,
    retry: false
  })
}

function invalidateTemplate(qc: ReturnType<typeof useQueryClient>, key: string) {
  void qc.invalidateQueries({ queryKey: payloadKeys.detail(key) })
  void qc.invalidateQueries({ queryKey: ['payload-templates', 'admin-list'] })
  void qc.invalidateQueries({ queryKey: panelKeys.versions(key) })
  // The pipeline editor's picker lists status too.
  void qc.invalidateQueries({ queryKey: ['payload-templates', 'list'] })
}

export function usePublish(key: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (args: { base_rev: number; note: string }) =>
      api
        .post<{ version: number }>(`/payload-templates/${enc(key)}/publish`, args)
        .then((r) => r.data),
    onSuccess: () => invalidateTemplate(qc, key)
  })
}

export function useRestoreVersion(key: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (v: number) =>
      api
        .post<{ rev: number }>(`/payload-templates/${enc(key)}/versions/${v}/restore`)
        .then((r) => r.data),
    onSuccess: () => invalidateTemplate(qc, key)
  })
}

export function useResetDefault(key: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () =>
      api.post<{ rev: number }>(`/payload-templates/${enc(key)}/reset-default`).then((r) => r.data),
    onSuccess: () => invalidateTemplate(qc, key)
  })
}

export function useConvert(key: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (args: { ids?: string[]; base_rev: number }) =>
      api
        .post<{ rev?: number; liquid?: string }>(`/payload-templates/${enc(key)}/convert`, args)
        .then((r) => r.data),
    onSuccess: () => invalidateTemplate(qc, key)
  })
}

/** The diffs a 422 `not_equal` from Convert carries; null for any other error. */
export function convertDiffs(e: unknown): ConvertDiff[] | null {
  if (httpStatus(e) !== 422) return null
  const d = (e as { response?: { data?: { diffs?: unknown } } }).response?.data?.diffs
  return Array.isArray(d) ? (d as ConvertDiff[]) : []
}

/** Display names for user ids (the shared people-card batch route). */
export function usePeople(ids: Array<string | null | undefined>) {
  const list = [...new Set(ids.filter((x): x is string => !!x))].sort()
  return useQuery({
    queryKey: panelKeys.people(list),
    queryFn: () =>
      api
        .post<{
          data: Array<{
            id: string
            first_name: string | null
            last_name: string | null
            email: string
          }>
        }>('/users/cards', { ids: list })
        .then((r) => {
          const out: Record<string, string> = {}
          for (const u of r.data.data ?? []) {
            const name = [u.first_name, u.last_name].filter(Boolean).join(' ').trim()
            out[String(u.id).toUpperCase()] = name || u.email
          }
          return out
        }),
    enabled: list.length > 0,
    staleTime: 5 * 60_000
  })
}

export function personName(
  names: Record<string, string> | undefined,
  id: string | null | undefined,
  given?: string | null
): string | null {
  if (given) return given
  if (!id) return null
  return names?.[id.toUpperCase()] ?? null
}

/** The pipeline a transition belongs to, with its transitions' actions (Data tab). */
export function usePipeline(id: string | null | undefined) {
  return useQuery({
    queryKey: panelKeys.pipeline(id ?? ''),
    queryFn: () =>
      api
        .get<{
          data: {
            id: string
            name?: string
            transitions?: Array<{ id: string; label?: string | null; actions?: unknown }>
          }
        }>(`/pipelines/${enc(id ?? '')}`)
        .then((r) => r.data.data),
    enabled: !!id,
    staleTime: 60_000
  })
}

/** The file default a registrar ships, when the route sends it. */
export function defaultOf(t: TemplateDetail): DraftBody | null {
  const x = t as TemplateDetail & { has_default?: boolean; default_mode?: TemplateMode }
  if (x.default_body == null) return null
  return toDraftBody(x.default_mode ?? 'map', x.default_body)
}

/**
 * The newest records of the template's collection — the same request and cache entry as the
 * record picker's empty search (`useRecordSearch(key, '')`), so a loaded picker costs nothing.
 */
export function fetchNewestRecords(qc: QueryClient, key: string): Promise<RecordOption[]> {
  return qc.ensureQueryData({
    queryKey: payloadKeys.records(key, ''),
    queryFn: () =>
      api
        .get<{ data: Array<{ id: string | number; label?: string | null }> }>(
          `/payload-templates/${enc(key)}/record-search`
        )
        .then((r) =>
          (r.data.data ?? []).map(
            (x): RecordOption => ({ id: String(x.id), label: x.label ? String(x.label) : '' })
          )
        )
  })
}
