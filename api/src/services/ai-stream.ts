import type Anthropic from '@anthropic-ai/sdk'

/**
 * Streaming over the one AI client (#688). Every path — the Anthropic SDK,
 * the anthropic-native gateway and the openai-compatible gateway — yields the
 * SAME Anthropic-shaped stream events (`content_block_start/delta/stop`,
 * `message_delta`, `message_stop`), and `assembleMessage` folds them back
 * into the shape `messages.create` returns, so a streamed call ends with the
 * one message the log records and the caller reads. The openai translation
 * (`openAiChunkToEvents`) and the SSE line parser are pure and unit-tested;
 * nothing here touches the network.
 */

export type AiStreamEvent = Anthropic.RawMessageStreamEvent

/** A streamed call: iterate the events as they arrive (once), then read the
 *  assembled message. `finalMessage()` drains the stream itself when nobody
 *  iterated it. */
export interface AiMessageStream extends AsyncIterable<AiStreamEvent> {
  finalMessage(): Promise<Anthropic.Message>
  abort(): void
}

// ─── assembling the final message ────────────────────────────────────────────

type Usage = Record<string, unknown>

/** Fold stream events into the non-streamed `Message` shape. */
export function createMessageAssembler() {
  let message: Record<string, unknown> | null = null
  const blocks: Array<Record<string, unknown>> = []
  const json: Map<number, string> = new Map()

  const push = (ev: AiStreamEvent) => {
    const e = ev as unknown as Record<string, unknown>
    switch (e.type) {
      case 'message_start': {
        const m = (e.message ?? {}) as Record<string, unknown>
        message = { ...m, content: [] }
        break
      }
      case 'content_block_start': {
        const i = Number(e.index)
        const b = { ...((e.content_block ?? {}) as Record<string, unknown>) }
        if (b.type === 'text') b.text = typeof b.text === 'string' ? b.text : ''
        if (b.type === 'tool_use') {
          json.set(i, '')
          b.input = b.input && typeof b.input === 'object' ? b.input : {}
        }
        blocks[i] = b
        break
      }
      case 'content_block_delta': {
        const i = Number(e.index)
        const d = (e.delta ?? {}) as Record<string, unknown>
        if (!blocks[i]) blocks[i] = { type: 'text', text: '', citations: null }
        const b = blocks[i]
        if (d.type === 'text_delta') b.text = `${String(b.text ?? '')}${String(d.text ?? '')}`
        else if (d.type === 'input_json_delta')
          json.set(i, `${json.get(i) ?? ''}${String(d.partial_json ?? '')}`)
        break
      }
      case 'content_block_stop': {
        const i = Number(e.index)
        const b = blocks[i]
        if (b && b.type === 'tool_use') b.input = parseToolInput(json.get(i) ?? '', b.input)
        break
      }
      case 'message_delta': {
        if (!message) message = skeleton('', '')
        const d = (e.delta ?? {}) as Record<string, unknown>
        if ('stop_reason' in d) message.stop_reason = d.stop_reason ?? null
        if ('stop_sequence' in d) message.stop_sequence = d.stop_sequence ?? null
        const u = e.usage as Usage | undefined
        if (u) {
          const merged = { ...((message.usage as Usage) ?? {}) }
          for (const [k, v] of Object.entries(u)) if (v != null) merged[k] = v
          message.usage = merged
        }
        break
      }
      default:
        break
    }
  }

  const finish = (): Anthropic.Message => {
    const m = message ?? skeleton('', '')
    // a block whose stop never arrived (the stream was cut) still parses
    for (const [i, raw] of json) {
      const b = blocks[i]
      if (b && b.type === 'tool_use' && (!b.input || !Object.keys(b.input as object).length))
        b.input = parseToolInput(raw, b.input)
    }
    m.content = blocks.filter(Boolean)
    if (m.stop_reason === undefined) m.stop_reason = null
    if (m.stop_sequence === undefined) m.stop_sequence = null
    return m as unknown as Anthropic.Message
  }

  /** Text accumulated so far (every text block, newline-joined). */
  const text = () =>
    blocks
      .filter((b) => b && b.type === 'text')
      .map((b) => String(b.text ?? ''))
      .join('\n')

  return { push, finish, text }
}

