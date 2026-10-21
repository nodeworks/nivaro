import type Anthropic from '@anthropic-ai/sdk'
import { db } from '../db/index.js'
import { NIVARO_VERSION } from '../version.js'
import { applyUsage, measureParts, type PartTokens, serializeParts } from './ai-prompt-parts.js'
import { emitAiCallLive } from './ai-quality.js'
import {
  type AiMessageStream,
  type AiStreamEvent,
  isAbortError,
  makeMessageStream,
  type StreamOptions
} from './ai-stream.js'
import { tenantState } from './ai-tenant-state.js'
import { currentTraceMeta } from './request-trace.js'
import { noteAiCall } from './traffic-taps/ai.js'

/**
 * Per-call AI log (nivaro_ai_calls) — every `messages.create` that leaves
 * through `getAiClient()` lands here with tokens, latency, cost and capped
 * bodies, the way nivaro_api_logs records HTTP requests. Attribution rides
 * the request trace: one HTTP request = one request_id, so a tool loop's
 * 6–12 calls group under one Ask AI question.
 */

export type AiProviderKind = 'anthropic' | 'gateway-openai' | 'gateway-anthropic'

/** USD per million tokens — gateway list prices where known; unknown ids cost null. */
const PRICES: Record<string, { input: number; cached: number; output: number }> = {
  'claude-4-6-sonnet': { input: 2.7, cached: 0.27, output: 13.5 },
  'claude-4-5-sonnet': { input: 2.7, cached: 0.27, output: 13.5 },
  'claude-4-sonnet': { input: 2.7, cached: 0.27, output: 13.5 },
  'claude-4-5-haiku': { input: 0.9, cached: 0.09, output: 4.5 },
  'claude-sonnet-4-6': { input: 3, cached: 0.3, output: 15 },
  'claude-sonnet-4-5': { input: 3, cached: 0.3, output: 15 },
  'claude-haiku-4-5-20251001': { input: 1, cached: 0.1, output: 5 },
  'claude-haiku-4-5': { input: 1, cached: 0.1, output: 5 }
}

/** Prices an admin set in AI quality (#2764); they beat the built-in list. */
type Prices = Record<string, { input: number; cached: number; output: number }>
const priceState = tenantState<{ prices: Prices }>(() => ({ prices: {} }))

export function setPriceOverrides(prices: Prices | null | undefined): void {
  priceState().prices = prices ?? {}
}

export function priceFor(model: string) {
  const base = model.replace(/-\d{8}$/, '')
  const overrides = priceState().prices
  return overrides[model] ?? overrides[base] ?? PRICES[model] ?? PRICES[base] ?? null
}

/** The prompt_parts column arrives with migration 470; probe once, retry after a minute. */
const partsColumnState = tenantState<{ v: { ok: boolean; at: number } | null }>(() => ({ v: null }))
async function promptPartsSupported(): Promise<boolean> {
  const st = partsColumnState()
  if (st.v && (st.v.ok || Date.now() - st.v.at < 60_000)) return st.v.ok
  const ok = await db.schema.hasColumn('nivaro_ai_calls', 'prompt_parts').catch(() => false)
  st.v = { ok, at: Date.now() }
  return ok
}

/** Part sizes for the request, or null — a counting failure must never fail the call. */
function partsOf(params: MessageParams): PartTokens[] | null {
  try {
    return measureParts(params)
  } catch {
    return null
  }
}

export function costOf(
  model: string,
  usage: { input?: number | null; cached?: number | null; output?: number | null }
): number | null {
  const p = priceFor(model)
  if (!p) return null
  const cached = usage.cached ?? 0
  const uncached = Math.max(0, (usage.input ?? 0) - cached)
  return (uncached * p.input + cached * p.cached + (usage.output ?? 0) * p.output) / 1_000_000
}

/** Which product feature a call belongs to, from the request route. */
export function featureFromRoute(route: string | null): string {
  if (!route) return 'background'
  const r = route.replace(/^\/api/, '')
  if (r.startsWith('/ai/chat')) return 'chat'
  if (r.startsWith('/ai/')) return r.split('/')[2]?.split('?')[0] || 'ai'
  if (r.startsWith('/chat/')) return 'chat-bot'
  if (r.includes('/explain-trend')) return 'explain-trend'
  if (r.startsWith('/report-studio')) return 'reports'
  if (r.startsWith('/config-conformance')) return 'integrity'
  if (r.startsWith('/pipelines')) return 'pipeline-review'
  if (r.startsWith('/metric-alerts') || r.startsWith('/alerts')) return 'alerts'
  if (r.startsWith('/help-videos/')) {
    // The editor's AI helpers (#1487, #1520): one feature name each, so the
    // AI analytics page can tell a first draft from a caption run.
    if (/\/draft\/suggest(\?|$)/.test(r)) return 'help-video-draft'
    if (/\/captions\/generate(\?|$)/.test(r)) return 'help-video-captions'
  }
  return r.split('/')[1]?.split('?')[0] || 'other'
}

