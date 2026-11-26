import { createHash, createHmac } from 'node:crypto'

/**
 * AWS Signature Version 4 for a plain `fetch` (no AWS SDK). Follows the published algorithm and
 * is checked against AWS's sig-v4 test suite (`get-vanilla`, see the contract test).
 *
 * What it signs: every header the caller passes, plus `host` (from the URL), `x-amz-date`, the
 * session token (`x-amz-security-token`) when there is one, and for S3 `x-amz-content-sha256`.
 * Returns the headers to send: the caller's (lower-cased) + the added ones + `authorization`.
 * `host` itself is signed but not returned — the transport sends the URL's host.
 */

export interface AwsSignRequest {
  method: string
  url: string
  headers?: Record<string, string>
  body?: string | Uint8Array | null
  /** 'ec2', 'rds', 's3', 'route53', 'sts', 'elasticloadbalancing', 'acm', … */
  service: string
  region: string
}

export interface AwsCredentials {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
}

const sha256Hex = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex')
const hmac = (key: string | Buffer, data: string) => createHmac('sha256', key).update(data).digest()

/** RFC 3986 encoding (encodeURIComponent leaves !'()* alone; AWS does not). */
export function awsUriEncode(s: string): string {
  return encodeURIComponent(s).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`
  )
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s)
  } catch {
    return s
  }
}

/** `20150830T123600Z` */
export function amzDate(now: Date): string {
  return now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}/, '')
}

function canonicalPath(pathname: string, service: string): string {
  if (service === 's3') {
    // S3: the path as the object key is, encoded once; no normalisation.
    const p = pathname
      .split('/')
      .map((seg) => awsUriEncode(safeDecode(seg)))
      .join('/')
    return p || '/'
  }
  // Every other service: normalised (no empty segments), each segment encoded twice.
  const segs = pathname.split('/').filter((s, i, all) => s !== '' || i === all.length - 1)
  const p = segs.map((seg) => awsUriEncode(awsUriEncode(safeDecode(seg)))).join('/')
  const out = `/${p}`.replace(/\/{2,}/g, '/')
  return out
}

function canonicalQuery(url: URL): string {
  const pairs: Array<[string, string]> = []
  for (const [k, v] of url.searchParams) pairs.push([awsUriEncode(k), awsUriEncode(v)])
  pairs.sort(([ak, av], [bk, bv]) => (ak < bk ? -1 : ak > bk ? 1 : av < bv ? -1 : av > bv ? 1 : 0))
  return pairs.map(([k, v]) => `${k}=${v}`).join('&')
}

const trimValue = (v: string) => v.trim().replace(/\s+/g, ' ')

/** The headers to send for this request, `authorization` included. */
export function signAwsRequest(
  req: AwsSignRequest,
  creds: AwsCredentials,
  now: Date = new Date()
): Record<string, string> {
  const url = new URL(req.url)
  const method = req.method.toUpperCase()
  const date = amzDate(now)
  const day = date.slice(0, 8)
  const body = req.body ?? ''
  const payloadHash = sha256Hex(body)

  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(req.headers ?? {})) {
    const name = k.toLowerCase()
    if (name === 'authorization' || name === 'host') continue
    out[name] = String(v)
  }
  out['x-amz-date'] = date
  if (creds.sessionToken) out['x-amz-security-token'] = creds.sessionToken
  if (req.service === 's3') out['x-amz-content-sha256'] = payloadHash

  const signed: Record<string, string> = { ...out, host: url.host }
  const names = Object.keys(signed).sort()
  const canonicalHeaders = names.map((n) => `${n}:${trimValue(signed[n])}\n`).join('')
  const signedHeaders = names.join(';')

  const canonicalRequest = [
    method,
    canonicalPath(url.pathname, req.service),
    canonicalQuery(url),
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n')

  const scope = `${day}/${req.region}/${req.service}/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', date, scope, sha256Hex(canonicalRequest)].join('\n')

  const kDate = hmac(`AWS4${creds.secretAccessKey}`, day)
  const kRegion = hmac(kDate, req.region)
  const kService = hmac(kRegion, req.service)
  const kSigning = hmac(kService, 'aws4_request')
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex')

  out.authorization = `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`
  return out
}
