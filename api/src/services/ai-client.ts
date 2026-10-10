import Anthropic from '@anthropic-ai/sdk'
import { config } from '../config.js'
import { db } from '../db/index.js'
import { loggedCreate, loggedStream } from './ai-log.js'
import {
  type AiMessageStream,
  type AiStreamEvent,
  abortError,
  eventsOfMessage,
  openAiChunkToEvents,
  openAiStreamEnd,
  openAiStreamState,
  readSseJson,
  type StreamOptions,
  streamMessage
} from './ai-stream.js'
import { overlaySettings } from './settings-overrides.js'
import { noteAiFallback } from './traffic-taps/ai.js'

/**
 * Shared AI client resolution. Every AI feature (generate, summarize, ask,
 * chat bot, briefs, SQL copilot, anomaly explanations …) calls
 * `client.messages.create(...)` in the Anthropic Messages shape and reads an
 * Anthropic-shaped response back. Which PROVIDER answers is a setting:
 *
 *   anthropic  — Anthropic's API with the env/settings key (the original path)
 *   gateway    — a model gateway reached with OAuth client-credentials, all
 *                of it in nivaro_settings (Settings → AI Features; per-instance
 *                overrides apply, so production can carry its own secret).
 *                Two wire formats:
 *                  openai     POST <base>/openai/v1/chat/completions, translated
 *                             both ways here (system, text, tool_use ⇄
 *                             tool_calls, tool_result ⇄ role:tool)
 *                  anthropic  <base>/anthropic — the SDK itself with a bearer
 *                Either way the configured gateway model replaces whatever a
 *                call site asked for: the gateway only knows its own ids.
 *
 * Streaming (#688): every client also carries `messages.createStream`, which
 * yields Anthropic-shaped events on all three paths (the SDK's own stream on
 * the Anthropic and anthropic-native-gateway paths; the openai shim sets
 * `stream: true` and translates the SSE chunks). Call sites reach it through
 * `streamMessage()` in ai-stream.ts, which falls back to a one-shot create
 * for a client without it. A streamed call is logged once, like a plain one.
 */

/** What `getAiClient()` really returns: the SDK surface plus the stream twin. */
export type AiClient = Anthropic & {
  messages: Anthropic['messages'] & {
    createStream: (params: MessageParams, opts?: StreamOptions) => Promise<AiMessageStream>
  }
}

export interface AiSettingsRow {
  ai_chat_guide?: string | null
  ai_gateway_chat_model?: string | null
  ai_gateway_extract_model?: string | null
  anthropic_api_key?: string | null
  ai_provider?: string | null
  ai_gateway_base_url?: string | null
  ai_gateway_token_url?: string | null
  ai_gateway_client_id?: string | null
  ai_gateway_client_secret?: string | null
  ai_gateway_format?: string | null
  ai_gateway_model?: string | null
  /** Per-feature model map (migration 364) — beats the three legacy columns. */
  ai_models?: string | null
  ai_answer_cache_minutes?: number | null
  ai_prompt_caching?: boolean | number | null
  ai_model?: string | null
  ai_max_tokens_generate?: number | null
  ai_max_tokens_summarize?: number | null
}

export async function settingsRow(): Promise<AiSettingsRow | null> {
  const row = (await db('nivaro_settings')
    .orderBy('id', 'asc')
    .first()
    .catch(() => null)) as Record<string, unknown> | undefined
  // the same per-instance layer mail/sms read through — a production
  // gateway secret lives in nivaro_settings_overrides, never on the shared row
  return ((await overlaySettings(row)) ?? null) as AiSettingsRow | null
}

export type AiProvider = 'anthropic' | 'gateway'

export interface AiProviderInfo {
  provider: AiProvider
  configured: boolean
  model: string
  format?: 'openai' | 'anthropic'
  /** prompt caching switched on (the markers ride every wire format) */
  caching: boolean
  reason?: string
  /** The effective per-feature models (gateway) — what each feature runs on. */
  models?: Record<string, string>
  /** Where semantic-search vectors come from right now. */
  embedding?: { provider: 'voyage' | 'gateway' | 'local'; model: string | null }
}

