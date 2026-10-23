import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import type { ExternalApi } from '../ExternalApis'

// ─── Partner payload templates: admin types + hooks ─────────────────────────
// The admin never imports api/src, so the field-map shapes are mirrored here
// from spec 2026-10-22 §5.1 (api/src/services/payload-templates/types.ts).
// Every query key starts with 'payload-templates'; the pipeline editor's
// template picker owns ['payload-templates', 'list', <api>] (a bare array),
// so this file never reuses that key with a different shape.

export interface ConditionRule {
  field: string
  op: string
  value: string | number | null
}

/** A dotted path into the render scope: `record.x`, `context.k[0].y`, `line.a.b`. */
export type Path = string

export type MapSpec = { v: 1; fields: Field[] }

export type Field = {
  id: string
  key: string
  type: 'text' | 'number' | 'boolean' | 'date' | 'object' | 'list' | 'json'
  value?: ValueSpec
  children?: Field[]
  list?: ListSpec
  include: 'always' | 'not_empty' | { when: ConditionRule[] }
  rules?: {
    required?: boolean
    max_length?: number
    min?: number
    max?: number
    allowed?: string[]
    pattern?: string
  }
  locked?: true
  note?: string
}

export type ListSpec = {
  source: Path
  item: string
  where?: ConditionRule[]
  sort?: string
  number_as?: string
  scalar?: true
}

export type BuiltinName =
  | 'today'
  | 'now'
  | 'acting_user.email'
  | 'acting_user.name'
  | 'acting_user.employee_id'
  | 'list.number'
  | 'state.label'
  | 'state.external_label'

export type ValueSpec = (
  | { source: 'fixed'; value: string | number | boolean | null }
  | { source: 'path'; path: Path }
  | { source: 'builtin'; name: BuiltinName }
  | { source: 'secret'; name: string }
  | { source: 'switch'; cases: { when: ConditionRule[]; value: ValueSpec }[]; else?: ValueSpec }
  | { source: 'formula'; liquid: string }
) & { transforms?: Transform[]; fallbacks?: ValueSpec[] }

export type Transform =
  | { op: 'trim' | 'upper' | 'lower' | 'next_open_day' | 'editor_text' }
  | { op: 'truncate'; n: number }
  | { op: 'prefix' | 'suffix'; text: string }
  | { op: 'pad_start'; n: number; char: string }
  | { op: 'replace'; from: string; to: string }
  | { op: 'date'; format: string }
  | { op: 'add_days' | 'at_least_days_out'; n: number }
  | { op: 'join'; sep: string }

/** One thing wrong with a render, anchored to the field-map row that caused it. */
export type Problem = {
  field_id: string
  path: string
  message: string
  severity: 'error' | 'warning'
}

export type TemplateMode = 'map' | 'code'
export type TemplateStatus = 'live' | 'draft' | 'unpublished'

/** A template body as the editor holds it: a parsed spec in map mode, Liquid text in code mode. */
export type DraftBody = { mode: 'map'; body: MapSpec } | { mode: 'code'; body: string }

export interface TemplateListItem {
  key: string
  label: string
  external_api: string | null
  status: TemplateStatus
  published_version: number | null
  draft_rev: number
  used_by_count: number
  newer_default: boolean
}

export interface UsedBy {
  kind: 'transition' | 'code'
  label: string
  template_id?: string
  transition_id?: string
}

export interface TemplateDetail {
  id: number
  key: string
  label: string
  description: string | null
  external_api: string | null
  endpoint_path: string | null
  collection: string
  owner: string | null
  draft_mode: TemplateMode
  draft_body: unknown
  published_mode: TemplateMode | null
  published_body: unknown
  draft_rev: number
  draft_updated_by: string | null
  draft_updated_at: string | null
  published_version: number | null
  published_at: string | null
  published_by: string | null
  /** Display names, when the route joins them in. */
  draft_updated_by_name?: string | null
  published_by_name?: string | null
  locked_keys: string[]
  lookups: unknown
  used_by: UsedBy[]
  /** `context.<key>` names a render can read (first referencing action's context + own lookups). */
  context_keys: string[]
  newer_default: boolean
  /** The registrar ships a file default for this key (Reset to file default). */
  has_default?: boolean
  default_mode?: TemplateMode | null
  default_body?: unknown
}

export interface PreviewResult {
  body: unknown
  problems: Problem[]
  values: Record<string, unknown>
  skipped: string | null
  version: number | null
}

export interface RecordOption {
  id: string
  label: string
}