const REQUEST_CAP = 48_000
const RESPONSE_CAP = 16_000

function capJson(value: unknown, cap: number): string | null {
  if (value == null) return null
  let s: string
  try {
    s = JSON.stringify(value)
  } catch {
    return null
  }
  return s.length > cap ? `${s.slice(0, cap)}…` : s
}

type MessageParams = Anthropic.MessageCreateParams

/** One call's log row in flight — `ok` / `fail` each write at most once. */
function beginAiCall(provider: AiProviderKind, params: MessageParams) {
  const meta = currentTraceMeta()
  const started = performance.now()
  const base = {
    created_at: new Date(),
    request_id: meta?.id ?? null,
    user: meta?.userId ?? null,
    feature: featureFromRoute(meta?.urlHint ?? null),
    route: meta?.urlHint?.slice(0, 300) ?? null,
    provider,
    model: String(params.model ?? ''),
    rounds: Array.isArray(params.messages) ? params.messages.length : null,
    request: capJson(
      {
        system: params.system,
        tools: params.tools?.map((t) => t.name),
        messages: params.messages
      },
      REQUEST_CAP
    )
  }
  const parts = partsOf(params)
  let written = false
  return {
    ok(res: Anthropic.Message) {
      if (written) return
      written = true
      const usage = res.usage as
        | {
            input_tokens?: number
            output_tokens?: number
            cache_read_input_tokens?: number | null
            cache_creation_input_tokens?: number | null
          }
        | undefined
      const input = usage?.input_tokens ?? null
      const output = usage?.output_tokens ?? null
      const cached = usage?.cache_read_input_tokens ?? null
      const content = Array.isArray(res.content) ? res.content : []
      const latency = Math.round(performance.now() - started)
      // #1141: the call is a request into the Traffic Map's AI provider node.
      noteAiCall({
        provider,
        model: res.model || base.model,
        ok: true,
        ms: latency,
        input,
        output,
        cached,
        cost: costOf(res.model || base.model, { input, cached, output })
      })
      emitAiCallLive({
        at: new Date().toISOString(),
        request_id: base.request_id,
        feature: base.feature,
        model: res.model || base.model,
        provider,
        user: base.user,
        status: 'ok',
        latency_ms: latency,
        cost_usd: costOf(res.model || base.model, { input, cached, output }),
        input_tokens: input,
        output_tokens: output
      })
      const stored =
        parts &&
        serializeParts(
          applyUsage(parts, {
            input,
            cacheRead: cached,
            cacheWrite: usage?.cache_creation_input_tokens ?? null,
            inputIncludesCache: provider === 'gateway-openai'
          }),
          NIVARO_VERSION
        )
      void (async () => {
        const withParts = stored && (await promptPartsSupported())
        await db('nivaro_ai_calls').insert({
          ...(withParts ? { prompt_parts: stored } : {}),
          ...base,
          model: res.model || base.model,
          status: 'ok',
          latency_ms: latency,
          input_tokens: input,
          output_tokens: output,
          cache_read_tokens: cached,
          cache_write_tokens: usage?.cache_creation_input_tokens ?? null,
          cost_usd: costOf(res.model || base.model, { input, cached, output }),
          stop_reason: res.stop_reason ?? null,
          tool_calls: content.filter((b) => b.type === 'tool_use').length,
          response: capJson(content, RESPONSE_CAP)
        })
      })().catch(() => undefined)
    },
    fail(err: unknown) {
      if (written) return
      written = true
      noteAiCall({
        provider,
        model: base.model,
        ok: false,
        ms: Math.round(performance.now() - started)
      })
      emitAiCallLive({
        at: new Date().toISOString(),
        request_id: base.request_id,
        feature: base.feature,
        model: base.model,
        provider,
        user: base.user,
        status: 'error',
        latency_ms: Math.round(performance.now() - started),
        cost_usd: null,
        input_tokens: null,
        output_tokens: null,
        error: String((err as Error)?.message ?? err).slice(0, 200)
      })
      void (async () => {
        const withParts = parts && (await promptPartsSupported())
        await db('nivaro_ai_calls').insert({
          ...(withParts
            ? { prompt_parts: serializeParts(applyUsage(parts, {}), NIVARO_VERSION) }
            : {}),
          ...base,
          status: 'error',
          latency_ms: Math.round(performance.now() - started),
          error: String((err as Error)?.message ?? err).slice(0, 1000)
        })
      })().catch(() => undefined)
    }
  }
}

