import type {
  ConnectionTest,
  DesiredResource,
  HealthAnswer,
  ListPage,
  Observed,
  OpResult,
  PlannedOp,
  ProviderAdapter,
  ProviderContext
} from '../types.js'
import { ProviderError } from '../types.js'
import {
  type AcmeSession,
  accountKeyProblem,
  CONNECTION_FIELDS,
  DNS_WAIT_MAX_SECONDS,
  decodeUrlId,
  describeConnection,
  directoryChoice,
  directoryHost,
  directoryUrl,
  dnsConnectionId,
  EMAIL_RE,
  encodeUrlId,
  guarded,
  HOST_RE,
  hostsOf,
  isProduction,
  openSession,
  useExistingAccount
} from './client.js'
import { openDnsContext } from './dns.js'
import { parseNames } from './names.js'
import {
  ACCOUNT_TYPE,
  CERT_TYPE,
  daysLeft,
  fetchChain,
  issueCertificate,
  keyTypeOf,
  ORDER_COOLDOWN_MS,
  observedCertificate,
  RENEW_BEFORE_DAYS,
  readChain
} from './order.js'
import { contactOf, planAccount, planCertificate } from './plan.js'
import { ACME_TYPES } from './specs.js'

/**
 * Let's Encrypt / ACME (`acme`, Hub providers Task 38).
 *
 * One connection = one ACME account key at one CA directory (Let's Encrypt STAGING until a Hub
 * administrator switches the connection to production), plus the one Cloudflare or Route 53
 * connection that holds the DNS zones. DNS-01 only: the order's `_acme-challenge` TXT records are
 * made through that DNS connection and removed afterwards (see dns.ts for why the DNS connection
 * is a connection setting, not a `ref`).
 *
 * Types: `acme.account` (shared) and `acme.certificate` (names, one zone; outputs `fullchain` and
 * the once-only `private_key`). A certificate has no listing at the CA, so there is nothing to
 * adopt: its id is its URL at the CA (base64url), read with the account key.
 *
 * Renewal: `plan()` returns a `renew` op once the certificate has 30 days left, so the drift
 * sweep plans it with no special code. A renewal is a normal change (no confirm, no cost). At
 * most one order per certificate per hour; a 429 is retryable and says how long to wait.
 *
 * Bindings: the outputs bind to stack secrets (`stack_secret`), which the Hub agent mounts under
 * /run/secrets/<KEY> for Traefik's file provider (docs: hub-providers-acme).
 */

const ok = (
  externalId: string | null,
  observed: Observed | null,
  answer?: Record<string, unknown>,
  outputs?: Record<string, string>
): OpResult => ({
  ok: true,
  externalId,
  observed,
  ...(answer ? { answer } : {}),
  ...(outputs ? { outputs } : {})
})

function mismatch(op: PlannedOp, desired: DesiredResource | null): void {
  if (desired?.externalId && op.externalId && desired.externalId !== op.externalId)
    throw new ProviderError(
      'TARGET_MISMATCH',
      'This step is for a different ACME resource than the one it was planned for.'
    )
}

// ═══ Account ═══

function observedAccount(ctx: ProviderContext, url: string, data: Record<string, any>): Observed {
  const mail = (Array.isArray(data.contact) ? data.contact : []).find(
    (c: unknown) => typeof c === 'string' && c.startsWith('mailto:')
  )
  const contact = typeof mail === 'string' ? mail.slice(7) : ''
  return {
    type: ACCOUNT_TYPE,
    externalId: encodeUrlId(url),
    name: contact || 'ACME account',
    fields: {
      contact_email: contact,
      status: typeof data.status === 'string' ? data.status : 'valid',
      directory: directoryChoice(ctx.config)
    },
    tags: {},
    status: typeof data.status === 'string' ? data.status : 'valid'
  }
}

/** The account the connection's key has at the CA, or null when it has none. */
async function readAccount(
  ctx: ProviderContext,
  session: AcmeSession = openSession(ctx)
): Promise<{ url: string; observed: Observed } | null> {
  try {
    const got = await useExistingAccount(ctx, session)
    return { url: got.url, observed: observedAccount(ctx, got.url, got.account) }
  } catch (e) {
    if (e instanceof ProviderError && e.code === 'ACME_NO_ACCOUNT') return null
    throw e
  }
}

