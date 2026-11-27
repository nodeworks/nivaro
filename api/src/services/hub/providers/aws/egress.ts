import { makeProviderContext } from '../context.js'
import { engineDeps } from '../engine/deps.js'
import { getProvider } from '../registry.js'
import { listResources, openConnectionSecrets, readConnection } from '../store.js'
import type { ProviderContext } from '../types.js'
import { GIB, getMetricData, type MetricQuery } from './cloudwatch.js'

/**
 * Measured data out of an app's AWS resources (Task 44b), for the cost run-rate and the estimate
 * form's traffic prefill. CloudWatch is billed per metric requested, so:
 *
 *  - one batch per connection and region (up to 500 metrics a call),
 *  - at most once an hour per connection (`EGRESS_TTL_MS`), single-flight,
 *  - the answer is cached; a reader never waits on a refresh once a figure exists (it gets the
 *    cached one and a refresh starts in the background); the very first read waits up to
 *    `FIRST_WAIT_MS`.
 *
 * What is read (the last 7 days, a Sum, scaled to a 30-day month, in GiB):
 *   EC2 `NetworkOut` · NAT gateway `BytesOutToDestination` · load balancer `ProcessedBytes` ·
 *   S3 `BytesDownloaded` (only where request metrics are on for the whole bucket, the
 *   `EntireBucket` filter; otherwise CloudWatch has no figure and the bucket counts none).
 *
 * An environment's figure is the LARGEST of three paths — instances plus buckets, NAT gateways,
 * load balancers — because the same traffic often crosses more than one of them; the sum would
 * count it twice. A resource's own figure (`resourceEgress`) is what the run-rate puts on it.
 */

export const EGRESS_TTL_MS = 60 * 60 * 1000
const FIRST_WAIT_MS = 3_000
const WINDOW_DAYS = 7
const MONTH_DAYS = 30
const PERIOD_SECONDS = WINDOW_DAYS * 24 * 3600

interface Snapshot {
  at: number
  /** `${type}|${externalId}` → GiB a month. */
  byResource: Map<string, number>
}

// Hub-only (HUB=on, never a shared deployment): one snapshot per AWS connection.
const snapshots = new Map<number, Snapshot>()
const inflight = new Map<number, Promise<void>>()

/** Tests: forget every snapshot. */
export function resetAwsEgressForTest(): void {
  snapshots.clear()
  inflight.clear()
}

const key = (type: string, externalId: string) => `${type}|${externalId}`

const TYPES = new Set(['aws.ec2_instance', 'aws.nat_gateway', 'aws.load_balancer', 'aws.s3_bucket'])

interface Target {
  type: string
  externalId: string
  region: string
  query: Omit<MetricQuery, 'id'>
}

function queryFor(
  type: string,
  externalId: string,
  fields: Record<string, unknown>
): Omit<MetricQuery, 'id'> | null {
  const base = { stat: 'Sum' as const, periodSeconds: PERIOD_SECONDS }
  if (type === 'aws.ec2_instance')
    return {
      ...base,
      namespace: 'AWS/EC2',
      metric: 'NetworkOut',
      dimensions: [{ name: 'InstanceId', value: externalId }]
    }
  if (type === 'aws.nat_gateway')
    return {
      ...base,
      namespace: 'AWS/NATGateway',
      metric: 'BytesOutToDestination',
      dimensions: [{ name: 'NatGatewayId', value: externalId }]
    }
  if (type === 'aws.load_balancer') {
    const at = externalId.indexOf(':loadbalancer/')
    const lb = at >= 0 ? externalId.slice(at + ':loadbalancer/'.length) : ''
    if (!lb) return null
    return {
      ...base,
      namespace: fields.type === 'network' ? 'AWS/NetworkELB' : 'AWS/ApplicationELB',
      metric: 'ProcessedBytes',
      dimensions: [{ name: 'LoadBalancer', value: lb }]
    }
  }
  if (type === 'aws.s3_bucket')
    return {
      ...base,
      namespace: 'AWS/S3',
      metric: 'BytesDownloaded',
      dimensions: [
        { name: 'BucketName', value: externalId },
        { name: 'FilterId', value: 'EntireBucket' }
      ]
    }
  return null
}

async function targetsOf(connectionId: number): Promise<Target[]> {
  const out: Target[] = []
  for (const r of await listResources({ connectionId, provider: 'aws' })) {
    if (!r.external_id || !TYPES.has(r.type)) continue
    const fields = r.observed?.fields ?? {}
    const region = typeof fields.region === 'string' ? fields.region : ''
    if (!region) continue
    const query = queryFor(r.type, r.external_id, fields)
    if (query) out.push({ type: r.type, externalId: r.external_id, region, query })
  }
  return out
}