// unset (a row older than migration 323) = on; the column itself defaults to 1
const cachingOn = (s: AiSettingsRow) =>
  s.ai_prompt_caching == null ? true : Boolean(Number(s.ai_prompt_caching))

/** What the AI features would use right now (no secrets). */
export async function describeAiProvider(): Promise<AiProviderInfo> {
  const s = (await settingsRow()) ?? {}
  const provider: AiProvider = s.ai_provider === 'gateway' ? 'gateway' : 'anthropic'
  if (provider === 'anthropic') {
    const key = config.ANTHROPIC_API_KEY || s.anthropic_api_key
    return {
      provider,
      configured: !!key,
      model: s.ai_model ?? 'claude-haiku-4-5-20251001',
      caching: cachingOn(s),
      reason: key ? undefined : 'no Anthropic API key in env or settings'
    }
  }
  const format = s.ai_gateway_format === 'anthropic' ? 'anthropic' : 'openai'
  const model = s.ai_gateway_model?.trim() || s.ai_model || 'claude-4-5-haiku'
  const caching = cachingOn(s)
  const gw = gatewayFromSettings(s)
  const missing = [
    !gw.base_url && 'base URL',
    !gw.token_url && 'token URL',
    !gw.client_id && 'client id',
    !gw.client_secret && 'client secret'
  ].filter(Boolean)
  if (missing.length) {
    return {
      provider,
      configured: false,
      model,
      format,
      caching,
      reason: `gateway is missing its ${missing.join(', ')}`
    }
  }
  const models = await getAiModelSettings()
  return {
    provider,
    configured: true,
    model,
    format,
    caching,
    models: {
      default: models.model,
      chat: models.chatModel,
      extract: models.extractModel,
      generate: models.generateModel,
      summarize: models.summarizeModel,
      embed: models.embedModel ?? '',
      transcribe: models.transcribeModel ?? ''
    },
    embedding: embeddingProviderFor(s)
  }
}

export function embeddingProviderFor(s: AiSettingsRow): {
  provider: 'voyage' | 'gateway' | 'local'
  model: string | null
} {
  if (process.env.VOYAGE_API_KEY) return { provider: 'voyage', model: 'voyage-3-lite' }
  const models = parseAiModels(s)
  if (s.ai_provider === 'gateway' && models.embed)
    return { provider: 'gateway', model: models.embed }
  return { provider: 'local', model: null }
}

// ─── per-feature models (#754) ───────────────────────────────────────────────

export type AiFeatureModelKey =
  | 'default'
  | 'chat'
  | 'extract'
  | 'generate'
  | 'summarize'
  | 'embed'
  | 'transcribe'
export const AI_FEATURE_MODEL_KEYS: AiFeatureModelKey[] = [
  'default',
  'chat',
  'extract',
  'generate',
  'summarize',
  'embed',
  'transcribe'
]

/** The configured map, legacy columns folded in as the fallback for a
 *  database migration 364 never reached. Blank entries are absent. */
export function parseAiModels(s: AiSettingsRow): Partial<Record<AiFeatureModelKey, string>> {
  const out: Partial<Record<AiFeatureModelKey, string>> = {}
  let raw: unknown = null
  try {
    raw = s.ai_models ? JSON.parse(s.ai_models) : null
  } catch {
    raw = null
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const k of AI_FEATURE_MODEL_KEYS) {
      const v = (raw as Record<string, unknown>)[k]
      if (typeof v === 'string' && v.trim()) out[k] = v.trim()
    }
  }
  if (!out.default && s.ai_gateway_model?.trim()) out.default = s.ai_gateway_model.trim()
  if (!out.chat && s.ai_gateway_chat_model?.trim()) out.chat = s.ai_gateway_chat_model.trim()
  if (!out.extract && s.ai_gateway_extract_model?.trim())
    out.extract = s.ai_gateway_extract_model.trim()
  return out
}

