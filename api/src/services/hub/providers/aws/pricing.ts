import { awsSkuKey } from '../pricing/aws-price-list.js'
import {
  estimateOf,
  freeEstimate,
  type PriceLookupAnswer,
  priceLookup,
  unknownEstimate
} from '../pricing/index.js'
import type {
  BundledPriceTable,
  CostEstimate,
  CostLine,
  DesiredResource,
  EstimateTraffic,
  Observed,
  ProviderContext
} from '../types.js'
import { awsBucketSizeGb } from './cloudwatch.js'

/**
 * AWS cost estimates (Task 44b). List prices from the Price List Query API (`GetProducts`, through
 * the price book: 7-day cache, then the dated bundled table below, never a throw). Each costed
 * `aws.*` type calls one function here from its `estimate`. Rules:
 *
 *  - `estimate(ctx, desired, observed)` with a desired resource = what it will cost; with
 *    `desired: null` = what the observed resource costs NOW (the before figure, the delete saving).
 *  - A month is 730 hours (AWS's own convention for its monthly figures).
 *  - Data transfer is a separate `transfer` line from `ctx.traffic` (the form's figure or the
 *    measured one); with no traffic nothing is assumed and the note says "plus data transfer".
 *  - Tax and discount lines are the engine's, never added here.
 *  - A price AWS does not list for the region, or an unknown type value, is `unknown`.
 *
 * Filters follow the Price List attribute names (`instanceType`, `volumeApiName`, `groupDescription`
 * …). They are recorded in the sku keys below, the only place a correction touches.
 */

export const HOURS_PER_MONTH = 730
export const AWS_PRICES_AS_OF = '2026-11-26'

// ── Sku keys ──

export const EC2 = 'AmazonEC2'

export const ec2Sku = (instanceType: string) =>
  awsSkuKey(EC2, {
    capacitystatus: 'Used',
    instanceType,
    operatingSystem: 'Linux',
    preInstalledSw: 'NA',
    productFamily: 'Compute Instance',
    tenancy: 'Shared'
  })

export const ebsStorageSku = (volumeApiName: string) =>
  awsSkuKey(EC2, { productFamily: 'Storage', volumeApiName })

export const ebsIopsSku = (volumeApiName: string) =>
  awsSkuKey(EC2, { group: 'EBS IOPS', productFamily: 'System Operation', volumeApiName })

export const ebsThroughputSku = (volumeApiName: string) =>
  awsSkuKey(EC2, {
    group: 'EBS Throughput',
    productFamily: 'Provisioned Throughput',
    volumeApiName
  })

export const NAT_HOURS_SKU = awsSkuKey(EC2, {
  group: 'NGW:NatGateway',
  groupDescription: 'Hourly charge for NAT Gateways',
  productFamily: 'NAT Gateway'
})

export const NAT_GB_SKU = awsSkuKey(EC2, {
  group: 'NGW:NatGateway',
  groupDescription: 'Charge for per GB data processed by NAT Gateways',
  productFamily: 'NAT Gateway'
})

export const EIP_SKU = awsSkuKey('AmazonVPC', { group: 'VPCPublicIPv4Address' })

export const rdsInstanceSku = (instanceType: string, engine: string, deployment: string) =>
  awsSkuKey('AmazonRDS', {
    databaseEngine: engine,
    deploymentOption: deployment,
    instanceType,
    productFamily: 'Database Instance'
  })

export const rdsStorageSku = (volumeType: string, engine: string, deployment: string) =>
  awsSkuKey('AmazonRDS', {
    databaseEngine: engine,
    deploymentOption: deployment,
    productFamily: 'Database Storage',
    volumeType
  })

export const lbHoursSku = (network: boolean) =>
  awsSkuKey('AWSELB', {
    groupDescription: network
      ? 'LoadBalancer hourly usage by Network Load Balancer'
      : 'LoadBalancer hourly usage by Application Load Balancer',
    productFamily: network ? 'Load Balancer-Network' : 'Load Balancer-Application'
  })

export const S3_STORAGE_SKU = awsSkuKey('AmazonS3', {
  productFamily: 'Storage',
  volumeType: 'Standard'
})

export const ROUTE53_ZONE_SKU = awsSkuKey('AmazonRoute53', {
  location: 'Global',
  productFamily: 'DNS Zone'
})

