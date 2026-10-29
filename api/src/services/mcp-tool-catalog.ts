import type { FastifyRequest } from 'fastify'

/**
 * Every MCP tool name a connection could be given (#3205 scope editor, #3214 kits, #3206
 * suggestions): the built-ins as @nivaro/mcp registers them with every option on (listed once
 * per process over an in-memory transport, so titles and read-only hints come from the tools
 * themselves), plus the instance's own tools the caller may use.
 */

export type CatalogGroup = 'everyday' | 'chat' | 'admin' | 'instance'

export interface CatalogTool {
  name: string
  title: string
  description: string
  group: CatalogGroup
  read_only: boolean
}

let builtins: Promise<CatalogTool[]> | null = null

/** The built-in tools (static per build). Never calls the API: the fetch it is given refuses. */
export function builtinToolCatalog(): Promise<CatalogTool[]> {
  builtins ??= (async () => {
    const [m, { Client }, { InMemoryTransport }] = await Promise.all([
      import('@nivaro/mcp'),
      import('@modelcontextprotocol/sdk/client/index.js'),
      import('@modelcontextprotocol/sdk/inMemory.js')
    ])
    const { server } = m.createNivaroMcpServer({
      url: 'http://catalog.invalid',
      token: 'catalog',
      adminTools: true,
      chatAccess: 'post',
      fetch: (async () => new Response('{}', { status: 503 })) as typeof fetch
    })
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
    const client = new Client({ name: 'nivaro-tool-catalog', version: '1.0.0' })
    await server.connect(serverSide)
    await client.connect(clientSide)
    try {
      const { tools } = await client.listTools()
      const admin = new Set<string>([
        ...m.ADMIN_TOOL_NAMES,
        ...m.LAYOUT_TOOL_NAMES,
        ...m.INFRA_TOOL_NAMES
      ])
      const chat = new Set<string>(m.CHAT_TOOL_NAMES)
      return tools.map(
        (t): CatalogTool => ({
          name: t.name,
          title: t.title ?? t.annotations?.title ?? t.name,
          description: (t.description ?? '').slice(0, 300),
          group: admin.has(t.name) ? 'admin' : chat.has(t.name) ? 'chat' : 'everyday',
          read_only: t.annotations?.readOnlyHint === true
        })
      )
    } finally {
      await client.close().catch(() => {})
      await server.close().catch(() => {})
    }
  })().catch((err) => {
    builtins = null
    throw err
  })
  return builtins
}

/**
 * The catalog this caller may hand out: administrators see every tool (admin ones included);
 * anyone else the everyday and chat tools plus the instance tools they can call.
 */
export async function toolCatalogFor(req: FastifyRequest): Promise<CatalogTool[]> {
  const { instanceToolCatalog, mcpCallerAccess } = await import('./mcp-tools.js')
  const access = mcpCallerAccess(req)
  const [base, instance] = await Promise.all([
    builtinToolCatalog(),
    instanceToolCatalog(access).catch(() => [])
  ])
  const names = new Set(base.map((t) => t.name))
  const out = base.filter((t) => access.isAdmin || t.group !== 'admin')
  for (const t of instance) {
    if (names.has(t.name)) continue
    out.push({
      name: t.name,
      title: t.title,
      description: t.description.slice(0, 300),
      group: 'instance',
      read_only: t.read_only
    })
  }
  return out
}
