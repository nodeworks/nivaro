import type { FastifyInstance, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'
import type { User } from '../types.js'
import { ExtensionToolError, liveExtensionTools, runExtensionTool } from './extension-tools.js'
import { MCP_INNER_HEADER } from './mcp-config.js'

/**
 * The instance's own MCP tools, beyond the fixed set in @nivaro/mcp:
 *
 *   - extension tools (#2465, ctx.mcp.registerTool) — every signed-in caller
 *     sees them; the handler runs AS the caller;
 *   - named tools an administrator defines (#2464): a custom query or a flow
 *     exposed under its own name, with the query's params (or the tool's
 *     declared params, for a flow) as the input schema. A query tool runs
 *     through POST /custom-queries/:slug/execute AS the caller — the query's
 *     own access level and scope_params apply exactly as for run_custom_query.
 *     A flow tool runs the flow with the caller as the person who triggered it.
 *
 * The hosted /api/mcp lists these by name; the npm stdio server reaches them
 * through its list_instance_tools / call_instance_tool proxy. Both call
 * POST /api/mcp-tools/:name/call with the caller's own credential.
 */

function parseJson<T>(raw: string | null | undefined): T | null {
  if (!raw) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

export const MCP_TOOLS_COLUMN = 'mcp_tools'
const NAME_RE = /^[a-z][a-z0-9_]{2,47}$/
const PARAM_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const PARAM_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'date'])
export const MAX_NAMED_TOOLS = 100
/** Rows a query tool hands back, and the size a flow tool's answer is cut to. */
export const QUERY_ROW_CAP = 200
const FLOW_RESULT_CAP = 30_000

export interface ToolParam {
  name: string
  type: 'string' | 'number' | 'integer' | 'boolean' | 'date'
  required?: boolean
  description?: string
}

export interface NamedToolConfig {
  name: string
  title?: string
  description: string
  kind: 'custom_query' | 'flow'
  /** The query's slug, or the flow's id. */
  ref: string
  /** Who may see and call it: administrators only, or anyone signed in. */
  access: 'admin' | 'authenticated'
  /** The tool only reads (clients that confirm writes skip the prompt). */
  read_only: boolean
  enabled: boolean
  /** Flow tools: the inputs the flow's payload takes. */
  params?: ToolParam[]
}

export interface InstanceTool {
  name: string
  title: string
  description: string
  input_schema: Record<string, unknown>
  read_only: boolean
  source:
    | { kind: 'extension'; extension: string }
    | { kind: 'custom_query'; slug: string }
    | { kind: 'flow'; flow_id: string }
}

/** Pure: one stored/posted tool row → a clean config, or why it is refused. */
export function normalizeNamedTool(raw: unknown): { tool: NamedToolConfig } | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'not an object' }
  const r = raw as Record<string, unknown>
  const name = String(r.name ?? '').trim()
  if (!NAME_RE.test(name))
    return { error: `"${name}" — names are 3–48 lower-case letters, digits or _` }
  const kind = r.kind === 'flow' ? 'flow' : r.kind === 'custom_query' ? 'custom_query' : null
  if (!kind) return { error: `${name}: kind must be custom_query or flow` }
  const ref = String(r.ref ?? '').trim()
  if (!ref || ref.length > 255)
    return { error: `${name}: pick the ${kind === 'flow' ? 'flow' : 'query'}` }
  const description = String(r.description ?? '').trim()
  if (!description) return { error: `${name}: a description is required (the assistant reads it)` }
  const params: ToolParam[] = []
  if (kind === 'flow' && r.params != null) {
    if (!Array.isArray(r.params)) return { error: `${name}: params must be a list` }
    const seen = new Set<string>()
    for (const p of r.params.slice(0, 30)) {
      const pr = (p ?? {}) as Record<string, unknown>
      const pn = String(pr.name ?? '').trim()
      if (!PARAM_RE.test(pn)) return { error: `${name}: parameter "${pn}" is not a valid name` }
      if (seen.has(pn)) return { error: `${name}: parameter "${pn}" is listed twice` }
      seen.add(pn)
      const type = PARAM_TYPES.has(String(pr.type))
        ? (String(pr.type) as ToolParam['type'])
        : 'string'
      params.push({
        name: pn,
        type,
        ...(pr.required === true ? { required: true } : {}),
        ...(pr.description ? { description: String(pr.description).slice(0, 300) } : {})
      })
    }
  }
  return {
    tool: {
      name,
      ...(typeof r.title === 'string' && r.title.trim()
        ? { title: r.title.trim().slice(0, 80) }
        : {}),
      description: description.slice(0, 1000),
      kind,
      ref,
      access: r.access === 'authenticated' ? 'authenticated' : 'admin',
      read_only: r.read_only === true,
      enabled: r.enabled !== false,
      ...(kind === 'flow' ? { params } : {})
    }
  }
}