/** Data transfer out to the internet, tier 0..4 (the answer's price dimensions by start range). */
export const transferOutSku = (region: string, tier: number) =>
  awsSkuKey('AWSDataTransfer', {
    fromRegionCode: region,
    productFamily: 'Data Transfer',
    tierIndex: String(tier),
    toLocation: 'External',
    transferType: 'AWS Outbound'
  })

/** Data moved between availability zones of a region (billed in each direction). */
export const crossAzSku = (region: string) =>
  awsSkuKey('AWSDataTransfer', {
    fromRegionCode: region,
    productFamily: 'Data Transfer',
    transferType: 'IntraRegion'
  })

/**
 * Internet-out tier ends in GB a month (100 free, then 10 TB, 50 TB, 150 TB, then the rest). AWS
 * has held these steps for years; the PRICE of each tier is read from the price list.
 */
export const TRANSFER_OUT_TIERS_GB = [100, 10_240, 51_200, 153_600, Number.POSITIVE_INFINITY]

// ── The bundled snapshot (us-east-1 list prices, the fallback when the price API cannot be read) ──

const east = (unit: string, unitCents: number, label?: string) => ({
  unit,
  unitCents,
  regions: { 'us-east-1': unitCents },
  regionsOnly: true,
  ...(label ? { label } : {})
})

const E = 'us-east-1'

/** Dated list prices copied from aws.amazon.com/pricing; a region not listed here has no bundled price. */
export const AWS_BUNDLED_PRICES: BundledPriceTable = {
  asOf: AWS_PRICES_AS_OF,
  currency: 'USD',
  items: {
    [ec2Sku('t3.micro')]: east('Hrs', 1.04),
    [ec2Sku('t3.small')]: east('Hrs', 2.08),
    [ec2Sku('t3.medium')]: east('Hrs', 4.16),
    [ec2Sku('t3.large')]: east('Hrs', 8.32),
    [ec2Sku('m5.large')]: east('Hrs', 9.6),
    [ec2Sku('m6i.large')]: east('Hrs', 9.6),
    [ec2Sku('c5.large')]: east('Hrs', 8.5),
    [ebsStorageSku('gp3')]: east('GB-Mo', 8),
    [ebsStorageSku('gp2')]: east('GB-Mo', 10),
    [ebsStorageSku('io2')]: east('GB-Mo', 12.5),
    [ebsStorageSku('io1')]: east('GB-Mo', 12.5),
    [ebsStorageSku('st1')]: east('GB-Mo', 4.5),
    [ebsStorageSku('sc1')]: east('GB-Mo', 1.5),
    [ebsIopsSku('gp3')]: east('IOPS-Mo', 0.5),
    [ebsIopsSku('io2')]: east('IOPS-Mo', 6.5),
    [ebsIopsSku('io1')]: east('IOPS-Mo', 6.5),
    [ebsThroughputSku('gp3')]: east('GiBps-mo', 4096),
    [NAT_HOURS_SKU]: east('Hrs', 4.5),
    [NAT_GB_SKU]: east('GB', 4.5),
    [EIP_SKU]: east('Hrs', 0.5),
    [rdsInstanceSku('db.t3.micro', 'PostgreSQL', 'Single-AZ')]: east('Hrs', 1.7),
    [rdsInstanceSku('db.t3.small', 'PostgreSQL', 'Single-AZ')]: east('Hrs', 3.4),
    [rdsInstanceSku('db.t3.medium', 'PostgreSQL', 'Single-AZ')]: east('Hrs', 6.8),
    [rdsStorageSku('General Purpose-GP3', 'PostgreSQL', 'Single-AZ')]: east('GB-Mo', 11.5),
    [rdsStorageSku('General Purpose', 'PostgreSQL', 'Single-AZ')]: east('GB-Mo', 11.5),
    [lbHoursSku(false)]: east('Hrs', 2.25),
    [lbHoursSku(true)]: east('Hrs', 2.25),
    [S3_STORAGE_SKU]: east('GB-Mo', 2.3),
    [ROUTE53_ZONE_SKU]: { unit: 'Hosted Zone/Month', unitCents: 50 },
    [transferOutSku(E, 0)]: east('GB', 0),
    [transferOutSku(E, 1)]: east('GB', 9),
    [transferOutSku(E, 2)]: east('GB', 8.5),
    [transferOutSku(E, 3)]: east('GB', 7),
    [transferOutSku(E, 4)]: east('GB', 5),
    [crossAzSku(E)]: east('GB', 1)
  }
}

