import type { User } from '../types.js'
import type { ChatTraceEntry } from './ai-chat-loop.js'
import {
  getConversation,
  listMessages,
  messagesForViewer,
  REPLAYABLE_TOOLS,
  type ReplayFn,
  sameUserId
} from './ai-conversations.js'
import { hashToolResult } from './ai-result-hash.js'

/**
 * Shared live Ask AI sessions (#2739). When a stored conversation has other
 * participants (the owner and the people it is shared with), the answer the
 * asker is getting streams to them too — over their own `user:<id>` rooms as
 * `ai:live`, so the room is gated by membership of the conversation, never by
 * a socket room anybody can join.
 *
 * ACCESS NEVER WIDENS. A participant is shown the asker's steps and answer
 * text under the same rule the stored answer is shown under afterwards
 * (services/ai-conversations.ts): every tool call so far must be a replayable
 * read that replays AS THAT PARTICIPANT to the same fingerprint, every earlier
 * answer in the thread must be readable by them, and there must have been at
 * least one call (text written before any tool ran is the model talking from
 * the asker's prompt). Until that holds — or once it stops holding — the
 * participant gets only "<asker> is asking…, working" with no text, and the
 * stored answer they later refetch is filtered for them the normal way.
 *
 * Replays cost a read per call per participant; they run off the asker's
 * path (a promise chain per mirror) so the asker's answer is never slowed,
 * and events keep their order because every emit rides the same chain.
 */

/** Participants mirrored per answer (beyond this they refetch when it lands). */
export const LIVE_MAX_PARTICIPANTS = 5
/** Replays one participant may spend on one answer. */
export const LIVE_MAX_REPLAYS = 20

export type LiveEmit = (userId: string, payload: Record<string, unknown>) => void

export interface LiveMirror {
  /** A finished tool call (the loop's onTrace). A started step names its tool and
   *  target before anything replays, so steps go out only once verified. */
  trace(entry: ChatTraceEntry): void
  /** A text delta (the loop's onDelta). */
  delta(text: string, round: number): void
  /** The answer is over (stored or failed); participants refetch on ai:conversation. */
  end(state: 'answered' | 'failed' | 'stopped'): void
  /** Test seam: resolves when every queued check and emit has run. */
  settled(): Promise<void>
}

interface Watcher {
  user: User
  /** Still entitled to see the stream. */
  open: boolean
  /** Verified tool calls (the trace so far, as far as it was checked). */
  verified: number
  replays: number
}

/** Can this trace entry be shown to someone other than its asker at all? */
export function liveShareableEntry(e: ChatTraceEntry): boolean {
  return (
    REPLAYABLE_TOOLS.has(e.tool) &&
    typeof e.result_hash === 'string' &&
    !(typeof e.summary === 'string' && e.summary.startsWith('error:'))
  )
}

const defaultReplay: ReplayFn = async (u, tool, input) => {
  const { executeChatTool } = await import('./ai-chat.js')
  return executeChatTool(u, tool, input)
}

/**
 * Build the mirror for one answer. `participants` are user ids (the asker is
 * skipped); `loadUser` resolves each one; `earlierVisible` says whether every
 * earlier answer in the thread is readable by them. Null when there is
 * nobody to mirror to.
 */
