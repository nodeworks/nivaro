import type { FastifyInstance, FastifyReply } from 'fastify'
import { requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import {
  type AskInput,
  answerQuestion,
  askQuestion,
  cancelQuestion,
  canSeeQuestion,
  isHumanSession,
  loadQuestion,
  MAX_WAIT_S,
  markAnswerSeen,
  openQuestionsFor,
  QuestionError,
  type QuestionRow,
  questionNames,
  questionsAskedBy,
  questionsReady,
  questionView,
  waitForAnswer
} from '../services/agent-questions.js'
import { mcpConnOf } from '../services/mcp-calls.js'

/**
 * ask_human (#3220), under /api/agent-questions — see services/agent-questions.ts.
 *
 *   POST /                 ask {to?, question, choices?, allow_text?, expires_in_minutes?, collection?, item?}
 *   GET  /mine             questions waiting on me (My Work)
 *   GET  /asked            ?status=open|unseen|answered|expired|cancelled|all — what this connection asked
 *   GET  /:id              ?wait=0..25 holds the request until it is answered (asker, recipient, admin)
 *   POST /:id/answer       {choice?, answer?} — the person asked, from a signed-in session only
 *   POST /:id/cancel       the asker withdraws it
 */

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof QuestionError)
    return reply.code(err.statusCode).send({ error: err.message, code: err.code })
  throw err
}

const notReady = (reply: FastifyReply) =>
  reply.code(409).send({ error: 'Agent questions need database migration 511.', code: 'NOT_READY' })

export async function agentQuestionRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAuth)

  /** The asker (the person the connection acts for) also sees the connection key. */
  const view = async (row: QuestionRow, userId: string) =>
    questionView(row, {
      id: userId,
      isAsker: String(row.asker).toLowerCase() === userId.toLowerCase()
    })

  app.post<{ Body: AskInput }>('/', async (req, reply) => {
    if (!(await questionsReady())) return notReady(reply)
    try {
      const row = await askQuestion(app, req, req.body ?? {})
      await logActivity({
        action: 'agent-question',
        user: req.user!.id,
        collection: 'nivaro_agent_questions',
        item: row.id,
        comment: `${row.asker_name ?? 'An assistant'} asked ${String(row.recipient)}`,
        req
      })
      return reply.code(201).send({ data: await view(row, String(req.user!.id)) })
    } catch (err) {
      return sendError(reply, err)
    }
  })

  app.get('/mine', async (req, reply) => {
    if (!(await questionsReady())) return reply.send({ data: [], ready: false })
    const rows = await openQuestionsFor(String(req.user!.id))
    const n = await questionNames(rows.flatMap((r) => [r.asker, r.recipient]))
    const me = String(req.user!.id)
    return reply.send({
      data: await Promise.all(rows.map((r) => questionView(r, { id: me, isAsker: false }, n))),
      ready: true,
      // Answers go in from a signed-in browser only; tell the client before it tries.
      can_answer: isHumanSession(req)
    })
  })

  app.get<{ Querystring: { status?: string; limit?: string } }>('/asked', async (req, reply) => {
    if (!(await questionsReady())) return reply.send({ data: [] })
    const me = String(req.user!.id)
    const conn = mcpConnOf(req) ?? `u${me.toLowerCase()}`
    const rows = await questionsAskedBy(conn, {
      status: req.query.status,
      limit: req.query.limit ? Number(req.query.limit) : 50
    })
    const n = await questionNames(rows.flatMap((r) => [r.asker, r.recipient]))
    const data = await Promise.all(rows.map((r) => questionView(r, { id: me, isAsker: true }, n)))
    for (const r of rows) await markAnswerSeen(r)
    return reply.send({ data })
  })

  app.get<{ Params: { id: string }; Querystring: { wait?: string } }>(
    '/:id',
    async (req, reply) => {
      if (!(await questionsReady())) return notReady(reply)
      let row = await loadQuestion(req.params.id)
      if (!row || !canSeeQuestion(req, row)) return reply.code(404).send({ error: 'Not found' })
      const wait = Math.min(Math.max(Number(req.query.wait) || 0, 0), MAX_WAIT_S)
      if (wait > 0 && row.status === 'open') {
        const closed = { aborted: false }
        req.raw.once('close', () => {
          closed.aborted = true
        })
        row = (await waitForAnswer(row.id, wait, { signal: closed })) ?? row
      }
      const me = String(req.user!.id)
      const conn = mcpConnOf(req)
      const isAsker = String(row.asker).toLowerCase() === me.toLowerCase()
      if (isAsker && (conn == null || conn === row.asker_conn)) await markAnswerSeen(row)
      return reply.send({ data: await view(row, me) })
    }
  )

  app.post<{ Params: { id: string }; Body: { choice?: unknown; answer?: unknown } }>(
    '/:id/answer',
    async (req, reply) => {
      if (!(await questionsReady())) return notReady(reply)
      try {
        const row = await answerQuestion(req, req.params.id, req.body ?? {})
        await logActivity({
          action: 'agent-question-answer',
          user: req.user!.id,
          collection: 'nivaro_agent_questions',
          item: row.id,
          comment: row.answer_choice ? `Chose "${row.answer_choice}"` : 'Answered',
          req
        })
        return reply.send({ data: await view(row, String(req.user!.id)) })
      } catch (err) {
        return sendError(reply, err)
      }
    }
  )

  app.post<{ Params: { id: string } }>('/:id/cancel', async (req, reply) => {
    if (!(await questionsReady())) return notReady(reply)
    try {
      const row = await cancelQuestion(req, req.params.id)
      return reply.send({ data: await view(row, String(req.user!.id)) })
    } catch (err) {
      return sendError(reply, err)
    }
  })
}