// ── Helpers ──

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '')
const num = (v: unknown): number | null => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}
const REGION_RE = /^[a-z]{2}(-[a-z]+)+-\d$/

/** The fields an estimate reads: the desired ones, or (a delete / "costs now") the observed ones. */
export function fieldsOf(
  desired: DesiredResource | null,
  observed: Observed | null
): Record<string, unknown> | null {
  if (desired) return { ...(observed?.fields ?? {}), ...desired.fields }
  return observed?.fields ?? null
}

/** The region of a resource: its own field, else the context's. null when neither is a region. */
export function regionOf(
  ctx: ProviderContext,
  fields: Record<string, unknown> | null
): string | null {
  const r = str(fields?.region) || str(ctx.region)
  return REGION_RE.test(r) ? r : null
}

/** Never throws: any failure inside an estimate is "No estimate". */
export async function safeEstimate(fn: () => Promise<CostEstimate>): Promise<CostEstimate> {
  try {
    return await fn()
  } catch {
    return unknownEstimate('The price could not be worked out.')
  }
}

const price = (ctx: ProviderContext, sku: string, region: string | null) =>
  priceLookup(ctx, 'aws', sku, region)

/** Convert a price answer to cents per base unit the line uses (GiBps → MiBps). */
const perUnit = (p: PriceLookupAnswer, unitDivisor = 1) => p.unitCents / unitDivisor

const older = (a: string | null, b: string | null): string | null =>
  a && b ? (a < b ? a : b) : (a ?? b)

/** One sentence when a figure came from the bundled table, not AWS's live list. */
function sourceNote(ps: Array<PriceLookupAnswer | null>): string | null {
  const b = ps.find((p) => p?.source === 'bundled')
  return b
    ? `Prices are the Hub's bundled list of ${b.asOf ?? 'an earlier date'} (AWS's live list was not read).`
    : null
}

const join = (...parts: Array<string | null | undefined | false>): string | undefined => {
  const s = parts.filter((p): p is string => !!p).join(' ')
  return s || undefined
}

const gbLabel = (n: number) => `${Math.round(n * 1000) / 1000}`

// ── Data transfer ──

/**
 * Internet-out lines for `gb` GB a month in a region, one line per paid tier (the first 100 GB a
 * month are free and AWS pools them per account, so a per-resource estimate may count them more
 * than once). null = a tier price could not be found (the caller says so and leaves the line out).
 */
export async function internetOutLines(
  ctx: ProviderContext,
  region: string,
  traffic: EstimateTraffic | undefined,
  label = 'Data transfer out to the internet'
): Promise<{ lines: CostLine[]; asOf: string | null; bundled: PriceLookupAnswer | null } | null> {
  if (!traffic || !(traffic.egressGbMonth > 0)) return { lines: [], asOf: null, bundled: null }
  const source = traffic.source === 'measured' ? 'measured' : 'assumed'
  const lines: CostLine[] = []
  let asOf: string | null = null
  let bundled: PriceLookupAnswer | null = null
  let from = 0
  for (let i = 0; i < TRANSFER_OUT_TIERS_GB.length; i++) {
    const to = TRANSFER_OUT_TIERS_GB[i]
    if (traffic.egressGbMonth <= from) break
    const used = Math.min(traffic.egressGbMonth, to) - from
    from = to
    const p = await price(ctx, transferOutSku(region, i), region)
    if (!p) return null
    asOf = older(asOf, p.asOf)
    if (p.source === 'bundled') bundled = p
    if (p.unitCents > 0 && used > 0)
      lines.push({
        label: `${label} (tier ${i + 1})`,
        qty: Math.round(used * 1000) / 1000,
        unit: 'GB',
        unitCents: p.unitCents,
        monthlyCents: Math.round(used * p.unitCents),
        kind: 'transfer',
        source
      })
  }
  return { lines, asOf, bundled }
}

/**
 * Cross-AZ data: AWS bills each direction, so a GB that crosses a zone costs the listed price
 * twice. `gb` is the amount that crosses.
 */