export function createLiveMirror(opts: {
  conversationId: string
  questionMessageId: string
  asker: { id: string; name: string }
  participants: User[]
  emit: LiveEmit
  /** Every earlier answer is readable by this participant (checked once). */
  earlierVisible: (u: User) => Promise<boolean>
  /** Context the page handed the question rides the trace and never replays. */
  hasPageContext?: boolean
  replay?: ReplayFn
}): LiveMirror | null {
  const others = opts.participants
    .filter((u) => !sameUserId(u.id, opts.asker.id))
    .slice(0, LIVE_MAX_PARTICIPANTS)
  if (!others.length) return null
  const replay = opts.replay ?? defaultReplay
  const watchers: Watcher[] = others.map((user) => ({
    user,
    open: !opts.hasPageContext,
    verified: 0,
    replays: 0
  }))
  const trace: ChatTraceEntry[] = []
  const base = {
    conversation_id: opts.conversationId,
    message_id: opts.questionMessageId,
    by: { id: opts.asker.id, name: opts.asker.name }
  }
  let chain: Promise<void> = Promise.resolve()
  const enqueue = (fn: () => Promise<void> | void) => {
    chain = chain.then(fn).catch(() => {})
  }
  const send = (w: Watcher, payload: Record<string, unknown>) => {
    try {
      opts.emit(String(w.user.id), { ...base, ...payload })
    } catch {
      /* decoration — the asker's answer never depends on the mirror */
    }
  }
  /** What a closed watcher sees: someone is working, nothing more. */
  const sendWorking = (w: Watcher) => send(w, { kind: 'working' })

  // Earlier answers first: one hidden answer closes the watcher for good.
  enqueue(async () => {
    for (const w of watchers) {
      if (!w.open) continue
      if (!(await opts.earlierVisible(w.user).catch(() => false))) w.open = false
    }
    for (const w of watchers) sendWorking(w)
  })

  /** Bring a watcher's verification up to the trace so far. */
  const catchUp = async (w: Watcher) => {
    while (w.open && w.verified < trace.length) {
      const entry = trace[w.verified]
      if (!liveShareableEntry(entry) || w.replays >= LIVE_MAX_REPLAYS) {
        w.open = false
        break
      }
      w.replays++
      try {
        const { result } = await replay(w.user, entry.tool, entry.input ?? {})
        if (hashToolResult(result) !== entry.result_hash) {
          w.open = false
          break
        }
      } catch {
        w.open = false
        break
      }
      w.verified++
      send(w, { kind: 'step', tool: entry.tool, summary: entry.summary })
    }
    if (!w.open) sendWorking(w)
  }
  /** Entitled to text now: open, at least one call, all of them verified. */
  const seesText = (w: Watcher) => w.open && trace.length > 0 && w.verified === trace.length

  return {
    trace(entry) {
      trace.push(entry)
      const snapshot = trace.length
      enqueue(async () => {
        for (const w of watchers) if (w.open && w.verified < snapshot) await catchUp(w)
      })
    },
    delta(text, round) {
      enqueue(() => {
        for (const w of watchers) if (seesText(w)) send(w, { kind: 'delta', text, round })
      })
    },
    end(state) {
      enqueue(() => {
        for (const w of watchers) send(w, { kind: 'end', state })
      })
    },
    settled: () => chain
  }
}

/**
 * The mirror for a turn in a stored conversation: resolves the participants,
 * the asker's name and each participant's earlier-answer verdict. Null when
 * nobody else is in it.
 */
export async function openLiveMirror(input: {
  conversationId: string
  questionMessageId: string
  asker: User
  participantIds: string[]
  emit: LiveEmit
  hasPageContext?: boolean
}): Promise<LiveMirror | null> {
  const ids = input.participantIds.filter((id) => !sameUserId(id, input.asker.id))
  if (!ids.length) return null
  const { getUser } = await import('./users.js')
  const users: User[] = []
  for (const id of ids.slice(0, LIVE_MAX_PARTICIPANTS)) {
    const u = await getUser(id).catch(() => undefined)
    if (u && u.status === 'active') users.push(u)
  }
  if (!users.length) return null
  const conv = await getConversation(input.conversationId)
  if (!conv) return null
  // Earlier turns only: the question just stored has no answer yet.
  const rows = (await listMessages(conv.id)).filter(
    (r) => String(r.id) !== String(input.questionMessageId)
  )
  const asker = input.asker
  const name =
    [asker.first_name, asker.last_name].filter(Boolean).join(' ').trim() || asker.email || 'Someone'
  return createLiveMirror({
    conversationId: input.conversationId,
    questionMessageId: input.questionMessageId,
    asker: { id: String(asker.id), name },
    participants: users,
    emit: input.emit,
    hasPageContext: input.hasPageContext,
    earlierVisible: async (u) => {
      const view = await messagesForViewer(u, rows)
      return view.every((m) => m.role !== 'assistant' || m.visible)
    }
  })
}