/**
 * Pure: a whole posted list → clean configs, or the first problem. Names are
 * unique and never a built-in MCP tool's or a registered extension tool's.
 */
export function validateNamedTools(
  raw: unknown,
  reserved: Set<string>
): { tools: NamedToolConfig[] } | { error: string } {
  if (!Array.isArray(raw)) return { error: 'tools must be a list' }
  if (raw.length > MAX_NAMED_TOOLS) return { error: `At most ${MAX_NAMED_TOOLS} named tools` }
  const out: NamedToolConfig[] = []
  const names = new Set<string>()
  for (const [i, r] of raw.entries()) {
    const n = normalizeNamedTool(r)
    if ('error' in n) return { error: `Tool ${i + 1}: ${n.error}` }
    if (reserved.has(n.tool.name))
      return { error: `Tool ${i + 1}: "${n.tool.name}" is already a tool's name — pick another` }
    if (names.has(n.tool.name)) return { error: `Tool ${i + 1}: "${n.tool.name}" is used twice` }
    names.add(n.tool.name)
    out.push(n.tool)
  }
  return { tools: out }
}

/** Is the settings column there yet (migration 473)? */
export async function namedToolsReady(): Promise<boolean> {
  return hasColumn('nivaro_settings', MCP_TOOLS_COLUMN).catch(() => false)
}

/** The stored named tools; [] before migration 473 or when none are set. */
export async function readNamedTools(): Promise<NamedToolConfig[]> {
  if (!(await namedToolsReady())) return []
  const row = (await db('nivaro_settings')
    .first(MCP_TOOLS_COLUMN)
    .catch(() => null)) as Record<string, unknown> | null | undefined
  const list = parseJson<unknown[]>(row?.[MCP_TOOLS_COLUMN] as string | null) ?? []
  const out: NamedToolConfig[] = []
  for (const r of Array.isArray(list) ? list : []) {
    const n = normalizeNamedTool(r)
    if ('tool' in n) out.push(n.tool)
  }
  return out
}

export async function writeNamedTools(tools: NamedToolConfig[]): Promise<void> {
  const row = (await db('nivaro_settings').first('id')) as { id: number | string } | undefined
  if (!row) throw new Error('No settings row')
  await db('nivaro_settings')
    .where({ id: row.id })
    .update({ [MCP_TOOLS_COLUMN]: tools.length ? JSON.stringify(tools) : null })
}

/** Pure: declared params → the JSON Schema object an MCP client reads. */
export function paramsToSchema(
  params: Array<{
    name: string
    type?: string
    required?: boolean
    description?: string
    default?: unknown
  }>
): Record<string, unknown> {
  const properties: Record<string, Record<string, unknown>> = {}
  const required: string[] = []
  for (const p of params) {
    if (!p || !PARAM_RE.test(String(p.name ?? ''))) continue
    const t = String(p.type ?? 'string')
    const prop: Record<string, unknown> =
      t === 'number' || t === 'integer'
        ? { type: t }
        : t === 'boolean'
          ? { type: 'boolean' }
          : t === 'date'
            ? { type: 'string', format: 'date' }
            : { type: 'string' }
    const bits = [p.description ? String(p.description) : '']
    if (p.default !== undefined && p.default !== null && p.default !== '')
      bits.push(`Default ${JSON.stringify(p.default)}.`)
    const description = bits.filter(Boolean).join(' ')
    if (description) prop.description = description
    properties[p.name] = prop
    if (p.required === true && (p.default === undefined || p.default === null || p.default === ''))
      required.push(p.name)
  }
  return { type: 'object', properties, ...(required.length ? { required } : {}) }
}

