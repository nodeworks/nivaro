import type { FastifyInstance } from 'fastify'
import { adminBaseUrl } from '../admin-base.js'
import { db } from '../db/index.js'
import { runInBackgroundPool } from '../db/pool-context.js'
import type { User } from '../types.js'
import { logActivity } from './activity.js'
import { type ConversationTurn, openConversationTurn } from './ai-conversation-turn.js'
import { titleFromQuestion } from './ai-conversations.js'
import { registerStream, requestStreamStop } from './ai-stream-delivery.js'
import { type JobRunHandle, startJobRun } from './job-runs.js'
import { emitJobProgress, emitToUser } from './live-progress.js'
import { runInTrace } from './request-trace.js'

/**
 * Background research questions (#2456). "Ask in background" runs one Ask AI
 * question as a job in the person's Jobs tray instead of in their open page:
 *  - READ-ONLY: the loop is offered only the replayable read tools
 *    (ai-chat-loop readOnly) — no proposals, no plans, no saved SQL — so Ask
 *    AI still changes data only through a plan the person approves;
 *  - AS THE ASKER: every tool call runs with their permissions, scopes and
 *    field limits, exactly like a question asked on the page;
 *  - a LARGER BUDGET: more tool rounds, a longer answer and a wall-clock cap;
 *  - the answer is stored in the person's Ask history (a conversation turn,
 *    meta.research) and lands in their inbox; the tray links to it;
 *  - cancellable from the tray (POST /ai/research/:run/cancel): the stop flag
 *    rides the same stream-stop seam as a streamed answer, so it reaches the
 *    process running it.
 */

export const RESEARCH_JOB_ID = 'ask-research'
export const RESEARCH_MAX_ROUNDS = 30
export const RESEARCH_MAX_TOKENS = 3000
export const RESEARCH_TIME_BUDGET_MS = 10 * 60_000
/** Background questions one person may have running at once. */
export const RESEARCH_MAX_RUNNING = 2

const RESEARCH_DIRECTIVE = `

## Background research
This question runs in the background with a larger budget than usual (up to ${RESEARCH_MAX_ROUNDS} tool rounds), and the person is not watching it. Be thorough: break the question down, cross-check figures from more than one angle, and finish with a complete, self-contained written answer (the person reads it later, from their inbox). Only reading tools exist in this run: if the question asks for a change, say what you found and suggest they ask again on the page to draft a plan.`

export const researchStreamId = (runId: number | string) => `research-${runId}`

export function researchLink(conversationId: string): string {
  return `/ask?conversation=${encodeURIComponent(conversationId)}`
}

export interface ResearchStart {
  run_id: number | null
  conversation_id: string
  question_message_id: string
}

type StartResult = ResearchStart | { status: number; error: string }

/** How many background questions `userId` has running now. */
export async function runningResearchCount(userId: string): Promise<number> {
  const since = new Date(Date.now() - RESEARCH_TIME_BUDGET_MS - 5 * 60_000)
  const row = (await db('nivaro_job_runs')
    .where({ kind: 'ai', job_id: RESEARCH_JOB_ID, triggered_by: userId, status: 'running' })
    .where('started_at', '>=', since)
    .count({ n: '*' })
    .first()
    .catch(() => ({ n: 0 }))) as { n?: number | string } | undefined
  return Number(row?.n ?? 0)
}

/** The reply text past the follow-up list, plus the follow-ups themselves. */
async function splitReply(text: string): Promise<{ text: string; followups: string[] }> {
  const { extractFollowUps } = await import('./ai-panel.js')
  return extractFollowUps(text)
}

/**
 * Start a background question. The question is stored at once (it shows in
 * the conversation straight away); the answer follows when the job ends.
 */
