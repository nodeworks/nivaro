import type { FastifyInstance, FastifyRequest } from 'fastify'
import { requireAdmin } from '../middleware/authenticate.js'
import { mcpPublicOrigin } from '../services/mcp-config.js'
import { injectFetch, loadMcp, mcpInstanceTools, mcpToolOptions } from './mcp.js'

/**
 * Admin MCP console (#2468) — /api/mcp-console.
 *
 *   GET  /tools   the tools a connected app signed in as this administrator would get
 *                 (the same mcpToolOptions rule /api/mcp uses), with input schemas
 *   POST /run     { tool, arguments, dry_run } → { result, compact, ms, chars, calls, … }
 *
 * The console builds the same @nivaro/mcp server /api/mcp builds and talks to it over an
 * in-memory transport, so a run is exactly what an assistant's call would be: every request a
 * tool makes goes back into this API in-process as the administrator (their session or bearer)
 * and is judged like any other. Calls carry `x-nivaro-app: mcp-console`, not the MCP inner
 * marker, so they never count as a connected app's traffic.
 *
 * Dry run (the default for every tool that can write): a tool with its own `dry_run` argument
 * rehearses (create_item); any other request a write tool makes besides a GET is NOT sent —
 * the console answers it with a refusal and lists what would have gone out. Read tools run
 * as they are (some reads are POSTs with a body).
 */

const DRY_RUN_CODE = 'MCP_CONSOLE_DRY_RUN'
const MAX_CALLS = 100
const MAX_BODY_CHARS = 4_000

interface ToolInfo {
  name: string
  title?: string
  description?: string
  inputSchema?: { properties?: Record<string, unknown> }
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean }
}

export interface ConsoleCall {
  method: string
  path: string
  status: number
  ms: number
  /** Dry run: the console did not send it. */
  held?: true
  body?: unknown
}

const isWrite = (t: ToolInfo) => t.annotations?.readOnlyHint !== true
const hasDryRunArg = (t: ToolInfo) => !!t.inputSchema?.properties?.dry_run

function bodyOf(raw: unknown): unknown {
  if (typeof raw !== 'string' || !raw) return undefined
  const clipped = raw.length > MAX_BODY_CHARS ? `${raw.slice(0, MAX_BODY_CHARS)}…` : raw
  try {
    return raw.length > MAX_BODY_CHARS ? clipped : JSON.parse(raw)
  } catch {
    return clipped
  }
}

/** A rehearsal the API itself honours: `?dry_run=1` (items create). */
const rehearsed = (url: URL) => {
  const v = url.searchParams.get('dry_run')
  return v === '1' || v === 'true'
}

/**
 * The fetch a console run uses: records every call, and — while `hold()` says so — answers
 * every request but a GET/HEAD or an API rehearsal itself instead of sending it.
 */
export function consoleFetch(
  inner: typeof fetch,
  calls: ConsoleCall[],
  hold: () => boolean
): typeof fetch {
  return (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    )
    const method = (init?.method ?? 'GET').toUpperCase()
    const path = `${url.pathname}${url.search}`
    const t0 = performance.now()
    if (hold() && method !== 'GET' && method !== 'HEAD' && !rehearsed(url)) {
      if (calls.length < MAX_CALLS)
        calls.push({ method, path, status: 0, ms: 0, held: true, body: bodyOf(init?.body) })
      return new Response(
        JSON.stringify({
          error: `Dry run: the console did not send ${method} ${url.pathname}`,
          code: DRY_RUN_CODE
        }),
        { status: 409, headers: { 'content-type': 'application/json' } }
      )
    }
    const res = await inner(input, init)
    if (calls.length < MAX_CALLS)
      calls.push({ method, path, status: res.status, ms: Math.round(performance.now() - t0) })
    return res
  }) as typeof fetch
}

/** The result's text block as JSON when it is JSON, else the text, else null. */
export function compactOf(result: { content?: unknown }): { value: unknown; chars: number } {
  const content = Array.isArray(result.content) ? result.content : []
  const text = content
    .filter(
      (c): c is { type: 'text'; text: string } => c?.type === 'text' && typeof c.text === 'string'
    )
    .map((c) => c.text)
    .join('\n')
  if (!text) return { value: null, chars: 0 }
  try {
    return { value: JSON.parse(text), chars: text.length }
  } catch {
    return { value: text, chars: text.length }
  }
}

