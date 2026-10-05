import type Anthropic from '@anthropic-ai/sdk'
import { db } from '../db/index.js'
import {
  type AiMessageStream,
  type AiStreamEvent,
  makeMessageStream,
  type StreamOptions
} from './ai-stream.js'
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

export function priceFor(model: string) {
  return PRICES[model] ?? PRICES[model.replace(/-\d{8}$/, '')] ?? null
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
      void db('nivaro_ai_calls')
        .insert({
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
        .catch(() => undefined)
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
      void db('nivaro_ai_calls')
        .insert({
          ...base,
          status: 'error',
          latency_ms: Math.round(performance.now() - started),
          error: String((err as Error)?.message ?? err).slice(0, 1000)
        })
        .catch(() => undefined)
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
      onError: (err) => call.fail(err)
    })
  }
}

export const AI_LOG_RETENTION_DAYS = 30

/** Drop rows older than the retention window; rides the daily retention pass. */
export async function pruneAiCalls(): Promise<number> {
  const cutoff = new Date(Date.now() - AI_LOG_RETENTION_DAYS * 86_400_000)
  return db('nivaro_ai_calls').where('created_at', '<', cutoff).del()
}