export async function crossAzLines(
  ctx: ProviderContext,
  region: string,
  traffic: EstimateTraffic | undefined,
  label = 'Data between availability zones'
): Promise<{ lines: CostLine[]; asOf: string | null; bundled: PriceLookupAnswer | null } | null> {
  if (!traffic || !(traffic.egressGbMonth > 0)) return { lines: [], asOf: null, bundled: null }
  const p = await price(ctx, crossAzSku(region), region)
  if (!p) return null
  const both = p.unitCents * 2
  return {
    lines: [
      {
        label: `${label} (both directions)`,
        qty: Math.round(traffic.egressGbMonth * 1000) / 1000,
        unit: 'GB',
        unitCents: both,
        monthlyCents: Math.round(traffic.egressGbMonth * both),
        kind: 'transfer',
        source: traffic.source === 'measured' ? 'measured' : 'assumed'
      }
    ],
    asOf: p.asOf,
    bundled: p.source === 'bundled' ? p : null
  }
}

const noTransfer = 'No data transfer is assumed.'

// ── aws.ec2_instance ──

export function ec2Estimate(
  ctx: ProviderContext,
  desired: DesiredResource | null,
  observed: Observed | null
): Promise<CostEstimate> {
  return safeEstimate(async () => {
    const f = fieldsOf(desired, observed)
    const type = str(f?.instance_type)
    const region = regionOf(ctx, f)
    if (!type || !region)
      return unknownEstimate('Pick an instance type and a region to see a price.')
    // A stopped instance bills no compute (its disks stay on their own volume lines).
    const stopped = !desired && observed?.status === 'stopped'
    const p = stopped ? null : await price(ctx, ec2Sku(type), region)
    if (!stopped && !p) return unknownEstimate(`AWS lists no price for ${type} in ${region}.`)
    const out = await internetOutLines(ctx, region, ctx.traffic)
    const lines: CostLine[] = []
    if (p)
      lines.push({
        label: `EC2 ${type} (Linux, on-demand)`,
        qty: HOURS_PER_MONTH,
        unit: 'hour',
        unitCents: perUnit(p),
        monthlyCents: Math.round(HOURS_PER_MONTH * perUnit(p)),
        kind: 'base',
        source: 'price_list'
      })
    if (out) lines.push(...out.lines)
    return estimateOf({
      basis: 'price_list',
      confidence: 'list_price',
      lines,
      priceAsOf: older(p?.asOf ?? null, out?.asOf ?? null),
      note: join(
        stopped && 'Stopped: no compute is billed.',
        'Linux on-demand list price for a 730-hour month; its disks are billed on their own volumes.',
        !ctx.traffic && 'Data transfer out is extra; none is assumed.',
        out === null && 'The data transfer price could not be read, so that line is left out.',
        sourceNote([p, out?.bundled ?? null])
      )
    })
  })
}

// ── aws.ebs_volume ──

const GIBPS = /gibps/i

export function ebsEstimate(
  ctx: ProviderContext,
  desired: DesiredResource | null,
  observed: Observed | null
): Promise<CostEstimate> {
  return safeEstimate(async () => {
    const f = fieldsOf(desired, observed)
    const region = regionOf(ctx, f)
    const size = num(f?.size_gb)
    const type = str(f?.volume_type) || 'gp3'
    if (!region || size == null || size <= 0)
      return unknownEstimate('Set a size and a region to see a price.')
    const storage = await price(ctx, ebsStorageSku(type), region)
    if (!storage) return unknownEstimate(`AWS lists no ${type} storage price in ${region}.`)
    const lines: CostLine[] = [
      {
        label: `EBS ${type} storage`,
        qty: size,
        unit: 'GB-month',
        unitCents: storage.unitCents,
        monthlyCents: Math.round(size * storage.unitCents),
        kind: 'base',
        source: 'price_list'
      }
    ]
    const ps: Array<PriceLookupAnswer | null> = [storage]
    let asOf = storage.asOf
    const iops = num(f?.iops)
    const throughput = num(f?.throughput)
    const extras: Array<{ qty: number; sku: string; label: string; divisor?: boolean }> = []
    if (type === 'gp3') {
      if (iops != null && iops > 3000)
        extras.push({ qty: iops - 3000, sku: ebsIopsSku('gp3'), label: 'gp3 IOPS above 3,000' })
      if (throughput != null && throughput > 125)
        extras.push({
          qty: throughput - 125,
          sku: ebsThroughputSku('gp3'),
          label: 'gp3 throughput above 125 MiB/s',
          divisor: true
        })
    } else if ((type === 'io1' || type === 'io2') && iops != null && iops > 0)
      extras.push({ qty: iops, sku: ebsIopsSku(type), label: `${type} provisioned IOPS` })
    let incomplete = false
    for (const e of extras) {
      const p = await price(ctx, e.sku, region)
      if (!p) {
        incomplete = true
        continue
      }
      ps.push(p)
      asOf = older(asOf, p.asOf)
      // The throughput price is listed per GiBps-month; the field is in MiB/s.
      const unitCents = e.divisor && GIBPS.test(p.unit) ? p.unitCents / 1024 : p.unitCents
      lines.push({
        label: e.label,
        qty: e.qty,
        unit: e.divisor ? 'MiB/s-month' : 'IOPS-month',
        unitCents,
        monthlyCents: Math.round(e.qty * unitCents),
        kind: 'base',
        source: 'price_list'
      })
    }
    return estimateOf({
      basis: 'price_list',
      confidence: 'list_price',
      lines,
      priceAsOf: asOf,
      note: join(
        incomplete && 'A provisioned IOPS or throughput price could not be read and is left out.',
        type === 'io2' && 'io2 IOPS uses the first price tier.',
        'Snapshots are billed separately.',
        sourceNote(ps)
      )
    })
  })
}