async function contextOf(connectionId: number, now: () => Date): Promise<ProviderContext | null> {
  const row = await readConnection(connectionId)
  const adapter = row ? getProvider(row.provider) : null
  if (!row || !adapter || row.provider !== 'aws' || row.status === 'disabled') return null
  const deps = engineDeps()
  return makeProviderContext({
    adapter,
    connectionId,
    config: row.config,
    secrets: await openConnectionSecrets(row),
    region: null,
    now,
    ...(deps.fetch ? { fetch: deps.fetch } : {})
  })
}

/**
 * Reads one connection's measured egress and stores the snapshot. Never throws: a connection
 * that cannot read CloudWatch keeps its old snapshot (or none).
 */
export async function refreshAwsEgress(
  connectionId: number,
  now: Date = new Date()
): Promise<void> {
  try {
    const targets = await targetsOf(connectionId)
    if (!targets.length) {
      snapshots.set(connectionId, { at: now.getTime(), byResource: new Map() })
      return
    }
    const ctx = await contextOf(connectionId, () => now)
    if (!ctx) return
    const byResource = new Map<string, number>()
    const byRegion = new Map<string, Target[]>()
    for (const t of targets) byRegion.set(t.region, [...(byRegion.get(t.region) ?? []), t])
    const end = now
    const start = new Date(now.getTime() - WINDOW_DAYS * 24 * 3600 * 1000)
    for (const [region, list] of byRegion) {
      const queries = list.map((t, i) => ({ id: `m${i}`, ...t.query }))
      let answer: Awaited<ReturnType<typeof getMetricData>>
      try {
        answer = await getMetricData(ctx, region, queries, start, end)
      } catch {
        // No permission or throttled for this region: its resources keep no figure.
        continue
      }
      list.forEach((t, i) => {
        const values = answer.get(`m${i}`)
        if (!values?.length) return
        const bytes = values.reduce((n, v) => n + v, 0)
        byResource.set(key(t.type, t.externalId), (bytes / GIB) * (MONTH_DAYS / WINDOW_DAYS))
      })
    }
    snapshots.set(connectionId, { at: now.getTime(), byResource })
  } catch {
    /* a reader never fails an estimate */
  }
}

/** Starts (or joins) the refresh of a connection; resolves when it is done. */
function refreshOnce(connectionId: number, now: Date): Promise<void> {
  const running = inflight.get(connectionId)
  if (running) return running
  const p = refreshAwsEgress(connectionId, now).finally(() => inflight.delete(connectionId))
  inflight.set(connectionId, p)
  return p
}

/** Makes the snapshot fresh enough: stale ones refresh in the background, a missing one waits briefly. */
async function ensureFresh(connectionId: number, nowMs: number): Promise<void> {
  const snap = snapshots.get(connectionId)
  if (snap && nowMs - snap.at < EGRESS_TTL_MS) return
  const p = refreshOnce(connectionId, new Date(nowMs))
  if (snap) return
  await Promise.race([p, new Promise((resolve) => setTimeout(resolve, FIRST_WAIT_MS).unref?.())])
}

/** The measured figure of one resource (GiB a month), from the cache only; null = none. */
export function awsResourceEgress(
  connectionId: number,
  type: string,
  externalId: string
): number | null {
  const v = snapshots.get(connectionId)?.byResource.get(key(type, externalId))
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
}

/**
 * What the Hub measured going out of each environment of an app (environment id → GiB a month):
 * the seam `configureCostsLive({measuredEgress})` reads. The default of that seam.
 */
export async function awsMeasuredEgress(
  appId: number,
  nowMs = Date.now()
): Promise<Map<number, number>> {
  const out = new Map<number, number>()
  let rows: Awaited<ReturnType<typeof listResources>>
  try {
    rows = (await listResources({ appId, provider: 'aws' })).filter(
      (r) => r.external_id && r.environment_id != null && TYPES.has(r.type)
    )
  } catch {
    return out
  }
  const connections = [...new Set(rows.map((r) => r.connection_id))]
  await Promise.all(connections.map((id) => ensureFresh(id, nowMs).catch(() => undefined)))
  const paths = new Map<number, { compute: number; nat: number; lb: number }>()
  for (const r of rows) {
    const gb = awsResourceEgress(r.connection_id, r.type, r.external_id as string)
    if (gb == null || r.environment_id == null) continue
    const p = paths.get(r.environment_id) ?? { compute: 0, nat: 0, lb: 0 }
    if (r.type === 'aws.ec2_instance' || r.type === 'aws.s3_bucket') p.compute += gb
    else if (r.type === 'aws.nat_gateway') p.nat += gb
    else p.lb += gb
    paths.set(r.environment_id, p)
  }
  for (const [env, p] of paths) {
    const gb = Math.max(p.compute, p.nat, p.lb)
    if (gb > 0) out.set(env, Math.round(gb * 100) / 100)
  }
  return out
}
