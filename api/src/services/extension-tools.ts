import type {
  ExtensionToolDef,
  ExtensionToolHelpers,
  ToolFieldList,
  ToolInputSchema
} from '@nivaro/extension-kit'
import type { User } from '../types.js'

/**
 * Tools extensions hand to assistants: `ctx.mcp.registerTool` (#2465) and
 * `ctx.ai.registerTool` (#2735). One registry per channel, one declaration
 * shape for both, so an extension can pass the same definition to each.
 *
 * Every handler runs AS the caller — the MCP client's user, the person asking
 * Ask AI — with helpers that read through the items service, check field
 * lists through ai-aggregate-guard and label links through ai-link-labels.
 * A disabled extension's tools are neither listed nor run (the kill switch).
 */

export type ToolChannel = 'mcp' | 'ai'

export interface ExtensionTool {
  extension: string
  channel: ToolChannel
  name: string
  title: string
  description: string
  input_schema: ToolInputSchema
  read_only: boolean
  /** Ask AI only: answers that used it may be shared (only with read_only). */
  replayable: boolean
  field_lists: ToolFieldList[]
  handler: ExtensionToolDef['handler']
  stats: { calls: number; errors: number; last_used_at: string | null; last_error: string | null }
}

const NAME_RE = /^[a-z][a-z0-9_]{2,47}$/
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
/** One call's time cap — a hung handler must not hold an MCP request or an answer. */
export const TOOL_TIMEOUT_MS = 30_000

const registries: Record<ToolChannel, Map<string, ExtensionTool>> = {
  mcp: new Map(),
  ai: new Map()
}

/** Either registerTool spelling → one declaration, or the reason it is refused. */
export function normalizeToolArgs(
  args: unknown[]
): { def: ExtensionToolDef & { replayable?: boolean } } | { error: string } {
  let raw: Record<string, unknown>
  if (args[0] && typeof args[0] === 'object') raw = args[0] as Record<string, unknown>
  else {
    const opts = (args[3] && typeof args[3] === 'object' ? args[3] : {}) as Record<string, unknown>
    raw = { ...opts, name: args[0], input_schema: args[1], handler: args[2] }
  }
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (!NAME_RE.test(name))
    return { error: `name "${String(raw.name)}" must be 3–48 lower-case letters, digits or _` }
  if (typeof raw.handler !== 'function') return { error: `${name}: handler must be a function` }
  const schema = raw.input_schema ?? { type: 'object', properties: {} }
  if (!schema || typeof schema !== 'object' || Array.isArray(schema))
    return { error: `${name}: input_schema must be a JSON Schema object` }
  const s = schema as Record<string, unknown>
  if (s.type != null && s.type !== 'object')
    return { error: `${name}: input_schema must describe an object` }
  const fieldLists: ToolFieldList[] = []
  for (const f of Array.isArray(raw.field_lists) ? raw.field_lists : []) {
    const fl = f as ToolFieldList
    if (!fl || !KEY_RE.test(String(fl.fields_key ?? '')))
      return { error: `${name}: field_lists needs a fields_key` }
    if (!fl.collection && !KEY_RE.test(String(fl.collection_key ?? '')))
      return { error: `${name}: field_lists needs a collection or a collection_key` }
    fieldLists.push({
      fields_key: fl.fields_key,
      ...(fl.collection ? { collection: String(fl.collection) } : {}),
      ...(fl.collection_key ? { collection_key: String(fl.collection_key) } : {})
    })
  }
  return {
    def: {
      name,
      title:
        typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim().slice(0, 80) : name,
      description: String(raw.description ?? '')
        .trim()
        .slice(0, 1000),
      input_schema: { ...s, type: 'object', properties: s.properties ?? {} },
      read_only: raw.read_only === true,
      replayable: raw.replayable === true,
      field_lists: fieldLists,
      handler: raw.handler as ExtensionToolDef['handler']
    }
  }
}

/** Register one tool; refuses (and registers nothing) on a bad or taken name. */
export function registerExtensionTool(
  channel: ToolChannel,
  extension: string,
  args: unknown[]
): { ok: true; name: string } | { ok: false; error: string } {
  const out = normalizeToolArgs(args)
  if ('error' in out) return { ok: false, error: out.error }
  const { def } = out
  const prior = registries[channel].get(def.name)
  // Two extensions never share a name; a reload of the same one replaces it.
  if (prior && prior.extension !== extension)
    return { ok: false, error: `${def.name} is already registered by ${prior.extension}` }
  if (!def.description) return { ok: false, error: `${def.name}: a description is required` }
  registries[channel].set(def.name, {
    extension,
    channel,
    name: def.name,
    title: def.title ?? def.name,
    description: def.description,
    input_schema: def.input_schema,
    read_only: def.read_only === true,
    // Only a read can be replayed as another reader.
    replayable: channel === 'ai' && def.read_only === true && def.replayable === true,
    field_lists: def.field_lists ?? [],
    handler: def.handler,
    stats: prior?.stats ?? { calls: 0, errors: 0, last_used_at: null, last_error: null }
  })
  return { ok: true, name: def.name }
}