export async function startResearch(
  app: FastifyInstance,
  user: User,
  input: { question: unknown; conversationId?: unknown }
): Promise<StartResult> {
  const question = typeof input.question === 'string' ? input.question.trim().slice(0, 4000) : ''
  if (!question) return { status: 400, error: 'question is required' }
  const userId = String(user.id)
  const { aiHistoryOff } = await import('./ai-memory.js')
  if (await aiHistoryOff(userId)) {
    return {
      status: 409,
      error:
        'Your Ask AI history is off. A background answer is kept in your Ask history, so turn history on to ask in the background.'
    }
  }
  if ((await runningResearchCount(userId)) >= RESEARCH_MAX_RUNNING) {
    return {
      status: 429,
      error: `You already have ${RESEARCH_MAX_RUNNING} questions running in the background. Wait for one to finish or cancel it from the Jobs tray.`
    }
  }
  const { getAiClient, getAiModelSettings } = await import('./ai-client.js')
  const { chatModel } = await getAiModelSettings()
  const client = await getAiClient({ model: chatModel })
  if (!client) return { status: 503, error: 'AI features are not configured' }

  const conversationId =
    typeof input.conversationId === 'string' && input.conversationId.trim()
      ? input.conversationId.trim()
      : undefined
  const turnOpen = await openConversationTurn(app, user, {
    conversationId,
    save: !conversationId,
    question,
    historyOff: false,
    notifyAsker: true
  })
  if (!turnOpen) return { status: 400, error: 'Could not start the conversation' }
  if ('error' in turnOpen) return { status: turnOpen.status, error: turnOpen.error }
  const turn = turnOpen

  const label = `Ask AI: ${titleFromQuestion(question).slice(0, 120)}`
  const run = await startJobRun('ai', RESEARCH_JOB_ID, {
    label,
    triggeredBy: userId,
    trigger: 'manual'
  })
  const start: ResearchStart = {
    run_id: run.id,
    conversation_id: turn.conversation.id,
    question_message_id: turn.questionMessageId
  }
  // The tray links to the conversation and offers Cancel from the first tick.
  const progress = { phase: 'Starting…', done: 0, conversation_id: turn.conversation.id }
  run.progress(progress)
  if (run.id != null) {
    emitJobProgress(userId, {
      key: `job:${run.id}`,
      kind: 'ai',
      label,
      status: 'running',
      progress,
      href: researchLink(turn.conversation.id),
      cancel_path: `/ai/research/${run.id}/cancel`
    })
  }

  void runInBackgroundPool(() =>
    runInTrace('/api/ai/research', userId, () =>
      runResearch(app, user, { question, turn, run, label, client, model: chatModel })
    )
  ).catch(() => {})
  return start
}

