import type { ConnectionTest, ProviderAdapter, ProviderContext } from '../types.js'
import { ProviderError } from '../types.js'
import { accessAppImpl, accessPolicyImpl } from './access.js'
import {
  accountPath,
  accountProblem,
  CLOUDFLARE_HOST,
  CONNECTION_FIELDS,
  cfCall,
  checkId
} from './client.js'
import { arr, asObj, str, type TypeImpl } from './common.js'
import { dnsImpl } from './dns.js'
import { domainImpl } from './domain.js'
import { CLOUDFLARE_BUNDLED } from './pricing.js'
import { r2Impl } from './r2.js'
import { tunnelImpl, tunnelRouteImpl } from './tunnel.js'
import { wafImpl } from './waf.js'
import { workerRouteImpl, workerSecretImpl } from './workers.js'
import { zoneImpl } from './zone.js'

/**
 * Cloudflare provider (Hub third-party providers, Task 15). One account per connection (the
 * account id is pinned; a token that sees more accounts is never followed into them). Types:
 * `cloudflare.zone` (shared, read / adopt), `.dns_record`, `.tunnel`, `.tunnel_route`,
 * `.access_application`, `.access_policy`, `.r2_bucket`, `.worker_route`, `.worker_secret` and
 * `.waf_custom_rule`, and `.domain` (Task 43: Cloudflare Registrar, read / adopt / auto-renew /
 * lock / privacy). Worker script upload is not in scope.
 *
 * Reusable by later tasks: `client.ts` (`cfCall`, `readZone`, `requireZone`, id checks) and
 * `dns.ts` (`createDnsRecord`, `deleteDnsRecord`, `findDnsRecords`) — Task 38 (ACME DNS-01) and
 * Task 43 (Cloudflare Registrar) import them from here.
 */

const IMPLS: TypeImpl[] = [
  zoneImpl,
  dnsImpl,
  tunnelImpl,
  tunnelRouteImpl,
  accessAppImpl,
  accessPolicyImpl,
  r2Impl,
  workerRouteImpl,
  workerSecretImpl,
  wafImpl,
  domainImpl
]
const BY_TYPE = new Map<string, TypeImpl>(IMPLS.map((i) => [i.spec.key, i]))

function implOf(type: string): TypeImpl {
  const impl = BY_TYPE.get(type)
  if (!impl) throw new ProviderError('UNKNOWN_TYPE', `Cloudflare has no resource type ${type}.`)
  return impl
}

interface TokenVerify {
  id?: string
  status?: string
}

/** The token's own id when it verifies (account-owned token first, then a user token). */
async function verifyToken(ctx: ProviderContext): Promise<TokenVerify | null> {
  const tries = [`${accountPath(ctx)}/tokens/verify`, '/user/tokens/verify']
  for (const path of tries) {
    const res = await cfCall<TokenVerify>(ctx, 'GET', path, { allow: [400, 401, 403, 404] })
    if (res.status === 200 && res.result?.status === 'active') return res.result
  }
  return null
}

/** The permission-group names of the token, when its detail can be read (else null). */
async function tokenGroups(ctx: ProviderContext, id: string): Promise<Set<string> | null> {
  for (const path of [
    `${accountPath(ctx)}/tokens/${checkId(id, 'token id')}`,
    `/user/tokens/${checkId(id, 'token id')}`
  ]) {
    const res = await cfCall<{ policies?: unknown[] }>(ctx, 'GET', path, {
      allow: [400, 401, 403, 404]
    })
    if (res.status !== 200 || !res.result) continue
    const names = new Set<string>()
    for (const p of arr(res.result.policies))
      for (const g of arr(asObj(p).permission_groups)) {
        const n = str(asObj(g).name)
        if (n) names.add(n.toLowerCase())
      }
    return names.size ? names : null
  }
  return null
}

