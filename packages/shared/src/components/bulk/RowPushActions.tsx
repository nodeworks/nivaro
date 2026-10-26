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
}): {
  /** Every push the collection offers; `ready` = it applies to this record now. */
  pushActions: Array<PushItemAction & { ready: boolean }>
  failedPartners: string[]
} {
  const client = useNivaroClient()
  const pushOn = builtinListed(bulkData, bulkEnabledKeys, collection, 'push')
  const retryOn = builtinListed(bulkData, bulkEnabledKeys, collection, 'retry-push')
  // Every push the collection offers (same key + shape as the bulk bar's) — a
  // push the record is not ready for is listed disabled rather than missing,
  // so "Push to Fusion" never vanishes beside "Retry" (Rob 2026-10-26).
  const { data: allActions = [] } = useQuery({
    queryKey: ['bulk-push-actions', collection],
    queryFn: () =>
      client
        .request<{ data: PushItemAction[] }>(get('/item-actions/registered', { collection }))
        .then((r) => r.data ?? [])
        .catch(() => [] as PushItemAction[]),
    enabled: open && pushOn,
    staleTime: 5 * 60_000
  })
  // Same key + shape as the record form's ItemActionButtons — one fetch serves both.
  const { data: readyActions = [] } = useQuery({
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
  const readyIds = new Set(readyActions.map((a) => a.id))
  const pushActions = [
    ...readyActions.map((a) => ({ ...a, ready: true })),
    // Not ready here: listed, disabled — unless it is withheld from this person
    // (an addendum they could not create), which stays hidden.
    ...allActions
      .filter((a) => !readyIds.has(a.id) && !a.requires_addendum_create)
      .map((a) => ({ ...a, ready: false }))
  ]
  return { pushActions: pushOn ? pushActions : [], failedPartners: retryOn ? failedPartners : [] }
}

/** Run one row's push / retry; resolves with that record's outcome. */
export async function runRowPush(
  client: NivaroClient,
  collection: string,
  id: string | number,
  op: RowPushOp,
  note?: string,
  pick?: string | null
): Promise<PushRunOutcome['outcomes'][number] | null> {
  const payload: Record<string, unknown> = {}
  if (note?.trim()) payload.message = note.trim()
  if (op.kind === 'push' && op.action.choose && pick != null) payload[op.action.choose.key] = pick
  const res =
    op.kind === 'push'
      ? await client.request<{ data: PushRunOutcome }>(
          post('/bulk-actions/push', {
            collection,
            action_id: op.action.id,
            ids: [id],
            ...(Object.keys(payload).length > 0 ? { payload } : {})
          })
        )
      : await client.request<{ data: PushRunOutcome }>(
          post('/bulk-actions/retry-push', { collection, ids: [id] })
        )
  return res.data?.outcomes?.[0] ?? null
}
