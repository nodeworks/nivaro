import { X509Certificate } from 'node:crypto'
import type { Observed, ProviderContext } from '../types.js'
import { ProviderError } from '../types.js'
import {
  type AcmeSession,
  acmeFailure,
  acmeKeys,
  dnsWaitMs,
  encodeUrlId,
  ensureAccountUrl,
  openSession
} from './client.js'
import { type DnsHandle, type DnsSolver, dnsSleep, openDnsSolver } from './dns.js'
import { challengeName, checkNamesAllowed, type ParsedName } from './names.js'

/**
 * Orders (Task 38): issue and read. Everything cryptographic is acme-client's (key and CSR
 * creation, JWS, finalize); this file sequences the DNS-01 dance around it.
 */

export const CERT_TYPE = 'acme.certificate'
export const ACCOUNT_TYPE = 'acme.account'
/** A certificate is planned for renewal this many days before it expires. */
export const RENEW_BEFORE_DAYS = 30
/** At most one order per certificate per hour (Let's Encrypt's duplicate-certificate limits). */
export const ORDER_COOLDOWN_MS = 60 * 60 * 1000

export type KeyType = 'ec256' | 'ec384' | 'rsa2048' | 'rsa4096'
export const KEY_TYPES: KeyType[] = ['ec256', 'ec384', 'rsa2048', 'rsa4096']
export const DEFAULT_KEY_TYPE: KeyType = 'ec256'

export function keyTypeOf(v: unknown): KeyType {
  return KEY_TYPES.includes(v as KeyType) ? (v as KeyType) : DEFAULT_KEY_TYPE
}

async function makeKey(type: KeyType): Promise<string> {
  const buf =
    type === 'ec384'
      ? await acmeKeys.createPrivateEcdsaKey('P-384')
      : type === 'rsa2048'
        ? await acmeKeys.createPrivateRsaKey(2048)
        : type === 'rsa4096'
          ? await acmeKeys.createPrivateRsaKey(4096)
          : await acmeKeys.createPrivateEcdsaKey('P-256')
  return buf.toString()
}

// ── Reading a certificate ──

export interface CertInfo {
  names: string[]
  notBefore: string
  notAfter: string
  serial: string
  issuer: string
  keyType: string
}

function issuerOf(x: X509Certificate): string {
  const lines = x.issuer.split('\n')
  const get = (k: string) => lines.find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1)
  return get('CN') ?? get('O') ?? lines.join(', ')
}

function keyTypeOfCert(x: X509Certificate): string {
  const k = x.publicKey
  if (k.asymmetricKeyType === 'ec') {
    const c = k.asymmetricKeyDetails?.namedCurve
    return c === 'prime256v1' ? 'ec256' : c === 'secp384r1' ? 'ec384' : `ec:${c ?? '?'}`
  }
  if (k.asymmetricKeyType === 'rsa') return `rsa${k.asymmetricKeyDetails?.modulusLength ?? ''}`
  return String(k.asymmetricKeyType ?? 'unknown')
}

/** The leaf certificate of a PEM chain, as plain facts. Throws ACME_BAD_CERT on garbage. */
export function readChain(pem: string): CertInfo {
  const first = acmeKeys.splitPemChain(pem)[0]
  if (!first) throw new ProviderError('ACME_BAD_CERT', 'The CA did not return a certificate.')
  let x: X509Certificate
  try {
    x = new X509Certificate(first)
  } catch {
    throw new ProviderError('ACME_BAD_CERT', 'The CA returned a certificate the Hub cannot read.')
  }
  const names = (x.subjectAltName ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.startsWith('DNS:'))
    .map((s) => s.slice(4).toLowerCase())
  return {
    names,
    notBefore: new Date(x.validFrom).toISOString(),
    notAfter: new Date(x.validTo).toISOString(),
    serial: x.serialNumber.toLowerCase(),
    issuer: issuerOf(x),
    keyType: keyTypeOfCert(x)
  }
}

export function daysLeft(notAfter: string, now: Date): number {
  return Math.floor((new Date(notAfter).getTime() - now.getTime()) / 86_400_000)
}

export function observedCertificate(certUrl: string, info: CertInfo, directory: string): Observed {
  return {
    type: CERT_TYPE,
    externalId: encodeUrlId(certUrl),
    name: info.names[0] ?? null,
    fields: {
      names: info.names,
      key_type: info.keyType,
      serial: info.serial,
      issuer: info.issuer,
      not_before: info.notBefore,
      not_after: info.notAfter,
      directory
    },
    tags: {},
    version: info.serial,
    status: 'issued'
  }
}

