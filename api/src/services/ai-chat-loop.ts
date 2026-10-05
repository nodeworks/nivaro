import type Anthropic from '@anthropic-ai/sdk'
import type { User } from '../types.js'
import { buildWrapUpMessages, CHAT_TOOLS, executeChatTool, MAX_ROUNDS } from './ai-chat.js'
import { consumeText, isAbortError, streamMessage } from './ai-stream.js'

/**
 * The Ask AI tool loop (#688 moved it out of the route so it can stream).
 * Rounds, tool results, proposals, the wrap-up past the round cap — all as
 * before; what is new is that every round is read as a STREAM: text deltas
 * reach `onDelta` as they arrive, a round that turns out to be a tool round
 * reports each tool through `onStatus`, and `shouldStop` is polled between
 * deltas so a person can halt a long answer. Without callbacks the loop
 * behaves exactly like the old non-streamed one.
 */

export interface ChatTraceEntry {
  tool: string
  input: Record<string, unknown>
  summary: string
}

export interface ChatLoopCallbacks {
  /** A text delta; `round` tells a client which round it belongs to (a
   *  tool round's text is narration, the final round's text is the answer). */
  onDelta?: (text: string, round: number) => void
  /** A tool is about to run in `round`. */
  onStatus?: (status: { round: number; tool: string; text: string }) => void
  /** Polled between deltas — true stops the loop at once. */
  shouldStop?: () => boolean
}

export interface ChatLoopResult {
  text: string
  trace: ChatTraceEntry[]
  proposals: Array<Record<string, unknown>>
  rounds: number
  /** The round cap was hit and the wrap-up call answered instead. */
  truncated: boolean
  /** Stopped by the caller — `text` is what had arrived. */
  stopped: boolean
}

export interface ChatLoopOptions extends ChatLoopCallbacks {
  client: Anthropic
  model: string
  system: string | Anthropic.TextBlockParam[]
  user: User
  /** The conversation; the loop APPENDS to it. */
  convo: Anthropic.MessageParam[]
  maxTokens?: number
  warn?: (err: unknown, msg: string) => void
}

/** What the status line says while a tool runs — generic over the tool set,
 *  so a tool an extension adds still reads as a sentence. */
export function describeToolCall(tool: string, input: Record<string, unknown>): string {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  const name = (s: string) => s.replace(/_/g, ' ')
  switch (tool) {
    case 'list_collections':
      return str('collection') ? `Looking at ${name(str('collection'))}…` : 'Listing collections…'
    case 'query_items':
      return `Reading ${name(str('collection')) || 'records'}…`
    case 'aggregate':
      return `Counting ${name(str('collection')) || 'records'}…`
    case 'semantic_search':
      return 'Searching…'
    case 'run_custom_query':
      return `Running ${str('slug') || 'a saved query'}…`
    case 'queue_summary':
      return `Looking at the ${str('queue') || str('name') || ''} queue…`.replace(/\s{2,}/g, ' ')
    case 'propose_action':
      return 'Drafting a proposal for you to approve…'
    case 'my_tasks':
      return 'Checking tasks…'
    case 'integration_status':
    case 'record_event_path':
    case 'record_integrity':
    case 'explain_access':
      return `Checking ${name(str('collection')) || 'the record'}…`
    default:
      return `Using ${name(tool)}…`
  }
}

function textOf(message: Anthropic.Message): string {
  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
}