/** Pure: may this caller see/call a named tool over this query access level? */
export function namedToolVisible(
  tool: Pick<NamedToolConfig, 'access' | 'enabled'>,
  isAdmin: boolean,
  queryAccess?: string
): boolean {
  if (!tool.enabled) return false
  if (isAdmin) return true
  if (tool.access !== 'authenticated') return false
  // A query that only administrators may run is never offered to anyone else.
  return queryAccess === undefined || queryAccess === 'authenticated' || queryAccess === 'public'
}

interface QueryRow {
  slug: string
  name: string
  description: string | null
  params: string | null
  access: string
  enabled: boolean | number
}
interface FlowRow {
  id: string
  name: string
  status: string
}

async function resolveRefs(tools: NamedToolConfig[]): Promise<{
  queries: Map<string, QueryRow>
  flows: Map<string, FlowRow>
}> {
  const slugs = [...new Set(tools.filter((t) => t.kind === 'custom_query').map((t) => t.ref))]
  const flowIds = [...new Set(tools.filter((t) => t.kind === 'flow').map((t) => t.ref))]
  const [qs, fs] = await Promise.all([
    slugs.length
      ? (db('nivaro_custom_queries')
          .whereIn('slug', slugs)
          .select('slug', 'name', 'description', 'params', 'access', 'enabled') as Promise<
          QueryRow[]
        >)
      : Promise.resolve([] as QueryRow[]),
    flowIds.length
      ? (db('nivaro_flows').whereIn('id', flowIds).select('id', 'name', 'status') as Promise<
          FlowRow[]
        >)
      : Promise.resolve([] as FlowRow[])
  ])
  return {
    queries: new Map(qs.map((q) => [q.slug, q])),
    flows: new Map(fs.map((f) => [String(f.id).toLowerCase(), f]))
  }
}

/**
 * Who is calling, judged ONCE per request and used by the catalog and by the
 * call alike. `isAdmin` follows the admin-tools rule of /api/mcp: an
 * administrator on a collection-scoped API key is not an administrator here.
 * `scoped` = the key carries collection scopes (authenticate leaves
 * `api_key_scopes` unset for an open '*' key): flow tools are never offered to
 * it, since a flow runs as the user and would escape the key's scopes.
 */
export interface McpCallerAccess {
  isAdmin: boolean
  scoped: boolean
}
export function mcpCallerAccess(req: Pick<FastifyRequest, 'isAdmin' | 'user'>): McpCallerAccess {
  const scoped = !!req.user?.api_key_scopes
  return { isAdmin: !!req.isAdmin && !scoped, scoped }
}

export const SCOPED_KEY_FLOW_MESSAGE =
  'This API key is limited to named collections, so it cannot run flow tools'

/** One named tool as the caller would see it, or null when they may not. */
function describeNamed(
  t: NamedToolConfig,
  refs: Awaited<ReturnType<typeof resolveRefs>>,
  access: McpCallerAccess
): InstanceTool | null {
  const { isAdmin } = access
  if (t.kind === 'custom_query') {
    const q = refs.queries.get(t.ref)
    if (!q || !q.enabled || !namedToolVisible(t, isAdmin, q.access)) return null
    return {
      name: t.name,
      title: t.title ?? q.name,
      description: t.description,
      input_schema: paramsToSchema(parseJson<ToolParam[]>(q.params) ?? []),
      read_only: t.read_only,
      source: { kind: 'custom_query', slug: q.slug }
    }
  }
  if (access.scoped) return null
  const f = refs.flows.get(t.ref.toLowerCase())
  if (!f || f.status !== 'active' || !namedToolVisible(t, isAdmin)) return null
  return {
    name: t.name,
    title: t.title ?? f.name,
    description: t.description,
    input_schema: paramsToSchema(t.params ?? []),
    read_only: t.read_only,
    source: { kind: 'flow', flow_id: String(f.id) }
  }
}

