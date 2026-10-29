import { type QueryClient, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { api } from '@/lib/api'
import {
  type DraftBody,
  httpStatus,
  type Problem,
  payloadKeys,
  type RecordOption,
  sameBody,
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
  /** The lookups this version published (null = none). */
  lookups?: unknown
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
  check: (key: string, which: 'draft' | 'published', run: string) =>
    ['payload-templates', 'check', key, which, run] as const,
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

export const CHECK_CHUNK = 4

export interface ChunkedCheck {
  status: 'idle' | 'running' | 'done' | 'error'
  /** Records rendered so far / records in the set (null until the set is known). */
  done: number
  total: number | null
  results: CheckResult[]
  error: unknown
}

const IDLE: ChunkedCheck = { status: 'idle', done: 0, total: null, results: [], error: null }

function normResults(raw: unknown): CheckResult[] {
  return (Array.isArray(raw) ? raw : []).map((x: CheckResult) => ({
    ...x,
    id: String(x.id),
    label: x.label ? String(x.label) : String(x.id),
    problems: Array.isArray(x.problems) ? x.problems : [],
    skipped: x.skipped ?? null
  }))
}

/**
 * Check recent records in chunks, so the panel can say "12 / 20": GET /recent for the set, then
 * POST /check with CHECK_CHUNK ids at a time. `run` names one run (e.g. `<rev>:<n>`); a new value
 * starts over, null waits. A finished run is kept in the query cache under (key, which, run), so
 * Check and Publish reuse it; unmount or a new run aborts the requests in flight.
 */
export function useChunkedCheck(
  key: string,
  which: 'draft' | 'published',
  run: string | null
): ChunkedCheck {
  const qc = useQueryClient()
  const [state, setState] = useState<ChunkedCheck>(IDLE)
  useEffect(() => {
    if (!key || run == null) return
    const cacheKey = panelKeys.check(key, which, run)
    const cached = qc.getQueryData<CheckResult[]>(cacheKey)
    if (cached) {
      setState({
        status: 'done',
        done: cached.length,
        total: cached.length,
        results: cached,
        error: null
      })
      return
    }
    const ac = new AbortController()
    setState({ ...IDLE, status: 'running' })
    void (async () => {
      try {
        const r = await api.get<{ ids: Array<string | number> }>(
          `/payload-templates/${enc(key)}/recent`,
          { params: { limit: CHECK_LIMIT }, signal: ac.signal }
        )
        const ids = (r.data.ids ?? []).map(String)
        setState((s) => ({ ...s, total: ids.length }))
        let all: CheckResult[] = []
        for (let i = 0; i < ids.length; i += CHECK_CHUNK) {
          const res = await api.post<{ results: CheckResult[] }>(
            `/payload-templates/${enc(key)}/check`,
            { which, ids: ids.slice(i, i + CHECK_CHUNK) },
            { signal: ac.signal }
          )
          if (ac.signal.aborted) return
          all = [...all, ...normResults(res.data.results)]
          const now = all
          setState((s) => ({ ...s, done: now.length, results: now }))
        }
        if (ac.signal.aborted) return
        qc.setQueryData(cacheKey, all)
        setState({ status: 'done', done: all.length, total: ids.length, results: all, error: null })
      } catch (e) {
        if (ac.signal.aborted) return
        setState((s) => ({ ...s, status: 'error', error: e }))
      }
    })()
    return () => ac.abort()
  }, [key, which, run, qc])
  return state
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
    mutationFn: (args: { base_rev: number }) =>
      api
        .post<{ rev?: number; liquid?: string }>(`/payload-templates/${enc(key)}/convert`, args)
        .then((r) => r.data),
    onSuccess: () => invalidateTemplate(qc, key)
  })
}

