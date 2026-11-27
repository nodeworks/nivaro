import { awsRest, restXml } from '../aws/client.js'
import { normName, type RecordSet, recordXml, route53ZoneDef } from '../aws/route53.js'
import { xmlChild, xmlList, xmlText } from '../aws/xml.js'
import {
  createDnsRecord,
  deleteDnsRecord,
  findDnsRecords,
  requireZone
} from '../cloudflare/index.js'
import { makeProviderContext } from '../context.js'
import { engineDeps } from '../engine/deps.js'
import { getProvider } from '../registry.js'
import { openConnectionSecrets, readConnection } from '../store.js'
import { type ProviderContext, ProviderError } from '../types.js'
import { dnsConnectionId } from './client.js'

/**
 * DNS-01 solvers (Task 38): the `_acme-challenge` TXT records a certificate order needs, made and
 * removed through the connection's ONE DNS connection (Cloudflare or AWS Route 53, both merged).
 *
 * Why the DNS connection is a connection setting and not a `ref` on the certificate: the engine
 * only lets a resource point at another resource on its OWN connection, and which DNS account an
 * ACME connection may write to is an administrator's decision, not an app owner's. The owner of a
 * certificate names only the zone id; the zone is then read through the DNS adapter, which pins
 * its own account (Cloudflare `requireZone`, Route 53 the credentials' hosted zones).
 *
 * The Hub's lookup is read-only (connection row + secret opened for this call only) and the
 * adapters of the DNS provider do the writes: this file never calls a DNS API itself except the
 * Route 53 TXT merge, which uses the AWS adapter's own signed `awsRest`.
 */

export interface DnsHandle {
  /** What was written (a record id, a quoted value): never logged, only used to remove it. */
  remove(): Promise<void>
}

export interface DnsSolver {
  provider: 'cloudflare' | 'aws'
  /** Human label for error text ("Cloudflare", "AWS Route 53"). */
  label: string
  zoneName: string
  /** Makes one TXT record `name` = `value`. Never touches a record it did not make. */
  add(name: string, value: string): Promise<DnsHandle>
  /** Waits until the provider says the changes are published (a no-op where it is instant). */
  settle(): Promise<void>
  /** Removes TXT records an earlier, interrupted run of this resource left (best effort). */
  sweep(names: string[]): Promise<number>
}

const SUPPORTED = new Set(['cloudflare', 'aws'])

/** The DNS connection's context (read-only lookup; never writes anything). */
export async function openDnsContext(
  ctx: ProviderContext
): Promise<{ ctx: ProviderContext; provider: 'cloudflare' | 'aws' }> {
  const id = dnsConnectionId(ctx.config)
  if (id == null)
    throw new ProviderError(
      'ACME_DNS_CONNECTION',
      'The ACME connection has no DNS connection. Edit it and pick the Cloudflare or Route 53 connection that holds your zones.'
    )
  const row = await readConnection(id)
  if (!row || row.status === 'disabled')
    throw new ProviderError(
      'ACME_DNS_CONNECTION',
      'The DNS connection of this ACME connection no longer exists or is disabled.'
    )
  if (!SUPPORTED.has(row.provider))
    throw new ProviderError(
      'ACME_DNS_CONNECTION',
      'DNS-01 works through a Cloudflare or AWS Route 53 connection only.'
    )
  const adapter = getProvider(row.provider)
  if (!adapter)
    throw new ProviderError('ACME_DNS_CONNECTION', `The ${row.provider} provider is not available.`)
  const deps = engineDeps()
  return {
    provider: row.provider as 'cloudflare' | 'aws',
    ctx: makeProviderContext({
      adapter,
      connectionId: row.id,
      config: row.config,
      secrets: await openConnectionSecrets(row),
      region: null,
      signal: ctx.signal,
      now: ctx.now,
      ...(deps.fetch ? { fetch: deps.fetch } : {})
    })
  }
}

/** A DNS provider's failure, said as the DNS step it was (code and retryable kept). */
function dnsFailure(label: string, e: unknown): ProviderError {
  if (e instanceof ProviderError)
    return new ProviderError('ACME_DNS_FAILED', `DNS (${label}): ${e.message}`.slice(0, 1000), {
      retryable: e.retryable,
      ...(e.status !== undefined ? { status: e.status } : {})
    })
  return new ProviderError('ACME_DNS_FAILED', `DNS (${label}) failed.`)
}

async function wrap<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (e) {
    throw dnsFailure(label, e)
  }
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (ms <= 0 || signal.aborted) return resolve()
    const t = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        resolve()
      },
      { once: true }
    )
  })

// ═══ Cloudflare ═══

const CF = 'Cloudflare'

export async function cloudflareSolver(
  dns: ProviderContext,
  zoneId: string,
  resourceId: number | null
): Promise<DnsSolver> {
  const zone = await wrap(CF, () => requireZone(dns, zoneId))
  return {
    provider: 'cloudflare',
    label: CF,
    zoneName: zone.name.toLowerCase(),
    async add(name, value) {
      const made = await wrap(CF, () =>
        createDnsRecord(
          dns,
          zone.id,
          { type: 'TXT', name, content: value, ttl: 60, comment: 'ACME DNS-01 challenge' },
          resourceId
        )
      )
      const recordId = made.record.id
      return { remove: () => wrap(CF, () => deleteDnsRecord(dns, zone.id, recordId)) }
    },
    async settle() {
      /* Cloudflare answers from its edge as soon as the write returns. */
    },
    async sweep(names) {
      if (resourceId == null) return 0
      let removed = 0
      for (const name of names) {
        const rows = await wrap(CF, () => findDnsRecords(dns, zone.id, { type: 'TXT', name }))
        for (const r of rows) {
          if (!String(r.comment ?? '').endsWith(`nivaro-hub:resource=${resourceId}`)) continue
          await wrap(CF, () => deleteDnsRecord(dns, zone.id, r.id))
          removed++
        }
      }
      return removed
    }
  }
}

