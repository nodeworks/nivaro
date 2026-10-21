import type { ServerResponse } from 'node:http'
import type { FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { getTenantId } from '../db/tenant-context.js'
import { hasColumn } from '../lib/column-probe.js'
import { overlaySettings } from './settings-overrides.js'

/**
 * MCP calls in the request log (#2466), as their own Traffic Map caller (#2469), and the
 * MCP settings (#2497).
 *
 * Every request that came through the hosted MCP endpoint is stamped on its api_logs row
 * (migration 480): the POST /api/mcp row of a `tools/call` (one per tool call — the tool, how
 * it ended, how many bytes it answered) and each in-process call its tool made back into the
 * API (`req.mcpInner`, services/mcp-config.ts). Both name the CONNECTION — the OAuth grant, the
 * API key or the token the agent signed in with — so stats, the person's "What my agents did"
 * list and the idle review read one log. The in-process rows share the outer row's chain id
 * (plugins/chain.ts adopts the caller's chain), which is how a tool call finds its writes.
 *
 * The tool name on an inner row comes from `x-nivaro-mcp-tool`, which the MCP package stamps.
 * It is believed only on a request the inner marker proved came from routes/mcp.ts.
 */

export type McpOutcome = 'ok' | 'error' | 'refused'

export interface McpCallStamp {
  /** `o<grant id>` | `k<api key id>` | `u<user id>`. */
  conn: string
  /** The caller's name as a caller-key slug (`Claude_Code`). */
  client: string
  tool: string | null
  /** Set on the POST /api/mcp row of a tools/call once its answer is written. */
  outcome?: McpOutcome
  bytes?: number
}

declare module 'fastify' {
  interface FastifyRequest {
    /** The tool call POST /api/mcp is answering (routes/mcp.ts). */
    mcpCall?: McpCallStamp
  }
}

// ─── Connection + caller identity (pure) ─────────────────────────────────────

const UUID_RE = /^[0-9a-f-]{36}$/i

/** The connection a request signed in with, or null (no credential). */
export function mcpConnOf(req: {
  authMethod?: string
  oauthGrantId?: string
  apiKeyId?: number | null
  user?: { id?: unknown } | null
}): string | null {
  if (req.authMethod === 'oauth' && req.oauthGrantId && UUID_RE.test(req.oauthGrantId))
    return `o${req.oauthGrantId.toLowerCase()}`
  if (req.authMethod === 'api_key' && req.apiKeyId != null) return `k${req.apiKeyId}`
  if (req.user?.id != null) return `u${String(req.user.id).toLowerCase()}`
  return null
}

/** Valid connection key (`o<uuid>`, `k<digits>`, `u<uuid>`). */
export const CONN_RE = /^(o[0-9a-f-]{36}|k\d{1,12}|u[0-9a-f-]{36})$/

/** A display name as a caller-key slug: letters, digits, `.` `_` `-`; spaces become `_`. */
export function clientSlug(name: string | null | undefined): string {
  const s = String(name ?? '')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48)
  return s || 'Assistant'
}

/** Traffic Map caller key for an MCP client (`m:Claude_Code`). */
export const mcpCallerKey = (slug: string) => `m:${slug}`
export const MCP_CALLER_RE = /^m:[A-Za-z0-9._-]{1,48}$/
/** `m:Claude_Code` → `MCP: Claude Code`. */
export const mcpCallerLabel = (key: string) => `MCP: ${key.slice(2).replace(/_/g, ' ')}`

/** The name an agent goes by: the OAuth client's registration, the API key, else the person. */
export function mcpClientNameOf(req: {
  oauthClientName?: string
  apiKeyName?: string
  user?: { first_name?: string | null; last_name?: string | null; email?: string | null } | null
}): string {
  if (req.oauthClientName) return req.oauthClientName
  if (req.apiKeyName) return req.apiKeyName
  const u = req.user
  const person = `${u?.first_name ?? ''} ${u?.last_name ?? ''}`.trim() || u?.email?.split('@')[0]
  return person ? `${person} token` : 'Assistant'
}

const TOOL_RE = /^[a-z][a-z0-9_]{0,59}$/