/** The records a Convert left out (their scope could not be built), from its 422. */
export function convertSkipped(e: unknown): Array<{ id: string; message: string }> {
  const d = (e as { response?: { data?: { skipped?: unknown } } }).response?.data?.skipped
  return Array.isArray(d)
    ? d.map((x: { id?: unknown; message?: unknown }) => ({
        id: String(x?.id ?? ''),
        message: toText(x?.message ?? '')
      }))
    : []
}

/** The recent-records set Check and Convert use (registrar recent() or the newest records). */
export function fetchRecentIds(key: string, limit = CHECK_LIMIT): Promise<string[]> {
  return api
    .get<{ ids: Array<string | number> }>(`/payload-templates/${enc(key)}/recent`, {
      params: { limit }
    })
    .then((r) => (r.data.ids ?? []).map(String))
}

/** The diffs a 422 `not_equal` from Convert carries; null for any other error. */
export function convertDiffs(e: unknown): ConvertDiff[] | null {
  if (httpStatus(e) !== 422) return null
  const d = (e as { response?: { data?: { diffs?: unknown } } }).response?.data?.diffs
  return Array.isArray(d) ? (d as ConvertDiff[]) : []
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
  if (t.default_body == null) return null
  if (t.default_mode) return toDraftBody(t.default_mode, t.default_body)
  // An older server without default_mode: a body that is not a field map is Liquid.
  let parsed: unknown = t.default_body
  if (typeof parsed === 'string') {
    try {
      parsed = JSON.parse(parsed)
    } catch {
      parsed = null
    }
  }
  const isMap =
    !!parsed && typeof parsed === 'object' && Array.isArray((parsed as { fields?: unknown }).fields)
  return toDraftBody(isMap ? 'map' : 'code', t.default_body)
}

/**
 * What the "newer default" banner says: `hidden` when the draft already is the default and
 * nothing is left to publish (the default is live — the banner would contradict the page),
 * `holds` when the draft holds it but it is not live yet, `offer` otherwise.
 */
export function newerDefaultState(
  t: TemplateDetail,
  draft: DraftBody,
  nothingToPublish: boolean
): 'hidden' | 'holds' | 'offer' {
  if (!t.newer_default) return 'hidden'
  const def = defaultOf(t)
  const holds = !!def && sameBody(def, draft) && sameLookups(defaultLookupsOf(t), draftLookupsOf(t))
  if (!holds) return 'offer'
  return nothingToPublish ? 'hidden' : 'holds'
}

/** Business collections a lookup may read (system collections never; the server re-checks). */
export function useLookupCollections(enabled = true) {
  return useQuery({
    queryKey: ['payload-templates', 'collections'],
    queryFn: () =>
      api.get<{ data: Array<{ collection: string }> }>('/collections').then((r) =>
        (r.data.data ?? [])
          .map((c) => String(c.collection))
          .filter((c) => !/^(nivaro_|directus_)/i.test(c))
          .sort()
      ),
    enabled,
    staleTime: 5 * 60_000
  })
}

/** Save the DRAFT's lookups under the draft revision guard (409 stale like a body save). */
export function useSaveLookups(key: string) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (args: {
      lookups: Record<string, unknown> | null
      base_rev: number
      /** The published version the editor loaded at; a publish since then = 409 stale. */
      base_published_version: number | null
    }) =>
      api
        .put<{ rev: number; data: { lookups: Record<string, unknown> | null } }>(
          `/payload-templates/${enc(key)}/lookups`,
          args
        )
        .then((r) => ({ rev: r.data.rev, lookups: r.data.data?.lookups ?? null })),
    onSuccess: (res) => {
      qc.setQueryData<{ data: TemplateDetail; warning: string | null }>(
        payloadKeys.detail(key),
        (old) =>
          old
            ? {
                ...old,
                data: {
                  ...old.data,
                  draft_rev: res.rev,
                  draft_lookups: res.lookups
                } as TemplateDetail
              }
            : old
      )
      // Draft previews read the draft lookups; the list's status may change.
      void qc.invalidateQueries({ queryKey: ['payload-templates', 'preview', key] })
      void qc.invalidateQueries({ queryKey: ['payload-templates', 'preview-side', key] })
      void qc.invalidateQueries({ queryKey: ['payload-templates', 'admin-list'] })
    }
  })
}

