import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { api } from '@/lib/api'
import {
  humanizeName,
  type IssueLabelLookup,
  placeOf,
  type ReadableOpts,
  readableIssue,
  serverHeader
} from './issue-readable'
import { type IssueSource, parseIssueTitle } from './issue-title'

/**
 * How an issue reads everywhere it is shown (issue log list + detail, Overview card): the
 * stored title in plain words when it is one of the known server shapes (issue-readable.ts),
 * else parseIssueTitle's headline; a description line; where it came from in words. The raw
 * route and machine text stay available for "Details for support".
 */
export interface IssueDisplay {
  /** What a person reads. */
  title: string
  /** What it means and what to do, when known. */
  description: string | null
  /** Where it came from in words ("Scheduled job", "Server request", "Screen"). */
  place: string | null
  /** The raw route, job or screen ("cron/miss", "GET /api/items/:collection") — support only. */
  where: string | null
  /** Machine text the title left out (SQL, a deadlock victim). */
  technical: string | null
  source: IssueSource | null
  /** The recognised shape ("cron-miss", …), or null. */
  kind: string | null
  /** The record's collection in words, for an issue raised on a record. */
  collectionName: string | null
}

export interface IssueDisplayInput {
  title: string
  details?: string | null
  /** The record's collection, for manual issues raised on a record. */
  collection?: string | null
  /** server | client | manual (the column; the title's prefix when unset). */
  source?: string | null
}

export function issueDisplay(issue: IssueDisplayInput, opts: ReadableOpts = {}): IssueDisplay {
  const parsed = parseIssueTitle(issue.title)
  const r = readableIssue(
    { title: issue.title, details: issue.details, source: issue.source },
    opts
  )
  const route = r ? serverHeader(issue.details).route : null
  const where = parsed.where ?? route
  // A browser crash keeps "Browser" (its app and build ride the tag's tip), never "Screen".
  const browser = (issue.source ?? parsed.source) === 'client'
  return {
    title: r?.title || parsed.headline,
    description: r?.description ?? null,
    place: r?.place ?? (browser ? null : placeOf(where)),
    where,
    technical: parsed.technical,
    source: parsed.source,
    kind: r?.kind ?? null,
    collectionName: issue.collection
      ? opts.labels?.collection?.(issue.collection)?.trim() || humanizeName(issue.collection)
      : null
  }
}

/** The collections and fields a page of issues names, for one label read. */
export function issueLabelRequest(issues: IssueDisplayInput[]): {
  collections: string[]
  fields: Array<{ collection: string; field: string }>
} {
  const collections = new Set<string>()
  const fields = new Map<string, { collection: string; field: string }>()
  for (const i of issues) {
    if (i.collection) collections.add(i.collection)
    const r = readableIssue({ title: i.title, details: i.details, source: i.source })
    if (!r) continue
    for (const c of r.names.collections) collections.add(c)
    for (const f of r.names.fields) {
      collections.add(f.collection)
      fields.set(`${f.collection}.${f.field}`, f)
    }
  }
  return {
    collections: [...collections].sort(),
    fields: [...fields.values()].sort((a, b) =>
      `${a.collection}.${a.field}`.localeCompare(`${b.collection}.${b.field}`)
    )
  }
}

interface LabelsAnswer {
  collections?: Record<string, { singular?: string | null; plural?: string | null } | string>
  fields?: Record<string, string>
}

/** POST /activity/labels' answer as a lookup: collections by their plural name. */
export function labelLookup(data: LabelsAnswer | undefined): IssueLabelLookup | undefined {
  if (!data) return undefined
  return {
    collection: (c) => {
      const v = data.collections?.[c]
      if (!v) return null
      return typeof v === 'string' ? v : (v.plural ?? v.singular ?? null)
    },
    field: (c, f) => data.fields?.[`${c}.${f}`] ?? null
  }
}

/**
 * Collection and field names for the issues on screen (rollup drift, workflow start), read as
 * the viewer through POST /activity/labels. Undefined while loading or when none are named:
 * the words fall back to the ids in words until it lands.
 */
export function useIssueLabels(issues: IssueDisplayInput[]): IssueLabelLookup | undefined {
  const body = useMemo(() => issueLabelRequest(issues), [issues])
  const key = useMemo(() => JSON.stringify(body), [body])
  const { data } = useQuery({
    queryKey: ['issue-title-labels', key],
    queryFn: () =>
      api
        .post<{ data: LabelsAnswer }>('/activity/labels', { refs: [], users: [], ...body })
        .then((r) => r.data.data),
    enabled: body.collections.length > 0,
    staleTime: 5 * 60_000,
    retry: false
  })
  return useMemo(() => labelLookup(data), [data])
}
