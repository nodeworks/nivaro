/**
 * Contract from real traffic (#623).
 *
 * Reads the last successful answers an endpoint gave — the flight recorder's
 * bodies (24 h) plus the verbose call log (30 days) — and proposes the
 * contract those answers already satisfy: the statuses seen, and every path
 * present in EVERY sample with the type it always had. The admin accepts the
 * proposal into the endpoint's contract with one click; nothing is saved here.
 */
import { db } from '../db/index.js'
import type { EndpointContract } from './external-api-contracts.js'

type JsonType = 'string' | 'number' | 'boolean' | 'array' | 'object'

function typeOf(v: unknown): JsonType | 'null' {
  if (Array.isArray(v)) return 'array'
  if (v === null) return 'null'
  return typeof v as JsonType
}

const MAX_DEPTH = 4
const MAX_PATHS = 30

/** Every path in one body → its type, arrays walked through their first element. */
function collectPaths(body: unknown, prefix = '', depth = 0, out = new Map<string, string>()) {
  if (depth > MAX_DEPTH || body == null || typeof body !== 'object') return out
  if (Array.isArray(body)) {
    if (!body.length) return out
    const p = `${prefix}[0]`
    out.set(p, typeOf(body[0]))
    collectPaths(body[0], p, depth + 1, out)
    return out
  }
  for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
    if (!/^[A-Za-z0-9_$-]+$/.test(k)) continue // walkPath cannot address it
    const p = prefix ? `${prefix}.${k}` : k
    out.set(p, typeOf(v))
    collectPaths(v, p, depth + 1, out)
  }
  return out
}

export interface InferenceResult {
  contract: EndpointContract
  samples: number
  statuses: number[]
  paths_seen: number
  notes: string[]
}

/**
 * Pure: the contract a set of successful answers agrees on. A path must
 * appear in every JSON sample; its type is kept when every sample agrees and
 * never null (null in any sample drops the type, not the path). Shallow paths
 * win when the list is capped.
 */