export async function runChatLoop(opts: ChatLoopOptions): Promise<ChatLoopResult> {
  const { client, model, system, user, convo, onDelta, onStatus, shouldStop } = opts
  const maxTokens = opts.maxTokens ?? 1500
  const trace: ChatTraceEntry[] = []
  const proposals: Array<Record<string, unknown>> = []

  /** One streamed call; text deltas go out as they arrive, `stopped` when
   *  the caller halted it mid-stream (the partial message comes back). */
  const call = async (
    params: Anthropic.MessageCreateParams,
    round: number
  ): Promise<{ message: Anthropic.Message; stopped: boolean; partial: string }> => {
    // No sink and no stopper = the plain call, byte for byte as before (#688
    // leaves a request without `stream` on messages.create).
    if (!onDelta && !shouldStop) {
      const message = (await client.messages.create(params)) as Anthropic.Message
      return { message, stopped: false, partial: textOf(message) }
    }
    const controller = new AbortController()
    let partial = ''
    let stopped = false
    const stream = await streamMessage(client, params, { signal: controller.signal })
    try {
      const message = await consumeText(stream, (text) => {
        partial += text
        onDelta?.(text, round)
        if (shouldStop?.()) {
          stopped = true
          controller.abort()
          stream.abort()
        }
      })
      return { message, stopped, partial }
    } catch (err) {
      if (stopped || isAbortError(err)) {
        return {
          message: {
            id: '',
            type: 'message',
            role: 'assistant',
            model,
            content: partial ? [{ type: 'text', text: partial, citations: null }] : [],
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: {
              input_tokens: 0,
              output_tokens: 0,
              cache_creation_input_tokens: null,
              cache_read_input_tokens: null,
              server_tool_use: null,
              service_tier: null
            }
          } as unknown as Anthropic.Message,
          stopped: true,
          partial
        }
      }
      throw err
    }
  }

  for (let round = 0; round < MAX_ROUNDS; round++) {
    if (shouldStop?.())
      return { text: '', trace, proposals, rounds: round, truncated: false, stopped: true }
    const { message, stopped, partial } = await call(
      { model, max_tokens: maxTokens, system, tools: CHAT_TOOLS, messages: convo },
      round
    )
    if (stopped)
      return { text: partial, trace, proposals, rounds: round + 1, truncated: false, stopped: true }

    if (message.stop_reason !== 'tool_use') {
      return {
        text: textOf(message),
        trace,
        proposals,
        rounds: round + 1,
        truncated: false,
        stopped: false
      }
    }

    convo.push({ role: 'assistant', content: message.content })
    const results: Anthropic.ToolResultBlockParam[] = []
    for (const block of message.content) {
      if (block.type !== 'tool_use') continue
      const input = (block.input ?? {}) as Record<string, unknown>
      onStatus?.({ round, tool: block.name, text: describeToolCall(block.name, input) })
      try {
        const { result, summary } = await executeChatTool(user, block.name, input)
        trace.push({ tool: block.name, input, summary })
        if (block.name === 'propose_action' && result && typeof result === 'object') {
          proposals.push(result as Record<string, unknown>)
        }
        results.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(result).slice(0, 12_000)
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Tool failed'
        trace.push({ tool: block.name, input, summary: `error: ${msg}` })
        results.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: `Error: ${msg}`,
          is_error: true
        })
      }
      if (shouldStop?.()) {
        return { text: '', trace, proposals, rounds: round + 1, truncated: false, stopped: true }
      }
    }
    convo.push({ role: 'user', content: results })
  }

  // Out of rounds: one last call with NO tools and NO tool blocks (the
  // transcript rides as plain text — some providers refuse tool history
  // without a tool config), so the model answers from what it gathered
  // instead of the user getting a dead end.
  let text = ''
  let stopped = false
  try {
    onStatus?.({ round: MAX_ROUNDS, tool: '', text: 'Wrapping up…' })
    const final = await call(
      { model, max_tokens: maxTokens, system, messages: buildWrapUpMessages(convo) },
      MAX_ROUNDS
    )
    stopped = final.stopped
    text = (final.stopped ? final.partial : textOf(final.message)).trim()
  } catch (err) {
    opts.warn?.(err, 'AI chat wrap-up call failed')
  }
  return { text, trace, proposals, rounds: MAX_ROUNDS, truncated: true, stopped }
}

export { MAX_ROUNDS }
