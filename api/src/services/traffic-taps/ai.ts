// api/src/services/traffic-taps/ai.ts
/**
 * Topology tap `ai` (#1141): the AI provider (Anthropic direct, or the model gateway in either
 * wire format) as a downstream node — calls, failures, tokens, cost, the models answering and
 * the model fallbacks/refusals, fed by loggedCreate() (ai-log.ts) and withModelFallback().
 */
import { noteDown } from '../traffic-map.js'
import { registerTrafficTap, tapState } from '../traffic-taps.js'
import { noteSourceDown } from './sources.js'
import { currentEntityKey, MinuteTotals } from './util.js'

export const AI_TAP = 'ai'
export const AI_PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  'gateway-openai': 'AI gateway',
  'gateway-anthropic': 'AI gateway'
}

interface AiState {
  /** `<provider>|calls|errors|in|out|cached|cost` */
  totals: MinuteTotals
  /** `<provider>|<model>` calls */
  models: MinuteTotals
  /** `<from>><to>` fallbacks */
  fallbacks: MinuteTotals
  since_boot: number
}
function state(): AiState {
  return tapState<AiState>(AI_TAP, () => ({
    totals: new MinuteTotals(40),
    models: new MinuteTotals(30),
    fallbacks: new MinuteTotals(20),
    since_boot: 0
  }))
}

export function aiNodeId(provider: string): string {
  return `ai:${String(provider || 'unknown').slice(0, 40)}`
}

export function noteAiCall(c: {
  provider: string
  model: string
  ok: boolean
  ms: number
  input?: number | null
  output?: number | null
  cached?: number | null
  cost?: number | null
}): void {
  if (process.env.CLOUD_META_DB_URL) return
  try {
    const at = Date.now()
    const sec = Math.floor(at / 1000)
    const s = state()
    const p = c.provider
    s.totals.add(`${p}|calls`, sec)
    if (!c.ok) s.totals.add(`${p}|errors`, sec)
    if (c.input) s.totals.add(`${p}|in`, sec, c.input)
    if (c.output) s.totals.add(`${p}|out`, sec, c.output)
    if (c.cached) s.totals.add(`${p}|cached`, sec, c.cached)
    if (c.cost) s.totals.add(`${p}|cost`, sec, c.cost)
    if (c.model) s.models.add(`${p}|${c.model.slice(0, 60)}`, sec)
    const id = aiNodeId(p)
    noteDown({
      id,
      label: AI_PROVIDER_LABELS[p] ?? p,
      kind: 'ai',
      ok: c.ok,
      ms: c.ms,
      at,
      entityKey: currentEntityKey()
    })
    noteSourceDown(id, at)
  } catch {
    /* never */
  }
}

/** The gateway refused `from` and the call fell back to `to`. */
export function noteAiFallback(from: string, to: string): void {
  if (process.env.CLOUD_META_DB_URL) return
  try {
    const s = state()
    s.since_boot++
    s.fallbacks.add(`${from.slice(0, 60)}>${to.slice(0, 60)}`, Math.floor(Date.now() / 1000))
  } catch {
    /* never */
  }
}

registerTrafficTap({
  id: AI_TAP,
  snapshot(windowS, sec) {
    const s = state()
    const providers: Record<
      string,
      Record<string, number | Array<{ model: string; n: number }>>
    > = {}
    for (const [k, n] of s.totals.entries(windowS, sec)) {
      const cut = k.lastIndexOf('|')
      const p = k.slice(0, cut)
      const id = aiNodeId(p)
      providers[id] = { ...(providers[id] ?? {}), [k.slice(cut + 1)]: n }
    }
    for (const [k, n] of s.models.entries(windowS, sec)) {
      const cut = k.indexOf('|')
      const id = aiNodeId(k.slice(0, cut))
      const row = providers[id] ?? {}
      const list = (row.models as Array<{ model: string; n: number }> | undefined) ?? []
      list.push({ model: k.slice(cut + 1), n })
      row.models = list
      providers[id] = row
    }
    const fallbacks = s.fallbacks.entries(windowS, sec).map(([k, n]) => {
      const cut = k.indexOf('>')
      return { from: k.slice(0, cut), to: k.slice(cut + 1), n }
    })
    if (!Object.keys(providers).length && !fallbacks.length) return undefined
    return { providers, fallbacks, fallbacks_since_boot: s.since_boot }
  },
  sweep(sec) {
    const s = state()
    s.totals.sweep(sec)
    s.models.sweep(sec)
    s.fallbacks.sweep(sec)
  }
})