/**
 * The MCP stamp of a finished request, or null when it did not come through /api/mcp:
 * the outer row's own stamp (routes/mcp.ts), else an inner call's connection + tool.
 */
export function mcpStampOf(req: FastifyRequest, path: string): McpCallStamp | null {
  if (req.mcpCall) return req.mcpCall
  const isOuter = path === '/api/mcp'
  if (!req.mcpInner && !isOuter) return null
  const conn = mcpConnOf(req)
  if (!conn) return null
  const raw = req.mcpInner ? req.headers['x-nivaro-mcp-tool'] : undefined
  const tool = typeof raw === 'string' && TOOL_RE.test(raw) ? raw : null
  return { conn, client: clientSlug(mcpClientNameOf(req)), tool }
}

// ─── JSON-RPC (pure) ─────────────────────────────────────────────────────────

export interface RpcCall {
  method: string | null
  /** The tool a `tools/call` names. */
  tool: string | null
  id: string | number | null
}

/** What a POST /api/mcp body asks for (the first message of a batch). */
export function rpcCallOf(body: unknown): RpcCall {
  const msg = Array.isArray(body) ? body[0] : body
  if (!msg || typeof msg !== 'object') return { method: null, tool: null, id: null }
  const m = msg as { method?: unknown; params?: { name?: unknown }; id?: unknown }
  const method = typeof m.method === 'string' ? m.method.slice(0, 60) : null
  const name = m.params?.name
  const tool =
    method === 'tools/call' && typeof name === 'string' && TOOL_RE.test(name) ? name : null
  const id = typeof m.id === 'string' || typeof m.id === 'number' ? m.id : null
  return { method, tool, id }
}

const isRefusalStatus = (s: unknown) => typeof s === 'number' && s >= 400 && s < 500

/**
 * How a tool call ended, from the JSON-RPC answer: `ok`; `refused` — the API or the tool said
 * no (4xx, a guard's code, an unknown tool or bad arguments); `error` — it broke (5xx, the
 * network, an internal error). `head` may be cut short: an answer too long to parse whole is a
 * success unless its tail says `"isError":true`.
 */
export function classifyToolAnswer(head: string, tail = ''): McpOutcome {
  let msg: unknown
  try {
    msg = JSON.parse(head)
  } catch {
    return /"isError"\s*:\s*true/.test(tail) ? 'error' : 'ok'
  }
  const one = (Array.isArray(msg) ? msg[0] : msg) as
    | {
        error?: { code?: number }
        result?: { isError?: boolean; content?: Array<{ type?: string; text?: string }> }
      }
    | undefined
  if (!one) return 'ok'
  if (one.error) return one.error.code === -32603 ? 'error' : 'refused'
  if (!one.result?.isError) return 'ok'
  const text = one.result.content?.find((c) => c.type === 'text')?.text
  try {
    const failure = JSON.parse(text ?? '') as { status?: number; code?: string }
    if (isRefusalStatus(failure.status)) return 'refused'
    if (failure.status == null && failure.code && failure.code !== 'NETWORK_ERROR') return 'refused'
  } catch {
    // a tool's own prose error
  }
  return 'error'
}

/** What a failed tool call said (`"Forbidden (403, FORBIDDEN)"`), ≤ 1000 chars; null on success. */
export function toolAnswerMessage(head: string): string | null {
  let msg: unknown
  try {
    msg = JSON.parse(head)
  } catch {
    return null
  }
  const one = (Array.isArray(msg) ? msg[0] : msg) as
    | {
        error?: { message?: string }
        result?: { isError?: boolean; content?: Array<{ type?: string; text?: string }> }
      }
    | undefined
  if (one?.error) return String(one.error.message ?? 'JSON-RPC error').slice(0, 1000)
  if (!one?.result?.isError) return null
  const text = one.result.content?.find((c) => c.type === 'text')?.text ?? ''
  try {
    const f = JSON.parse(text) as { error?: string; status?: number; code?: string }
    const tag = [f.status, f.code].filter((x) => x != null && x !== '').join(', ')
    return `${f.error ?? 'Failed'}${tag ? ` (${tag})` : ''}`.slice(0, 1000)
  } catch {
    return text.slice(0, 1000) || 'Failed'
  }
}

