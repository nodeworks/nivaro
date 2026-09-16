import { db } from '../db/index.js'
import { callExternalApi } from './external-apis.js'

// ─── #74 — endpoint contract tests ─────────────────────────────────────────
// A contract says what a healthy answer from an endpoint looks like. The run
// calls the endpoint through callExternalApi (auth, instance overrides and
// mock mode all apply) and judges the response; the verdict is stamped on the
// endpoint row so the editor and the nightly sweep read the same truth.

export interface EndpointContract {
  /** Accepted HTTP status(es); default 2xx. */
  expect_status?: number | number[]
  /** Body must parse as JSON (default true). */
  expect_json?: boolean
  /** Paths that must exist on the body — `a.b[0].c` — with an optional type / value. */
  expect_paths?: Array<{
    path: string
    type?: 'string' | 'number' | 'boolean' | 'array' | 'object' | 'any'
    equals?: unknown
  }>
  /** Contracts run GET/HEAD only unless the endpoint author opts a mutation in. */
  allow_mutation?: boolean
  timeout_ms?: number
}

export interface ContractRunResult {
  endpoint_id: number
  api_id: number
  ok: boolean
  status: number | null
  duration_ms: number
  detail: string
  skipped?: boolean
}

function parseJson<T>(v: unknown): T | null {
  if (v == null || v === '') return null
  if (typeof v !== 'string') return v as T
  try {
    return JSON.parse(v) as T
  } catch {
    return null
  }
}

export function walkPath(body: unknown, path: string): { found: boolean; value: unknown } {
  const parts = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean)
  let cur: unknown = body
  for (const p of parts) {
    if (cur == null || typeof cur !== 'object') return { found: false, value: undefined }
    if (!(p in (cur as Record<string, unknown>))) return { found: false, value: undefined }
    cur = (cur as Record<string, unknown>)[p]
  }
  return { found: true, value: cur }
}

function typeOf(v: unknown): string {
  if (Array.isArray(v)) return 'array'
  if (v === null) return 'null'
  return typeof v
}

/** Pure judge — exported for unit tests. */
export function judgeContract(
  contract: EndpointContract,
  status: number,
  body: unknown
): { ok: boolean; problems: string[] } {
  const problems: string[] = []
  const expected = contract.expect_status
  if (expected === undefined) {
    if (status < 200 || status >= 300) problems.push(`status ${status} (expected 2xx)`)
  } else {
    const list = Array.isArray(expected) ? expected : [expected]
    if (!list.includes(status)) problems.push(`status ${status} (expected ${list.join(' or ')})`)
  }
  if (contract.expect_json !== false && (body === null || typeof body !== 'object')) {
    problems.push('body is not JSON')
  }
  for (const p of contract.expect_paths ?? []) {
    const { found, value } = walkPath(body, p.path)
    if (!found) {
      problems.push(`missing ${p.path}`)
      continue
    }
    if (p.type && p.type !== 'any' && typeOf(value) !== p.type) {
      problems.push(`${p.path} is ${typeOf(value)}, expected ${p.type}`)
    }
    if ('equals' in p && JSON.stringify(value) !== JSON.stringify(p.equals)) {
      problems.push(`${p.path} = ${JSON.stringify(value)}, expected ${JSON.stringify(p.equals)}`)
    }
  }
  return { ok: problems.length === 0, problems }
}

interface EndpointRow {
  id: number
  api_id: number
  name: string
  method: string
  contract: string | null
}

export async function runEndpointContract(endpointId: number): Promise<ContractRunResult> {
  const ep = (await db('nivaro_external_api_endpoints').where({ id: endpointId }).first()) as
    | EndpointRow
    | undefined
  if (!ep) throw new Error('Endpoint not found')
  const contract = parseJson<EndpointContract>(ep.contract)
  if (!contract) throw new Error('Endpoint has no contract')
  const method = (ep.method ?? 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'HEAD' && !contract.allow_mutation) {
    const detail = `${method} endpoint — contract runs need allow_mutation: true`
    await stamp(ep.id, null, detail)
    return {
      endpoint_id: ep.id,
      api_id: ep.api_id,
      ok: false,
      status: null,
      duration_ms: 0,
      detail,
      skipped: true
    }
  }
  const t0 = Date.now()
  let status: number | null = null
  let verdict: { ok: boolean; problems: string[] }
  try {
    const res = await callExternalApi(ep.api_id, {
      endpoint: ep.id,
      timeoutMs: contract.timeout_ms ?? 15_000,
      _log: { triggeredBy: 'contract' }
    })
    status = res.status
    verdict = judgeContract(contract, res.status, res.body)
  } catch (err) {
    verdict = { ok: false, problems: [err instanceof Error ? err.message : String(err)] }
  }
  const duration_ms = Date.now() - t0
  const detail = verdict.ok
    ? `OK · ${status} in ${duration_ms}ms`
    : `${verdict.problems.join('; ')} (${duration_ms}ms)`
  await stamp(ep.id, verdict.ok, detail)
  return { endpoint_id: ep.id, api_id: ep.api_id, ok: verdict.ok, status, duration_ms, detail }
}

async function stamp(id: number, ok: boolean | null, detail: string): Promise<void> {
  await db('nivaro_external_api_endpoints')
    .where({ id })
    .update({
      contract_last_run: new Date(),
      contract_last_ok: ok,
      contract_last_detail: detail.slice(0, 2000)
    })
    .catch(() => {})
}

/** Every endpoint carrying a contract on an enabled API. */
export async function contractTargets(
  apiId?: number
): Promise<Array<{ id: number; api_id: number; name: string; api_name: string; method: string }>> {
  let q = db('nivaro_external_api_endpoints as e')
    .join('nivaro_external_apis as a', 'a.id', 'e.api_id')
    .whereNotNull('e.contract')
    .where('a.enabled', true)
  if (apiId != null) q = q.where('e.api_id', apiId)
  return (await q
    .orderBy('a.name')
    .orderBy('e.sort')
    .select('e.id', 'e.api_id', 'e.name', 'a.name as api_name', 'e.method')) as Array<{
    id: number
    api_id: number
    name: string
    api_name: string
    method: string
  }>
}

export async function runContracts(apiId?: number): Promise<ContractRunResult[]> {
  const targets = await contractTargets(apiId)
  const out: ContractRunResult[] = []
  for (const t of targets) {
    try {
      out.push(await runEndpointContract(t.id))
    } catch (err) {
      out.push({
        endpoint_id: t.id,
        api_id: t.api_id,
        ok: false,
        status: null,
        duration_ms: 0,
        detail: err instanceof Error ? err.message : String(err)
      })
    }
  }
  return out
}