// ── aws.nat_gateway ──

export function natEstimate(
  ctx: ProviderContext,
  desired: DesiredResource | null,
  observed: Observed | null
): Promise<CostEstimate> {
  return safeEstimate(async () => {
    const f = fieldsOf(desired, observed)
    const region = regionOf(ctx, f)
    if (!region) return unknownEstimate('Pick a region to see a price.')
    const hours = await price(ctx, NAT_HOURS_SKU, region)
    if (!hours) return unknownEstimate(`AWS lists no NAT gateway price in ${region}.`)
    const lines: CostLine[] = [
      {
        label: 'NAT gateway',
        qty: HOURS_PER_MONTH,
        unit: 'hour',
        unitCents: hours.unitCents,
        monthlyCents: Math.round(HOURS_PER_MONTH * hours.unitCents),
        kind: 'base',
        source: 'price_list'
      }
    ]
    const ps: Array<PriceLookupAnswer | null> = [hours]
    let asOf = hours.asOf
    let gbMissing = false
    const traffic = ctx.traffic
    const gbPrice = await price(ctx, NAT_GB_SKU, region)
    if (traffic && traffic.egressGbMonth > 0) {
      if (gbPrice) {
        ps.push(gbPrice)
        asOf = older(asOf, gbPrice.asOf)
        lines.push({
          label: 'Data processed by the NAT gateway',
          qty: Math.round(traffic.egressGbMonth * 1000) / 1000,
          unit: 'GB',
          unitCents: gbPrice.unitCents,
          monthlyCents: Math.round(traffic.egressGbMonth * gbPrice.unitCents),
          kind: 'transfer',
          source: traffic.source === 'measured' ? 'measured' : 'assumed'
        })
      } else gbMissing = true
    }
    const perGb = gbPrice ? ` (${gbLabel(gbPrice.unitCents / 100)} dollars per GB)` : ''
    return estimateOf({
      basis: 'price_list',
      confidence: 'usage_varies',
      lines,
      priceAsOf: asOf,
      note: join(
        traffic && traffic.egressGbMonth > 0
          ? 'Data processed is counted from the traffic figure; data out to the internet is billed on the instances behind it.'
          : `Plus data processed${perGb}; ${noTransfer.toLowerCase()}`,
        gbMissing && 'The data processed price could not be read, so that line is left out.',
        sourceNote(ps)
      )
    })
  })
}

// ── aws.elastic_ip ──

export function eipEstimate(
  ctx: ProviderContext,
  desired: DesiredResource | null,
  observed: Observed | null
): Promise<CostEstimate> {
  return safeEstimate(async () => {
    const f = fieldsOf(desired, observed)
    const region = regionOf(ctx, f)
    if (!region) return unknownEstimate('Pick a region to see a price.')
    const p = await price(ctx, EIP_SKU, region)
    if (!p) return unknownEstimate(`AWS lists no public IPv4 price in ${region}.`)
    return estimateOf({
      basis: 'price_list',
      confidence: 'list_price',
      lines: [
        {
          label: 'Public IPv4 address',
          qty: HOURS_PER_MONTH,
          unit: 'hour',
          unitCents: p.unitCents,
          monthlyCents: Math.round(HOURS_PER_MONTH * p.unitCents),
          kind: 'base',
          source: 'price_list'
        }
      ],
      priceAsOf: p.asOf,
      note: join('Billed in use or idle.', sourceNote([p]))
    })
  })
}

