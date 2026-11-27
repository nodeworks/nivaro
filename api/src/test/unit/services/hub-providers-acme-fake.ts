import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * A fake ACME CA (directory, nonce, account, order, authorization, challenge, finalize,
 * certificate) plus fake Cloudflare and Route 53 DNS APIs, all behind one `fetchImpl`. Hub
 * providers Task 38 tests: nothing here ever reaches a real server. The CA checks the TXT record
 * the DNS fakes hold against the real DNS-01 proof (base64url sha256 of token.thumbprint), so a
 * test proves the Hub wrote the right record, in the right place, before the challenge turned valid.
 */

const FIX = join(import.meta.dirname, '../../../services/hub/providers/acme/__fixtures__')
export const CHAIN_PLAIN = readFileSync(join(FIX, 'fullchain-plain.pem'), 'utf8')
export const CHAIN_WILDCARD = readFileSync(join(FIX, 'fullchain-wildcard.pem'), 'utf8')

export const CF_ACCOUNT = 'a1b2c3d4e5f60718293a4b5c6d7e8f90'
export const CF_ZONE = '023e105f4ecef8ad9ca31a8372d0c353'
export const R53_ZONE = 'Z0123456789FAKE'
export const ZONE_NAME = 'example.test'
export const CA_STAGING = 'acme-staging-v02.api.letsencrypt.org'

const b64u = (s: string | Buffer) => Buffer.from(s).toString('base64url')
const unb64u = (s: string) => Buffer.from(s, 'base64url').toString('utf8')

interface Order {
  id: number
  identifiers: Array<{ type: string; value: string }>
  authz: number[]
  status: 'pending' | 'valid'
  certId?: string
}
interface Authz {
  id: number
  base: string
  wildcard: boolean
  token: string
  status: 'pending' | 'valid' | 'invalid'
}

export interface Call {
  host: string
  method: string
  path: string
  body: any
}

export interface WorldOptions {
  /** The CA already has an account for the key. */
  account?: boolean
  /** newOrder answers 429 rateLimited with this Retry-After (seconds). */
  rateLimitSeconds?: number
  /** The chain the CA hands out. */
  chain?: string
  /** Cloudflare zone belongs to another account. */
  cfForeignZone?: boolean
  r53Private?: boolean
  host?: string
}

