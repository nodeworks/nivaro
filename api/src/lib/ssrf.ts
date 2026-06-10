import { promises as dnsPromises } from 'node:dns'
import { isIP } from 'node:net'

const PRIVATE_HOST_RE =
  /^(localhost|.*\.local|.*\.internal)$|^(10|127)\.\d+\.\d+\.\d+$|^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$|^192\.168\.\d+\.\d+$|^169\.254\.\d+\.\d+$|^0\.0\.0\.0$|^\[?::1\]?$|^\[?fe80:/i

function isPrivateHost(hostname: string): boolean {
  return PRIVATE_HOST_RE.test(hostname)
}

/**
 * Throws if the URL is non-http(s), targets a private/loopback host, or resolves
 * to a private IP (DNS rebinding guard). Used by outbound fetch callers and the
 * extension callExternalApi context before any server-side HTTP request.
 */
export async function assertSafeUrl(rawUrl: string): Promise<void> {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error('Invalid URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http and https URLs are allowed')
  }
  const hostname = parsed.hostname.toLowerCase().replace(/^\[|]$/g, '')
  if (isPrivateHost(hostname)) {
    throw new Error('Requests to private/loopback addresses are not allowed')
  }
  if (!isIP(hostname)) {
    try {
      const addresses = await dnsPromises.lookup(hostname, { all: true, family: 0 })
      for (const { address } of addresses) {
        if (isPrivateHost(address)) {
          throw new Error('Hostname resolves to a private/reserved address')
        }
      }
    } catch (err) {
      if (
        err instanceof Error &&
        (err.message.includes('private') || err.message.includes('reserved'))
      ) {
        throw err
      }
      throw new Error('Hostname could not be resolved')
    }
  }
}