// ── aws.rds_instance ──

const RDS_ENGINES: Record<string, string> = {
  postgres: 'PostgreSQL',
  mysql: 'MySQL',
  mariadb: 'MariaDB'
}
const RDS_VOLUMES: Record<string, string> = {
  gp3: 'General Purpose-GP3',
  gp2: 'General Purpose',
  io1: 'Provisioned IOPS'
}

export function rdsEstimate(
  ctx: ProviderContext,
  desired: DesiredResource | null,
  observed: Observed | null
): Promise<CostEstimate> {
  return safeEstimate(async () => {
    const f = fieldsOf(desired, observed)
    const region = regionOf(ctx, f)
    const cls = str(f?.instance_class)
    const rawEngine = str(f?.engine).toLowerCase()
    const engine = RDS_ENGINES[rawEngine]
    if (!region || !cls)
      return unknownEstimate('Pick an instance class and a region to see a price.')
    if (!engine)
      return unknownEstimate(
        `The Hub prices PostgreSQL, MySQL and MariaDB; ${rawEngine || 'this engine'} depends on a licence.`
      )
    const deployment = f?.multi_az === true ? 'Multi-AZ' : 'Single-AZ'
    const inst = await price(ctx, rdsInstanceSku(cls, engine, deployment), region)
    if (!inst) return unknownEstimate(`AWS lists no ${cls} ${engine} price in ${region}.`)
    const lines: CostLine[] = [
      {
        label: `RDS ${cls} ${engine} (${deployment})`,
        qty: HOURS_PER_MONTH,
        unit: 'hour',
        unitCents: inst.unitCents,
        monthlyCents: Math.round(HOURS_PER_MONTH * inst.unitCents),
        kind: 'base',
        source: 'price_list'
      }
    ]
    const ps: Array<PriceLookupAnswer | null> = [inst]
    let asOf = inst.asOf
    let storageMissing = false
    const gb = num(f?.allocated_storage_gb)
    const volume = RDS_VOLUMES[str(f?.storage_type) || 'gp3']
    if (gb != null && gb > 0) {
      const s = volume ? await price(ctx, rdsStorageSku(volume, engine, deployment), region) : null
      if (s) {
        ps.push(s)
        asOf = older(asOf, s.asOf)
        lines.push({
          label: `Storage (${str(f?.storage_type) || 'gp3'})`,
          qty: gb,
          unit: 'GB-month',
          unitCents: s.unitCents,
          monthlyCents: Math.round(gb * s.unitCents),
          kind: 'base',
          source: 'price_list'
        })
      } else storageMissing = true
    }
    return estimateOf({
      basis: 'price_list',
      confidence: 'list_price',
      lines,
      priceAsOf: asOf,
      note: join(
        storageMissing && 'The storage price could not be read, so that line is left out.',
        str(f?.storage_type) === 'io1' && 'Provisioned IOPS are not counted.',
        'Backups beyond the free allowance and data transfer are extra.',
        sourceNote(ps)
      )
    })
  })
}

// ── aws.load_balancer ──

