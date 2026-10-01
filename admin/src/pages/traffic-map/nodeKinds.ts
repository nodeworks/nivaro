// Node kinds the Traffic Map draws beyond request callers and the data stores (group C):
// sources (`cron:<job>`, `flow:<id>`, `import:worker`, `socket:browsers`) and downstream kinds
// (partner, channel, ai, webhook). Pure helpers shared by MapCanvas, Inspector and features.
import type { TrafficModel } from './model'
import type { TrafficCatalog } from './types'

/** The folded tail of the Sources group. */
export const OTHER_SOURCES = '__other_sources__'

/** A source id is `<kind>:<ref>`; request caller keys never hold a colon. */
export const isSourceId = (id: string) => id.includes(':')

// Names of sources the snapshot catalog has never seen (a flow that only ran, or only called
// partners): the topology poller fills this from the sources tap.
const sourceLabels = new Map<string, string>()
export function setSourceLabel(id: string, label: string | null | undefined): void {
  if (label && isSourceId(id)) sourceLabels.set(id, label)
}
export function sourceLabel(id: string): string | undefined {
  return sourceLabels.get(id)
}
// Names of down nodes the snapshot has not met yet (an extension-declared node only a source has
// called): the topology poller fills this from the declared-node list.
const downLabels = new Map<string, string>()
export function setDownLabel(id: string, label: string | null | undefined): void {
  if (label) downLabels.set(id, label)
}
/** Kind of a down node: the snapshot's, else read off the id. */
export function downKindOf(m: TrafficModel, id: string): string {
  if (id === 'db') return 'db'
  if (id === 'redis') return 'cache'
  if (id === 'store') return 'storage'
  if (id.startsWith('ext:') || id.startsWith('x:')) return 'partner'
  const k = m.downKinds.get(id)
  if (k) return k
  if (id.startsWith('ai:')) return 'ai'
  if (id.startsWith('webhook:')) return 'webhook'
  if (id === 'mail' || id === 'sms' || id === 'push' || id === 'teams') return 'channel'
  return 'service'
}

const DOWN_FALLBACK: Record<string, string> = {
  db: 'SQL Server',
  redis: 'Redis',
  store: 'File storage',
  mail: 'Email',
  sms: 'SMS',
  push: 'Web push',
  teams: 'Teams',
  'ai:anthropic': 'Anthropic',
  'ai:gateway-openai': 'AI gateway',
  'ai:gateway-anthropic': 'AI gateway'
}
/** A down node's label: catalog, partner name, snapshot label, then a readable fallback. */
export function downLabel(m: TrafficModel, cat: TrafficCatalog | null, id: string): string {
  if (cat?.down[id]) return cat.down[id]
  if (id.startsWith('ext:') && cat?.partners[id.slice(4)]) return cat.partners[id.slice(4)]
  const known = m.downLabels.get(id)
  if (known) return known
  const declared = downLabels.get(id)
  if (declared) return declared
  if (DOWN_FALLBACK[id]) return DOWN_FALLBACK[id]
  if (id.startsWith('webhook:')) return `Webhook ${id.slice(8)}`
  if (id.startsWith('x:')) return id.slice(id.indexOf('.') + 1)
  return id
}