/**
 * Wrap a `messages.create` implementation so every call is logged. Never
 * throws on its own account — a logging failure must not fail the AI call.
 */
export function loggedCreate(
  provider: AiProviderKind,
  create: (params: MessageParams) => Promise<Anthropic.Message>
): (params: MessageParams) => Promise<Anthropic.Message> {
  return async (params) => {
    const call = beginAiCall(provider, params)
    try {
      const res = await create(params)
      call.ok(res)
      return res
    } catch (err) {
      call.fail(err)
      throw err
    }
  }
}

/**
 * The streaming twin (#688): `open` starts the provider stream and hands back
 * the event source; the returned stream logs ONE row with the assembled
 * message's usage once the last event lands (or an error row when the stream
 * breaks) — the same fields a non-streamed call records.
 */
export function loggedStream(
  provider: AiProviderKind,
  open: (
    params: MessageParams,
    opts: StreamOptions
  ) => Promise<{ events: AsyncIterable<AiStreamEvent>; abort: () => void }>
): (params: MessageParams, opts?: StreamOptions) => Promise<AiMessageStream> {
  return async (params, opts = {}) => {
    const call = beginAiCall(provider, params)
    let source: { events: AsyncIterable<AiStreamEvent>; abort: () => void }
    try {
      source = await open(params, opts)
    } catch (err) {
      call.fail(err)
      throw err
    }
    return makeMessageStream(source.events, source.abort, {
      onFinal: (m) => call.ok(m),
      // A stream the person STOPPED is not a provider failure: it logs as ok
      // with what had arrived, stop_reason 'stopped', and no token figures
      // (the usage rides the last chunk, which never came).
      onError: (err, partial) =>
        isAbortError(err)
          ? call.ok({ ...partial, stop_reason: 'stopped', usage: undefined } as never)
          : call.fail(err)
    })
  }
}

/**
 * A row for a call that did not go through `messages.create` — a speech-to-
 * text run on the gateway's audio endpoint, or a local Whisper model (#1520).
 * The feature is named by the caller (a background job has no request
 * trace); tokens and cost are whatever the provider reported, else null.
 * Best-effort like every log write.
 */
export function recordAiCall(row: {
  feature: string
  provider: AiProviderKind | 'local-whisper'
  model: string
  status: 'ok' | 'error'
  latency_ms: number
  user?: string | null
  route?: string | null
  input_tokens?: number | null
  output_tokens?: number | null
  cost_usd?: number | null
  /** Capped JSON of what was sent (never the audio itself). */
  request?: unknown
  /** Capped JSON of what came back (a transcript summary, not the words). */
  response?: unknown
  error?: string | null
}): void {
  const meta = currentTraceMeta()
  void db('nivaro_ai_calls')
    .insert({
      created_at: new Date(),
      request_id: meta?.id ?? null,
      user: row.user ?? meta?.userId ?? null,
      feature: row.feature.slice(0, 60),
      route: (row.route ?? meta?.urlHint ?? null)?.slice(0, 300) ?? null,
      provider: row.provider,
      model: row.model.slice(0, 100),
      status: row.status,
      latency_ms: Math.max(0, Math.round(row.latency_ms)),
      input_tokens: row.input_tokens ?? null,
      output_tokens: row.output_tokens ?? null,
      cost_usd: row.cost_usd ?? null,
      request: capJson(row.request, REQUEST_CAP),
      response: capJson(row.response, RESPONSE_CAP),
      error: row.error ? String(row.error).slice(0, 1000) : null
    })
    .catch(() => undefined)
}

export const AI_LOG_RETENTION_DAYS = 30

/** Drop rows older than the retention window; rides the daily retention pass. */
export async function pruneAiCalls(): Promise<number> {
  const cutoff = new Date(Date.now() - AI_LOG_RETENTION_DAYS * 86_400_000)
  return db('nivaro_ai_calls').where('created_at', '<', cutoff).del()
}