export function makeWorld(opts: WorldOptions = {}) {
  const host = opts.host ?? CA_STAGING
  const base = `https://${host}`
  const calls: Call[] = []
  const txt = new Map<string, string[]>()
  const cfRecords: Array<{
    id: string
    type: string
    name: string
    content: string
    comment?: string
  }> = []
  let nonce = 0
  let ids = 0
  const state = {
    account: opts.account
      ? ({ id: 7, jwk: null as any, contact: ['mailto:ops@example.test'], status: 'valid' } as {
          id: number
          jwk: any
          contact: string[]
          status: string
        } | null)
      : null,
    orders: [] as Order[],
    authzs: [] as Authz[],
    deniedChallenges: 0,
    breakProof: false,
    /** Text a problem answer echoes (a hostile CA repeating what it was sent). */
    echo: '',
    chain: opts.chain ?? CHAIN_PLAIN,
    rateLimitSeconds: opts.rateLimitSeconds ?? 0,
    deactivated: [] as number[]
  }

  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: {
        'content-type': 'application/json',
        'replay-nonce': `nonce-${++nonce}`,
        ...headers
      }
    })
  const problem = (
    status: number,
    type: string,
    detail: string,
    headers: Record<string, string> = {}
  ) =>
    new Response(JSON.stringify({ type: `urn:ietf:params:acme:error:${type}`, detail, status }), {
      status,
      headers: {
        'content-type': 'application/problem+json',
        'replay-nonce': `nonce-${++nonce}`,
        ...headers
      }
    })

  function thumbprint(jwk: any): string {
    const o = { crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y }
    return b64u(createHash('sha256').update(JSON.stringify(o)).digest())
  }

  function orderBody(o: Order) {
    return {
      status: o.status,
      identifiers: o.identifiers,
      authorizations: o.authz.map((a) => `${base}/acme/authz/${a}`),
      finalize: `${base}/acme/finalize/${o.id}`,
      ...(o.certId ? { certificate: `${base}/acme/cert/${o.certId}` } : {})
    }
  }

  function authzBody(a: Authz) {
    return {
      status: a.status,
      identifier: { type: 'dns', value: a.base },
      ...(a.wildcard ? { wildcard: true } : {}),
      challenges: [
        {
          type: 'http-01',
          url: `${base}/acme/chall/${a.id}/h`,
          token: `${a.token}h`,
          status: 'pending'
        },
        { type: 'dns-01', url: `${base}/acme/chall/${a.id}`, token: a.token, status: a.status }
      ]
    }
  }

  function acme(url: URL, method: string, init: any): Response {
    const path = url.pathname
    if (method === 'GET' && path === '/directory')
      return json(200, {
        newNonce: `${base}/acme/new-nonce`,
        newAccount: `${base}/acme/new-acct`,
        newOrder: `${base}/acme/new-order`,
        revokeCert: `${base}/acme/revoke-cert`,
        keyChange: `${base}/acme/key-change`,
        meta: { termsOfService: 'https://example.test/terms.pdf' }
      })
    if (method === 'HEAD' && path === '/acme/new-nonce')
      return new Response(null, { status: 200, headers: { 'replay-nonce': `nonce-${++nonce}` } })
    if (method !== 'POST') return problem(405, 'malformed', 'method not allowed')
    const jws = JSON.parse(String(init.body))
    const header = JSON.parse(unb64u(jws.protected))
    const payload = jws.payload ? JSON.parse(unb64u(jws.payload)) : null
    if (path === '/acme/new-acct') {
      if (header.jwk && !state.account) state.account = null
      if (payload?.onlyReturnExisting) {
        if (!state.account)
          return problem(400, 'accountDoesNotExist', 'No account exists with the provided key')
        state.account.jwk ??= header.jwk
        return json(200, accountBody(), { location: `${base}/acme/acct/${state.account.id}` })
      }
      if (state.account) {
        state.account.jwk ??= header.jwk
        return json(200, accountBody(), { location: `${base}/acme/acct/${state.account.id}` })
      }
      if (payload?.termsOfServiceAgreed !== true)
        return problem(403, 'userActionRequired', 'must agree to terms of service')
      state.account = { id: 7, jwk: header.jwk, contact: payload?.contact ?? [], status: 'valid' }
      return json(201, accountBody(), { location: `${base}/acme/acct/7` })
    }
    const acct = /^\/acme\/acct\/(\d+)$/.exec(path)
    if (acct) {
      if (!state.account || String(state.account.id) !== acct[1])
        return problem(403, 'unauthorized', 'wrong account')
      if (payload?.status === 'deactivated') {
        state.account.status = 'deactivated'
        state.deactivated.push(state.account.id)
      }
      if (payload?.contact) state.account.contact = payload.contact
      return json(200, accountBody())
    }
    if (!header.kid) return problem(400, 'malformed', 'kid required')
    if (path === '/acme/new-order') {
      if (state.echo) return problem(400, 'malformed', `bad request ${state.echo}`)
      if (state.rateLimitSeconds)
        return problem(429, 'rateLimited', 'too many certificates already issued', {
          'retry-after': String(state.rateLimitSeconds)
        })
      const identifiers = payload.identifiers as Order['identifiers']
      const authz = identifiers.map((i) => {
        const wildcard = i.value.startsWith('*.')
        const a: Authz = {
          id: ++ids,
          base: wildcard ? i.value.slice(2) : i.value,
          wildcard,
          token: `token-${ids}`,
          status: 'pending'
        }
        state.authzs.push(a)
        return a.id
      })
      const o: Order = { id: ++ids, identifiers, authz, status: 'pending' }
      state.orders.push(o)
      return json(201, orderBody(o), { location: `${base}/acme/order/${o.id}` })
    }
    const az = /^\/acme\/authz\/(\d+)$/.exec(path)
    if (az) {
      const a = state.authzs.find((x) => x.id === Number(az[1]))
      if (!a) return problem(404, 'malformed', 'no such authz')
      if (payload?.status === 'deactivated') {
        a.status = 'invalid'
        return json(200, authzBody(a))
      }
      return json(200, authzBody(a))
    }
    const ch = /^\/acme\/chall\/(\d+)$/.exec(path)
    if (ch) {
      const a = state.authzs.find((x) => x.id === Number(ch[1]))
      if (!a) return problem(404, 'malformed', 'no such challenge')
      if (payload && a.status === 'pending') {
        // The DNS-01 check: the TXT must hold the key authorization digest.
        const want = b64u(
          createHash('sha256')
            .update(`${a.token}.${thumbprint(state.account?.jwk)}${state.breakProof ? 'x' : ''}`)
            .digest()
        )
        const have = txt.get(`_acme-challenge.${a.base}`) ?? []
        const seen = have.map((v) => v.replace(/^"|"$/g, ''))
        a.status = seen.includes(want) ? 'valid' : 'invalid'
        if (a.status === 'invalid') state.deniedChallenges++
      }
      return json(200, authzBody(a).challenges[1])
    }
    const fin = /^\/acme\/finalize\/(\d+)$/.exec(path)
    if (fin) {
      const o = state.orders.find((x) => x.id === Number(fin[1]))
      if (!o) return problem(404, 'malformed', 'no such order')
      if (o.authz.some((id) => state.authzs.find((a) => a.id === id)?.status !== 'valid'))
        return problem(403, 'orderNotReady', 'order is not ready')
      o.status = 'valid'
      o.certId = `fake-cert-${o.id}`
      return json(200, orderBody(o), { location: `${base}/acme/order/${o.id}` })
    }
    const ord = /^\/acme\/order\/(\d+)$/.exec(path)
    if (ord) {
      const o = state.orders.find((x) => x.id === Number(ord[1]))
      return o ? json(200, orderBody(o)) : problem(404, 'malformed', 'no such order')
    }
    const cert = /^\/acme\/cert\/(.+)$/.exec(path)
    if (cert) {
      if (cert[1] === 'gone') return problem(404, 'malformed', 'certificate not found')
      return new Response(state.chain, {
        status: 200,
        headers: {
          'content-type': 'application/pem-certificate-chain',
          'replay-nonce': `nonce-${++nonce}`
        }
      })
    }
    return problem(404, 'malformed', `unknown ${path}`)
  }

  function accountBody() {
    return { status: state.account?.status ?? 'valid', contact: state.account?.contact ?? [] }
  }

  // ── Cloudflare ──
  function cf(url: URL, method: string, init: any): Response {
    const ok = (result: unknown) =>
      new Response(JSON.stringify({ success: true, errors: [], result }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    const m = /^\/client\/v4\/zones\/([^/]+)(\/dns_records(?:\/([^/]+))?)?$/.exec(url.pathname)
    if (!m)
      return new Response('{"success":false,"errors":[{"message":"not found"}]}', { status: 404 })
    if (m[1] !== CF_ZONE)
      return new Response('{"success":false,"errors":[{"message":"zone not found"}]}', {
        status: 404
      })
    if (!m[2])
      return ok({
        id: CF_ZONE,
        name: ZONE_NAME,
        account: { id: opts.cfForeignZone ? 'ffffffffffffffffffffffffffffffff' : CF_ACCOUNT }
      })
    if (method === 'GET') {
      const type = url.searchParams.get('type')
      const name = url.searchParams.get('name')
      return ok(cfRecords.filter((r) => (!type || r.type === type) && (!name || r.name === name)))
    }
    if (method === 'POST') {
      const b = JSON.parse(String(init.body))
      const r = {
        id: `0000000000000000000000000000${String(++ids).padStart(4, '0')}`,
        type: b.type,
        name: b.name,
        content: b.content,
        comment: b.comment
      }
      cfRecords.push(r)
      txt.set(r.name, [...(txt.get(r.name) ?? []), r.content])
      return ok(r)
    }
    if (method === 'DELETE' && m[3]) {
      const i = cfRecords.findIndex((r) => r.id === m[3])
      if (i >= 0) {
        const [r] = cfRecords.splice(i, 1)
        txt.set(
          r.name,
          (txt.get(r.name) ?? []).filter((v) => v !== r.content)
        )
      }
      return ok({ id: m[3] })
    }
    return new Response('{}', { status: 405 })
  }

  // ── Route 53 ──
  const xml = (body: string) =>
    new Response(`<?xml version="1.0"?>${body}`, {
      status: 200,
      headers: { 'content-type': 'text/xml' }
    })
  const r53Sets = new Map<string, { ttl: number; values: string[] }>()
  const r53Changes: string[] = []
  function r53(url: URL, method: string, init: any): Response {
    const p = url.pathname
    if (method === 'GET' && p === `/2013-04-01/hostedzone/${R53_ZONE}`)
      return xml(
        `<GetHostedZoneResponse><HostedZone><Id>/hostedzone/${R53_ZONE}</Id><Name>${ZONE_NAME}.</Name><Config><PrivateZone>${opts.r53Private ? 'true' : 'false'}</PrivateZone></Config><ResourceRecordSetCount>2</ResourceRecordSetCount></HostedZone></GetHostedZoneResponse>`
      )
    if (method === 'GET' && p === `/2013-04-01/hostedzone/${R53_ZONE}/rrset`) {
      const name = (url.searchParams.get('name') ?? '').replace(/\.$/, '')
      const set = r53Sets.get(name)
      return xml(
        `<ListResourceRecordSetsResponse><ResourceRecordSets>${
          set
            ? `<ResourceRecordSet><Name>${name}.</Name><Type>TXT</Type><TTL>${set.ttl}</TTL><ResourceRecords>${set.values
                .map(
                  (v) =>
                    `<ResourceRecord><Value>${v.replace(/"/g, '&quot;')}</Value></ResourceRecord>`
                )
                .join('')}</ResourceRecords></ResourceRecordSet>`
            : ''
        }</ResourceRecordSets><IsTruncated>false</IsTruncated></ListResourceRecordSetsResponse>`
      )
    }
    if (method === 'POST' && p === `/2013-04-01/hostedzone/${R53_ZONE}/rrset/`) {
      const body = String(init.body)
      const action = /<Action>(\w+)<\/Action>/.exec(body)?.[1]
      const name = /<Name>([^<]+)<\/Name>/.exec(body)?.[1]?.replace(/\.$/, '') ?? ''
      const ttl = Number(/<TTL>(\d+)<\/TTL>/.exec(body)?.[1] ?? 60)
      const values = [...body.matchAll(/<Value>([^<]*)<\/Value>/g)].map((x) =>
        x[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&')
      )
      if (action === 'UPSERT') {
        r53Sets.set(name, { ttl, values })
        txt.set(name, values)
      } else if (action === 'DELETE') {
        r53Sets.delete(name)
        txt.set(name, [])
      }
      r53Changes.push(`${action} ${name}`)
      return xml(
        `<ChangeResourceRecordSetsResponse><ChangeInfo><Id>/change/C${r53Changes.length}</Id><Status>PENDING</Status></ChangeInfo></ChangeResourceRecordSetsResponse>`
      )
    }
    if (method === 'GET' && /^\/2013-04-01\/change\/C\d+$/.test(p))
      return xml(
        `<GetChangeResponse><ChangeInfo><Id>${p.split('/').pop()}</Id><Status>INSYNC</Status></ChangeInfo></GetChangeResponse>`
      )
    return new Response('<Error><Code>NoSuchHostedZone</Code><Message>no</Message></Error>', {
      status: 404
    })
  }

  async function fetchImpl(url: string, init: any = {}): Promise<Response> {
    const u = new URL(url)
    const method = String(init?.method ?? 'GET').toUpperCase()
    let body: any
    try {
      body = init?.body ? JSON.parse(String(init.body)) : undefined
    } catch {
      body = String(init?.body ?? '')
    }
    calls.push({ host: u.hostname, method, path: u.pathname, body })
    if (u.hostname === host) return acme(u, method, init)
    if (u.hostname === 'api.cloudflare.com') return cf(u, method, init)
    if (u.hostname === 'route53.amazonaws.com') return r53(u, method, init)
    return new Response('unexpected host', { status: 599 })
  }

  return { fetchImpl, calls, txt, cfRecords, r53Sets, r53Changes, state, host, base }
}

export type World = ReturnType<typeof makeWorld>