/** Every instance tool this caller may use: extension tools, then named ones. */
export async function instanceToolCatalog(access: McpCallerAccess): Promise<InstanceTool[]> {
  const ext = (await liveExtensionTools('mcp').catch(() => [])).map(
    (t): InstanceTool => ({
      name: t.name,
      title: t.title,
      description: t.description,
      input_schema: t.input_schema,
      read_only: t.read_only,
      source: { kind: 'extension', extension: t.extension }
    })
  )
  const named = await readNamedTools().catch(() => [])
  const taken = new Set(ext.map((t) => t.name))
  const live = named.filter((t) => t.enabled && !taken.has(t.name))
  if (!live.length) return ext
  const refs = await resolveRefs(live)
  const out = [...ext]
  for (const t of live) {
    const d = describeNamed(t, refs, access)
    if (d) out.push(d)
  }
  return out
}

/** Pure: only the inputs a schema declares, so nothing undeclared rides along. */
export function declaredInputs(
  schema: Record<string, unknown>,
  input: Record<string, unknown>
): Record<string, unknown> {
  const props = (schema.properties ?? {}) as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const k of Object.keys(props)) if (input[k] !== undefined) out[k] = input[k]
  return out
}

/** The caller's own credential for an in-process call made on their behalf. */
function callerHeaders(req: FastifyRequest): Record<string, string> {
  const out: Record<string, string> = { 'content-type': 'application/json' }
  for (const h of ['authorization', 'cookie', 'x-workspace', 'user-agent', MCP_INNER_HEADER]) {
    const v = req.headers[h]
    if (typeof v === 'string') out[h] = v
  }
  return out
}

/**
 * Run one instance tool AS the caller. Throws ExtensionToolError with an HTTP
 * status: 404 for a tool the caller cannot see, the API's own status for a
 * refused query run.
 */
export async function callInstanceTool(
  app: FastifyInstance,
  req: FastifyRequest,
  name: string,
  input: Record<string, unknown>
): Promise<unknown> {
  const user = req.user as User
  const access = mcpCallerAccess(req)
  const tool = (await instanceToolCatalog(access)).find((t) => t.name === name)
  if (!tool) {
    // Say why a scoped key cannot run a flow tool rather than pretend it is not there.
    if (access.scoped) {
      const named = (await readNamedTools().catch(() => [])).find((t) => t.name === name)
      if (named?.kind === 'flow' && named.enabled)
        throw new ExtensionToolError(SCOPED_KEY_FLOW_MESSAGE, 403)
    }
    throw new ExtensionToolError('Unknown tool', 404)
  }
  const args = declaredInputs(tool.input_schema, input)
  const src = tool.source
  if (src.kind === 'extension') return runExtensionTool('mcp', user, name, input)

  if (src.kind === 'custom_query') {
    const res = await app.inject({
      method: 'POST',
      url: `/api/custom-queries/${encodeURIComponent(src.slug)}/execute`,
      headers: callerHeaders(req),
      payload: JSON.stringify({ params: args }),
      remoteAddress: req.ip
    })
    const body = parseJson<Record<string, unknown>>(res.body) ?? {}
    if (res.statusCode >= 400)
      throw new ExtensionToolError(String(body.error ?? 'The query failed'), res.statusCode)
    const rows = Array.isArray(body.data) ? body.data : []
    return {
      rows: rows.slice(0, QUERY_ROW_CAP),
      row_count: rows.length,
      truncated: rows.length > QUERY_ROW_CAP,
      cached: body.cached === true,
      ...(body.executed_at ? { executed_at: body.executed_at } : {})
    }
  }

  if (access.scoped) throw new ExtensionToolError(SCOPED_KEY_FLOW_MESSAGE, 403)
  const flow = (await db('nivaro_flows')
    .where({ id: src.flow_id })
    .first('id', 'name', 'status')) as FlowRow | undefined
  if (!flow || flow.status !== 'active') throw new ExtensionToolError('Unknown tool', 404)
  const { executeFlow } = await import('./flow-executor.js')
  const data = await executeFlow({
    flowId: String(flow.id),
    flowName: flow.name,
    trigger: 'mcp',
    payload: { ...args, $tool: name },
    log: app.log,
    userId: String(user.id)
  })
  const { logActivity } = await import('./activity.js')
  void logActivity({
    action: 'run',
    collection: 'nivaro_flows',
    item: String(flow.id),
    user: user.id,
    comment: `MCP tool ${name}`,
    req
  })
  const text = JSON.stringify(data ?? null)
  return text.length > FLOW_RESULT_CAP
    ? { truncated: true, result: text.slice(0, FLOW_RESULT_CAP) }
    : { result: data ?? null }
}