export function unregisterExtensionTools(extension: string): void {
  for (const reg of Object.values(registries))
    for (const [k, v] of reg) if (v.extension === extension) reg.delete(k)
}

/** Test seam: replaced in tests so the loader (and its imports) never loads. */
let isEnabled: (extension: string) => Promise<boolean> = async (extension) => {
  const { extensionRegistry } = await import('../extensions/loader.js')
  return extensionRegistry.get(extension)?.enabled !== false
}
export function _setExtensionToolsEnabledCheck(fn: typeof isEnabled): void {
  isEnabled = fn
}
export function _resetExtensionTools(): void {
  registries.mcp.clear()
  registries.ai.clear()
}

/** The tools of enabled extensions on one channel, by name. */
export async function liveExtensionTools(channel: ToolChannel): Promise<ExtensionTool[]> {
  const live: ExtensionTool[] = []
  for (const t of registries[channel].values()) if (await isEnabled(t.extension)) live.push(t)
  return live.sort((a, b) => a.name.localeCompare(b.name))
}

/** Every registered tool on a channel with whether its extension is on and
 *  its calls since boot — for the admin pages (/ai-quality, /mcp-tools). */
export async function extensionToolRoster(channel: ToolChannel): Promise<
  Array<{
    name: string
    title: string
    extension: string
    description: string
    read_only: boolean
    replayable: boolean
    enabled: boolean
    input_schema: ToolInputSchema
    stats: ExtensionTool['stats']
  }>
> {
  const out = []
  for (const t of registries[channel].values())
    out.push({
      name: t.name,
      title: t.title,
      extension: t.extension,
      description: t.description,
      read_only: t.read_only,
      replayable: t.replayable,
      enabled: await isEnabled(t.extension),
      input_schema: t.input_schema,
      stats: { ...t.stats }
    })
  return out.sort((a, b) => a.extension.localeCompare(b.extension) || a.name.localeCompare(b.name))
}

/** Names Ask AI uses outside its CHAT_TOOLS list — never an extension tool's. */
export const AI_RESERVED_NAMES = ['suggest_memory', 'set_reminder', 'watch_record', 'product_help']

/**
 * The tools an Ask AI answer may call: `base` (the built-ins) plus every
 * enabled extension's ctx.ai tool whose name no built-in uses.
 */
export async function withExtensionAiTools<
  T extends { name: string; description?: string; input_schema: unknown }
>(base: T[]): Promise<T[]> {
  const ext = await liveExtensionTools('ai').catch(() => [] as ExtensionTool[])
  if (!ext.length) return base
  const taken = new Set([...base.map((t) => t.name), ...AI_RESERVED_NAMES])
  const extra = ext
    .filter((t) => !taken.has(t.name))
    .map(
      (t) =>
        ({
          name: t.name,
          description: `${t.description} (from the ${t.extension} extension)`.slice(0, 1100),
          input_schema: t.input_schema
        }) as unknown as T
    )
  return extra.length ? [...base, ...extra] : base
}

/** Synchronous lookup (no kill-switch check) — for tool routing. */
export function extensionTool(channel: ToolChannel, name: string): ExtensionTool | undefined {
  return registries[channel].get(name)
}

/** An Ask AI answer that used this tool may be replayed for other readers. */
export function isReplayableExtensionTool(name: string): boolean {
  return registries.ai.get(name)?.replayable === true
}

/** Everything one extension registered, for the extension registry sheet. */
export function describeExtensionTools(extension: string): {
  mcp_tools: Array<{ name: string; description: string; read_only: boolean }>
  ai_tools: Array<{ name: string; description: string; read_only: boolean; replayable: boolean }>
} {
  const of = (c: ToolChannel) =>
    [...registries[c].values()].filter((t) => t.extension === extension)
  return {
    mcp_tools: of('mcp').map((t) => ({
      name: t.name,
      description: t.description,
      read_only: t.read_only
    })),
    ai_tools: of('ai').map((t) => ({
      name: t.name,
      description: t.description,
      read_only: t.read_only,
      replayable: t.replayable
    }))
  }
}

export class ExtensionToolError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400
  ) {
    super(message)
  }
}

/** Required input keys the schema names but the call left out. Pure. */
export function missingRequired(schema: ToolInputSchema, input: Record<string, unknown>): string[] {
  const req = Array.isArray(schema.required) ? (schema.required as unknown[]) : []
  return req
    .map(String)
    .filter((k) => input[k] === undefined || input[k] === null || input[k] === '')
}

/** The (collection, fields) pairs a call's declared field lists name. Pure. */
export function fieldListsOf(
  lists: ToolFieldList[],
  input: Record<string, unknown>
): Array<{ collection: string; fields: string[] }> {
  const out: Array<{ collection: string; fields: string[] }> = []
  for (const fl of lists) {
    const raw = input[fl.fields_key]
    const fields = (Array.isArray(raw) ? raw : raw == null || raw === '' ? [] : [raw])
      .map((f) => String(f).trim())
      .filter(Boolean)
    if (!fields.length) continue
    const collection = fl.collection ?? String(input[fl.collection_key ?? ''] ?? '').trim()
    if (!collection) throw new ExtensionToolError(`${fl.collection_key} is required`)
    out.push({ collection, fields })
  }
  return out
}

