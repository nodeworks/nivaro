import { db } from '../db/index.js'

/**
 * Workspace usage quotas + counters.
 *
 * Quota limits live as JSON in `nivaro_workspaces.quotas`:
 *   { max_items, max_storage_mb, max_api_requests_per_day, max_users }
 *
 * Usage counters live in `nivaro_usage_counters` (workspace, metric, period, value)
 * with UNIQUE(workspace, metric, period). Cumulative metrics (items, storage_mb,
 * users) use period 'total'; api_requests uses a daily YYYY-MM-DD period.
 */

export interface WorkspaceQuotas {
  max_items?: number | null
  max_storage_mb?: number | null
  max_api_requests_per_day?: number | null
  max_users?: number | null
}

export type QuotaMetric = 'items' | 'storage_mb' | 'api_requests' | 'users'

const METRIC_TO_QUOTA_KEY: Record<QuotaMetric, keyof WorkspaceQuotas> = {
  items: 'max_items',
  storage_mb: 'max_storage_mb',
  api_requests: 'max_api_requests_per_day',
  users: 'max_users'
}

/** Accepts both metric names ('items') and quota keys ('max_items'). */
function normalizeMetric(metric: string): QuotaMetric {
  switch (metric) {
    case 'items':
    case 'max_items':
      return 'items'
    case 'storage_mb':
    case 'max_storage_mb':
      return 'storage_mb'
    case 'api_requests':
    case 'max_api_requests_per_day':
      return 'api_requests'
    case 'users':
    case 'max_users':
      return 'users'
    default:
      return metric as QuotaMetric
  }
}

function periodFor(metric: QuotaMetric): string {
  return metric === 'api_requests' ? new Date().toISOString().slice(0, 10) : 'total'
}

export class QuotaExceededError extends Error {
  /** Picked up by Fastify's default error handler so re-thrown errors return 429. */
  statusCode = 429

  constructor(
    public metric: string,
    public current: number,
    public limit: number
  ) {
    super(`Workspace quota exceeded for ${metric} (${current}/${limit})`)
    this.name = 'QuotaExceededError'
  }
}

export async function getQuotas(workspaceId: string): Promise<WorkspaceQuotas> {
  try {
    const row = (await db('nivaro_workspaces')
      .where({ id: workspaceId })
      .select('quotas')
      .first()) as { quotas: string | null } | undefined
    if (!row?.quotas) return {}
    return (JSON.parse(row.quotas) as WorkspaceQuotas) ?? {}
  } catch {
    // Missing column / malformed JSON — treat as unlimited.
    return {}
  }
}

/**
 * Upsert-increment a usage counter. UNIQUE(workspace, metric, period) makes the
 * insert race-safe: a concurrent insert loses and we fall back to increment.
 */
export async function incrementUsage(workspaceId: string, metric: string, by = 1): Promise<void> {
  const m = normalizeMetric(metric)
  const period = periodFor(m)
  const where = { workspace: workspaceId, metric: m, period }

  const updated = await db('nivaro_usage_counters').where(where).increment('value', by)
  if (updated > 0) return

  try {
    await db('nivaro_usage_counters').insert({ ...where, value: by })
  } catch {
    // Lost the insert race — the row exists now, increment it.
    await db('nivaro_usage_counters').where(where).increment('value', by)
  }
}

export async function checkQuota(
  workspaceId: string,
  metric: string
): Promise<{ allowed: boolean; current: number; limit: number | null }> {
  const m = normalizeMetric(metric)
  const quotas = await getQuotas(workspaceId)
  const rawLimit = quotas[METRIC_TO_QUOTA_KEY[m]]
  const limit = rawLimit != null && Number(rawLimit) > 0 ? Number(rawLimit) : null

  let current = 0
  try {
    const row = (await db('nivaro_usage_counters')
      .where({ workspace: workspaceId, metric: m, period: periodFor(m) })
      .select('value')
      .first()) as { value: number | string } | undefined
    current = Number(row?.value ?? 0)
  } catch {
    current = 0
  }

  if (limit === null) return { allowed: true, current, limit: null }
  return { allowed: current < limit, current, limit }
}

/** Full usage report for a workspace — all metrics with current value vs limit. */
export async function getUsage(
  workspaceId: string
): Promise<Array<{ metric: QuotaMetric; current: number; limit: number | null; period: string }>> {
  const metrics: QuotaMetric[] = ['items', 'storage_mb', 'api_requests', 'users']
  const out: Array<{ metric: QuotaMetric; current: number; limit: number | null; period: string }> =
    []
  for (const m of metrics) {
    const { current, limit } = await checkQuota(workspaceId, m)
    out.push({ metric: m, current, limit, period: periodFor(m) })
  }
  return out
}