// ─── Query keys ──────────────────────────────────────────────────────────────

export const payloadKeys = {
  all: ['payload-templates'] as const,
  list: (externalApi: string) => ['payload-templates', 'admin-list', externalApi] as const,
  detail: (key: string) => ['payload-templates', 'detail', key] as const,
  preview: (key: string, which: 'draft' | 'published', id: string, draft: DraftBody | null) =>
    ['payload-templates', 'preview', key, which, id, draft] as const,
  records: (key: string, q: string) => ['payload-templates', 'records', key, q] as const
}

// ─── Normalizers ─────────────────────────────────────────────────────────────

function parseMaybeJson(v: unknown): unknown {
  if (typeof v !== 'string') return v
  try {
    return JSON.parse(v)
  } catch {
    return v
  }
}

function isSpec(v: unknown): v is MapSpec {
  return !!v && typeof v === 'object' && Array.isArray((v as { fields?: unknown }).fields)
}

/** A stored body as the editor holds it. A map body that does not parse becomes an empty map. */
export function toDraftBody(mode: TemplateMode | null | undefined, body: unknown): DraftBody {
  if (mode === 'code') return { mode: 'code', body: typeof body === 'string' ? body : '' }
  const parsed = parseMaybeJson(body)
  return { mode: 'map', body: isSpec(parsed) ? parsed : { v: 1, fields: [] } }
}

export function draftOf(t: TemplateDetail): DraftBody {
  return toDraftBody(t.draft_mode, t.draft_body)
}

export function publishedOf(t: TemplateDetail): DraftBody | null {
  if (t.published_version == null || t.published_body == null) return null
  return toDraftBody(t.published_mode, t.published_body)
}

/** Same mode and the same body (map specs compared as JSON). */
export function sameBody(a: DraftBody | null, b: DraftBody | null): boolean {
  if (!a || !b) return a === b
  if (a.mode !== b.mode) return false
  return a.mode === 'code' ? a.body === b.body : JSON.stringify(a.body) === JSON.stringify(b.body)
}

function normalizeDetail(raw: TemplateDetail): TemplateDetail {
  const locked = parseMaybeJson(raw.locked_keys)
  return {
    ...raw,
    locked_keys: Array.isArray(locked) ? locked.map(String) : [],
    lookups: parseMaybeJson(raw.lookups),
    used_by: Array.isArray(raw.used_by) ? raw.used_by : [],
    context_keys: Array.isArray(raw.context_keys) ? raw.context_keys.map(String) : [],
    newer_default: !!raw.newer_default
  }
}

/** The status a template is in, from its detail row (the list route sends it ready-made). */
export function detailStatus(t: TemplateDetail, local?: DraftBody | null): TemplateStatus {
  const published = publishedOf(t)
  if (!published) return 'unpublished'
  return sameBody(local ?? draftOf(t), published) ? 'live' : 'draft'
}

export function statusText(status: TemplateStatus, version: number | null): string {
  if (status === 'live') return `Live v${version ?? '?'}`
  if (status === 'draft') return 'Draft changes'
  return 'Not published'
}

/** Body-secret names on an API row (values arrive masked). */
export function bodySecretNames(apiRow: Pick<ExternalApi, 'auth_config'> | null | undefined) {
  const bs = (apiRow?.auth_config as { body_secrets?: unknown } | null | undefined)?.body_secrets
  return bs && typeof bs === 'object' && !Array.isArray(bs) ? Object.keys(bs) : []
}

// ─── Small helpers ───────────────────────────────────────────────────────────

const ET = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true
})
const ET_TIME = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York',
  hour: 'numeric',
  minute: '2-digit',
  hour12: true
})