async function runResearch(
  app: FastifyInstance,
  user: User,
  ctx: {
    question: string
    turn: ConversationTurn
    run: JobRunHandle
    label: string
    client: import('@anthropic-ai/sdk').default
    model: string
  }
): Promise<void> {
  const { question, turn, run, label } = ctx
  const userId = String(user.id)
  const conversationId = turn.conversation.id
  const stopper = run.id != null ? registerStream(app, researchStreamId(run.id), userId) : null
  const deadline = Date.now() + RESEARCH_TIME_BUDGET_MS
  let timedOut = false
  const shouldStop = () => {
    if (stopper?.stopped()) return true
    if (Date.now() > deadline) {
      timedOut = true
      return true
    }
    return false
  }
  try {
    const [{ buildChatSystemPrompt }, memory, { runChatLoop }] = await Promise.all([
      import('./ai-chat.js'),
      import('./ai-memory.js'),
      import('./ai-chat-loop.js')
    ])
    const notes = await memory.readMemory(userId).catch(() => [])
    const system =
      (await buildChatSystemPrompt(user, { question })) +
      memory.memoryPromptBlock(notes) +
      RESEARCH_DIRECTIVE
    const convo = [
      ...turn.history.slice(-18).map((m) => ({ role: m.role, content: m.content.slice(0, 4000) })),
      { role: 'user' as const, content: question }
    ]
    let steps = 0
    const result = await runChatLoop({
      client: ctx.client,
      model: ctx.model,
      system,
      user,
      convo,
      readOnly: true,
      maxRounds: RESEARCH_MAX_ROUNDS,
      maxTokens: RESEARCH_MAX_TOKENS,
      // background research runs longer than an interactive question
      deadlineMs: 20 * 60_000,
      shouldStop,
      onStatus: (st) => {
        if (!st.tool || st.done) return
        steps++
        run.progress({ phase: st.text, done: steps, conversation_id: conversationId })
      }
    })
    const split = await splitReply(result.text)
    const stopped = result.stopped
    const reply =
      split.text ||
      (stopped
        ? ''
        : `I used all ${RESEARCH_MAX_ROUNDS} tool rounds without reaching an answer — try a narrower question, or name the collection and fields you mean.`)
    await logActivity({
      action: 'ai-research',
      user: user.id,
      collection: 'nivaro_ai_conversations',
      item: conversationId,
      comment: `${stopped ? (timedOut ? 'ran out of time' : 'cancelled') : 'answered'} after ${result.trace.length} tool call(s)`
    }).catch(() => {})

    if (stopped && !reply) {
      // Nothing arrived: the question leaves the thread rather than sit unanswered.
      await turn.fail()
      await finishCanceled(run, userId, label, timedOut, conversationId)
      return
    }
    await turn.record({
      reply,
      trace: result.trace,
      proposals: [],
      truncated: result.truncated || undefined,
      stopped: stopped || undefined,
      followups: stopped ? [] : split.followups,
      research: true
    })
    emitToUser(userId, 'ai:conversation', {
      conversation_id: conversationId,
      by: userId,
      state: 'answered'
    })
    if (stopped) {
      await finishCanceled(run, userId, label, timedOut, conversationId)
      return
    }
    await run.complete('Answered', { href: researchLink(conversationId) })
    const { notifyUser } = await import('./notification-channels.js')
    await notifyUser(app, userId, {
      subject: 'Your background question is answered',
      message: `“${titleFromQuestion(question)}” — ${reply.replace(/\s+/g, ' ').slice(0, 220)}`,
      category: 'system',
      always_inbox: true,
      target: {
        kind: 'external',
        url: `${adminBaseUrl() ?? ''}${researchLink(conversationId)}`
      },
      source: { kind: 'ai-research', label: 'Ask AI' }
    }).catch(() => {})
  } catch (err) {
    await turn.fail().catch(() => {})
    await run.fail(err)
  } finally {
    stopper?.dispose()
  }
}

async function finishCanceled(
  run: JobRunHandle,
  userId: string,
  label: string,
  timedOut: boolean,
  conversationId: string
): Promise<void> {
  const outcome = timedOut
    ? 'Ran out of time — what had arrived is in your Ask history'
    : 'Cancelled'
  await run.complete(outcome, { href: researchLink(conversationId) })
  if (!timedOut && run.id != null) {
    emitJobProgress(userId, {
      key: `job:${run.id}`,
      kind: 'ai',
      label,
      status: 'canceled',
      outcome,
      href: researchLink(conversationId)
    })
  }
}

/**
 * Cancel a background question: only its asker (or an administrator) may.
 * 'not_found' covers a run that is not a research run or not theirs.
 */
export async function cancelResearch(
  app: FastifyInstance,
  user: User,
  runId: number,
  isAdmin: boolean
): Promise<'stopped' | 'queued' | 'finished' | 'not_found'> {
  const row = (await db('nivaro_job_runs')
    .where({ id: runId })
    .first('id', 'kind', 'job_id', 'triggered_by', 'status')
    .catch(() => null)) as Record<string, unknown> | null | undefined
  if (!row || row.kind !== 'ai' || row.job_id !== RESEARCH_JOB_ID) return 'not_found'
  const own = String(row.triggered_by ?? '').toUpperCase() === String(user.id).toUpperCase()
  if (!own && !isAdmin) return 'not_found'
  if (row.status !== 'running') return 'finished'
  const outcome = await requestStreamStop(app, researchStreamId(runId), {
    id: String(row.triggered_by),
    admin: true
  })
  return outcome === 'forbidden' ? 'not_found' : outcome
}