const HEAD_CAP = 16 * 1024
const TAIL_CAP = 512

/**
 * Watch what a hijacked response writes: total bytes, the first 16 KB and the last 512 bytes.
 * `done` runs once, from the final `end()` — before the 'finish' event the request logger
 * listens for, so the stamp it sets is on the row.
 */
export function watchResponse(
  raw: ServerResponse,
  done: (head: string, tail: string, bytes: number) => void
): void {
  const chunks: Buffer[] = []
  let headLen = 0
  let tail = Buffer.alloc(0)
  let bytes = 0
  const note = (chunk: unknown, encoding?: unknown) => {
    if (chunk == null || typeof chunk === 'function') return
    const buf = Buffer.isBuffer(chunk)
      ? chunk
      : chunk instanceof Uint8Array
        ? Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
        : Buffer.from(
            String(chunk),
            typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8'
          )
    bytes += buf.length
    if (headLen < HEAD_CAP) {
      const take = buf.subarray(0, HEAD_CAP - headLen)
      chunks.push(take)
      headLen += take.length
    }
    tail = Buffer.concat([tail, buf]).subarray(-TAIL_CAP)
  }
  const write = raw.write.bind(raw)
  const end = raw.end.bind(raw)
  let finished = false
  // Some responses (light-my-request's) write the end chunk through write(): count it once.
  let ending = false
  raw.write = ((chunk: unknown, ...rest: unknown[]) => {
    if (!ending) note(chunk, rest[0])
    return (write as (...a: unknown[]) => boolean)(chunk, ...rest)
  }) as typeof raw.write
  raw.end = ((chunk?: unknown, ...rest: unknown[]) => {
    if (!finished) note(chunk, rest[0])
    if (!finished) {
      finished = true
      try {
        const head = Buffer.concat(chunks).toString('utf8')
        done(bytes > HEAD_CAP ? '' : head, tail.toString('utf8'), bytes)
      } catch {
        /* the log must never affect a response */
      }
    }
    ending = true
    try {
      return (end as (...a: unknown[]) => ServerResponse)(chunk, ...rest)
    } finally {
      ending = false
    }
  }) as typeof raw.end
}

// ─── Settings (nivaro_settings.mcp_settings, migration 480) ──────────────────

export interface McpSettings {
  /** An OAuth connection unused this long is flagged to its owner. */
  idle_flag_days: number
  /** …and disconnected at this age, after a notice 7 days before. */
  idle_revoke_days: number
  /** Tool calls one connection may make a minute (0 = no limit). */
  rate_limit_per_minute: number
  /** Per-connection overrides of the limit, by connection key. */
  connection_limits: Record<string, number>
}

export const MCP_SETTINGS_DEFAULTS: McpSettings = {
  idle_flag_days: 60,
  idle_revoke_days: 90,
  rate_limit_per_minute: 120,
  connection_limits: {}
}
/** The notice before an idle disconnection. */
export const IDLE_NOTICE_DAYS = 7
const MAX_OVERRIDES = 500

const int = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) ? v : Number.NaN)

