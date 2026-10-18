/**
 * Tell the instance that a call came through the MCP server, and through which tool, so an
 * administrator's Traffic Map can show AI assistants as their own source (tools used, API keys,
 * errors). Two headers, no payload: `x-nivaro-app: mcp` and `x-nivaro-mcp-tool: <tool>`.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

const currentTool = new AsyncLocalStorage<string>()

/** A fetch that adds the identifying headers to every request it forwards to `inner`. */
export function identifyingFetch(inner?: typeof fetch): typeof fetch {
  const base = inner ?? globalThis.fetch
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    headers.set('x-nivaro-app', 'mcp')
    const tool = currentTool.getStore()
    if (tool) headers.set('x-nivaro-mcp-tool', tool)
    return base(input, { ...init, headers })
  }) as typeof fetch
}

interface ToolRegistrar {
  registerTool: (name: string, config: unknown, cb: (...args: never[]) => unknown) => unknown
}

/**
 * Make every tool handler registered on `server` run with its name in scope, so the calls it
 * makes carry `x-nivaro-mcp-tool`. Call once, before the tools are registered.
 */
export function tagToolCalls(server: object): void {
  const s = server as ToolRegistrar
  const orig = s.registerTool.bind(s)
  s.registerTool = (name, config, cb) =>
    orig(name, config, ((...args: never[]) =>
      currentTool.run(name, () => cb(...args))) as typeof cb)
}
