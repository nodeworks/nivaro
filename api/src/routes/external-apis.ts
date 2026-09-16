import type { FastifyInstance } from 'fastify'
import { load as yamlLoad } from 'js-yaml'
import { db } from '../db/index.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import {
  contractTargets,
  runContracts,
  runEndpointContract
} from '../services/external-api-contracts.js'
import {
  instanceOverrideFor,
  mockConfigFor,
  resolveInstanceRow,
  writeApiCallLog
} from '../services/external-apis.js'
import { registerReadinessCheck } from '../services/readiness.js'
import { instanceKey } from '../services/settings-overrides.js'

// ─── Types ──────────────────────────────────────────────────────────────────

type AuthType = 'none' | 'bearer' | 'api_key' | 'basic' | 'oauth2_cc'

interface ExternalApiRow {
  id: number
  name: string
  base_url: string
  description: string | null
  auth_type: AuthType
  auth_config: string | null
  headers: string | null
  enabled: boolean
  integration_type: string | null
  integration_config: string | null
  retry_policy?: string | null
  outbound_contract?: string | null
  mock_config?: string | null
  instance_overrides?: string | null
  created_at: Date
  updated_at: Date
}

interface BearerConfig {
  token: string
}
interface ApiKeyConfig {
  key: string
  value: string
  in: 'header' | 'query'
  param_name: string
}
interface BasicConfig {
  username: string
  password: string
}
interface OAuth2CCConfig {
  client_id: string
  client_secret: string
  token_url: string
  scope?: string
}

// ─── Slug helper ────────────────────────────────────────────────────────────

function slugifyEndpoint(method: string, path: string, operationId?: string): string {
  if (operationId) {
    return operationId
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
  }
  return `${method.toLowerCase()}-${path
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')}`
}

// ─── Schema skeleton builder (OpenAPI → default body) ───────────────────────

function buildSchemaSkeleton(schema: Record<string, unknown>, depth = 0): unknown {
  if (depth > 3) return null
  if (!schema || typeof schema !== 'object') return null

  if (schema.example !== undefined) return schema.example

  const type = schema.type as string | undefined

  if (type === 'object' || schema.properties) {
    const props = schema.properties as Record<string, Record<string, unknown>> | undefined
    if (!props) return {}
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(props)) {
      out[k] = buildSchemaSkeleton(v, depth + 1) ?? ''
    }
    return out
  }

  if (type === 'array') {
    const items = schema.items as Record<string, unknown> | undefined
    return items ? [buildSchemaSkeleton(items, depth + 1)] : []
  }

  if (type === 'string') return ''
  if (type === 'integer' || type === 'number') return 0
  if (type === 'boolean') return false

  return null
}

// ─── JSON helpers ───────────────────────────────────────────────────────────

function parseJson<T = unknown>(val: string | null | undefined): T | null {
  if (val == null) return null
  try {
    return JSON.parse(val) as T
  } catch {
    return null
  }
}

function toJsonStr(val: unknown): string | null {
  if (val == null) return null
  return JSON.stringify(val)
}

// Secret field names masked in GET responses (kept structurally but obscured).
const SECRET_FIELDS = new Set(['token', 'password', 'client_secret', 'value'])
const MASK = '••••••'

const SECRET_HEADER_RE = /secret|token|password|key/i

function maskAuthConfig(cfg: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!cfg) return null
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(cfg)) {
    if (k === 'token_headers' && v && typeof v === 'object' && !Array.isArray(v)) {
      // Nested header credentials (SAT-style X-Client-Secret) are secrets too —
      // top-level-only masking returned them raw.
      out[k] = Object.fromEntries(
        Object.entries(v as Record<string, unknown>).map(([hk, hv]) => [
          hk,
          SECRET_HEADER_RE.test(hk) && hv ? MASK : hv
        ])
      )
    } else {
      out[k] = SECRET_FIELDS.has(k) && v ? MASK : v
    }
  }
  return out
}

// #66/#74 readiness: a mocked API on a production-shaped instance and any
// failing endpoint contract both warn on the scorecard. Registered once.
let readinessRegistered = false
function registerIntegrationReadiness(): void {
  if (readinessRegistered) return
  readinessRegistered = true
  registerReadinessCheck({
    id: 'external-api-mock-mode',
    label: 'No external API is mocked on this instance',
    description:
      'Mock mode answers integration calls from canned rules instead of the real system.',
    group: 'Integrations',
    run: async () => {
      const rows = (await db('nivaro_external_apis').select(
        'id',
        'name',
        'mock_config',
        'enabled'
      )) as ExternalApiRow[]
      const mocked = rows.filter((r) => r.enabled && mockConfigFor(r) != null).map((r) => r.name)
      if (mocked.length === 0)
        return { status: 'pass', detail: `No API mocked on instance "${instanceKey()}".` }
      return {
        status: 'warn',
        detail: `${mocked.length} API${mocked.length === 1 ? '' : 's'} mocked on "${instanceKey()}"`,
        blockers: mocked.map((n) => `${n} is answering from mock rules`)
      }
    }
  })
  registerReadinessCheck({
    id: 'external-api-contracts',
    label: 'Endpoint contracts pass',
    description: 'The last contract run of every external API endpoint that declares one.',
    group: 'Integrations',
    run: async () => {
      const rows = (await db('nivaro_external_api_endpoints as e')
        .join('nivaro_external_apis as a', 'a.id', 'e.api_id')
        .whereNotNull('e.contract')
        .where('a.enabled', true)
        .select(
          'e.name',
          'a.name as api_name',
          'e.contract_last_ok',
          'e.contract_last_detail',
          'e.contract_last_run'
        )) as Array<{
        name: string
        api_name: string
        contract_last_ok: boolean | null
        contract_last_detail: string | null
        contract_last_run: Date | null
      }>
      if (rows.length === 0) return { status: 'skip', detail: 'No endpoint declares a contract.' }
      const failing = rows.filter((r) => r.contract_last_ok === false)
      const never = rows.filter((r) => r.contract_last_run == null)
      if (failing.length === 0 && never.length === 0)
        return {
          status: 'pass',
          detail: `${rows.length} contract${rows.length === 1 ? '' : 's'} passing.`
        }
      return {
        status: failing.length ? 'fail' : 'warn',
        detail: `${failing.length} failing, ${never.length} never run`,
        blockers: [
          ...failing.map((r) => `${r.api_name} · ${r.name}: ${r.contract_last_detail ?? 'failed'}`),
          ...never.map((r) => `${r.api_name} · ${r.name}: never run`)
        ]
      }
    }
  })
}