export const cloudflareProvider: ProviderAdapter = {
  key: 'cloudflare',
  label: 'Cloudflare',
  bundledPrices: CLOUDFLARE_BUNDLED,
  connection: {
    fields: CONNECTION_FIELDS,
    hosts: () => [CLOUDFLARE_HOST],
    describe: (config) => `Cloudflare account ${String(config.accountId ?? '')}`,
    validate(config, secrets) {
      const problems: string[] = []
      const a = accountProblem(config)
      if (a) problems.push(a)
      if ('apiToken' in secrets && !secrets.apiToken) problems.push('Enter the API token.')
      return problems
    }
  },
  types: IMPLS.map((i) => i.spec),

  async testConnection(ctx): Promise<ConnectionTest> {
    let verified: TokenVerify | null
    try {
      verified = await verifyToken(ctx)
    } catch (err) {
      const message = err instanceof ProviderError ? err.message : 'Could not reach Cloudflare.'
      return { ok: false, identity: null, permissions: [], missing: [], message }
    }
    if (!verified)
      return {
        ok: false,
        identity: null,
        permissions: [],
        missing: [],
        message: 'Cloudflare did not accept this API token (it is invalid, expired or revoked).'
      }
    let identity = `Cloudflare account ${String(ctx.config.accountId)}`
    try {
      const acct = await cfCall<{ name?: string }>(ctx, 'GET', accountPath(ctx), {
        allow: [400, 401, 403, 404]
      })
      if (acct.status === 200 && acct.result?.name)
        identity = `Cloudflare account ${acct.result.name} (${String(ctx.config.accountId)})`
    } catch {
      // The token may not read account settings; the id alone is shown.
    }
    const groups = verified.id ? await tokenGroups(ctx, verified.id).catch(() => null) : null
    const permissions: ConnectionTest['permissions'] = []
    for (const impl of IMPLS) {
      for (const p of impl.permissions) {
        let has = false
        try {
          const r = await p.probe(ctx)
          has = r !== false
        } catch (err) {
          if (
            !(err instanceof ProviderError) ||
            !['FORBIDDEN', 'AUTH_FAILED', 'NOT_FOUND'].includes(err.code)
          )
            throw err
          has = false
        }
        permissions.push({ type: impl.spec.key, need: p.need, has })
        if (groups && p.group)
          permissions.push({
            type: impl.spec.key,
            need: `edit ${impl.spec.label} (permission "${p.group}")`,
            has: groups.has(p.group.toLowerCase())
          })
      }
    }
    const missing = [...new Set(permissions.filter((p) => !p.has).map((p) => p.need))]
    const said = groups
      ? missing.length
        ? 'Grant the missing permissions to this API token in the Cloudflare dashboard.'
        : ''
      : 'Cloudflare did not list this token’s permissions; only read access was checked. Write access shows up when a change is tried.'
    // Task 43: what the Registrar API offers, said once on every test.
    const registrar =
      'Domain registration and transfers into Cloudflare are not offered through its API: register in the Cloudflare dashboard, then adopt the domain here.'
    return {
      ok: true,
      identity,
      permissions,
      missing,
      message: said ? `${said} ${registrar}` : registrar
    }
  },

  observe: (ctx, type, externalId) => implOf(type).observe(ctx, externalId),
  list: (ctx, type, cursor) => implOf(type).list(ctx, cursor),
  findExisting: async (ctx, type, desired) => implOf(type).findExisting?.(ctx, desired) ?? null,
  plan(ctx, desired, observed) {
    const type = desired?.type ?? observed?.type
    return type ? implOf(type).plan(ctx, desired, observed) : []
  },
  apply: (ctx, op, desired) => implOf(op.type).apply(ctx, op, desired),
  async readOutputs(ctx, type, externalId) {
    return (await implOf(type).readOutputs?.(ctx, externalId)) ?? {}
  },
  async health(ctx, type, externalId) {
    const impl = implOf(type)
    if (impl.health) return impl.health(ctx, externalId)
    const seen = await impl.observe(ctx, externalId)
    return {
      status: seen ? 'ok' : 'down',
      message: seen ? 'Present at Cloudflare.' : 'Gone at Cloudflare.',
      checkedAt: ctx.now().toISOString()
    }
  }
}

export {
  accountPath,
  cfCall,
  readZone,
  requireZone
} from './client.js'
export {
  createDnsRecord,
  DNS_RECORD,
  type DnsRecordInput,
  deleteDnsRecord,
  findDnsRecords,
  fqdn
} from './dns.js'
export { ZONE } from './zone.js'
