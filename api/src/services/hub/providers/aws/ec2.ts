import type { Observed, ProviderContext } from '../types.js'
import { awsQuery, orNull } from './client.js'
import { type AwsListPage, ec2Page } from './kit.js'
import { type XmlObject, type XmlValue, xmlChild, xmlList, xmlText } from './xml.js'

/** EC2 answer reading + the few calls the network and compute types share. */

export const text = (v: XmlValue | undefined) => xmlText(v)
export const flag = (v: XmlValue | undefined) => xmlText(v) === 'true'
export const int = (v: XmlValue | undefined): number | undefined => {
  const t = xmlText(v)
  return t === '' ? undefined : Number(t)
}
export const child = xmlChild
export const items = (v: XmlValue | undefined) => xmlList(v, 'item')

/** `<tagSet><item><key/><value/></item></tagSet>` as a map. */
export function tagsOf(set: XmlValue | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const t of items(set)) {
    const k = text(xmlChild(t, 'key'))
    if (k) out[k] = text(xmlChild(t, 'value'))
  }
  return out
}

/** The first item of a Describe answer, null when AWS says the id does not exist. */
export async function describeOne(
  ctx: ProviderContext,
  action: string,
  setName: string,
  idParam: string,
  id: string,
  region: string,
  extra: Record<string, unknown> = {}
): Promise<XmlValue | null> {
  const r = await orNull(() =>
    awsQuery(ctx, 'ec2', action, { [idParam]: [id], ...extra }, { region })
  )
  return (r && items(r[setName])[0]) || null
}

/** A pageable Describe as an `AwsTypeDef.list`. */
export function describeLister(
  action: string,
  setName: string,
  map: (item: XmlValue, region: string) => Observed | null,
  opts: { paged?: boolean; params?: Record<string, unknown> } = {}
) {
  return async (
    ctx: ProviderContext,
    region: string,
    token: string | null
  ): Promise<AwsListPage> => {
    const params: Record<string, unknown> = { ...opts.params }
    if (opts.paged !== false) {
      params.MaxResults = 100
      if (token) params.NextToken = token
    }
    const r = await awsQuery(ctx, 'ec2', action, params, { region })
    const out: Observed[] = []
    for (const it of items(r[setName])) {
      const o = map(it, region)
      if (o) out.push(o)
    }
    return { items: out, next: opts.paged === false ? null : ec2Page(text(r.nextToken)) }
  }
}

/** CreateTags: the Hub tags + Name on an existing resource (idempotent). */
export async function putTags(
  ctx: ProviderContext,
  region: string,
  id: string,
  tags: Record<string, string>
): Promise<void> {
  const list = Object.entries(tags).map(([Key, Value]) => ({ Key, Value }))
  if (list.length)
    await awsQuery(ctx, 'ec2', 'CreateTags', { ResourceId: [id], Tag: list }, { region })
}

/** A `DescribeX` probe for the permission test (EC2 DryRun: `DryRunOperation` = allowed). */
export const ec2Probe = (action: string) => ({
  need: `ec2:${action}`,
  dryRun: true,
  run: (ctx: ProviderContext, region: string) =>
    awsQuery(ctx, 'ec2', action, { DryRun: true }, { region })
})

export const first = (v: XmlValue | undefined): XmlObject | undefined => {
  const x = Array.isArray(v) ? v[0] : v
  return x && typeof x === 'object' ? (x as XmlObject) : undefined
}

/** `AwsTypeDef.findExisting`: a resource a half-finished create made, by its Hub resource tag. */
export const findByResourceTag =
  (action: string, setName: string, map: (item: XmlValue, region: string) => Observed | null) =>
  async (
    ctx: ProviderContext,
    desired: { tags: Record<string, string> },
    region: string
  ): Promise<Observed | null> => {
    const rid = desired.tags['nivaro-hub:resource']
    if (!rid) return null
    const r = await awsQuery(
      ctx,
      'ec2',
      action,
      { Filter: [{ Name: 'tag:nivaro-hub:resource', Value: [rid] }] },
      { region }
    )
    for (const it of items(r[setName])) {
      const o = map(it, region)
      if (o) return o
    }
    return null
  }