// ─── Lookups on a template (published on the row, the draft's beside it) ────

const asLookups = (v: unknown): Record<string, unknown> | null => {
  let x = v
  if (typeof x === 'string') {
    try {
      x = JSON.parse(x)
    } catch {
      return null
    }
  }
  return x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).length
    ? (x as Record<string, unknown>)
    : null
}

/** The PUBLISHED lookups (what pushes read). */
export const liveLookupsOf = (t: TemplateDetail) => asLookups(t.lookups)
/** The draft's lookups (the route mirrors the published ones until a draft row exists). */
export const draftLookupsOf = (t: TemplateDetail) =>
  // Only an ABSENT key (an older server) mirrors the live lookups: a null draft means "none",
  // so clearing every lookup is something to publish.
  asLookups(
    'draft_lookups' in t
      ? (t as TemplateDetail & { draft_lookups?: unknown }).draft_lookups
      : t.lookups
  )
/** The registrar's declared lookups (Reset to file default brings them back). */
export const defaultLookupsOf = (t: TemplateDetail) =>
  asLookups((t as TemplateDetail & { default_lookups?: unknown }).default_lookups)
export const versionLookupsOf = (v: Pick<VersionDetail, 'lookups'>) => asLookups(v.lookups)

/** Same lookups (null and {} both mean none). */
export function sameLookups(a: unknown, b: unknown): boolean {
  return JSON.stringify(asLookups(a)) === JSON.stringify(asLookups(b))
}

/** One side of a comparison, and which lookups its render reads. */
export type CompareSide = {
  label: string
  body: DraftBody | null
  /** For display (Template view) and, with source 'given', for the render. */
  lookups: Record<string, unknown> | null
  /** 'published' = the live version as pushes render it; 'draft' = with the saved draft's
   *  lookups; 'given' = with `lookups` exactly (an older version, the default). */
  source: 'published' | 'draft' | 'given'
}

/** Render one comparison side for a record (the server renders; the client never evaluates). */
export function useSidePreview(
  key: string,
  recordId: string | null,
  side: CompareSide,
  enabled: boolean
) {
  const draft =
    side.source === 'published' || !side.body
      ? null
      : {
          mode: side.body.mode,
          body: side.body.mode === 'map' ? JSON.stringify(side.body.body) : side.body.body,
          ...(side.source === 'given' ? { lookups: side.lookups } : {})
        }
  return useQuery({
    queryKey: [
      'payload-templates',
      'preview-side',
      key,
      side.source,
      recordId ?? '',
      draft
    ] as const,
    queryFn: ({ signal }) =>
      api
        .post<{ body: unknown; skipped?: string | null }>(
          `/payload-templates/${enc(key)}/preview`,
          {
            id: recordId,
            which: side.source === 'published' ? 'published' : 'draft',
            ...(draft ? { draft } : {})
          },
          { signal }
        )
        .then((r) => ({ body: r.data.body, skipped: r.data.skipped ?? null })),
    enabled: enabled && !!key && !!recordId && !!side.body,
    staleTime: 15_000,
    retry: false
  })
}

/** Server text that may arrive as something other than a string, rendered safely. */
export function toText(v: unknown): string {
  if (typeof v === 'string') return v
  if (v && typeof v === 'object' && typeof (v as { message?: unknown }).message === 'string')
    return (v as { message: string }).message
  try {
    return JSON.stringify(v) ?? String(v)
  } catch {
    return String(v)
  }
}

/** The list a 400 carried (`errors[]`), each rendered as text. */
export function serverErrors(e: unknown): string[] {
  const list = (e as { response?: { data?: { errors?: unknown } } })?.response?.data?.errors
  return Array.isArray(list) ? list.map(toText) : []
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
