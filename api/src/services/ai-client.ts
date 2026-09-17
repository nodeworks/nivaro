import Anthropic from '@anthropic-ai/sdk'
import { config } from '../config.js'
import { db } from '../db/index.js'
import { overlaySettings } from './settings-overrides.js'

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
 * Streaming is not used anywhere in the code base, so the openai translation
 * covers non-streaming calls only.
 */

export interface AiSettingsRow {
  ai_chat_guide?: string | null
  ai_gateway_chat_model?: string | null
  anthropic_api_key?: string | null
  ai_provider?: string | null
  ai_gateway_base_url?: string | null
  ai_gateway_token_url?: string | null
  ai_gateway_client_id?: string | null
  ai_gateway_client_secret?: string | null
  ai_gateway_format?: string | null
  ai_gateway_model?: string | null
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
  return { provider, configured: true, model, format, caching }
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

/** `messages.create` with the caching markers applied on the way in. */
function cachingClient(inner: Anthropic, model?: string): Anthropic {
  const create = (params: MessageParams) =>
    inner.messages.create(withPromptCaching(model ? { ...params, model } : params) as never)
  return { messages: { create } } as unknown as Anthropic
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

function toOpenAi(params: MessageParams, model: string): Record<string, unknown> {
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
    stream: false,
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
  // Call sites only ever use messages.create; the rest of the SDK surface is
  // deliberately absent (a throw is better than a silent no-op there).
  return { messages: { create } } as unknown as Anthropic
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
  if (caching) return cachingClient(inner, model)
  const create = (params: MessageParams) => inner.messages.create({ ...params, model } as never)
  return { messages: { create } } as unknown as Anthropic
}

// ─── public ──────────────────────────────────────────────────────────────────

export async function getAiClient(): Promise<Anthropic | null> {
  const s = (await settingsRow()) ?? {}
  const caching = cachingOn(s)
  if (s.ai_provider === 'gateway') {
    const api = gatewayFromSettings(s)
    if (!api.base_url || !api.token_url || !api.client_id || !api.client_secret) return null
    const model = s.ai_gateway_model?.trim() || s.ai_model || 'claude-4-5-haiku'
    return s.ai_gateway_format === 'anthropic'
      ? anthropicGatewayClient(api, model, caching)
      : openAiCompatClient(api, model, caching)
  }
  const key = config.ANTHROPIC_API_KEY || s.anthropic_api_key
  if (!key) return null
  const inner = new Anthropic({ apiKey: key })
  return caching ? cachingClient(inner) : inner
}

export async function getAiModelSettings() {
  const row = (await settingsRow()) ?? {}
  const gateway = row.ai_provider === 'gateway'
  const model = gateway
    ? row.ai_gateway_model?.trim() || row.ai_model || 'claude-4-5-haiku'
    : (row.ai_model ?? 'claude-haiku-4-5-20251001')
  return {
    model,
    /** Ask AI / chat bot: the multi-step tool loop, worth a stronger model than one-shot calls. */
    chatModel: (gateway && row.ai_gateway_chat_model?.trim()) || model,
    maxTokensGenerate: row.ai_max_tokens_generate ?? 500,
    maxTokensSummarize: row.ai_max_tokens_summarize ?? 200
  }
}