// Serialize a row for client consumption — secrets masked.
function serializeForRead(row: ExternalApiRow) {
  return {
    id: row.id,
    name: row.name,
    base_url: row.base_url,
    description: row.description,
    auth_type: row.auth_type,
    auth_config: maskAuthConfig(parseJson<Record<string, unknown>>(row.auth_config)),
    headers: parseJson<Record<string, string>>(row.headers),
    enabled: !!row.enabled,
    integration_type: row.integration_type ?? null,
    integration_config: parseJson(row.integration_config),
    // #65 — the retry policy was PATCHable but never read back, so the editor
    // always showed it empty.
    retry_policy: parseJson(row.retry_policy) ?? null,
    outbound_contract: parseJson(row.outbound_contract) ?? null,
    // #66 — mock rules per instance + whether THIS instance is mocking.
    mock_config: parseJson(row.mock_config) ?? null,
    mock_active: mockConfigFor(row) != null,
    // #89 — per-instance overrides, credentials masked per instance.
    instance_overrides: maskInstanceOverrides(
      parseJson<
        Record<
          string,
          {
            base_url?: string
            auth_config?: Record<string, unknown>
            headers?: Record<string, string>
          }
        >
      >(row.instance_overrides)
    ),
    current_instance: instanceKey(),
    created_at: row.created_at,
    updated_at: row.updated_at
  }
}

function maskInstanceOverrides(
  all: Record<
    string,
    { base_url?: string; auth_config?: Record<string, unknown>; headers?: Record<string, string> }
  > | null
) {
  if (!all) return null
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(all)) {
    if (!v || typeof v !== 'object') continue
    out[k] = {
      ...v,
      auth_config: v.auth_config ? maskAuthConfig(v.auth_config) : undefined,
      headers: v.headers
        ? Object.fromEntries(
            Object.entries(v.headers).map(([hk, hv]) => [
              hk,
              SECRET_HEADER_RE.test(hk) && hv ? MASK : hv
            ])
          )
        : undefined
    }
  }
  return out
}

// Masked values coming back from the editor keep the stored secret (per instance).
function mergeInstanceOverrides(
  incoming:
    | Record<
        string,
        {
          base_url?: string
          auth_config?: Record<string, unknown>
          headers?: Record<string, string>
        } | null
      >
    | null
    | undefined,
  existingRaw: string | null | undefined
): string | null {
  if (incoming === undefined) return existingRaw ?? null
  if (incoming === null) return null
  const existing =
    parseJson<
      Record<string, { auth_config?: Record<string, unknown>; headers?: Record<string, string> }>
    >(existingRaw ?? null) ?? {}
  const out: Record<string, unknown> = {}
  for (const [key, v] of Object.entries(incoming)) {
    if (!v || typeof v !== 'object') continue
    if (!/^[A-Za-z0-9_.-]{1,60}$/.test(key)) continue
    const prev = existing[key]
    const entry: Record<string, unknown> = {}
    if (typeof v.base_url === 'string' && v.base_url.trim()) entry.base_url = v.base_url.trim()
    if (v.auth_config && typeof v.auth_config === 'object') {
      const merged = { ...v.auth_config }
      for (const [k, val] of Object.entries(merged)) {
        if (val === MASK && prev?.auth_config && prev.auth_config[k] != null)
          merged[k] = prev.auth_config[k]
      }
      if (Object.keys(merged).length) entry.auth_config = merged
    }
    if (v.headers && typeof v.headers === 'object') {
      const merged: Record<string, string> = { ...v.headers }
      for (const [k, val] of Object.entries(merged)) {
        if (val === MASK && prev?.headers && prev.headers[k] != null) merged[k] = prev.headers[k]
      }
      if (Object.keys(merged).length) entry.headers = merged
    }
    if (Object.keys(entry).length) out[key] = entry
  }
  return Object.keys(out).length ? JSON.stringify(out) : null
}

// When updating auth_config: if a secret field still holds the mask value, keep
// the existing stored secret rather than overwriting it with the mask.
function mergeAuthConfig(
  incoming: Record<string, unknown> | null | undefined,
  existing: Record<string, unknown> | null
): Record<string, unknown> | null {
  if (incoming === undefined) return existing
  if (incoming === null) return null
  const out: Record<string, unknown> = { ...incoming }
  for (const field of SECRET_FIELDS) {
    if (out[field] === MASK && existing && existing[field] != null) {
      out[field] = existing[field]
    }
  }
  // Nested token_headers: a still-masked header value keeps its stored secret.
  const inTh = out.token_headers
  const exTh = existing?.token_headers
  if (
    inTh &&
    typeof inTh === 'object' &&
    !Array.isArray(inTh) &&
    exTh &&
    typeof exTh === 'object'
  ) {
    const merged: Record<string, unknown> = { ...(inTh as Record<string, unknown>) }
    for (const [hk, hv] of Object.entries(merged)) {
      if (hv === MASK && (exTh as Record<string, unknown>)[hk] != null) {
        merged[hk] = (exTh as Record<string, unknown>)[hk]
      }
    }
    out.token_headers = merged
  }
  return out
}

// ─── Auth resolution for test calls ─────────────────────────────────────────

interface ResolvedAuth {
  headers: Record<string, string>
  queryParams: Record<string, string>
}

async function resolveAuth(
  authType: AuthType,
  cfg: Record<string, unknown> | null
): Promise<ResolvedAuth> {
  const headers: Record<string, string> = {}
  const queryParams: Record<string, string> = {}

  switch (authType) {
    case 'bearer': {
      const c = cfg as unknown as BearerConfig | null
      if (c?.token) headers.Authorization = `Bearer ${c.token}`
      break
    }
    case 'api_key': {
      const c = cfg as unknown as ApiKeyConfig | null
      if (c?.value) {
        const paramName = c.param_name || c.key
        if (c.in === 'query') {
          if (paramName) queryParams[paramName] = c.value
        } else if (paramName) {
          headers[paramName] = c.value
        }
      }
      break
    }
    case 'basic': {
      const c = cfg as unknown as BasicConfig | null
      if (c?.username != null) {
        const encoded = Buffer.from(`${c.username}:${c.password ?? ''}`).toString('base64')
        headers.Authorization = `Basic ${encoded}`
      }
      break
    }
    case 'oauth2_cc': {
      const c = cfg as unknown as OAuth2CCConfig | null
      if (c?.token_url && c.client_id) {
        const tokenRes = await fetch(c.token_url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: c.client_id,
            client_secret: c.client_secret ?? '',
            ...(c.scope ? { scope: c.scope } : {})
          })
        })
        const tokenBody = (await tokenRes.json()) as { access_token?: string }
        if (tokenBody.access_token) {
          headers.Authorization = `Bearer ${tokenBody.access_token}`
        }
      }
      break
    }
    default:
      break
  }

  return { headers, queryParams }
}

// ─── Routes ─────────────────────────────────────────────────────────────────

/**
 * A network-level failure reaches here as undici's bare "fetch failed" with
 * the real reason buried in `err.cause` (ECONNREFUSED, ENOTFOUND, a TLS
 * code…). The test panel showed only the outer message, so "the host is not
 * reachable from THIS server" read as a mystery. Surface the cause plus a
 * one-line hint; the caller still gets a plain string.
 */
