// api/src/services/traffic-node-info.ts
/**
 * #2245 — a short description of what a Traffic Map node is.
 *
 * Order of authority: an admin's own words (settings `descriptions`, key `<kind>:<id>`), then
 * what the product already says (a collection's note, a custom query's or flow's description, a
 * background job's description, a partner's description, an extension's declared node), then a
 * built-in sentence for the system nodes and lanes. A node with none of these answers null and
 * the page offers the admin a place to write one.
 */
import { db } from '../db/index.js'
import { CRON_DESCRIPTIONS } from './cron-descriptions.js'
import { LANES } from './traffic-entities.js'
import { describeTrafficNode } from './traffic-taps/nodes.js'

export type NodeInfoKind = 'entity' | 'lane' | 'caller' | 'down'
export type NodeInfoSource = 'admin' | 'registry' | 'extension' | 'built-in'

export interface NodeInfo {
  kind: NodeInfoKind
  id: string
  /** What the page shows: the admin's text, else the automatic one; null = nothing to say. */
  text: string | null
  source: NodeInfoSource | null
  /** The automatic description, shown beside an override so it can be compared. */
  auto: string | null
  auto_source: NodeInfoSource | null
  /** The admin's own text, when one is saved. */
  override: string | null
}

export const KINDS: NodeInfoKind[] = ['entity', 'lane', 'caller', 'down']
const clip = (s: unknown, n = 500): string | null => {
  const t = typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : ''
  return t ? t.slice(0, n) : null
}

const LANE_TEXT: Record<string, string> = {
  items: 'Reads and writes of records in your collections, through /api/items and GraphQL.',
  widgets: 'Dashboard and report widgets being rendered for the people looking at them.',
  pages: 'Published pages loading their widget data.',
  queries: 'Custom SQL queries run through the API, each cached by its own settings.',
  graphql: 'GraphQL operations, grouped by operation name.',
  inbound: 'Calls from outside systems into a configured inbound key.',
  files: 'File uploads, downloads and thumbnails.',
  extension: 'Routes that installed extensions add to the API.',
  system: "The platform's own configuration tables: schema, roles, settings, workflows.",
  socket: 'Messages from open browser tabs on the realtime connection, after the handshake.',
  other: 'Every other API route that has no node of its own.'
}
const DOWN_TEXT: Record<string, string> = {
  db: 'The database. Every record read and write ends here.',
  redis: 'Redis: sessions, caches, locks and the pub/sub that links API processes.',
  store: 'File storage: where uploaded files live.',
  mail: 'Outgoing email through the configured SMTP server.',
  sms: 'Text messages through the configured SMS provider.',
  push: 'Browser push notifications.',
  teams: 'Microsoft Teams messages through the configured webhook.',
  'ai:anthropic': 'Calls to Anthropic for the AI features.',
  'ai:gateway-openai': 'Calls to the configured AI gateway (OpenAI wire format).',
  'ai:gateway-anthropic': 'Calls to the configured AI gateway (Anthropic wire format).'
}
const SOURCE_TEXT: Record<string, string> = {
  'import:worker': 'The staged-import worker that applies queued imports to your data.',
  'socket:browsers': 'Open browser tabs on the realtime connection.'
}
const CALLER_TEXT: Record<string, string> = {
  cron: 'Scheduled jobs and the other background work this API runs itself.',
  anon: 'Requests that carried no sign-in.'
}

