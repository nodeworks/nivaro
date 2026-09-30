import type { NivaroClient } from '@nivaro/sdk'
import { useQuery } from '@tanstack/react-query'
import { useNivaroClient } from '../../context'
import { get, post } from '../../lib/commands'
import type { AvailableBulkAction } from './BulkActionButtons'
import { builtinListed, type PushItemAction, type PushRunOutcome } from './PushBulkButtons'

/**
 * #622 — the row Actions menu's integration entries: "Push to <partner>"
 * (registered item actions that apply to THIS record — the same
 * /item-actions/registered?item= answer the record form's buttons use) and
 * "Retry last failed push" (when a partner's latest submission failed).
 * Both run through the one-record form of the bulk endpoints, so the
 * built-in switch, access rule, update permission and per-record gates are
 * the ones the selection bars enforce.
 */

export type RowPushOp =
  | { kind: 'push'; action: PushItemAction }
  | { kind: 'retry'; partners: string[] }

interface SubmissionRow {
  external_api: number | null
  external_api_name?: string | null
  status: string
}

/** Partners whose LATEST submission failed. `rows` newest first (the route's order). */
export function latestFailedPartners(rows: SubmissionRow[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const r of rows) {
    const key = String(r.external_api ?? '')
    if (seen.has(key)) continue
    seen.add(key)
    if (r.status === 'failed' || r.status === 'rejected')
      out.push(r.external_api_name ?? `API ${r.external_api ?? '?'}`)
  }
  return out
}

export function useRowPushActions({
  collection,
  id,
  open,
  bulkData,
  bulkEnabledKeys
}: {
  collection: string
  id: string | number
  open: boolean
  bulkData: Record<string, AvailableBulkAction[]> | undefined
  bulkEnabledKeys?: string[] | null
}): { pushActions: PushItemAction[]; failedPartners: string[] } {
  const client = useNivaroClient()
  const pushOn = builtinListed(bulkData, bulkEnabledKeys, collection, 'push')
  const retryOn = builtinListed(bulkData, bulkEnabledKeys, collection, 'retry-push')
  // Same key + shape as the record form's ItemActionButtons — one fetch serves both.
  const { data: pushActions = [] } = useQuery({
    queryKey: ['item-actions', collection, String(id)],
    queryFn: () =>
      client
        .request<{ data: PushItemAction[] }>(
          get('/item-actions/registered', { collection, item: String(id) })
        )
        .then((r) => r.data ?? [])
        .catch(() => [] as PushItemAction[]),
    enabled: open && pushOn,
    staleTime: 5 * 60_000
  })
  const { data: failedPartners = [] } = useQuery({
    queryKey: ['row-push-state', collection, String(id)],
    queryFn: () =>
      client
        .request<{ data: SubmissionRow[] }>(get(`/erp-submissions/${collection}/${id}`))
        .then((r) => latestFailedPartners(r.data ?? []))
        .catch(() => [] as string[]),
    enabled: open && retryOn,
    staleTime: 15_000
  })
  return { pushActions: pushOn ? pushActions : [], failedPartners: retryOn ? failedPartners : [] }
}

/** Run one row's push / retry; resolves with that record's outcome. */
export async function runRowPush(
  client: NivaroClient,
  collection: string,
  id: string | number,
  op: RowPushOp,
  note?: string
): Promise<PushRunOutcome['outcomes'][number] | null> {
  const res =
    op.kind === 'push'
      ? await client.request<{ data: PushRunOutcome }>(
          post('/bulk-actions/push', {
            collection,
            action_id: op.action.id,
            ids: [id],
            ...(note?.trim() ? { payload: { message: note.trim() } } : {})
          })
        )
      : await client.request<{ data: PushRunOutcome }>(
          post('/bulk-actions/retry-push', { collection, ids: [id] })
        )
  return res.data?.outcomes?.[0] ?? null
}
