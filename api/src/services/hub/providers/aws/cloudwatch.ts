import type { ProviderContext } from '../types.js'
import { awsQuery } from './client.js'
import { xmlChild, xmlList, xmlText } from './xml.js'

/**
 * A small CloudWatch reader (`GetMetricData`, the Query API) for two things the cost estimates
 * need: what a resource sent out (measured egress, egress.ts) and how big an S3 bucket is
 * (`BucketSizeBytes`). AWS bills CloudWatch by the metric requested, so callers batch up to 500
 * metrics in one request, per region, and cache (egress.ts keeps an hour). Never throws from the
 * convenience readers: a missing permission or a throttle is "no figure".
 */

export const GIB = 1024 ** 3
/** GetMetricData takes at most 500 metric queries per call. */
export const MAX_QUERIES = 500

export interface MetricQuery {
  /** Caller's id (letters, digits, underscore; starts with a lowercase letter). */
  id: string
  namespace: string
  metric: string
  dimensions: Array<{ name: string; value: string }>
  stat: 'Sum' | 'Average' | 'Maximum'
  periodSeconds: number
}

/** Each query's datapoints (the values CloudWatch returned, oldest to newest or as sent). */
export type MetricAnswer = Map<string, number[]>

const ID_RE = /^[a-z][A-Za-z0-9_]{0,254}$/

/** One batched GetMetricData over [start, end]; answers each query's values (missing = none). */
export async function getMetricData(
  ctx: ProviderContext,
  region: string,
  queries: readonly MetricQuery[],
  start: Date,
  end: Date
): Promise<MetricAnswer> {
  const out: MetricAnswer = new Map()
  for (let i = 0; i < queries.length; i += MAX_QUERIES) {
    const batch = queries.slice(i, i + MAX_QUERIES)
    for (const q of batch) if (!ID_RE.test(q.id)) throw new Error(`Bad metric query id ${q.id}.`)
    const r = await awsQuery(
      ctx,
      'monitoring',
      'GetMetricData',
      {
        StartTime: start.toISOString(),
        EndTime: end.toISOString(),
        ScanBy: 'TimestampAscending',
        MetricDataQueries: batch.map((q) => ({
          Id: q.id,
          MetricStat: {
            Metric: {
              Namespace: q.namespace,
              MetricName: q.metric,
              Dimensions: q.dimensions.map((d) => ({ Name: d.name, Value: d.value }))
            },
            Period: q.periodSeconds,
            Stat: q.stat
          },
          ReturnData: true
        }))
      },
      { region }
    )
    for (const res of xmlList(xmlChild(r, 'MetricDataResults'), 'member')) {
      const id = xmlText(xmlChild(res, 'Id'))
      if (!id) continue
      const values = xmlList(xmlChild(res, 'Values'), 'member')
        .map((v) => Number(xmlText(v)))
        .filter((n) => Number.isFinite(n))
      out.set(id, [...(out.get(id) ?? []), ...values])
    }
  }
  return out
}

/**
 * The size of an S3 bucket in GB (Standard storage), from the newest daily `BucketSizeBytes`.
 * null = no figure (no permission, no data yet, throttled). Never throws.
 */
export async function awsBucketSizeGb(
  ctx: ProviderContext,
  region: string,
  bucket: string
): Promise<number | null> {
  try {
    const end = ctx.now()
    const start = new Date(end.getTime() - 3 * 24 * 3600 * 1000)
    const answer = await getMetricData(
      ctx,
      region,
      [
        {
          id: 'size',
          namespace: 'AWS/S3',
          metric: 'BucketSizeBytes',
          dimensions: [
            { name: 'BucketName', value: bucket },
            { name: 'StorageType', value: 'StandardStorage' }
          ],
          stat: 'Average',
          periodSeconds: 86_400
        }
      ],
      start,
      end
    )
    const v = answer.get('size') ?? []
    return v.length ? v[v.length - 1] / GIB : null
  } catch {
    return null
  }
}