/** The built-in sentence for a node (pure), or null. */
export function builtInText(kind: NodeInfoKind, id: string): string | null {
  if (kind === 'lane') return LANE_TEXT[id] ?? null
  if (kind === 'down') {
    if (DOWN_TEXT[id]) return DOWN_TEXT[id]
    if (id.startsWith('ext:')) return 'An outside system this API calls.'
    if (id.startsWith('webhook:')) return 'A webhook this API delivers events to.'
    return null
  }
  if (kind === 'caller') {
    if (CALLER_TEXT[id]) return CALLER_TEXT[id]
    if (SOURCE_TEXT[id]) return SOURCE_TEXT[id]
    if (id.startsWith('cron:')) return 'A scheduled job.'
    if (id.startsWith('flow:')) return 'A flow running on its trigger.'
    if (/^k\d+$/.test(id)) return 'An API key: an integration or script calling this API.'
    if (/^u[0-9a-f-]{36}$/i.test(id)) return 'A signed-in person.'
    return null
  }
  if (kind === 'entity') {
    const lane = id.split('/')[0]
    const name = id.slice(lane.length + 1)
    if (lane === 'items') return `Records of the ${name} collection.`
    if (lane === 'system') return `The platform's ${name} configuration table.`
    if (lane === 'graphql') return `The GraphQL operation ${name}.`
    if (lane === 'queries') return `The custom query ${name}.`
    if (lane === 'extension') return `Routes added by the ${name} extension.`
    if (lane === 'inbound') return `Calls into the inbound key ${name}.`
    if (lane === 'widgets') return 'A dashboard or report widget being rendered.'
    if (lane === 'pages') return 'A published page loading its data.'
    return LANE_TEXT[lane] ?? null
  }
  return null
}

/** The most specific text the product already holds for a node. */
async function registryText(
  kind: NodeInfoKind,
  id: string
): Promise<{ text: string; source: NodeInfoSource } | null> {
  try {
    if (kind === 'entity') {
      const lane = id.split('/')[0]
      const name = id.slice(lane.length + 1)
      if (lane === 'items' || lane === 'system') {
        const c = (await db('nivaro_collections')
          .where('collection', name)
          .first('display_name', 'note')) as { display_name?: string; note?: string } | undefined
        const note = clip(c?.note)
        if (note) return { text: note, source: 'registry' }
      } else if (lane === 'queries') {
        const q = (await db('nivaro_custom_queries').where('slug', name).first('description')) as
          | { description?: string }
          | undefined
        const d = clip(q?.description)
        if (d) return { text: d, source: 'registry' }
      }
      return null
    }
    if (kind === 'caller') {
      if (id.startsWith('cron:')) {
        const d = clip(CRON_DESCRIPTIONS[id.slice(5)], 400)
        if (d) return { text: d, source: 'registry' }
      } else if (id.startsWith('flow:')) {
        const f = (await db('nivaro_flows')
          .where('id', id.slice(5))
          .first('name', 'description')) as { name?: string; description?: string } | undefined
        const d = clip(f?.description) ?? (f?.name ? `The flow "${clip(f.name, 120)}".` : null)
        if (d) return { text: d, source: 'registry' }
      }
      return null
    }
    if (kind === 'down') {
      if (id.startsWith('ext:')) {
        const n = Number(id.slice(4))
        if (Number.isInteger(n)) {
          const a = (await db('nivaro_external_apis')
            .where('id', n)
            .first('name', 'description')) as { name?: string; description?: string } | undefined
          const d =
            clip(a?.description) ?? (a?.name ? `The outside system "${clip(a.name, 120)}".` : null)
          if (d) return { text: d, source: 'registry' }
        }
      } else if (id.startsWith('webhook:')) {
        const n = Number(id.slice(8))
        if (Number.isInteger(n)) {
          const w = (await db('nivaro_webhooks').where('id', n).first('name')) as
            | { name?: string }
            | undefined
          if (w?.name) return { text: `The webhook "${clip(w.name, 120)}".`, source: 'registry' }
        }
      } else if (id.startsWith('x:')) {
        const d = describeTrafficNode(id)
        const text = clip(d?.description)
        if (d && text) return { text: `${text} (declared by ${d.extension})`, source: 'extension' }
      }
    }
  } catch {
    /* a missing table or column just means nothing to say */
  }
  return null
}

/** The key an override is stored under. */
export const overrideKey = (kind: NodeInfoKind, id: string): string => `${kind}:${id}`

export async function describeNode(
  kind: NodeInfoKind,
  id: string,
  overrides: Record<string, string>
): Promise<NodeInfo> {
  const override = overrides[overrideKey(kind, id)] ?? null
  const found = await registryText(kind, id)
  const auto = found?.text ?? builtInText(kind, id)
  const autoSource: NodeInfoSource | null = found ? found.source : auto ? 'built-in' : null
  return {
    kind,
    id,
    text: override ?? auto,
    source: override ? 'admin' : autoSource,
    auto,
    auto_source: autoSource,
    override
  }
}

export const LANE_IDS = new Set(LANES.map((l) => l.id as string))
