import type Anthropic from '@anthropic-ai/sdk'
import { type AiCallRouting, parseAiCallMeta, withAiCallMeta } from './ai-call-meta.js'
import { costOf } from './ai-log.js'

/**
 * Model routing by difficulty (#2471). Per feature, an admin may switch on
 * "start cheap": the first call goes to a small model and moves up to the
 * feature's main model when
 *  - a tool call fails (the main model carries on from there),
 *  - the model is about to propose an action or a plan (proposals and plans
 *    are always made by the main model),
 *  - the reply is not valid JSON where JSON is expected, or
 *  - the model says it cannot answer (the question runs again on the main
 *    model, from the start),
 * and whenever the person clicks "Try harder". Every call is logged with its
 * tier (nivaro_ai_calls.meta), so the AI quality page shows both calls with
 * their cost and what routing saved.
 *
 * Off by default; the switch lives beside budgets in ai_models._quality.
 */

export interface RoutingConfig {
  /** Features that start cheap; empty = routing off. */
  features: string[]
  /** The small model the first call goes to; null = routing off. */
  cheap_model: string | null
}

export const DEFAULT_ROUTING: RoutingConfig = { features: [], cheap_model: null }

/** Features that can start cheap, with the words the settings card shows. */
export const ROUTABLE_FEATURES: Array<{ key: string; label: string }> = [
  { key: 'chat', label: 'Ask AI' },
  { key: 'review', label: 'Record review' },
  { key: 'summarize', label: 'Record summaries' },
  { key: 'generate', label: 'Field generation' }
]
const ROUTABLE = new Set(ROUTABLE_FEATURES.map((f) => f.key))

export function normalizeRouting(raw: unknown): RoutingConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULT_ROUTING }
  const o = raw as Record<string, unknown>
  const features = Array.isArray(o.features)
    ? [...new Set(o.features.filter((f): f is string => typeof f === 'string' && ROUTABLE.has(f)))]
    : []
  const cheap =
    typeof o.cheap_model === 'string' && o.cheap_model.trim()
      ? o.cheap_model.trim().slice(0, 100)
      : null
  return { features, cheap_model: cheap }
}

/** The cheap model for a feature, or null when that feature does not start cheap. */
export function cheapModelFor(
  routing: RoutingConfig | null | undefined,
  feature: string,
  mainModel: string
): string | null {
  if (!routing?.cheap_model || !routing.features.includes(feature)) return null
  return routing.cheap_model === mainModel ? null : routing.cheap_model
}

/** Tools the small model never runs: the main model makes every proposal and plan. */
export const MAIN_MODEL_TOOLS = new Set(['propose_action', 'propose_plan'])