// ═══ Route 53 ═══

const R53 = 'AWS Route 53'
const R53_PATH = '/2013-04-01'
const quoted = (v: string) => `"${v}"`

interface TxtSet {
  ttl: number
  values: string[]
}

async function readTxt(dns: ProviderContext, zone: string, name: string): Promise<TxtSet | null> {
  const res = await awsRest(dns, 'route53', 'GET', `${R53_PATH}/hostedzone/${zone}/rrset`, {
    query: { name: `${name}.`, type: 'TXT', maxitems: '1' }
  })
  const first = xmlList(restXml(dns, res).ResourceRecordSets, 'ResourceRecordSet')[0]
  if (!first) return null
  if (
    normName(xmlText(xmlChild(first, 'Name'))) !== name ||
    xmlText(xmlChild(first, 'Type')) !== 'TXT'
  )
    return null
  const ttl = Number(xmlText(xmlChild(first, 'TTL')))
  return {
    ttl: Number.isFinite(ttl) && ttl > 0 ? ttl : 300,
    values: xmlList(xmlChild(first, 'ResourceRecords'), 'ResourceRecord').map((x) =>
      xmlText(xmlChild(x, 'Value'))
    )
  }
}

/** One Route 53 change; answers the change id so `settle` can wait for INSYNC. */
async function changeTxt(
  dns: ProviderContext,
  zone: string,
  action: 'UPSERT' | 'DELETE',
  record: RecordSet
): Promise<string | null> {
  const body = `<ChangeResourceRecordSetsRequest xmlns="https://route53.amazonaws.com/doc/2013-04-01/"><ChangeBatch><Comment>nivaro-hub:acme</Comment><Changes><Change><Action>${action}</Action>${recordXml(record)}</Change></Changes></ChangeBatch></ChangeResourceRecordSetsRequest>`
  const res = await awsRest(dns, 'route53', 'POST', `${R53_PATH}/hostedzone/${zone}/rrset/`, {
    headers: { 'content-type': 'application/xml' },
    body
  })
  const id = xmlText(xmlChild(xmlChild(restXml(dns, res), 'ChangeInfo'), 'Id'))
  return id ? id.replace(/^\/change\//, '') : null
}

export async function route53Solver(dns: ProviderContext, zoneId: string): Promise<DnsSolver> {
  const zone = String(zoneId).replace(/^\/hostedzone\//, '')
  if (!/^[A-Z0-9]{5,32}$/.test(zone))
    throw new ProviderError('BAD_ID', 'That is not a Route 53 hosted zone id.')
  const z = await wrap(R53, () => route53ZoneDef.observe(dns, zone, 'us-east-1'))
  if (!z)
    throw new ProviderError(
      'ACME_ZONE_NOT_FOUND',
      'That hosted zone does not exist in the DNS connection.',
      {
        status: 404
      }
    )
  if (z.fields.private === true)
    throw new ProviderError(
      'ACME_ZONE_PRIVATE',
      'That hosted zone is private: the CA cannot see its records, so DNS-01 cannot prove a name there.'
    )
  const pending: string[] = []
  const touch = async (action: 'UPSERT' | 'DELETE', record: RecordSet) => {
    const id = await changeTxt(dns, zone, action, record)
    if (id) pending.push(id)
  }
  return {
    provider: 'aws',
    label: R53,
    zoneName: String(z.fields.name ?? z.name ?? '').toLowerCase(),
    async add(rawName, value) {
      const name = normName(rawName)
      const mine = quoted(value)
      await wrap(R53, async () => {
        const have = await readTxt(dns, zone, name)
        // Other TXT values of the same name (another challenge, an SPF-like note) are kept.
        const values = [...new Set([...(have?.values ?? []), mine])]
        await touch('UPSERT', { name, type: 'TXT', ttl: have?.ttl ?? 60, values })
      })
      return {
        remove: () =>
          wrap(R53, async () => {
            const have = await readTxt(dns, zone, name)
            if (!have || !have.values.includes(mine)) return
            const rest = have.values.filter((v) => v !== mine)
            if (rest.length)
              await touch('UPSERT', { name, type: 'TXT', ttl: have.ttl, values: rest })
            else await touch('DELETE', { name, type: 'TXT', ttl: have.ttl, values: have.values })
          })
      }
    },
    async settle() {
      // Wait for every change we made to be INSYNC (up to a minute), then forget them.
      const ids = pending.splice(0)
      for (const id of ids) {
        for (let i = 0; i < 30; i++) {
          const res = await wrap(R53, () =>
            awsRest(dns, 'route53', 'GET', `${R53_PATH}/change/${id}`)
          )
          if (xmlText(xmlChild(xmlChild(restXml(dns, res), 'ChangeInfo'), 'Status')) === 'INSYNC')
            break
          await sleep(2000, dns.signal)
        }
      }
    },
    async sweep() {
      // Route 53 records carry no owner marker: a record is only ever removed by the run that made it.
      return 0
    }
  }
}

/** The solver for the connection's DNS provider and one zone. */
export async function openDnsSolver(
  ctx: ProviderContext,
  zoneId: string,
  resourceId: number | null
): Promise<DnsSolver> {
  const { ctx: dns, provider } = await openDnsContext(ctx)
  return provider === 'cloudflare'
    ? cloudflareSolver(dns, zoneId, resourceId)
    : route53Solver(dns, zoneId)
}

export { sleep as dnsSleep }
