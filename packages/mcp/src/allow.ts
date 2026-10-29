/**
 * A connection's tool allowlist (#3205): every tool registered on `server` whose name is not in
 * `allowed` is removed the moment it is registered, so it is neither listed nor callable (a call
 * answers "tool not found"). The hosted endpoint also refuses the API calls such a tool would
 * make, so this is the first of two gates, not the only one. Call once, before the tools are
 * registered.
 */
interface ToolRegistrar {
  registerTool: (name: string, config: unknown, cb: (...args: never[]) => unknown) => unknown
}

export function restrictTools(server: object, allowed: Iterable<string>): void {
  const allow = new Set(allowed)
  const s = server as ToolRegistrar
  const orig = s.registerTool.bind(s)
  s.registerTool = (name, config, cb) => {
    const registered = orig(name, config, cb) as { remove?: () => void } | undefined
    if (!allow.has(name)) registered?.remove?.()
    return registered
  }
}