const CANNOT_ANSWER = [
  /\bI(?: can(?:no|['’])t| am unable to|['’]m unable to| am not able to|['’]m not able to) (?:answer|find|determine|tell|work out|see|access|help with|summari[sz]e|provide|generate|write|complete)\b/i,
  /\bI (?:do not|don['’]t) have (?:enough|the|access|any)\b[^.]{0,40}\b(?:information|data|access|details|tools?)\b/i,
  // "I could not find any open requests" is an answer (none); "could not find the data" is not.
  /\bI (?:could not|couldn['’]t|was unable to|wasn['’]t able to) (?:determine|answer|work out|retrieve|find (?:the|that|this|enough|a way|which))\b/i,
  /\b(?:not|no) (?:enough|sufficient) (?:information|data) to (?:answer|tell|say)\b/i
]

/** The model said it cannot answer — worth asking the main model. */
export function saysCannotAnswer(text: string): boolean {
  const t = text.trim()
  if (!t) return true
  // Only the opening matters: a long answer that mentions one gap is an answer.
  const head = t.slice(0, 400)
  return CANNOT_ANSWER.some((re) => re.test(head))
}

/** The reply holds the JSON the feature asked for (an array or an object). */
export function isValidJsonReply(text: string, kind: 'array' | 'object'): boolean {
  const m = kind === 'array' ? /\[[\s\S]*\]/.exec(text) : /\{[\s\S]*\}/.exec(text)
  if (!m) return false
  try {
    const v = JSON.parse(m[0])
    return kind === 'array' ? Array.isArray(v) : !!v && typeof v === 'object' && !Array.isArray(v)
  } catch {
    return false
  }
}

const textOf = (m: Anthropic.Message) =>
  m.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')

export interface RoutedResult {
  message: Anthropic.Message
  routing: { tier: 'cheap' | 'main'; model: string; reason?: AiCallRouting['reason'] } | null
}

/**
 * One call for a one-shot feature (review, summarize, generate): the small
 * model first when the feature starts cheap, the main model when its reply
 * fails the check. Without routing it is the plain call.
 */
export async function routedCreate(opts: {
  main: { client: Anthropic; model: string }
  cheap: { client: Anthropic; model: string } | null
  params: Omit<Anthropic.MessageCreateParamsNonStreaming, 'model'>
  /** The reply must hold JSON of this kind. */
  expectJson?: 'array' | 'object'
  tryHarder?: { retryOf?: string | null } | null
}): Promise<RoutedResult> {
  const { main, cheap } = opts
  const mainCall = (routing?: AiCallRouting) =>
    withAiCallMeta(
      routing ? { routing } : null,
      () =>
        main.client.messages.create({
          ...opts.params,
          model: main.model
        }) as Promise<Anthropic.Message>
    )
  if (!cheap) {
    return { message: await mainCall(), routing: null }
  }
  const base = { main_model: main.model, cheap_model: cheap.model }
  if (opts.tryHarder) {
    const message = await mainCall({
      ...base,
      tier: 'main',
      reason: 'try_harder',
      ...(opts.tryHarder.retryOf ? { retry_of: opts.tryHarder.retryOf } : {})
    })
    return { message, routing: { tier: 'main', model: main.model, reason: 'try_harder' } }
  }
  const first = (await withAiCallMeta({ routing: { ...base, tier: 'cheap' } }, () =>
    cheap.client.messages.create({ ...opts.params, model: cheap.model })
  )) as Anthropic.Message
  const text = textOf(first)
  const reason: AiCallRouting['reason'] | null =
    opts.expectJson && !isValidJsonReply(text, opts.expectJson)
      ? 'invalid_json'
      : saysCannotAnswer(text)
        ? 'cannot_answer'
        : null
  if (!reason) return { message: first, routing: { tier: 'cheap', model: cheap.model } }
  const message = await mainCall({ ...base, tier: 'main', reason, rerun: true })
  return { message, routing: { tier: 'main', model: main.model, reason } }
}

// ─── savings ────────────────────────────────────────────────────────────────

export interface RoutingCallRow {
  request_id: string | null
  model: string
  cost_usd: number | null
  input_tokens: number | null
  output_tokens: number | null
  cache_read_tokens: number | null
  meta: string | null
}

export interface RoutingSavings {
  /** Questions (requests) that started cheap. */
  routed: number
  /** …answered by the small model alone. */
  answered_cheap: number
  /** …that moved up, by reason. */
  escalated: Record<string, number>
  /** "Try harder" clicks. */
  try_harder: number
  cheap_calls: number
  main_calls: number
  /** What the small model's calls cost. */
  cheap_cost_usd: number
  /** What the main model's calls on routed questions cost. */
  main_cost_usd: number
  /** What the small model's useful calls would have cost on the main model. */
  main_equivalent_usd: number
  /** main_equivalent − cheap cost of useful calls − cheap calls thrown away. */
  saved_usd: number
  /** Calls whose model has no known price (left out of the figures). */
  unpriced_calls: number
}

/**
 * What routing saved over a set of logged calls. A cheap call is useful when
 * its question did not start again on the main model (a rerun, or a later
 * "Try harder" naming it): it saved what the main model would have charged
 * for the same tokens, minus what it cost. A thrown-away cheap call saved
 * nothing and cost its price.
 */
export function routingSavings(rows: RoutingCallRow[]): RoutingSavings {
  const out: RoutingSavings = {
    routed: 0,
    answered_cheap: 0,
    escalated: {},
    try_harder: 0,
    cheap_calls: 0,
    main_calls: 0,
    cheap_cost_usd: 0,
    main_cost_usd: 0,
    main_equivalent_usd: 0,
    saved_usd: 0,
    unpriced_calls: 0
  }
  const parsed = rows
    .map((r) => ({ r, routing: parseAiCallMeta(r.meta)?.routing ?? null }))
    .filter((x): x is { r: RoutingCallRow; routing: AiCallRouting } => !!x.routing)
  const wasted = new Set<string>()
  const byRequest = new Map<string, AiCallRouting[]>()
  for (const { r, routing } of parsed) {
    const id = r.request_id ?? `row:${Math.random()}`
    if (routing.rerun) wasted.add(id)
    if (routing.retry_of) wasted.add(routing.retry_of)
    const list = byRequest.get(id) ?? []
    list.push(routing)
    byRequest.set(id, list)
  }
  for (const list of byRequest.values()) {
    if (list.some((x) => x.reason === 'try_harder')) {
      out.try_harder++
      continue
    }
    if (!list.some((x) => x.tier === 'cheap')) continue
    out.routed++
    const up = list.find((x) => x.tier === 'main' && x.reason)
    if (up?.reason) out.escalated[up.reason] = (out.escalated[up.reason] ?? 0) + 1
    else out.answered_cheap++
  }
  for (const { r, routing } of parsed) {
    const cost = r.cost_usd == null ? null : Number(r.cost_usd)
    if (routing.tier === 'main') {
      out.main_calls++
      if (cost == null) out.unpriced_calls++
      else out.main_cost_usd += cost
      continue
    }
    out.cheap_calls++
    const equiv = costOf(routing.main_model, {
      input: r.input_tokens,
      cached: r.cache_read_tokens,
      output: r.output_tokens
    })
    if (cost == null || equiv == null) {
      out.unpriced_calls++
      continue
    }
    out.cheap_cost_usd += cost
    if (r.request_id && wasted.has(r.request_id)) {
      out.saved_usd -= cost
      continue
    }
    out.main_equivalent_usd += equiv
    out.saved_usd += equiv - cost
  }
  const round = (n: number) => Math.round(n * 1_000_000) / 1_000_000
  out.cheap_cost_usd = round(out.cheap_cost_usd)
  out.main_cost_usd = round(out.main_cost_usd)
  out.main_equivalent_usd = round(out.main_equivalent_usd)
  out.saved_usd = round(out.saved_usd)
  return out
}