// ─── prompt caching ──────────────────────────────────────────────────────────

/**
 * Mark the stable prefix of a call so the provider serves it from cache on
 * the next round: the system prompt (its last block), the tool definitions
 * (the last one — a marker covers everything before it) and, once a
 * conversation is under way, the newest message, so a tool loop or a chat
 * finds its whole history cached next turn (the provider looks back up to 20
 * blocks from a marker for an earlier hit). Three markers, under the cap of
 * four, and a caller's own marker is never overwritten.
 *
 * Anthropic ignores a marker on a prefix under the model's minimum (1,024
 * tokens on Sonnet/Opus, 4,096 on Haiku 4.5), so a short call simply does not
 * cache — the size estimate (≈4 chars per token) only keeps the markers off
 * requests that could never reach any minimum. Nothing here changes what the
 * model sees; only what it is billed for. The openai shim carries the system
 * marker only (see toOpenAi); the SDK paths carry all three.
 */
const MIN_CACHEABLE_CHARS = 1024 * 4
const EPHEMERAL = { type: 'ephemeral' } as const

const sizeOf = (v: unknown): number =>
  v == null ? 0 : typeof v === 'string' ? v.length : JSON.stringify(v).length

export function withPromptCaching(params: MessageParams): MessageParams {
  if (sizeOf(params.system) + sizeOf(params.tools) + sizeOf(params.messages) < MIN_CACHEABLE_CHARS)
    return params
  const out: MessageParams = { ...params }
  if (typeof params.system === 'string') {
    if (params.system.trim())
      out.system = [{ type: 'text', text: params.system, cache_control: EPHEMERAL }]
  } else if (Array.isArray(params.system) && params.system.length) {
    const blocks = [...params.system]
    const last = blocks[blocks.length - 1]
    blocks[blocks.length - 1] = { ...last, cache_control: last.cache_control ?? EPHEMERAL }
    out.system = blocks
  }
  if (params.tools?.length) {
    const tools = [...params.tools]
    const last = tools[tools.length - 1] as Anthropic.Tool
    tools[tools.length - 1] = {
      ...last,
      cache_control: last.cache_control ?? EPHEMERAL
    } as typeof last
    out.tools = tools
  }
  if (params.messages.length >= 3) {
    const msgs = [...params.messages]
    const i = msgs.length - 1
    const last = msgs[i]
    if (typeof last.content === 'string') {
      if (last.content.trim())
        msgs[i] = {
          ...last,
          content: [{ type: 'text', text: last.content, cache_control: EPHEMERAL }]
        }
    } else if (Array.isArray(last.content) && last.content.length) {
      const blocks = [...last.content]
      const lb = blocks[blocks.length - 1] as Block & {
        cache_control?: typeof EPHEMERAL | null
      }
      if (lb.type === 'text' || lb.type === 'tool_result' || lb.type === 'image') {
        blocks[blocks.length - 1] = { ...lb, cache_control: lb.cache_control ?? EPHEMERAL } as Block
        msgs[i] = { ...last, content: blocks }
      }
    }
    out.messages = msgs
  }
  return out
}

/** The SDK's own stream as an event source (`abort` cancels the request). */
function sdkStream(
  inner: Anthropic,
  params: MessageParams,
  opts: StreamOptions
): { events: AsyncIterable<AiStreamEvent>; abort: () => void } {
  const controller = new AbortController()
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort()
    else opts.signal.addEventListener('abort', () => controller.abort(), { once: true })
  }
  const stream = inner.messages.stream({ ...params, stream: true } as never, {
    signal: controller.signal
  })
  return {
    events: stream as unknown as AsyncIterable<AiStreamEvent>,
    abort: () => {
      controller.abort()
      try {
        stream.abort()
      } catch {
        /* already done */
      }
    }
  }
}

