import { useQuery } from '@tanstack/react-query'
import { useNivaroClient } from '../../context'
import { get } from '../../lib/commands'

/**
 * The caller's own notification subscriptions — ONE list read shared by the
 * record bell and every grid row's watch button. Each consumer narrows it to
 * its own record through `select`, so a form with forty saved lines costs one
 * request, not forty copies of the same list under forty keys.
 */
export interface MySubscriptionRow {
  id: number
  collection: string | null
  event_type: string
  filter_field: string | null
  filter_value: string | null
  filters?: Array<{ field: string; op: string; value?: unknown }> | null
}

export const MY_SUBSCRIPTIONS_KEY = ['notification-subscriptions', 'mine'] as const

export function subscriptionTargetsRecord(
  s: MySubscriptionRow,
  collection: string,
  id: string
): boolean {
  if (s.collection !== collection) return false
  if (s.filter_field === 'id' && String(s.filter_value) === id) return true
  return (s.filters ?? []).some((f) => f.field === 'id' && f.op === 'eq' && String(f.value) === id)
}

export function useRecordSubscriptions(collection: string, id: string) {
  const client = useNivaroClient()
  return useQuery<MySubscriptionRow[], Error, MySubscriptionRow[]>({
    queryKey: MY_SUBSCRIPTIONS_KEY,
    queryFn: () =>
      client
        .request<{ data: MySubscriptionRow[] }>(get('/notification-subscriptions'))
        .then((r) => r.data ?? []),
    select: (rows) => rows.filter((s) => subscriptionTargetsRecord(s, collection, id)),
    staleTime: 60_000
  })
}
