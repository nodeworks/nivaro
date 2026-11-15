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
