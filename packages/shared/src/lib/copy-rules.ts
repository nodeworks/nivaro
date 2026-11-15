/**
 * The fields that never follow a record into a copy — client side of the ONE
 * copy rule (api services/copy-rules.ts, GET /api/copy-rules/:collection).
 * More → Duplicate, Save as template and the Clone dialog all leave these out:
 * the pipeline's state field, audit stamps, generated ids, calculated values,
 * read-only and hidden fields, "do not duplicate" fields and the collection's
 * own never-copy list. A copy is a new record: its pipeline starts fresh.
 */
import type { QueryClient } from '@tanstack/react-query'
import { get } from './commands'

export type CopySkip = Record<string, string>

interface RequestClient {
  request<T>(cmd: unknown): Promise<T>
}

/** Why a field never copies, in plain words, in the order people care about. */
export const COPY_REASON_WORDS: ReadonlyArray<readonly [string, string]> = [
  ['pipeline-state', 'Workflow step'],
  ['never-copy', 'On this collection’s list'],
  ['do-not-duplicate', 'Marked “do not duplicate”'],
  ['read-only', 'Read-only'],
  ['generated', 'Generated ids'],
  ['calculated', 'Calculated'],
  ['rollup', 'Totals from lines'],
  ['rollup-switch', 'Totals from lines'],
  ['hidden', 'Hidden'],
  ['audit', 'Stamps']
]

/** A field name as a label: `workflow_state` → Workflow State, `markComplete` → Mark Complete. */
export function fieldTitle(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase())
}

export interface NeverCopiedGroup {
  reason: string
  label: string
  fields: Array<{ field: string; label: string }>
}

/**
 * The fields of this collection a copy never carries, grouped by reason (the
 * Clone dialog's "N fields are never copied" and the never-copy settings card).
 * Only fields the collection really has; link lists are not counted (they copy
 * under their own rule).
 */
export function groupNeverCopied(
  skip: CopySkip | null | undefined,
  fields: ReadonlyArray<{ field: string; label?: string | null }>
): NeverCopiedGroup[] {
  const byName = new Map(fields.map((f) => [f.field, f]))
  const groups = new Map<string, NeverCopiedGroup>()
  for (const [reason, label] of COPY_REASON_WORDS) {
    if (!groups.has(label)) groups.set(label, { reason, label, fields: [] })
  }
  for (const [field, why] of Object.entries(skip ?? {})) {
    const f = byName.get(field)
    if (!f || why === 'list') continue
    const label = COPY_REASON_WORDS.find(([r]) => r === why)?.[1]
    if (!label) continue
    groups.get(label)?.fields.push({ field, label: f.label?.trim() || fieldTitle(field) })
  }
  return [...groups.values()].filter((g) => g.fields.length > 0)
}

/** Fields a copied CHILD row (a grid line) leaves out: hidden columns still copy there. */
export function childCopySkip(skip: CopySkip | null | undefined): Set<string> {
  return new Set(
    Object.entries(skip ?? {})
      .filter(([, why]) => why !== 'hidden' && why !== 'list')
      .map(([f]) => f)
  )
}

/**
 * Header fields the copy leaves out. A stored rollup ('rollup') is left to the
 * form's own per-record check (isDerivedForRecord): a total a filtered-out
 * record types by hand (a PUB's amount) still copies, a derived one does not.
 */
export function headerCopySkip(skip: CopySkip | null | undefined): Set<string> {
  return new Set(
    Object.entries(skip ?? {})
      .filter(([, why]) => why !== 'rollup')
      .map(([f]) => f)
  )
}

/**
 * The copy rule of one collection (cached a minute). Null when it cannot be
 * read — callers then keep their own client-side rules only.
 */
export async function fetchCopySkip(
  client: RequestClient,
  qc: QueryClient,
  collection: string
): Promise<CopySkip | null> {
  try {
    return await qc.fetchQuery(copyRulesQuery(client, collection))
  } catch {
    return null
  }
}

/** The ONE query for a collection's copy rule — every reader uses it (one cached shape). */
export function copyRulesQuery(client: RequestClient, collection: string) {
  return {
    queryKey: ['copy-rules', collection] as const,
    queryFn: () =>
      client
        .request<{ data: { skip: CopySkip } }>(get(`/copy-rules/${collection}`))
        .then((r) => r?.data?.skip ?? {}),
    staleTime: 60_000
  }
}