async function applyAccount(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource | null
): Promise<OpResult> {
  mismatch(op, desired)
  const session = openSession(ctx)
  if (op.kind === 'create') {
    if (!desired) throw new ProviderError('INVALID_FIELDS', 'Nothing to create.')
    if (desired.fields.terms_agreed !== true)
      throw new ProviderError('INVALID_FIELDS', 'Agree to the CA’s terms of service first.')
    const contact = contactOf(ctx, desired.fields)
    const resp = await guarded(ctx, session, () =>
      session.api.createAccount({
        termsOfServiceAgreed: true,
        ...(contact ? { contact: [`mailto:${contact}`] } : {})
      })
    )
    const url = session.api.accountUrl
    if (!url) throw new ProviderError('ACME_NO_ACCOUNT', 'The CA did not return an account URL.')
    // 200 = the key already had an account. Only a resumed run (the id was recorded) may carry on.
    if (resp.status === 200 && desired.externalId !== encodeUrlId(url))
      throw new ProviderError(
        'ALREADY_EXISTS',
        'This connection’s account key already has an account at the CA that the Hub did not make. Adopt it instead of creating it.',
        { status: 409 }
      )
    return ok(encodeUrlId(url), observedAccount(ctx, url, resp.data ?? {}), { created: true })
  }
  const have = await readAccount(ctx, session)
  if (op.kind === 'delete') {
    if (!have) return ok(op.externalId, null, { already_gone: true })
    if (have.observed.externalId !== op.externalId)
      throw new ProviderError(
        'ACME_OUT_OF_ACCOUNT',
        'That account is not the one this connection’s key owns.'
      )
    await guarded(ctx, session, () =>
      session.api.apiRequest(have.url, { status: 'deactivated' }, [200])
    )
    return ok(op.externalId, null, { deactivated: true })
  }
  if (!have || have.observed.externalId !== op.externalId)
    throw new ProviderError('NOT_FOUND', 'The ACME account no longer exists.', { status: 404 })
  if (!desired) throw new ProviderError('INVALID_FIELDS', 'Nothing to write.')
  const contact = contactOf(ctx, desired.fields)
  if (!contact || contact === have.observed.fields.contact_email)
    return ok(op.externalId, have.observed, { already: 'matches' })
  const resp = await guarded(ctx, session, () =>
    session.api.apiRequest(have.url, { contact: [`mailto:${contact}`] }, [200, 202])
  )
  return ok(op.externalId, observedAccount(ctx, have.url, resp.data ?? {}), {
    changed: ['contact_email']
  })
}

// ═══ Certificate ═══

async function readCertificate(ctx: ProviderContext, id: string): Promise<Observed | null> {
  const url = decodeUrlId(ctx, id, 'certificate')
  const session = openSession(ctx)
  const chain = await fetchChain(ctx, session, url)
  if (!chain) return null
  return observedCertificate(url, readChain(chain), directoryChoice(ctx.config))
}

async function applyCertificate(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource | null
): Promise<OpResult> {
  mismatch(op, desired)
  if (op.kind === 'delete') {
    // The CA keeps no deletable record: the Hub forgets the certificate and its sealed key.
    return ok(op.externalId, null, { released: true, revoked: false })
  }
  if (!desired) throw new ProviderError('INVALID_FIELDS', 'Nothing to write.')
  if (desired.refs.account == null)
    throw new ProviderError('INVALID_FIELDS', 'The certificate has no ACME account.')
  const names = parseNames(desired.fields.names)
  const zoneId = String(desired.fields.zone ?? '').trim()
  if (!zoneId) throw new ProviderError('INVALID_FIELDS', 'Name the DNS zone for the proof records.')
  let previous: string | null = null
  if (op.kind !== 'create') {
    const have = op.externalId ? await readCertificate(ctx, op.externalId) : null
    if (!have)
      throw new ProviderError('NOT_FOUND', 'The certificate is no longer at the CA.', {
        status: 404
      })
    previous = String(have.fields.serial ?? '')
    // At most one order per certificate per hour.
    const since = ctx.now().getTime() - new Date(String(have.fields.not_before)).getTime()
    if (since >= 0 && since < ORDER_COOLDOWN_MS)
      throw new ProviderError(
        'ACME_ORDER_TOO_SOON',
        `This certificate was ordered ${Math.max(1, Math.round(since / 60000))} minute(s) ago. The Hub orders at most once an hour per certificate; try again in about ${Math.ceil((ORDER_COOLDOWN_MS - since) / 60000)} minute(s).`,
        { retryable: true }
      )
  }
  const made = await issueCertificate(ctx, {
    names,
    zoneId,
    keyType: keyTypeOf(desired.fields.key_type),
    resourceId: desired.resourceId
  })
  const observed = observedCertificate(made.certUrl, made.info, directoryChoice(ctx.config))
  return ok(
    observed.externalId,
    observed,
    {
      serial: made.info.serial,
      not_after: made.info.notAfter,
      ...(previous ? { previous_serial: previous, previous_kept_until_expiry: true } : {}),
      ...(made.cleanupFailures ? { cleanup_failed: made.cleanupFailures } : {})
    },
    { fullchain: made.fullchain, private_key: made.privateKey }
  )
}

