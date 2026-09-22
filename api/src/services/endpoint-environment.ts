/**
 * Which environment an integration endpoint points at (#534).
 *
 * The go-live audit found UAT and staging hosts on several enabled external
 * APIs, and mock mode is per instance — state that matters most on cutover
 * night and lived in scattered rows. This reads it off the host name so the
 * External APIs list and Integration Health can carry a TEST badge day to
 * day, and the readiness scorecard the same verdict. A heuristic, stated as
 * one: an operator who names a live host `test-` gets a badge to dismiss, not
 * a block.
 */

export type EndpointEnvironment = 'test' | 'live' | 'local' | 'unknown'

export interface EndpointVerdict {
  environment: EndpointEnvironment
  /** The token that decided it, for the tooltip. */
  reason: string | null
}

const LOCAL = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|host\.docker\.internal)$/i
const TEST_TOKENS = [
  'uat',
  'stg',
  'staging',
  'sandbox',
  'sbx',
  'test',
  'qa',
  'dev',
  'preprod',
  'pre-prod',
  'nonprod',
  'non-prod'
]

export function endpointEnvironment(baseUrl: string | null | undefined): EndpointVerdict {
  if (!baseUrl) return { environment: 'unknown', reason: null }
  let host = ''
  try {
    host = new URL(baseUrl).hostname
  } catch {
    host = String(baseUrl)
      .replace(/^[a-z]+:\/\//i, '')
      .split(/[/?#]/)[0]
  }
  if (!host) return { environment: 'unknown', reason: null }
  if (LOCAL.test(host)) return { environment: 'local', reason: host }
  const labels = host.toLowerCase().split(/[.\-_]/)
  for (const t of TEST_TOKENS) {
    if (labels.includes(t)) return { environment: 'test', reason: `host label "${t}"` }
  }
  return { environment: 'live', reason: null }
}