function parseToolInput(raw: string, fallback: unknown): unknown {
  const s = raw.trim()
  if (!s) return fallback && typeof fallback === 'object' ? fallback : {}
  try {
    return JSON.parse(s)
  } catch {
    return { _raw: raw }
  }
}

function skeleton(id: string, model: string): Record<string, unknown> {
  return {
    id,
    type: 'message',
    role: 'assistant',
    model,
    content: [],
    stop_reason: null,
    stop_sequence: null,
    usage: {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      server_tool_use: null,
      service_tier: null
    }
  }
}

/** Convenience over the assembler for a whole event list. */
export function assembleMessage(events: Iterable<AiStreamEvent>): Anthropic.Message {
  const a = createMessageAssembler()
  for (const ev of events) a.push(ev)
  return a.finish()
}

// ─── building a stream from an event source ─────────────────────────────────

export interface MessageStreamHooks {
  /** Runs once with the assembled message after the last event. */
  onFinal?: (message: Anthropic.Message) => void
  /** Runs once when iteration throws (the consumer still sees the throw);
   *  `partial` is what had been assembled by then — an abort still has text. */
  onError?: (err: unknown, partial: Anthropic.Message) => void
}

/**
 * Wrap an event source as an `AiMessageStream`: the source is iterated at
 * most once, events are assembled as they pass through, and `finalMessage()`
 * resolves when the source ends — driving the iteration itself when the
 * caller never did.
 */
export function makeMessageStream(
  source: AsyncIterable<AiStreamEvent>,
  abort: () => void,
  hooks: MessageStreamHooks = {}
): AiMessageStream {
  const assembler = createMessageAssembler()
  let settled: Promise<Anthropic.Message> | null = null
  let resolveFinal!: (m: Anthropic.Message) => void
  let rejectFinal!: (e: unknown) => void
  const final = new Promise<Anthropic.Message>((res, rej) => {
    resolveFinal = res
    rejectFinal = rej
  })
  // a never-awaited rejection must not surface as unhandled
  final.catch(() => undefined)

  let started = false
  async function* run(): AsyncGenerator<AiStreamEvent> {
    started = true
    try {
      for await (const ev of source) {
        assembler.push(ev)
        yield ev
      }
      const m = assembler.finish()
      try {
        hooks.onFinal?.(m)
      } catch {
        /* a hook must never fail the stream */
      }
      resolveFinal(m)
    } catch (err) {
      try {
        hooks.onError?.(err, assembler.finish())
      } catch {
        /* same */
      }
      rejectFinal(err)
      throw err
    }
  }

  let iterator: AsyncGenerator<AiStreamEvent> | null = null
  return {
    [Symbol.asyncIterator]() {
      if (!iterator) iterator = run()
      return iterator
    },
    finalMessage() {
      if (!settled) {
        settled = (async () => {
          if (!started) {
            const it = this[Symbol.asyncIterator]()
            while (!(await it.next()).done) {
              /* drain */
            }
          }
          return final
        })()
      }
      return settled
    },
    abort
  }
}

/** Events for a message that was NOT streamed — one text delta per text
 *  block, tool blocks whole — so a caller can treat every client the same. */
export function eventsOfMessage(message: Anthropic.Message): AiStreamEvent[] {
  const m = message as unknown as Record<string, unknown>
  const out: Record<string, unknown>[] = [{ type: 'message_start', message: { ...m, content: [] } }]
  const content = Array.isArray(m.content) ? (m.content as Record<string, unknown>[]) : []
  content.forEach((b, i) => {
    if (b.type === 'text') {
      out.push({ type: 'content_block_start', index: i, content_block: { ...b, text: '' } })
      out.push({
        type: 'content_block_delta',
        index: i,
        delta: { type: 'text_delta', text: String(b.text ?? '') }
      })
    } else {
      out.push({ type: 'content_block_start', index: i, content_block: { ...b } })
    }
    out.push({ type: 'content_block_stop', index: i })
  })
  out.push({
    type: 'message_delta',
    delta: { stop_reason: m.stop_reason ?? null, stop_sequence: m.stop_sequence ?? null },
    usage: m.usage ?? {}
  })
  out.push({ type: 'message_stop' })
  return out as unknown as AiStreamEvent[]
}

// ─── openai chat/completions chunks → Anthropic events ──────────────────────