export function describeFetchError(err: unknown): string {
  if (!(err instanceof Error)) return 'Request failed'
  if (err.name === 'AbortError') return 'Request timed out after 10s'
  const cause = (err as { cause?: unknown }).cause as
    | { code?: string; message?: string; address?: string; port?: number; hostname?: string }
    | undefined
  if (!cause || err.message !== 'fetch failed') return err.message
  const where = cause.hostname
    ? cause.hostname
    : cause.address
      ? `${cause.address}${cause.port ? `:${cause.port}` : ''}`
      : ''
  const code = cause.code ?? ''
  const hint: Record<string, string> = {
    ECONNREFUSED: 'the host refused the connection — wrong port, or the service is down',
    ENOTFOUND: 'DNS could not resolve the host from the API server',
    EAI_AGAIN: 'DNS lookup failed (temporary) from the API server',
    ETIMEDOUT: 'no answer from the host — firewall, VPN, or the server is not on that network',
    EHOSTUNREACH: 'no route to the host from the API server — internal network / VPN',
    ENETUNREACH: 'no route to the network from the API server',
    ECONNRESET: 'the host closed the connection mid-request',
    CERT_HAS_EXPIRED: 'the host presented an expired TLS certificate',
    UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'TLS certificate chain not trusted by the API server',
    SELF_SIGNED_CERT_IN_CHAIN: 'self-signed TLS certificate in the chain',
    DEPTH_ZERO_SELF_SIGNED_CERT: 'self-signed TLS certificate',
    ERR_TLS_CERT_ALTNAME_INVALID: 'TLS certificate does not match the host name'
  }
  const parts = ['fetch failed']
  if (code || where) parts.push(`— ${[code, where].filter(Boolean).join(' ')}`)
  if (code && hint[code]) parts.push(`(${hint[code]})`)
  else if (cause.message && cause.message !== err.message) parts.push(`(${cause.message})`)
  parts.push('· the request is made by the API server, not your browser')
  return parts.join(' ')
}