export function lbEstimate(
  ctx: ProviderContext,
  desired: DesiredResource | null,
  observed: Observed | null
): Promise<CostEstimate> {
  return safeEstimate(async () => {
    const f = fieldsOf(desired, observed)
    const region = regionOf(ctx, f)
    if (!region) return unknownEstimate('Pick a region to see a price.')
    const kind = str(f?.type) === 'network' ? 'network' : 'application'
    const hours = await price(ctx, lbHoursSku(kind === 'network'), region)
    if (!hours) return unknownEstimate(`AWS lists no ${kind} load balancer price in ${region}.`)
    const lines: CostLine[] = [
      {
        label: `${kind === 'network' ? 'Network' : 'Application'} load balancer`,
        qty: HOURS_PER_MONTH,
        unit: 'hour',
        unitCents: hours.unitCents,
        monthlyCents: Math.round(HOURS_PER_MONTH * hours.unitCents),
        kind: 'base',
        source: 'price_list'
      }
    ]
    let asOf = hours.asOf
    let bundled: PriceLookupAnswer | null = hours.source === 'bundled' ? hours : null
    let skipped = false
    // A network load balancer's cross-zone traffic is billed as data between zones; an
    // application load balancer's is not. Worst case: every GB crosses.
    if (kind === 'network' && ctx.traffic && ctx.traffic.egressGbMonth > 0) {
      const az = await crossAzLines(
        ctx,
        region,
        ctx.traffic,
        'Cross-zone data (worst case: all traffic crosses)'
      )
      if (az) {
        lines.push(...az.lines)
        asOf = older(asOf, az.asOf)
        bundled = bundled ?? az.bundled
      } else skipped = true
    }
    return estimateOf({
      basis: 'price_list',
      confidence: 'usage_varies',
      lines,
      priceAsOf: asOf,
      note: join(
        'Plus load balancer capacity units (LCU) by use; the hourly charge is the fixed part.',
        skipped && 'The cross-zone data price could not be read, so that line is left out.',
        sourceNote([hours, bundled])
      )
    })
  })
}

// ── aws.s3_bucket ──

export function s3Estimate(
  ctx: ProviderContext,
  desired: DesiredResource | null,
  observed: Observed | null
): Promise<CostEstimate> {
  return safeEstimate(async () => {
    const f = fieldsOf(desired, observed)
    const region = regionOf(ctx, f)
    if (!region) return unknownEstimate('Pick a region to see a price.')
    const bucket = str(observed?.externalId) || str(f?.name)
    const unit = await price(ctx, S3_STORAGE_SKU, region)
    // The stored size is CloudWatch's `BucketSizeBytes` (a daily figure); a bucket that is not
    // made yet has none.
    const sizeGb =
      observed?.externalId && bucket ? await awsBucketSizeGb(ctx, region, bucket) : null
    const lines: CostLine[] = []
    const ps: Array<PriceLookupAnswer | null> = [unit]
    let asOf = unit?.asOf ?? null
    if (unit && sizeGb != null)
      lines.push({
        label: 'S3 Standard storage',
        qty: Math.round(sizeGb * 1000) / 1000,
        unit: 'GB-month',
        unitCents: unit.unitCents,
        monthlyCents: Math.round(sizeGb * unit.unitCents),
        kind: 'base',
        source: 'measured'
      })
    const out = await internetOutLines(ctx, region, ctx.traffic, 'Data transfer out of S3')
    if (out) {
      lines.push(...out.lines)
      asOf = older(asOf, out.asOf)
      ps.push(out.bundled)
    }
    const perGb = unit
      ? ` (${gbLabel(unit.unitCents / 100)} dollars per GB-month for the first tier)`
      : ''
    return estimateOf({
      basis: 'usage',
      confidence: 'usage_varies',
      lines,
      priceAsOf: asOf,
      note: join(
        unit == null && 'The storage price could not be read.',
        sizeGb == null
          ? `Billed by use: storage${perGb}, requests and data out. Nothing is counted until the bucket's size is read.`
          : 'Storage is the bucket size CloudWatch reports; requests and lifecycle charges are extra.',
        out === null && 'The data transfer price could not be read, so that line is left out.',
        sourceNote(ps)
      )
    })
  })
}

// ── aws.route53_zone ──

export function route53Estimate(
  ctx: ProviderContext,
  _desired: DesiredResource | null,
  _observed: Observed | null
): Promise<CostEstimate> {
  return safeEstimate(async () => {
    const p = await price(ctx, ROUTE53_ZONE_SKU, null)
    if (!p) return unknownEstimate('AWS lists no hosted zone price.')
    return estimateOf({
      basis: 'price_list',
      confidence: 'usage_varies',
      lines: [
        {
          label: 'Hosted zone',
          qty: 1,
          unit: 'zone-month',
          unitCents: p.unitCents,
          monthlyCents: Math.round(p.unitCents),
          kind: 'base',
          source: 'price_list'
        }
      ],
      priceAsOf: p.asOf,
      note: join(
        'The first 25 zones cost this; later ones are cheaper. Plus DNS queries by use.',
        sourceNote([p])
      )
    })
  })
}

// ── aws.acm_certificate ──

export function acmEstimate(): Promise<CostEstimate> {
  return Promise.resolve(freeEstimate('Public certificates from ACM are free.'))
}