/** `messages.create` with the caching markers applied on the way in. */
function cachingClient(
  inner: Anthropic,
  provider: 'anthropic' | 'gateway-anthropic',
  model?: string
): Anthropic {
  const prepare = (params: MessageParams) =>
    withPromptCaching(model ? { ...params, model } : params)
  const create = loggedCreate(
    provider,
    (params: MessageParams) =>
      inner.messages.create(prepare(params) as never) as Promise<Anthropic.Message>
  )
  const createStream = loggedStream(provider, async (params, opts) =>
    sdkStream(inner, prepare(params), opts)
  )
  return { messages: { create, createStream } } as unknown as Anthropic
}

/** The plain SDK client, every call logged. */
function loggedClient(
  inner: Anthropic,
  provider: 'anthropic' | 'gateway-anthropic',
  model?: string
): Anthropic {
  const prepare = (params: MessageParams) => (model ? { ...params, model } : params)
  const create = loggedCreate(
    provider,
    (params: MessageParams) =>
      inner.messages.create(prepare(params) as never) as Promise<Anthropic.Message>
  )
  const createStream = loggedStream(provider, async (params, opts) =>
    sdkStream(inner, prepare(params), opts)
  )
  return { messages: { create, createStream } } as unknown as Anthropic
}

// ─── gateway: settings + bearer cache ────────────────────────────────────────

interface GatewayApi {
  base_url: string
  token_url: string
  client_id: string
  client_secret: string
}

export function gatewayFromSettings(s: AiSettingsRow): GatewayApi {
  return {
    base_url: (s.ai_gateway_base_url ?? '').trim().replace(/\/+$/, ''),
    token_url: (s.ai_gateway_token_url ?? '').trim(),
    client_id: (s.ai_gateway_client_id ?? '').trim(),
    client_secret: s.ai_gateway_client_secret ?? ''
  }
}

const bearerCache = new Map<string, { token: string; exp: number }>()
const cacheKey = (api: GatewayApi) =>
  `${api.token_url}|${api.client_id}|${api.client_secret.length}`

/**
 * OAuth client-credentials exchange, cached until 60 s before expiry. The
 * credentials ride as X-Client-Id / X-Client-Secret HEADERS (SAT-NG style);
 * the form body still carries grant_type for endpoints that want it.
 */
export async function gatewayBearer(api: GatewayApi): Promise<string> {
  const key = cacheKey(api)
  const hit = bearerCache.get(key)
  if (hit && hit.exp > Date.now()) return hit.token
  const res = await fetch(api.token_url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'X-Client-Id': api.client_id,
      'X-Client-Secret': api.client_secret
    },
    body: new URLSearchParams({ grant_type: 'client_credentials' })
  })
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string
    expires_in?: number
    error?: string
    error_description?: string
  }
  if (!res.ok || !body.access_token) {
    throw new Error(
      `token endpoint ${res.status}: ${body.error_description ?? body.error ?? 'no access_token in the response'}`
    )
  }
  const ttl = Math.max(60, Number(body.expires_in ?? 3600)) - 60
  bearerCache.set(key, { token: body.access_token, exp: Date.now() + ttl * 1000 })
  return body.access_token
}

/** Drop the cached bearers (a settings edit, or a 401 from the gateway). */
export function bustGatewayBearer(): void {
  bearerCache.clear()
}

// ─── openai-compatible translation ───────────────────────────────────────────

type MessageParams = Anthropic.MessageCreateParams
type Block = Anthropic.ContentBlockParam

function textOf(content: string | Block[] | undefined | null): string {
  if (!content) return ''
  if (typeof content === 'string') return content
  return content
    .map((b) => ('text' in b && typeof b.text === 'string' ? b.text : ''))
    .filter(Boolean)
    .join('\n')
}

