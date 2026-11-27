import type {
  ConnectionTest,
  HealthAnswer,
  ListPage,
  ProviderAdapter,
  ProviderContext
} from '../types.js'
import { ProviderError } from '../types.js'
import { xmlAttr, xmlChild } from '../xml.js'
import { CONNECTION_FIELDS, connectionProblems, hostOf, ncCall, seenOf } from './client.js'
import {
  applyRecord,
  DNS_RECORD,
  dnsRecordSpec,
  listRecords,
  planRecord,
  readRecord
} from './dns.js'
import {
  applyDomain,
  DOMAIN,
  domainHealth,
  domainSpec,
  listDomains,
  planDomain,
  readDomain
} from './domain.js'
import { NAMECHEAP_BUNDLED, namecheapPriceApi } from './pricing.js'

/**
 * Namecheap (`namecheap`, Task 43): domain registrations (`namecheap.domain`, shared, registrar)
 * and the host records of domains on Namecheap's own DNS (`namecheap.dns_record`, app). See
 * client.ts for the call rules (API key in the POST body, the account's IP allow-list, sandbox
 * host), domain.ts and dns.ts for what each type may do.
 */

const unknown = (type: string) =>
  new ProviderError('UNKNOWN_TYPE', `Namecheap has no resource type ${type}.`)

async function testConnection(ctx: ProviderContext): Promise<ConnectionTest> {
  const ip = String(ctx.config.client_ip ?? '').trim()
  const permissions: ConnectionTest['permissions'] = []
  try {
    const r = await ncCall(ctx, 'namecheap.users.getBalances')
    const bal = xmlChild(r.response, 'UserGetBalancesResult')
    permissions.push({ type: '*', need: 'API access for this user', has: true })
    permissions.push({ type: '*', need: `calls from ${ip}`, has: true })
    let domains = true
    try {
      await ncCall(ctx, 'namecheap.domains.getList', { PageSize: 10, Page: 1 })
    } catch (err) {
      if (!(err instanceof ProviderError) || err.code === 'RATE_LIMITED') throw err
      domains = false
    }
    permissions.push({ type: DOMAIN, need: 'list domains', has: domains })
    const user = String(ctx.config.username ?? '') || String(ctx.config.api_user ?? '')
    return {
      ok: true,
      identity: `Namecheap user ${user}${ctx.config.sandbox === true ? ' (sandbox)' : ''}${
        xmlAttr(bal, 'Currency') ? `, account in ${xmlAttr(bal, 'Currency')}` : ''
      }`,
      permissions,
      missing: permissions.filter((p) => !p.has).map((p) => p.need),
      message:
        'Domain registration and renewal are charged to this account’s balance or card; the Hub asks a Hub administrator to confirm each one.'
    }
  } catch (err) {
    if (err instanceof ProviderError && err.code === 'CLIENT_IP_NOT_ALLOWED') {
      const seen = seenOf(err)
      return {
        ok: false,
        identity: null,
        permissions: [{ type: '*', need: `calls from ${seen ?? ip}`, has: false }],
        missing: [`calls from ${seen ?? ip}`],
        message: `${err.message} ${
          seen
            ? `Namecheap sees the Hub calling from ${seen}${seen !== ip ? ` (the connection says ${ip || 'nothing'})` : ''}: add ${seen} under Profile → Tools → API access → Whitelisted IPs, and set it as the Hub address here.`
            : `Add the Hub's public IPv4 address (${ip || 'not set'}) under Profile → Tools → API access → Whitelisted IPs.`
        }`
      }
    }
    if (err instanceof ProviderError && err.code === 'AUTH_FAILED')
      return {
        ok: false,
        identity: null,
        permissions: [{ type: '*', need: 'API access for this user', has: false }],
        missing: ['API access for this user'],
        message: `${err.message} Turn API access on under Profile → Tools → API access and copy the key again.`
      }
    const message = err instanceof ProviderError ? err.message : 'Could not reach Namecheap.'
    return { ok: false, identity: null, permissions: [], missing: [], message }
  }
}

export const namecheapAdapter: ProviderAdapter = {
  key: 'namecheap',
  label: 'Namecheap',
  bundledPrices: NAMECHEAP_BUNDLED,
  priceApi: (ctx, skuKey) => namecheapPriceApi(ctx, skuKey),
  connection: {
    fields: CONNECTION_FIELDS,
    hosts: (config) => [hostOf(config)],
    describe: (config) =>
      `Namecheap ${String(config.username || config.api_user || '')}${config.sandbox === true ? ' (sandbox)' : ''} · from ${String(config.client_ip ?? '')}`,
    validate: connectionProblems
  },
  types: [domainSpec, dnsRecordSpec],
  testConnection,

  async observe(ctx, type, externalId) {
    if (type === DOMAIN) return readDomain(ctx, externalId)
    if (type === DNS_RECORD) return readRecord(ctx, externalId)
    throw unknown(type)
  },

  async list(ctx, type, cursor): Promise<ListPage> {
    if (type === DOMAIN) return listDomains(ctx, cursor)
    if (type === DNS_RECORD) {
      const page = await listDomains(ctx, null)
      const ours = page.items
        .filter((d) => Array.isArray(d.fields.nameservers) && d.fields.nameservers.length === 0)
        .map((d) => d.externalId)
      return listRecords(ctx, ours)
    }
    throw unknown(type)
  },

  async findExisting(ctx, type, desired) {
    if (type === DOMAIN) return readDomain(ctx, String(desired.fields.name ?? ''))
    return null
  },

  plan(_ctx, desired, observed) {
    const type = desired?.type ?? observed?.type
    if (type === DOMAIN) return planDomain(desired, observed)
    if (type === DNS_RECORD) return planRecord(desired, observed)
    return []
  },

  apply(ctx, op, desired) {
    if (op.type === DOMAIN) return applyDomain(ctx, op, desired)
    if (op.type === DNS_RECORD) return applyRecord(ctx, op, desired)
    throw unknown(op.type)
  },

  async health(ctx, type, externalId): Promise<HealthAnswer> {
    const checkedAt = ctx.now().toISOString()
    if (type === DOMAIN) {
      const o = await readDomain(ctx, externalId)
      if (!o)
        return { status: 'down', message: 'Not in this Namecheap account any more.', checkedAt }
      return domainHealth(ctx, o)
    }
    if (type === DNS_RECORD) {
      const o = await readRecord(ctx, externalId)
      return o
        ? { status: 'ok', message: 'The record is in place.', checkedAt }
        : { status: 'down', message: 'The record is gone at Namecheap.', checkedAt }
    }
    throw unknown(type)
  }
}