export interface OpenAiChunk {
  id?: string
  model?: string
  choices?: Array<{
    index?: number
    delta?: {
      role?: string
      content?: string | null
      tool_calls?: Array<{
        index?: number
        id?: string
        type?: string
        function?: { name?: string; arguments?: string }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
  } | null
  error?: { message?: string } | string
}

export interface OpenAiStreamState {
  model: string
  started: boolean
  finished: boolean
  id: string | null
  nextIndex: number
  /** the open text block, if any */
  textIndex: number | null
  /** openai tool_call index → our block index */
  tools: Map<number, number>
  /** a tool block was opened at some point — the stop reason follows it when
   *  the gateway never says (some send `finish_reason: null` on every chunk) */
  hadTools: boolean
  finishReason: string | null
  usage: OpenAiChunk['usage'] | null
}

export function openAiStreamState(model: string): OpenAiStreamState {
  return {
    model,
    started: false,
    finished: false,
    id: null,
    nextIndex: 0,
    textIndex: null,
    tools: new Map(),
    hadTools: false,
    finishReason: null,
    usage: null
  }
}

const ev = (o: Record<string, unknown>) => o as unknown as AiStreamEvent

/**
 * Translate ONE chat/completions chunk into Anthropic stream events, carrying
 * the open blocks in `state`. A chunk with no choices (the usage-only tail
 * the gateway sends under `stream_options.include_usage`) records usage and
 * yields nothing; `openAiStreamEnd` closes the message.
 */
export function openAiChunkToEvents(chunk: OpenAiChunk, state: OpenAiStreamState): AiStreamEvent[] {
  const out: AiStreamEvent[] = []
  if (chunk.usage) state.usage = chunk.usage
  if (chunk.id && !state.id) state.id = chunk.id
  if (chunk.model) state.model = chunk.model
  if (!state.started) {
    state.started = true
    out.push(
      ev({
        type: 'message_start',
        message: skeleton(state.id ?? `gw_${Date.now()}`, state.model)
      })
    )
  }
  const choice = chunk.choices?.[0]
  if (!choice) return out
  const delta = choice.delta ?? {}
  if (delta.content) {
    if (state.textIndex == null) {
      state.textIndex = state.nextIndex++
      out.push(
        ev({
          type: 'content_block_start',
          index: state.textIndex,
          content_block: { type: 'text', text: '', citations: null }
        })
      )
    }
    out.push(
      ev({
        type: 'content_block_delta',
        index: state.textIndex,
        delta: { type: 'text_delta', text: String(delta.content) }
      })
    )
  }
  for (const tc of delta.tool_calls ?? []) {
    const oi = Number(tc.index ?? state.tools.size)
    let bi = state.tools.get(oi)
    if (bi == null) {
      // text precedes tool calls in the Anthropic shape — close it first
      if (state.textIndex != null) {
        out.push(ev({ type: 'content_block_stop', index: state.textIndex }))
        state.textIndex = null
      }
      bi = state.nextIndex++
      state.tools.set(oi, bi)
      state.hadTools = true
      out.push(
        ev({
          type: 'content_block_start',
          index: bi,
          content_block: {
            type: 'tool_use',
            id: tc.id ?? `call_${bi}`,
            name: tc.function?.name ?? '',
            input: {}
          }
        })
      )
    }
    const args = tc.function?.arguments
    if (args)
      out.push(
        ev({
          type: 'content_block_delta',
          index: bi,
          delta: { type: 'input_json_delta', partial_json: args }
        })
      )
  }
  if (choice.finish_reason && !state.finished) {
    state.finished = true
    state.finishReason = choice.finish_reason
    out.push(...closeBlocks(state))
  }
  return out
}

function closeBlocks(state: OpenAiStreamState): AiStreamEvent[] {
  const out: AiStreamEvent[] = []
  if (state.textIndex != null) {
    out.push(ev({ type: 'content_block_stop', index: state.textIndex }))
    state.textIndex = null
  }
  for (const bi of [...state.tools.values()].sort((a, b) => a - b))
    out.push(ev({ type: 'content_block_stop', index: bi }))
  state.tools.clear()
  return out
}

/** The stream ended ([DONE] or EOF): close what is open, then the message. */
export function openAiStreamEnd(state: OpenAiStreamState): AiStreamEvent[] {
  const out: AiStreamEvent[] = []
  if (!state.started) {
    state.started = true
    out.push(
      ev({ type: 'message_start', message: skeleton(state.id ?? `gw_${Date.now()}`, state.model) })
    )
  }
  if (!state.finished) {
    state.finished = true
    out.push(...closeBlocks(state))
  }
  // A message that called a tool stopped FOR the tool, whatever the gateway
  // said (or did not say) in `finish_reason`; only a length cut outranks it.
  const fr = state.finishReason
  const stop_reason =
    fr === 'length' ? 'max_tokens' : fr === 'tool_calls' || state.hadTools ? 'tool_use' : 'end_turn'
  const u = state.usage
  out.push(
    ev({
      type: 'message_delta',
      delta: { stop_reason, stop_sequence: null },
      usage: {
        input_tokens: u?.prompt_tokens ?? 0,
        output_tokens: u?.completion_tokens ?? 0,
        cache_creation_input_tokens: null,
        cache_read_input_tokens: u?.prompt_tokens_details?.cached_tokens ?? null
      }
    })
  )
  out.push(ev({ type: 'message_stop' }))
  return out
}

// ─── SSE wire parsing ────────────────────────────────────────────────────────

/**
 * Pull complete SSE events out of a growing buffer. Returns the `data:`
 * payloads of every complete event (multi-line data joined with '\n') and the
 * unconsumed tail. Comment lines and other fields are ignored.
 */
export function takeSseData(buffer: string): { data: string[]; rest: string } {
  const data: string[] = []
  let rest = buffer
  for (;;) {
    const m = /\r?\n\r?\n/.exec(rest)
    if (!m) break
    const block = rest.slice(0, m.index)
    rest = rest.slice(m.index + m[0].length)
    const lines = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
    if (lines.length) data.push(lines.join('\n'))
  }
  return { data, rest }
}

/** Decode a `ReadableStream` of SSE bytes into parsed JSON chunks; `[DONE]` ends it. */
export async function* readSseJson(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal
): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      if (signal?.aborted) throw abortError()
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const { data, rest } = takeSseData(buffer)
      buffer = rest
      for (const d of data) {
        if (d.trim() === '[DONE]') return
        try {
          yield JSON.parse(d) as Record<string, unknown>
        } catch {
          /* a partial or non-JSON line — skip it */
        }
      }
    }
    const tail = takeSseData(`${buffer}\n\n`).data
    for (const d of tail) {
      if (d.trim() === '[DONE]') return
      try {
        yield JSON.parse(d) as Record<string, unknown>
      } catch {
        /* same */
      }
    }
  } finally {
    reader.releaseLock()
  }
}