function toOpenAi(params: MessageParams, model: string, stream = false): Record<string, unknown> {
  const messages: Array<Record<string, unknown>> = []
  const system =
    typeof params.system === 'string'
      ? params.system
      : Array.isArray(params.system)
        ? textOf(params.system as Block[])
        : ''
  // A cache marker on the system prompt rides as an Anthropic-style
  // cache_control inside a content PART (the OpenRouter convention, which the
  // gateway maps onto the Anthropic request). Probed 2026-09-17 on the EFP
  // gateway: this caches system + tool definitions (the gateway's own
  // accounting reports them as cached_tokens on the repeat). Markers on
  // later messages are deliberately NOT carried — the gateway maps them by
  // message index and a tool loop (role: tool rows) shifts the indices, which
  // fails the whole request ('Could not find array index N').
  const systemMarked =
    Array.isArray(params.system) &&
    (params.system as Array<{ cache_control?: unknown }>).some((b) => b.cache_control)
  if (system)
    messages.push({
      role: 'system',
      content: systemMarked
        ? [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }]
        : system
    })
  for (const m of params.messages) {
    if (typeof m.content === 'string') {
      messages.push({ role: m.role, content: m.content })
      continue
    }
    const texts: string[] = []
    const toolCalls: Array<Record<string, unknown>> = []
    const toolResults: Array<Record<string, unknown>> = []
    for (const b of m.content as Block[]) {
      if (b.type === 'text') texts.push(b.text)
      else if (b.type === 'tool_use')
        toolCalls.push({
          id: b.id,
          type: 'function',
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) }
        })
      else if (b.type === 'tool_result')
        toolResults.push({
          role: 'tool',
          tool_call_id: b.tool_use_id,
          content:
            typeof b.content === 'string' ? b.content : textOf(b.content as Block[] | undefined)
        })
      else if (b.type === 'image') texts.push('[image omitted]')
    }
    if (m.role === 'assistant') {
      messages.push({
        role: 'assistant',
        content: texts.join('\n') || null,
        ...(toolCalls.length ? { tool_calls: toolCalls } : {})
      })
    } else {
      // tool results must directly follow the assistant turn that called them
      for (const tr of toolResults) messages.push(tr)
      if (texts.length) messages.push({ role: 'user', content: texts.join('\n') })
    }
  }
  const tools = (params.tools ?? [])
    .filter((t): t is Anthropic.Tool => 'input_schema' in t)
    .map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema }
    }))
  let tool_choice: unknown
  const tc = params.tool_choice
  if (tc?.type === 'any') tool_choice = 'required'
  else if (tc?.type === 'tool') tool_choice = { type: 'function', function: { name: tc.name } }
  else if (tc?.type === 'auto') tool_choice = 'auto'
  else if (tc?.type === 'none') tool_choice = 'none'
  return {
    model,
    messages,
    max_tokens: params.max_tokens,
    ...(params.temperature != null ? { temperature: params.temperature } : {}),
    ...(params.stop_sequences?.length ? { stop: params.stop_sequences } : {}),
    stream,
    // usage on the stream's last chunk (OpenAI's own option; a gateway that
    // ignores it simply reports zero tokens for the streamed call)
    ...(stream ? { stream_options: { include_usage: true } } : {}),
    ...(tools.length ? { tools, ...(tool_choice ? { tool_choice } : {}) } : {})
  }
}

interface OpenAiResponse {
  id?: string
  model?: string
  choices?: Array<{
    finish_reason?: string
    message?: {
      content?: string | null
      tool_calls?: Array<{ id: string; function?: { name?: string; arguments?: string } }>
    }
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    /** OpenAI's own automatic-cache accounting, when the gateway forwards it */
    prompt_tokens_details?: { cached_tokens?: number }
  }
  error?: { message?: string } | string
}