async function connect(req: FastifyRequest, f: typeof fetch) {
  const { createNivaroMcpServer } = await loadMcp()
  const [{ Client }, { InMemoryTransport }] = await Promise.all([
    import('@modelcontextprotocol/sdk/client/index.js'),
    import('@modelcontextprotocol/sdk/inMemory.js')
  ])
  const { server } = createNivaroMcpServer({
    url: mcpPublicOrigin(),
    // A placeholder: the console's fetch forwards the administrator's own session or bearer.
    token: 'mcp-console',
    fetch: f,
    ...mcpToolOptions(req),
    instanceTools: await mcpInstanceTools(req)
  } as Parameters<typeof createNivaroMcpServer>[0])
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'nivaro-mcp-console', version: '1.0.0' })
  await server.connect(serverSide)
  await client.connect(clientSide)
  return {
    client,
    close: async () => {
      await client.close().catch(() => {})
      await server.close().catch(() => {})
    }
  }
}

const base = (app: FastifyInstance, req: FastifyRequest) =>
  injectFetch(app, req, { cookie: true, inner: false, app: 'mcp-console' })

export async function mcpConsoleRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin)

  app.get('/tools', async (req) => {
    const mcp = await connect(req, base(app, req))
    try {
      const { tools } = await mcp.client.listTools()
      const { ADMIN_TOOL_NAMES, INFRA_TOOL_NAMES, LAYOUT_TOOL_NAMES } = await import('@nivaro/mcp')
      const adminOnly = new Set<string>([
        ...ADMIN_TOOL_NAMES,
        ...LAYOUT_TOOL_NAMES,
        ...INFRA_TOOL_NAMES
      ])
      return {
        admin_tools: mcpToolOptions(req).adminTools,
        chat_access: mcpToolOptions(req).chatAccess,
        tools: (tools as ToolInfo[]).map((t) => ({
          name: t.name,
          title: t.title ?? null,
          description: t.description ?? null,
          input_schema: t.inputSchema ?? { type: 'object' },
          annotations: t.annotations ?? {},
          write: isWrite(t),
          dry_run_arg: hasDryRunArg(t),
          group: adminOnly.has(t.name) ? 'admin' : 'everyday'
        }))
      }
    } finally {
      await mcp.close()
    }
  })

  app.post('/run', async (req, reply) => {
    const body = (req.body ?? {}) as { tool?: unknown; arguments?: unknown; dry_run?: unknown }
    const name = typeof body.tool === 'string' ? body.tool : ''
    if (!name) return reply.code(400).send({ error: 'Name a tool', code: 'TOOL_REQUIRED' })
    const args =
      body.arguments && typeof body.arguments === 'object' && !Array.isArray(body.arguments)
        ? { ...(body.arguments as Record<string, unknown>) }
        : {}
    const dryRun = body.dry_run !== false

    const calls: ConsoleCall[] = []
    let holding = false
    const mcp = await connect(
      req,
      consoleFetch(base(app, req), calls, () => holding)
    )
    try {
      const { tools } = await mcp.client.listTools()
      const tool = (tools as ToolInfo[]).find((t) => t.name === name)
      if (!tool)
        return reply
          .code(404)
          .send({ error: `${name} is not one of your MCP tools`, code: 'TOOL_NOT_FOUND' })
      const write = isWrite(tool)
      const rehearses = write && dryRun && hasDryRunArg(tool)
      // A write tool that rehearses itself is told to; any other write is held at the fetch.
      if (rehearses) args.dry_run = true
      // Dry run off: a tool that rehearses by default (create_item) stores for real.
      else if (write && !dryRun && hasDryRunArg(tool) && args.dry_run === undefined)
        args.dry_run = false
      holding = write && dryRun
      const t0 = performance.now()
      const result = await mcp.client.callTool({ name, arguments: args }, undefined, {
        timeout: 120_000
      })
      const ms = Math.round(performance.now() - t0)
      const compact = compactOf(result as { content?: unknown })
      return {
        tool: name,
        arguments: args,
        is_error: result.isError === true,
        ms,
        chars: compact.chars,
        compact: compact.value,
        result,
        calls,
        dry_run: !write ? 'not_needed' : !dryRun ? 'off' : rehearses ? 'tool' : 'held'
      }
    } catch (err) {
      return reply.code(422).send({
        error: (err as Error).message || 'The tool call failed',
        code: 'TOOL_CALL_FAILED',
        calls
      })
    } finally {
      await mcp.close()
    }
  })
}
