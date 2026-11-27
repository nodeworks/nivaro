import { useAuth } from '@/lib/auth'
import { CostChip } from './CostFigure'
import { environmentNow, resourceSeries, useLiveCosts } from './use-costs'

/**
 * The `$x/mo` chips on Hub rows (Task 44c): a managed resource, an environment, an app card. Each
 * reads the live run-rate (one request per app, shared by every row of it through the query
 * cache) and shows nothing until the Hub has sampled a figure for it.
 */

const isAdminUser = (u: unknown) => !!(u as { is_admin?: boolean } | null)?.is_admin

export function ResourceCostChip({
  resourceId,
  appId
}: {
  resourceId: number
  /** null = a shared resource (Hub administrators see its figure). */
  appId: number | null
}) {
  const { user } = useAuth()
  const live = useLiveCosts(appId, { enabled: appId != null || isAdminUser(user) })
  const s = resourceSeries(live.data, resourceId)
  if (!s || !live.data) return null
  return (
    <CostChip
      monthlyCents={s.nowCents}
      currency={live.data.currency}
      unknown={s.confidence === 'unknown'}
      free={s.basis === 'free'}
      what='this resource'
    />
  )
}

export function EnvironmentCostChip({ appId, envId }: { appId: number; envId: number }) {
  const live = useLiveCosts(appId)
  const now = environmentNow(live.data, envId)
  if (!now || !live.data) return null
  return (
    <CostChip monthlyCents={now.nowCents} currency={live.data.currency} what='this environment' />
  )
}

/** An app card's chip: from the all-apps answer (one request for the whole list). */
export function AppCostChip({ appId }: { appId: number }) {
  const live = useLiveCosts(null)
  const a = live.data?.byApp.find((x) => x.app_id === appId)
  if (!a || !live.data) return null
  return <CostChip monthlyCents={a.nowCents} currency={live.data.currency} what='this app' />
}