function fromOpenAi(res: OpenAiResponse, model: string): Anthropic.Message {
  const choice = res.choices?.[0]
  const msg = choice?.message ?? {}
  const content: Array<Record<string, unknown>> = []
  if (msg.content) content.push({ type: 'text', text: String(msg.content), citations: null })
  for (const tcall of msg.tool_calls ?? []) {
    let input: unknown = {}
    try {
      input = JSON.parse(tcall.function?.arguments || '{}')
    } catch {
      input = { _raw: tcall.function?.arguments }
    }
    content.push({ type: 'tool_use', id: tcall.id, name: tcall.function?.name ?? '', input })
  }
  const fr = choice?.finish_reason
  const stop_reason = fr === 'tool_calls' ? 'tool_use' : fr === 'length' ? 'max_tokens' : 'end_turn'
  return {
    id: res.id ?? `gw_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: res.model ?? model,
    content,
    stop_reason,
    stop_sequence: null,
    usage: {
      input_tokens: res.usage?.prompt_tokens ?? 0,
      output_tokens: res.usage?.completion_tokens ?? 0,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: res.usage?.prompt_tokens_details?.cached_tokens ?? null,
      server_tool_use: null,
      service_tier: null
    }
  } as unknown as Anthropic.Message
}

/** `client.messages.create` over an OpenAI-compatible chat/completions endpoint. */
function openAiCompatClient(api: GatewayApi, model: string, caching: boolean): Anthropic {
  const url = `${api.base_url}/openai/v1/chat/completions`
  const create = async (raw: MessageParams): Promise<Anthropic.Message> => {
    const params = caching ? withPromptCaching(raw) : raw
    const attempt = async (retryOn401: boolean): Promise<Anthropic.Message> => {
      const bearer = await gatewayBearer(api)
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${bearer}`
        },
        body: JSON.stringify(toOpenAi(params, model))
      })
      if (res.status === 401 && retryOn401) {
        bustGatewayBearer()
        return attempt(false)
      }
      const text = await res.text()
      let body: OpenAiResponse = {}
      try {
        body = JSON.parse(text) as OpenAiResponse
      } catch {
        /* non-JSON error body */
      }
      if (!res.ok) {
        const detail = typeof body.error === 'string' ? body.error : body.error?.message
        throw new Error(`AI gateway ${res.status}: ${detail ?? text.slice(0, 300)}`)
      }
      return fromOpenAi(body, model)
    }
    return attempt(true)
  }
  /** Open the streamed request: the SSE body becomes Anthropic events. A
   *  non-2xx answer throws BEFORE any event (so the model fallback still
   *  sees a refusal); a cut body ends the message with what arrived. */
  const openStream = async (
    raw: MessageParams,
    opts: StreamOptions
  ): Promise<{ events: AsyncIterable<AiStreamEvent>; abort: () => void }> => {
    const params = caching ? withPromptCaching(raw) : raw
    const controller = new AbortController()
    if (opts.signal) {
      if (opts.signal.aborted) controller.abort()
      else opts.signal.addEventListener('abort', () => controller.abort(), { once: true })
    }
    const attempt = async (retryOn401: boolean): Promise<Response> => {
      const bearer = await gatewayBearer(api)
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
          Authorization: `Bearer ${bearer}`
        },
        body: JSON.stringify(toOpenAi(params, model, true)),
        signal: controller.signal
      })
      if (res.status === 401 && retryOn401) {
        bustGatewayBearer()
        return attempt(false)
      }
      if (!res.ok) {
        const text = await res.text()
        let detail: string | undefined
        try {
          const body = JSON.parse(text) as OpenAiResponse
          detail = typeof body.error === 'string' ? body.error : body.error?.message
        } catch {
          /* non-JSON error body */
        }
        throw new Error(`AI gateway ${res.status}: ${detail ?? text.slice(0, 300)}`)
      }
      if (!res.body) throw new Error('AI gateway answered without a body')
      return res
    }
    const res = await attempt(true)
    const body = res.body as ReadableStream<Uint8Array>
    const events = (async function* (): AsyncGenerator<AiStreamEvent> {
      const state = openAiStreamState(model)
      // a non-streamed JSON answer (a gateway that ignored stream: true)
      const ctype = res.headers.get('content-type') ?? ''
      if (!/event-stream/i.test(ctype)) {
        const text = await res.text()
        let parsed: OpenAiResponse = {}
        try {
          parsed = JSON.parse(text) as OpenAiResponse
        } catch {
          throw new Error(`AI gateway answered ${ctype || 'an unknown type'} to a streamed call`)
        }
        const whole = fromOpenAi(parsed, model)
        for (const e of eventsOfMessage(whole)) yield e
        return
      }
      for await (const chunk of readSseJson(body, controller.signal)) {
        const err = (chunk as { error?: { message?: string } | string }).error
        if (err) throw new Error(`AI gateway: ${typeof err === 'string' ? err : err.message}`)
        for (const e of openAiChunkToEvents(chunk as never, state)) yield e
      }
      if (controller.signal.aborted) throw abortError()
      for (const e of openAiStreamEnd(state)) yield e
    })()
    return { events, abort: () => controller.abort() }
  }
  // Call sites only ever use messages.create / createStream; the rest of the
  // SDK surface is deliberately absent (a throw is better than a silent no-op).
  return {
    messages: {
      create: loggedCreate('gateway-openai', create),
      createStream: loggedStream('gateway-openai', openStream)
    }
  } as unknown as Anthropic
}