/** Validate a settings patch merged onto `base`; throws a plain sentence when it does not hold. */
export function mergeMcpSettings(base: McpSettings, patch: unknown): McpSettings {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch))
    throw new Error('Settings must be an object')
  const p = patch as Record<string, unknown>
  const out: McpSettings = { ...base, connection_limits: { ...base.connection_limits } }
  if (p.idle_flag_days !== undefined) {
    const n = int(p.idle_flag_days)
    if (!(n >= 7 && n <= 365)) throw new Error('Flag after must be 7 to 365 days')
    out.idle_flag_days = n
  }
  if (p.idle_revoke_days !== undefined) {
    const n = int(p.idle_revoke_days)
    if (!(n >= 14 && n <= 730)) throw new Error('Disconnect after must be 14 to 730 days')
    out.idle_revoke_days = n
  }
  if (out.idle_revoke_days < out.idle_flag_days + IDLE_NOTICE_DAYS)
    throw new Error(
      `Disconnect after must be at least ${IDLE_NOTICE_DAYS} days later than flag after`
    )
  if (p.rate_limit_per_minute !== undefined) {
    const n = int(p.rate_limit_per_minute)
    if (!(n >= 0 && n <= 10_000)) throw new Error('The rate limit must be 0 to 10,000 a minute')
    out.rate_limit_per_minute = n
  }
  if (p.connection_limits !== undefined) {
    const m = p.connection_limits
    if (!m || typeof m !== 'object' || Array.isArray(m))
      throw new Error('connection_limits must be an object')
    for (const [k, v] of Object.entries(m as Record<string, unknown>)) {
      if (!CONN_RE.test(k)) throw new Error(`${k} is not a connection`)
      if (v === null) {
        delete out.connection_limits[k]
        continue
      }
      const n = int(v)
      if (!(n >= 0 && n <= 10_000)) throw new Error('A connection limit must be 0 to 10,000')
      out.connection_limits[k] = n
    }
    if (Object.keys(out.connection_limits).length > MAX_OVERRIDES)
      throw new Error(`At most ${MAX_OVERRIDES} connection limits`)
  }
  return out
}

/** A stored value read leniently: anything invalid reads as its default. */
function lenient(raw: unknown): McpSettings {
  let v: unknown = raw
  if (typeof raw === 'string') {
    try {
      v = raw ? JSON.parse(raw) : null
    } catch {
      v = null
    }
  }
  if (!v || typeof v !== 'object') return MCP_SETTINGS_DEFAULTS
  let out = MCP_SETTINGS_DEFAULTS
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    try {
      out = mergeMcpSettings(out, { [k]: val })
    } catch {
      // keep the default
    }
  }
  return out
}

const cache = new Map<string, { at: number; value: McpSettings }>()

/** Effective settings (instance overrides overlaid). Never throws; 60 s cache per tenant. */
export async function readMcpSettings(): Promise<McpSettings> {
  const key = getTenantId() ?? ''
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < 60_000) return hit.value
  let value = MCP_SETTINGS_DEFAULTS
  try {
    if (await hasColumn('nivaro_settings', 'mcp_settings')) {
      const row = (await db('nivaro_settings').where('id', 1).first('mcp_settings')) as
        | { mcp_settings?: unknown }
        | undefined
      const overlaid = await overlaySettings(row)
      value = lenient(overlaid?.mcp_settings)
    }
  } catch {
    value = MCP_SETTINGS_DEFAULTS
  }
  cache.set(key, { at: Date.now(), value })
  return value
}

/** Store a validated patch on the shared row. False when the column is not there yet. */
export async function writeMcpSettings(patch: unknown): Promise<McpSettings | false> {
  if (!(await hasColumn('nivaro_settings', 'mcp_settings'))) return false
  const row = (await db('nivaro_settings').where('id', 1).first('mcp_settings')) as
    | { mcp_settings?: unknown }
    | undefined
  const next = mergeMcpSettings(lenient(row?.mcp_settings), patch)
  await db('nivaro_settings')
    .where('id', 1)
    .update({ mcp_settings: JSON.stringify(next) })
  cache.clear()
  return next
}

export function bustMcpSettings(): void {
  cache.clear()
}

/** The tool-call limit a connection runs under (0 = none). */
export function connectionLimit(settings: McpSettings, conn: string): number {
  return settings.connection_limits[conn] ?? settings.rate_limit_per_minute
}

// ─── Log columns ─────────────────────────────────────────────────────────────

/** The api_logs columns of a stamp (nothing for a request that did not come through MCP). */
export function mcpLogColumns(stamp: McpCallStamp | null): Record<string, string | number | null> {
  if (!stamp) return {}
  return {
    mcp_conn: stamp.conn,
    mcp_client: stamp.client,
    mcp_tool: stamp.tool,
    mcp_outcome: stamp.outcome ?? null,
    mcp_bytes: stamp.bytes ?? null
  }
}

/** True when the request log has the MCP columns (per tenant, cached by the probe). */
export const hasMcpLogColumns = () => hasColumn('nivaro_api_logs', 'mcp_conn')
