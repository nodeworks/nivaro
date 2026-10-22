import { type ArmedFault, registerFault } from '../catalog.js'
import { armedFaults, chaosPoint, targetMatches } from '../registry.js'

/**
 * Partner faults (#1773): a chaos profile over the external-API layer (#66 mock mode), armed
 * through the registry — the API's saved config (mock_config, retry policy) is never edited.
 * `callExternalApi` asks `partnerFault(api)` per attempt (so a share target fails some
 * attempts and inline retries can recover) and lets the fault answer instead of the network:
 * added latency, a 500, a 429 with Retry-After, a 200 whose body says ERROR, malformed JSON,
 * or a TLS failure thrown in the shape Node's fetch throws it. ERP pushes go through the same
 * call, so the push outcome / response_error paths see the fault too.
 *
 * Synthetic answers carry `x-nivaro-chaos: 1`, so the call logs show which ones a drill made.
 */

export type PartnerMode =
  | 'latency'
  | 'error_500'
  | 'rate_limited_429'
  | 'error_body_200'
  | 'malformed_json'
  | 'tls_failure'

const MODES: PartnerMode[] = [
  'latency',
  'error_500',
  'rate_limited_429',
  'error_body_200',
  'malformed_json',
  'tls_failure'
]

/** Does this fault name the API (blank = every API; a name or a numeric id)? */
export function apiMatches(fault: ArmedFault, api: { id: number | string; name: string }): boolean {
  const want = String(fault.params.api ?? '')
    .trim()
    .toLowerCase()
  return !want || want === String(api.name).toLowerCase() || want === String(api.id)
}

/** The partner fault acting on this call to `api`, or null (the usual answer, O(1)). */
export function partnerFault(api: { id: number | string; name: string }): ArmedFault | null {
  const first = chaosPoint('external.call')
  if (!first) return null
  if (apiMatches(first, api)) return first
  // Several partner faults armed for different APIs: look past the first.
  for (const f of armedFaults()) {
    if (f.id !== first.id && f.fault_key === 'partner_faults' && apiMatches(f, api)) {
      if (targetMatches(f, undefined)) return f
    }
  }
  return null
}

function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(t)
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

const JSON_HEADERS = { 'content-type': 'application/json', 'x-nivaro-chaos': '1' }

function errorBody(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.trim() : ''
  if (s) {
    try {
      const parsed = JSON.parse(s)
      if (parsed && typeof parsed === 'object') return JSON.stringify(parsed)
    } catch {
      /* fall back to the default body */
    }
  }
  return JSON.stringify({
    status: 'ERROR',
    api_status: 'ERROR',
    message: 'Chaos drill: the partner answered 200 with an error in the body'
  })
}

/** The TLS failure Node's fetch throws (undici wraps the socket error as `cause`). */
export function tlsError(): Error {
  return Object.assign(new TypeError('fetch failed'), {
    cause: Object.assign(new Error('certificate has expired'), { code: 'CERT_HAS_EXPIRED' })
  })
}

/**
 * What the partner "answers" under the fault. `real` is the call it stands in for (the network
 * fetch, or null in mock mode): latency waits then makes the real call (null when there is
 * none); every other mode answers itself or throws. Honors the caller's abort signal.
 */
export async function partnerChaosFetch(
  fault: ArmedFault,
  real: (() => Promise<Response>) | null,
  signal?: AbortSignal | null
): Promise<Response | null> {
  const mode = (
    MODES.includes(fault.params.mode as PartnerMode) ? fault.params.mode : 'error_500'
  ) as PartnerMode
  const delay = Math.max(0, Number(fault.params.delay_ms) || 0)
  if (delay > 0) await sleep(delay, signal)
  switch (mode) {
    case 'latency':
      return real ? real() : null
    case 'error_500':
      return new Response(JSON.stringify({ error: 'Internal Server Error' }), {
        status: 500,
        headers: JSON_HEADERS
      })
    case 'rate_limited_429':
      return new Response(JSON.stringify({ error: 'Too Many Requests' }), {
        status: 429,
        headers: {
          ...JSON_HEADERS,
          'retry-after': String(Math.max(1, Number(fault.params.retry_after_s) || 30))
        }
      })
    case 'error_body_200':
      return new Response(errorBody(fault.params.error_body), {
        status: 200,
        headers: JSON_HEADERS
      })
    case 'malformed_json':
      return new Response('{"data": [{"id": 1, "status": "OK"', {
        status: 200,
        headers: JSON_HEADERS
      })
    case 'tls_failure':
      throw tlsError()
  }
}

/** A synthetic answer as `callExternalApi` returns one (headers, parsed JSON or text). */
export async function readChaosResponse(
  res: Response
): Promise<{ status: number; headers: Record<string, string>; body: unknown; text: string }> {
  const headers: Record<string, string> = {}
  res.headers.forEach((v, k) => {
    headers[k] = v
  })
  const text = await res.text()
  let body: unknown = text
  if ((res.headers.get('content-type') ?? '').includes('application/json')) {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }
  return { status: res.status, headers, body, text }
}

registerFault({
  key: 'partner_faults',
  label: 'Partner failing',
  area: 'outbound',
  proves:
    'A failing partner is contained: inline retries recover what they may, a 429 waits as Retry-After says, a 200 that says ERROR is not taken as success, unreadable answers and TLS failures land as clear errors in the call log and the Integrations console, and the record that triggered the call stays saved.',
  claim_keys: ['partners.breaker_retry'],
  targets: ['all', 'share'],
  params: {
    api: {
      type: 'string',
      label: 'External API (name or id; blank = every API)',
      default: '',
      max_length: 200,
      pattern: '^[\\w .:/-]*$'
    },
    mode: {
      type: 'enum',
      label: 'Answer',
      options: MODES,
      default: 'error_500'
    },
    delay_ms: {
      type: 'number',
      label: 'Added before the answer',
      min: 0,
      max: 30000,
      default: 0,
      unit: 'ms'
    },
    retry_after_s: {
      type: 'number',
      label: 'Retry-After (429)',
      min: 1,
      max: 3600,
      default: 30,
      unit: 's'
    },
    error_body: {
      type: 'string',
      label: 'Error body (200 with ERROR; JSON, blank = status: ERROR)',
      default: '',
      max_length: 2000
    }
  },
  max_seconds: 600,
  default_seconds: 60,
  points: ['external.call'],
  danger: 'medium',
  hypothesis_defaults: [{ sampler: 'http.5xx_pct', op: '<', limit: 1, tolerance: 0.5 }]
})