export function abortError(): Error {
  return Object.assign(new Error('AI stream stopped'), { name: 'AbortError', aborted: true })
}

export function isAbortError(err: unknown): boolean {
  const e = err as { name?: string; aborted?: boolean } | null
  return !!e && (e.name === 'AbortError' || e.aborted === true)
}

// ─── the caller-facing helper ────────────────────────────────────────────────

export interface StreamOptions {
  signal?: AbortSignal
}

type StreamCapable = {
  messages: {
    create: (params: Anthropic.MessageCreateParams) => Promise<Anthropic.Message>
    createStream?: (
      params: Anthropic.MessageCreateParams,
      opts?: StreamOptions
    ) => Promise<AiMessageStream>
  }
}

/**
 * Stream a message through whichever client `getAiClient()` returned. A
 * client without `createStream` (a test double, an extension's own) answers
 * with a one-shot create replayed as events, so callers never branch.
 */
export async function streamMessage(
  client: Anthropic,
  params: Anthropic.MessageCreateParams,
  opts: StreamOptions = {}
): Promise<AiMessageStream> {
  const c = client as unknown as StreamCapable
  if (typeof c.messages.createStream === 'function') return c.messages.createStream(params, opts)
  const message = await c.messages.create(params)
  const events = eventsOfMessage(message)
  return makeMessageStream(
    (async function* () {
      for (const e of events) yield e
    })(),
    () => undefined
  )
}

/** Text deltas out of a stream, with the final message after. */
export async function consumeText(
  stream: AiMessageStream,
  onDelta?: (text: string) => void
): Promise<Anthropic.Message> {
  for await (const e of stream) {
    const r = e as unknown as { type: string; delta?: { type?: string; text?: string } }
    if (r.type === 'content_block_delta' && r.delta?.type === 'text_delta' && r.delta.text)
      onDelta?.(r.delta.text)
  }
  return stream.finalMessage()
}