function toDate(iso: string): Date {
  // datetime2 values may arrive without a zone; they are UTC.
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`)
}

/** "Oct 22, 9:45 PM ET" (12-hour Eastern). `timeOnly` → "9:45 PM ET". */
export function formatEt(iso: string | null | undefined, timeOnly = false): string {
  if (!iso) return ''
  const d = toDate(iso)
  if (Number.isNaN(d.getTime())) return ''
  return `${(timeOnly ? ET_TIME : ET).format(d)} ET`
}

/** A server error in plain words: `errors[]` (joined), then `message`, then a string `error`. */
export function errorMessage(e: unknown, fallback = 'Something went wrong'): string {
  const r = (
    e as { response?: { data?: { error?: unknown; errors?: unknown; message?: unknown } } }
  )?.response?.data
  if (Array.isArray(r?.errors) && r.errors.length) return r.errors.map(String).join('; ')
  if (typeof r?.message === 'string' && r.message) return r.message
  if (typeof r?.error === 'string' && r.error) return r.error
  if (e instanceof Error && e.message) return e.message
  return fallback
}

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value)
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms)
    return () => clearTimeout(t)
  }, [value, ms])
  return v
}

export function httpStatus(e: unknown): number | null {
  return (e as { response?: { status?: number } })?.response?.status ?? null
}

/** The current row a 409 from draft save / publish carries. */
export function staleCurrent(e: unknown): TemplateDetail | null {
  if (httpStatus(e) !== 409) return null
  const cur = (e as { response?: { data?: { current?: TemplateDetail } } }).response?.data?.current
  return cur ? normalizeDetail(cur) : null
}

/** Wire form of a body: both modes travel as text (map specs as JSON text; the server parses). */
function wire(d: DraftBody): { mode: TemplateMode; body: string } {
  return { mode: d.mode, body: d.mode === 'map' ? JSON.stringify(d.body) : d.body }
}

// ─── Hooks ───────────────────────────────────────────────────────────────────

export function useExternalApis() {
  return useQuery<ExternalApi[]>({
    queryKey: ['external-apis'],
    queryFn: () => api.get<{ data: ExternalApi[] }>('/external-apis').then((r) => r.data.data)
  })
}

export function useTemplates(externalApi: string | null | undefined) {
  return useQuery({
    queryKey: payloadKeys.list(externalApi ?? ''),
    queryFn: () =>
      api
        .get<{ data: TemplateListItem[]; warning: string | null }>('/payload-templates', {
          params: { external_api: externalApi }
        })
        .then((r) => ({ data: r.data.data ?? [], warning: r.data.warning ?? null })),
    enabled: !!externalApi
  })
}

/** The one fetcher behind `payloadKeys.detail` — every reader of that key caches this shape. */
export function fetchTemplate(
  key: string
): Promise<{ data: TemplateDetail; warning: string | null }> {
  return api
    .get<{ data: TemplateDetail; warning: string | null }>(
      `/payload-templates/${encodeURIComponent(key)}`
    )
    .then((r) => ({ data: normalizeDetail(r.data.data), warning: r.data.warning ?? null }))
}

export function useTemplate(key: string | null | undefined) {
  return useQuery({
    queryKey: payloadKeys.detail(key ?? ''),
    queryFn: () => fetchTemplate(key ?? ''),
    enabled: !!key,
    // The editor holds the draft locally; a focus refetch must not look like someone else's edit.
    refetchOnWindowFocus: false,
    retry: (n, e) => httpStatus(e) !== 404 && n < 2
  })
}

/**
 * PUT the draft. Resolves `{ rev }`; a stale `base_rev` — or a publish since the editor loaded
 * (`base_published_version`) — rejects with the 409 (read it with `staleCurrent`), a spec the
 * server refuses rejects with the 400 (`errorMessage`).
 */
export function useSaveDraft(key?: string) {
  const qc = useQueryClient()
  return useMutation({
    /** `key` overrides the hook's key (a flush after the editor switched templates). */
    mutationFn: (args: {
      draft: DraftBody
      base_rev: number
      base_published_version: number | null
      key?: string
    }) =>
      api
        .put<{ rev: number }>(
          `/payload-templates/${encodeURIComponent(args.key ?? key ?? '')}/draft`,
          {
            ...wire(args.draft),
            base_rev: args.base_rev,
            base_published_version: args.base_published_version
          }
        )
        .then((r) => r.data),
    onSuccess: (res, args) => {
      const k = args.key ?? key ?? ''
      const wired = wire(args.draft)
      let updated = null as TemplateDetail | null
      qc.setQueryData<{ data: TemplateDetail; warning: string | null }>(
        payloadKeys.detail(k),
        (old) => {
          if (!old) return old
          updated = {
            ...old.data,
            draft_rev: res.rev,
            draft_mode: wired.mode,
            draft_body: wired.body,
            draft_updated_at: new Date().toISOString()
          }
          return { ...old, data: updated }
        }
      )
      // The list's status chip follows the save; no refetch per keystroke pause.
      qc.setQueriesData<{ data: TemplateListItem[]; warning: string | null }>(
        { queryKey: ['payload-templates', 'admin-list'] },
        (old) =>
          old
            ? {
                ...old,
                data: old.data.map((t) =>
                  t.key === k
                    ? {
                        ...t,
                        draft_rev: res.rev,
                        status: updated
                          ? detailStatus(updated)
                          : t.published_version != null
                            ? 'draft'
                            : 'unpublished'
                      }
                    : t
                )
              }
            : old
      )
    }
  })
}

export interface PreviewArgs {
  which: 'draft' | 'published'
  recordId: string | null
  /** The unsaved draft to render (draft view only); null = the stored draft. */
  draft?: DraftBody | null
  enabled?: boolean
}

/** Render a template for one record. Same args → one shared request (PreviewPane + editor). */
export function usePreview(key: string | null | undefined, args: PreviewArgs) {
  const draft = args.which === 'draft' ? (args.draft ?? null) : null
  return useQuery({
    queryKey: payloadKeys.preview(key ?? '', args.which, args.recordId ?? '', draft),
    queryFn: ({ signal }) =>
      api
        .post<PreviewResult>(
          `/payload-templates/${encodeURIComponent(key ?? '')}/preview`,
          { id: args.recordId, which: args.which, ...(draft ? { draft: wire(draft) } : {}) },
          { signal }
        )
        .then((r) => ({
          body: r.data.body,
          problems: Array.isArray(r.data.problems) ? r.data.problems : [],
          values: r.data.values ?? {},
          skipped: r.data.skipped ?? null,
          version: r.data.version ?? null
        })),
    enabled: !!key && !!args.recordId && args.enabled !== false,
    // Keep the last render while the next one loads — never across templates.
    placeholderData: (prev, prevQuery) =>
      prevQuery?.queryKey[2] === (key ?? '') ? prev : undefined,
    staleTime: 15_000,
    retry: false
  })
}

/** Newest records of the template's collection, or the ones matching `q`. */
export function useRecordSearch(key: string | null | undefined, q: string) {
  return useQuery({
    queryKey: payloadKeys.records(key ?? '', q),
    queryFn: ({ signal }) =>
      api
        .get<{ data: Array<{ id: string | number; label?: string | null }> }>(
          `/payload-templates/${encodeURIComponent(key ?? '')}/record-search`,
          { params: q ? { q } : {}, signal }
        )
        .then((r) =>
          (r.data.data ?? []).map(
            (x): RecordOption => ({ id: String(x.id), label: x.label ? String(x.label) : '' })
          )
        ),
    enabled: !!key,
    // Keep the last render while the next one loads — never across templates.
    placeholderData: (prev, prevQuery) =>
      prevQuery?.queryKey[2] === (key ?? '') ? prev : undefined,
    staleTime: 30_000
  })
}

export interface CreateTemplateInput {
  key: string
  label: string
  external_api: string
  collection: string
  endpoint_path?: string | null
  mode: TemplateMode
}

export function useCreateTemplate() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (input: CreateTemplateInput) =>
      api
        .post<{ data: { key: string } }>('/payload-templates', {
          key: input.key,
          label: input.label,
          external_api: input.external_api,
          ...(input.endpoint_path ? { endpoint_path: input.endpoint_path } : {}),
          collection: input.collection,
          mode: input.mode,
          body: input.mode === 'map' ? JSON.stringify({ v: 1, fields: [] }) : '{\n}'
        })
        .then((r) => r.data.data ?? { key: input.key }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: payloadKeys.all })
  })
}

/** Lowercase slug for a template key (`^[a-z0-9-]+$`). */
export function slugKey(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120)
}

/** Every body-secret name a template body reads (map `secret` sources, Liquid `secrets.x`). */
export function secretsUsedBy(body: DraftBody | null): string[] {
  if (!body) return []
  const out = new Set<string>()
  if (body.mode === 'code') {
    for (const m of body.body.matchAll(/\bsecrets\.([A-Za-z0-9_.-]+)/g)) out.add(m[1])
    for (const m of body.body.matchAll(/['"]([A-Za-z0-9_.-]+)['"]\s*\|\s*secret\b/g)) out.add(m[1])
    return [...out]
  }
  const walkValue = (v: ValueSpec | undefined) => {
    if (!v) return
    if (v.source === 'secret' && v.name) out.add(v.name)
    if (v.source === 'switch') {
      for (const c of v.cases ?? []) walkValue(c.value)
      walkValue(v.else)
    }
    for (const f of v.fallbacks ?? []) walkValue(f)
  }
  const walk = (fields: Field[] | undefined) => {
    for (const f of fields ?? []) {
      walkValue(f.value)
      walk(f.children)
    }
  }
  walk(body.body.fields)
  return [...out]
}