export async function externalApisRoutes(app: FastifyInstance) {
  // List all
  app.get('/', { preHandler: requireAdmin }, async () => {
    const rows = (await db('nivaro_external_apis').orderBy('name', 'asc')) as ExternalApiRow[]
    return { data: rows.map(serializeForRead) }
  })
  registerIntegrationReadiness()

  // Single
  app.get<{ Params: { id: string } }>('/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const row = (await db('nivaro_external_apis')
      .where({ id: Number(req.params.id) })
      .first()) as ExternalApiRow | undefined
    if (!row) return reply.code(404).send({ error: 'Not found' })
    return { data: serializeForRead(row) }
  })

  // Create
  app.post<{
    Body: {
      name: string
      base_url: string
      description?: string | null
      auth_type?: AuthType
      auth_config?: Record<string, unknown> | null
      headers?: Record<string, string> | null
      enabled?: boolean
      integration_type?: string | null
      integration_config?: unknown
    }
  }>('/', { preHandler: requireAdmin }, async (req, reply) => {
    const body = req.body
    if (!body?.name || !body?.base_url) {
      return reply.code(400).send({ error: 'name and base_url are required' })
    }
    const now = new Date()
    const [inserted] = await db('nivaro_external_apis')
      .insert({
        name: body.name,
        base_url: body.base_url,
        description: body.description ?? null,
        auth_type: body.auth_type ?? 'none',
        auth_config: toJsonStr(body.auth_config ?? null),
        headers: toJsonStr(body.headers ?? null),
        enabled: body.enabled ?? true,
        integration_type: body.integration_type ?? null,
        integration_config: toJsonStr(body.integration_config ?? null),
        created_at: now,
        updated_at: now
      })
      .returning('*')

    // MSSQL returning may yield the row or just the id depending on driver.
    const row =
      inserted && typeof inserted === 'object'
        ? (inserted as ExternalApiRow)
        : ((await db('nivaro_external_apis')
            .where({ id: inserted as number })
            .first()) as ExternalApiRow)

    await logActivity({
      action: 'create',
      collection: 'nivaro_external_apis',
      item: String(row.id),
      user: req.user?.id,
      req
    })
    return reply.code(201).send({ data: serializeForRead(row) })
  })

  // Update (partial merge)
  app.patch<{
    Params: { id: string }
    Body: Partial<{
      name: string
      base_url: string
      description: string | null
      auth_type: AuthType
      auth_config: Record<string, unknown> | null
      headers: Record<string, string> | null
      enabled: boolean
      integration_type: string | null
      integration_config: unknown
      retry_policy: {
        max_attempts?: number
        backoff_minutes?: number
        inline_retries?: number
        inline_backoff_ms?: number
        retry_on?: string[]
      } | null
      mock_config: Record<
        string,
        { enabled?: boolean; rules?: unknown[]; fallback?: unknown }
      > | null
      instance_overrides: Record<
        string,
        {
          base_url?: string
          auth_config?: Record<string, unknown>
          headers?: Record<string, string>
        } | null
      > | null
    }>
  }>('/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = Number(req.params.id)
    const existing = (await db('nivaro_external_apis').where({ id }).first()) as
      | ExternalApiRow
      | undefined
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    const body = req.body ?? {}
    const patch: Record<string, unknown> = { updated_at: new Date() }

    if (body.name !== undefined) patch.name = body.name
    if (body.retry_policy !== undefined) {
      // #469 — {max_attempts 1-10, backoff_minutes >= 1}; null disables.
      if (body.retry_policy === null) patch.retry_policy = null
      else {
        // The scheduled pair is optional as a PAIR (an inline-only policy is
        // valid); when either half is given, both must be, and be sane.
        const hasScheduled =
          body.retry_policy.max_attempts != null || body.retry_policy.backoff_minutes != null
        const max = hasScheduled ? Number(body.retry_policy.max_attempts) : undefined
        const back = hasScheduled ? Number(body.retry_policy.backoff_minutes) : undefined
        if (
          hasScheduled &&
          (!Number.isFinite(max) ||
            (max as number) < 1 ||
            (max as number) > 10 ||
            !Number.isFinite(back) ||
            (back as number) < 1)
        ) {
          return reply
            .code(400)
            .send({ error: 'retry_policy needs max_attempts 1-10 and backoff_minutes >= 1' })
        }
        // #65 — inline retries: transient failures (network / timeout / 5xx by
        // default) are re-attempted INSIDE callExternalApi, bounded to 3 with a
        // short backoff; the sweep-level policy above stays the slow path.
        const inline = Number(body.retry_policy.inline_retries ?? 0)
        const inlineBackoff = Number(body.retry_policy.inline_backoff_ms ?? 500)
        if (!Number.isInteger(inline) || inline < 0 || inline > 3) {
          return reply.code(400).send({ error: 'inline_retries must be 0–3' })
        }
        if (!Number.isFinite(inlineBackoff) || inlineBackoff < 100 || inlineBackoff > 10_000) {
          return reply.code(400).send({ error: 'inline_backoff_ms must be 100–10000' })
        }
        const retryOn = Array.isArray(body.retry_policy.retry_on)
          ? body.retry_policy.retry_on.filter((x) => ['network', '5xx', '429'].includes(String(x)))
          : ['network', '5xx']
        patch.retry_policy =
          !hasScheduled && inline === 0
            ? null
            : JSON.stringify({
                ...(hasScheduled ? { max_attempts: max, backoff_minutes: back } : {}),
                inline_retries: inline,
                inline_backoff_ms: inlineBackoff,
                retry_on: retryOn
              })
      }
    }
    // #66 — mock_config: per-instance {enabled, rules[], fallback}; validated
    // to the shape callExternalApi reads.
    if (body.mock_config !== undefined) {
      if (body.mock_config === null) patch.mock_config = null
      else {
        const out: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(body.mock_config)) {
          if (!v || typeof v !== 'object' || !/^[A-Za-z0-9_.-]{1,60}$/.test(k)) continue
          const rules = Array.isArray(v.rules) ? v.rules : []
          for (const r of rules) {
            const rr = r as { status?: unknown; path?: unknown; method?: unknown }
            if (!rr || typeof rr !== 'object' || !Number.isInteger(rr.status))
              return reply
                .code(400)
                .send({ error: `mock_config.${k}.rules: every rule needs an integer status` })
            if (rr.path !== undefined && typeof rr.path !== 'string')
              return reply
                .code(400)
                .send({ error: `mock_config.${k}.rules: path must be a string` })
          }
          out[k] = { enabled: !!v.enabled, rules, fallback: v.fallback ?? undefined }
        }
        patch.mock_config = Object.keys(out).length ? JSON.stringify(out) : null
      }
    }
    // #89 — per-instance overrides, masked secrets preserved.
    if (body.instance_overrides !== undefined) {
      patch.instance_overrides = mergeInstanceOverrides(
        body.instance_overrides,
        existing.instance_overrides
      )
    }
    if (body.base_url !== undefined) patch.base_url = body.base_url
    if (body.description !== undefined) patch.description = body.description
    if (body.auth_type !== undefined) patch.auth_type = body.auth_type
    if (body.headers !== undefined) patch.headers = toJsonStr(body.headers)
    if (body.enabled !== undefined) patch.enabled = body.enabled
    if (body.integration_type !== undefined) patch.integration_type = body.integration_type
    if (body.integration_config !== undefined)
      patch.integration_config = toJsonStr(body.integration_config)

    if (body.auth_config !== undefined) {
      const merged = mergeAuthConfig(
        body.auth_config,
        parseJson<Record<string, unknown>>(existing.auth_config)
      )
      patch.auth_config = toJsonStr(merged)
    }

    await db('nivaro_external_apis').where({ id }).update(patch)
    const row = (await db('nivaro_external_apis').where({ id }).first()) as ExternalApiRow
    await logActivity({
      action: 'update',
      collection: 'nivaro_external_apis',
      item: String(id),
      user: req.user?.id,
      req
    })
    return { data: serializeForRead(row) }
  })

  // Delete
  app.delete<{ Params: { id: string } }>(
    '/:id',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const deleted = await db('nivaro_external_apis')
        .where({ id: Number(req.params.id) })
        .delete()
      if (!deleted) return reply.code(404).send({ error: 'Not found' })
      await logActivity({
        action: 'delete',
        collection: 'nivaro_external_apis',
        item: req.params.id,
        user: req.user?.id,
        req
      })
      return { data: { success: true } }
    }
  )

  // Test call
  app.post<{
    Params: { id: string }
    Body: {
      method?: string
      path?: string
      body?: unknown
      query?: Record<string, string>
      headers?: Record<string, string>
    }
  }>('/:id/test', { preHandler: requireAdmin }, async (req, reply) => {
    const stored = (await db('nivaro_external_apis')
      .where({ id: Number(req.params.id) })
      .first()) as ExternalApiRow | undefined
    if (!stored) return reply.code(404).send({ error: 'Not found' })
    // #89 — the test talks to the same host/credentials a real call would.
    const row = resolveInstanceRow(stored)

    const method = (req.body?.method ?? 'GET').toUpperCase()
    const path = req.body?.path ?? ''
    const extraQuery = req.body?.query ?? {}
    const extraHeaders = req.body?.headers ?? {}
    const cfg = parseJson<Record<string, unknown>>(row.auth_config)
    const staticHeaders = parseJson<Record<string, string>>(row.headers) ?? {}

    const startMs = Date.now()
    let fetchError: string | null = null

    try {
      const auth = await resolveAuth(row.auth_type, cfg)

      // Build URL: join base_url + path, then apply auth + caller query params.
      const base = row.base_url.replace(/\/+$/, '')
      const suffix = path ? (path.startsWith('/') ? path : `/${path}`) : ''
      const url = new URL(base + suffix)
      for (const [k, v] of Object.entries(auth.queryParams)) {
        url.searchParams.set(k, v)
      }
      for (const [k, v] of Object.entries(extraQuery)) {
        url.searchParams.set(k, v)
      }

      // Merge headers: static config → auth → per-request overrides.
      const headers: Record<string, string> = { ...staticHeaders, ...auth.headers, ...extraHeaders }

      const init: RequestInit = { method, headers }
      let reqBodyStr: string | null = null
      if (method !== 'GET' && method !== 'HEAD' && req.body?.body !== undefined) {
        if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
          headers['Content-Type'] = 'application/json'
        }
        reqBodyStr =
          typeof req.body.body === 'string' ? req.body.body : JSON.stringify(req.body.body)
        init.body = reqBodyStr
      }

      // No SSRF guard here — external APIs are admin-only and intentionally reach
      // internal corporate services (ERPs, ticketing systems, etc.).
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 10_000)
      init.signal = controller.signal

      let res: Response
      try {
        res = await fetch(url.toString(), init)
      } finally {
        clearTimeout(timer)
      }

      const durationMs = Date.now() - startMs

      const resHeaders: Record<string, string> = {}
      res.headers.forEach((value, key) => {
        resHeaders[key] = value
      })

      const text = await res.text()
      let parsedBody: unknown = text
      const ct = res.headers.get('content-type') ?? ''
      if (ct.includes('application/json')) {
        try {
          parsedBody = JSON.parse(text)
        } catch {
          parsedBody = text
        }
      }

      await Promise.all([
        logActivity({
          action: 'run',
          collection: 'nivaro_external_apis',
          item: req.params.id,
          user: req.user?.id,
          req,
          comment: 'test'
        }),
        writeApiCallLog({
          api_id: row.id,
          triggered_by: 'test',
          method,
          url: url.toString(),
          request_headers: headers,
          request_body: reqBodyStr,
          response_status: res.status,
          response_headers: resHeaders,
          response_body: text,
          duration_ms: durationMs,
          user_id: req.user?.id ?? null
        })
      ])

      return {
        data: {
          status: res.status,
          headers: resHeaders,
          body: parsedBody
        }
      }
    } catch (err) {
      const message = describeFetchError(err)

      await writeApiCallLog({
        api_id: row.id,
        triggered_by: 'test',
        method,
        url: (() => {
          try {
            const base = row.base_url.replace(/\/+$/, '')
            const suffix = path ? (path.startsWith('/') ? path : `/${path}`) : ''
            return new URL(base + suffix).toString()
          } catch {
            return `${row.base_url}${path}`
          }
        })(),
        duration_ms: Date.now() - startMs,
        error: message,
        user_id: req.user?.id ?? null
      })

      fetchError = message
      return reply.code(200).send({
        data: { status: 0, headers: {}, body: null },
        error: fetchError
      })
    }
  })

  // ─── Endpoint definitions ─────────────────────────────────────────────────

  interface EndpointRow {
    id: number
    api_id: number
    name: string
    slug: string
    method: string
    path: string
    description: string | null
    default_body: string | null
    default_query: string | null
    default_headers: string | null
    sort: number
    contract?: string | null
    contract_last_run?: Date | null
    contract_last_ok?: boolean | null
    contract_last_detail?: string | null
    created_at: Date
    updated_at: Date
  }

  function serializeEndpoint(e: EndpointRow) {
    return {
      id: e.id,
      api_id: e.api_id,
      name: e.name,
      slug: e.slug,
      method: e.method,
      path: e.path,
      description: e.description,
      default_body: parseJson(e.default_body),
      default_query: parseJson<Record<string, string>>(e.default_query),
      default_headers: parseJson<Record<string, string>>(e.default_headers),
      sort: e.sort,
      // #74 — contract + last verdict
      contract: parseJson(e.contract ?? null) ?? null,
      contract_last_run: e.contract_last_run ?? null,
      contract_last_ok: e.contract_last_ok == null ? null : !!e.contract_last_ok,
      contract_last_detail: e.contract_last_detail ?? null,
      created_at: e.created_at,
      updated_at: e.updated_at
    }
  }

  async function resolveEndpoint(slugOrId: string): Promise<EndpointRow | undefined> {
    const asNum = Number(slugOrId)
    if (!Number.isNaN(asNum) && Number.isInteger(asNum)) {
      return db('nivaro_external_api_endpoints').where({ id: asNum }).first() as Promise<
        EndpointRow | undefined
      >
    }
    return db('nivaro_external_api_endpoints').where({ slug: slugOrId }).first() as Promise<
      EndpointRow | undefined
    >
  }

  // List endpoints for an API
  app.get<{ Params: { id: string } }>(
    '/:id/endpoints',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const apiId = Number(req.params.id)
      const exists = await db('nivaro_external_apis').where({ id: apiId }).first()
      if (!exists) return reply.code(404).send({ error: 'Not found' })
      const rows = (await db('nivaro_external_api_endpoints')
        .where({ api_id: apiId })
        .orderBy('sort', 'asc')
        .orderBy('id', 'asc')) as EndpointRow[]
      return { data: rows.map(serializeEndpoint) }
    }
  )

  // Create endpoint
  app.post<{
    Params: { id: string }
    Body: {
      name: string
      slug: string
      method?: string
      path?: string
      description?: string | null
      default_body?: unknown
      default_query?: Record<string, string> | null
      default_headers?: Record<string, string> | null
      sort?: number
      contract?: unknown
    }
  }>('/:id/endpoints', { preHandler: requireAdmin }, async (req, reply) => {
    const apiId = Number(req.params.id)
    const exists = await db('nivaro_external_apis').where({ id: apiId }).first()
    if (!exists) return reply.code(404).send({ error: 'Not found' })
    if (!req.body?.name) return reply.code(400).send({ error: 'name is required' })
    if (!req.body?.slug?.trim()) return reply.code(400).send({ error: 'slug is required' })

    const now = new Date()
    const [inserted] = await db('nivaro_external_api_endpoints')
      .insert({
        api_id: apiId,
        name: req.body.name,
        slug: req.body.slug ?? null,
        method: (req.body.method ?? 'GET').toUpperCase(),
        path: req.body.path ?? '',
        description: req.body.description ?? null,
        default_body: req.body.default_body != null ? toJsonStr(req.body.default_body) : null,
        default_query: req.body.default_query != null ? toJsonStr(req.body.default_query) : null,
        default_headers:
          req.body.default_headers != null ? toJsonStr(req.body.default_headers) : null,
        sort: req.body.sort ?? 0,
        contract: req.body.contract != null ? toJsonStr(req.body.contract) : null,
        created_at: now,
        updated_at: now
      })
      .returning('*')

    const row =
      inserted && typeof inserted === 'object'
        ? (inserted as EndpointRow)
        : ((await db('nivaro_external_api_endpoints')
            .where({ id: inserted as number })
            .first()) as EndpointRow)

    await logActivity({
      action: 'create',
      collection: 'nivaro_external_api_endpoints',
      item: String(row.id),
      user: req.user?.id,
      req,
      comment: `api:${apiId}`
    })
    return reply.code(201).send({ data: serializeEndpoint(row) })
  })

  // Update endpoint
  app.patch<{
    Params: { eid: string }
    Body: Partial<{
      name: string
      slug: string
      method: string
      path: string
      description: string | null
      default_body: unknown
      default_query: Record<string, string> | null
      default_headers: Record<string, string> | null
      sort: number
      contract: unknown
    }>
  }>('/endpoints/:eid', { preHandler: requireAdmin }, async (req, reply) => {
    const eid = Number(req.params.eid)
    const existing = (await db('nivaro_external_api_endpoints').where({ id: eid }).first()) as
      | EndpointRow
      | undefined
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    const b = req.body ?? {}
    const patch: Record<string, unknown> = { updated_at: new Date() }
    if (b.name !== undefined) patch.name = b.name
    if ('slug' in b) patch.slug = b.slug ?? null
    if (b.method !== undefined) patch.method = b.method.toUpperCase()
    if (b.path !== undefined) patch.path = b.path
    if (b.description !== undefined) patch.description = b.description
    if (b.sort !== undefined) patch.sort = b.sort
    if ('default_body' in b)
      patch.default_body = b.default_body != null ? toJsonStr(b.default_body) : null
    if ('default_query' in b)
      patch.default_query = b.default_query != null ? toJsonStr(b.default_query) : null
    if ('default_headers' in b)
      patch.default_headers = b.default_headers != null ? toJsonStr(b.default_headers) : null
    if ('contract' in b) {
      if (b.contract != null && (typeof b.contract !== 'object' || Array.isArray(b.contract)))
        return reply.code(400).send({ error: 'contract must be an object' })
      patch.contract = b.contract != null ? toJsonStr(b.contract) : null
      if (b.contract == null) {
        patch.contract_last_run = null
        patch.contract_last_ok = null
        patch.contract_last_detail = null
      }
    }

    await db('nivaro_external_api_endpoints').where({ id: eid }).update(patch)
    const row = (await db('nivaro_external_api_endpoints')
      .where({ id: eid })
      .first()) as EndpointRow
    await logActivity({
      action: 'update',
      collection: 'nivaro_external_api_endpoints',
      item: String(eid),
      user: req.user?.id,
      req
    })
    return { data: serializeEndpoint(row) }
  })

  // #74 — run one endpoint's contract, or every contract on an API.
  app.post<{ Params: { eid: string } }>(
    '/endpoints/:eid/contract/run',
    { preHandler: requireAdmin },
    async (req, reply) => {
      try {
        const result = await runEndpointContract(Number(req.params.eid))
        await logActivity({
          action: 'external-api-contract-run',
          collection: 'nivaro_external_api_endpoints',
          item: req.params.eid,
          user: req.user?.id,
          req,
          comment: `${result.ok ? 'pass' : 'FAIL'} — ${result.detail}`
        })
        return { data: result }
      } catch (err) {
        return reply.code(422).send({ error: err instanceof Error ? err.message : String(err) })
      }
    }
  )
  app.post<{ Params: { id: string } }>(
    '/:id/contracts/run',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const apiId = Number(req.params.id)
      const exists = await db('nivaro_external_apis').where({ id: apiId }).first()
      if (!exists) return reply.code(404).send({ error: 'Not found' })
      const results = await runContracts(apiId)
      // A skipped endpoint (mutation without allow_mutation) is not a failure.
      const failed = results.filter((r) => !r.ok && !r.skipped).length
      await logActivity({
        action: 'external-api-contract-run',
        collection: 'nivaro_external_apis',
        item: String(apiId),
        user: req.user?.id,
        req,
        comment: `${results.length} contract${results.length === 1 ? '' : 's'}, ${failed} failing`
      })
      return { data: { results, failed } }
    }
  )
  app.get('/contracts', { preHandler: requireAdmin }, async () => ({
    data: await contractTargets()
  }))

  // Delete endpoint
  app.delete<{ Params: { eid: string } }>(
    '/endpoints/:eid',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const deleted = await db('nivaro_external_api_endpoints')
        .where({ id: Number(req.params.eid) })
        .delete()
      if (!deleted) return reply.code(404).send({ error: 'Not found' })
      await logActivity({
        action: 'delete',
        collection: 'nivaro_external_api_endpoints',
        item: req.params.eid,
        user: req.user?.id,
        req
      })
      return { data: { success: true } }
    }
  )

  // Call a pre-defined endpoint by id or slug (authenticated, not admin-only)
  app.post<{
    Params: { eid: string }
    Body?: {
      body?: unknown
      query?: Record<string, string>
      headers?: Record<string, string>
    }
  }>('/endpoints/:eid/call', { preHandler: authenticate }, async (req, reply) => {
    const endpoint = await resolveEndpoint(req.params.eid)
    if (!endpoint) return reply.code(404).send({ error: 'Not found' })

    const api = (await db('nivaro_external_apis').where({ id: endpoint.api_id }).first()) as
      | ExternalApiRow
      | undefined
    if (!api || !api.enabled) return reply.code(404).send({ error: 'Not found' })

    const defaultBody = parseJson(endpoint.default_body)
    const defaultQuery = parseJson<Record<string, string>>(endpoint.default_query) ?? {}
    const defaultHeaders = parseJson<Record<string, string>>(endpoint.default_headers) ?? {}
    const staticHeaders = parseJson<Record<string, string>>(api.headers) ?? {}
    const callerQuery = req.body?.query ?? {}
    const callerHeaders = req.body?.headers ?? {}
    const callerBody = req.body?.body
    const cfg = parseJson<Record<string, unknown>>(api.auth_config)

    const startMs = Date.now()

    try {
      const auth = await resolveAuth(api.auth_type, cfg)

      const base = api.base_url.replace(/\/+$/, '')
      const suffix = endpoint.path
        ? endpoint.path.startsWith('/')
          ? endpoint.path
          : `/${endpoint.path}`
        : ''
      const url = new URL(base + suffix)
      for (const [k, v] of Object.entries(auth.queryParams)) url.searchParams.set(k, v)
      for (const [k, v] of Object.entries(defaultQuery)) url.searchParams.set(k, v)
      for (const [k, v] of Object.entries(callerQuery)) url.searchParams.set(k, v)

      const headers: Record<string, string> = {
        ...staticHeaders,
        ...defaultHeaders,
        ...auth.headers,
        ...callerHeaders
      }

      const method = endpoint.method.toUpperCase()
      const init: RequestInit = { method, headers }
      let reqBodyStr: string | null = null
      const bodyPayload = callerBody !== undefined ? callerBody : defaultBody
      if (
        method !== 'GET' &&
        method !== 'HEAD' &&
        bodyPayload !== null &&
        bodyPayload !== undefined
      ) {
        if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
          headers['Content-Type'] = 'application/json'
        }
        reqBodyStr = typeof bodyPayload === 'string' ? bodyPayload : JSON.stringify(bodyPayload)
        init.body = reqBodyStr
      }

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 10_000)
      init.signal = controller.signal

      let res: Response
      try {
        res = await fetch(url.toString(), init)
      } finally {
        clearTimeout(timer)
      }

      const durationMs = Date.now() - startMs
      const resHeaders: Record<string, string> = {}
      res.headers.forEach((value, key) => {
        resHeaders[key] = value
      })

      const text = await res.text()
      let parsedBody: unknown = text
      const ct = res.headers.get('content-type') ?? ''
      if (ct.includes('application/json')) {
        try {
          parsedBody = JSON.parse(text)
        } catch {
          parsedBody = text
        }
      }

      await writeApiCallLog({
        api_id: api.id,
        endpoint_id: endpoint.id,
        triggered_by: 'sdk',
        method,
        url: url.toString(),
        request_headers: headers,
        request_body: reqBodyStr,
        response_status: res.status,
        response_headers: resHeaders,
        response_body: text,
        duration_ms: durationMs,
        user_id: req.user?.id ?? null
      })

      return { data: { status: res.status, headers: resHeaders, body: parsedBody } }
    } catch (err) {
      const message = describeFetchError(err)

      await writeApiCallLog({
        api_id: api.id,
        endpoint_id: endpoint.id,
        triggered_by: 'sdk',
        method: endpoint.method,
        url: (() => {
          try {
            const base = api.base_url.replace(/\/+$/, '')
            const suffix = endpoint.path
              ? endpoint.path.startsWith('/')
                ? endpoint.path
                : `/${endpoint.path}`
              : ''
            return new URL(base + suffix).toString()
          } catch {
            return `${api.base_url}${endpoint.path}`
          }
        })(),
        duration_ms: Date.now() - startMs,
        error: message,
        user_id: req.user?.id ?? null
      })

      return reply.code(200).send({ data: { status: 0, headers: {}, body: null }, error: message })
    }
  })

  // Call any arbitrary endpoint on a configured API (authenticated, not admin-only)
  app.post<{
    Params: { id: string }
    Body: {
      method?: string
      path?: string
      body?: unknown
      query?: Record<string, string>
      headers?: Record<string, string>
    }
  }>('/:id/call', { preHandler: authenticate }, async (req, reply) => {
    const api = (await db('nivaro_external_apis')
      .where({ id: Number(req.params.id) })
      .first()) as ExternalApiRow | undefined
    if (!api || !api.enabled) return reply.code(404).send({ error: 'Not found' })

    const method = (req.body?.method ?? 'GET').toUpperCase()
    const path = req.body?.path ?? ''
    const callerQuery = req.body?.query ?? {}
    const callerHeaders = req.body?.headers ?? {}
    const cfg = parseJson<Record<string, unknown>>(api.auth_config)
    const staticHeaders = parseJson<Record<string, string>>(api.headers) ?? {}
    const startMs = Date.now()

    try {
      const auth = await resolveAuth(api.auth_type, cfg)

      const base = api.base_url.replace(/\/+$/, '')
      const suffix = path ? (path.startsWith('/') ? path : `/${path}`) : ''
      const url = new URL(base + suffix)
      for (const [k, v] of Object.entries(auth.queryParams)) url.searchParams.set(k, v)
      for (const [k, v] of Object.entries(callerQuery)) url.searchParams.set(k, v)

      const headers: Record<string, string> = {
        ...staticHeaders,
        ...auth.headers,
        ...callerHeaders
      }
      const init: RequestInit = { method, headers }
      let reqBodyStr: string | null = null
      if (method !== 'GET' && method !== 'HEAD' && req.body?.body !== undefined) {
        if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
          headers['Content-Type'] = 'application/json'
        }
        reqBodyStr =
          typeof req.body.body === 'string' ? req.body.body : JSON.stringify(req.body.body)
        init.body = reqBodyStr
      }

      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 10_000)
      init.signal = controller.signal

      let res: Response
      try {
        res = await fetch(url.toString(), init)
      } finally {
        clearTimeout(timer)
      }

      const durationMs = Date.now() - startMs
      const resHeaders: Record<string, string> = {}
      res.headers.forEach((value, key) => {
        resHeaders[key] = value
      })

      const text = await res.text()
      let parsedBody: unknown = text
      const ct = res.headers.get('content-type') ?? ''
      if (ct.includes('application/json')) {
        try {
          parsedBody = JSON.parse(text)
        } catch {
          parsedBody = text
        }
      }

      await writeApiCallLog({
        api_id: api.id,
        triggered_by: 'sdk',
        method,
        url: url.toString(),
        request_headers: headers,
        request_body: reqBodyStr,
        response_status: res.status,
        response_headers: resHeaders,
        response_body: text,
        duration_ms: durationMs,
        user_id: req.user?.id ?? null
      })

      return { data: { status: res.status, headers: resHeaders, body: parsedBody } }
    } catch (err) {
      const message = describeFetchError(err)

      await writeApiCallLog({
        api_id: api.id,
        triggered_by: 'sdk',
        method,
        url: (() => {
          try {
            const base = api.base_url.replace(/\/+$/, '')
            const suffix = path ? (path.startsWith('/') ? path : `/${path}`) : ''
            return new URL(base + suffix).toString()
          } catch {
            return `${api.base_url}${path}`
          }
        })(),
        duration_ms: Date.now() - startMs,
        error: message,
        user_id: req.user?.id ?? null
      })

      return reply.code(200).send({ data: { status: 0, headers: {}, body: null }, error: message })
    }
  })

  // Reorder endpoints
  app.patch<{
    Params: { id: string }
    Body: { order: { id: number; sort: number }[] }
  }>('/:id/endpoints/reorder', { preHandler: requireAdmin }, async (req, reply) => {
    const items = req.body?.order ?? []
    await Promise.all(
      items.map((item) =>
        db('nivaro_external_api_endpoints')
          .where({ id: item.id })
          .update({ sort: item.sort, updated_at: new Date() })
      )
    )
    return reply.send({ data: { success: true } })
  })

  // ─── Spec import ─────────────────────────────────────────────────────────

  interface SchemaRow {
    id: number
    external_api_id: number
    title: string | null
    spec_version: string | null
    raw_spec: string | null
    endpoint_count: number
    imported_at: Date
    imported_by: string | null
  }

  // POST /:id/import-spec — parse OpenAPI/Swagger JSON and bulk-create endpoints
  app.post<{
    Params: { id: string }
    Body: { spec: string | Record<string, unknown> }
  }>('/:id/import-spec', { preHandler: requireAdmin }, async (req, reply) => {
    const apiId = Number(req.params.id)
    const exists = await db('nivaro_external_apis').where({ id: apiId }).first()
    if (!exists) return reply.code(404).send({ error: 'Not found' })

    // Parse spec — accept pre-parsed object, JSON string, or YAML string
    let spec: Record<string, unknown>
    if (typeof req.body?.spec !== 'string') {
      spec = req.body?.spec as Record<string, unknown>
    } else {
      const raw = req.body.spec.trimStart()
      try {
        // Try JSON first (faster, unambiguous), then fall back to YAML
        spec =
          raw.startsWith('{') || raw.startsWith('[')
            ? (JSON.parse(raw) as Record<string, unknown>)
            : (yamlLoad(raw) as Record<string, unknown>)
      } catch {
        // One format failed — try the other before giving up
        try {
          spec =
            raw.startsWith('{') || raw.startsWith('[')
              ? (yamlLoad(raw) as Record<string, unknown>)
              : (JSON.parse(raw) as Record<string, unknown>)
        } catch {
          return reply.code(400).send({ error: 'Invalid spec: could not parse as JSON or YAML' })
        }
      }
    }

    if (!spec || typeof spec !== 'object') {
      return reply.code(400).send({ error: 'spec must be a JSON object' })
    }

    const paths = spec.paths as Record<string, Record<string, unknown>> | undefined
    if (!paths || typeof paths !== 'object') {
      return reply.code(400).send({ error: 'No paths found in spec' })
    }

    // Determine version
    const specVersion =
      typeof spec.openapi === 'string'
        ? spec.openapi
        : typeof spec.swagger === 'string'
          ? spec.swagger
          : null

    const infoObj = spec.info as Record<string, unknown> | undefined
    const title = typeof infoObj?.title === 'string' ? infoObj.title : null

    const SKIP_METHODS = new Set(['head', 'options', 'trace'])
    const BODY_METHODS = new Set(['post', 'put', 'patch'])

    // Collect existing slugs for this api to deduplicate
    const existingSlugs = new Set<string>(
      (await db('nivaro_external_api_endpoints').where({ api_id: apiId }).pluck('slug')) as string[]
    )

    const now = new Date()
    let imported = 0
    let skipped = 0

    // Get max sort for appending
    const maxSortRow = (await db('nivaro_external_api_endpoints')
      .where({ api_id: apiId })
      .max('sort as m')
      .first()) as { m: number | null } | undefined
    let nextSort = (maxSortRow?.m ?? -1) + 1

    for (const [pathKey, pathItem] of Object.entries(paths)) {
      if (!pathItem || typeof pathItem !== 'object') continue

      for (const [verb, operation] of Object.entries(pathItem as Record<string, unknown>)) {
        if (SKIP_METHODS.has(verb.toLowerCase())) continue
        if (!operation || typeof operation !== 'object') continue

        const op = operation as Record<string, unknown>
        const method = verb.toUpperCase()
        const operationId = typeof op.operationId === 'string' ? op.operationId : undefined
        const slug = slugifyEndpoint(method, pathKey, operationId)

        if (existingSlugs.has(slug)) {
          skipped++
          continue
        }

        const summary = typeof op.summary === 'string' ? op.summary : null
        const descRaw = typeof op.description === 'string' ? op.description : null
        const description = (summary ?? descRaw ?? '').slice(0, 500) || null
        const name = operationId ?? `${method} ${pathKey}`

        // Build default_query from parameters
        const params = Array.isArray(op.parameters)
          ? (op.parameters as Record<string, unknown>[])
          : []
        const queryParams: Record<string, string> = {}
        for (const p of params) {
          if (p.in === 'query' && typeof p.name === 'string') {
            queryParams[p.name] = ''
          }
        }

        // Build default_body skeleton for POST/PUT/PATCH
        let defaultBody: string | null = null
        if (BODY_METHODS.has(verb.toLowerCase())) {
          // OpenAPI 3.x
          const reqBody = op.requestBody as Record<string, unknown> | undefined
          if (reqBody) {
            const content = reqBody.content as Record<string, unknown> | undefined
            const jsonContent = content?.['application/json'] as Record<string, unknown> | undefined
            const schema = (jsonContent?.schema ?? jsonContent?.example) as
              | Record<string, unknown>
              | undefined
            if (schema) {
              const skeleton = buildSchemaSkeleton(schema)
              if (skeleton !== null) defaultBody = JSON.stringify(skeleton, null, 2)
            }
          }
          // Swagger 2.0 body parameter
          if (!defaultBody) {
            const bodyParam = params.find((p) => p.in === 'body')
            if (bodyParam) {
              const schema = bodyParam.schema as Record<string, unknown> | undefined
              if (schema) {
                const skeleton = buildSchemaSkeleton(schema)
                if (skeleton !== null) defaultBody = JSON.stringify(skeleton, null, 2)
              }
            }
          }
        }

        await db('nivaro_external_api_endpoints').insert({
          api_id: apiId,
          name,
          slug,
          method,
          path: pathKey,
          description,
          default_body: defaultBody,
          default_query: Object.keys(queryParams).length ? toJsonStr(queryParams) : null,
          default_headers: null,
          sort: nextSort++,
          created_at: now,
          updated_at: now
        })

        existingSlugs.add(slug)
        imported++
      }
    }

    // Save schema record (insert-then-select pattern for MSSQL)
    await db('nivaro_external_api_schemas').insert({
      external_api_id: apiId,
      title,
      spec_version: specVersion,
      raw_spec: JSON.stringify(spec),
      endpoint_count: imported,
      imported_at: now,
      imported_by: req.user?.id ?? null
    })
    const schemaRow = (await db('nivaro_external_api_schemas')
      .where({ external_api_id: apiId })
      .orderBy('id', 'desc')
      .first()) as SchemaRow

    await logActivity({
      action: 'external-api-spec-import',
      collection: 'nivaro_external_apis',
      item: String(apiId),
      user: req.user?.id,
      req,
      comment: `imported:${imported} skipped:${skipped}`
    })

    return { data: { imported, skipped, schema_id: schemaRow.id } }
  })

  // GET /:id/schemas — list schemas for this API (newest first)
  app.get<{ Params: { id: string } }>(
    '/:id/schemas',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const apiId = Number(req.params.id)
      const exists = await db('nivaro_external_apis').where({ id: apiId }).first()
      if (!exists) return reply.code(404).send({ error: 'Not found' })

      const rows = (await db('nivaro_external_api_schemas')
        .where({ external_api_id: apiId })
        .orderBy('id', 'desc')
        .select(
          'id',
          'external_api_id',
          'title',
          'spec_version',
          'endpoint_count',
          'imported_at',
          'imported_by'
        )) as Omit<SchemaRow, 'raw_spec'>[]

      return { data: rows }
    }
  )

  // DELETE /:id/schemas/:sid — delete a schema record (does NOT delete endpoints)
  app.delete<{ Params: { id: string; sid: string } }>(
    '/:id/schemas/:sid',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const apiId = Number(req.params.id)
      const sid = Number(req.params.sid)
      const deleted = await db('nivaro_external_api_schemas')
        .where({ id: sid, external_api_id: apiId })
        .delete()
      if (!deleted) return reply.code(404).send({ error: 'Not found' })
      await logActivity({
        action: 'delete',
        user: req.user?.id,
        collection: 'nivaro_external_api_schemas',
        item: String(sid),
        comment: `api ${apiId}`,
        req
      })
      return { data: { success: true } }
    }
  )

  // ─── Call logs ────────────────────────────────────────────────────────────

  interface LogRow {
    id: number
    api_id: number
    endpoint_id: number | null
    triggered_by: string
    method: string
    url: string
    request_headers: string | null
    request_body: string | null
    response_status: number | null
    response_headers: string | null
    response_body: string | null
    duration_ms: number | null
    error: string | null
    user_id: string | null
    created_at: Date
  }

  function serializeLog(r: LogRow) {
    return {
      id: r.id,
      api_id: r.api_id,
      endpoint_id: r.endpoint_id,
      triggered_by: r.triggered_by,
      method: r.method,
      url: r.url,
      request_headers: r.request_headers ? JSON.parse(r.request_headers) : null,
      request_body: r.request_body,
      response_status: r.response_status,
      response_headers: r.response_headers ? JSON.parse(r.response_headers) : null,
      response_body: r.response_body,
      duration_ms: r.duration_ms,
      error: r.error,
      user_id: r.user_id,
      created_at: r.created_at
    }
  }

  // List logs for an API (newest first, last 500)
  app.get<{
    Params: { id: string }
    Querystring: { limit?: string; offset?: string }
  }>('/:id/logs', { preHandler: requireAdmin }, async (req, reply) => {
    const apiId = Number(req.params.id)
    const exists = await db('nivaro_external_apis').where({ id: apiId }).first()
    if (!exists) return reply.code(404).send({ error: 'Not found' })

    const limit = Math.min(Number(req.query.limit ?? 100), 500)
    const offset = Number(req.query.offset ?? 0)

    const [rows, countRow] = await Promise.all([
      db('nivaro_external_api_logs')
        .where({ api_id: apiId })
        .orderBy('id', 'desc')
        .limit(limit)
        .offset(offset) as Promise<LogRow[]>,
      db('nivaro_external_api_logs')
        .where({ api_id: apiId })
        .count('id as total')
        .first() as unknown as Promise<{ total: number | string }>
    ])

    return {
      data: rows.map(serializeLog),
      total: Number(countRow?.total ?? 0)
    }
  })

  // Single log entry
  app.get<{ Params: { logId: string } }>(
    '/logs/:logId',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const row = (await db('nivaro_external_api_logs')
        .where({ id: Number(req.params.logId) })
        .first()) as LogRow | undefined
      if (!row) return reply.code(404).send({ error: 'Not found' })
      return { data: serializeLog(row) }
    }
  )

  // Delete a single log entry
  app.delete<{ Params: { logId: string } }>(
    '/logs/:logId',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const deleted = await db('nivaro_external_api_logs')
        .where({ id: Number(req.params.logId) })
        .delete()
      if (!deleted) return reply.code(404).send({ error: 'Not found' })
      await logActivity({
        action: 'external-api-log-delete',
        user: req.user?.id,
        comment: `log #${req.params.logId}`,
        req
      })
      return { data: { success: true } }
    }
  )

  // Clear all logs for an API
  app.delete<{ Params: { id: string } }>(
    '/:id/logs',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const apiId = Number(req.params.id)
      const exists = await db('nivaro_external_apis').where({ id: apiId }).first()
      if (!exists) return reply.code(404).send({ error: 'Not found' })
      const cleared = await db('nivaro_external_api_logs').where({ api_id: apiId }).delete()
      await logActivity({
        action: 'external-api-logs-clear',
        user: req.user?.id,
        comment: `${(exists as { name?: string }).name ?? apiId}: ${cleared} log rows cleared`,
        req
      })
      return { data: { success: true } }
    }
  )
}