function assertCollectionName(name: string): string {
  if (!/^[A-Za-z0-9_]+$/.test(name)) throw new ExtensionToolError('Invalid collection name')
  if (/^(nivaro|directus)_/i.test(name))
    throw new ExtensionToolError('System collections cannot be read by a tool')
  return name
}

/** The helpers a handler gets — every one acts AS `user`. */
export function toolHelpers(user: User): ExtensionToolHelpers {
  return {
    readItems: async (collection, query = {}) => {
      const { readItems } = await import('./items.js')
      const res = (await readItems(user, assertCollectionName(collection), {
        fields: Array.isArray(query.fields) ? query.fields.map(String) : undefined,
        filter: query.filter,
        sort: Array.isArray(query.sort) ? query.sort.map(String) : undefined,
        limit: Math.min(500, Math.max(1, Number(query.limit) || 25)),
        ...(query.search ? { search: String(query.search).slice(0, 200) } : {})
      })) as { data?: Array<Record<string, unknown>>; total?: number }
      return {
        data: res.data ?? [],
        ...(typeof res.total === 'number' ? { total: res.total } : {})
      }
    },
    assertFieldsReadable: async (collection, fields) => {
      const name = assertCollectionName(collection)
      const { can } = await import('./permissions.js')
      if (!(await can(user, 'read', name)))
        throw new ExtensionToolError(`No read access to ${name}`)
      const { chatFieldSet, chatRelationsFor } = await import('./ai-chat.js')
      const guard = await import('./ai-aggregate-guard.js')
      const all = await chatFieldSet(name)
      const readable = await guard.readableFieldSet(user, name, all)
      const paths = fields.map((f) => String(f).split('.').filter(Boolean)).filter((p) => p.length)
      for (const p of paths)
        if (p.length === 1 && !all.has(p[0]))
          throw new guard.FieldAccessError(guard.describeUnreadable(p[0], all, name))
      const hidden = new Set([...all].filter((f) => !readable.has(f)))
      await guard.assertFilterReadable(user, name, paths, hidden, chatRelationsFor, {
        subject: 'This tool'
      })
    },
    linkLabels: async (refs) => {
      const byTarget = new Map<string, Set<string>>()
      for (const r of Array.isArray(refs) ? refs.slice(0, 500) : []) {
        if (!r || r.id == null || typeof r.collection !== 'string') continue
        if (!/^[A-Za-z0-9_]+$/.test(r.collection)) continue
        const set = byTarget.get(r.collection) ?? new Set<string>()
        set.add(String(r.id))
        byTarget.set(r.collection, set)
      }
      if (!byTarget.size) return {}
      const { linkLabelsAsUser } = await import('./ai-link-labels.js')
      return linkLabelsAsUser(user, byTarget).catch(() => ({}))
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    p,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new ExtensionToolError('The tool took too long', 504)), ms)
      timer.unref?.()
    })
  ]).finally(() => clearTimeout(timer))
}

/**
 * Run one extension tool AS `user`. Refuses an unknown tool or one whose
 * extension is disabled (404), missing required input (400) and — for Ask AI
 * tools — a declared field list naming a field the caller cannot read.
 */
export async function runExtensionTool(
  channel: ToolChannel,
  user: User,
  name: string,
  input: Record<string, unknown>,
  helpers: ExtensionToolHelpers = toolHelpers(user)
): Promise<unknown> {
  const t = registries[channel].get(name)
  if (!t || !(await isEnabled(t.extension))) throw new ExtensionToolError('Unknown tool', 404)
  const args = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const missing = missingRequired(t.input_schema, args)
  if (missing.length) throw new ExtensionToolError(`Missing input: ${missing.join(', ')}`)
  t.stats.calls++
  t.stats.last_used_at = new Date().toISOString()
  try {
    for (const { collection, fields } of fieldListsOf(t.field_lists, args))
      await helpers.assertFieldsReadable(collection, fields)
    return await withTimeout(
      Promise.resolve(t.handler(user as never, args, helpers)),
      TOOL_TIMEOUT_MS
    )
  } catch (err) {
    t.stats.errors++
    t.stats.last_error = (err instanceof Error ? err.message : String(err)).slice(0, 300)
    throw err
  }
}

/** A short summary line for a tool result (Ask AI traces). Pure. */
export function summarizeToolResult(name: string, result: unknown): string {
  if (Array.isArray(result)) return `${name}: ${result.length} item(s)`
  if (result && typeof result === 'object') {
    const r = result as Record<string, unknown>
    for (const k of ['rows', 'data', 'items', 'results'])
      if (Array.isArray(r[k])) return `${name}: ${(r[k] as unknown[]).length} item(s)`
    if (typeof r.summary === 'string') return `${name}: ${r.summary.slice(0, 120)}`
  }
  return `${name}: done`
}