/** The real SDK against the gateway's Anthropic-native path, model pinned. */
async function anthropicGatewayClient(
  api: GatewayApi,
  model: string,
  caching: boolean
): Promise<Anthropic> {
  const bearer = await gatewayBearer(api)
  const inner = new Anthropic({
    apiKey: null,
    authToken: bearer,
    baseURL: `${api.base_url}/anthropic`
  })
  return caching
    ? cachingClient(inner, 'gateway-anthropic', model)
    : loggedClient(inner, 'gateway-anthropic', model)
}

// ─── model fallback (#761) ───────────────────────────────────────────────────

const MODEL_REFUSED = /model|not found|unsupported|unknown|does not exist|not available|forbidden/i

/** A gateway that refuses the pinned model (a retired id, one this
 *  deployment's key does not cover) answers 400/403/404 naming the model.
 *  The next model in the chain answers the same call; the log keeps the
 *  failed attempt as its own row, so the fallback is visible, not silent. */
export function withModelFallback(
  chain: string[],
  build: (model: string) => Promise<Anthropic> | Anthropic
): Anthropic {
  const clients = new Map<string, Promise<Anthropic>>()
  const clientFor = (m: string) => {
    let c = clients.get(m)
    if (!c) {
      c = Promise.resolve(build(m))
      clients.set(m, c)
    }
    return c
  }
  /** Try the chain in order; a refusal of the model id moves to the next. */
  const viaChain = async <T>(run: (client: AiClient, model: string) => Promise<T>): Promise<T> => {
    let lastErr: unknown
    for (let i = 0; i < chain.length; i++) {
      const client = (await clientFor(chain[i])) as AiClient
      try {
        return await run(client, chain[i])
      } catch (err) {
        lastErr = err
        const msg = String((err as Error)?.message ?? '')
        const status =
          /AI gateway (\d{3})/.exec(msg)?.[1] ?? String((err as { status?: number })?.status ?? '')
        const refused = ['400', '403', '404', '422'].includes(status) && MODEL_REFUSED.test(msg)
        if (!refused || i === chain.length - 1) throw err
        // biome-ignore lint/suspicious/noConsole: the fallback must be visible in the server log
        console.warn(
          `[ai] model "${chain[i]}" refused (${msg.slice(0, 120)}) — falling back to "${chain[i + 1]}"`
        )
        fallbackCount++
        noteAiFallback(chain[i], chain[i + 1])
      }
    }
    throw lastErr
  }
  const create = (params: MessageParams): Promise<Anthropic.Message> =>
    viaChain((client) => client.messages.create(params) as Promise<Anthropic.Message>)
  // A streamed refusal arrives when the stream OPENS (the openai shim reads
  // the status before any event; the SDK throws on connect), so the fallback
  // covers streams too — once events flow, errors are the caller's.
  const createStream = (params: MessageParams, opts?: StreamOptions): Promise<AiMessageStream> =>
    viaChain((client) =>
      typeof client.messages.createStream === 'function'
        ? client.messages.createStream(params, opts)
        : streamMessage(client, params, opts)
    )
  return { messages: { create, createStream } } as unknown as Anthropic
}

