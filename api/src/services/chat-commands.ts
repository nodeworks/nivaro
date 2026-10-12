import type { ChatCommandDef } from '@nivaro/extension-kit'

/**
 * Slash commands an extension adds to the chat composer (#2338).
 *
 * The four built-ins (/task /remind /poll /note) are inline forms in the
 * client; this registry only holds what extensions register. The command runs
 * server-side AS the person typing it — the route checks they can see the room
 * first — and returns text to post and/or a private reply.
 */

export const BUILTIN_COMMANDS = ['task', 'remind', 'poll', 'note'] as const
const NAME_RE = /^[a-z][a-z0-9-]{1,23}$/

interface Registered extends ChatCommandDef {
  extension: string
}

const commands = new Map<string, Registered>()

/** Returns false (and registers nothing) for a bad or colliding name. */
export function registerChatCommand(extension: string, def: ChatCommandDef): boolean {
  const name = String(def?.name ?? '')
    .toLowerCase()
    .replace(/^\//, '')
  if (!NAME_RE.test(name)) return false
  if ((BUILTIN_COMMANDS as readonly string[]).includes(name)) return false
  if (typeof def.run !== 'function') return false
  const prior = commands.get(name)
  // Two extensions never share a name; a reload of the same one replaces it.
  if (prior && prior.extension !== extension) return false
  commands.set(name, {
    ...def,
    name,
    description: String(def.description ?? '').slice(0, 140),
    extension
  })
  return true
}

export function unregisterChatCommands(extension: string): void {
  for (const [k, v] of commands) if (v.extension === extension) commands.delete(k)
}

/** Test seam: replaced in tests so the loader (and its imports) never loads. */
let isEnabled: (extension: string) => Promise<boolean> = async (extension) => {
  const { extensionRegistry } = await import('../extensions/loader.js')
  return extensionRegistry.get(extension)?.enabled !== false
}
export function _setExtensionEnabledCheck(fn: typeof isEnabled): void {
  isEnabled = fn
}

export async function listChatCommands(): Promise<
  Array<{ name: string; description: string; usage: string | null; extension: string }>
> {
  const live: Registered[] = []
  for (const c of commands.values()) if (await isEnabled(c.extension)) live.push(c)
  return live
    .map((c) => ({
      name: c.name,
      description: c.description,
      usage: c.usage ?? null,
      extension: c.extension
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

export async function runChatCommand(
  name: string,
  args: string,
  ctx: { userId: string; room: string }
): Promise<{ post?: string; reply?: string } | null> {
  const c = commands.get(String(name).toLowerCase())
  if (!c) return null
  // The extension kill switch: a disabled extension's code never runs.
  if (!(await isEnabled(c.extension))) return null
  const out = await c.run(String(args ?? '').slice(0, 2000), ctx)
  if (!out) return {}
  return {
    post: out.post ? String(out.post).slice(0, 8000) : undefined,
    reply: out.reply ? String(out.reply).slice(0, 2000) : undefined
  }
}

/** Test seam. */
export function _resetChatCommands(): void {
  commands.clear()
}