async function observeOne(
  ctx: ProviderContext,
  type: string,
  externalId: string
): Promise<Observed | null> {
  if (type === ACCOUNT_TYPE) {
    const url = decodeUrlId(ctx, externalId, 'account')
    const have = await readAccount(ctx)
    // The connection's key owns exactly one account; any other id is not ours.
    return have && have.url === url ? have.observed : null
  }
  if (type === CERT_TYPE) return readCertificate(ctx, externalId)
  throw new ProviderError('UNKNOWN_TYPE', `ACME has no resource type ${type}.`)
}

// ═══ Adapter ═══

export const acmeAdapter: ProviderAdapter = {
  key: 'acme',
  label: 'Let’s Encrypt (ACME)',
  connection: {
    fields: CONNECTION_FIELDS,
    hosts: hostsOf,
    describe: describeConnection,
    validate(config, secrets) {
      const problems: string[] = []
      const choice = config.directory
      if (
        choice !== undefined &&
        !['letsencrypt_staging', 'letsencrypt_production', 'custom'].includes(String(choice))
      )
        problems.push('Pick a certificate authority from the list.')
      if (directoryChoice(config) === 'custom') {
        const url = directoryUrl(config)
        let u: URL | null = null
        try {
          u = new URL(url)
        } catch {
          /* handled below */
        }
        if (!u || u.protocol !== 'https:' || u.username || u.password || !HOST_RE.test(u.hostname))
          problems.push('The directory URL must be an https address with a host name.')
      }
      if (!EMAIL_RE.test(String(config.contact_email ?? '').trim()))
        problems.push('Give a contact email address.')
      if (dnsConnectionId(config) == null)
        problems.push(
          'Give the id of the Cloudflare or Route 53 connection that holds the DNS zones.'
        )
      for (const d of Array.isArray(config.allowed_domains) ? config.allowed_domains : [])
        if (!HOST_RE.test(String(d).trim().toLowerCase().replace(/^\*\./, '')))
          problems.push(`“${String(d).slice(0, 60)}” is not a domain name.`)
      const wait = Number(config.dns_wait_seconds)
      if (
        config.dns_wait_seconds !== undefined &&
        (!Number.isFinite(wait) || wait < 0 || wait > DNS_WAIT_MAX_SECONDS)
      )
        problems.push(`Seconds to wait for DNS is 0 to ${DNS_WAIT_MAX_SECONDS}.`)
      if (secrets.account_key !== undefined) {
        const bad = accountKeyProblem(secrets.account_key)
        if (bad) problems.push(bad)
      }
      return problems
    }
  },
  types: ACME_TYPES,

  async testConnection(ctx): Promise<ConnectionTest> {
    const permissions: ConnectionTest['permissions'] = []
    const bad = ctx.secrets.account_key
      ? accountKeyProblem(ctx.secrets.account_key)
      : 'No account key.'
    permissions.push({ type: '*', need: 'a usable ACME account key', has: !bad })
    let reach = false
    let message: string | undefined
    try {
      const res = await ctx.fetch(directoryUrl(ctx.config), {
        headers: { accept: 'application/json' }
      })
      const body: any = res.status === 200 ? await res.json().catch(() => null) : null
      reach = !!body?.newNonce && !!body?.newOrder
      if (!reach)
        message = `The directory at ${directoryHost(ctx.config)} did not answer as an ACME v2 directory.`
    } catch (e) {
      message = ctx.scrub(e instanceof Error ? e.message : String(e)).slice(0, 300)
    }
    permissions.push({ type: '*', need: 'reach the ACME directory', has: reach })
    let hasAccount = false
    if (reach && !bad) {
      try {
        hasAccount = (await readAccount(ctx)) != null
      } catch {
        hasAccount = false
      }
    }
    permissions.push({
      type: ACCOUNT_TYPE,
      need: 'an ACME account for this key (make it as an ACME account resource)',
      has: hasAccount
    })
    let dnsLabel = ''
    let dnsOk = false
    try {
      const dns = await openDnsContext(ctx)
      dnsOk = true
      dnsLabel = dns.provider === 'cloudflare' ? 'Cloudflare' : 'AWS Route 53'
    } catch (e) {
      if (!message) message = e instanceof ProviderError ? e.message : undefined
    }
    permissions.push({
      type: CERT_TYPE,
      need: 'a Cloudflare or Route 53 connection for DNS-01',
      has: dnsOk
    })
    const staging = isProduction(ctx.config)
      ? ''
      : ' Using the Let’s Encrypt STAGING CA: its certificates are not trusted by browsers.'
    return {
      ok: reach && !bad,
      identity: `${describeConnection(ctx.config)}${dnsLabel ? ` · DNS through ${dnsLabel}` : ''}`,
      permissions,
      missing: permissions.filter((p) => !p.has).map((p) => p.need),
      ...(message || staging ? { message: `${message ?? ''}${staging}`.trim() } : {})
    }
  },

  observe: observeOne,

  async list(ctx, type): Promise<ListPage> {
    if (type === ACCOUNT_TYPE) {
      const have = await readAccount(ctx)
      return { items: have ? [have.observed] : [], cursor: null }
    }
    // A CA keeps no listing of certificates by account.
    return { items: [], cursor: null }
  },

  plan(ctx, desired, observed) {
    const type = desired?.type ?? observed?.type
    if (type === ACCOUNT_TYPE) return planAccount(ctx, desired, observed)
    if (type === CERT_TYPE) return planCertificate(ctx, desired, observed)
    throw new ProviderError('UNKNOWN_TYPE', `ACME has no resource type ${String(type)}.`)
  },

  async apply(ctx, op, desired) {
    if (op.type === ACCOUNT_TYPE) return applyAccount(ctx, op, desired)
    if (op.type === CERT_TYPE) return applyCertificate(ctx, op, desired)
    throw new ProviderError('UNKNOWN_TYPE', `ACME has no resource type ${op.type}.`)
  },

  async findExisting(ctx, type): Promise<Observed | null> {
    // Only an account can collide: the key is the account. A certificate order is always new.
    return type === ACCOUNT_TYPE ? ((await readAccount(ctx))?.observed ?? null) : null
  },

  async readOutputs(ctx, type, externalId): Promise<Record<string, string>> {
    if (type !== CERT_TYPE) return {}
    const url = decodeUrlId(ctx, externalId, 'certificate')
    const chain = await fetchChain(ctx, openSession(ctx), url)
    return chain ? { fullchain: chain } : {}
  },

  async health(ctx, type, externalId): Promise<HealthAnswer> {
    const checkedAt = ctx.now().toISOString()
    const seen = await observeOne(ctx, type, externalId)
    if (!seen) return { status: 'down', message: 'The CA no longer has it.', checkedAt }
    if (type === ACCOUNT_TYPE)
      return seen.status === 'valid'
        ? { status: 'ok', checkedAt }
        : { status: 'down', message: `The account is ${String(seen.status)}.`, checkedAt }
    const notAfter = String(seen.fields.not_after ?? '')
    const left = daysLeft(notAfter, ctx.now())
    const details = { expiresAt: notAfter, daysLeft: left }
    if (left < 0)
      return { status: 'down', message: 'The certificate has expired.', checkedAt, details }
    if (left <= RENEW_BEFORE_DAYS)
      return {
        status: 'warn',
        message: `Expires in ${left} day(s); a renewal is due.`,
        checkedAt,
        details
      }
    return { status: 'ok', checkedAt, details }
  }
}
