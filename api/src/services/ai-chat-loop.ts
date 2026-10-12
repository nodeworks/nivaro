import type Anthropic from '@anthropic-ai/sdk'
import type { User } from '../types.js'
import { buildWrapUpMessages, CHAT_TOOLS, executeChatTool, MAX_ROUNDS } from './ai-chat.js'
import { hashToolResult } from './ai-result-hash.js'
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
  /** Fingerprint of what the tool showed the model (#1809 shared threads). */
  result_hash?: string
}

export interface ChatLoopCallbacks {
  /** A text delta; `round` tells a client which round it belongs to (a
   *  tool round's text is narration, the final round's text is the answer). */
  onDelta?: (text: string, round: number) => void
  /** A tool is about to run in `round` — then, once it returns, the same
   *  step again with `done: true` and a short `result` ("42 found") or
   *  `failed: true` (#1839: the steps list above the answer). */
  onStatus?: (status: ChatStepStatus) => void
  /** Polled between deltas — true stops the loop at once. */
  shouldStop?: () => boolean
}

export interface ChatStepStatus {
  round: number
  tool: string
  text: string
  /** Which tool call of the round (0-based) — pairs a step's start and end. */
  step?: number
  done?: boolean
  failed?: boolean
  result?: string
}

export interface ChatLoopResult {
  text: string
  trace: ChatTraceEntry[]
  proposals: Array<Record<string, unknown>>
  /** Multi-step plans the model proposed (services/ai-plans.ts). */
  plans: Array<Record<string, unknown>>
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
    case 'propose_plan':
      return 'Drafting a plan for you to approve…'
    default:
      return `Using ${name(tool)}…`
  }
}

/** The few words after a finished step ("42 found", "3 groups") — read off
 *  the tool's own summary, so any tool gets one; '' when nothing reads well. */
export function describeToolResult(tool: string, summary: string): string {
  const s = summary.trim()
  if (!s) return ''
  let m = /^(\d+) of (\d+) row\(s\)/.exec(s)
  if (m) return `${Number(m[2]).toLocaleString('en-US')} found`
  m = /^(\d+) row\(s\)/.exec(s.replace(/^[^:]+:\s*/, ''))
  if (m) return `${Number(m[1]).toLocaleString('en-US')} found`
  m = /: (\d+) group\(s\)$/.exec(s)
  if (m) return `${m[1]} group${m[1] === '1' ? '' : 's'}`
  m = /\) = (.+)$/.exec(s)
  if (m) {
    const n = Number(m[1])
    return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 2 }) : m[1]
  }
  if (tool === 'propose_action' || tool === 'propose_plan') return 'ready for you to review'
  m = /^(\d+) (semantic hit|open task|help video|integrity finding)/.exec(s)
  if (m) return `${m[1]} found`
  return s.length <= 60 ? s : ''
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
  const plans: Array<Record<string, unknown>> = []

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
      return { text: '', trace, proposals, plans, rounds: round, truncated: false, stopped: true }
    const { message, stopped, partial } = await call(
      { model, max_tokens: maxTokens, system, tools: CHAT_TOOLS, messages: convo },
      round
    )
    if (stopped)
      return {
        text: partial,
        trace,
        proposals,
        plans,
        rounds: round + 1,
        truncated: false,
        stopped: true
      }

    if (message.stop_reason !== 'tool_use') {
      return {
        text: textOf(message),
        trace,
        proposals,
        plans,
        rounds: round + 1,
        truncated: false,
        stopped: false
      }
    }

    convo.push({ role: 'assistant', content: message.content })
    const results: Anthropic.ToolResultBlockParam[] = []
    let step = -1
    for (const block of message.content) {
      if (block.type !== 'tool_use') continue
      step++
      const input = (block.input ?? {}) as Record<string, unknown>
      const text = describeToolCall(block.name, input)
      onStatus?.({ round, tool: block.name, text, step })
      try {
        const { result, summary } = await executeChatTool(user, block.name, input)
        trace.push({ tool: block.name, input, summary, result_hash: hashToolResult(result) })
        onStatus?.({
          round,
          tool: block.name,
          text,
          step,
          done: true,
          result: describeToolResult(block.name, summary)
        })
        if (block.name === 'propose_action' && result && typeof result === 'object') {
          proposals.push(result as Record<string, unknown>)
        }
        if (block.name === 'propose_plan' && result && typeof result === 'object') {
          plans.push(result as Record<string, unknown>)
        }
        results.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(result).slice(0, 12_000)
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : 'Tool failed'
        trace.push({ tool: block.name, input, summary: `error: ${msg}` })
        onStatus?.({ round, tool: block.name, text, step, done: true, failed: true })
        results.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: `Error: ${msg}`,
          is_error: true
        })
      }
      if (shouldStop?.()) {
        return {
          text: '',
          trace,
          proposals,
          plans,
          rounds: round + 1,
          truncated: false,
          stopped: true
        }
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
  return { text, trace, proposals, plans, rounds: MAX_ROUNDS, truncated: true, stopped }
}

export { MAX_ROUNDS }