/** The PEM chain at a certificate URL, or null when the CA no longer has it. */
export async function fetchChain(
  ctx: ProviderContext,
  session: AcmeSession,
  url: string
): Promise<string | null> {
  await ensureAccountUrl(ctx, session)
  try {
    const resp = await session.api.apiRequest(url, null, [200])
    return typeof resp.data === 'string' ? resp.data : null
  } catch (e) {
    if (session.last?.status === 404) return null
    throw acmeFailure(ctx, e, session)
  }
}

// ── Issuing ──

export interface IssueInput {
  names: ParsedName[]
  zoneId: string
  keyType: KeyType
  /** The Hub row id (marks Cloudflare records so a resumed run recognises its own). */
  resourceId: number | null
}

export interface IssueResult {
  certUrl: string
  fullchain: string
  /** Secret. Only ever put into `OpResult.outputs`. */
  privateKey: string
  info: CertInfo
  /** TXT records that could not be removed afterwards (the answer says so; they are harmless). */
  cleanupFailures: number
}

/**
 * One DNS-01 order. The DNS solver is created here from the connection's DNS connection unless a
 * test hands one in. A failed challenge deactivates its authorization; the TXT records are always
 * removed.
 */
export async function issueCertificate(
  ctx: ProviderContext,
  input: IssueInput,
  deps: { session?: AcmeSession; solver?: DnsSolver } = {}
): Promise<IssueResult> {
  const session = deps.session ?? openSession(ctx)
  const solver = deps.solver ?? (await openDnsSolver(ctx, input.zoneId, input.resourceId))
  checkNamesAllowed(input.names, solver.zoneName, ctx.config)
  const client = session.client as any
  const handles: DnsHandle[] = []
  let cleanupFailures = 0
  try {
    await ensureAccountUrl(ctx, session)
    const keyPem = await makeKey(input.keyType)
    session.secretsInPlay.push(keyPem)
    const [, csr] = await acmeKeys.createCsr(
      {
        commonName: input.names[0]?.name,
        altNames: input.names.map((n) => n.name)
      },
      keyPem
    )
    const bases = [...new Set(input.names.map((n) => challengeName(n.base)))]
    await solver.sweep(bases).catch(() => 0)

    const order = await client.createOrder({
      identifiers: input.names.map((n) => ({ type: 'dns', value: n.name }))
    })
    const authzs = (await client.getAuthorizations(order)) as any[]
    const todo: Array<{ authz: any; challenge: any }> = []
    for (const authz of authzs) {
      if (authz.status === 'valid') continue
      const challenge = (authz.challenges ?? []).find((c: any) => c.type === 'dns-01')
      if (!challenge)
        throw new ProviderError(
          'ACME_NO_DNS01',
          `The CA offers no DNS-01 challenge for ${String(authz.identifier?.value ?? 'a name')}.`
        )
      const proof = (await client.getChallengeKeyAuthorization(challenge)) as string
      handles.push(await solver.add(challengeName(String(authz.identifier.value)), proof))
      todo.push({ authz, challenge })
    }
    if (todo.length) {
      await solver.settle()
      await dnsSleep(dnsWaitMs(ctx.config), ctx.signal)
      await Promise.all(
        todo.map(async ({ authz, challenge }) => {
          try {
            await client.completeChallenge(challenge)
            await client.waitForValidStatus(challenge)
          } catch (e) {
            await client.deactivateAuthorization(authz).catch(() => undefined)
            throw e
          }
        })
      )
    }
    const finalized = await client.finalizeOrder(order, csr)
    const fullchain = (await client.getCertificate(finalized)) as string
    const certUrl = String(finalized.certificate ?? '')
    if (!certUrl)
      throw new ProviderError('ACME_NO_CERT_URL', 'The CA did not say where the certificate is.')
    return {
      certUrl,
      fullchain,
      privateKey: keyPem,
      info: readChain(fullchain),
      get cleanupFailures() {
        return cleanupFailures
      }
    }
  } catch (e) {
    throw acmeFailure(ctx, e, session)
  } finally {
    for (const h of handles) {
      try {
        await h.remove()
      } catch {
        cleanupFailures++
      }
    }
    await solver.settle().catch(() => undefined)
  }
}