let fallbackCount = 0
/** How many calls fell back to another model since boot (the provider card). */
export function modelFallbacksSinceBoot(): number {
  return fallbackCount
}

// ─── public ──────────────────────────────────────────────────────────────────

/**
 * The one AI client factory. On the gateway paths the MODEL IS PINNED here
 * (the gateway only knows its own ids), so a caller that needs a different
 * model — Ask AI on the chat model — must ask for it: `getAiClient({ model })`.
 * A `model` in the messages.create params is overridden on those paths.
 */
export async function getAiClient(opts?: {
  model?: string | null
  /** false = no fallback to the chat/default model when the gateway refuses
   *  the pinned one (#761). Default: fall back. */
  fallback?: boolean
}): Promise<Anthropic | null> {
  const s = (await settingsRow()) ?? {}
  const caching = cachingOn(s)
  if (s.ai_provider === 'gateway') {
    const api = gatewayFromSettings(s)
    if (!api.base_url || !api.token_url || !api.client_id || !api.client_secret) return null
    const models = parseAiModels(s)
    const model = opts?.model?.trim() || models.default || s.ai_model || 'claude-4-5-haiku'
    const build = (m: string) =>
      s.ai_gateway_format === 'anthropic'
        ? anthropicGatewayClient(api, m, caching)
        : openAiCompatClient(api, m, caching)
    const chain =
      opts?.fallback === false
        ? [model]
        : [
            ...new Set(
              [model, models.chat ?? '', models.default ?? '', s.ai_model ?? ''].filter(Boolean)
            )
          ]
    if (chain.length <= 1) return build(model)
    return withModelFallback(chain, build)
  }
  const key = config.ANTHROPIC_API_KEY || s.anthropic_api_key
  if (!key) return null
  const inner = new Anthropic({ apiKey: key })
  return caching ? cachingClient(inner, 'anthropic') : loggedClient(inner, 'anthropic')
}

export async function getAiModelSettings() {
  const row = (await settingsRow()) ?? {}
  const gateway = row.ai_provider === 'gateway'
  const models = gateway ? parseAiModels(row) : {}
  const model = gateway
    ? models.default || row.ai_model || 'claude-4-5-haiku'
    : (row.ai_model ?? 'claude-haiku-4-5-20251001')
  const chatModel = (gateway && models.chat) || model
  return {
    model,
    /** Ask AI / chat bot: the multi-step tool loop, worth a stronger model than one-shot calls. */
    chatModel,
    /** Document autofill: extraction + lookup tool loop. Blank = the chat model. */
    extractModel: (gateway && models.extract) || chatModel,
    /** One-shot field generation. Blank = the default model. */
    generateModel: (gateway && models.generate) || model,
    /** Record summaries / briefs. Blank = the default model. */
    summarizeModel: (gateway && models.summarize) || model,
    /** Gateway embedding model for semantic search (#681); null = not set. */
    embedModel: (gateway && models.embed) || null,
    /** Gateway speech-to-text model for help-video captions (#1520), reached
     *  through the gateway's OpenAI-compatible /audio/transcriptions; null =
     *  not set (a local Whisper command may still transcribe). */
    transcribeModel: (gateway && models.transcribe) || null,
    answerCacheMinutes:
      row.ai_answer_cache_minutes == null
        ? 15
        : Math.max(0, Number(row.ai_answer_cache_minutes) || 0),
    maxTokensGenerate: row.ai_max_tokens_generate ?? 500,
    maxTokensSummarize: row.ai_max_tokens_summarize ?? 200
  }
}