export function inferContract(
  samples: Array<{ status: number; body: unknown }>
): InferenceResult | null {
  if (!samples.length) return null
  const notes: string[] = []
  const statuses = [...new Set(samples.map((s) => s.status))].sort((a, b) => a - b)
  const json = samples.filter((s) => s.body != null && typeof s.body === 'object')
  const contract: EndpointContract = {
    expect_status: statuses.length === 1 ? statuses[0] : statuses
  }
  if (json.length < samples.length) {
    contract.expect_json = false
    notes.push(
      `${samples.length - json.length} of ${samples.length} answers were not JSON — body checks left out`
    )
    return { contract, samples: samples.length, statuses, paths_seen: 0, notes }
  }
  const maps = json.map((s) => collectPaths(s.body))
  const common: Array<{ path: string; type?: JsonType }> = []
  for (const [path] of maps[0]) {
    if (!maps.every((m) => m.has(path))) continue
    // A path that was ever null keeps its place but not its type — the
    // contract must not fail the next null.
    const types = new Set(maps.map((m) => m.get(path)))
    common.push(
      types.size === 1 && !types.has('null') ? { path, type: [...types][0] as JsonType } : { path }
    )
  }
  const depth = (p: string) => p.split(/\.|\[/).length
  common.sort((a, b) => depth(a.path) - depth(b.path) || a.path.localeCompare(b.path))
  // Shallowest first, trimmed to the cap.
  const kept = common.slice(0, MAX_PATHS)
  if (common.length > MAX_PATHS)
    notes.push(`${common.length} stable paths — kept the ${MAX_PATHS} shallowest`)
  if (samples.length < 5)
    notes.push(`Only ${samples.length} answer${samples.length === 1 ? '' : 's'} to learn from`)
  contract.expect_paths = kept.map((c) =>
    c.type ? { path: c.path, type: c.type } : { path: c.path }
  )
  return { contract, samples: samples.length, statuses, paths_seen: common.length, notes }
}

/** `/items/{id}` or `/items/:id` → a regex over recorded paths. */
export function pathPattern(template: string): RegExp {
  const clean = (template || '/').split('?')[0]
  const norm = clean.startsWith('/') ? clean : `/${clean}`
  const esc = norm
    .split(/(\{[^}]+\}|:[A-Za-z_][A-Za-z0-9_]*)/)
    .map((part, i) => (i % 2 === 1 ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('')
  return new RegExp(`^${esc}/?$`)
}

function parseBody(text: string | null): { ok: boolean; body: unknown } {
  if (text == null || text === '') return { ok: false, body: null }
  if (/… \[truncated\]$/.test(text)) return { ok: false, body: null }
  try {
    return { ok: true, body: JSON.parse(text) }
  } catch {
    return { ok: true, body: text }
  }
}

/** The last (≤50) successful answers an endpoint gave, newest first. */
export async function endpointSamples(
  endpointId: number,
  limit = 50
): Promise<Array<{ status: number; body: unknown; at: Date; source: string }>> {
  const ep = (await db('nivaro_external_api_endpoints').where({ id: endpointId }).first()) as
    | { id: number; api_id: number; method: string; path: string }
    | undefined
  if (!ep) throw new Error('Endpoint not found')
  const method = (ep.method || 'GET').toUpperCase()
  const re = pathPattern(ep.path)
  const out: Array<{ status: number; body: unknown; at: Date; source: string }> = []

  const recorded = (await db('nivaro_outbound_log')
    .where({ api_id: ep.api_id, method, ok: true })
    .whereNotNull('response_body')
    .orderBy('id', 'desc')
    .limit(500)
    .select('status', 'path', 'endpoint_id', 'response_body', 'created_at')
    .catch(() => [])) as Array<{
    status: number
    path: string | null
    endpoint_id: number | null
    response_body: string | null
    created_at: Date
  }>
  for (const r of recorded) {
    const p = r.path ?? ''
    if (p.endsWith(' [mock]')) continue
    if (r.endpoint_id !== ep.id && !(r.endpoint_id == null && re.test(p))) continue
    const b = parseBody(r.response_body)
    if (b.ok)
      out.push({ status: Number(r.status), body: b.body, at: r.created_at, source: 'recorder' })
  }

  const logged = (await db('nivaro_external_api_logs')
    .where({ api_id: ep.api_id, method })
    .where('response_status', '>=', 200)
    .where('response_status', '<', 300)
    .whereNotNull('response_body')
    .orderBy('id', 'desc')
    .limit(500)
    .select('response_status', 'url', 'endpoint_id', 'response_body', 'created_at')
    .catch(() => [])) as Array<{
    response_status: number
    url: string
    endpoint_id: number | null
    response_body: string | null
    created_at: Date
  }>
  for (const r of logged) {
    if (r.url?.startsWith('mock://')) continue
    let path = ''
    try {
      path = new URL(r.url).pathname
    } catch {
      path = r.url ?? ''
    }
    if (r.endpoint_id !== ep.id && !(r.endpoint_id == null && re.test(path))) continue
    const b = parseBody(r.response_body)
    if (b.ok)
      out.push({
        status: Number(r.response_status),
        body: b.body,
        at: r.created_at,
        source: 'call_log'
      })
  }
  return out
    .sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
    .slice(0, Math.min(50, Math.max(1, limit)))
}

export async function inferContractForEndpoint(
  endpointId: number
): Promise<
  | (InferenceResult & { oldest: string | null; newest: string | null })
  | { contract: null; samples: 0; notes: string[] }
> {
  const samples = await endpointSamples(endpointId, 50)
  const res = inferContract(samples.map((s) => ({ status: s.status, body: s.body })))
  if (!res)
    return {
      contract: null,
      samples: 0,
      notes: [
        'No successful answers with a body were recorded for this endpoint — the recorder keeps bodies for 24 hours, the call log for 30 days.'
      ]
    }
  return {
    ...res,
    newest: samples[0] ? new Date(samples[0].at).toISOString() : null,
    oldest: samples.length ? new Date(samples[samples.length - 1].at).toISOString() : null
  }
}
